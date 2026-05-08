/**
 * InvestySignals — Fibonacci + Utility Engine  v5
 * public/analysis/indicator.js
 *
 * FIXED:
 * - Renamed loadIndicatorSettings → loadGlobalIndicatorSettings (avoids conflict with profile.html)
 * - Merges user overrides from /api/user/settings on top of admin defaults
 * - IS() helper reads merged window.ISETTINGS
 */
'use strict';

window.ISETTINGS        = {};
window.ISETTINGS_LOADED = false;

async function loadGlobalIndicatorSettings() {
  try {
    // 1. Load admin defaults (public endpoint)
    const r = await fetch('/api/settings/indicators');
    const j = await r.json();
    if (j.success && j.data) {
      window.ISETTINGS = Object.assign({}, j.data);
      window.ISETTINGS_LOADED = true;
    }
  } catch (_) {}

  // 2. Try merging user overrides on top (requires Firebase auth)
  try {
    const auth = window._auth || (window.firebase && window.firebase.auth && window.firebase.auth());
    const user = auth && auth.currentUser;
    if (user) {
      const idToken = await user.getIdToken();
      const ur = await fetch('/api/user/settings', {
        headers: { Authorization: 'Bearer ' + idToken }
      });
      const uj = await ur.json();
      if (uj.success && uj.overrides && Object.keys(uj.overrides).length > 0) {
        // User overrides take precedence over admin defaults
        Object.assign(window.ISETTINGS, uj.overrides);
      }
    }
  } catch (_) {}
}

function IS(key, def) {
  const v = window.ISETTINGS && window.ISETTINGS[key];
  return (v != null && !isNaN(+v)) ? +v : def;
}

// Call on load — also re-call after Firebase auth ready if needed
loadGlobalIndicatorSettings();

// Backward compat alias (profile.html defines its own loadIndicatorSettings — no conflict)
window.loadGlobalIndicatorSettings = loadGlobalIndicatorSettings;

/* ─── snapToFibEntry v2 — direction-agnostic (works in ranging/counter-trend) ─── */
function snapToFibEntry(price, fibData, direction, atr) {
  if (!fibData || !fibData.levels) return null;
  const aV = atr || price * 0.015, tol = aV * 2.5;
  // Ideal: use trend-aligned levels. Fallback: any key retracement level near price
  if (direction === 'LONG') {
    // First try aligned uptrend levels
    if (fibData.trend === 'uptrend') {
      const aligned = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price <= price + tol && l.price >= price - tol * 3).sort((a,b) => b.price - a.price);
      if (aligned.length) return aligned[0].price;
    }
    // Fallback: any key fib level below price (acts as support)
    const fallback = fibData.levels.filter(l => l.key && l.price < price && l.price >= price - tol * 3).sort((a,b) => b.price - a.price);
    return fallback.length ? fallback[0].price : null;
  }
  if (direction === 'SHORT') {
    if (fibData.trend === 'downtrend') {
      const aligned = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price >= price - tol && l.price <= price + tol * 3).sort((a,b) => a.price - b.price);
      if (aligned.length) return aligned[0].price;
    }
    const fallback = fibData.levels.filter(l => l.key && l.price > price && l.price <= price + tol * 3).sort((a,b) => a.price - b.price);
    return fallback.length ? fallback[0].price : null;
  }
  return null;
}

/* ─── getFibSL v2 — uses nearest invalidation level, not just swing base ─── */
function getFibSL(ep, fibData, direction, atr) {
  if (!fibData || !fibData.levels) return null;
  const aV = atr || ep * 0.015;
  if (direction === 'LONG') {
    // Find nearest key fib BELOW entry — that's our invalidation
    const below = fibData.levels.filter(l => l.key && l.price < ep - aV * 0.1).sort((a,b) => b.price - a.price);
    if (below.length) return below[0].price - aV * 0.2; // buffer below
    // fallback: swing base
    const base = fibData.levels.find(l => l.r === 0);
    if (base && base.price < ep) return base.price - aV * 0.3;
    return null;
  } else {
    const above = fibData.levels.filter(l => l.key && l.price > ep + aV * 0.1).sort((a,b) => a.price - b.price);
    if (above.length) return above[0].price + aV * 0.2;
    const base = fibData.levels.find(l => l.r === 0);
    if (base && base.price > ep) return base.price + aV * 0.3;
    return null;
  }
}

/* ─── getFibTargets v2 — multi-level TP ladder with RR enforcement ─── */
function getFibTargets(ep, sl, fibData, direction, srZones) {
  const risk = Math.abs(ep - sl);
  if (!risk) return { tp1: ep, tp2: ep };
  let tp1 = null, tp2 = null;
  const hasFib = fibData && fibData.levels;
  // Extension levels to use as targets (0.618ext, 1.0, 1.272, 1.618)
  const extRatios = [0.618, 1.0, 1.272, 1.618, 2.0];
  if (direction === 'LONG') {
    if (hasFib) {
      // TP1: first extension above entry with RR >= 1.2
      for (const r of extRatios) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.05 && l.price > ep);
        if (lvl && (lvl.price - ep) / risk >= 1.2) { tp1 = lvl.price; break; }
      }
      // TP2: next extension after TP1 with RR >= 2.0
      if (tp1) {
        for (const r of extRatios) {
          const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.05 && l.price > tp1 + risk * 0.3);
          if (lvl && (lvl.price - ep) / risk >= 2.0) { tp2 = lvl.price; break; }
        }
      }
    }
    // Fallbacks with S/R refinement
    if (!tp1) {
      const sr1 = srZones && srZones.above && srZones.above.find(z => (z.price - ep) / risk >= 1.2 && z.strength >= 2);
      tp1 = sr1 ? sr1.price : ep + risk * 1.5;
    }
    if (!tp2) {
      const sr2 = srZones && srZones.above && srZones.above.find(z => z.price > tp1 + risk * 0.3 && (z.price - ep) / risk >= 2.0 && z.strength >= 2);
      tp2 = sr2 ? sr2.price : ep + risk * 2.8;
    }
    // Enforce min RR: TP1 >= 1.2R, TP2 >= 2.0R
    if ((tp1 - ep) / risk < 1.2) tp1 = ep + risk * 1.2;
    if ((tp2 - ep) / risk < 2.0) tp2 = ep + risk * 2.0;
  }
  if (direction === 'SHORT') {
    if (hasFib) {
      for (const r of extRatios) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.05 && l.price < ep);
        if (lvl && (ep - lvl.price) / risk >= 1.2) { tp1 = lvl.price; break; }
      }
      if (tp1) {
        for (const r of extRatios) {
          const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.05 && l.price < tp1 - risk * 0.3);
          if (lvl && (ep - lvl.price) / risk >= 2.0) { tp2 = lvl.price; break; }
        }
      }
    }
    if (!tp1) {
      const sr1 = srZones && srZones.below && srZones.below.find(z => (ep - z.price) / risk >= 1.2 && z.strength >= 2);
      tp1 = sr1 ? sr1.price : ep - risk * 1.5;
    }
    if (!tp2) {
      const sr2 = srZones && srZones.below && srZones.below.find(z => z.price < tp1 - risk * 0.3 && (ep - z.price) / risk >= 2.0 && z.strength >= 2);
      tp2 = sr2 ? sr2.price : ep - risk * 2.8;
    }
    if ((ep - tp1) / risk < 1.2) tp1 = ep - risk * 1.2;
    if ((ep - tp2) / risk < 2.0) tp2 = ep - risk * 2.0;
  }
  return { tp1, tp2 };
}

/* ─── checkMomentumConfirmation — last closed candle aligns with direction ─── */
function checkMomentumConfirmation(O, C, H, L, direction, atr) {
  if (!O || O.length < 3) return { confirmed: false, label: 'No data', strength: 0 };
  const aV = atr || Math.abs(C[C.length-1]) * 0.01;
  // Use last CLOSED candle (index -2; index -1 is still forming)
  const i  = O.length - 2;
  const o = O[i], c = C[i], h = H[i], l = L[i];
  const body = Math.abs(c - o), range = h - l;
  const isBull = c > o, isBear = c < o;
  const bodyRatio = range > 0 ? body / range : 0;
  const upWick = h - Math.max(o,c), downWick = Math.min(o,c) - l;

  // Previous candle for momentum check
  const pi = i - 1;
  const pc = C[pi], po = O[pi];
  const prevBull = pc > po, prevBear = pc < po;

  let confirmed = false, label = '', strength = 0;

  if (direction === 'LONG') {
    if (isBull && bodyRatio >= 0.5) {
      // Strong bull candle — good confirm
      strength = bodyRatio >= 0.75 ? 3 : 2;
      label = bodyRatio >= 0.75 ? 'Strong Bull Close' : 'Bull Close';
      confirmed = true;
    } else if (isBull && downWick >= body * 1.5) {
      // Hammer-type with bull body
      strength = 2; label = 'Hammer Close'; confirmed = true;
    } else if (isBull && bodyRatio < 0.35) {
      // Weak bull (doji-like) — weak confirm
      strength = 1; label = 'Weak Bull (Doji)'; confirmed = false;
    } else if (isBear) {
      // Bear candle = no confirmation for LONG
      strength = 0; label = 'Bear Candle ⚠ (no confirm)'; confirmed = false;
    }
    // 2-candle momentum: consecutive bulls = stronger
    if (confirmed && prevBull) strength = Math.min(strength + 1, 3);
  } else {
    if (isBear && bodyRatio >= 0.5) {
      strength = bodyRatio >= 0.75 ? 3 : 2;
      label = bodyRatio >= 0.75 ? 'Strong Bear Close' : 'Bear Close';
      confirmed = true;
    } else if (isBear && upWick >= body * 1.5) {
      strength = 2; label = 'Shooting Star Close'; confirmed = true;
    } else if (isBear && bodyRatio < 0.35) {
      strength = 1; label = 'Weak Bear (Doji)'; confirmed = false;
    } else if (isBull) {
      strength = 0; label = 'Bull Candle ⚠ (no confirm)'; confirmed = false;
    }
    if (confirmed && prevBear) strength = Math.min(strength + 1, 3);
  }
  return { confirmed, label, strength, isBull, isBear, bodyRatio };
}

/* ─── calcEntryInvalidation — price level that kills the setup ─── */
function calcEntryInvalidation(dir, ep, sl, fibonacci, srZones, mtfOBs, atr) {
  // The invalidation level is the structural level that if broken, the thesis is wrong.
  // For LONG: highest significant resistance that if price breaks above FROM BELOW means OB/level broken
  // Actually: invalidation = key support BELOW entry. If price drops to sl zone = invalidated.
  // We return the specific price that triggers "setup failed" + a % distance from entry.
  const risk = Math.abs(ep - sl);
  const aV   = atr ? atr.atr : risk * 0.5;

  if (dir === 'LONG') {
    // Invalidation: below SL by 0.3 ATR (buffer). Also check if OB low is closer.
    let invLevel = sl - aV * 0.2;
    if (mtfOBs && mtfOBs.nearestBullOB) {
      const obLow = mtfOBs.nearestBullOB.low;
      if (obLow < ep && obLow > invLevel) invLevel = obLow - aV * 0.1; // tighten to OB
    }
    const distPct = ep > 0 ? ((ep - invLevel) / ep * 100).toFixed(2) : '—';
    return { level: invLevel, distPct, note: `Setup fails if price closes below ${invLevel.toFixed(6)}` };
  } else {
    let invLevel = sl + aV * 0.2;
    if (mtfOBs && mtfOBs.nearestBearOB) {
      const obHigh = mtfOBs.nearestBearOB.high;
      if (obHigh > ep && obHigh < invLevel) invLevel = obHigh + aV * 0.1;
    }
    const distPct = ep > 0 ? ((invLevel - ep) / ep * 100).toFixed(2) : '—';
    return { level: invLevel, distPct, note: `Setup fails if price closes above ${invLevel.toFixed(6)}` };
  }
}

/* ─── calcLimitExpiry — max time to wait for limit fill ─── */
function calcLimitExpiry(entryType, atr, price) {
  // If limit order: estimate fill window based on ATR volatility
  // High ATR% = fills faster; Low ATR% = longer window
  if (entryType === 'MARKET') return null;
  const atrPct = atr ? atr.pct : 1.5;
  // Hours to expiry: 2H for high vol, 4H for normal, 8H for low vol
  const hours = atrPct > 3 ? 2 : atrPct > 1.5 ? 4 : 8;
  const now = Date.now();
  const expiry = new Date(now + hours * 3600 * 1000);
  return {
    hours,
    expiryTime: expiry.toUTCString(),
    note: `Cancel if not filled within ${hours}H (${expiry.toUTCString().slice(17,22)} UTC)`
  };
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
