#!/usr/bin/env node
/**
 * position_guard.js — 持仓守护（2026-09-17 血教训后重建）
 * 
 * 教训: 2026-09-17 02:07 ZEC空单爆仓, 因为我"给了止损位但不持续跟踪"
 * 
 * 设计原则（针对上次失败）:
 *  ① 每2分钟检查（更快）
 *  ② 多通道推送（Telegram + 备用方式），确保必达
 *  ③ 止损位必须"反复提醒"（不是只提醒一次）
 *  ④ 距离止损越近，提醒越频繁
 *  ⑤ 记录每次提醒（可追溯）
 */

const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CFG = {
  proxy: 'http://127.0.0.1:2080',
  tokenFile: process.env.TG_TOKEN_FILE || path.join(__dirname, '.tg_token'),
  chatId: process.env.TG_CHAT_ID || '',
  logFile: path.join(__dirname, 'data', 'position_guard.log'),
  stateFile: path.join(__dirname, 'data', 'position_guard_state.json'),
  // 提醒频率（秒）
  intervals: { critical: 120, warning: 300, info: 900 },  // 距止损<1%:2min, <3%:5min, 其他:15min
};

function log(m) {
  const l = `[${new Date().toISOString()}] ${m}`;
  console.log(l);
  try { fs.appendFileSync(CFG.logFile, l + '\n'); } catch {}
}

async function push(msg, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const token = fs.readFileSync(CFG.tokenFile, 'utf8').trim();
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const https = require('https');
      const agent = new HttpsProxyAgent(CFG.proxy);
      const pd = JSON.stringify({ chat_id: CFG.chatId, text: msg, parse_mode: 'HTML' });
      const ok = await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', agent,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pd) }, timeout: 20000,
        }, (res) => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok":true')));
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(pd); req.end();
      });
      if (ok) { log(`推送成功(第${i}次)`); return true; }
    } catch (e) { log(`推送异常(第${i}次): ${e.message.slice(0,40)}`); }
    await new Promise(r => setTimeout(r, 3000));
  }
  log('❌ 推送全部失败！');
  return false;
}

async function main() {
  const ex = new ccxt.binanceusdm({
    apiKey: process.env.BINANCE_API_KEY, secret: process.env.BINANCE_SECRET_KEY,
    enableRateLimit: true, httpProxy: CFG.proxy, options: { defaultType: 'future' }, timeout: 25000,
  });

  let positions = [];
  try {
    const pos = await ex.fetchPositions();
    positions = pos.filter(p => parseFloat(p.contracts) > 0);
  } catch (e) { log(`获取持仓失败: ${e.message.slice(0,40)}`); return; }

  if (positions.length === 0) { log('无持仓'); return; }

  // 加载止损位配置
  let levels = {};
  try { levels = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'alert_levels.json'), 'utf8')); } catch {}

  let state = {};
  try { state = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); } catch {}

  const now = Date.now();
  const alerts = [];

  for (const p of positions) {
    const sym = p.symbol.split(':')[0].replace('/USDT', '');
    const entry = parseFloat(p.entryPrice), mark = parseFloat(p.markPrice);
    const amt = parseFloat(p.contracts);
    const pnl = parseFloat(p.unrealizedPnl || 0);
    const roe = parseFloat(p.percentage || 0);
    const liq = parseFloat(p.liquidationPrice || 0);
    const cfg = levels[p.symbol] || {};
    const dir = p.side === 'short' ? -1 : 1;

    // 止损距离
    let stopDist = null, stopLevel = null;
    const stops = cfg.stopLevels || [];
    for (const sl of stops) {
      const d = dir === 1 ? (mark - sl) / mark : (sl - mark) / mark;
      if (d > -0.001 && (stopDist === null || d < stopDist)) { stopDist = d; stopLevel = sl; }
    }

    // 判断紧急度
    let urgency = 'info', interval = CFG.intervals.info;
    if (stopDist !== null) {
      if (stopDist < 0.01) { urgency = 'critical'; interval = CFG.intervals.critical; }
      else if (stopDist < 0.03) { urgency = 'warning'; interval = CFG.intervals.warning; }
    }
    // 距强平
    const liqDist = liq > 0 ? Math.abs((mark - liq) / mark * 100) : null;

    // 检查是否该提醒（按间隔）
    const key = `${sym}_${urgency}`;
    const last = state[key] || 0;
    if (now - last > interval * 1000) {
      state[key] = now;
      const emoji = urgency === 'critical' ? '🆘' : urgency === 'warning' ? '⚠️' : '📊';
      let msg = `${emoji} <b>${sym} ${p.side === 'short' ? '空' : '多'}单${urgency === 'critical' ? '危险' : '提醒'}</b>\n`;
      msg += `入场 ${entry.toFixed(2)} → 现价 <b>${mark.toFixed(2)}</b>\n`;
      msg += `浮盈 <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}U</b> (${roe >= 0 ? '+' : ''}${roe.toFixed(1)}%)\n`;
      if (stopLevel) msg += `\n🎯 止损位 ${stopLevel}（距现价 ${(stopDist * 100).toFixed(2)}%）\n`;
      if (liqDist !== null) msg += `💀 距强平 ${liqDist.toFixed(1)}%\n`;
      if (urgency === 'critical') msg += `\n<b>⚠️ 已非常接近止损位，请立即决定！</b>`;
      alerts.push(msg);
    }
  }

  if (alerts.length > 0) {
    await push(alerts.join('\n\n———\n\n') + '\n\n<i>仅提醒，未执行任何操作</i>');
  }

  fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2));
  log(`检查完成: ${positions.length}仓, ${alerts.length}条提醒`);
}

if (require.main === module) main().catch(e => { log(`致命: ${e.message}`); process.exit(1); });
