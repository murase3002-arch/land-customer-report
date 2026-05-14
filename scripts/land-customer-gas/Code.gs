// ============================================================
// 土地なし管理客 週次レポート
// 毎週木曜日に自動実行 → Gmailでレポート送信
// URLからいつでもレポートを確認可能（Webアプリとしてデプロイ後）
// ============================================================

// ========== 設定 ==========
const CONFIG = {
  SPREADSHEET_ID: '1YnzNGi_VMOMpTpb0d9TdoJwMV0d-9tRiUnotoZ5ubT4',
  TARGET_SHEETS: ['2026年1月～（村瀬）', '村瀬2025年1月～'],
  RECIPIENT_EMAIL: 'murase3002@gmail.com',
  CLAUDE_API_KEY: '',
  UNFOLLOW_THRESHOLD_DAYS: 14,
  LOAN_ALERT_DAYS: 14, // ローン特約期日まで何日以内で警告するか
};

// ========== 列インデックス（0始まり）==========
const COL = {
  FIRST_CONTACT:  0, // A: 初回接客日
  NAME:           1, // B: お客様名
  DETAIL:         2, // C: 内容（エリア・予算等）
  FOLLOW_NOTES:   3, // D: フォロー状況
  REFERRAL:       4, // E: 紹介有無（住宅会社紹介あり・なし）
  REFERRAL_HM:    5, // F: 紹介HM契約
  LAND_CONTRACT:  6, // G: 土地契約（チェックあり = 契約済み → フォローリストから除外）
  LOAN_DEADLINE:  7, // H: ローン特約期日（日付）
  LOAN_APPLY:     8, // I: ローン本申込
  DECISION:       9, // J: 決裁案内
};

// ============================================================
// メイン処理（毎週木曜日に実行）
// ============================================================
function weeklyLandCustomerReport() {
  try {
    Logger.log('=== 土地なし管理客レポート 開始 ===');
    const allCustomers = getAllCustomers();
    Logger.log(`取得顧客数: ${allCustomers.length}名`);
    if (allCustomers.length === 0) { Logger.log('データなし。終了。'); return; }
    const aiSummary = getAiSummary(allCustomers);
    sendReportEmail(allCustomers, aiSummary);
    Logger.log('=== レポート送信完了 ===');
  } catch (e) {
    Logger.log(`エラー: ${e.message}`);
    GmailApp.sendEmail(CONFIG.RECIPIENT_EMAIL, '【エラー】土地なし管理客レポート',
      `エラーが発生しました。\n\n${e.message}\n\n${e.stack}`);
  }
}

// ============================================================
// URLからいつでも最新レポートを確認（Webアプリ用）
// ============================================================
function doGet() {
  try {
    const allCustomers = getAllCustomers();
    const aiSummary = getAiSummary(allCustomers);
    const today = new Date();
    const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
    const unfollowedCount = allCustomers.filter(c => c.isUnfollowed).length;
    const html = buildReportHtml(allCustomers, aiSummary, dateStr, unfollowedCount);
    return HtmlService.createHtmlOutput(html).setTitle('土地なし管理客レポート');
  } catch (e) {
    return HtmlService.createHtmlOutput(`<p>エラー: ${e.message}</p>`);
  }
}

// ============================================================
// スプレッドシートからデータ取得
// ============================================================
function getAllCustomers() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const customers = [];
  for (const sheetName of CONFIG.TARGET_SHEETS) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) { Logger.log(`シート "${sheetName}" が見つかりません`); continue; }
    const dataRange = sheet.getDataRange();
    const rows = dataRange.getValues();
    // A列の背景色を一括取得して打ち切り客を判定
    const backgrounds = sheet.getRange(1, 1, rows.length, 1).getBackgrounds();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = cleanName(row[COL.NAME]);
      if (!name) continue;
      // 濃い灰色背景 = 打ち切り客 → スキップ
      if (isDarkGray(backgrounds[i][0])) {
        Logger.log(`打ち切り客スキップ: ${name}`);
        continue;
      }
      customers.push(parseCustomerRow(row, sheetName));
    }
  }
  return customers;
}

// 名前のクリーニング（全角スペース・改行・前後空白を除去）
function cleanName(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/\r?\n/g, ' ')  // セル内改行をスペースに
    .replace(/　/g, ' ')      // 全角スペースを半角に
    .replace(/\s+/g, ' ')    // 連続スペースを1つに
    .trim();
}

// 濃い灰色かどうかを判定（打ち切り客の行検出）
function isDarkGray(hexColor) {
  if (!hexColor || hexColor === '#ffffff' || hexColor === 'white') return false;
  const h = hexColor.replace('#', '').toLowerCase();
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const diff = Math.max(r, g, b) - Math.min(r, g, b);
  // グレー系（色差 < 30）かつ明るすぎない（< 210）
  return diff < 30 && Math.max(r, g, b) < 210;
}

function parseCustomerRow(row, sheetName) {
  const firstContact = row[COL.FIRST_CONTACT];
  const followNotes  = String(row[COL.FOLLOW_NOTES] || '').trim();
  const lastFollowDate = extractLastFollowDate(followNotes, firstContact);
  const daysSinceFollow = calcDaysSince(lastFollowDate);

  const isLandContracted = !!row[COL.LAND_CONTRACT];

  // ローン特約期日（日付セル）
  const loanDeadlineRaw = row[COL.LOAN_DEADLINE];
  const loanDeadlineDate = loanDeadlineRaw instanceof Date
    ? loanDeadlineRaw
    : (loanDeadlineRaw ? new Date(loanDeadlineRaw) : null);
  const daysUntilLoan = (loanDeadlineDate && !isNaN(loanDeadlineDate.getTime()))
    ? Math.floor((loanDeadlineDate - new Date()) / 86400000)
    : null;
  const isLoanApplied = !!row[COL.LOAN_APPLY];
  const isLoanAlert = daysUntilLoan !== null
    && daysUntilLoan <= CONFIG.LOAN_ALERT_DAYS
    && !isLoanApplied;

  // ローン期日超過かつ本申込済み = 手続き完了とみなしてフォロー対象外
  const isLoanCompleted = daysUntilLoan !== null && daysUntilLoan <= 0 && isLoanApplied;

  const stages = {
    '紹介あり':    !!row[COL.REFERRAL],
    '紹介HM契約':  !!row[COL.REFERRAL_HM],
    '土地契約':    isLandContracted,
    'ローン本申込': isLoanApplied,
    '決裁案内':    !!row[COL.DECISION],
  };
  const completedStages = Object.entries(stages).filter(([, v]) => v).map(([k]) => k);

  // 土地契約済み or ローン手続き完了はフォロー不要（除外フラグ）
  const isUnfollowed = !isLandContracted && !isLoanCompleted &&
    (daysSinceFollow === null || daysSinceFollow >= CONFIG.UNFOLLOW_THRESHOLD_DAYS);

  const challenge = detectChallenge(stages, daysSinceFollow, daysUntilLoan);

  return {
    sheetName, name: cleanName(row[COL.NAME]),
    firstContact: formatDate(firstContact), detail: String(row[COL.DETAIL] || '').trim(),
    followNotes, lastFollowDate: lastFollowDate ? formatDate(lastFollowDate) : '記録なし',
    daysSinceFollow, stages, completedStages, isUnfollowed, isLandContracted,
    loanDeadline: (loanDeadlineDate && !isNaN(loanDeadlineDate.getTime())) ? formatDate(loanDeadlineDate) : null,
    daysUntilLoan, isLoanAlert, challenge,
  };
}

// 課題を自動判定する関数
function detectChallenge(stages, daysSinceFollow, daysUntilLoan) {
  // ローン特約期日アラート：本申込済みの場合は出さない
  if (!stages['ローン本申込']) {
    if (daysUntilLoan !== null && daysUntilLoan <= 0)  return { label: `ローン特約期日 超過！`, color: '#c92a2a' };
    if (daysUntilLoan !== null && daysUntilLoan <= 7)  return { label: `ローン特約期日まで${daysUntilLoan}日！`, color: '#c92a2a' };
    if (daysUntilLoan !== null && daysUntilLoan <= 14) return { label: `ローン特約期日まで${daysUntilLoan}日`, color: '#e67700' };
  }

  if (stages['決裁案内'])     return { label: '決裁待ち',                        color: '#7950f2' };
  if (stages['ローン本申込']) return { label: 'ローン審査中',                    color: '#1971c2' };
  if (stages['土地契約'])     return { label: '土地契約済み・ローン準備中',        color: '#2f9e44' };
  if (stages['紹介HM契約'])   return { label: 'HM契約済み・土地マッチングが課題', color: '#0ca678' };
  if (stages['紹介あり'])     return { label: 'HM契約への誘導が課題',             color: '#e67700' };
  if (daysSinceFollow !== null && daysSinceFollow >= 30) return { label: '長期未連絡・再接触が課題', color: '#c92a2a' };
  if (daysSinceFollow !== null && daysSinceFollow >= 14) return { label: '関係維持のフォローが課題', color: '#e67700' };
  return { label: '初期ヒアリング・ニーズ把握が課題', color: '#868e96' };
}

function extractLastFollowDate(text, fallback) {
  if (!text) return fallback instanceof Date ? fallback : null;
  const patterns = [/(\d{4})\/(\d{1,2})\/(\d{1,2})/g, /(\d{1,2})\/(\d{1,2})/g];
  let latestDate = null;
  const currentYear = new Date().getFullYear();
  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(text)) !== null) {
      const d = match.length === 4
        ? new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]))
        : new Date(currentYear, parseInt(match[1]) - 1, parseInt(match[2]));
      if (!latestDate || d > latestDate) latestDate = d;
    }
  }
  return latestDate || (fallback instanceof Date ? fallback : null);
}

function calcDaysSince(date) {
  if (!date) return null;
  return Math.floor((new Date() - (date instanceof Date ? date : new Date(date))) / 86400000);
}

function formatDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

// ============================================================
// Claude API で簡易サマリー生成
// ============================================================
function getAiSummary(customers) {
  try {
    const apiKey = CONFIG.CLAUDE_API_KEY ||
      PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
    if (!apiKey) return null;

    const unfollowed = customers.filter(c => c.isUnfollowed);
    const loanAlerts = customers.filter(c => c.isLoanAlert);

    const urgentLines = [
      ...loanAlerts.map(c => `・${c.name}：ローン特約期日まであと${c.daysUntilLoan}日`),
      ...unfollowed.slice(0, 5).map(c => `・${c.name}：${c.daysSinceFollow !== null ? c.daysSinceFollow + '日間未連絡' : '未連絡'}`),
    ].join('\n');

    const prompt = `不動産営業の週次フォロー管理です。データを見て今週やることを答えてください。

ルール：
- 箇条書き2行のみ（「・」で始める）
- 1行は30文字以内
- 名前を1人だけ具体的に入れる
- 余計な説明・前置き不要

【状況】総顧客${customers.length}名 / ローン期日警告${loanAlerts.length}名 / 未フォロー${unfollowed.length}名
【要注意】${urgentLines || 'なし'}

今週のアクション:`;

    const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
      muteHttpExceptions: true,
    });

    const result = JSON.parse(response.getContentText());
    if (result.error) { Logger.log(`Claude API エラー: ${result.error.message}`); return null; }
    return result.content[0].text.trim();
  } catch (e) {
    Logger.log(`AI サマリー取得失敗: ${e.message}`);
    return null;
  }
}

// ============================================================
// メール送信
// ============================================================
function sendReportEmail(customers, aiSummary) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const unfollowedCount = customers.filter(c => c.isUnfollowed).length;
  const loanAlertCount  = customers.filter(c => c.isLoanAlert).length;
  const alertTag = loanAlertCount > 0 ? `🚨ローン期日警告${loanAlertCount}件 ` : '';
  const subject = `【土地なし管理客レポート】${dateStr} ${alertTag}（未フォロー${unfollowedCount}名）`;
  const htmlBody = buildReportHtml(customers, aiSummary, dateStr, unfollowedCount);
  const plainText = `土地なし管理客レポート ${dateStr}\n未フォロー: ${unfollowedCount}名 / ローン期日警告: ${loanAlertCount}件`;
  GmailApp.sendEmail(CONFIG.RECIPIENT_EMAIL, subject, plainText, {
    htmlBody, name: '土地なし管理客レポートシステム',
  });
  Logger.log(`メール送信完了: ${CONFIG.RECIPIENT_EMAIL}`);
}

// ============================================================
// HTML レポート生成（メール・URL共通）
// ============================================================
function buildReportHtml(customers, aiSummary, dateStr, unfollowedCount) {
  // 曜日を動的に取得
  const dayNames = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
  const dayOfWeek = dayNames[new Date().getDay()];

  // ステージ進捗（実際の列に合わせて修正）
  const stageStats = [
    { name: '紹介あり',    color: '#7950f2', count: customers.filter(c => c.stages['紹介あり']).length },
    { name: '紹介HM契約',  color: '#0ca678', count: customers.filter(c => c.stages['紹介HM契約']).length },
    { name: '土地契約',    color: '#51cf66', count: customers.filter(c => c.stages['土地契約']).length },
    { name: 'ローン本申込', color: '#1971c2', count: customers.filter(c => c.stages['ローン本申込']).length },
    { name: '決裁案内',    color: '#e67700', count: customers.filter(c => c.stages['決裁案内']).length },
  ];
  const total = customers.length;

  const stageBars = stageStats.map(({ name, color, count }) => {
    const pct = total > 0 ? Math.round(count / total * 100) : 0;
    return `
    <div style="margin-bottom:12px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:5px;">
        <tr>
          <td style="font-size:13px;color:#555;">${name}</td>
          <td align="right" style="font-size:13px;font-weight:bold;color:${color};">${count}名</td>
        </tr>
      </table>
      <div style="background:#f0f0f0;border-radius:4px;height:8px;">
        <div style="background:${color};height:8px;border-radius:4px;width:${pct}%;"></div>
      </div>
    </div>`;
  }).join('');

  const unfollowedCustomers = customers
    .filter(c => c.isUnfollowed)
    .sort((a, b) => (b.daysSinceFollow || 0) - (a.daysSinceFollow || 0));

  const urgencyStyle = (days) => {
    if (days === null || days >= 30) return { bg: '#fff5f5', border: '#ff6b6b', badge: '#ff6b6b' };
    return { bg: '#fffbf0', border: '#fcc419', badge: '#e67700' };
  };

  // 完了ステージのバッジ（チェック済みのみ表示）
  const stageOrder = ['紹介あり', '紹介HM契約', '土地契約', 'ローン本申込', '決裁案内'];
  const stageBadge = (label) =>
    `<span style="display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;background:#eef2ff;color:#5c7cfa;margin:0 2px 3px 0;">${label}</span>`;

  // ローン期日アラート顧客（土地契約済みだがローン申込未）
  const loanAlertCustomers = customers
    .filter(c => c.isLoanAlert)
    .sort((a, b) => (a.daysUntilLoan || 999) - (b.daysUntilLoan || 999));

  // 顧客カード（table レイアウトでメールクライアント対応）
  const customerCards = unfollowedCustomers.map(c => {
    const col = urgencyStyle(c.daysSinceFollow);
    const daysLabel = c.daysSinceFollow !== null ? `${c.daysSinceFollow}日前` : '不明';
    const doneBadges = stageOrder.filter(s => c.stages[s]).map(stageBadge).join('');
    return `
    <div style="border-left:4px solid ${col.border};background:${col.bg};border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
        <tr>
          <td style="font-size:16px;font-weight:bold;color:#333;">${c.name}</td>
          <td align="right">
            <span style="background:${col.badge};color:white;font-size:11px;padding:3px 10px;border-radius:20px;white-space:nowrap;">${daysLabel}</span>
          </td>
        </tr>
      </table>
      <div style="font-size:12px;color:#999;margin-bottom:6px;">
        初回接客：${c.firstContact}　最終フォロー：${c.lastFollowDate}
      </div>
      ${doneBadges ? `<div style="margin-bottom:7px;">${doneBadges}</div>` : ''}
      ${c.detail ? `<div style="font-size:13px;color:#666;margin-bottom:7px;line-height:1.6;">${c.detail}</div>` : ''}
      <span style="display:inline-block;background:white;border:1px solid ${c.challenge.color};border-radius:6px;padding:4px 10px;font-size:12px;font-weight:bold;color:${c.challenge.color};">! 課題：${c.challenge.label}</span>
    </div>`;
  }).join('');

  // ローン期日アラートカード
  const loanAlertCards = loanAlertCustomers.map(c => {
    const urgent = c.daysUntilLoan !== null && c.daysUntilLoan <= 7;
    const bg     = urgent ? '#fff0f0' : '#fffbf0';
    const border = urgent ? '#ff6b6b' : '#fcc419';
    const badge  = urgent ? '#ff6b6b' : '#e67700';
    return `
    <div style="border-left:4px solid ${border};background:${bg};border-radius:0 10px 10px 0;padding:12px;margin-bottom:10px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
        <tr>
          <td style="font-size:16px;font-weight:bold;color:#333;">${c.name}</td>
          <td align="right">
            <span style="background:${badge};color:white;font-size:11px;padding:3px 10px;border-radius:20px;white-space:nowrap;">あと${c.daysUntilLoan}日</span>
          </td>
        </tr>
      </table>
      <div style="font-size:12px;color:#999;margin-bottom:6px;">
        ローン特約期日：${c.loanDeadline}　ローン本申込：${c.stages['ローン本申込'] ? '済' : '未'}
      </div>
      ${c.detail ? `<div style="font-size:13px;color:#666;margin-bottom:7px;line-height:1.6;">${c.detail}</div>` : ''}
      <span style="display:inline-block;background:white;border:1px solid ${c.challenge.color};border-radius:6px;padding:4px 10px;font-size:12px;font-weight:bold;color:${c.challenge.color};">! ${c.challenge.label}</span>
    </div>`;
  }).join('');

  const followedCount = customers.length - unfollowedCount;
  const loanAlertCount = customers.filter(c => c.isLoanAlert).length;

  // 統計カード（table レイアウトで CSS Grid の代替）
  const statCard = (value, label, color) =>
    `<td width="50%" style="padding:4px;">
      <div style="background:white;border-radius:14px;padding:16px;text-align:center;border-top:4px solid ${color};">
        <div style="font-size:34px;font-weight:bold;color:${color};">${value}</div>
        <div style="font-size:12px;color:#888;margin-top:2px;">${label}</div>
      </div>
    </td>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;margin:0;padding:0;background:#f0f2f5;color:#333;">
<div style="max-width:480px;margin:0 auto;padding:16px;">

  <!-- ヘッダー -->
  <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:22px 20px;border-radius:16px;margin-bottom:14px;">
    <div style="font-size:11px;opacity:0.75;letter-spacing:1.5px;margin-bottom:6px;">WEEKLY REPORT</div>
    <div style="font-size:20px;font-weight:bold;margin-bottom:4px;">土地なし管理客レポート</div>
    <div style="font-size:13px;opacity:0.85;">${dateStr}（${dayOfWeek}）</div>
  </div>

  <!-- 統計カード（table レイアウト：メールクライアント対応） -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
    <tr>
      ${statCard(customers.length, '総顧客数', '#667eea')}
      ${statCard(unfollowedCount, '未フォロー', '#ff6b6b')}
    </tr>
    <tr>
      ${statCard(followedCount, 'フォロー中', '#51cf66')}
      ${statCard(loanAlertCount, 'ローン期日警告', loanAlertCount > 0 ? '#c92a2a' : '#aaa')}
    </tr>
  </table>

  <!-- AIサマリー -->
  ${aiSummary ? `
  <div style="background:#f5f3ff;border-radius:14px;padding:14px 16px;margin-bottom:14px;border-left:4px solid #7c3aed;">
    <div style="font-size:12px;font-weight:bold;color:#7c3aed;margin-bottom:8px;">✨ 今週のアドバイス</div>
    <div style="font-size:13px;color:#333;line-height:1.9;white-space:pre-line;">${aiSummary}</div>
  </div>` : ''}

  <!-- ローン特約期日アラート（最優先表示） -->
  ${loanAlertCustomers.length > 0 ? `
  <div style="background:#fff0f0;border-radius:14px;padding:16px;margin-bottom:14px;border:2px solid #ff6b6b;">
    <div style="margin-bottom:12px;">
      <span style="background:#ff6b6b;color:white;border-radius:8px;padding:5px 10px;font-size:13px;font-weight:bold;">🚨 ローン特約期日が迫っています（${loanAlertCustomers.length}名）</span>
    </div>
    ${loanAlertCards}
  </div>` : ''}

  <!-- 未フォロー客リスト -->
  ${unfollowedCustomers.length > 0 ? `
  <div style="background:white;border-radius:14px;padding:16px;margin-bottom:14px;">
    <div style="margin-bottom:12px;">
      <span style="background:#fff0f0;color:#ff6b6b;border-radius:8px;padding:5px 10px;font-size:13px;font-weight:bold;">⚠ 要フォロー ${unfollowedCustomers.length}名</span>
    </div>
    ${customerCards}
  </div>` : `
  <div style="background:#f0fdf4;border-radius:14px;padding:16px;margin-bottom:14px;text-align:center;">
    <div style="font-size:24px;margin-bottom:4px;">✅</div>
    <div style="font-size:14px;font-weight:bold;color:#16a34a;">未フォロー客はいません</div>
  </div>`}

  <!-- ステージ別進捗 -->
  <div style="background:white;border-radius:14px;padding:16px;margin-bottom:14px;">
    <div style="font-size:15px;font-weight:bold;color:#333;margin-bottom:14px;">ステージ別進捗</div>
    ${stageBars}
  </div>

  <!-- フッター -->
  <div style="text-align:center;font-size:11px;color:#aaa;padding:8px;">
    Google Apps Script + Claude AI により自動生成
  </div>

</div>
</body>
</html>`;
}

// ============================================================
// トリガー設定（初回1回だけ実行 → 毎週木曜 9:00 に自動送信）
// ============================================================
function setWeeklyTrigger() {
  // 既存のトリガーを全削除（重複防止）
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'weeklyLandCustomerReport') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 毎週木曜日 9:00 に実行
  ScriptApp.newTrigger('weeklyLandCustomerReport')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.THURSDAY)
    .atHour(9)
    .create();

  Logger.log('トリガー設定完了：毎週木曜日 9:00');
}

// ============================================================
// 手動テスト用
// ============================================================
function testRun() {
  weeklyLandCustomerReport();
}
