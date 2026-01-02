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
    // Always respond 200 fast to Meta
    res.status(200).send("OK");

    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return;

      const from = msg.from;
      const text = msg?.text?.body;
      if (!text) return;

      // Call ArliAI to generate a reply
      const reply = await callArliAI(text);

      // Send reply back to WhatsApp
      await sendWhatsAppText(from, reply);
    } catch (err) {
      console.error("Webhook error:", err);
    }

    return;
  }

  return res.status(405).send("Method Not Allowed");
}

async function callArliAI(userText) {
  const payload = {
    model: process.env.ARLIAI_MODEL || "Llama-3.3-70B-Instruct",
    hide_thinking: true,
    temperature: 0.2,
    max_completion_tokens: 160,
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

  const r = await fetch("https://api.arliai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ARLIAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || "Thanks! What date and time would you like?";
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
  if (!r.ok) console.error("WhatsApp send error:", r.status, out);
  return out;
}