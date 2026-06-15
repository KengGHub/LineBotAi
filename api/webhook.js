import { GoogleGenAI } from "@google/genai";
import { LineBotClient, validateSignature } from "@line/bot-sdk";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/systemPrompt.js";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_LINE_TEXT_LENGTH = 4900;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL;
const FAQ_CACHE_MS = 5 * 60 * 1000;
const MAX_SELECTED_FAQ_ROWS = 18;
const MAX_DIRECT_FAQ_ROWS = 3;
const MAX_HISTORY_MESSAGES = 6;
const AI_RETRY_DELAY_MS = 900;
const FALLBACK_REPLY = "ขออภัยค่ะ ระบบกำลังเช็กข้อมูลให้ แอดมินจะช่วยยืนยันให้นะคะ";
const PRODUCT_TERM_GROUPS = [
  ["pro5", "โปรไฟว์", "พลูโตเม็ด", "pluto pro5"],
  ["s1", "เอส1"],
  ["s2", "เอส2"],
  ["vita", "ไวต้า"],
  ["101"],
  ["201"],
  ["prosoil", "โปรซอย", "โปรซอยล์", "aa prosoil"],
  ["nitro", "ไนโตร"],
  ["ktro", "เคโตร"],
  ["tko", "ทีเคโอ"],
  ["greenpluz", "greenpluz+", "กรีนพลัส"],
  ["ดินฟุ", "dinfu"],
];
const FOLIAR_LIQUID_TERMS = [
  "พลูโต 1",
  "พลูโต 2",
  "พลูโต 3",
  "pluto 1",
  "pluto 2",
  "pluto 3",
  "ฉีดพ่น",
  "ผสมน้ำ",
  "ซีซี",
  "cc",
];
const TREE_AGE_TERMS = ["อายุ", "ปี", "เดือน", "ต้นเล็ก", "เพิ่งปลูก", "ปลูกใหม่", "สูง"];

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
  let selectedFaqRows = [];

  try {
    const faq = await getFaqData();
    selectedFaqRows = selectRelevantFaqRows(faq.rows, message, history);
    const relevantFaqText = faqRowsToText(selectedFaqRows) || getNoMatchingFaqText(message, history) || faq.text;

    const response = await generateAiContent({
      message: buildMessageWithHistory(message, history),
      faqText: relevantFaqText,
    });

    const replyText = response.text?.trim() || FALLBACK_REPLY;
    if (violatesProductGuardrails(replyText, message, history)) {
      return buildTreeAgePro5Reply(message) || buildDirectFaqReply(selectedFaqRows, message) || FALLBACK_REPLY;
    }

    return replyText;
  } catch (error) {
    console.error("Failed to generate reply", error);
    const treeAgeReply = buildTreeAgePro5Reply(message);
    if (treeAgeReply) {
      return treeAgeReply;
    }

    const directFaqReply = buildDirectFaqReply(selectedFaqRows, message);
    if (directFaqReply) {
      return directFaqReply;
    }

    return FALLBACK_REPLY;
  }
}

async function generateAiContent({ message, faqText }) {
  const request = {
    model: GEMINI_MODEL,
    contents: buildUserPrompt({
      message,
      faqText,
    }),

    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.2,
    },
  };

  try {
    return await getGenAI().models.generateContent(request);
  } catch (error) {
    if (!isTemporaryAiError(error)) {
      throw error;
    }

    await delay(AI_RETRY_DELAY_MS);
    return getGenAI().models.generateContent(request);
  }
}

function isTemporaryAiError(error) {
  const status = error?.status || error?.error?.code;
  const message = String(error?.message || "");

  return status === 429 || status === 503 || message.includes('"code":429') || message.includes('"code":503');
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

  const headerIndex = rows.findIndex((row) => {
    const headerText = normalizeSearchText(row.join(" "));
    return headerText.includes("คำถาม") && headerText.includes("คำตอบ");
  });
  const dataRows = rows.slice(headerIndex >= 0 ? headerIndex + 1 : 1);

  return dataRows
    .filter((row) => {
      if (row.length < 3) {
        return false;
      }

      const [, question, answer] = row;
      return hasUsefulFaqCell(question) && hasUsefulFaqCell(answer);
    })
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

function hasUsefulFaqCell(value) {
  const text = String(value || "").trim();
  return Boolean(text && text !== "-" && text.length > 3);
}

function selectRelevantFaqRows(rows, message, history) {
  if (!rows.length) {
    return [];
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
  const productTermGroups = getMatchedProductTermGroups(query);
  const treeAgeQuery = isTreeAgeRecommendationQuery(query);

  if (!terms.length) {
    return rows.slice(0, MAX_SELECTED_FAQ_ROWS);
  }

  const scoredRows = rows
    .map((row, index) => ({
      row,
      index,
      score: scoreFaqRow(row.searchText, terms) + scoreContextBoost(row.searchText, { treeAgeQuery }),
    }))
    .filter((item) => item.score > 0)
    .filter((item) => !treeAgeQuery || !isFoliarLiquidRow(item.row.searchText))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (productTermGroups.length) {
    const productRows = scoredRows.filter((item) => {
      return productTermGroups.some((group) => group.some((term) => item.row.searchText.includes(term)));
    });

    return productRows.slice(0, MAX_SELECTED_FAQ_ROWS).map((item) => item.row);
  }

  const selectedRows = scoredRows.length
    ? scoredRows.slice(0, MAX_SELECTED_FAQ_ROWS).map((item) => item.row)
    : [];

  return selectedRows;
}

function scoreFaqRow(text, terms) {
  return terms.reduce((score, term) => {
    if (text.includes(term)) {
      return score + (term.length >= 4 ? 3 : 1);
    }

    return score;
  }, 0);
}

function scoreContextBoost(rowText, { treeAgeQuery }) {
  if (!treeAgeQuery) {
    return 0;
  }

  let score = 0;
  if (rowText.includes("pro5") || rowText.includes("โปรไฟว์") || rowText.includes("พลูโตเม็ด")) {
    score += 12;
  }
  if (rowText.includes("s1") || rowText.includes("เอส1")) {
    score += 8;
  }
  if (rowText.includes("s2") || rowText.includes("เอส2")) {
    score += 5;
  }
  if (rowText.includes("กี่เม็ด") || rowText.includes("กรัม") || rowText.includes("ฝัง")) {
    score += 4;
  }

  return score;
}

function isTreeAgeRecommendationQuery(text) {
  const mentionsTree = /ทุเรียน|ต้นไม้|ไม้ผล|พืช/.test(text);
  const mentionsAgeOrSize = TREE_AGE_TERMS.some((term) => text.includes(normalizeSearchText(term))) || /\d+\s*(ปี|เดือน|เมตร)/.test(text);
  const asksRecommendation = /แนะนำ|ใช้|แบบไหน|ตัวไหน|กี่เม็ด|กี่กรัม|บำรุง/.test(text);

  return mentionsTree && mentionsAgeOrSize && asksRecommendation;
}

function isFoliarLiquidRow(text) {
  return FOLIAR_LIQUID_TERMS.some((term) => text.includes(normalizeSearchText(term)));
}

function violatesProductGuardrails(replyText, message, history = []) {
  const query = normalizeSearchText(
    [
      message,
      ...history
        .slice(-4)
        .map((item) => item.text),
    ].join(" "),
  );

  if (!isTreeAgeRecommendationQuery(query)) {
    return false;
  }

  const reply = normalizeSearchText(replyText);
  return isFoliarLiquidRow(reply);
}

function buildTreeAgePro5Reply(message) {
  const query = normalizeSearchText(message);

  if (!isTreeAgeRecommendationQuery(query)) {
    return "";
  }

  if (/2\s*ปี|สองปี|สอง\s*ปี/.test(query)) {
    return [
      "สำหรับทุเรียนอายุประมาณ 2 ปี แนะนำเป็น Pluto Pro5 S1 ค่ะ",
      "ใช้ขนาด 2.5 กรัม ประมาณ 1-5 เม็ดต่อต้น โดยฝังรอบทรงพุ่มลึกประมาณ 10-20 ซม.",
      "ถ้าต้นสูงเกิน 2 เมตรหรือทรงพุ่มใหญ่แล้ว แอดมินแนะนำให้ทีมงานช่วยเช็กอีกทีว่าจะขยับเป็นเม็ด 10 กรัมเหมาะกว่าไหมค่ะ",
    ].join("\n");
  }

  return [
    "กรณีถามตามอายุต้น แนะนำเริ่มจากกลุ่ม Pluto Pro5 S1/S2 แบบเม็ดฝังดินนะคะ",
    "แอดมินขอเช็กอายุต้นหรือความสูงโดยประมาณอีกนิด จะได้แนะนำขนาดเม็ดและจำนวนเม็ดให้ตรงค่ะ",
  ].join("\n");
}

function buildDirectFaqReply(rows, message) {
  const usefulRows = rows
    .filter((row) => {
      const answer = String(row.answer || "").trim();
      return answer && answer !== "-";
    })
    .slice(0, MAX_DIRECT_FAQ_ROWS);

  if (!usefulRows.length) {
    return "";
  }

  const isBuying = /ซื้อ|สั่ง|ราคา|โปร|กี่บาท|ส่ง/.test(message);
  const intro = isBuying
    ? "ได้ค่ะ แอดมินสรุปข้อมูลจากระบบให้ก่อนนะคะ"
    : "แอดมินสรุปข้อมูลที่เกี่ยวข้องให้ก่อนนะคะ";
  const answers = usefulRows
    .map((row) => {
      const category = row.category && row.category !== "-" ? `${row.category}: ` : "";
      return `• ${category}${cleanFaqAnswer(row.answer)}`;
    })
    .join("\n");
  const outro = "ถ้าพี่บอกพืช/อาการ/อายุต้นเพิ่มได้ แอดมินจะช่วยเช็กให้ตรงขึ้นค่ะ";

  return `${intro}\n${answers}\n\n${outro}`;
}

function cleanFaqAnswer(answer) {
  return String(answer || "")
    .replace(/\s+/g, " ")
    .trim();
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

function getMatchedProductTermGroups(text) {
  return PRODUCT_TERM_GROUPS
    .map((group) => group.map((term) => normalizeSearchText(term)))
    .filter((group) => group.some((term) => text.includes(term)));
}

function getNoMatchingFaqText(message, history) {
  const query = normalizeSearchText(
    [
      message,
      ...history
        .slice(-4)
        .map((item) => item.text),
    ].join(" "),
  );

  const productTermGroups = getMatchedProductTermGroups(query);
  if (!productTermGroups.length) {
    return "";
  }

  const productNames = productTermGroups.map((group) => group[0]).join(", ");
  return `ไม่มีข้อมูลสินค้า/คำถาม "${productNames}" ใน FAQ ที่ระบบอ่านได้ตอนนี้ ห้ามเดาราคา วิธีใช้ ปริมาณใช้ หรือคุณสมบัติ ให้แจ้งว่าจะให้ทีมงานช่วยยืนยัน`;
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
