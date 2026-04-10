/**
 * AI書類抽出API
 * POST /api/extract
 * メールからGemini AIで請求書・領収書を自動判定・抽出
 * 添付ファイルがある場合はIMAPから再取得してファイル解析
 */
const { getRedis, getUser, decrypt, callGemini, cors, genId } = require('./helpers');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// AI抽出は最大60秒
module.exports.maxDuration = 60;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'リクエスト形式が不正です' });
  }
  const { emailId } = body;

  const redis = getRedis();
  const email = await redis.hgetall(`mail:email:${emailId}`);

  if (!email || !email.id) {
    return res.status(404).json({ error: 'メールが見つかりません' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return res.status(500).json({ error: 'Gemini APIキーが設定されていません' });
  }

  try {
    let result = null;

    // --- 添付ファイル解析（PDF/画像） ---
    let attachments = [];
    try {
      attachments = typeof email.attachments === 'string' 
        ? JSON.parse(email.attachments) 
        : (email.attachments || []);
    } catch { attachments = []; }
    const hasDocAttachment = attachments.some(a =>
      a.contentType?.includes('pdf') ||
      a.contentType?.includes('image/png') ||
      a.contentType?.includes('image/jpeg')
    );

    if (hasDocAttachment) {
      const account = await redis.hgetall(`mail:account:${email.accountId}`);
      if (account && account.encPassword) {
        try {
          const password = decrypt(account.encPassword);
          const client = new ImapFlow({
            host: account.imapHost,
            port: parseInt(account.imapPort),
            secure: true,
            auth: { user: account.email, pass: password },
            logger: false
          });

          await client.connect();
          const lock = await client.getMailboxLock('INBOX');

          try {
            // UIDで特定のメッセージの添付ファイルを取得
            for await (const msg of client.fetch(email.uid, {
              uid: true,
              source: true
            }, { uid: true })) {
              const parsed = await simpleParser(msg.source);

              if (parsed.attachments && parsed.attachments.length > 0) {
                // PDF or 画像の添付ファイルを抽出
                const att = parsed.attachments.find(a =>
                  a.contentType?.includes('pdf') ||
                  a.contentType?.includes('image/png') ||
                  a.contentType?.includes('image/jpeg')
                );

                if (att) {
                  const base64 = att.content.toString('base64');
                  const filePrompt = buildFilePrompt();

                  result = await callGemini(geminiKey, filePrompt, [{
                    mimeType: att.contentType,
                    data: base64
                  }]);
                }
              }
            }
          } finally {
            lock.release();
          }

          await client.logout();
        } catch (e) {
          console.error('IMAP再取得エラー:', e.message);
          // フォールバック: 本文のみで解析
        }
      }
    }

    // --- 本文解析（添付なし or 添付取得失敗） ---
    if (!result) {
      const bodyPrompt = buildBodyPrompt(email.subject, email.from, email.bodyText);
      result = await callGemini(geminiKey, bodyPrompt);
    }

    // 該当なし
    if (!result || result.type === 'none') {
      return res.json({
        success: true,
        document: null,
        message: '請求書・領収書は検出されませんでした'
      });
    }

    // --- 書類をRedisに保存 ---
    const docId = genId();
    const doc = {
      id: docId,
      userId: user.id,
      emailId: email.id,
      type: result.type === 'invoice' ? '請求書' : '領収書',
      vendor: result.vendor || '不明',
      date: result.date || '',
      amount: (parseInt(result.amount) || 0).toString(),
      amountEx: (parseInt(result.amountEx) || 0).toString(),
      tax: (parseInt(result.tax) || 0).toString(),
      items: JSON.stringify(result.items || []),
      confidence: (parseFloat(result.confidence) || 0).toString(),
      emailSubject: email.subject,
      emailFrom: email.from,
      emailDate: email.date,
      createdAt: new Date().toISOString()
    };

    await redis.hset(`mail:doc:${docId}`, doc);
    await redis.zadd(`mail:user:${user.id}:docs`, {
      score: Date.now(),
      member: docId
    });

    // メールに抽出済みフラグを設定
    await redis.hset(`mail:email:${emailId}`, { extracted: '1', docId });

    return res.json({
      success: true,
      document: {
        ...doc,
        items: result.items || [],
        amount: parseInt(result.amount) || 0,
        amountEx: parseInt(result.amountEx) || 0,
        tax: parseInt(result.tax) || 0,
        confidence: parseFloat(result.confidence) || 0
      }
    });
  } catch (e) {
    console.error('抽出エラー:', e);
    return res.status(500).json({ error: `抽出エラー: ${e.message}` });
  }
};

// --- プロンプトテンプレート ---

/** 添付ファイル解析用プロンプト */
function buildFilePrompt() {
  return `このファイルを分析して以下を判定してください:
1. type: "invoice"(請求書) or "receipt"(領収書) or "none"(該当なし)
2. vendor: 発行元の会社名・店名（短い名前）
3. date: 書類の日付（YYYY-MM-DD形式）
4. amount: 金額（税込み、数値のみ）
5. amountEx: 税抜き金額（わかる場合、数値のみ）
6. tax: 消費税額（わかる場合、数値のみ）
7. items: 品目名の配列（最大5件）
8. confidence: 確信度（0.0〜1.0）

JSON形式のみ: {"type":"invoice","vendor":"会社名","date":"2026-04-01","amount":12345,"amountEx":11223,"tax":1122,"items":["商品A"],"confidence":0.95}
※見積書・概算・お知らせは除外。実際の請求書または領収書のみ対象。
該当なし: {"type":"none","vendor":null,"date":null,"amount":0,"amountEx":0,"tax":0,"items":[],"confidence":0}`;
}

/** メール本文解析用プロンプト */
function buildBodyPrompt(subject, from, bodyText) {
  return `以下はメールの件名・差出人・本文です。「請求書」「領収書（購入・注文・決済）」に該当するか判定してください。

件名: ${subject}
差出人: ${from}
本文:
${(bodyText || '').substring(0, 5000)}

以下をJSON形式のみで返してください:
1. type: "invoice"(請求書) or "receipt"(領収書) or "none"(該当なし)
2. vendor: 取引先名（短い名前）
3. date: 書類の日付（YYYY-MM-DD形式）
4. amount: 金額（税込み、数値のみ）
5. amountEx: 税抜き金額（わかる場合）
6. tax: 消費税額（わかる場合）
7. items: 品目リスト（配列、最大5件）
8. confidence: 確信度（0.0〜1.0）

JSON形式のみ: {"type":"receipt","vendor":"会社名","date":"2026-04-01","amount":12345,"amountEx":11223,"tax":1122,"items":["商品A"],"confidence":0.9}
※見積書・概算・クーポン・お知らせは除外。
該当なし: {"type":"none","vendor":null,"date":null,"amount":0,"amountEx":0,"tax":0,"items":[],"confidence":0}`;
}
