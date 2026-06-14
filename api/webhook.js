import { GoogleGenAI } from "@google/genai";
import { LineBotClient, validateSignature } from "@line/bot-sdk";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/systemPrompt.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_LINE_TEXT_LENGTH = 4900;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const FAQ_CACHE_MS = 5 * 60 * 1000;
let faqCache = { text: "", expiresAt: 0 };

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
  const faqText = await getFaqText();

  const response = await getGenAI().models.generateContent({
    model: GEMINI_MODEL,
    contents: buildUserPrompt({
      message,
      faqText,
    }),
    
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.3,
    },
  });

  return response.text?.trim() || "ขออภัยค่ะ ระบบยังตอบไม่ได้ เดี๋ยวให้ทีมงานช่วยยืนยันให้นะคะ";
}

async function getFaqText() {
  const fallbackFaq = process.env.PLUTO_FAQ || "";

  if (!SHEET_CSV_URL) {
    return fallbackFaq;
  }

  const now = Date.now();
  if (faqCache.text && faqCache.expiresAt > now) {
    return faqCache.text;
  }

  try {
    const response = await fetch(SHEET_CSV_URL);

    if (!response.ok) {
      console.error("Failed to fetch FAQ CSV", response.status);
      return fallbackFaq;
    }

    const csvText = await response.text();
    const faqText = csvToFaqText(csvText);

    faqCache = {
      text: faqText || fallbackFaq,
      expiresAt: now + FAQ_CACHE_MS,
    };

    return faqCache.text;
  } catch (error) {
    console.error("Failed to load FAQ CSV", error);
    return fallbackFaq;
  }
}

function csvToFaqText(csvText) {
  const rows = parseCsv(csvText);
  const dataRows = rows.slice(1).filter((row) => row.length >= 3);

  return dataRows
    .map(([category, question, answer]) => {
      return `หมวด: ${category || "-"}\nคำถาม: ${question || "-"}\nคำตอบ: ${answer || "-"}`;
    })
    .join("\n\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        i += 1;
      }

      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);

      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);

  return rows;
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
