/**
 * IMAP同期 + AI抽出 統合API
 * POST /api/sync
 * 「取込」ボタンで呼ばれる。
 * 1. IMAPサーバーで財務系キーワード検索（領収、請求、receipt等）
 * 2. マッチしたメールだけ本文付きで取得
 * 3. 即座にGemini AIで書類判定・金額抽出
 * → スキャン不要、取込1回で完結
 */
const { getRedis, getUser, decrypt, callGemini, cors, genId } = require('./helpers');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');

// 最大60秒
module.exports.maxDuration = 60;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { accountId, month } = body;

  const redis = getRedis();
  const geminiKey = process.env.GEMINI_API_KEY;
  const account = await redis.hgetall(`mail:account:${accountId}`);

  if (!account || account.userId !== user.id) {
    return res.status(404).json({ error: 'アカウントが見つかりません' });
  }

  let password;
  try {
    password = decrypt(account.encPassword);
  } catch {
    return res.status(400).json({ error: 'パスワードの復号に失敗しました。アカウントを再登録してください。' });
  }

  const client = new ImapFlow({
    host: account.imapHost,
    port: parseInt(account.imapPort),
    secure: true,
    auth: { user: account.email, pass: password },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let synced = 0;
    let extracted = 0;
    const BATCH_SIZE = 50;
    const startTime = Date.now();
    const TIMEOUT_MS = 50000; // 50秒で切り上げ

    let uidsToFetch;
    try {
      const lastUid = parseInt(account.lastSyncedUid) || 0;
      let maxUid = lastUid;

      // 財務系キーワード（IMAP SEARCH用）
      const FINANCE_KEYWORDS = [
        '請求', '領収', '御請求', '御見積',
        '決済', '支払', '振込', '入金',
        '引き落とし', '明細', '納品書',
        'invoice', 'receipt', 'payment', 'billing'
      ];

      // 各キーワードでIMAP SEARCHし、UIDを集約
      const uidSet = new Set();
      const dateFilter = {};
      if (month) {
        const [year, mon] = month.split('-').map(Number);
        dateFilter.since = new Date(year, mon - 1, 1);
        dateFilter.before = new Date(year, mon, 1);
      } else if (lastUid > 0) {
        // 差分同期
      } else {
        const since = new Date();
        since.setDate(since.getDate() - 90);
        dateFilter.since = since;
      }

      for (const kw of FINANCE_KEYWORDS) {
        try {
          // 件名のみで検索（本文検索は遅いため）
          const query = { ...dateFilter, subject: kw };
          if (lastUid > 0 && !month) query.uid = `${lastUid + 1}:*`;
          const results = await client.search(query, { uid: true });
          for (const uid of results) {
            if (lastUid > 0 && uid <= lastUid && !month) continue;
            uidSet.add(uid);
          }
        } catch (searchErr) {
          console.log(`IMAP検索スキップ: "${kw}" - ${searchErr.message}`);
        }
      }

      uidsToFetch = Array.from(uidSet);
      console.log(`📬 IMAP検索: ${FINANCE_KEYWORDS.length}キーワードで ${uidsToFetch.length}件ヒット`);

      if (uidsToFetch.length === 0) {
        lock.release();
        await client.logout();
        return res.json({
          success: true, synced: 0, extracted: 0,
          message: month ? `${month}の対象メールはありません` : '新しい対象メールはありません'
        });
      }

      // 最新から取得
      uidsToFetch.sort((a, b) => b - a);
      const targetUids = uidsToFetch.slice(0, BATCH_SIZE);
      const uidRange = targetUids.join(',');

      // 既存UID取得（重複防止）
      const existingIds = await redis.zrange(`mail:account:${accountId}:emails`, 0, -1) || [];
      const existingUids = new Set();
      for (const eid of existingIds) {
        const u = await redis.hget(`mail:email:${eid}`, 'uid');
        if (u) existingUids.add(String(u));
      }

      for await (const msg of client.fetch(uidRange, {
        uid: true, envelope: true, bodyStructure: true,
        source: true
      }, { uid: true })) {
        if (Date.now() - startTime > TIMEOUT_MS) break;
        if (synced >= BATCH_SIZE) break;
        if (existingUids.has(String(msg.uid))) continue;

        const env = msg.envelope;
        const emailId = genId();
        const timestamp = env.date ? new Date(env.date).getTime() : Date.now();

        // 添付ファイル情報
        const attachments = [];
        function walkParts(part) {
          if (part.disposition === 'attachment' || (part.type && part.subtype && part.size > 0 && part.disposition)) {
            attachments.push({
              filename: (part.dispositionParameters && part.dispositionParameters.filename) || (part.parameters && part.parameters.name) || '添付ファイル',
              contentType: `${part.type}/${part.subtype}`,
              size: part.size || 0
            });
          }
          if (part.childNodes) part.childNodes.forEach(walkParts);
        }
        if (msg.bodyStructure) walkParts(msg.bodyStructure);

        // 差出人情報
        const fromAddr = env.from && env.from[0] ? env.from[0] : {};
        const fromText = fromAddr.address || '';
        const fromName = fromAddr.name || '';
        const toAddr = env.to && env.to[0] ? env.to[0] : {};

        // mailparserで本文+添付PDFをパース（日本語対応）
        let bodyText = '';
        let bodyPreview = '';
        let pdfText = '';
        if (msg.source) {
          try {
            const parsed = await simpleParser(msg.source);
            bodyText = (parsed.text || '').substring(0, 8000);
            if (!bodyText && parsed.html) {
              bodyText = parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 8000);
            }
            bodyPreview = bodyText.substring(0, 200);

            // PDF添付ファイルからテキスト抽出
            if (parsed.attachments && parsed.attachments.length > 0) {
              for (const att of parsed.attachments) {
                if (att.contentType === 'application/pdf' && att.content && att.size < 2 * 1024 * 1024) {
                  try {
                    const pdf = await pdfParse(att.content);
                    if (pdf.text) {
                      pdfText += `\n[添付PDF: ${att.filename || 'file.pdf'}]\n${pdf.text.substring(0, 5000)}\n`;
                      console.log(`📎 PDF抽出: ${att.filename} (${Math.round(att.size/1024)}KB, ${pdf.text.length}文字)`);
                    }
                  } catch (pdfErr) {
                    console.log(`PDF解析スキップ: ${att.filename} - ${pdfErr.message}`);
                  }
                }
              }
            }
          } catch (parseErr) {
            console.error(`メール解析エラー (UID:${msg.uid}):`, parseErr.message);
          }
        }

        // メール本文 + PDF内容を結合（AI抽出用）
        const fullText = pdfText ? (bodyText + pdfText).substring(0, 12000) : bodyText;

        const subject = env.subject || '(件名なし)';

        // メールをRedisに保存
        await redis.hset(`mail:email:${emailId}`, {
          id: emailId,
          accountId,
          messageId: env.messageId || '',
          uid: msg.uid.toString(),
          subject,
          from: fromText,
          fromName: fromName,
          to: toAddr.address || '',
          date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
          timestamp: timestamp.toString(),
          bodyPreview,
          bodyText,
          bodyHtml: '',
          hasAttachment: attachments.length > 0 ? '1' : '0',
          attachments: JSON.stringify(attachments),
          isRead: '0',
          extracted: '0'
        });

        await redis.zadd(`mail:account:${accountId}:emails`, { score: timestamp, member: emailId });
        await redis.zadd(`mail:user:${user.id}:emails`, { score: timestamp, member: emailId });

        if (msg.uid > maxUid) maxUid = msg.uid;
        synced++;

        // === AI抽出（取込と同時に実行） ===
        if (geminiKey && (bodyText || pdfText)) {
          try {
            console.log(`🔍 AI送信: "${subject.substring(0, 50)}" body:${bodyText.length}文字 pdf:${pdfText.length}文字`);
            const prompt = buildBodyPrompt(subject, fromText, fullText);
            const result = await callGemini(geminiKey, prompt);
            console.log(`📋 AI結果: type=${result?.type} vendor=${result?.vendor} amount=${result?.amount}`);

            if (result && result.type !== 'none') {
              const docId = genId();
              const doc = {
                id: docId,
                userId: user.id,
                emailId,
                type: result.type === 'invoice' ? '請求書' : '領収書',
                vendor: result.vendor || '不明',
                date: result.date || '',
                amount: (parseInt(result.amount) || 0).toString(),
                amountEx: (parseInt(result.amountEx) || 0).toString(),
                tax: (parseInt(result.tax) || 0).toString(),
                items: JSON.stringify(result.items || []),
                confidence: (parseFloat(result.confidence) || 0).toString(),
                emailSubject: subject,
                emailFrom: fromText,
                emailDate: env.date ? new Date(env.date).toISOString() : '',
                createdAt: new Date().toISOString()
              };
              await redis.hset(`mail:doc:${docId}`, doc);
              await redis.zadd(`mail:user:${user.id}:docs`, { score: Date.now(), member: docId });
              await redis.hset(`mail:email:${emailId}`, { extracted: '1', docId });
              extracted++;
              console.log(`✅ 抽出: ${doc.type} ${doc.vendor} ¥${doc.amount} ← "${subject.substring(0, 40)}"`);
            } else {
              await redis.hset(`mail:email:${emailId}`, { extracted: '1' });
              console.log(`⏭️ 該当なし: "${subject.substring(0, 40)}"`);
            }
          } catch (aiErr) {
            console.error(`❌ AI抽出エラー: ${aiErr.message} ← "${subject.substring(0, 30)}"`);
          }
        } else {
          console.log(`⚠️ 本文なし: "${(env.subject || '').substring(0, 40)}" body:${bodyText.length} pdf:${pdfText.length}`);
        }
      }

      // lastSyncedUid更新
      if (!month && maxUid > lastUid) {
        await redis.hset(`mail:account:${accountId}`, {
          lastSyncedUid: maxUid.toString(),
          lastSynced: new Date().toISOString()
        });
      } else if (month) {
        await redis.hset(`mail:account:${accountId}`, {
          lastSynced: new Date().toISOString()
        });
      }

      lock.release();
    } catch (e) {
      console.error('同期内部エラー:', e.message);
      try { lock.release(); } catch {}
      throw e;
    }

    await client.logout();
    return res.json({
      success: true,
      synced,
      extracted,
      total: uidsToFetch ? uidsToFetch.length : synced,
      message: `${synced}件取込、${extracted}件の書類を抽出しました`
    });
  } catch (e) {
    console.error('同期エラー:', e);
    try { await client.logout(); } catch {}
    return res.status(500).json({ error: `同期エラー: ${e.message}` });
  }
};

/** メール本文からAI抽出用プロンプト */
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
