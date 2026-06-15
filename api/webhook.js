import { GoogleGenAI } from "@google/genai";
import { LineBotClient, validateSignature } from "@line/bot-sdk";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/systemPrompt.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_LINE_TEXT_LENGTH = 4900;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const FAQ_CACHE_MS = 5 * 60 * 1000;
const MAX_SELECTED_FAQ_ROWS = 18;
const MAX_HISTORY_MESSAGES = 6;
const FALLBACK_REPLY = "ขออภัยค่ะ ระบบกำลังเช็กข้อมูลให้ แอดมินจะช่วยยืนยันให้นะคะ";

let faqCache = { rows: [], text: "", expiresAt: 0 };
const userMemory = new Map();

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

  const userId = getEventUserId(event);
  const messageText = event.message.text;
  const history = getUserHistory(userId);
  const replyText = await generateReply(messageText, history);
  rememberMessage(userId, "ลูกค้า", messageText);
  rememberMessage(userId, "บอท", replyText);

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

async function generateReply(message, history = []) {
  try {
    const faq = await getFaqData();
    const relevantFaqText = selectRelevantFaqText(faq.rows, message, history) || faq.text;

    const response = await getGenAI().models.generateContent({
      model: GEMINI_MODEL,
      contents: buildUserPrompt({
        message: buildMessageWithHistory(message, history),
        faqText: relevantFaqText,
      }),

      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.2,
      },
    });

    return response.text?.trim() || FALLBACK_REPLY;
  } catch (error) {
    console.error("Failed to generate reply", error);
    return FALLBACK_REPLY;
  }
}

async function getFaqData() {
  const fallbackFaq = process.env.PLUTO_FAQ || "";

  if (!SHEET_CSV_URL) {
    return {
      rows: [],
      text: fallbackFaq,
    };
  }

  const now = Date.now();
  if ((faqCache.text || faqCache.rows.length) && faqCache.expiresAt > now) {
    return faqCache;
  }

  try {
    const response = await fetch(SHEET_CSV_URL);

    if (!response.ok) {
      console.error("Failed to fetch FAQ CSV", response.status);
      return {
        rows: [],
        text: fallbackFaq,
      };
    }

    const csvText = await response.text();
    const rows = csvToFaqRows(csvText);
    const faqText = faqRowsToText(rows);

    faqCache = {
      rows,
      text: faqText || fallbackFaq,
      expiresAt: now + FAQ_CACHE_MS,
    };

    return faqCache;
  } catch (error) {
    console.error("Failed to load FAQ CSV", error);
    return {
      rows: [],
      text: fallbackFaq,
    };
  }
}

function csvToFaqRows(csvText) {
  const rows = parseCsv(csvText);
  return rows
    .slice(1)
    .filter((row) => row.length >= 3)
    .map(([category, question, answer]) => ({
      category: category || "-",
      question: question || "-",
      answer: answer || "-",
      searchText: normalizeSearchText([category, question, answer].join(" ")),
    }));
}

function faqRowsToText(rows) {
  return rows
    .map(({ category, question, answer }) => {
      return `หมวด: ${category}\nคำถาม: ${question}\nคำตอบ: ${answer}`;
    })
    .join("\n\n");
}

function selectRelevantFaqText(rows, message, history) {
  if (!rows.length) {
    return "";
  }

  const query = normalizeSearchText(
    [
      message,
      ...history
        .slice(-4)
        .map((item) => item.text),
    ].join(" "),
  );
  const terms = getSearchTerms(query);

  if (!terms.length) {
    return faqRowsToText(rows.slice(0, MAX_SELECTED_FAQ_ROWS));
  }

  const scoredRows = rows
    .map((row, index) => ({
      row,
      index,
      score: scoreFaqRow(row.searchText, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const selectedRows = scoredRows.length
    ? scoredRows.slice(0, MAX_SELECTED_FAQ_ROWS).map((item) => item.row)
    : rows.slice(0, MAX_SELECTED_FAQ_ROWS);

  return faqRowsToText(selectedRows);
}

function scoreFaqRow(text, terms) {
  return terms.reduce((score, term) => {
    if (text.includes(term)) {
      return score + (term.length >= 4 ? 3 : 1);
    }

    return score;
  }, 0);
}

function getSearchTerms(text) {
  const terms = new Set();
  const importantTerms = [
    "pro5",
    "s1",
    "s2",
    "โปรไฟว์",
    "เอส1",
    "เอส2",
    "ไวต้า",
    "vita",
    "101",
    "201",
    "โปรซอย",
    "prosoil",
    "ไนโตร",
    "เคโตร",
    "ทีเคโอ",
    "greenpluz",
    "ดินฟุ",
    "ทุเรียน",
    "ปาล์ม",
    "ข้าว",
    "อ้อย",
    "มัน",
    "ข้าวโพด",
    "ราก",
    "ดิน",
    "ใบ",
    "ดอก",
    "ผล",
    "ราคา",
    "วิธี",
    "ใช้",
    "กี่เม็ด",
    "กี่กรัม",
    "ฝัง",
    "ปุ๋ย",
    "เชื้อรา",
    "รากเน่า",
    "ไม่เห็นผล",
  ];

  for (const term of importantTerms) {
    if (text.includes(normalizeSearchText(term))) {
      terms.add(normalizeSearchText(term));
    }
  }

  text
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .forEach((term) => terms.add(term));

  return [...terms].slice(0, 24);
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMessageWithHistory(message, history) {
  if (!history.length) {
    return message;
  }

  const historyText = history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => `${item.role}: ${item.text}`)
    .join("\n");

  return `<conversation_history>\n${historyText}\n</conversation_history>\n\n<latest_message>\n${message}\n</latest_message>`;
}

function getEventUserId(event) {
  return event.source?.userId || event.source?.groupId || event.source?.roomId || "anonymous";
}

function getUserHistory(userId) {
  return userMemory.get(userId) || [];
}

function rememberMessage(userId, role, text) {
  const history = getUserHistory(userId);
  history.push({
    role,
    text,
    at: Date.now(),
  });

  userMemory.set(userId, history.slice(-MAX_HISTORY_MESSAGES));
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
