/**
 * InvestySignals — Backtest Engine v1.0
 * Standalone Node.js module. No browser dependencies.
 * Usage: require('./backtest-engine') → exports { runBacktest }
 *
 * Place this file in the project root alongside server.js
 * Add routes from backtest-routes.js to server.js
 */

'use strict';

const https = require('https');

const FAPI = 'https://fapi.binance.com';
const RSI_PERIOD = 14;

/* ══════════════════════════════════════════════════
   HELPERS — FETCH
══════════════════════════════════════════════════ */

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/**
 * Fetch all 1H klines for a symbol over the given date range.
 * Binance limit = 1000 per request → paginate automatically.
 */
async function fetchKlines(symbol, interval, startMs, endMs) {
  const all = [];
  let from = startMs;
  while (from < endMs) {
    const url = `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`;
    const batch = await httpsGet(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    const lastOpen = parseInt(batch[batch.length - 1][0]);
    if (batch.length < 1000) break;
    from = lastOpen + 1;
  }
  return all;
}

/* ══════════════════════════════════════════════════
   INDICATOR FUNCTIONS (ported from analysis.html)
══════════════════════════════════════════════════ */

function calcEMA(c, p) {
  if (!c || c.length < p) return null;
  const k = 2 / (p + 1);
  let e = c.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < c.length; i++) e = c[i] * k + e * (1 - k);
  return e;
}

function calcEMAStack(c) {
  const e20 = calcEMA(c, 20), e50 = calcEMA(c, 50);
  const e200 = c.length >= 200 ? calcEMA(c, 200) : null;
  const price = c[c.length - 1];
  let stack = 'neutral';
  if (e20 && e50) {
    if (e20 > e50 && price > e20) stack = (e200 && e50 > e200) ? 'perfect_bull' : 'bull';
    else if (e20 < e50 && price < e20) stack = (e200 && e50 < e200) ? 'perfect_bear' : 'bear';
  }
  return { ema20: e20, ema50: e50, ema200: e200, stack };
}

function calcRSI(c, p) {
  if (!c || c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
}

function calcMACD(c, f, s, sig) {
  f = f || 12; s = s || 26; sig = sig || 9;
  if (!c || c.length < s + sig) return null;
  const k1 = 2 / (f + 1), k2 = 2 / (s + 1), k3 = 2 / (sig + 1);
  // EMA arrays
  let ef = c.slice(0, f).reduce((a, b) => a + b, 0) / f;
  let es = c.slice(0, s).reduce((a, b) => a + b, 0) / s;
  const macdLine = [];
  for (let i = Math.max(f, s); i < c.length; i++) {
    // advance ef to i
    const startF = i - (s - f); // ef was init at f, es at s
    ef = c[startF] * k1 + ef * (1 - k1); // simplified: recalc
  }
  // Proper recalc
  let efa = c.slice(0, f).reduce((a, b) => a + b, 0) / f;
  let esa = c.slice(0, s).reduce((a, b) => a + b, 0) / s;
  const efs = [efa], ess = [esa];
  for (let i = f; i < c.length; i++) { efa = c[i] * k1 + efa * (1 - k1); efs.push(efa); }
  for (let i = s; i < c.length; i++) { esa = c[i] * k2 + esa * (1 - k2); ess.push(esa); }
  const off = s - f;
  const ml = efs.slice(off).map((v, i) => v - ess[i]);
  let sa = ml.slice(0, sig).reduce((a, b) => a + b, 0) / sig;
  const sas = [sa];
  for (let i = sig; i < ml.length; i++) { sa = ml[i] * k3 + sa * (1 - k3); sas.push(sa); }
  const lm = ml[ml.length - 1], ls = sas[sas.length - 1];
  const h = lm - ls, ph = ml[ml.length - 2] - sas[sas.length - 2];
  return { macd: lm, signal: ls, histogram: h, prevHistogram: ph, trend: lm > ls ? 'bullish' : 'bearish', strengthening: Math.abs(h) > Math.abs(ph) };
}

function calcBollingerBands(c, p, m) {
  p = p || 20; m = m || 2;
  if (!c || c.length < p) return null;
  const sl = c.slice(-p), mean = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((s, v) => s + (v - mean) ** 2, 0) / p);
  const upper = mean + m * std, lower = mean - m * std;
  const width = (upper - lower) / mean;
  const pos = (c[c.length - 1] - lower) / (upper - lower);
  return { upper, middle: mean, lower, width, position: Math.max(0, Math.min(1, pos)), squeeze: width < 0.04 };
}

function calcATR(H, L, C, p) {
  p = p || 14;
  if (!H || H.length < p + 1) return null;
  const tr = [];
  for (let i = 1; i < H.length; i++) tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  let a = tr.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
  const lastC = C[C.length - 1];
  if (!isFinite(a) || a < lastC * 0.0015) a = lastC * 0.0015;
  return { atr: a, pct: (a / lastC) * 100 };
}

function calcADX(H, L, C, p) {
  p = p || 14;
  if (!H || H.length < p * 2) return null;
  const pm = [], mm = [], tr = [];
  for (let i = 1; i < H.length; i++) {
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    pm.push(up > dn && up > 0 ? up : 0);
    mm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  }
  const ws = (a, n) => { let s = a.slice(0, n).reduce((x, y) => x + y, 0); const r = [s]; for (let i = n; i < a.length; i++) { s = s - s / n + a[i]; r.push(s); } return r; };
  const sT = ws(tr, p), sP = ws(pm, p), sM = ws(mm, p);
  const di = sT.map((t, i) => ({ plus: t > 0 ? (sP[i] / t) * 100 : 0, minus: t > 0 ? (sM[i] / t) * 100 : 0 }));
  const dx = di.map(d => { const s = d.plus + d.minus; return s > 0 ? (Math.abs(d.plus - d.minus) / s) * 100 : 0; });
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  const last = di[di.length - 1];
  return { adx, plusDI: last.plus, minusDI: last.minus, trend: adx > 25 ? (last.plus > last.minus ? 'bullish' : 'bearish') : 'ranging', strength: adx > 50 ? 'strong' : adx > 25 ? 'moderate' : 'weak' };
}

function calcOBV(C, V) {
  if (!C || C.length < 10) return null;
  let o = 0; const a = [0];
  for (let i = 1; i < C.length; i++) { if (C[i] > C[i - 1]) o += V[i]; else if (C[i] < C[i - 1]) o -= V[i]; a.push(o); }
  const l5 = a.slice(-5).reduce((x, y) => x + y, 0) / 5, p5 = a.slice(-10, -5).reduce((x, y) => x + y, 0) / 5;
  return { obv: o, trend: l5 > p5 ? 'accumulation' : 'distribution', rising: l5 > p5 };
}

function calcSupertrend(H, L, C, p, m) {
  p = p || 10; m = m || 3;
  if (!H || H.length < p + 10) return null;
  const tr = [H[0] - L[0]];
  for (let i = 1; i < H.length; i++) tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  const aa = []; let av = tr.slice(0, p).reduce((a, b) => a + b, 0) / p; aa.push(av);
  for (let i = p; i < tr.length; i++) { av = (av * (p - 1) + tr[i]) / p; aa.push(av); }
  const off = H.length - aa.length; let pU = 0, pL = 0, dir = 1;
  for (let i = 0; i < aa.length; i++) {
    const idx = i + off, hl = (H[idx] + L[idx]) / 2;
    let u = hl + m * aa[i], l = hl - m * aa[i];
    if (i > 0) { u = (u < pU || C[idx - 1] > pU) ? u : pU; l = (l > pL || C[idx - 1] < pL) ? l : pL; }
    if (C[idx] > u) dir = 1; else if (C[idx] < l) dir = -1;
    pU = u; pL = l;
  }
  const last = H.length - 1, val = dir === 1 ? pL : pU;
  return { direction: dir, bullish: dir === 1, value: val, label: dir === 1 ? '▲ Bullish' : '▼ Bearish' };
}

function detectBOS(H, L, C, lb) {
  lb = lb || 20;
  if (!H || H.length < lb * 2) return { bullBOS: false, bearBOS: false, choch: false };
  const rH = H.slice(-lb), rL = L.slice(-lb), rC = C.slice(-lb);
  const recentHigh = Math.max(...rH.slice(0, -1)), recentLow = Math.min(...rL.slice(0, -1));
  const curC = rC[rC.length - 1];
  const bullBOS = curC > recentHigh;
  const bearBOS = curC < recentLow;
  const prevHigh = Math.max(...H.slice(-lb * 2, -lb));
  const prevLow  = Math.min(...L.slice(-lb * 2, -lb));
  const choch = (bullBOS && prevLow < recentLow) || (bearBOS && prevHigh > recentHigh);
  return { bullBOS, bearBOS, choch };
}

function calcVWAP(kl) {
  if (!kl || kl.length === 0) return null;
  let tpvSum = 0, volSum = 0;
  for (const k of kl) {
    const h = parseFloat(k[2]), l = parseFloat(k[3]), c = parseFloat(k[4]), v = parseFloat(k[5]);
    const tp = (h + l + c) / 3;
    tpvSum += tp * v; volSum += v;
  }
  if (volSum === 0) return null;
  const vwap = tpvSum / volSum;
  const lastC = parseFloat(kl[kl.length - 1][4]);
  return { vwap, above: lastC > vwap, pct: ((lastC - vwap) / vwap) * 100 };
}

function calcMTFRSI(C, C4, C15, C1D) {
  const r15 = C15 ? calcRSI(C15, 14) : null;
  const r1  = C   ? calcRSI(C,   14) : null;
  const r4  = C4  ? calcRSI(C4,  14) : null;
  const r1d = C1D ? calcRSI(C1D, 14) : null;
  const all = [r15, r1, r4, r1d].filter(v => v != null);
  const bullCount = all.filter(v => v < 45).length;
  const bearCount = all.filter(v => v > 55).length;
  return {
    rsi1H: r1, rsi4H: r4, rsi1D: r1d,
    bullishAlign: r1 < 40 && r4 < 40, bearishAlign: r1 > 60 && r4 > 60,
    extremeBullish: r1 < 30 && r4 < 30, extremeBearish: r1 > 70 && r4 > 70,
    fullBullAlign: bullCount >= 3, fullBearAlign: bearCount >= 3,
    bullCount, bearCount
  };
}

function calc4HTrend(kl) {
  if (!kl || kl.length < 30) return { bias: 'neutral', label: '↔ Neutral', score: 0 };
  const C  = kl.map(k => parseFloat(k[4])), H = kl.map(k => parseFloat(k[2])), L = kl.map(k => parseFloat(k[3]));
  const e20 = calcEMA(C, 20), e50 = calcEMA(C, Math.min(50, C.length - 1));
  const r4 = calcRSI(C, 14), price = C[C.length - 1];
  let sc = 0;
  if (e20 && e50) { if (e20 > e50) sc += 2; else sc -= 2; }
  if (e20) { if (price > e20) sc += 1; else sc -= 1; }
  if (r4 !== null) { if (r4 > 55) sc += 1; else if (r4 < 45) sc -= 1; }
  const r10H = H.slice(-10), r10L = L.slice(-10);
  if (r10H.slice(1).filter((v, i) => v > r10H[i]).length >= 6) sc += 1;
  if (r10L.slice(1).filter((v, i) => v > r10L[i]).length >= 6) sc += 1;
  if (r10H.slice(1).filter((v, i) => v > r10H[i]).length <= 3) sc -= 1;
  if (r10L.slice(1).filter((v, i) => v > r10L[i]).length <= 3) sc -= 1;
  const bias = sc >= 2 ? 'bull' : sc <= -2 ? 'bear' : 'neutral';
  return { bias, label: bias === 'bull' ? '▲ Bullish' : bias === 'bear' ? '▼ Bearish' : '↔ Neutral', score: sc, ema20_4h: e20, ema50_4h: e50, rsi4h: r4 };
}

function detectDivergence(C, H, L, V, rp, lb) {
  rp = rp || 14; lb = lb || 30;
  if (!C || C.length < lb) return {};
  const rArr = [];
  for (let i = rp; i < C.length; i++) rArr.push(calcRSI(C.slice(0, i + 1), rp));
  const rS = rArr.slice(-lb), cS = C.slice(-lb), hS = H.slice(-lb), lS = L.slice(-lb);
  const n = cS.length;
  const pL = cS.indexOf(Math.min(...cS)), pLH = rS.indexOf(Math.min(...rS));
  const pH = cS.indexOf(Math.max(...cS)), pHH = rS.indexOf(Math.max(...rS));
  const regularBull = cS[n-1] < cS[pL] && rS[n-1] > rS[pLH];
  const regularBear = cS[n-1] > cS[pH] && rS[n-1] < rS[pHH];
  const hiddenBull = cS[n-1] > cS[pL] && rS[n-1] < rS[pLH];
  const hiddenBear = cS[n-1] < cS[pH] && rS[n-1] > rS[pHH];
  let obvV = 0, oBull = false, oBear = false;
  if (V && V.length >= lb) {
    const vS = V.slice(-lb);
    const oa = [0];
    for (let i = 1; i < cS.length; i++) { if (cS[i] > cS[i-1]) obvV += vS[i]; else if (cS[i] < cS[i-1]) obvV -= vS[i]; oa.push(obvV); }
    oBull = cS[n-1] < cS[0] && oa[n-1] > oa[0];
    oBear = cS[n-1] > cS[0] && oa[n-1] < oa[0];
  }
  return { regularBull, regularBear, hiddenBull, hiddenBear, obvBull: oBull, obvBear: oBear };
}

function analyzeVolume(kl) {
  const v = kl.map(k => parseFloat(k[5]));
  const avg = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const last = v.slice(-4, -1).reduce((a, b) => a + b, 0) / 3;
  const ratio = avg > 0 ? last / avg : 1;
  return { avg20: avg, last3: last, ratio, surge: ratio >= 1.5, label: ratio >= 2 ? 'Very High' : ratio >= 1.5 ? 'High' : ratio >= 1 ? 'Normal' : 'Low' };
}

/* ══════════════════════════════════════════════════
   SIMPLIFIED SIGNAL DECISION (core 9 factors)
   No live API calls (OI, taker, orderbook skipped)
══════════════════════════════════════════════════ */

function decideSignal(C, H, L, V, O, kl1h, kl4h, kl1d) {
  const price = C[C.length - 1];
  const rsi   = calcRSI(C, RSI_PERIOD);
  const macd  = calcMACD(C);
  const bb    = calcBollingerBands(C);
  const atr   = calcATR(H, L, C);
  const adx   = calcADX(H, L, C);
  const obv   = calcOBV(C, V);
  const es    = calcEMAStack(C);
  const spt   = calcSupertrend(H, L, C);
  const bos   = detectBOS(H, L, C);
  const div   = detectDivergence(C, H, L, V);
  const vol   = analyzeVolume(kl1h);
  const vwap  = calcVWAP(kl1h);

  const C4  = kl4h.map(k => parseFloat(k[4]));
  const H4  = kl4h.map(k => parseFloat(k[2]));
  const L4  = kl4h.map(k => parseFloat(k[3]));
  const C1D = kl1d.map(k => parseFloat(k[4]));

  const t4    = calc4HTrend(kl4h);
  const mRSI  = calcMTFRSI(C, C4, null, C1D);
  const ema1d = calcEMAStack(C1D);
  const ema4h = calcEMAStack(C4);
  const bos4h = detectBOS(H4, L4, C4, 35);
  const rsi4h = calcRSI(C4, RSI_PERIOD);
  const rsi1d = calcRSI(C1D, RSI_PERIOD);

  if (!rsi || !atr || !adx) return null;

  // ADX gate
  const adxGate = 20;
  if (adx.adx < adxGate) return null;

  let ls = 0, ss = 0;

  // F1: RSI
  if (rsi <= 22)      ls += 22;
  else if (rsi <= 30) ls += 17;
  else if (rsi <= 40) ls += 9;
  else if (rsi <= 48) { ls += 3; ss += 3; }
  else if (rsi >= 78) ss += 22;
  else if (rsi >= 70) ss += 17;
  else if (rsi >= 60) ss += 9;

  // F2: EMA Stack
  if (es.stack === 'perfect_bull')      { ls += 15; ss = Math.max(ss - 8, 0); }
  else if (es.stack === 'bull')           ls += 10;
  else if (es.stack === 'perfect_bear') { ss += 15; ls = Math.max(ls - 8, 0); }
  else if (es.stack === 'bear')           ss += 10;

  // F3: MACD
  if (macd) {
    if (macd.trend === 'bullish' && macd.strengthening) ls += 10;
    else if (macd.trend === 'bullish') ls += 6;
    if (macd.trend === 'bearish' && macd.strengthening) ss += 10;
    else if (macd.trend === 'bearish') ss += 6;
  }

  // F4: Bollinger Bands
  if (bb) {
    if (bb.position <= 0.08) ls += 10;
    else if (bb.position <= 0.2) ls += 7;
    else if (bb.position <= 0.35) ls += 4;
    if (bb.position >= 0.92) ss += 10;
    else if (bb.position >= 0.8) ss += 7;
    else if (bb.position >= 0.65) ss += 4;
    if (bb.squeeze) { if (price > bb.middle) ss += 4; else ls += 4; }
  }

  // F6: ADX
  if (adx.strength === 'strong') {
    if (adx.trend === 'bullish') ls += 9;
    else if (adx.trend === 'bearish') ss += 9;
  } else if (adx.strength === 'moderate') {
    if (adx.trend === 'bullish') ls += 5;
    else if (adx.trend === 'bearish') ss += 5;
  }

  // F7: OBV
  if (obv) {
    if (obv.trend === 'accumulation') ls += 8;
    else if (obv.trend === 'distribution') ss += 8;
  }

  // F8: Volume
  if (vol.surge) { ls += 7; ss += 7; }
  else if (vol.ratio >= 0.8) { ls += 2; ss += 2; }

  // F9: 4H Trend — highest weight
  if (t4) {
    if (t4.bias === 'bull') { ls += 22; ss = Math.max(ss - 22, 0); }
    else if (t4.bias === 'bear') { ss += 22; ls = Math.max(ls - 22, 0); }
  }

  // F12: Divergence
  if (div) {
    if (div.regularBull) ls += 16; if (div.regularBear) ss += 16;
    if (div.hiddenBull)  ls += 11; if (div.hiddenBear)  ss += 11;
    if (div.obvBull)     ls += 8;  if (div.obvBear)     ss += 8;
  }

  // F13: VWAP
  if (vwap) {
    if (vwap.above && vwap.pct > 1.5)        { ls += 13; ss = Math.max(ss - 6, 0); }
    else if (vwap.above)                      { ls += 8;  ss = Math.max(ss - 3, 0); }
    else if (!vwap.above && vwap.pct < -1.5)  { ss += 13; ls = Math.max(ls - 6, 0); }
    else                                      { ss += 8;  ls = Math.max(ls - 3, 0); }
  }

  // F14: Supertrend
  if (spt) { if (spt.bullish) ls += 13; else ss += 13; }

  // F15: BOS
  if (bos) {
    if (bos.bullBOS) ls += 11;
    if (bos.bearBOS) ss += 11;
    if (bos.choch) {
      if (bos.bullBOS) ls += 7;
      else if (bos.bearBOS) ss += 7;
    }
  }

  // N1: MTF RSI
  if (mRSI) {
    if (mRSI.extremeBullish) ls += 7; else if (mRSI.bullishAlign) ls += 4;
    if (mRSI.extremeBearish) ss += 7; else if (mRSI.bearishAlign) ss += 4;
    if (mRSI.fullBullAlign) ls += 9;
    if (mRSI.fullBearAlign) ss += 9;
  }

  // N3: 1D EMA
  if (ema1d) {
    if (ema1d.stack?.includes('bull')) { ls += 13; ss = Math.max(ss - 6, 0); }
    else if (ema1d.stack?.includes('bear')) { ss += 13; ls = Math.max(ls - 6, 0); }
  }

  // N5: 4H BOS
  if (bos4h) {
    if (bos4h.bullBOS) ls += 9;
    if (bos4h.bearBOS) ss += 9;
    if (bos4h.choch) {
      if (bos4h.bullBOS) ls += 5;
      else if (bos4h.bearBOS) ss += 5;
    }
  }

  const MAX = 260;
  const lc = Math.min(100, Math.round(ls / MAX * 100));
  const sc = Math.min(100, Math.round(ss / MAX * 100));
  const MIN_GAP = 12;

  let dir, conf;
  if (lc > sc && (lc - sc) >= MIN_GAP)      { dir = 'LONG';  conf = lc; }
  else if (sc > lc && (sc - lc) >= MIN_GAP) { dir = 'SHORT'; conf = sc; }
  else return null; // ambiguous

  if (conf < 50) return null; // min confidence gate

  const aV = atr.atr;
  const slM = atr.pct > 3.5 ? 2.0 : atr.pct > 2.0 ? 2.2 : 2.5;

  let ep, sl, tp1, tp2;
  if (dir === 'LONG') {
    ep  = price;
    sl  = Math.min(...L.slice(-10)) - aV * 0.2;
    sl  = Math.max(sl, ep - aV * slM);
    const risk = ep - sl;
    tp1 = ep + risk * 1.5;
    tp2 = ep + risk * 2.5;
  } else {
    ep  = price;
    sl  = Math.max(...H.slice(-10)) + aV * 0.2;
    sl  = Math.min(sl, ep + aV * slM);
    const risk = sl - ep;
    tp1 = ep - risk * 1.5;
    tp2 = ep - risk * 2.5;
  }

  const risk = dir === 'LONG' ? ep - sl : sl - ep;
  const rrr1 = risk > 0 ? (Math.abs(tp1 - ep) / risk).toFixed(2) : '0';
  const rrr2 = risk > 0 ? (Math.abs(tp2 - ep) / risk).toFixed(2) : '0';

  return { dir, conf, ep, sl, tp1, tp2, rrr1, rrr2, rsi, adx: adx.adx, trend4h: t4.bias };
}

/* ══════════════════════════════════════════════════
   FORWARD OUTCOME CHECKER
   Given signal generated at candle[i], walk forward
   through subsequent candles to find TP1/TP2/SL hit.
══════════════════════════════════════════════════ */

function checkOutcome(dir, ep, sl, tp1, tp2, futureKlines) {
  let tp1Hit = false, tp2Hit = false, slHit = false;
  let closePrice = null, closeCandle = null;
  let tp1HitCandle = null;

  for (let i = 0; i < futureKlines.length; i++) {
    const kl = futureKlines[i];
    const h = parseFloat(kl[2]), l = parseFloat(kl[3]), c = parseFloat(kl[4]);

    if (dir === 'LONG') {
      if (!tp1Hit && h >= tp1) { tp1Hit = true; tp1HitCandle = i; }
      if (tp1Hit && h >= tp2) { tp2Hit = true; closePrice = tp2; closeCandle = i; break; }
      if (l <= sl) {
        slHit = true;
        closePrice = tp1Hit ? ep : sl; // BE if TP1 was hit (SL moved to BE)
        closeCandle = i;
        break;
      }
    } else {
      if (!tp1Hit && l <= tp1) { tp1Hit = true; tp1HitCandle = i; }
      if (tp1Hit && l <= tp2) { tp2Hit = true; closePrice = tp2; closeCandle = i; break; }
      if (h >= sl) {
        slHit = true;
        closePrice = tp1Hit ? ep : sl;
        closeCandle = i;
        break;
      }
    }
  }

  // Still open after all future candles
  if (!slHit && !tp2Hit) {
    const last = futureKlines[futureKlines.length - 1];
    closePrice = parseFloat(last[4]);
    closeCandle = futureKlines.length - 1;
  }

  let outcome;
  if (tp2Hit)       outcome = 'TP2';
  else if (slHit)   outcome = tp1Hit ? 'BE' : 'SL';
  else if (tp1Hit)  outcome = 'TP1';
  else              outcome = 'OPEN';

  const risk = dir === 'LONG' ? ep - sl : sl - ep;
  let pnlR = 0;
  if (risk > 0 && closePrice !== null) {
    const rawPnl = dir === 'LONG' ? (closePrice - ep) / risk : (ep - closePrice) / risk;
    pnlR = parseFloat(rawPnl.toFixed(3));
  }

  return { outcome, tp1Hit, tp2Hit, slHit, closePrice, closeCandle, pnlPct: pnlR * 100, tp1HitCandle };
}

/* ══════════════════════════════════════════════════
   SLICE HELPERS — get matching 4H / 1D klines
   up to a given 1H candle open time
══════════════════════════════════════════════════ */

function klinesUpTo(klines, tsMs) {
  // return all klines whose open time <= tsMs
  const idx = klines.findIndex(k => parseInt(k[0]) > tsMs);
  if (idx === -1) return klines;
  return klines.slice(0, idx);
}

/* ══════════════════════════════════════════════════
   MAIN BACKTEST RUNNER
══════════════════════════════════════════════════ */

/**
 * @param {string}   symbol      e.g. 'BTCUSDT'
 * @param {number}   startMs     Unix ms start
 * @param {number}   endMs       Unix ms end
 * @param {Function} [onProgress] optional callback(pct, msg)
 * @returns {Promise<Object>}    results object
 */
async function runBacktest(symbol, startMs, endMs, onProgress) {
  const progress = onProgress || (() => {});

  progress(5, `Fetching 1H klines for ${symbol}…`);
  const kl1h = await fetchKlines(symbol, '1h', startMs, endMs);
  if (!kl1h.length) throw new Error(`No 1H data for ${symbol}`);

  progress(20, `Fetching 4H klines…`);
  const kl4h = await fetchKlines(symbol, '4h', startMs - 86400000 * 30, endMs); // extra 30d warmup

  progress(30, `Fetching 1D klines…`);
  const kl1d = await fetchKlines(symbol, '1d', startMs - 86400000 * 60, endMs); // extra 60d warmup

  progress(40, `Running analysis on ${kl1h.length} candles…`);

  const signals = [];
  const WARMUP = 200; // need enough candles for EMA200 etc.
  const MIN_FUTURE = 24; // at least 24 candles ahead to check outcome (1 day)
  const SCAN_STEP = 4; // scan every 4 candles to avoid signal spam (every 4H)

  let lastSignalCandle = -99; // prevent consecutive signals
  const MIN_SIGNAL_GAP = 12; // min 12 candles (~12H) between signals for same symbol

  for (let i = WARMUP; i < kl1h.length - MIN_FUTURE; i += SCAN_STEP) {
    // Prevent signal spam
    if (i - lastSignalCandle < MIN_SIGNAL_GAP) continue;

    const ts = parseInt(kl1h[i][0]);

    // Slice data up to current candle
    const slice1h = kl1h.slice(0, i + 1).slice(-250); // last 250 candles
    const slice4h = klinesUpTo(kl4h, ts).slice(-100);
    const slice1d = klinesUpTo(kl1d, ts).slice(-60);

    if (slice4h.length < 30 || slice1d.length < 10) continue;

    const C = slice1h.map(k => parseFloat(k[4]));
    const H = slice1h.map(k => parseFloat(k[2]));
    const L = slice1h.map(k => parseFloat(k[3]));
    const V = slice1h.map(k => parseFloat(k[5]));
    const O = slice1h.map(k => parseFloat(k[1]));

    const sig = decideSignal(C, H, L, V, O, slice1h, slice4h, slice1d);
    if (!sig) continue;

    // Check outcome using next 168 candles (7 days)
    const futureKlines = kl1h.slice(i + 1, i + 1 + 168);
    const result = checkOutcome(sig.dir, sig.ep, sig.sl, sig.tp1, sig.tp2, futureKlines);

    const openDate = new Date(ts).toISOString().split('T')[0];
    let closeDate = null;
    if (result.closeCandle !== null) {
      const closeTs = parseInt(kl1h[Math.min(i + 1 + result.closeCandle, kl1h.length - 1)][0]);
      closeDate = new Date(closeTs).toISOString().split('T')[0];
    }

    signals.push({
      symbol,
      openTime: ts,
      openDate,
      closeDate,
      direction: sig.dir,
      confidence: sig.conf,
      entryPrice: parseFloat(sig.ep.toFixed(6)),
      tp1: parseFloat(sig.tp1.toFixed(6)),
      tp2: parseFloat(sig.tp2.toFixed(6)),
      sl: parseFloat(sig.sl.toFixed(6)),
      rrr1: parseFloat(sig.rrr1),
      rrr2: parseFloat(sig.rrr2),
      rsi: parseFloat((sig.rsi || 0).toFixed(2)),
      adx: parseFloat((sig.adx || 0).toFixed(2)),
      trend4h: sig.trend4h,
      outcome: result.outcome,
      tp1Hit: result.tp1Hit,
      tp2Hit: result.tp2Hit,
      slHit: result.slHit,
      closePrice: result.closePrice ? parseFloat(result.closePrice.toFixed(6)) : null,
      pnlPct: parseFloat(result.pnlPct.toFixed(2)),
    });

    lastSignalCandle = i;

    if (i % 50 === 0) {
      const pct = 40 + Math.round(((i - WARMUP) / (kl1h.length - WARMUP - MIN_FUTURE)) * 50);
      progress(Math.min(pct, 88), `Analysed ${i}/${kl1h.length} candles — ${signals.length} signals found…`);
    }
  }

  progress(90, 'Computing statistics…');

  /* ── Statistics ── */
  const total = signals.length;
  const wins   = signals.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  const losses = signals.filter(s => s.outcome === 'SL').length;
  const be     = signals.filter(s => s.outcome === 'BE').length;
  const open   = signals.filter(s => s.outcome === 'OPEN').length;
  const tp2s   = signals.filter(s => s.outcome === 'TP2').length;
  const winRate = total > 0 ? ((wins / (total - open)) * 100) : 0;

  const totalPnlR = signals.reduce((s, x) => {
    if (x.outcome === 'TP2') return s + parseFloat(x.rrr2);
    if (x.outcome === 'TP1') return s + parseFloat(x.rrr1);
    if (x.outcome === 'SL')  return s - 1;
    return s; // BE / OPEN = 0
  }, 0);

  const avgConf  = total > 0 ? (signals.reduce((s, x) => s + x.confidence, 0) / total).toFixed(1) : 0;
  const avgRrr1  = total > 0 ? (signals.reduce((s, x) => s + x.rrr1, 0) / total).toFixed(2) : 0;

  const longSigs  = signals.filter(s => s.direction === 'LONG');
  const shortSigs = signals.filter(s => s.direction === 'SHORT');
  const longWins  = longSigs.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  const shortWins = shortSigs.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2').length;

  // Monthly breakdown
  const monthly = {};
  for (const s of signals) {
    const mo = s.openDate.slice(0, 7);
    if (!monthly[mo]) monthly[mo] = { month: mo, signals: 0, wins: 0, losses: 0, be: 0, pnlR: 0 };
    monthly[mo].signals++;
    if (s.outcome === 'TP1' || s.outcome === 'TP2') { monthly[mo].wins++; monthly[mo].pnlR += s.outcome === 'TP2' ? s.rrr2 : s.rrr1; }
    else if (s.outcome === 'SL') { monthly[mo].losses++; monthly[mo].pnlR -= 1; }
    else if (s.outcome === 'BE') monthly[mo].be++;
  }

  progress(100, 'Done!');

  return {
    symbol,
    period: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    candlesAnalysed: kl1h.length,
    stats: {
      total, wins, losses, be, open, tp2s,
      winRate: parseFloat(winRate.toFixed(1)),
      totalPnlR: parseFloat(totalPnlR.toFixed(2)),
      avgConf: parseFloat(avgConf),
      avgRrr1: parseFloat(avgRrr1),
      longSignals: longSigs.length,
      shortSignals: shortSigs.length,
      longWinRate: longSigs.length > 0 ? parseFloat(((longWins / longSigs.length) * 100).toFixed(1)) : 0,
      shortWinRate: shortSigs.length > 0 ? parseFloat(((shortWins / shortSigs.length) * 100).toFixed(1)) : 0,
    },
    monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)),
    signals,
  };
}

module.exports = { runBacktest };
