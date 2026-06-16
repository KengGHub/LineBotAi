import { GoogleGenAI } from "@google/genai";
import { LineBotClient, validateSignature } from "@line/bot-sdk";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/systemPrompt.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_LINE_TEXT_LENGTH = 4900;

let lineClient;
let genAI;

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "LineBotAi webhook" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-line-signature"];

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  if (!payload.events?.length) {
    return res.status(200).json({ ok: true });
  }

  if (!hasRequiredEnv()) {
    console.error("Missing required environment variables");
    return res.status(500).json({ error: "Server is not configured" });
  }

  if (!signature || !validateSignature(rawBody, process.env.LINE_CHANNEL_SECRET, signature)) {
    return res.status(401).json({ error: "Invalid LINE signature" });
  }

  await Promise.all((payload.events || []).map(handleLineEvent));
  return res.status(200).json({ ok: true });
}

async function handleLineEvent(event) {
  if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken) {
    return;
  }

  const replyText = await generateReply(event.message.text);

  await getLineClient().replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: "text",
        text: trimForLine(replyText),
      },
    ],
  });
}

async function generateReply(message) {
  const response = await getGenAI().models.generateContent({
    model: GEMINI_MODEL,
    contents: buildUserPrompt({
      message,
      faqText: process.env.PLUTO_FAQ,
    }),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.3,
    },
  });

  return response.text?.trim() || "ขออภัยค่ะ ระบบยังตอบไม่ได้ เดี๋ยวให้ทีมงานช่วยยืนยันให้นะคะ";
}

function hasRequiredEnv() {
  return Boolean(
    process.env.LINE_CHANNEL_SECRET &&
      process.env.LINE_CHANNEL_ACCESS_TOKEN &&
      (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
  );
}

function getLineClient() {
  if (!lineClient) {
    lineClient = LineBotClient.fromChannelAccessToken({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }

  return lineClient;
}

function getGenAI() {
  if (!genAI) {
    genAI = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    });
  }

  return genAI;
}

function trimForLine(text) {
  if (text.length <= MAX_LINE_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_LINE_TEXT_LENGTH - 32)}\n\n...`;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
