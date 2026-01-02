// Simple in-memory dedupe to avoid replying multiple times when Meta retries webhooks
const processedMessageIds = new Map(); // id -> timestamp
const processedMessageKeys = new Map(); // key -> timestamp
const DEDUPE_TTL_MS = 5 * 60 * 1000;

// Simple per-user conversation memory (in-memory). For production-grade, use Redis/DB.
const conversationStore = new Map(); // from -> { messages: Array<{role, content}>, ts: number }
const CONVO_TTL_MS = 30 * 60 * 1000;
const MAX_TURNS = 8; // last N messages (user+assistant)

function getConversation(from) {
  const now = Date.now();

  // prune old conversations
  for (const [k, v] of conversationStore.entries()) {
    if (!v?.ts || now - v.ts > CONVO_TTL_MS) conversationStore.delete(k);
  }

  const existing = conversationStore.get(from);
  if (!existing) {
    const fresh = { messages: [], ts: now };
    conversationStore.set(from, fresh);
    return fresh;
  }

  existing.ts = now;
  return existing;
}

function pushTurn(from, role, content) {
  if (!from || !content) return;
  const convo = getConversation(from);
  convo.messages.push({ role, content });
  // keep only last MAX_TURNS turns
  if (convo.messages.length > MAX_TURNS) {
    convo.messages = convo.messages.slice(convo.messages.length - MAX_TURNS);
  }
  convo.ts = Date.now();
}

function isDuplicateMessage(id) {
  if (!id) return false;
  const now = Date.now();

  // prune old ids
  for (const [k, ts] of processedMessageIds.entries()) {
    if (now - ts > DEDUPE_TTL_MS) processedMessageIds.delete(k);
  }

  if (processedMessageIds.has(id)) return true;
  processedMessageIds.set(id, now);
  return false;
}

function isDuplicateKey(key) {
  if (!key) return false;
  const now = Date.now();

  // prune old keys
  for (const [k, ts] of processedMessageKeys.entries()) {
    if (now - ts > DEDUPE_TTL_MS) processedMessageKeys.delete(k);
  }

  if (processedMessageKeys.has(key)) return true;
  processedMessageKeys.set(key, now);
  return false;
}

export default async function handler(req, res) {
  // 1) Verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // 2) Incoming message events (POST)
  if (req.method === "POST") {
    // Debug: confirm the function is receiving POST events
    console.log("WEBHOOK POST received");

    // Debug: confirm required env vars exist (do not log secrets)
    console.log("ENV CHECK", {
      has_META_ACCESS_TOKEN: Boolean(process.env.META_ACCESS_TOKEN),
      has_PHONE_NUMBER_ID: Boolean(process.env.PHONE_NUMBER_ID),
      has_ARLIAI_API_KEY: Boolean(process.env.ARLIAI_API_KEY),
      model: process.env.ARLIAI_MODEL || "Llama-3.3-27B-Instruct"
    });

    // WhatsApp sends many event types; only proceed if there is an inbound message
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) {
      console.log("No messages[] in payload (likely status event). Keys:", Object.keys(value || {}));
      return res.status(200).send("OK");
    }
    const messageId = msg.id;

    const msgTs = msg.timestamp;
    const msgText = msg?.text?.body || "";
    const key = `${msg.from}:${msgTs}:${msgText}`;

    if (isDuplicateMessage(messageId)) {
      console.log("DUPLICATE MESSAGE ignored", { messageId });
      return res.status(200).send("OK");
    }

    if (isDuplicateKey(key)) {
      console.log("DUPLICATE KEY ignored", { key });
      return res.status(200).send("OK");
    }

    try {
      const from = msg.from;
      const text = msg?.text?.body;

      console.log("INBOUND MESSAGE", { from, text, type: msg?.type });

      if (!text) {
        console.log("Message has no text body; skipping.");
        return res.status(200).send("OK");
      }

      pushTurn(from, "user", text);

      // Quick rule-based responses for speed and to avoid repeated questions
      const lower = text.toLowerCase();
      if (lower.includes("what do you offer") || lower.includes("services")) {
        const quick = "We help with branding, logos, websites, social media, menus, and pitch decks. What do you need help with?";
        console.log("AI REPLY", quick);
        pushTurn(from, "assistant", quick);
        await withTimeout(sendWhatsAppText(from, quick), 6500);
        return res.status(200).send("OK");
      }

      // Use a faster model by default for webhook latency
      const aiResult = await withTimeout(callArliAI(from), 6500);

      const replyText = extractReplyText(aiResult);

      console.log("AI REPLY", replyText);
      pushTurn(from, "assistant", replyText);

      const sendResult = await withTimeout(sendWhatsAppText(from, replyText), 6500);
      console.log("WHATSAPP SEND RESULT", sendResult);

      return res.status(200).send("OK");
    } catch (err) {
      console.error("Webhook error:", err?.message || err);
      return res.status(200).send("OK");
    }
  }

  return res.status(405).send("Method Not Allowed");
}

async function callArliAI(from) {
  // Force a faster model if the env var is accidentally set to a slow 70B model
  const envModel = process.env.ARLIAI_MODEL || "";
  const model = envModel.includes("70B") ? "Llama-3.3-27B-Instruct" : (envModel || "Llama-3.3-27B-Instruct");

  console.log("ARLIAI MODEL USED", model);

  const payload = {
    model,
    hide_thinking: true,
    temperature: 0.2,
    max_completion_tokens: 30,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are the WhatsApp auto-reply assistant for The Third House, a design agency. Be warm, confident, and concise. Keep replies under 3 short sentences. Ask at most ONE question per message. No emojis. Never mention you are an AI. If the user asks what you offer, list 4 to 6 core services briefly (branding, logo, social media, menus, websites, pitch decks) and ask which one they need. If the user gives you the service and timeline, ask the next missing detail (brand name, then budget range). If they ask for pricing, do not invent numbers; say you will confirm and ask what service + timeline. IMPORTANT: Output ONLY the message text to send to the user. Do NOT output JSON, keys, code blocks, or quotes."
      },
      ...getConversation(from).messages
    ]
  };

  try {
    const r = await fetchWithTimeout(
      "https://api.arliai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.ARLIAI_API_KEY}`
        },
        body: JSON.stringify(payload)
      },
      6000
    );

    const data = await r.json();
    if (!r.ok) {
      console.error("ArliAI error:", r.status, data);
    }

    return (
      data?.choices?.[0]?.message?.content?.trim() ||
      data?.reply ||
      nextQuestionFallback(from)
    );
  } catch (err) {
    // AbortError or network hiccup: return a safe fallback so we can still reply on WhatsApp
    console.error("ArliAI call failed:", err?.name || "Error", err?.message || err);
    return nextQuestionFallback(from);
  }
}

async function sendWhatsAppText(to, body) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const metaToken = process.env.META_ACCESS_TOKEN;

  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${metaToken}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });

  const out = await r.json();
  console.log("WHATSAPP SEND HTTP", { ok: r.ok, status: r.status });
  if (!r.ok) console.error("WhatsApp send error:", r.status, out);
  return out;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    )
  ]);
}

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

function extractReplyText(aiResult) {
  // 1) If the model returned an object, prefer .reply
  if (aiResult && typeof aiResult === "object") {
    return (
      aiResult.reply ||
      aiResult.choices?.[0]?.message?.content?.trim() ||
      "Hi! What day and time would you like?"
    );
  }

  // 2) If the model returned a string, it might be JSON. Try to parse.
  const s = String(aiResult || "").trim();
  if (!s) return "Hi! What day and time would you like?";

  // Quick check to avoid parsing normal text
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === "object") {
        return (
          parsed.reply ||
          parsed.message ||
          parsed.text ||
          "Hi! What day and time would you like?"
        );
      }
    } catch {
      // fall through to return the raw string
    }
  }

  // 3) Default: return raw string
  return s;
}

function nextQuestionFallback(from) {
  const convo = getConversation(from).messages || [];
  const lastUser = [...convo].reverse().find(m => m.role === "user")?.content?.toLowerCase() || "";
  const allText = convo.map(m => (m.content || "").toLowerCase()).join(" \n");

  const hasService = /(logo|branding|brand|website|web|social|pitch deck|menu)/.test(allText);
  const hasTimeline = /(tomorrow|today|week|weeks|month|months|deadline|by\s)/.test(allText);
  const hasBrandName = /(brand is|business name|we are|called|name is)/.test(allText);
  const hasStyle = /(modern|minimal|bold|luxury|traditional|clean|playful|ref|reference|style)/.test(allText);
  const hasBudget = /(budget|idr|usd|rp\s?|million|k\b)/.test(allText);

  // If the user is clearly answering the last question, move forward
  if (hasService && (hasBrandName || lastUser.length > 2) && hasStyle && !hasBudget) {
    return "Got it. Do you have a budget range in mind for this logo?";
  }

  if (hasService && hasTimeline && !hasBrandName) {
    return "Great. What's the brand or business name?";
  }

  if (hasService && hasBrandName && !hasStyle) {
    return "Nice. What style do you want (modern, minimal, bold, etc.) or any references?";
  }

  if (hasService && hasBrandName && hasStyle && hasBudget) {
    return "Perfect. What's the best contact name, and should we continue here or by email?";
  }

  // Default
  return "Thanks for the details. What's your brand or business name and what style do you like?";
}