# LineBotAi

LINE Messaging API webhook สำหรับบอทพลูโต ใช้ `@line/bot-sdk` และ `@google/genai`
เพื่อให้ Gemini ตอบแชทลูกค้าตาม FAQ โดยมี guardrail เรื่องการถามข้อมูลพืช,
ปัญหา, อายุ/ขนาดต้น และระยะพืช เช่น ออกดอก ติดลูก หลังตัดลูก หรือฟื้นต้น

## Setup

```sh
npm install
cp .env.example .env
```

ตั้งค่า env:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` ค่าเริ่มต้นคือ `gemini-2.5-flash`
- `PLUTO_FAQ` FAQ/ข้อมูลสินค้าที่อนุญาตให้บอทใช้อ้างอิง

## Local dev

```sh
npm run dev
```

ตั้ง LINE webhook URL เป็น:

```txt
https://your-domain.vercel.app/webhook
```

หรือใช้ path ตรง:

```txt
https://your-domain.vercel.app/api/webhook
```

## Vercel

โปรเจกต์นี้มี `vercel.json` กำหนด `framework: null`, ไม่ใช้ build command,
และล็อก Node.js เป็น `22.x` ใน `package.json` เพื่อกัน Vercel detect framework ผิด
หรือพยายาม build เป็น frontend framework

## Test

```sh
npm test
```
