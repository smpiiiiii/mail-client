/**
 * 全メール一括AI抽出API
 * POST /api/extract-all
 * 未抽出のメールを一括でGemini AIにかけて請求書・領収書を自動判定
 * 45秒制限で自動切り上げ、続きは再度リクエスト
 */
const { getRedis, getUser, decrypt, callGemini, cors, genId } = require('./helpers');

// 最大60秒
module.exports.maxDuration = 60;

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = getUser(req);
  if (!user) return res.status(401).json({ error: '認証が必要です' });

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(500).json({ error: 'Gemini APIキーが設定されていません' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const userKeywords = body.keywords ? body.keywords.split(/[,、\s]+/).filter(k => k.trim()) : null;

  const redis = getRedis();
  const startTime = Date.now();
  const TIMEOUT = 45000; // 45秒で切り上げ

  try {
    // ユーザーの全メールIDを取得
    const emailIds = await redis.zrange(`mail:user:${user.id}:emails`, 0, -1);
    if (!emailIds || emailIds.length === 0) {
      return res.json({ success: true, processed: 0, extracted: 0, skipped: 0, remaining: 0, message: 'メールがありません' });
    }

    let processed = 0;
    let extracted = 0;
    let skipped = 0;
    let filtered = 0; // キーワードフィルタで除外した件数
    let errors = 0;
    const results = [];

    for (const emailId of emailIds) {
      // タイムアウトチェック
      if (Date.now() - startTime > TIMEOUT) break;

      const email = await redis.hgetall(`mail:email:${emailId}`);
      if (!email || !email.id) continue;

      // 既に抽出済みならスキップ（ユーザーキーワード指定時は再スキャン対象）
      if (email.extracted === '1' && !userKeywords) {
        skipped++;
        continue;
      }

      // キーワード事前フィルタ（AI呼び出し前に絞り込み）
      // 件名のみでチェック（差出人は誤マッチが多いため除外）
      const subject = (email.subject || '').toLowerCase();
      const KEYWORDS = userKeywords || [
        // 請求・領収系（最も確実）
        '請求', '領収', '御請求', '御見積',
        // 決済・支払系
        '決済', '支払', '引き落とし', '振込', '入金',
        // 購入・注文系
        '注文確認', '購入', 'ご注文', 'お買い上げ',
        // 明細系
        '明細', '利用明細', '取引明細',
        // 英語
        'invoice', 'receipt', 'payment', 'billing',
        // その他
        '納品', '見積書', '代金'
      ];
      // 除外キーワード（ニュース・プロモーション・通知系を弾く）
      const EXCLUDE = [
        'キャンペーン', 'セール', 'お知らせ', 'ニュース', '新着',
        'アップデート', '更新のお知らせ', 'メルマガ', 'プレゼント',
        '急募', '募集', '障害', 'failure', 'failed', 'ログイン通知',
        'セキュリティ', '認証', 'パスワード', '事例', '紹介'
      ];
      const hasExclude = EXCLUDE.some(kw => subject.includes(kw.toLowerCase()));
      const hasKeyword = KEYWORDS.some(kw => subject.includes(kw.toLowerCase()));
      if (!hasKeyword || hasExclude) {
        // キーワードなし or 除外対象 → スキップ
        await redis.hset(`mail:email:${emailId}`, { extracted: '1' });
        filtered++;
        continue;
      }

      console.log(`🔍 キーワードマッチ: "${(email.subject || '').substring(0, 50)}" from ${(email.from || '').substring(0, 30)}`);

      processed++;

      try {
        // 本文からAI抽出（添付ファイルは一括では省略、高速化のため）
        const bodyPrompt = buildBodyPrompt(email.subject, email.from, email.bodyText);
        const result = await callGemini(geminiKey, bodyPrompt);

        if (!result || result.type === 'none') {
          // 該当なし → 抽出済みフラグだけ立てる（再スキャン不要）
          await redis.hset(`mail:email:${emailId}`, { extracted: '1' });
          continue;
        }

        // 書類をRedisに保存
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
        await redis.hset(`mail:email:${emailId}`, { extracted: '1', docId });

        extracted++;
        results.push({
          type: doc.type,
          vendor: doc.vendor,
          amount: parseInt(doc.amount),
          subject: email.subject
        });
      } catch (e) {
        console.error(`抽出エラー (${emailId}):`, e.message);
        errors++;
        // エラーでも続行
      }
    }

    // 残りの未抽出メール数を計算
    const remaining = emailIds.length - skipped - processed - filtered;

    console.log(`📊 スキャン結果: 処理${processed} 抽出${extracted} 既済${skipped} フィルタ除外${filtered} エラー${errors} 残り${remaining}`);

    return res.json({
      success: true,
      processed,
      extracted,
      skipped,
      filtered,
      errors,
      remaining: Math.max(0, remaining),
      results,
      message: remaining > 0
        ? `${processed}件処理(${filtered}件除外)、${extracted}件抽出。残り${remaining}件`
        : `全${processed + filtered}件完了（AI処理:${processed} フィルタ除外:${filtered} 抽出:${extracted}件）`
    });
  } catch (e) {
    console.error('一括抽出エラー:', e);
    return res.status(500).json({ error: `一括抽出エラー: ${e.message}` });
  }
};

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
