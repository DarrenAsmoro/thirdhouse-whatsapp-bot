import express from "express";

const app = express();
app.use(express.json());

// Meta webhook verification token
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// Required by Vercel
export default function handler(req, res) {
  app(req, res);
}

// GET = Meta verification
app.get("/api/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST = incoming WhatsApp messages
app.post("/api/webhook", (req, res) => {
  res.sendStatus(200);
  console.log("Incoming WhatsApp message:", JSON.stringify(req.body, null, 2));
});