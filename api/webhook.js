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
      return;
    }

    try {
      const from = msg.from;
      const text = msg?.text?.body;

      console.log("INBOUND MESSAGE", { from, text, type: msg?.type });

      if (!text) {
        console.log("Message has no text body; skipping.");
        return res.status(200).send("OK");
      }

      // Use a faster model by default for webhook latency
      const aiResult = await withTimeout(callArliAI(text), 7000);

      const replyText =
        typeof aiResult === "string"
          ? aiResult
          : (aiResult && aiResult.reply) ||
            (aiResult && aiResult.choices?.[0]?.message?.content) ||
            "Thanks! What date and time would you like?";

      console.log("AI REPLY", replyText);

      const sendResult = await withTimeout(sendWhatsAppText(from, replyText), 7000);
      console.log("WHATSAPP SEND RESULT", sendResult);

      return res.status(200).send("OK");
    } catch (err) {
      console.error("Webhook error:", err?.message || err);
      return res.status(200).send("OK");
    }
  }

  return res.status(405).send("Method Not Allowed");
}

async function callArliAI(userText) {
  const payload = {
    model: process.env.ARLIAI_MODEL || "Llama-3.3-27B-Instruct",
    hide_thinking: true,
    temperature: 0.2,
    max_completion_tokens: 40,
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are the WhatsApp auto-reply assistant for Shawarma Beirut. Help with table reservations. Keep replies under 3 short sentences. Ask exactly 1 question if needed (date, time, pax). Do not invent prices or availability. Never mention you are an AI."
      },
      { role: "user", content: userText }
    ]
  };

  const r = await fetchWithTimeout("https://api.arliai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ARLIAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  }, 6500);

  const data = await r.json();
  if (!r.ok) {
    console.error("ArliAI error:", r.status, data);
  }
  return data?.choices?.[0]?.message?.content?.trim() || data?.reply || "Thanks! What date and time would you like?";
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