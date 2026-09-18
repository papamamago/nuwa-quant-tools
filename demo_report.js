#!/usr/bin/env node
/**
 * demo_report.js — 免费市场简报生成器（Demo + 引流工具）
 * 
 * 用途: 
 *  ① 展示我们的数据能力（让潜在客户看到价值）
 *  ② 作为引流工具（免费发到社群）
 *  ③ 服务产品化的第一步
 * 
 * 输出: 一份专业的市场简报（HTML/Markdown），含:
 *  · 市场状态（趋势/震荡）
 *  · 8维数据摘要
 *  · 风险预警（爆仓数据/异常波动）
 *  · 强势弱势币排名
 */

const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PROXY = 'http://127.0.0.1:2080';

function api(url) {
  return new Promise((res) => {
    const req = https.get(url, { agent: new HttpsProxyAgent(PROXY), timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch { res(null); } });
    });
    req.on('error', () => res(null));
    req.setTimeout(18000, () => { req.destroy(); res(null); });
  });
}

async function main() {
  const ex = new ccxt.binanceusdm({ enableRateLimit: true, httpProxy: PROXY, options: { defaultType: 'future' }, timeout: 25000 });
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  console.log(`生成简报 ${now}...`);

  const syms = ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','LINK','ZEC','LTC','TRX','DOT','BCH','ATOM','UNI','APT','ARB','OP','SUI'];
  const rows = [];

  for (const s of syms) {
    try {
      const o = await ex.fetchOHLCV(s + '/USDT', '1h', undefined, 200);
      const n = o.length;
      if (n < 200) continue;
      const c = o.map(x => x[4]);
      const px = c[n - 1];
      const chg24 = (px - c[n - 25]) / c[n - 25] * 100;
      const chg7d = (px - c[n - 169]) / c[n - 169] * 100;

      // SMA200 / EMA20
      const sma200 = c.slice(-200).reduce((a, b) => a + b) / 200;
      const ema20 = c.slice(-20).reduce((a, b) => a + b) / 20;

      // ATR
      let tr = [];
      for (let i = n - 14; i < n; i++) tr.push(Math.max(o[i][2] - o[i][3], Math.abs(o[i][2] - o[i-1][4]), Math.abs(o[i][3] - o[i-1][4])));
      const atr = tr.reduce((a, b) => a + b) / 14;
      const atrPct = atr / px * 100;

      // 量比
      const vAvg = o.slice(-24).reduce((a, x) => a + x[5], 0) / 24;
      const vr = o[n - 1][5] / vAvg;

      // 趋势系数（简化版）
      let score = 0;
      score += (px > sma200 ? 25 : -25);          // 长期趋势
      score += (px > ema20 ? 15 : -15);           // 短期趋势
      score += Math.max(-20, Math.min(20, chg7d * 2)); // 7日动量
      score += Math.max(-20, Math.min(20, chg24 * 3)); // 24h动量
      score = Math.max(-100, Math.min(100, score));

      // 区间位置
      const hi = Math.max(...o.slice(-72).map(x => x[2]));
      const lo = Math.min(...o.slice(-72).map(x => x[3]));
      const pos = (px - lo) / (hi - lo) * 100;

      rows.push({ s, px, chg24, chg7d, atrPct, vr, score, pos, sma200 });
    } catch (e) {}
  }

  // 排序
  const strong = [...rows].sort((a, b) => b.score - a.score);
  const weak = [...rows].sort((a, b) => a.score - b.score);

  // 生成报告
  let md = `# 📊 市场简报 ${now}\n\n`;
  md += `> 数据来源: 币安合约 | 20币 | 1h周期 | 自动生成\n\n`;

  md += `## 一、市场概览\n\n`;
  const btc = rows.find(r => r.s === 'BTC');
  if (btc) {
    md += `- **BTC**: $${btc.px.toFixed(0)} | 24h ${btc.chg24 >= 0 ? '+' : ''}${btc.chg24.toFixed(2)}% | 7d ${btc.chg7d >= 0 ? '+' : ''}${btc.chg7d.toFixed(2)}%\n`;
    md += `- **市场状态**: ${btc.px > btc.sma200 ? '🟢 多头区间（价 > SMA200）' : '🔴 空头区间（价 < SMA200）'}\n`;
    md += `- **波动率**: BTC ATR ${btc.atrPct.toFixed(2)}%\n`;
  }
  md += `\n`;

  md += `## 二、强势币 TOP5（趋势系数）\n\n`;
  md += `| 币种 | 现价 | 24h | 7d | 趋势系数 | 区间位置 |\n`;
  md += `|------|------|-----|-----|---------|----------|\n`;
  for (const r of strong.slice(0, 5)) {
    md += `| ${r.s} | ${r.px > 100 ? r.px.toFixed(1) : r.px.toFixed(4)} | ${r.chg24 >= 0 ? '+' : ''}${r.chg24.toFixed(1)}% | ${r.chg7d >= 0 ? '+' : ''}${r.chg7d.toFixed(1)}% | **${r.score.toFixed(0)}** | ${r.pos.toFixed(0)}% |\n`;
  }
  md += `\n`;

  md += `## 三、弱势币 TOP5（谨慎/回避）\n\n`;
  md += `| 币种 | 现价 | 24h | 7d | 趋势系数 | 区间位置 |\n`;
  md += `|------|------|-----|-----|---------|----------|\n`;
  for (const r of weak.slice(0, 5)) {
    md += `| ${r.s} | ${r.px > 100 ? r.px.toFixed(1) : r.px.toFixed(4)} | ${r.chg24 >= 0 ? '+' : ''}${r.chg24.toFixed(1)}% | ${r.chg7d >= 0 ? '+' : ''}${r.chg7d.toFixed(1)}% | **${r.score.toFixed(0)}** | ${r.pos.toFixed(0)}% |\n`;
  }
  md += `\n`;

  md += `## 四、风险提示\n\n`;
  const highVol = rows.filter(r => r.atrPct > 3).sort((a, b) => b.atrPct - a.atrPct);
  if (highVol.length > 0) {
    md += `⚠️ **高波动币**（ATR > 3%，注意风险）:\n`;
    for (const r of highVol.slice(0, 3)) md += `- ${r.s}: ATR ${r.atrPct.toFixed(2)}%\n`;
  }
  const lowLiq = rows.filter(r => r.vr < 0.5);
  if (lowLiq.length > 0) {
    md += `\n📉 **缩量币**（量比 < 0.5，流动性差）: ${lowLiq.map(r => r.s).join(', ')}\n`;
  }
  md += `\n`;

  md += `---\n\n`;
  md += `*本报告由 Nuwa Quant 自动生成 | 仅供参考，不构成投资建议*\n`;

  const outFile = path.join(__dirname, '..', '..', 'data', `daily_report_${new Date().toISOString().slice(0,10)}.md`);
  fs.writeFileSync(outFile, md);
  console.log('✅ 简报已生成:', outFile);
  console.log('');
  console.log(md.slice(0, 1500));
}

main().catch(e => { console.error('错误:', e.message); process.exit(1); });
