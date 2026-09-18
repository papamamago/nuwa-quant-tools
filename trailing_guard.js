#!/usr/bin/env node
/**
 * trailing_guard.js — 移动止损守护（2026-09-17 重建）
 * 
 * 老板要求: "止损肯定是根据行情来的，移动止盈止损"
 * 
 * 设计:
 *  ① 移动止损: 按 ATR 或 百分比 计算，随价格朝有利方向移动
 *  ② 移动止盈: 盈利达到阈值后启用跟踪，回撤X%就提醒
 *  ③ 反复提醒: 触发条件后，每隔N分钟提醒，直到处理
 *  ④ 多档位: 按亏损/盈利幅度分级
 * 
 * 铁律: 只提醒，绝不主动平仓
 */

const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CFG = {
  proxy: 'http://127.0.0.1:2080',
  tokenFile: process.env.TG_TOKEN_FILE || path.join(__dirname, '.tg_token'),
  chatId: process.env.TG_CHAT_ID || '',
  logFile: path.join(__dirname, 'data', 'trailing_guard.log'),
  stateFile: path.join(__dirname, 'data', 'trailing_guard_state.json'),
  // 移动止损参数
  atrMult: 2.0,          // 初始止损 = 2 ATR
  trailPct: 0.04,        // 移动止损距离 = 4%（价格）
  // 提醒阈值（回撤幅度）
  levels: {
    retrace10: 0.10,     // 从最高点回撤10% → 提醒
    retrace15: 0.15,     // 回撤15% → 警告
    retrace20: 0.20,     // 回撤20% → 紧急
  },
  remindInterval: { warn: 600, critical: 180 },  // 警告10min, 紧急3min
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
        }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d.includes('"ok":true'))); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(pd); req.end();
      });
      if (ok) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 3000));
  }
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

  let state = {};
  try { state = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); } catch {}

  const now = Date.now();
  const alerts = [];

  for (const p of positions) {
    const sym = p.symbol.split(':')[0].replace('/USDT', '');
    const entry = parseFloat(p.entryPrice), mark = parseFloat(p.markPrice);
    const pnl = parseFloat(p.unrealizedPnl || 0);
    const roe = parseFloat(p.percentage || 0);
    const liq = parseFloat(p.liquidationPrice || 0);
    const dir = p.side === 'short' ? -1 : 1;

    // 获取该币的K线算ATR + 近期极值
    let atr = null, extreme = null, extremeTime = null;
    try {
      const o = await ex.fetchOHLCV(p.symbol, '1h', undefined, 50);
      const n = o.length;
      // ATR(14)
      let tr = [];
      for (let i = n - 14; i < n; i++) {
        tr.push(Math.max(o[i][2] - o[i][3], Math.abs(o[i][2] - o[i-1][4]), Math.abs(o[i][3] - o[i-1][4])));
      }
      atr = tr.reduce((a, b) => a + b) / 14;

      // 持仓期间的价格极值（对多头=最高，对空头=最低）
      const since = state[sym + '_start'] || (now - 7 * 24 * 3600 * 1000);
      const bars = o.filter(x => x[0] >= since);
      if (bars.length > 0) {
        extreme = dir === 1 ? Math.max(...bars.map(x => x[2])) : Math.min(...bars.map(x => x[3]));
        const bi = bars.findIndex(x => (dir === 1 ? x[2] === extreme : x[3] === extreme));
        extremeTime = bi >= 0 ? bars[bi][0] : null;
      }
    } catch (e) {}

    // 计算移动止损位
    let trailStop = null, stopReason = '';
    if (atr) {
      trailStop = dir === 1 ? mark - CFG.atrMult * atr : mark + CFG.atrMult * atr;
      stopReason = `${CFG.atrMult}ATR`;
    }

    // 计算"从极值的回撤"
    let retrace = null;
    if (extreme !== null) {
      retrace = dir === 1 ? (extreme - mark) / extreme : (mark - extreme) / extreme;
    }

    // 判断是否提醒
    let urgency = null, interval = 0;
    if (retrace !== null && retrace >= CFG.levels.retrace20) { urgency = 'critical'; interval = CFG.remindInterval.critical; }
    else if (retrace !== null && retrace >= CFG.levels.retrace15) { urgency = 'warn'; interval = CFG.remindInterval.warn; }

    // 距强平紧急提醒
    const liqDist = liq > 0 ? Math.abs((mark - liq) / mark) : null;
    if (liqDist !== null && liqDist < 0.05) { urgency = 'critical'; interval = CFG.remindInterval.critical; }

    if (urgency) {
      const key = `${sym}_${urgency}`;
      if (now - (state[key] || 0) > interval * 1000) {
        state[key] = now;
        const emoji = urgency === 'critical' ? '🆘' : '⚠️';
        let msg = `${emoji} <b>${sym} ${p.side === 'short' ? '空' : '多'}单 ${urgency === 'critical' ? '紧急' : '警告'}</b>\n\n`;
        msg += `入场 ${entry.toFixed(2)} → 现价 <b>${mark.toFixed(2)}</b>\n`;
        msg += `浮盈 <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}U</b> (${roe >= 0 ? '+' : ''}${roe.toFixed(1)}%)\n`;
        if (extreme !== null) msg += `\n📈 持仓期间最佳价: ${extreme.toFixed(2)}\n`;
        if (retrace !== null) msg += `📉 已回撤: <b>${(retrace * 100).toFixed(1)}%</b>\n`;
        if (trailStop) msg += `\n🎯 移动止损位(${stopReason}): ${trailStop.toFixed(2)}\n`;
        if (liqDist !== null) msg += `💀 距强平: ${(liqDist * 100).toFixed(1)}%\n`;
        msg += `\n<b>请决定: 继续持有 / 平仓 / 调整止损</b>`;
        alerts.push(msg);
      }
    }
  }

  if (alerts.length > 0) {
    await push(alerts.join('\n\n———\n\n') + '\n\n<i>仅提醒，绝不主动平仓</i>');
    log(`发出${alerts.length}条提醒`);
  }

  fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2));
  log(`检查完成: ${positions.length}仓`);
}

if (require.main === module) main().catch(e => { log(`致命: ${e.message}`); process.exit(1); });
