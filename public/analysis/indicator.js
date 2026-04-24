/**
 * InvestySignals — Fibonacci + Utility Engine  v4
 * public/analysis/indicator.js
 */
'use strict';

window.ISETTINGS        = {};
window.ISETTINGS_LOADED = false;

async function loadIndicatorSettings() {
  try {
    const r = await fetch('/api/settings/indicators');
    const j = await r.json();
    if (j.success && j.data) { window.ISETTINGS = j.data; window.ISETTINGS_LOADED = true; }
  } catch (_) {}
}
function IS(key, def) { const v = window.ISETTINGS && window.ISETTINGS[key]; return (v != null && !isNaN(+v)) ? +v : def; }
loadIndicatorSettings();

/* ─── snapToFibEntry ─── */
function snapToFibEntry(price, fibData, direction, atr) {
  if (!fibData || !fibData.levels || !fibData.trend) return null;
  const aV = atr || price * 0.015, tol = aV * 2.0;
  if (direction === 'LONG' && fibData.trend === 'uptrend') {
    const c = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price <= price + tol).sort((a,b) => b.price - a.price);
    return c.length ? c[0].price : null;
  }
  if (direction === 'SHORT' && fibData.trend === 'downtrend') {
    const c = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price >= price - tol).sort((a,b) => a.price - b.price);
    return c.length ? c[0].price : null;
  }
  return null;
}

/* ─── getFibSL ─── */
function getFibSL(ep, fibData, direction, atr) {
  if (!fibData || !fibData.levels) return null;
  const aV = atr || ep * 0.015, base = fibData.levels.find(l => l.r === 0);
  if (!base) return null;
  if (direction === 'LONG') { if (base.price >= ep) return null; return base.price - aV * 0.3; }
  else { if (base.price <= ep) return null; return base.price + aV * 0.3; }
}

/* ─── getFibTargets ─── */
function getFibTargets(ep, sl, fibData, direction, srZones) {
  const risk = Math.abs(ep - sl);
  if (!risk) return { tp1: ep, tp2: ep };
  let tp1 = null, tp2 = null;
  const hasFib = fibData && fibData.levels && fibData.trend;
  if (direction === 'LONG') {
    if (hasFib && fibData.trend === 'uptrend') {
      const f100 = fibData.levels.find(l => l.r === 1), f1618 = fibData.levels.find(l => Math.abs(l.r - 1.618) < 0.01);
      if (f100 && f100.price > ep && f100.price - ep <= risk * 4) tp1 = f100.price;
      else { const m = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price > ep && (!f100 || l.price < f100.price)).sort((a,b) => a.price - b.price)[0]; if (m) tp1 = m.price; }
      if (f1618 && tp1 !== null && f1618.price > tp1) tp2 = f1618.price; else if (f1618 && f1618.price > ep) tp2 = f1618.price;
    }
    if (tp1 === null) tp1 = ep + risk * 1.5;
    if (tp2 === null) { const nr = srZones && srZones.above && srZones.above.find(z => z.price > tp1); tp2 = nr ? Math.min(nr.price, ep + risk * 2.8) : ep + risk * 2.8; }
  }
  if (direction === 'SHORT') {
    if (hasFib && fibData.trend === 'downtrend') {
      const f100 = fibData.levels.find(l => l.r === 1), f1618 = fibData.levels.find(l => Math.abs(l.r - 1.618) < 0.01);
      if (f100 && f100.price < ep && ep - f100.price <= risk * 4) tp1 = f100.price;
      else { const m = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price < ep && (!f100 || l.price > f100.price)).sort((a,b) => b.price - a.price)[0]; if (m) tp1 = m.price; }
      if (f1618 && tp1 !== null && f1618.price < tp1) tp2 = f1618.price; else if (f1618 && f1618.price < ep) tp2 = f1618.price;
    }
    if (tp1 === null) tp1 = ep - risk * 1.5;
    if (tp2 === null) { const ns = srZones && srZones.below && srZones.below.find(z => z.price < tp1); tp2 = ns ? Math.max(ns.price, ep - risk * 2.8) : ep - risk * 2.8; }
  }
  return { tp1, tp2 };
}

/* ─── detectCandlePatterns ─── */
function detectCandlePatterns(O, H, L, C) {
  if (!O || O.length < 3) return { patterns: [], bullish: false, bearish: false, bullScore: 0, bearScore: 0, latest: null };
  const patterns = [], i = O.length - 1;
  const o = O[i], h = H[i], l = L[i], c = C[i];
  const body = Math.abs(c - o), range = h - l;
  if (range < 1e-10) return { patterns: [], bullish: false, bearish: false, bullScore: 0, bearScore: 0, latest: null };
  const upWick = h - Math.max(o,c), downWick = Math.min(o,c) - l;
  const isBull = c > o, isBear = c < o;
  const po = O[i-1], ph = H[i-1], pl = L[i-1], pc = C[i-1];
  const ppo = O[i-2], ppc = C[i-2];
  const prevBody = Math.abs(pc - po), prevRange = ph - pl;
  if (downWick >= body * 2.5 && upWick <= body * 0.5)  patterns.push({ name: 'Hammer', type: 'bullish', strength: 2 });
  if (upWick >= body * 2.5 && downWick <= body * 0.5)  patterns.push({ name: 'Shooting Star', type: 'bearish', strength: 2 });
  if (isBull && pc < po && c > po && o < pc)            patterns.push({ name: 'Bullish Engulfing', type: 'bullish', strength: 3 });
  if (isBear && pc > po && c < po && o > pc)            patterns.push({ name: 'Bearish Engulfing', type: 'bearish', strength: 3 });
  if (body < range * 0.08)                              patterns.push({ name: 'Doji', type: 'neutral', strength: 1 });
  if (body > range * 0.88 && isBull && upWick < body * 0.05 && downWick < body * 0.05) patterns.push({ name: 'Bull Marubozu', type: 'bullish', strength: 2 });
  if (body > range * 0.88 && isBear && upWick < body * 0.05 && downWick < body * 0.05) patterns.push({ name: 'Bear Marubozu', type: 'bearish', strength: 2 });
  if (isBull && pc < po && o < pc && c > (po + pc) / 2 && c < po) patterns.push({ name: 'Piercing Line', type: 'bullish', strength: 2 });
  if (isBear && pc > po && o > pc && c < (po + pc) / 2 && c > po) patterns.push({ name: 'Dark Cloud', type: 'bearish', strength: 2 });
  if (i >= 2 && isBull && ppc > ppo && prevBody < prevRange * 0.3 && o < pc && c > (ppo + ppc) / 2) patterns.push({ name: 'Morning Star', type: 'bullish', strength: 3 });
  if (i >= 2 && isBear && ppc < ppo && prevBody < prevRange * 0.3 && o > pc && c < (ppo + ppc) / 2) patterns.push({ name: 'Evening Star', type: 'bearish', strength: 3 });
  if (i >= 1 && isBull && Math.abs(l - pl) / (Math.max(l, pl, 1e-10)) < 0.002) patterns.push({ name: 'Tweezer Bottom', type: 'bullish', strength: 2 });
  if (i >= 1 && isBear && Math.abs(h - ph) / (Math.max(h, ph, 1e-10)) < 0.002) patterns.push({ name: 'Tweezer Top', type: 'bearish', strength: 2 });
  const bullish = patterns.some(p => p.type === 'bullish'), bearish = patterns.some(p => p.type === 'bearish');
  const bullScore = patterns.filter(p => p.type === 'bullish').reduce((a,p) => a + p.strength, 0);
  const bearScore = patterns.filter(p => p.type === 'bearish').reduce((a,p) => a + p.strength, 0);
  const latest = patterns.filter(p => p.type !== 'neutral')[0] || patterns[0] || null;
  return { patterns, bullish, bearish, bullScore, bearScore, latest };
}

/* ─── calcPivotPoints ─── */
function calcPivotPoints(kl1d) {
  if (!kl1d || kl1d.length < 2) return null;
  const prev = kl1d[kl1d.length - 2];
  const pH = parseFloat(prev[2]), pL = parseFloat(prev[3]), pC = parseFloat(prev[4]);
  const PP = (pH + pL + pC) / 3;
  return { PP, R1: 2*PP-pL, R2: PP+(pH-pL), R3: pH+2*(PP-pL), S1: 2*PP-pH, S2: PP-(pH-pL), S3: pL-2*(pH-PP), prevHigh: pH, prevLow: pL, prevClose: pC };
}

/* ─── calcDCAPoint ─── */
function calcDCAPoint(ep, sl, direction, fibonacci, srZones, mtfOBs, atr) {
  if (!ep || !sl) return null;
  const aV = atr ? atr.atr : Math.abs(ep - sl) * 0.35;
  const minDist = aV * 0.5;
  if (direction === 'LONG') {
    const lo = sl + minDist, hi = ep - minDist;
    if (lo >= hi) return (ep + sl) / 2;
    if (srZones && srZones.below) { const z = srZones.below.find(z => z.price < hi && z.price > lo && z.strength >= 2); if (z) return z.price; }
    if (fibonacci && fibonacci.levels) { for (const r of [0.618, 0.5]) { const fl = fibonacci.levels.find(l => Math.abs(l.r - r) < 0.01); if (fl && fl.price < hi && fl.price > lo) return fl.price; } }
    if (mtfOBs && mtfOBs.bullOBs) { const ob = mtfOBs.bullOBs.find(o => o.mid < hi && o.mid > lo); if (ob) return ob.mid; }
    return ep - (ep - sl) * 0.4;
  } else {
    const lo = ep + minDist, hi = sl - minDist;
    if (lo >= hi) return (ep + sl) / 2;
    if (srZones && srZones.above) { const z = srZones.above.find(z => z.price > lo && z.price < hi && z.strength >= 2); if (z) return z.price; }
    if (fibonacci && fibonacci.levels) { for (const r of [0.618, 0.5]) { const fl = fibonacci.levels.find(l => Math.abs(l.r - r) < 0.01); if (fl && fl.price > lo && fl.price < hi) return fl.price; } }
    if (mtfOBs && mtfOBs.bearOBs) { const ob = mtfOBs.bearOBs.find(o => o.mid > lo && o.mid < hi); if (ob) return ob.mid; }
    return ep + (sl - ep) * 0.4;
  }
}
