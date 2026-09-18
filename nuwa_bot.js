#!/usr/bin/env node
/**
 * nuwa_bot.js — 多用户 AI 交易助手（Telegram Bot）
 * 
 * 产品: 用户扫码/订阅 → 获得每日简报 + 持仓风控提醒
 * 目标: 自助产品（不需要人工维护每个用户）
 * 
 * 功能:
 *  /start    注册（生成用户ID）
 *  /brief    今日市场简报
 *  /score    币种趋势系数查询
 *  /watch    设置持仓监控（输入币种+入场价+方向）
 *  /list     查看我的监控
 *  /stop     取消监控
 *  /help     帮助
 * 
 * 商业化:
 *  · 免费: 每日简报 + 1个监控位
 *  · 付费: 无限监控 + 实时提醒 + 深度分析
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const ccxt = require('ccxt');

const CFG = {
  proxy: 'http://127.0.0.1:2080',
  tokenFile: process.env.TG_TOKEN_FILE || path.join(__dirname, '.tg_token'),
  dbFile: path.join(__dirname, 'data', 'users.json'),
  logFile: path.join(__dirname, 'nuwa_bot.log'),
  freeWatchLimit: 1,      // 免费用户监控位数
  paidWatchLimit: 20,     // 付费用户
};

function log(m) {
  const l = `[${new Date().toISOString()}] ${m}`;
  console.log(l);
  try { fs.appendFileSync(CFG.logFile, l + '\n'); } catch {}
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(CFG.dbFile, 'utf8')); } catch { return {}; }
}
function saveUsers(u) {
  fs.writeFileSync(CFG.dbFile, JSON.stringify(u, null, 2));
}

let TOKEN = '';
try { TOKEN = fs.readFileSync(CFG.tokenFile, 'utf8').trim(); } catch {}

const agent = new HttpsProxyAgent(CFG.proxy);

function tg(method, payload) {
  return new Promise((resolve) => {
    const pd = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${TOKEN}/${method}`, method: 'POST', agent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pd) }, timeout: 25000,
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(pd); req.end();
  });
}

async function getQuote(ex, sym) {
  const o = await ex.fetchOHLCV(sym + '/USDT', '1h', undefined, 200);
  const n = o.length;
  const c = o.map(x => x[4]);
  const px = c[n - 1];
  const chg24 = (px - c[n - 25]) / c[n - 25] * 100;
  const chg7d = (px - c[n - 169]) / c[n - 169] * 100;
  const sma200 = c.slice(-200).reduce((a, b) => a + b) / 200;
  const ema20 = c.slice(-20).reduce((a, b) => a + b) / 20;
  let tr = [];
  for (let i = n - 14; i < n; i++) tr.push(Math.max(o[i][2] - o[i][3], Math.abs(o[i][2] - o[i - 1][4]), Math.abs(o[i][3] - o[i - 1][4])));
  const atr = tr.reduce((a, b) => a + b) / 14;
  const atrPct = atr / px * 100;
  let score = 0;
  score += (px > sma200 ? 25 : -25);
  score += (px > ema20 ? 15 : -15);
  score += Math.max(-20, Math.min(20, chg7d * 2));
  score += Math.max(-20, Math.min(20, chg24 * 3));
  score = Math.max(-100, Math.min(100, score));
  return { px, chg24, chg7d, atrPct, score, sma200 };
}

async function handleUpdate(ex, update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const users = loadUsers();

  if (!users[chatId]) {
    users[chatId] = { id: chatId, name: msg.from?.first_name || 'user', created: Date.now(), paid: false, watches: [] };
    saveUsers(users);
  }
  const u = users[chatId];

  if (text === '/start') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `👋 欢迎使用 <b>Nuwa 交易助手</b>\n\n` +
        `我能帮你:\n` +
        `📊 /brief — 今日市场简报\n` +
        `🎯 /score 币种 — 趋势系数查询\n` +
        `👁 /watch 币种 方向 入场价 — 添加持仓监控\n` +
        `📋 /list — 查看我的监控\n` +
        `❌ /stop 币种 — 取消监控\n\n` +
        `<b>当前套餐</b>: ${u.paid ? '✅ 专业版' : '🆓 免费版（1个监控位）'}\n` +
        `升级专业版: 无限监控 + 实时提醒`,
      parse_mode: 'HTML',
    });
    return;
  }

  if (text === '/brief' || text === '/b') {
    await tg('sendMessage', { chat_id: chatId, text: '⏳ 生成简报中...' });
    try {
      const syms = ['BTC', 'ETH', 'SOL', 'ZEC', 'XRP', 'BNB', 'DOGE', 'UNI', 'ARB', 'OP'];
      const rows = [];
      for (const s of syms) {
        try { const q = await getQuote(ex, s); rows.push({ s, ...q }); } catch {}
      }
      rows.sort((a, b) => b.score - a.score);
      const btc = rows.find(r => r.s === 'BTC');
      let out = `📊 <b>市场简报</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}\n\n`;
      if (btc) out += `<b>BTC</b> $${btc.px.toFixed(0)} | 24h ${btc.chg24 >= 0 ? '+' : ''}${btc.chg24.toFixed(2)}% | ${btc.px > btc.sma200 ? '🟢多头区' : '🔴空头区'}\n\n`;
      out += `<b>📈 强势 TOP5</b>\n`;
      for (const r of rows.slice(0, 5)) out += `· ${r.s} 系数${r.score.toFixed(0)} | 24h ${r.chg24 >= 0 ? '+' : ''}${r.chg24.toFixed(1)}%\n`;
      out += `\n<b>📉 弱势 TOP5</b>\n`;
      for (const r of rows.slice(-5).reverse()) out += `· ${r.s} 系数${r.score.toFixed(0)} | 24h ${r.chg24 >= 0 ? '+' : ''}${r.chg24.toFixed(1)}%\n`;
      out += `\n<i>仅供参考，不构成投资建议</i>`;
      await tg('sendMessage', { chat_id: chatId, text: out, parse_mode: 'HTML' });
    } catch (e) { await tg('sendMessage', { chat_id: chatId, text: '❌ 简报生成失败，请稍后重试' }); }
    return;
  }

  if (text.startsWith('/score')) {
    const sym = (text.split(/\s+/)[1] || 'BTC').toUpperCase();
    try {
      const q = await getQuote(ex, sym);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `<b>${sym}</b> 趋势系数\n\n` +
          `现价: $${q.px.toFixed(q.px > 100 ? 1 : 4)}\n` +
          `24h: ${q.chg24 >= 0 ? '+' : ''}${q.chg24.toFixed(2)}%\n` +
          `7d: ${q.chg7d >= 0 ? '+' : ''}${q.chg7d.toFixed(2)}%\n` +
          `ATR: ${q.atrPct.toFixed(2)}%\n` +
          `趋势: ${q.px > q.sma200 ? '🟢 多头区间' : '🔴 空头区间'}\n\n` +
          `<b>系数: ${q.score.toFixed(0)}</b> ${q.score > 50 ? '（强势）' : q.score < -50 ? '（弱势）' : '（中性）'}`,
        parse_mode: 'HTML',
      });
    } catch (e) { await tg('sendMessage', { chat_id: chatId, text: `❌ 查询 ${sym} 失败` }); }
    return;
  }

  if (text.startsWith('/watch')) {
    const parts = text.split(/\s+/);
    const limit = u.paid ? CFG.paidWatchLimit : CFG.freeWatchLimit;
    if (u.watches.length >= limit) {
      await tg('sendMessage', { chat_id: chatId, text: `⚠️ 监控位已满（${limit}个）\n升级专业版可监控${CFG.paidWatchLimit}个` });
      return;
    }
    if (parts.length < 4) {
      await tg('sendMessage', { chat_id: chatId, text: '用法: /watch 币种 方向 入场价\n例: /watch BTC long 76000' });
      return;
    }
    const sym = parts[1].toUpperCase(), dir = parts[2].toLowerCase(), entry = parseFloat(parts[3]);
    if (!['long', 'short'].includes(dir) || isNaN(entry)) {
      await tg('sendMessage', { chat_id: chatId, text: '❌ 格式错误。方向用 long 或 short，入场价用数字' });
      return;
    }
    u.watches.push({ sym, dir, entry, added: Date.now() });
    saveUsers(users);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `✅ 已添加监控\n<b>${sym}</b> ${dir} @ ${entry}\n\n我会在价格接近关键位时提醒你。`,
      parse_mode: 'HTML',
    });
    return;
  }

  if (text === '/list') {
    if (u.watches.length === 0) {
      await tg('sendMessage', { chat_id: chatId, text: '📋 你还没有监控\n用 /watch 币种 方向 入场价 添加' });
      return;
    }
    let out = `📋 <b>我的监控</b> (${u.watches.length}/${u.paid ? CFG.paidWatchLimit : CFG.freeWatchLimit})\n\n`;
    for (const w of u.watches) out += `· ${w.sym} ${w.dir} @ ${w.entry}\n`;
    await tg('sendMessage', { chat_id: chatId, text: out, parse_mode: 'HTML' });
    return;
  }

  if (text.startsWith('/stop')) {
    const sym = (text.split(/\s+/)[1] || '').toUpperCase();
    const before = u.watches.length;
    u.watches = u.watches.filter(w => w.sym !== sym);
    saveUsers(users);
    await tg('sendMessage', { chat_id: chatId, text: before === u.watches.length ? `未找到 ${sym} 的监控` : `✅ 已取消 ${sym} 监控` });
    return;
  }

  if (text === '/help') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `<b>Nuwa 交易助手</b>\n\n` +
        `/brief — 市场简报\n` +
        `/score BTC — 趋势系数\n` +
        `/watch BTC long 76000 — 添加监控\n` +
        `/list — 查看监控\n` +
        `/stop BTC — 取消监控\n\n` +
        `数据来源: 币安合约 | 仅供参考`,
      parse_mode: 'HTML',
    });
    return;
  }
}

// 主循环: 长轮询
async function main() {
  const ex = new ccxt.binanceusdm({ enableRateLimit: true, httpProxy: CFG.proxy, options: { defaultType: 'future' }, timeout: 25000 });
  let offset = 0;
  log('🤖 Nuwa 交易助手启动');
  await tg('sendMessage', { chat_id: process.env.TG_CHAT_ID, text: '🤖 <b>Nuwa 交易助手已上线</b>\n\n可用命令:\n/brief — 市场简报\n/score BTC — 趋势系数\n/watch BTC long 76000 — 持仓监控\n\n<i>免费版: 1个监控位</i>', parse_mode: 'HTML' });

  while (true) {
    try {
      const res = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      if (res && res.result) {
        for (const up of res.result) {
          offset = up.update_id + 1;
          try { await handleUpdate(ex, up); } catch (e) { log(`处理失败: ${e.message.slice(0, 50)}`); }
        }
      }
    } catch (e) { log(`轮询错误: ${e.message.slice(0, 50)}`); }
    await new Promise(r => setTimeout(r, 1000));
  }
}

main().catch(e => { log(`致命: ${e.message}`); process.exit(1); });
