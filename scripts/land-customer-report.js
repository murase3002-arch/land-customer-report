#!/usr/bin/env node
'use strict';

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = process.env.REPORT_CONFIG
    ? path.join(__dirname, '..', process.env.REPORT_CONFIG)
    : path.join(__dirname, '..', 'configs', 'projects', 'land-customers.yml');

  const text = fs.readFileSync(configPath, 'utf8');

  function pick(key) {
    const m = text.match(new RegExp(`^\\s*${key}:\\s*["\']?([^"\'\\n#]+)["\']?`, 'm'));
    return m ? m[1].trim() : null;
  }
  function pickInt(key) {
    const v = pick(key);
    return v ? parseInt(v, 10) : null;
  }

  // uncontacted_values リストのパース
  const uncontactedValues = [];
  let inList = false;
  for (const line of text.split('\n')) {
    if (line.includes('uncontacted_values:')) { inList = true; continue; }
    if (inList) {
      const m = line.match(/^\s+-\s*"?([^"#]*)"?\s*$/);
      if (m) uncontactedValues.push(m[1].trim());
      else if (line.match(/^\s+\S/) && !line.match(/^\s+-/)) inList = false;
      else if (line.match(/^\S/)) inList = false;
    }
  }

  return {
    spreadsheetId:       pick('id'),
    sheetName:           pick('sheet_name') || 'シート1',
    dataStartRow:        pickInt('data_start_row') || 2,
    columns: {
      firstMeeting:    pickInt('first_meeting')    || 1,
      customerName:    pickInt('customer_name')    || 2,
      details:         pickInt('details')          || 3,
      followStatus:    pickInt('follow_status')    || 4,
      referral:        pickInt('referral')         || 5,
      referralHm:      pickInt('referral_hm')      || 6,
      landContract:    pickInt('land_contract')    || 7,
      loanDeadline:    pickInt('loan_deadline')    || 8,
      loanApplied:     pickInt('loan_applied')     || 9,
      settlementSent:  pickInt('settlement_sent')  || 10,
    },
    uncontactedValues: uncontactedValues.length ? uncontactedValues : ['', '未', '未対応', '未フォロー'],
    firstMeetingAlertDays: pickInt('days_since_first_meeting_alert') || 30,
    loanDeadlineAlertDays: pickInt('loan_deadline_alert_days') || 14,
    emailTo:       pick('to'),
    subjectPrefix: pick('subject_prefix') || '【土地なし管理客】週次レポート',
  };
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

function getGoogleAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
  const key = JSON.parse(Buffer.from(keyJson, 'base64').toString('utf8'));
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function fetchSheetData(config) {
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.sheetName}!A1:Z`,
  });

  const rows = response.data.values || [];
  if (rows.length < config.dataStartRow) return [];

  const c = config.columns;
  const customers = [];

  for (let i = config.dataStartRow - 1; i < rows.length; i++) {
    const row = rows[i];
    const name = (row[c.customerName - 1] || '').trim();
    if (!name) continue;

    customers.push({
      firstMeeting:   (row[c.firstMeeting   - 1] || '').trim(),
      name,
      details:        (row[c.details        - 1] || '').trim(),
      followStatus:   (row[c.followStatus   - 1] || '').trim(),
      referral:       (row[c.referral       - 1] || '').trim(),
      referralHm:     (row[c.referralHm     - 1] || '').trim(),
      landContract:   (row[c.landContract   - 1] || '').trim(),
      loanDeadline:   (row[c.loanDeadline   - 1] || '').trim(),
      loanApplied:    (row[c.loanApplied    - 1] || '').trim(),
      settlementSent: (row[c.settlementSent - 1] || '').trim(),
    });
  }

  return customers;
}

// ─── Analysis Helpers ─────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  const s = str.replace(/年/g, '/').replace(/月/g, '/').replace(/日/g, '').replace(/-/g, '/');
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysSince(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function daysUntil(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  return Math.floor((d.getTime() - Date.now()) / 86400000);
}

function isTruthy(str) {
  return /^(○|済|◎|有|あり|yes|true|1|完了|送付済|送った)/i.test((str || '').trim());
}

function isUncontacted(followStatus, uncontactedValues) {
  return uncontactedValues.includes(followStatus.trim());
}

function categorize(customers, config) {
  const uncontacted = [];
  const inProgress  = [];
  const contracted  = [];  // 土地契約済み
  const loanAlert   = [];  // ローン特約期日が迫っている

  for (const c of customers) {
    const noFollow = isUncontacted(c.followStatus, config.uncontactedValues);
    const sinceFirst = daysSince(c.firstMeeting);
    const untilLoan  = daysUntil(c.loanDeadline);
    const hasLand    = isTruthy(c.landContract);

    const customer = { ...c, sinceFirst, untilLoan, hasLand };

    if (untilLoan !== null && untilLoan <= config.loanDeadlineAlertDays && !isTruthy(c.loanApplied)) {
      loanAlert.push(customer);
    }

    if (hasLand) {
      contracted.push(customer);
    } else if (noFollow) {
      uncontacted.push(customer);
    } else {
      inProgress.push(customer);
    }
  }

  // 未フォローは初回接客日が古い順
  uncontacted.sort((a, b) => (b.sinceFirst || 0) - (a.sinceFirst || 0));
  // ローン期日は近い順
  loanAlert.sort((a, b) => (a.untilLoan || 999) - (b.untilLoan || 999));

  return { uncontacted, inProgress, contracted, loanAlert };
}

// ─── Claude Analysis ──────────────────────────────────────────────────────────

async function analyzeWithClaude(customers, cat, dateLabel) {
  const client = new Anthropic();

  const fmt = (c) => {
    const parts = [];
    if (c.firstMeeting) parts.push(`初回接客: ${c.firstMeeting}${c.sinceFirst !== null ? `（${c.sinceFirst}日前）` : ''}`);
    if (c.details)      parts.push(`内容: ${c.details}`);
    if (c.followStatus) parts.push(`フォロー: ${c.followStatus}`);
    if (c.referral)     parts.push(`紹介: ${c.referral}`);
    if (c.referralHm)   parts.push(`紹介HM契約: ${c.referralHm}`);
    if (c.landContract) parts.push(`土地契約: ${c.landContract}`);
    if (c.loanDeadline) parts.push(`ローン特約期日: ${c.loanDeadline}${c.untilLoan !== null ? `（あと${c.untilLoan}日）` : ''}`);
    if (c.loanApplied)  parts.push(`ローン本申込: ${c.loanApplied}`);
    if (c.settlementSent) parts.push(`決済案内: ${c.settlementSent}`);
    return `・${c.name}\n  ${parts.join(' | ')}`;
  };

  const sections = [
    cat.loanAlert.length   ? `【⚠️ ローン特約期日が迫っている顧客】\n${cat.loanAlert.map(fmt).join('\n')}` : '',
    cat.uncontacted.length ? `【未フォロー客】\n${cat.uncontacted.map(fmt).join('\n')}` : '',
    cat.inProgress.length  ? `【フォロー中】\n${cat.inProgress.map(fmt).join('\n')}` : '',
    cat.contracted.length  ? `【土地契約済み】\n${cat.contracted.map(fmt).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const prompt = `あなたは不動産営業のサポートAIです。
以下は土地なし管理客の${dateLabel}時点のデータです。週次レポートを作成してください。

【集計】
- 全顧客: ${customers.length}名
- 未フォロー: ${cat.uncontacted.length}名
- フォロー中: ${cat.inProgress.length}名
- 土地契約済み: ${cat.contracted.length}名
- ローン特約期日が${config_placeholder}日以内: ${cat.loanAlert.length}名
- 紹介あり: ${customers.filter(c => isTruthy(c.referral)).length}名

${sections}

以下の内容を含む週次レポートをJSON形式で出力してください:

{
  "summary": "今週の全体状況サマリー（3〜5行。営業メンバーが月曜朝に読む想定で、具体的な件数・傾向・推奨アクションを含める）",
  "top3": [
    {
      "name": "顧客名",
      "reason": "今週最優先でコンタクトすべき理由（ローン期日・長期未接触・進捗停滞などを具体的に）",
      "action": "具体的に何をすべきか（電話・書類確認・日程調整など）"
    }
  ],
  "alerts": "緊急対応が必要な事項（ローン特約期日・決済案内未送付など）。なければ空文字",
  "trends": "顧客全体のエリア・予算・進捗の傾向（2〜3行）"
}

JSON以外は出力しないこと。`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content[0].text;
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Claude returned no JSON: ' + text.slice(0, 300));
  return JSON.parse(text.slice(start, end + 1));
}

// config_placeholder は analyzeWithClaude 呼び出し前に差し替え
let config_placeholder = 14;

// ─── Email Builder ────────────────────────────────────────────────────────────

function buildEmail(customers, cat, analysis, dateLabel) {
  const referralCount   = customers.filter(c => isTruthy(c.referral)).length;
  const referralHmCount = customers.filter(c => isTruthy(c.referralHm)).length;
  const loanAppliedCount = customers.filter(c => isTruthy(c.loanApplied)).length;
  const settlementCount  = customers.filter(c => isTruthy(c.settlementSent)).length;

  const summaryHtml = esc(analysis.summary || '').replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
  const alertsHtml  = esc(analysis.alerts  || '').replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
  const trendsHtml  = esc(analysis.trends  || '').replace(/\\n/g, '<br>').replace(/\n/g, '<br>');

  const customerCard = (c) => {
    const badges = [];
    if (c.hasLand)                            badges.push(badge('土地契約済', '#fef9c3', '#854d0e'));
    if (isTruthy(c.referral))                 badges.push(badge('紹介あり', '#ede9fe', '#5b21b6'));
    if (isTruthy(c.referralHm))               badges.push(badge('HM契約', '#fce7f3', '#9d174d'));
    if (isTruthy(c.loanApplied))              badges.push(badge('ローン申込済', '#dcfce7', '#166534'));
    if (isTruthy(c.settlementSent))           badges.push(badge('決済案内済', '#e0f2fe', '#0369a1'));
    if (c.untilLoan !== null && c.untilLoan <= 14) {
      badges.push(badge(`ローン期日まで${c.untilLoan}日`, '#fee2e2', '#991b1b'));
    }

    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <div style="margin-bottom:5px;display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;">
            <strong style="font-size:14px;color:#1e293b;">${esc(c.name)}</strong>
            ${badges.join('')}
          </div>
          <div style="font-size:12px;color:#64748b;line-height:1.8;">
            ${c.firstMeeting  ? `<span>初回接客: ${esc(c.firstMeeting)}${c.sinceFirst !== null ? `（${c.sinceFirst}日前）` : ''}</span><br>` : ''}
            ${c.details       ? `<span style="color:#475569;">${esc(c.details)}</span><br>` : ''}
            ${c.followStatus  ? `<span>フォロー状況: ${esc(c.followStatus)}</span><br>` : '<span style="color:#ef4444;">フォロー状況: 未記入</span><br>'}
            ${c.loanDeadline  ? `<span>ローン特約期日: ${esc(c.loanDeadline)}${c.untilLoan !== null ? ` — あと<strong>${c.untilLoan}日</strong>` : ''}</span><br>` : ''}
          </div>
        </td>
      </tr>`;
  };

  const top3Rows = (analysis.top3 || []).map((t, i) => `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #f1f5f9;">
          <div style="font-size:13px;font-weight:bold;color:#1e293b;margin-bottom:3px;">
            <span style="color:#f59e0b;margin-right:6px;">${['①','②','③'][i] || (i+1)+'.'}  </span>${esc(t.name)}
          </div>
          <div style="font-size:12px;color:#64748b;margin-bottom:3px;">${esc(t.reason)}</div>
          <div style="font-size:12px;color:#0f172a;font-weight:500;">→ ${esc(t.action)}</div>
        </td>
      </tr>`).join('');

  const section = (title, color, count, rows, emptyMsg) => `
  <div style="padding:20px 24px 12px;border-bottom:1px solid #f1f5f9;">
    <h2 style="margin:0 0 10px;font-size:15px;color:${color};">${title}（${count}名）</h2>
    ${rows
      ? `<table style="width:100%;border-collapse:collapse;">${rows}</table>`
      : `<p style="color:#64748b;font-size:13px;margin:0;">${emptyMsg}</p>`}
  </div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Segoe UI',sans-serif;">
<div style="max-width:660px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.07);">

  <!-- Header -->
  <div style="background:#1e40af;padding:24px;">
    <h1 style="margin:0;color:#fff;font-size:18px;">土地なし管理客 週次レポート</h1>
    <p style="margin:6px 0 0;color:#bfdbfe;font-size:13px;">${dateLabel}</p>
  </div>

  <!-- Stats -->
  <div style="display:flex;flex-wrap:wrap;background:#eff6ff;border-bottom:1px solid #dbeafe;">
    ${stat('全顧客',      customers.length,      '#1e40af')}
    ${stat('未フォロー',   cat.uncontacted.length, '#dc2626')}
    ${stat('フォロー中',   cat.inProgress.length,  '#16a34a')}
    ${stat('土地契約済',   cat.contracted.length,  '#b45309')}
    ${stat('紹介あり',     referralCount,          '#7c3aed')}
    ${stat('紹介HM契約',  referralHmCount,         '#0e7490')}
    ${stat('ローン申込済', loanAppliedCount,        '#0369a1')}
    ${stat('決済案内済',   settlementCount,         '#059669')}
  </div>

  ${alertsHtml ? `
  <!-- Alerts -->
  <div style="padding:16px 24px;background:#fef2f2;border-bottom:2px solid #fecaca;">
    <div style="font-size:13px;font-weight:bold;color:#dc2626;margin-bottom:4px;">⚠ 緊急対応事項</div>
    <p style="margin:0;font-size:13px;color:#7f1d1d;line-height:1.7;">${alertsHtml}</p>
  </div>` : ''}

  <!-- Summary -->
  <div style="padding:20px 24px;border-bottom:1px solid #f1f5f9;">
    <h2 style="margin:0 0 10px;font-size:15px;color:#1e293b;">今週のサマリー</h2>
    <p style="margin:0;font-size:13px;color:#475569;line-height:1.8;">${summaryHtml}</p>
  </div>

  ${top3Rows ? `
  <!-- Top 3 -->
  <div style="padding:20px 24px 12px;border-bottom:1px solid #f1f5f9;">
    <h2 style="margin:0 0 10px;font-size:15px;color:#1e293b;">優先フォロー TOP3</h2>
    <table style="width:100%;border-collapse:collapse;">${top3Rows}</table>
  </div>` : ''}

  ${cat.loanAlert.length ? section('⚠ ローン特約期日 警告', '#dc2626', cat.loanAlert.length,
    cat.loanAlert.map(customerCard).join(''), '') : ''}

  ${section('未フォロー客', '#dc2626', cat.uncontacted.length,
    cat.uncontacted.length ? cat.uncontacted.map(customerCard).join('') : null,
    '未フォロー客はいません')}

  ${section('フォロー中', '#16a34a', cat.inProgress.length,
    cat.inProgress.length ? cat.inProgress.map(customerCard).join('') : null,
    'データなし')}

  ${cat.contracted.length ? section('土地契約済み', '#b45309', cat.contracted.length,
    cat.contracted.map(customerCard).join(''), '') : ''}

  ${trendsHtml ? `
  <div style="padding:20px 24px;border-bottom:1px solid #f1f5f9;">
    <h2 style="margin:0 0 10px;font-size:15px;color:#1e293b;">傾向・分析</h2>
    <p style="margin:0;font-size:13px;color:#475569;line-height:1.8;">${trendsHtml}</p>
  </div>` : ''}

  <div style="padding:14px 24px;background:#f8fafc;">
    <p style="margin:0;color:#94a3b8;font-size:11px;text-align:center;">このメールは自動生成されています。</p>
  </div>
</div>
</body>
</html>`;
}

function stat(label, value, color) {
  return `<div style="flex:1;min-width:80px;padding:10px 6px;text-align:center;border-right:1px solid #dbeafe;">
    <div style="font-size:18px;font-weight:bold;color:${color};">${value}</div>
    <div style="font-size:10px;color:#64748b;">${label}</div>
  </div>`;
}

function badge(label, bg, color) {
  return `<span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:bold;background:${bg};color:${color};">${label}</span>`;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Send Mail ────────────────────────────────────────────────────────────────

async function sendMail(html, subject, toEmail) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: `"コミネコ 顧客管理" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject,
    html,
  });
  console.log(`Email sent to ${toEmail}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateLabel = `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日`;

  const config = loadConfig();
  config_placeholder = config.loanDeadlineAlertDays;

  const toEmail = process.env.LAND_REPORT_TO_EMAIL || config.emailTo;
  if (!toEmail) throw new Error('送信先メールアドレスが設定されていません');
  if (!config.spreadsheetId || config.spreadsheetId === 'YOUR_SPREADSHEET_ID') {
    throw new Error('スプレッドシートIDが設定されていません（configs/projects/land-customers.yml）');
  }

  console.log(`Date: ${dateLabel} / To: ${toEmail}`);

  console.log('Fetching spreadsheet...');
  const customers = await fetchSheetData(config);
  console.log(`Customers: ${customers.length}`);
  if (customers.length === 0) { console.log('No data. Skipping.'); return; }

  const cat = categorize(customers, config);
  console.log(`Uncontacted: ${cat.uncontacted.length}, InProgress: ${cat.inProgress.length}, Contracted: ${cat.contracted.length}, LoanAlert: ${cat.loanAlert.length}`);

  console.log('Analyzing with Claude...');
  const analysis = await analyzeWithClaude(customers, cat, dateLabel);

  const html    = buildEmail(customers, cat, analysis, dateLabel);
  const subject = `${config.subjectPrefix} ${dateLabel}（未フォロー${cat.uncontacted.length}名 / ローン期日警告${cat.loanAlert.length}件）`;

  console.log('Sending email...');
  await sendMail(html, subject, toEmail);
  console.log('Done!');
}

main().catch(err => { console.error(err); process.exit(1); });
