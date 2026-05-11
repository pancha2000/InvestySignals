/**
 * InvestySignals — Indicator & Fibonacci Engine  v6
 * public/analysis/indicator.js
 *
 * UPGRADED v6:
 * - Multi-timeframe Fibonacci (15m/1H/4H/1D separate swing detection)
 * - Full extension levels (0.5, 0.618, 0.786, 1.0, 1.272, 1.414, 1.618, 2.0, 2.618)
 * - Fibonacci confluence zones (overlapping levels across TFs = institutional zones)
 * - 3-entry DCA ladder (aggressive / optimal / conservative)
 * - Market Regime Detection (Trending/Ranging/Volatile/Accumulation/Distribution)
 * - Win rate signal outcome helpers
 * - Improved SL precision (OB low/high aware)
 * - Improved TP ladder with fib extensions + S/R confluence
 */
'use strict';

window.ISETTINGS        = {};
window.ISETTINGS_LOADED = false;

async function loadGlobalIndicatorSettings() {
  try {
    const r = await fetch('/api/settings/indicators');
    const j = await r.json();
    if (j.success && j.data) {
      window.ISETTINGS = Object.assign({}, j.data);
      window.ISETTINGS_LOADED = true;
    }
  } catch (_) {}
  try {
    const auth = window._auth || (window.firebase && window.firebase.auth && window.firebase.auth());
    const user = auth && auth.currentUser;
    if (user) {
      const idToken = await user.getIdToken();
      const ur = await fetch('/api/user/settings', { headers: { Authorization: 'Bearer ' + idToken } });
      const uj = await ur.json();
      if (uj.success && uj.overrides && Object.keys(uj.overrides).length > 0) {
        Object.assign(window.ISETTINGS, uj.overrides);
      }
    }
  } catch (_) {}
}

function IS(key, def) {
  const v = window.ISETTINGS && window.ISETTINGS[key];
  return (v != null && !isNaN(+v)) ? +v : def;
}

loadGlobalIndicatorSettings();
window.loadGlobalIndicatorSettings = loadGlobalIndicatorSettings;

/* ═══════════════════════════════════════════════════════════════════
   FIBONACCI ENGINE v6 — Multi-Timeframe + Full Extension Levels
   ═══════════════════════════════════════════════════════════════════ */

const FIB_RETRACE = [
  { r: 0,     label: '0%',    key: false },
  { r: 0.236, label: '23.6%', key: false },
  { r: 0.382, label: '38.2%', key: true  },
  { r: 0.5,   label: '50%',   key: true  },
  { r: 0.618, label: '61.8%', key: true  },
  { r: 0.786, label: '78.6%', key: true  },
  { r: 1.0,   label: '100%',  key: false },
];

const FIB_EXTENSIONS = [
  { r: 1.0,   label: '100%',   key: false },
  { r: 1.272, label: '127.2%', key: false },
  { r: 1.414, label: '141.4%', key: false },
  { r: 1.618, label: '161.8%', key: true  },
  { r: 2.0,   label: '200%',   key: false },
  { r: 2.272, label: '227.2%', key: false },
  { r: 2.618, label: '261.8%', key: true  },
  { r: 3.618, label: '361.8%', key: false },
];

/**
 * findSwingPoints — detect swing high/low in a candle array
 * Returns { swingHigh, swingLow, hiIdx, loIdx } over last `lb` bars
 */
function findSwingPoints(H, L, lb) {
  lb = Math.min(lb, H.length);
  const rH = H.slice(-lb), rL = L.slice(-lb);
  let maxH = -Infinity, minL = Infinity, hiIdx = 0, loIdx = 0;
  for (let i = 0; i < rH.length; i++) {
    // Confirm swing high: higher than 2 bars each side
    if (i >= 2 && i <= rH.length - 3) {
      if (rH[i] > rH[i-1] && rH[i] > rH[i-2] && rH[i] >= rH[i+1] && rH[i] >= rH[i+2]) {
        if (rH[i] > maxH) { maxH = rH[i]; hiIdx = i; }
      }
      if (rL[i] < rL[i-1] && rL[i] < rL[i-2] && rL[i] <= rL[i+1] && rL[i] <= rL[i+2]) {
        if (rL[i] < minL) { minL = rL[i]; loIdx = i; }
      }
    }
  }
  // Fallback if no confirmed swing
  if (maxH === -Infinity) maxH = Math.max(...rH);
  if (minL === Infinity)  minL = Math.min(...rL);
  return { swingHigh: maxH, swingLow: minL, hiIdx, loIdx };
}

/**
 * buildFibLevels — compute retracement + extension prices from a swing
 * direction: 'uptrend' (fib from low to high) | 'downtrend' (fib from high to low)
 */
function buildFibLevels(swingHigh, swingLow, direction) {
  const range = swingHigh - swingLow;
  if (range <= 0) return [];
  const levels = [];

  if (direction === 'uptrend') {
    // Retracements: from top down
    FIB_RETRACE.forEach(f => {
      levels.push({ ...f, price: swingHigh - f.r * range, type: 'retrace' });
    });
    // Extensions: above swing high
    FIB_EXTENSIONS.forEach(f => {
      levels.push({ ...f, price: swingLow + f.r * range, type: 'extend' });
    });
  } else {
    // downtrend: retracements from low up
    FIB_RETRACE.forEach(f => {
      levels.push({ ...f, price: swingLow + f.r * range, type: 'retrace' });
    });
    // Extensions: below swing low
    FIB_EXTENSIONS.forEach(f => {
      levels.push({ ...f, price: swingHigh - f.r * range, type: 'extend' });
    });
  }

  return levels.sort((a, b) => a.price - b.price);
}

/**
 * calcFibonacciMTF — Multi-timeframe Fibonacci engine
 * Takes klines for multiple timeframes, returns confluence zones
 */
function calcFibonacciMTF(kl15m, kl1h, kl4h, kl1d, price, atr) {
  const aV = atr ? atr.atr : price * 0.015;

  const tfs = [
    { key: '15m', kl: kl15m, lb: 50,  weight: 1 },
    { key: '1H',  kl: kl1h,  lb: 100, weight: 2 },
    { key: '4H',  kl: kl4h,  lb: 60,  weight: 4 },
    { key: '1D',  kl: kl1d,  lb: 30,  weight: 8 },
  ];

  const allLevels = []; // flat list of all fib prices across TFs
  const tfResults = {};

  tfs.forEach(({ key, kl, lb, weight }) => {
    if (!kl || kl.length < 10) return;
    const H = kl.map(k => parseFloat(k[2]));
    const L = kl.map(k => parseFloat(k[3]));
    const C = kl.map(k => parseFloat(k[4]));
    const { swingHigh, swingLow, hiIdx, loIdx } = findSwingPoints(H, L, lb);
    const range = swingHigh - swingLow;
    if (range < aV * 0.5) return; // range too small for meaningful fib

    const direction = hiIdx > loIdx ? 'downtrend' : 'uptrend';
    const levels = buildFibLevels(swingHigh, swingLow, direction);

    tfResults[key] = { swingHigh, swingLow, direction, levels, range, weight };
    levels.forEach(l => {
      allLevels.push({ ...l, tf: key, weight });
    });
  });

  // === Confluence Zone Detection ===
  // Group nearby levels (within 0.4% of each other) = institutional zones
  const clusterPct = 0.004; // 0.4%
  const zones = [];
  const sorted = allLevels.sort((a, b) => a.price - b.price);

  sorted.forEach(lv => {
    const ex = zones.find(z => Math.abs(z.price - lv.price) / lv.price < clusterPct);
    if (ex) {
      ex.strength += lv.weight;
      ex.tfs = [...new Set([...ex.tfs, lv.tf])];
      ex.tfCount = ex.tfs.length;
      ex.labels = [...new Set([...ex.labels, lv.label])];
      ex.key = ex.key || lv.key;
      // Weighted average price
      ex.price = (ex.price * (ex.strength - lv.weight) + lv.price * lv.weight) / ex.strength;
    } else {
      zones.push({
        price: lv.price,
        label: lv.label,
        labels: [lv.label],
        type: lv.type,
        key: lv.key,
        tf: lv.tf,
        tfs: [lv.tf],
        tfCount: 1,
        strength: lv.weight,
        r: lv.r,
      });
    }
  });

  // Add distance % from current price
  zones.forEach(z => { z.distPct = ((z.price - price) / price) * 100; });

  // Find nearest levels to current price
  const nearZones  = zones.filter(z => Math.abs(z.distPct) < 10);
  const aboveZones = nearZones.filter(z => z.price > price).sort((a, b) => a.price - b.price);
  const belowZones = nearZones.filter(z => z.price < price).sort((a, b) => b.price - a.price);
  const atZone     = nearZones.find(z => Math.abs(z.distPct) < (aV / price * 100 * 0.5));

  // Primary fib (1H dominant for entry/SL/TP)
  const primary = tfResults['1H'] || tfResults['4H'] || Object.values(tfResults)[0];
  const levels  = primary ? primary.levels : [];

  // Key confluence zones (2+ TFs overlap = institutional)
  const confluenceZones = zones.filter(z => z.tfCount >= 2 && z.key).sort((a, b) => b.strength - a.strength);

  const nearest = levels.length
    ? levels.slice().sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price))[0]
    : null;

  const nearThreshold = aV / price * 100 * 0.5;
  const atFib    = nearest && Math.abs((nearest.price - price) / price * 100) < nearThreshold * 2;
  const atKeyFib = atFib && nearest.key;

  return {
    // Primary (1H) levels for backward compatibility
    levels,
    trend:     primary?.direction === 'uptrend' ? 'uptrend' : 'downtrend',
    swingHigh: primary?.swingHigh || 0,
    swingLow:  primary?.swingLow  || 0,
    nearest,
    atFib,
    atKeyFib,
    nearKey: atKeyFib ? nearest : null,
    atrThreshold: nearThreshold,
    // Multi-TF results
    tfResults,
    zones,
    aboveZones: aboveZones.slice(0, 6),
    belowZones: belowZones.slice(0, 6),
    atZone,
    confluenceZones: confluenceZones.slice(0, 5),
    allLevels,
  };
}

/* ─── snapToFibEntry v3 — MTF-aware, confluences first ─── */
function snapToFibEntry(price, fibData, direction, atr) {
  if (!fibData) return null;
  const aV  = atr || price * 0.015;
  const tol = aV * 2.5;

  // Priority 1: high-strength confluence zone near price
  if (fibData.confluenceZones && fibData.confluenceZones.length) {
    const cz = direction === 'LONG'
      ? fibData.confluenceZones.filter(z => z.price < price && z.price >= price - tol * 3).sort((a, b) => b.strength - a.strength)[0]
      : fibData.confluenceZones.filter(z => z.price > price && z.price <= price + tol * 3).sort((a, b) => b.strength - a.strength)[0];
    if (cz) return cz.price;
  }

  // Priority 2: primary levels
  if (!fibData.levels || !fibData.levels.length) return null;
  if (direction === 'LONG') {
    if (fibData.trend === 'uptrend') {
      const aligned = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price <= price + tol && l.price >= price - tol * 3).sort((a, b) => b.price - a.price);
      if (aligned.length) return aligned[0].price;
    }
    const fallback = fibData.levels.filter(l => l.key && l.price < price && l.price >= price - tol * 3).sort((a, b) => b.price - a.price);
    return fallback.length ? fallback[0].price : null;
  }
  if (direction === 'SHORT') {
    if (fibData.trend === 'downtrend') {
      const aligned = fibData.levels.filter(l => l.key && l.type === 'retrace' && l.price >= price - tol && l.price <= price + tol * 3).sort((a, b) => a.price - b.price);
      if (aligned.length) return aligned[0].price;
    }
    const fallback = fibData.levels.filter(l => l.key && l.price > price && l.price <= price + tol * 3).sort((a, b) => a.price - b.price);
    return fallback.length ? fallback[0].price : null;
  }
  return null;
}

/* ─── getFibSL v3 — OB-aware, confluence-first ─── */
function getFibSL(ep, fibData, direction, atr) {
  if (!fibData || !fibData.levels) return null;
  const aV = atr || ep * 0.015;

  // Check confluence zones first (stronger invalidation)
  if (fibData.confluenceZones && fibData.confluenceZones.length) {
    if (direction === 'LONG') {
      const cz = fibData.confluenceZones.filter(z => z.price < ep - aV * 0.1).sort((a, b) => b.price - a.price)[0];
      if (cz) return cz.price - aV * 0.15;
    } else {
      const cz = fibData.confluenceZones.filter(z => z.price > ep + aV * 0.1).sort((a, b) => a.price - b.price)[0];
      if (cz) return cz.price + aV * 0.15;
    }
  }

  if (direction === 'LONG') {
    const below = fibData.levels.filter(l => l.key && l.price < ep - aV * 0.1).sort((a, b) => b.price - a.price);
    if (below.length) return below[0].price - aV * 0.2;
    const base = fibData.levels.find(l => l.r === 0);
    if (base && base.price < ep) return base.price - aV * 0.3;
    return null;
  } else {
    const above = fibData.levels.filter(l => l.key && l.price > ep + aV * 0.1).sort((a, b) => a.price - b.price);
    if (above.length) return above[0].price + aV * 0.2;
    const base = fibData.levels.find(l => l.r === 0);
    if (base && base.price > ep) return base.price + aV * 0.3;
    return null;
  }
}

/* ─── getFibTargets v3 — full extension ladder ─── */
function getFibTargets(ep, sl, fibData, direction, srZones) {
  const risk = Math.abs(ep - sl);
  if (!risk) return { tp1: ep, tp2: ep };

  let tp1 = null, tp2 = null, tp3 = null;
  const hasFib = fibData && fibData.levels;

  // Extension ratios in order (closest first for TP1)
  const extRatios = [0.618, 1.0, 1.272, 1.414, 1.618, 2.0, 2.618];

  if (direction === 'LONG') {
    if (hasFib) {
      // TP1: first extension above entry >= 1.2R
      for (const r of extRatios) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.06 && l.price > ep);
        if (lvl && (lvl.price - ep) / risk >= 1.2) { tp1 = lvl.price; break; }
      }
      // TP2: next extension >= 2.0R
      for (const r of extRatios) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.06 && l.price > (tp1 || ep) + risk * 0.3);
        if (lvl && (lvl.price - ep) / risk >= 2.0) { tp2 = lvl.price; break; }
      }
      // TP3: highest extension >= 3.0R (runner)
      for (const r of extRatios.slice().reverse()) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.06 && l.price > (tp2 || ep) + risk * 0.5);
        if (lvl && (lvl.price - ep) / risk >= 3.0) { tp3 = lvl.price; break; }
      }
    }
    // S/R confluence refinement
    if (srZones && srZones.above) {
      if (!tp1) {
        const sr = srZones.above.find(z => (z.price - ep) / risk >= 1.2 && z.strength >= 2);
        tp1 = sr ? sr.price : ep + risk * 1.5;
      }
      if (!tp2) {
        const sr = srZones.above.find(z => z.price > (tp1 || ep) && (z.price - ep) / risk >= 2.0 && z.strength >= 2);
        tp2 = sr ? sr.price : ep + risk * 2.5;
      }
    }
    // Fallbacks
    if (!tp1) tp1 = ep + risk * 1.5;
    if (!tp2) tp2 = ep + risk * 2.5;
    if (!tp3) tp3 = ep + risk * 3.8;
    // Enforce minimums
    if ((tp1 - ep) / risk < 1.2) tp1 = ep + risk * 1.2;
    if ((tp2 - ep) / risk < 2.0) tp2 = ep + risk * 2.0;
    if ((tp3 - ep) / risk < 3.0) tp3 = ep + risk * 3.0;
  } else {
    if (hasFib) {
      for (const r of extRatios) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.06 && l.price < ep);
        if (lvl && (ep - lvl.price) / risk >= 1.2) { tp1 = lvl.price; break; }
      }
      for (const r of extRatios) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.06 && l.price < (tp1 || ep) - risk * 0.3);
        if (lvl && (ep - lvl.price) / risk >= 2.0) { tp2 = lvl.price; break; }
      }
      for (const r of extRatios.slice().reverse()) {
        const lvl = fibData.levels.find(l => Math.abs(l.r - r) < 0.06 && l.price < (tp2 || ep) - risk * 0.5);
        if (lvl && (ep - lvl.price) / risk >= 3.0) { tp3 = lvl.price; break; }
      }
    }
    if (srZones && srZones.below) {
      if (!tp1) {
        const sr = srZones.below.find(z => (ep - z.price) / risk >= 1.2 && z.strength >= 2);
        tp1 = sr ? sr.price : ep - risk * 1.5;
      }
      if (!tp2) {
        const sr = srZones.below.find(z => z.price < (tp1 || ep) && (ep - z.price) / risk >= 2.0 && z.strength >= 2);
        tp2 = sr ? sr.price : ep - risk * 2.5;
      }
    }
    if (!tp1) tp1 = ep - risk * 1.5;
    if (!tp2) tp2 = ep - risk * 2.5;
    if (!tp3) tp3 = ep - risk * 3.8;
    if ((ep - tp1) / risk < 1.2) tp1 = ep - risk * 1.2;
    if ((ep - tp2) / risk < 2.0) tp2 = ep - risk * 2.0;
    if ((ep - tp3) / risk < 3.0) tp3 = ep - risk * 3.0;
  }

  return { tp1, tp2, tp3 };
}

/* ─── calcDCALadder v2 — 3-entry DCA (aggressive / optimal / conservative) ─── */
function calcDCALadder(ep, sl, direction, fibData, srZones, mtfOBs, atr) {
  if (!ep || !sl) return null;
  const aV   = atr ? atr.atr : Math.abs(ep - sl) * 0.35;
  const risk = Math.abs(ep - sl);

  // Entry 1 (aggressive): current signal entry (EP itself = 40% position)
  const e1 = ep;

  // Entry 2 (optimal): 0.382–0.5 fib retracement from entry toward SL (40% position)
  let e2 = null;
  if (fibData && fibData.levels) {
    const candidates38 = fibData.levels.filter(l => Math.abs(l.r - 0.382) < 0.05 && (direction === 'LONG' ? l.price < e1 - aV * 0.3 : l.price > e1 + aV * 0.3));
    const candidates50 = fibData.levels.filter(l => Math.abs(l.r - 0.5)   < 0.05 && (direction === 'LONG' ? l.price < e1 - aV * 0.3 : l.price > e1 + aV * 0.3));
    const best = [...candidates38, ...candidates50].sort((a, b) =>
      direction === 'LONG' ? b.price - a.price : a.price - b.price
    )[0];
    if (best) e2 = best.price;
  }
  if (!e2) {
    // fallback: S/R zone between entry and SL
    if (srZones) {
      const zones = direction === 'LONG' ? srZones.below : srZones.above;
      const mid   = (e1 + sl) / 2;
      const z = zones && zones.find(z => Math.abs(z.price - mid) < risk * 0.4 && z.strength >= 2);
      if (z) e2 = z.price;
    }
    if (!e2) e2 = direction === 'LONG' ? e1 - risk * 0.38 : e1 + risk * 0.38;
  }

  // Entry 3 (conservative): near SL but with buffer — OB zone or 0.618 fib (20% position)
  let e3 = null;
  if (fibData && fibData.levels) {
    const c618 = fibData.levels.filter(l => Math.abs(l.r - 0.618) < 0.05 && (direction === 'LONG' ? l.price < e2 - aV * 0.2 : l.price > e2 + aV * 0.2));
    if (c618.length) e3 = direction === 'LONG' ? Math.max(...c618.map(l => l.price)) : Math.min(...c618.map(l => l.price));
  }
  if (!e3 && mtfOBs) {
    const ob = direction === 'LONG' ? mtfOBs.nearestBullOB : mtfOBs.nearestBearOB;
    if (ob) {
      const midOB = (ob.high + ob.low) / 2;
      if (direction === 'LONG' && midOB < e2 - aV * 0.2) e3 = midOB;
      if (direction === 'SHORT' && midOB > e2 + aV * 0.2) e3 = midOB;
    }
  }
  if (!e3) e3 = direction === 'LONG' ? e1 - risk * 0.618 : e1 + risk * 0.618;

  // Validate all entries are on correct side of SL
  if (direction === 'LONG') {
    if (e2 <= sl) e2 = sl + aV * 0.4;
    if (e3 <= sl) e3 = sl + aV * 0.2;
    if (e2 >= e1) e2 = e1 - aV * 0.3;
    if (e3 >= e2) e3 = e2 - aV * 0.2;
  } else {
    if (e2 >= sl) e2 = sl - aV * 0.4;
    if (e3 >= sl) e3 = sl - aV * 0.2;
    if (e2 <= e1) e2 = e1 + aV * 0.3;
    if (e3 <= e2) e3 = e2 + aV * 0.2;
  }

  // Weighted average entry
  const avgEntry = (e1 * 0.4 + e2 * 0.4 + e3 * 0.2);

  return {
    e1, e1pct: 40, e1label: 'Aggressive',
    e2, e2pct: 40, e2label: 'Optimal',
    e3, e3pct: 20, e3label: 'Conservative',
    avgEntry,
  };
}

// Keep backward compat alias
function calcDCAPoint(ep, sl, direction, fibonacci, srZones, mtfOBs, atr) {
  const ladder = calcDCALadder(ep, sl, direction, fibonacci, srZones, mtfOBs, atr);
  return ladder ? ladder.e2 : null; // return optimal entry as single DCA point
}

/* ─── detectMarketRegime — Trending/Ranging/Volatile/Accumulation/Distribution ─── */
function detectMarketRegime(C, H, L, V, adx, bb, atr) {
  if (!C || C.length < 30) return { regime: 'Unknown', label: '❓ Unknown', color: 'var(--muted)', score: 0 };

  const aV    = atr ? atr.atr : (H[H.length-1] - L[L.length-1]);
  const price = C[C.length - 1];

  let trendScore   = 0; // positive = trending
  let volatScore   = 0; // high = volatile
  let accumScore   = 0; // positive = accumulation, negative = distribution

  // ADX — primary trend indicator
  if (adx) {
    if (adx.adx >= 40)      trendScore += 30;
    else if (adx.adx >= 25) trendScore += 20;
    else if (adx.adx >= 18) trendScore += 5;
    else                    trendScore -= 15; // below 18 = ranging
  }

  // BB width — squeeze = ranging, wide = volatile/trending
  if (bb) {
    if (bb.width > 0.08)      volatScore += 20;
    else if (bb.width > 0.04) volatScore += 5;
    else                      trendScore -= 10; // squeeze = ranging
  }

  // ATR% — high ATR% = volatile
  const atrPct = aV / price * 100;
  if (atrPct > 4)      volatScore += 25;
  else if (atrPct > 2) volatScore += 10;

  // Price vs EMA trend direction consistency (last 10 candles)
  const ema20 = (() => { const k = 2/21; let e = C.slice(0,20).reduce((a,b)=>a+b,0)/20; for (let i = 20; i < C.length; i++) e = C[i]*k+e*(1-k); return e; })();
  const recentC = C.slice(-10);
  const aboveEMA = recentC.filter(c => c > ema20).length;
  if (aboveEMA >= 8 || aboveEMA <= 2) trendScore += 15; // consistent = trending
  else                                  trendScore -= 10; // mixed = ranging

  // Volume profile — rising volume in direction of move = trending
  const avgVol = V ? V.slice(-20).reduce((a, b) => a + b, 0) / 20 : 0;
  const lastVol = V ? V[V.length - 2] : 0;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  if (volRatio >= 1.5) accumScore += 10;
  else if (volRatio < 0.6) accumScore -= 5;

  // OBV-style: recent close vs open momentum
  let upBars = 0, dnBars = 0, upVol = 0, dnVol = 0;
  const recent20 = C.slice(-20);
  for (let i = 1; i < recent20.length; i++) {
    if (recent20[i] > recent20[i-1]) { upBars++; upVol += V ? V[V.length - 20 + i] : 1; }
    else                              { dnBars++; dnVol += V ? V[V.length - 20 + i] : 1; }
  }
  if (upVol > dnVol * 1.5)      accumScore += 20; // more buy volume = accumulation
  else if (dnVol > upVol * 1.5) accumScore -= 20; // more sell volume = distribution

  // Classify
  let regime, label, color;

  if (volatScore >= 35 && trendScore < 10) {
    regime = 'Volatile';
    label  = '⚡ Volatile/Choppy';
    color  = 'var(--yellow)';
  } else if (trendScore >= 25) {
    if (accumScore >= 10) {
      regime = 'Trending Bull';
      label  = '🚀 Trending Bullish';
      color  = 'var(--green)';
    } else if (accumScore <= -10) {
      regime = 'Trending Bear';
      label  = '🔻 Trending Bearish';
      color  = 'var(--red)';
    } else {
      regime = 'Trending';
      label  = '📈 Trending';
      color  = 'var(--cyan)';
    }
  } else if (trendScore <= -10) {
    regime = 'Ranging';
    label  = '↔ Ranging/Consolidating';
    color  = 'var(--muted)';
  } else if (accumScore >= 15) {
    regime = 'Accumulation';
    label  = '🏦 Accumulation';
    color  = 'rgba(0,255,136,.8)';
  } else if (accumScore <= -15) {
    regime = 'Distribution';
    label  = '🏚 Distribution';
    color  = 'rgba(255,61,90,.8)';
  } else {
    regime = 'Neutral';
    label  = '〰 Neutral';
    color  = 'var(--muted)';
  }

  return {
    regime,
    label,
    color,
    trendScore,
    volatScore,
    accumScore,
    isTrending:     trendScore >= 25,
    isRanging:      trendScore <= -10,
    isVolatile:     volatScore >= 35,
    isAccumulation: accumScore >= 15,
    isDistribution: accumScore <= -15,
    // Strategy hint
    strategyHint: trendScore >= 25
      ? 'Trend-following strategy preferred. Breakouts & pullbacks to EMA are highest probability.'
      : trendScore <= -10
      ? 'Range trading. Buy near support, sell near resistance. Avoid breakout entries.'
      : volatScore >= 35
      ? 'High volatility — reduce position size. Wait for clear directional move.'
      : 'Transitional market. Monitor for breakout or range establishment.',
  };
}

/* ─── checkMomentumConfirmation v2 ─── */
function checkMomentumConfirmation(O, C, H, L, direction, atr) {
  if (!O || O.length < 3) return { confirmed: false, label: 'No data', strength: 0 };
  const aV = atr ? atr.atr : Math.abs(C[C.length-1]) * 0.01;
  const i  = O.length - 2; // last closed candle
  const o = O[i], c = C[i], h = H[i], l = L[i];
  const body = Math.abs(c - o), range = h - l;
  const isBull = c > o, isBear = c < o;
  const bodyRatio  = range > 0 ? body / range : 0;
  const upWick     = h - Math.max(o, c);
  const downWick   = Math.min(o, c) - l;
  const pi = i - 1;
  const prevBull = C[pi] > O[pi], prevBear = C[pi] < O[pi];

  let confirmed = false, label = '', strength = 0;

  if (direction === 'LONG') {
    if (isBull && bodyRatio >= 0.5) {
      strength = bodyRatio >= 0.75 ? 3 : 2;
      label = bodyRatio >= 0.75 ? 'Strong Bull Close' : 'Bull Close';
      confirmed = true;
    } else if (isBull && downWick >= body * 1.5) {
      strength = 2; label = 'Hammer Close'; confirmed = true;
    } else if (isBull && bodyRatio < 0.35) {
      strength = 1; label = 'Weak Bull (Doji)'; confirmed = false;
    } else if (isBear) {
      strength = 0; label = 'Bear Candle ⚠ (no confirm)'; confirmed = false;
    }
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

/* ─── calcEntryInvalidation v2 ─── */
function calcEntryInvalidation(dir, ep, sl, fibonacci, srZones, mtfOBs, atr) {
  const risk = Math.abs(ep - sl);
  const aV   = atr ? atr.atr : risk * 0.5;

  if (dir === 'LONG') {
    let invLevel = sl - aV * 0.2;
    // Tighten to confluence zone if available
    if (fibonacci && fibonacci.confluenceZones) {
      const cz = fibonacci.confluenceZones.filter(z => z.price < ep && z.price > sl - aV * 2).sort((a, b) => b.price - a.price)[0];
      if (cz) invLevel = cz.price - aV * 0.1;
    }
    if (mtfOBs && mtfOBs.nearestBullOB) {
      const obLow = mtfOBs.nearestBullOB.low;
      if (obLow < ep && obLow > invLevel) invLevel = obLow - aV * 0.1;
    }
    const distPct = ep > 0 ? ((ep - invLevel) / ep * 100).toFixed(2) : '—';
    return { level: invLevel, distPct, note: `Setup fails if price closes below ${invLevel.toFixed(6)}` };
  } else {
    let invLevel = sl + aV * 0.2;
    if (fibonacci && fibonacci.confluenceZones) {
      const cz = fibonacci.confluenceZones.filter(z => z.price > ep && z.price < sl + aV * 2).sort((a, b) => a.price - b.price)[0];
      if (cz) invLevel = cz.price + aV * 0.1;
    }
    if (mtfOBs && mtfOBs.nearestBearOB) {
      const obHigh = mtfOBs.nearestBearOB.high;
      if (obHigh > ep && obHigh < invLevel) invLevel = obHigh + aV * 0.1;
    }
    const distPct = ep > 0 ? ((invLevel - ep) / ep * 100).toFixed(2) : '—';
    return { level: invLevel, distPct, note: `Setup fails if price closes above ${invLevel.toFixed(6)}` };
  }
}

/* ─── calcLimitExpiry ─── */
function calcLimitExpiry(entryType, atr, price) {
  if (entryType === 'MARKET') return null;
  const atrPct = atr ? atr.pct : 1.5;
  const hours  = atrPct > 3 ? 2 : atrPct > 1.5 ? 4 : 8;
  const expiry = new Date(Date.now() + hours * 3600 * 1000);
  return {
    hours,
    expiryTime: expiry.toUTCString(),
    note: `Cancel if not filled within ${hours}H (${expiry.toUTCString().slice(17,22)} UTC)`
  };
}

/* ─── detectCandlePatterns v2 — more patterns ─── */
function detectCandlePatterns(O, H, L, C) {
  if (!O || O.length < 4) return { patterns: [], bullish: false, bearish: false, bullScore: 0, bearScore: 0, latest: null };
  const patterns = [], i = O.length - 1;
  const o = O[i], h = H[i], l = L[i], c = C[i];
  const body = Math.abs(c - o), range = h - l;
  if (range < 1e-10) return { patterns: [], bullish: false, bearish: false, bullScore: 0, bearScore: 0, latest: null };
  const upWick = h - Math.max(o,c), downWick = Math.min(o,c) - l;
  const isBull = c > o, isBear = c < o;
  const po = O[i-1], ph = H[i-1], pl = L[i-1], pc = C[i-1];
  const ppo = O[i-2], pph = H[i-2], ppl = L[i-2], ppc = C[i-2];
  const pppo = i >= 3 ? O[i-3] : O[i-2], pppc = i >= 3 ? C[i-3] : C[i-2];
  const prevBody = Math.abs(pc - po), prevRange = ph - pl;
  const pIsBull = pc > po, pIsBear = pc < po;

  // Single candle patterns
  if (downWick >= body * 2.5 && upWick <= body * 0.5)                       patterns.push({ name: 'Hammer',           type: 'bullish', strength: 2 });
  if (upWick >= body * 2.5 && downWick <= body * 0.5)                        patterns.push({ name: 'Shooting Star',    type: 'bearish', strength: 2 });
  if (body < range * 0.08)                                                    patterns.push({ name: 'Doji',             type: 'neutral', strength: 1 });
  if (downWick >= range * 0.6 && upWick >= range * 0.2 && body < range * 0.2) patterns.push({ name: 'Long-Legged Doji', type: 'neutral', strength: 1 });
  if (body > range * 0.88 && isBull)                                          patterns.push({ name: 'Bull Marubozu',   type: 'bullish', strength: 2 });
  if (body > range * 0.88 && isBear)                                          patterns.push({ name: 'Bear Marubozu',   type: 'bearish', strength: 2 });
  if (upWick >= range * 0.65 && body < range * 0.15 && downWick < range * 0.1) patterns.push({ name: 'Gravestone Doji', type: 'bearish', strength: 2 });
  if (downWick >= range * 0.65 && body < range * 0.15 && upWick < range * 0.1) patterns.push({ name: 'Dragonfly Doji',  type: 'bullish', strength: 2 });

  // Two-candle patterns
  if (isBull && pIsBear && c > po && o < pc)                                 patterns.push({ name: 'Bullish Engulfing', type: 'bullish', strength: 3 });
  if (isBear && pIsBull && c < po && o > pc)                                 patterns.push({ name: 'Bearish Engulfing', type: 'bearish', strength: 3 });
  if (isBull && pIsBear && o < pc && c > (po + pc) / 2 && c < po)           patterns.push({ name: 'Piercing Line',     type: 'bullish', strength: 2 });
  if (isBear && pIsBull && o > pc && c < (po + pc) / 2 && c > po)           patterns.push({ name: 'Dark Cloud Cover',  type: 'bearish', strength: 2 });
  if (Math.abs(l - pl) / (Math.max(l, pl, 1e-10)) < 0.002)                   patterns.push({ name: 'Tweezer Bottom',   type: 'bullish', strength: 2 });
  if (Math.abs(h - ph) / (Math.max(h, ph, 1e-10)) < 0.002)                   patterns.push({ name: 'Tweezer Top',      type: 'bearish', strength: 2 });

  // Three-candle patterns
  if (isBull && pIsBear && pIsBear && ppc < ppo && prevBody < prevRange * 0.3 && o < pc && c > (ppo + ppc) / 2)
    patterns.push({ name: 'Morning Star', type: 'bullish', strength: 3 });
  if (isBear && pIsBull && ppc > ppo && prevBody < prevRange * 0.3 && o > pc && c < (ppo + ppc) / 2)
    patterns.push({ name: 'Evening Star', type: 'bearish', strength: 3 });

  // Three white soldiers / three black crows
  if (isBull && pIsBull && pIsBull && C[i-2] > O[i-2] &&
      c > pc && pc > C[i-2] && body > range * 0.6 && prevBody > prevRange * 0.6)
    patterns.push({ name: '3 White Soldiers', type: 'bullish', strength: 4 });
  if (isBear && pIsBear && C[i-2] < O[i-2] &&
      c < pc && pc < C[i-2] && body > range * 0.6 && prevBody > prevRange * 0.6)
    patterns.push({ name: '3 Black Crows', type: 'bearish', strength: 4 });

  const bullish   = patterns.some(p => p.type === 'bullish');
  const bearish   = patterns.some(p => p.type === 'bearish');
  const bullScore = patterns.filter(p => p.type === 'bullish').reduce((a, p) => a + p.strength, 0);
  const bearScore = patterns.filter(p => p.type === 'bearish').reduce((a, p) => a + p.strength, 0);
  const latest    = patterns.filter(p => p.type !== 'neutral')[0] || patterns[0] || null;
  return { patterns, bullish, bearish, bullScore, bearScore, latest };
}

/* ─── calcPivotPoints ─── */
function calcPivotPoints(kl1d) {
  if (!kl1d || kl1d.length < 2) return null;
  const prev = kl1d[kl1d.length - 2];
  const pH = parseFloat(prev[2]), pL = parseFloat(prev[3]), pC = parseFloat(prev[4]);
  const PP = (pH + pL + pC) / 3;
  return {
    PP,
    R1: 2*PP-pL, R2: PP+(pH-pL), R3: pH+2*(PP-pL),
    S1: 2*PP-pH, S2: PP-(pH-pL), S3: pL-2*(pH-PP),
    prevHigh: pH, prevLow: pL, prevClose: pC
  };
}


/* ═══════════════════════════════════════════════════════════════════
   SMC — LIQUIDITY SWEEPS
   Equal highs/lows swept by a wick then reversed = stop hunt
   Signals institutional entry after retail stops taken
   ═══════════════════════════════════════════════════════════════════ */
function detectLiquiditySweeps(H, L, C, O, atr) {
  if (!H || H.length < 20) return { bullSweep: null, bearSweep: null, recentSweeps: [] };
  const aV       = atr ? atr.atr : (H[H.length-1] - L[L.length-1]);
  const eqTol    = aV * 0.25;   // tolerance for "equal" highs/lows
  const sweepTol = aV * 0.15;   // wick must pierce beyond by at least this
  const lb       = Math.min(H.length - 3, 50);
  const sweeps   = [];

  for (let i = 2; i < lb; i++) {
    const idx = H.length - 1 - i;
    if (idx < 3) continue;

    // Find equal lows (BSL — buy-side liquidity) in previous 5-20 bars
    const lookH = H.slice(Math.max(0, idx - 20), idx);
    const lookL = L.slice(Math.max(0, idx - 20), idx);

    // === BEARISH LIQUIDITY SWEEP (equal highs taken, then reversal down) ===
    const eqHighs = lookH.filter(h => Math.abs(h - H[idx]) < eqTol);
    if (eqHighs.length >= 1) {
      const swept   = H[idx] > Math.max(...lookH.slice(-5)) - sweepTol; // wick pierced above
      const reversed = C[idx] < O[idx]; // closed bearish (reversal candle)
      const upperWick = H[idx] - Math.max(O[idx], C[idx]);
      const wickRatio = (H[idx] - L[idx]) > 0 ? upperWick / (H[idx] - L[idx]) : 0;
      if (swept && reversed && wickRatio >= 0.35) {
        sweeps.push({
          type:      'bearish',
          level:     H[idx],
          sweepHigh: H[idx],
          closePrice: C[idx],
          age:       i,
          barIdx:    idx,
          wickRatio: +wickRatio.toFixed(2),
          strength:  eqHighs.length >= 2 ? 'strong' : 'moderate',
          label:     `🐻 Bear Liquidity Sweep @ ${H[idx].toFixed(4)} (${eqHighs.length + 1} equal highs swept)`,
        });
      }
    }

    // === BULLISH LIQUIDITY SWEEP (equal lows taken, then reversal up) ===
    const eqLows = lookL.filter(l => Math.abs(l - L[idx]) < eqTol);
    if (eqLows.length >= 1) {
      const swept    = L[idx] < Math.min(...lookL.slice(-5)) + sweepTol;
      const reversed = C[idx] > O[idx];
      const lowerWick = Math.min(O[idx], C[idx]) - L[idx];
      const wickRatio = (H[idx] - L[idx]) > 0 ? lowerWick / (H[idx] - L[idx]) : 0;
      if (swept && reversed && wickRatio >= 0.35) {
        sweeps.push({
          type:      'bullish',
          level:     L[idx],
          sweepLow:  L[idx],
          closePrice: C[idx],
          age:       i,
          barIdx:    idx,
          wickRatio: +wickRatio.toFixed(2),
          strength:  eqLows.length >= 2 ? 'strong' : 'moderate',
          label:     `🟢 Bull Liquidity Sweep @ ${L[idx].toFixed(4)} (${eqLows.length + 1} equal lows swept)`,
        });
      }
    }
  }

  // Sort: most recent first
  sweeps.sort((a, b) => a.age - b.age);

  const price     = C[C.length - 1];
  const bullSweep = sweeps.filter(s => s.type === 'bullish' && s.age <= 12)[0] || null;
  const bearSweep = sweeps.filter(s => s.type === 'bearish' && s.age <= 12)[0] || null;

  return { bullSweep, bearSweep, recentSweeps: sweeps.slice(0, 5), price };
}

/* ═══════════════════════════════════════════════════════════════════
   SMC — BREAKER BLOCKS
   A failed OB that gets broken = flips polarity (support → resistance)
   Strongest SMC level because liquidity was already swept there
   ═══════════════════════════════════════════════════════════════════ */
function detectBreakerBlocks(O, H, L, C, atr) {
  if (!O || O.length < 25) return { bullBreakers: [], bearBreakers: [], nearestBull: null, nearestBear: null };
  const aV      = atr ? atr.atr : (H[H.length-1] - L[H.length-1]) * 0.5;
  const price   = C[C.length - 1];
  const lb      = Math.min(O.length - 4, 80);
  const bullBreakers = [], bearBreakers = [];

  for (let i = 4; i < lb; i++) {
    const idx = O.length - 1 - i;
    if (idx < 4) continue;

    const isBear = C[idx] < O[idx];
    const isBull = C[idx] > O[idx];

    // ── BULL BREAKER: was a bear OB → price broke above it → now support ──
    if (isBull) {
      // Check: impulse up from this candle
      const impulseUp = C[idx+1] > H[idx] || (idx+2 < C.length && C[idx+2] > H[idx]);
      if (impulseUp) {
        // Check: price later came back down and broke the OB (it failed as resistance)
        let broke = false;
        for (let j = idx + 2; j < Math.min(idx + 20, C.length - 1); j++) {
          if (L[j] < L[idx]) { broke = true; break; }
        }
        if (broke && price > H[idx]) {
          // Now price is above it = flipped to support = bull breaker
          bullBreakers.push({
            high:     H[idx],
            low:      L[idx],
            mid:      (H[idx] + L[idx]) / 2,
            age:      i,
            strength: impulseUp ? 'strong' : 'moderate',
            label:    `🟩 Bull Breaker Block ${H[idx].toFixed(4)}–${L[idx].toFixed(4)}`,
          });
        }
      }
    }

    // ── BEAR BREAKER: was a bull OB → price broke below it → now resistance ──
    if (isBear) {
      const impulseDown = C[idx+1] < L[idx] || (idx+2 < C.length && C[idx+2] < L[idx]);
      if (impulseDown) {
        let broke = false;
        for (let j = idx + 2; j < Math.min(idx + 20, C.length - 1); j++) {
          if (H[j] > H[idx]) { broke = true; break; }
        }
        if (broke && price < L[idx]) {
          bearBreakers.push({
            high:     H[idx],
            low:      L[idx],
            mid:      (H[idx] + L[idx]) / 2,
            age:      i,
            strength: impulseDown ? 'strong' : 'moderate',
            label:    `🟥 Bear Breaker Block ${H[idx].toFixed(4)}–${L[idx].toFixed(4)}`,
          });
        }
      }
    }
  }

  bullBreakers.sort((a, b) => Math.abs(price - a.mid) - Math.abs(price - b.mid));
  bearBreakers.sort((a, b) => Math.abs(price - a.mid) - Math.abs(price - b.mid));

  return {
    bullBreakers: bullBreakers.slice(0, 3),
    bearBreakers: bearBreakers.slice(0, 3),
    nearestBull:  bullBreakers[0] || null,
    nearestBear:  bearBreakers[0] || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ICT — OPTIMAL TRADE ENTRY (OTE)
   61.8%–79% fibonacci retracement of the last impulse wave
   ICT's highest probability entry zone after a BOS
   ═══════════════════════════════════════════════════════════════════ */
function calcOTEZone(H, L, C, O, atr, bos) {
  if (!H || H.length < 20) return null;
  const aV    = atr ? atr.atr : (H[H.length-1] - L[L.length-1]);
  const price = C[C.length - 1];
  const lb    = Math.min(H.length - 2, 60);

  // Find most recent significant impulse (BOS or large move)
  let impHigh = null, impLow = null, direction = null;

  // Use BOS if available
  if (bos && bos.type === 'bullish' && bos.level) {
    const lvl   = bos.level;
    const from  = H.slice(-lb).findIndex(h => h >= lvl * 0.998);
    const swing = {
      high: Math.max(...H.slice(-lb)),
      low:  Math.min(...L.slice(-lb)),
    };
    impHigh   = swing.high;
    impLow    = swing.low;
    direction = 'bullish';
  } else if (bos && bos.type === 'bearish' && bos.level) {
    impHigh   = Math.max(...H.slice(-lb));
    impLow    = Math.min(...L.slice(-lb));
    direction = 'bearish';
  } else {
    // Auto-detect: find largest range in recent bars
    let maxRange = 0, hiI = 0, loI = 0;
    for (let i = 5; i < lb; i++) {
      for (let j = 0; j < i; j++) {
        const r = Math.abs(H[H.length-1-j] - L[L.length-1-i]);
        if (r > maxRange) { maxRange = r; hiI = j; loI = i; }
      }
    }
    const recentH = H.slice(-lb), recentL = L.slice(-lb);
    const hiIdx   = recentH.lastIndexOf(Math.max(...recentH.slice(-30)));
    const loIdx   = recentL.lastIndexOf(Math.min(...recentL.slice(-30)));
    impHigh       = Math.max(...recentH.slice(-30));
    impLow        = Math.min(...recentL.slice(-30));
    direction     = hiIdx > loIdx ? 'bearish' : 'bullish';
  }

  if (!impHigh || !impLow || impHigh <= impLow) return null;
  const range = impHigh - impLow;
  if (range < aV * 1.5) return null; // impulse too small

  // OTE zone: 61.8% to 78.6% retracement
  let ote618, ote786, oteHigh, oteLow;
  if (direction === 'bullish') {
    // Pullback zone to buy
    ote618 = impHigh - 0.618 * range;
    ote786 = impHigh - 0.786 * range;
    oteLow  = ote786 - aV * 0.1;
    oteHigh = ote618 + aV * 0.1;
  } else {
    // Pullback zone to sell
    ote618 = impLow + 0.618 * range;
    ote786 = impLow + 0.786 * range;
    oteLow  = ote618 - aV * 0.1;
    oteHigh = ote786 + aV * 0.1;
  }

  const priceInOTE = price >= Math.min(oteLow, oteHigh) && price <= Math.max(oteLow, oteHigh);
  const distToOTE  = price > oteHigh ? price - oteHigh : price < oteLow ? oteLow - price : 0;
  const distPct    = (distToOTE / price) * 100;

  return {
    direction,
    impHigh,
    impLow,
    range,
    ote618,
    ote786,
    oteLow:  Math.min(oteLow, oteHigh),
    oteHigh: Math.max(oteLow, oteHigh),
    priceInOTE,
    distPct:  +distPct.toFixed(2),
    nearOTE:  distPct < 0.8,
    label:    `ICT OTE ${direction === 'bullish' ? 'Buy' : 'Sell'} Zone: ${Math.min(oteLow,oteHigh).toFixed(4)}–${Math.max(oteLow,oteHigh).toFixed(4)}`,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ICT — KILLZONES (time-based high-probability windows)
   London: 02:00–05:00 UTC
   NY AM:  07:00–10:00 UTC (Silver Bullet: 10:00–11:00)
   London Close: 14:00–16:00 UTC
   Asian: 20:00–00:00 UTC (low probability)
   ═══════════════════════════════════════════════════════════════════ */
function getICTKillzone() {
  const now  = new Date();
  const h    = now.getUTCHours();
  const m    = now.getUTCMinutes();
  const hm   = h + m / 60;

  const zones = [
    { name: 'Asian Killzone',         start: 20,   end: 24,   quality: 'low',    color: '#64748b', desc: 'Low volatility accumulation. Avoid entries.' },
    { name: 'Asian Killzone',         start: 0,    end: 2.5,  quality: 'low',    color: '#64748b', desc: 'Low volatility accumulation. Avoid entries.' },
    { name: '🏦 London Killzone',     start: 2,    end: 5,    quality: 'high',   color: '#00d4ff', desc: 'High probability. London banks set daily direction. Best for trend entries.' },
    { name: '⚡ London/NY Overlap',   start: 7,    end: 10,   quality: 'highest',color: '#00ff88', desc: 'HIGHEST probability window. Most liquidity. Best setups form here.' },
    { name: '🎯 Silver Bullet',       start: 10,   end: 11,   quality: 'high',   color: '#a78bfa', desc: 'ICT Silver Bullet window. FVG entries only. Very high accuracy.' },
    { name: '🇺🇸 NY PM Session',     start: 13,   end: 16,   quality: 'medium', color: '#fbbf24', desc: 'NY afternoon. London close liquidity grabs. Medium probability.' },
    { name: 'Dead Zone',              start: 16,   end: 20,   quality: 'avoid',  color: '#ff3d5a', desc: 'Low volume. Avoid new positions. Choppy price action.' },
  ];

  let activeZone = null;
  for (const z of zones) {
    if (hm >= z.start && hm < z.end) { activeZone = z; break; }
  }
  if (!activeZone) activeZone = zones[0]; // default Asian

  // Minutes to next killzone
  const nextHigh = zones.find(z => z.quality === 'high' || z.quality === 'highest');
  let nextKZStart = null;
  for (const z of zones.filter(z => z.quality !== 'low' && z.quality !== 'avoid')) {
    if (z.start > hm) { nextKZStart = z; break; }
  }

  return {
    ...activeZone,
    isKillzone: activeZone.quality === 'high' || activeZone.quality === 'highest',
    isSilverBullet: hm >= 10 && hm < 11,
    isDeadZone: activeZone.quality === 'avoid',
    isAsian: activeZone.quality === 'low',
    utcTime: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} UTC`,
    nextKillzone: nextKZStart ? `${nextKZStart.name} @ ${nextKZStart.start}:00 UTC` : null,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ICT — AMD MODEL (Accumulation → Manipulation → Distribution)
   Detects classic 3-phase institutional pattern
   Accumulation: tight range / Manipulation: fake breakout / Distribution: real move
   ═══════════════════════════════════════════════════════════════════ */
function detectAMDModel(O, H, L, C, V, atr) {
  if (!O || O.length < 30) return null;
  const aV    = atr ? atr.atr : (H[H.length-1] - L[H.length-1]) * 0.5;
  const price = C[C.length - 1];
  const lb    = Math.min(O.length - 2, 48); // look back ~2 days on 1H

  // === Phase 1: ACCUMULATION — tight range (BB squeeze or ATR contraction) ===
  const accBars  = Math.min(lb, 24);
  const accH     = H.slice(-accBars);
  const accL     = L.slice(-accBars);
  const accRange = Math.max(...accH) - Math.min(...accL);
  const accAvgAV = accH.map((h, i) => h - accL[i]).reduce((a, b) => a + b, 0) / accBars;
  const isTight  = accAvgAV < aV * 0.8; // candles smaller than usual ATR

  // === Phase 2: MANIPULATION — spike beyond range (stop hunt) then reversal ===
  // Look at most recent 6 bars for spike+reversal
  const manBars  = 8;
  const manH     = H.slice(-manBars);
  const manL     = L.slice(-manBars);
  const manO     = O.slice(-manBars);
  const manC     = C.slice(-manBars);
  const manV     = V ? V.slice(-manBars) : null;

  let manipulation = null;
  for (let i = 1; i < manBars - 1; i++) {
    const prevHigh = Math.max(...manH.slice(0, i));
    const prevLow  = Math.min(...manL.slice(0, i));
    const spikeUp  = manH[i] > prevHigh + aV * 0.3 && manC[i] < manO[i]; // wick up, close down
    const spikeDown = manL[i] < prevLow - aV * 0.3 && manC[i] > manO[i]; // wick down, close up
    if (spikeUp)   manipulation = { dir: 'bearish', spikeLevel: manH[i], age: manBars - 1 - i, type: 'Bull trap (fake breakout up)' };
    if (spikeDown) manipulation = { dir: 'bullish', spikeLevel: manL[i], age: manBars - 1 - i, type: 'Bear trap (fake breakdown down)' };
  }

  // === Phase 3: DISTRIBUTION — current momentum direction after manipulation ===
  const recentC  = C.slice(-5);
  const momentum = recentC[recentC.length-1] - recentC[0];
  const distDir  = momentum > aV * 0.3 ? 'bullish' : momentum < -aV * 0.3 ? 'bearish' : null;

  if (!manipulation) return null;

  const confidence = (isTight ? 30 : 10) + (manipulation ? 40 : 0) + (distDir && distDir === manipulation.dir ? 30 : 0);
  const detected   = confidence >= 50;

  return {
    detected,
    confidence,
    phase: distDir ? 'distribution' : manipulation ? 'manipulation' : 'accumulation',
    accumulation:  { detected: isTight, avgRange: +accAvgAV.toFixed(4), atrRatio: +(accAvgAV/aV).toFixed(2) },
    manipulation,
    distribution:  { direction: distDir, momentum: +momentum.toFixed(4) },
    tradeBias:     manipulation ? manipulation.dir : null,
    label: detected
      ? `🏛 AMD Pattern: ${manipulation.type} → ${manipulation.dir === 'bullish' ? '▲ Bullish' : '▼ Bearish'} distribution (${confidence}% conf)`
      : null,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   VSA — VOLUME SPREAD ANALYSIS
   Reads price spread + volume relationship to detect
   institutional buying/selling, no demand, no supply
   ═══════════════════════════════════════════════════════════════════ */
function detectVSA(O, H, L, C, V, atr) {
  if (!V || V.length < 20) return null;
  const aV      = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const lb      = Math.min(V.length - 1, 20);
  const avgVol  = V.slice(-lb).reduce((a, b) => a + b, 0) / lb;
  const signals = [];

  for (let i = 1; i <= Math.min(5, lb); i++) {
    const idx     = O.length - 1 - i;
    if (idx < 1) continue;
    const o = O[idx], h = H[idx], l = L[idx], c = C[idx], v = V[idx];
    const spread     = h - l;
    const body       = Math.abs(c - o);
    const upWick     = h - Math.max(o, c);
    const downWick   = Math.min(o, c) - l;
    const isBull     = c > o, isBear = c < o;
    const volRatio   = avgVol > 0 ? v / avgVol : 1;
    const spreadRatio = spread > 0 ? spread / aV : 0.5;
    const age        = i;

    // ── No Demand (bearish signal) ──
    // Up bar, narrow spread, low volume = no institutional interest in rally
    if (isBull && spreadRatio < 0.6 && volRatio < 0.7) {
      signals.push({ type: 'no_demand', age, label: '📉 No Demand — Up bar, narrow spread, low volume. Bullish move lacks institutional support.', bias: 'bearish', strength: 2 });
    }

    // ── No Supply (bullish signal) ──
    // Down bar, narrow spread, low volume = no institutional selling pressure
    if (isBear && spreadRatio < 0.6 && volRatio < 0.7) {
      signals.push({ type: 'no_supply', age, label: '📈 No Supply — Down bar, narrow spread, low volume. Bears losing control.', bias: 'bullish', strength: 2 });
    }

    // ── Stopping Volume (bullish) ──
    // Huge volume, wide spread, closes off lows = absorption of selling
    if (volRatio >= 2.0 && spreadRatio >= 1.0 && downWick >= spread * 0.35) {
      signals.push({ type: 'stopping_volume', age, label: `🛑 Stopping Volume — Huge vol (${volRatio.toFixed(1)}x), closes off lows. Institutional absorption of selling.`, bias: 'bullish', strength: 4 });
    }

    // ── Climactic Supply (bearish) ──
    // Huge volume up bar at highs = distribution, price about to turn
    if (volRatio >= 2.0 && isBull && upWick >= spread * 0.3 && spreadRatio >= 0.8) {
      signals.push({ type: 'climactic_supply', age, label: `🏔 Climactic Supply — Huge vol (${volRatio.toFixed(1)}x) on up bar with upper wick. Institutional distribution.`, bias: 'bearish', strength: 4 });
    }

    // ── Effort vs Result (bullish / bearish) ──
    // High volume + tiny move = absorption (opposing institutional players)
    if (volRatio >= 1.8 && spreadRatio < 0.4) {
      const absBias = isBull ? 'bearish' : 'bullish'; // opposite = one side absorbing other
      signals.push({ type: 'effort_no_result', age, label: `⚖ Effort Without Result — High vol (${volRatio.toFixed(1)}x) but tiny spread. ${absBias === 'bullish' ? 'Bears absorbed by bulls.' : 'Bulls absorbed by bears.'}`, bias: absBias, strength: 3 });
    }

    // ── Ultra-Low Volume (warning) ──
    if (volRatio < 0.35 && i <= 2) {
      signals.push({ type: 'ultra_low_vol', age, label: '⚠ Ultra-Low Volume — Weak move with minimal participation. Unreliable signal.', bias: 'neutral', strength: 1 });
    }
  }

  // Sort: most recent + strongest first
  signals.sort((a, b) => a.age - b.age || b.strength - a.strength);

  const latestBull = signals.filter(s => s.bias === 'bullish')[0] || null;
  const latestBear = signals.filter(s => s.bias === 'bearish')[0] || null;
  const dominant   = signals[0] || null;

  return {
    signals: signals.slice(0, 4),
    latestBull,
    latestBear,
    dominant,
    bullScore: signals.filter(s => s.bias === 'bullish').reduce((a, s) => a + s.strength, 0),
    bearScore: signals.filter(s => s.bias === 'bearish').reduce((a, s) => a + s.strength, 0),
    avgVol,
    latestVolRatio: avgVol > 0 ? +(V[V.length-2] / avgVol).toFixed(2) : 1,
  };
}

