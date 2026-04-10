/**
 * 共通ヘルパー
 * Redis接続、JWT認証、暗号化、Gemini API呼び出し
 */
const { Redis } = require('@upstash/redis');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// --- Redis クライアント ---
let redis;
function getRedis() {
  if (!redis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

// --- JWT 発行・検証 ---
const JWT_SECRET = () => process.env.JWT_SECRET || 'mail-client-dev-secret';
const JWT_EXPIRES = '7d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET(), { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET());
  } catch {
    return null;
  }
}

/**
 * リクエストからユーザーを取得
 * Authorization: Bearer xxx ヘッダーからJWTを検証
 */
function getUser(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  return verifyToken(token);
}

// --- AES-256-GCM 暗号化 / 復号 ---
function getEncKey() {
  const raw = process.env.ENCRYPTION_KEY || 'default-32-byte-key-change-this!';
  return Buffer.from(raw.padEnd(32, '0').substring(0, 32));
}

/**
 * IMAPパスワードをAES-256-GCMで暗号化
 */
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

/**
 * AES-256-GCMで復号
 */
function decrypt(encrypted) {
  const [ivHex, tagHex, data] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- Gemini API 呼び出し ---
/**
 * Gemini 2.5 Flashにプロンプトを送信
 * @param {string} apiKey - Gemini APIキー
 * @param {string} prompt - テキストプロンプト
 * @param {Array} files - 添付ファイル [{mimeType, data(base64)}]
 * @returns {Object} パース済みJSONレスポンス
 */
async function callGemini(apiKey, prompt, files = []) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const parts = [];
  for (const file of files) {
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }
  parts.push({ text: prompt });

  const payload = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.1, thinkingConfig: { thinkingBudget: 0 } }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  try {
    // レスポンス構造: candidates[0].content.parts にテキストとthinking両方が含まれる場合がある
    const parts = data.candidates?.[0]?.content?.parts || [];
    // textパートだけを取得（thinkingパートを除外）
    let text = '';
    for (const part of parts) {
      if (part.text) text = part.text;
    }
    if (!text) {
      throw new Error('Geminiからテキストレスポンスがありません');
    }
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('Geminiレスポンスパースエラー:', e.message, JSON.stringify(data).substring(0, 500));
    throw new Error(`AI解析結果のパースに失敗: ${e.message}`);
  }
}

// --- CORS ヘッダー ---
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// --- ユニークID生成 ---
function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// --- メール送信（SMTP via nodemailer） ---
const nodemailer = require('nodemailer');

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD
      }
    });
  }
  return transporter;
}

/**
 * メール送信
 * @param {string} to - 送信先メールアドレス
 * @param {string} subject - 件名
 * @param {string} html - HTML本文
 */
async function sendEmail(to, subject, html) {
  const t = getTransporter();
  await t.sendMail({
    from: `"MailExtract" <${process.env.SMTP_EMAIL}>`,
    to,
    subject,
    html
  });
}

/** 6桁の認証コード生成 */
function genCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = { getRedis, signToken, verifyToken, getUser, encrypt, decrypt, callGemini, cors, genId, sendEmail, genCode };
