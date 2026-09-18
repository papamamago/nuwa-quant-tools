#!/usr/bin/env node
/**
 * whale_tracker.js — 庄家操盘/护盘痕迹识别（2026-09-17）
 * 
 * 来源: 老板提问"如何通过K线找到庄家操盘护盘的痕迹，拿到短暂的利润"
 * 方法: 用ZEC爆仓案例反推, 提取可量化的K线特征
 * 
 * 4大特征:
 *  ① 长下影+拉回（护盘最典型）
 *  ② 逆势独立（大盘跌它不跌）
 *  ③ 缩量上涨（控盘）
 *  ④ 暴量拉升（逼空）
 * 
 * 输出: 每个币的"控盘系数"(0-100) + 识别到的特征
 */

const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CFG = {
  proxy: 'http://127.0.0.1:2080',
  logFile: path.join(__dirname, 'data', 'whale_tracker.log'),
  outFile: path.join(__dirname, 'data', 'whale_signals.json'),
  // 阈值
  dnShadowMin: 0.40,      // 下影占比>40% = 护盘
  volDryMax: 0.6,         // 量比<0.6 = 缩量
  volBurstMin: 4.0,       // 量比>4 = 暴量
  burstChgMin: 0.04,      // 单根涨>4%
};

function log(m) {
  const l = `[${new Date().toISOString()}] ${m}`;
  try { fs.appendFileSync(CFG.logFile, l + '\n'); } catch {}
  console.log(l);
}

async function analyze(ex, sym, btcBars) {
  const o = await ex.fetchOHLCV(sym + '/USDT', '1h', undefined, 72);
  const n = o.length;
  if (n < 50) return null;

  const c = o.map(x => x[4]);
  const vAvg = o.slice(-24).reduce((a, x) => a + x[5], 0) / 24;

  let score = 0;
  const signals = [];

  // === 特征1: 长下影+拉回（护盘）===
  let shadowCount = 0;
  for (let i = n - 8; i < n; i++) {
    const [ts, op, hi, lo, cl, v] = o[i];
    const rng = hi - lo;
    if (rng <= 0) continue;
    const dnShadow = (Math.min(op, cl) - lo) / rng;
    const closePos = (cl - lo) / rng;
    if (dnShadow > CFG.dnShadowMin && closePos > 0.5) {
      shadowCount++;
      signals.push({ type: '长下影护盘', time: new Date(ts).toISOString(), dnShadow: (dnShadow * 100).toFixed(0) + '%' });
    }
  }
  if (shadowCount >= 2) score += 25;

  // === 特征2: 逆势独立（大盘跌它不跌）===
  let divCount = 0;
  if (btcBars) {
    const btcC = btcBars.map(x => x[4]);
    const btcRet = (btcC[btcC.length - 1] - btcC[btcC.length - 13]) / btcC[btcC.length - 13];
    const myRet = (c[n - 1] - c[n - 13]) / c[n - 13];
    if (btcRet < -0.01 && myRet > 0) { divCount = 1; score += 20; signals.push({ type: '逆势独立', btc: (btcRet * 100).toFixed(1) + '%', coin: (myRet * 100).toFixed(1) + '%' }); }
  }

  // === 特征3: 缩量上涨（控盘）===
  let dryCount = 0;
  for (let i = n - 12; i < n; i++) {
    const [ts, op, hi, lo, cl, v] = o[i];
    const vr = v / vAvg;
    if (cl > op && vr < CFG.volDryMax) dryCount++;
  }
  if (dryCount >= 3) { score += 20; signals.push({ type: '缩量上涨', count: dryCount }); }

  // === 特征4: 暴量拉升（逼空）===
  for (let i = n - 6; i < n; i++) {
    const [ts, op, hi, lo, cl, v] = o[i];
    const vr = v / vAvg;
    const chg = (cl - op) / op;
    if (vr > CFG.volBurstMin && chg > CFG.burstChgMin) {
      score += 35;
      signals.push({ type: '暴量拉升(逼空)', time: new Date(ts).toISOString(), vr: vr.toFixed(1), chg: (chg * 100).toFixed(1) + '%' });
      break;
    }
  }

  // === 附加: 距高点涨幅（是否在拉盘）===
  const hi24 = Math.max(...o.slice(-24).map(x => x[2]));
  const lo24 = Math.min(...o.slice(-24).map(x => x[3]));
  const posInRange = (c[n - 1] - lo24) / (hi24 - lo24);
  if (posInRange > 0.8) { score += 10; signals.push({ type: '区间高位', pos: (posInRange * 100).toFixed(0) + '%' }); }

  return {
    symbol: sym,
    price: c[n - 1],
    score: Math.min(score, 100),
    signals,
    posInRange: (posInRange * 100).toFixed(0) + '%',
    volRatio: (o[n - 1][5] / vAvg).toFixed(2),
  };
}

async function main() {
  const ex = new ccxt.binanceusdm({ enableRateLimit: true, httpProxy: CFG.proxy, options: { defaultType: 'future' }, timeout: 25000 });

  // 基准: BTC
  let btcBars = null;
  try { btcBars = await ex.fetchOHLCV('BTC/USDT', '1h', undefined, 72); } catch (e) {}

  const syms = ['BTC','ETH','SOL','ZEC','XRP','BNB','DOGE','ADA','AVAX','LINK','DOT','LTC','BCH','TRX','ATOM','UNI','APT','ARB','OP','SUI','NEAR','FIL','INJ','TIA','SEI','PEPE','WIF','ORDI','HBAR','AAVE'];
  const results = [];

  for (const s of syms) {
    try {
      const r = await analyze(ex, s, btcBars);
      if (r && r.score > 0) results.push(r);
    } catch (e) {}
  }

  results.sort((a, b) => b.score - a.score);

  console.log('\n=== 控盘系数排名（庄家痕迹）===');
  console.log('币种    控盘分  现价       量比   区间位置  识别特征');
  for (const r of results.slice(0, 12)) {
    const feats = r.signals.map(s => s.type).join('/');
    console.log(r.symbol.padEnd(7), String(r.score).padStart(4), String(r.price.toFixed(r.price > 100 ? 1 : 4)).padStart(10), String(r.volRatio).padStart(6), String(r.posInRange).padStart(8), feats.slice(0, 40));
  }

  fs.writeFileSync(CFG.outFile, JSON.stringify({ ts: new Date().toISOString(), results }, null, 2));
  log(`扫描完成: ${results.length}币有控盘痕迹`);

  // 输出高分币的详细信号
  console.log('\n=== 高分币详情（控盘分≥40）===');
  for (const r of results.filter(x => x.score >= 40).slice(0, 5)) {
    console.log(`\n【${r.symbol}】控盘分 ${r.score}`);
    for (const s of r.signals) console.log('  -', s.type, JSON.stringify(s).slice(0, 100));
  }
}

if (require.main === module) main().catch(e => { log(`致命: ${e.message}`); process.exit(1); });
