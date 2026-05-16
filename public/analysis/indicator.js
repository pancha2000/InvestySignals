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
    // Enforce minimums — 1.5R / 2.5R / 3.5R
    if ((tp1 - ep) / risk < 1.5) tp1 = ep + risk * 1.5;
    if ((tp2 - ep) / risk < 2.5) tp2 = ep + risk * 2.5;
    if ((tp3 - ep) / risk < 3.5) tp3 = ep + risk * 3.5;
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
    if ((ep - tp1) / risk < 1.5) tp1 = ep - risk * 1.5;
    if ((ep - tp2) / risk < 2.5) tp2 = ep - risk * 2.5;
    if ((ep - tp3) / risk < 3.5) tp3 = ep - risk * 3.5;
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


/* ═══════════════════════════════════════════════════════════════════
   WYCKOFF METHOD — Accumulation & Distribution Schematic Detection
   Volume-based institutional footprint — highly reliable in crypto
   ═══════════════════════════════════════════════════════════════════ */
function detectWyckoff(O, H, L, C, V, atr) {
  const result = {
    detected:false, phase:null, stage:null, confidence:0,
    bias:null, events:[], rangeHigh:null, rangeLow:null,
    springDetected:false, utadDetected:false, label:null, note:'',
  };
  if (!O||O.length<40||!V||V.length<40) return result;

  const aV=atr?atr.atr:(H[H.length-1]-L[H.length-1]);
  const price=C[C.length-1];
  const lb=Math.min(O.length-2,80);
  const avgVol=V.slice(-lb).reduce((a,b)=>a+b,0)/lb;
  if(avgVol<=0) return result;

  const events=[];
  let confScore=0;

  const bv=i=>{
    const o=O[i],h=H[i],l=L[i],c=C[i],v=V[i];
    const range=h-l,body=Math.abs(c-o);
    return{o,h,l,c,v,range,body,
      upWick:h-Math.max(o,c), dnWick:Math.min(o,c)-l,
      isBull:c>o, isBear:c<o,
      volR:avgVol>0?v/avgVol:1,
      spread:range>0?range/aV:0};
  };

  // Trading Range
  const rBars=Math.min(lb,60);
  const rangeHigh=Math.max(...H.slice(-rBars));
  const rangeLow=Math.min(...L.slice(-rBars));
  const rangeSize=rangeHigh-rangeLow;
  if(rangeSize<aV*2) return result;

  result.rangeHigh=rangeHigh; result.rangeLow=rangeLow;

  // === ACCUMULATION EVENTS ===
  let hasPS=false,hasSC=false,hasAR=false,hasST=false;
  let hasSpring=false,hasSOS=false,hasLPS=false;

  for(let i=5;i<rBars-2;i++){
    const idx=O.length-1-i; if(idx<3) continue;
    const b=bv(idx);

    // PS — Preliminary Support (high vol down bar closes off lows)
    if(!hasPS&&b.volR>=1.8&&b.isBear&&b.spread>=1.2&&
       b.dnWick>=b.range*0.25&&b.l<=rangeLow+rangeSize*0.25){
      hasPS=true; confScore+=10;
      events.push({name:'PS',label:'Preliminary Support',age:i,bias:'bullish',pts:10});
    }
    // SC — Selling Climax (extreme vol, wide spread, closes off lows)
    if(!hasSC&&b.volR>=3.0&&b.isBear&&b.spread>=1.8&&
       b.dnWick>=b.range*0.35&&b.l<=rangeLow+rangeSize*0.15){
      hasSC=true; confScore+=25;
      events.push({name:'SC',label:'Selling Climax',age:i,bias:'bullish',pts:25});
    }
    // AR — Automatic Rally after SC
    if(hasSC&&!hasAR&&b.isBull&&b.volR>=1.3&&b.spread>=0.8&&
       b.h>=rangeLow+rangeSize*0.3){
      hasAR=true; confScore+=12;
      events.push({name:'AR',label:'Automatic Rally',age:i,bias:'bullish',pts:12});
    }
    // ST — Secondary Test on LOW volume
    if(hasSC&&hasAR&&!hasST&&b.volR<=0.8&&b.spread<=0.7&&
       b.l<=rangeLow+rangeSize*0.2&&b.c>b.l+(b.h-b.l)*0.4){
      hasST=true; confScore+=15;
      events.push({name:'ST',label:'Secondary Test',age:i,bias:'bullish',pts:15});
    }
    // Spring — shakeout below range, closes back inside
    if(hasST&&!hasSpring&&b.l<rangeLow-aV*0.1&&
       b.c>rangeLow&&b.dnWick>=b.range*0.45&&b.volR>=1.0){
      hasSpring=true; confScore+=20;
      events.push({name:'Spring',label:'\uD83C\uDF31 Spring (Shakeout)',age:i,bias:'bullish',pts:20});
    }
    // SOS — Sign of Strength (strong up bar breaks range on high vol)
    if((hasST||hasSpring)&&!hasSOS&&b.isBull&&b.volR>=2.0&&
       b.spread>=1.3&&b.h>=rangeHigh-rangeSize*0.1){
      hasSOS=true; confScore+=18;
      events.push({name:'SOS',label:'Sign of Strength',age:i,bias:'bullish',pts:18});
    }
    // LPS — Last Point of Support (low vol pullback after SOS = final entry)
    if(hasSOS&&!hasLPS&&b.isBear&&b.volR<=0.7&&b.spread<=0.6&&
       b.l>=rangeLow+rangeSize*0.35){
      hasLPS=true; confScore+=15;
      events.push({name:'LPS',label:'Last Point of Support',age:i,bias:'bullish',pts:15});
    }
  }

  // === DISTRIBUTION EVENTS ===
  let hasPSY=false,hasBC=false,hasARd=false,hasSTd=false;
  let hasUTAD=false,hasSOW=false;
  let distConf=0;

  for(let i=5;i<rBars-2;i++){
    const idx=O.length-1-i; if(idx<3) continue;
    const b=bv(idx);

    // PSY — Preliminary Supply
    if(!hasPSY&&b.volR>=1.8&&b.isBull&&b.spread>=1.2&&
       b.upWick>=b.range*0.25&&b.h>=rangeHigh-rangeSize*0.25){
      hasPSY=true; distConf+=10;
      events.push({name:'PSY',label:'Preliminary Supply',age:i,bias:'bearish',pts:10});
    }
    // BC — Buying Climax (euphoria, extreme vol, closes off highs)
    if(!hasBC&&b.volR>=3.0&&b.isBull&&b.spread>=1.8&&
       b.upWick>=b.range*0.35&&b.h>=rangeHigh-rangeSize*0.15){
      hasBC=true; distConf+=25;
      events.push({name:'BC',label:'Buying Climax',age:i,bias:'bearish',pts:25});
    }
    // AR — Automatic Reaction after BC
    if(hasBC&&!hasARd&&b.isBear&&b.volR>=1.3&&b.spread>=0.8&&
       b.l<=rangeHigh-rangeSize*0.3){
      hasARd=true; distConf+=12;
      events.push({name:'AR',label:'Automatic Reaction',age:i,bias:'bearish',pts:12});
    }
    // ST — Secondary Test on low vol
    if(hasBC&&hasARd&&!hasSTd&&b.volR<=0.8&&b.spread<=0.7&&
       b.h>=rangeHigh-rangeSize*0.2&&b.c<b.l+(b.h-b.l)*0.6){
      hasSTd=true; distConf+=15;
      events.push({name:'ST',label:'Secondary Test (dist)',age:i,bias:'bearish',pts:15});
    }
    // UTAD — False breakout above range (bull trap)
    if(hasSTd&&!hasUTAD&&b.h>rangeHigh+aV*0.1&&
       b.c<rangeHigh&&b.upWick>=b.range*0.4&&b.volR>=1.5){
      hasUTAD=true; distConf+=20;
      events.push({name:'UTAD',label:'\u26A0 UTAD (False Breakout)',age:i,bias:'bearish',pts:20});
    }
    // SOW — Sign of Weakness (strong down bar breaks range)
    if((hasSTd||hasUTAD)&&!hasSOW&&b.isBear&&b.volR>=2.0&&
       b.spread>=1.3&&b.l<=rangeLow+rangeSize*0.1){
      hasSOW=true; distConf+=18;
      events.push({name:'SOW',label:'Sign of Weakness',age:i,bias:'bearish',pts:18});
    }
  }

  const accumEvents=events.filter(e=>e.bias==='bullish');
  const distEvents=events.filter(e=>e.bias==='bearish');
  const accumScore=accumEvents.reduce((s,e)=>s+(e.pts||0),0);
  const dScore=distEvents.reduce((s,e)=>s+(e.pts||0),0);

  if(accumScore<25&&dScore<25) return result;

  const isAccum=accumScore>=dScore;
  const rawConf=isAccum?accumScore:dScore;
  const confidence=Math.min(95,Math.round(rawConf/115*100));
  if(confidence<22) return result;

  const domEvents=(isAccum?accumEvents:distEvents).sort((a,b)=>a.age-b.age);
  const latestEvent=domEvents[0]||null;
  const phase=isAccum?'accumulation':'distribution';
  const bias=isAccum?'bullish':'bearish';

  let note='';
  const cs=latestEvent?latestEvent.name:null;
  if(isAccum){
    if(hasLPS)         note='LPS formed — highest probability LONG entry. Markup imminent.';
    else if(hasSOS)    note='SOS confirmed. Wait for LPS pullback to enter LONG.';
    else if(hasSpring) note='Spring detected — shakeout complete. Strong reversal setup.';
    else if(hasST)     note='ST on low volume confirmed. Range being accumulated. Await SOS.';
    else if(hasAR)     note='AR after SC. Range forming. Wait for ST confirmation.';
    else if(hasSC)     note='Selling Climax detected — potential bottom forming.';
    else               note='PS detected — decline slowing. Range formation beginning.';
  } else {
    if(hasSOW)         note='SOW confirmed — markdown beginning. Highest probability SHORT.';
    else if(hasUTAD)   note='UTAD (bull trap) complete. Distribution done. Enter SHORT.';
    else if(hasSTd)    note='ST on low vol confirmed. Await UTAD or SOW for entry.';
    else if(hasARd)    note='AR after BC. Distribution range forming. Await ST.';
    else if(hasBC)     note='Buying Climax — potential top. Watch for AR then ST.';
    else               note='PSY detected — advance weakening. Distribution may be starting.';
  }

  return{
    detected:true, phase, stage:cs, confidence, bias,
    events:domEvents.slice(0,5), allEvents:events,
    rangeHigh, rangeLow, rangeSize,
    springDetected:hasSpring, utadDetected:hasUTAD,
    inRange:price>=rangeLow-aV*0.5&&price<=rangeHigh+aV*0.5,
    nearLow:price<=rangeLow+rangeSize*0.3,
    nearHigh:price>=rangeHigh-rangeSize*0.3,
    accumScore, distScore:dScore,
    label:`${bias==='bullish'?'\uD83C\uDFE6':'\uD83C\uDFDA'} Wyckoff ${phase.charAt(0).toUpperCase()+phase.slice(1)} — ${cs||'forming'} · ${confidence}% confidence`,
    note,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   PREMIUM / DISCOUNT ZONES (ICT Concept)
   50% of the current impulse swing = "Fair Value" or equilibrium
   Above 50% = Premium (expensive — look for shorts)
   Below 50% = Discount (cheap — look for longs)
   OTE zone (61.8–78.6%) = optimal retracement for entries
   ═══════════════════════════════════════════════════════════════════ */
function calcPremiumDiscount(H, L, C, atr) {
  if (!H || H.length < 20) return null;
  const lb    = Math.min(H.length - 1, 60);
  const aV    = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const price = C[C.length - 1];

  const recentH = H.slice(-lb), recentL = L.slice(-lb);
  const swingHigh = Math.max(...recentH);
  const swingLow  = Math.min(...recentL);
  const range     = swingHigh - swingLow;

  if (range < aV * 2) return null; // range too small

  const equilibrium = swingLow + range * 0.5;           // 50%
  const discountMax = swingLow + range * 0.382;          // 38.2% — deep discount
  const premiumMin  = swingLow + range * 0.618;          // 61.8% — premium zone
  const oteDiscount = swingLow + range * 0.236;          // 23.6% below = extreme discount
  const otePremium  = swingLow + range * 0.764;          // 76.4% above = extreme premium

  const pctInRange  = range > 0 ? (price - swingLow) / range : 0.5;

  let zone, zoneColor, zoneLabel;
  if (pctInRange >= 0.764) {
    zone = 'extreme_premium'; zoneColor = '#ff3d5a';
    zoneLabel = '🔴 Extreme Premium (76.4%+) — highly overvalued, short bias';
  } else if (pctInRange >= 0.618) {
    zone = 'premium'; zoneColor = '#fbbf24';
    zoneLabel = '🟡 Premium Zone (61.8%+) — avoid longs, look for shorts';
  } else if (pctInRange >= 0.5) {
    zone = 'fair_value_high'; zoneColor = '#94a3b8';
    zoneLabel = '⚪ Slightly Above Fair Value — neutral to mild short bias';
  } else if (pctInRange >= 0.382) {
    zone = 'fair_value_low'; zoneColor = '#94a3b8';
    zoneLabel = '⚪ Slightly Below Fair Value — neutral to mild long bias';
  } else if (pctInRange >= 0.236) {
    zone = 'discount'; zoneColor = '#fbbf24';
    zoneLabel = '🟡 Discount Zone (23.6–38.2%) — avoid shorts, look for longs';
  } else {
    zone = 'extreme_discount'; zoneColor = '#00ff88';
    zoneLabel = '🟢 Extreme Discount (<23.6%) — highly undervalued, long bias';
  }

  const inDiscount = pctInRange < 0.5;
  const inPremium  = pctInRange >= 0.5;

  return {
    swingHigh, swingLow, range, equilibrium,
    discountMax, premiumMin, oteDiscount, otePremium,
    pctInRange: +(pctInRange * 100).toFixed(1),
    zone, zoneColor, zoneLabel,
    inDiscount, inPremium,
    fairValue: equilibrium,
    distFromFair: ((price - equilibrium) / equilibrium * 100).toFixed(2),
    bias: pctInRange < 0.382 ? 'strong_long' : pctInRange < 0.5 ? 'mild_long' : pctInRange > 0.764 ? 'strong_short' : 'mild_short',
  };
}


/* ═══════════════════════════════════════════════════════════════════
   HARMONIC PATTERNS — Gartley, Bat, Crab, Butterfly, Cypher, Shark
   Uses XABCD swing legs with precise Fibonacci ratio validation
   PRZ (Potential Reversal Zone) = highest precision entry area
   ═══════════════════════════════════════════════════════════════════ */
const HARMONIC_PATTERNS = {
  Gartley: {
    XAB: [0.618, 0.618],       // B = 61.8% of XA
    ABC: [0.382, 0.886],       // C = 38.2–88.6% of AB
    BCD: [1.272, 1.618],       // D = 127.2–161.8% of BC
    XAD: [0.786, 0.786],       // D = 78.6% of XA (PRZ)
    tol: 0.06,
    label: 'Gartley', color: '#a78bfa', strength: 4,
  },
  Bat: {
    XAB: [0.382, 0.50],
    ABC: [0.382, 0.886],
    BCD: [1.618, 2.618],
    XAD: [0.886, 0.886],
    tol: 0.06,
    label: 'Bat', color: '#00d4ff', strength: 4,
  },
  Crab: {
    XAB: [0.382, 0.618],
    ABC: [0.382, 0.886],
    BCD: [2.24, 3.618],
    XAD: [1.618, 1.618],
    tol: 0.07,
    label: 'Crab', color: '#ff3d5a', strength: 5,
  },
  Butterfly: {
    XAB: [0.786, 0.786],
    ABC: [0.382, 0.886],
    BCD: [1.618, 2.618],
    XAD: [1.27, 1.618],
    tol: 0.07,
    label: 'Butterfly', color: '#fbbf24', strength: 4,
  },
  Cypher: {
    XAB: [0.382, 0.618],
    ABC: [1.13, 1.414],
    BCD: [0.786, 0.786],       // D = 78.6% retrace of XC
    XAD: [0.786, 0.786],
    tol: 0.07,
    label: 'Cypher', color: '#00ff88', strength: 4,
  },
  Shark: {
    XAB: [0.446, 0.618],
    ABC: [1.13, 1.618],
    BCD: [0.886, 1.13],
    XAD: [0.886, 1.13],
    tol: 0.08,
    label: 'Shark', color: '#fb923c', strength: 3,
  },
};

function inRange(val, lo, hi, tol) {
  return val >= lo - tol && val <= hi + tol;
}

function detectHarmonicPatterns(H, L, C, atr) {
  const result = { detected: false, patterns: [], bestPattern: null, przZone: null };
  if (!H || H.length < 20) return result;

  const aV    = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const price = C[C.length - 1];
  const lb    = Math.min(H.length - 2, 100);

  // Get confirmed swing points
  const swings = [];
  for (let i = 2; i < lb - 2; i++) {
    const idx = H.length - 1 - i;
    if (idx < 2) continue;
    if (H[idx] > H[idx-1] && H[idx] > H[idx-2] && H[idx] >= H[idx+1] && H[idx] >= H[idx+2])
      swings.push({ type: 'H', price: H[idx], idx, age: i });
    if (L[idx] < L[idx-1] && L[idx] < L[idx-2] && L[idx] <= L[idx+1] && L[idx] <= L[idx+2])
      swings.push({ type: 'L', price: L[idx], idx, age: i });
  }
  swings.sort((a, b) => a.idx - b.idx);

  // Deduplicate consecutive same-type
  const pts = [];
  for (const s of swings) {
    const last = pts[pts.length - 1];
    if (!last || last.type !== s.type) pts.push(s);
    else if (s.type === 'H' && s.price > last.price) pts[pts.length-1] = s;
    else if (s.type === 'L' && s.price < last.price) pts[pts.length-1] = s;
  }

  if (pts.length < 5) return result;
  const found = [];

  // Try each set of 5 consecutive alternating swings as XABCD
  for (let i = 0; i <= pts.length - 5; i++) {
    const [X, A, B, C2, D] = pts.slice(i, i + 5);
    // Must be alternating H/L
    const types = [X,A,B,C2,D].map(p => p.type).join('');
    if (types !== 'LHLHL' && types !== 'HLHLH') continue;

    const isBull = types === 'LHLHL'; // LONG setup (bullish reversal at D)

    const xaLen  = Math.abs(A.price - X.price);
    const abLen  = Math.abs(B.price - A.price);
    const bcLen  = Math.abs(C2.price - B.price);
    const cdLen  = Math.abs(D.price - C2.price);
    const xdLen  = Math.abs(D.price - X.price);
    if (!xaLen || !abLen || !bcLen || !cdLen) continue;

    const xabR = abLen / xaLen;
    const abcR = bcLen / abLen;
    const bcdR = cdLen / bcLen;
    const xadR = xdLen / xaLen;

    for (const [name, pat] of Object.entries(HARMONIC_PATTERNS)) {
      const t = pat.tol;
      if (!inRange(xabR, pat.XAB[0], pat.XAB[1], t)) continue;
      if (!inRange(abcR, pat.ABC[0], pat.ABC[1], t)) continue;
      if (!inRange(bcdR, pat.BCD[0], pat.BCD[1], t)) continue;
      if (!inRange(xadR, pat.XAD[0], pat.XAD[1], t)) continue;

      // Score precision: closer to ideal = higher score
      const xabIdeal = (pat.XAB[0] + pat.XAB[1]) / 2;
      const xadIdeal = (pat.XAD[0] + pat.XAD[1]) / 2;
      const precision = 100 - (Math.abs(xabR - xabIdeal) + Math.abs(xadR - xadIdeal)) * 100;

      // PRZ: D point ± ATR buffer
      const przLow  = D.price - aV * 0.5;
      const przHigh = D.price + aV * 0.5;
      const priceInPRZ = price >= przLow && price <= przHigh;
      const nearPRZ    = Math.abs(price - D.price) / price < 0.015;

      found.push({
        name, pattern: pat,
        X: X.price, A: A.price, B: B.price, C: C2.price, D: D.price,
        isBull,
        precision: Math.max(0, Math.round(precision)),
        przLow, przHigh, priceInPRZ, nearPRZ,
        age: pts.length - 1 - (i + 4),
        label: `${isBull ? '🟢' : '🔴'} ${name} ${isBull ? 'Bull' : 'Bear'} — D: ${D.price.toFixed(4)} · PRZ precision: ${Math.max(0,Math.round(precision))}%`,
        bias: isBull ? 'bullish' : 'bearish',
        strength: pat.strength,
        color: pat.color,
        // SL: beyond X for bull, below X for bear
        sl: isBull ? X.price - aV * 0.3 : X.price + aV * 0.3,
        // TP targets from D
        tp1: isBull ? D.price + Math.abs(D.price - C2.price) * 0.382
                    : D.price - Math.abs(D.price - C2.price) * 0.382,
        tp2: isBull ? D.price + Math.abs(D.price - A.price) * 0.618
                    : D.price - Math.abs(D.price - A.price) * 0.618,
      });
    }
  }

  if (!found.length) return result;
  found.sort((a, b) => b.precision - a.precision || a.age - b.age);
  const best = found[0];

  return {
    detected: true,
    patterns: found.slice(0, 3),
    bestPattern: best,
    przZone: { low: best.przLow, high: best.przHigh, mid: best.D },
    priceInPRZ: best.priceInPRZ,
    nearPRZ: best.nearPRZ,
    bias: best.bias,
    label: best.label,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   CVD — Cumulative Volume Delta + Delta Divergence
   Buy volume - Sell volume, cumulative
   Positive + price rising = real institutional buying
   Negative + price rising = distribution (smart money selling)
   Uses Taker buy/sell ratio × total volume per bar
   ═══════════════════════════════════════════════════════════════════ */
function calcCVD(O, H, L, C, V, takerRatio) {
  if (!V || V.length < 20) return null;
  const n = V.length;

  // Approximate delta per bar using taker ratio if available
  // Fallback: use candle direction as proxy
  const deltas = [];
  for (let i = 0; i < n; i++) {
    let buyVol, sellVol;
    // Best estimate: if taker series available use it, else use candle body proportion
    const isBull = C[i] > O[i];
    const range  = H[i] - L[i];
    const body   = Math.abs(C[i] - O[i]);
    const bodyRatio = range > 0 ? body / range : 0.5;
    // Bull bar: more buy vol; bear bar: more sell vol
    // Approximation: (0.5 + bodyRatio/2) of volume is market direction
    buyVol  = isBull ? V[i] * (0.5 + bodyRatio * 0.4) : V[i] * (0.5 - bodyRatio * 0.4);
    sellVol = V[i] - buyVol;
    deltas.push(buyVol - sellVol);
  }

  // CVD = cumulative sum of deltas
  const cvd = [];
  let cum = 0;
  for (const d of deltas) { cum += d; cvd.push(cum); }

  const last20cvd = cvd.slice(-20);
  const cvdNow    = cvd[cvd.length - 1];
  const cvd5ago   = cvd[Math.max(0, cvd.length - 6)];
  const cvd20ago  = cvd[Math.max(0, cvd.length - 21)];
  const price     = C[C.length - 1];
  const price5ago = C[Math.max(0, C.length - 6)];
  const price20ago= C[Math.max(0, C.length - 21)];

  // CVD trend: rising = net buying pressure
  const cvdRising = cvdNow > cvd5ago;
  const cvdFalling = cvdNow < cvd5ago;

  // Delta Divergence detection
  let divergence = null;
  // Bullish divergence: price lower, CVD higher → hidden buying
  if (price < price20ago && cvdNow > cvd20ago && (cvdNow - cvd20ago) > Math.abs(cvd20ago) * 0.05) {
    divergence = {
      type: 'bullish', strength: 'strong',
      label: '🟢 CVD Bullish Divergence — price down, buy volume up (institutional accumulation)',
    };
  }
  // Bearish divergence: price higher, CVD lower → hidden selling
  else if (price > price20ago && cvdNow < cvd20ago && (cvd20ago - cvdNow) > Math.abs(cvd20ago) * 0.05) {
    divergence = {
      type: 'bearish', strength: 'strong',
      label: '🔴 CVD Bearish Divergence — price up, sell volume up (institutional distribution)',
    };
  }
  // Moderate divergences (5-bar)
  else if (price < price5ago && cvdNow > cvd5ago) {
    divergence = {
      type: 'bullish', strength: 'moderate',
      label: '🟡 CVD Mild Bull Div — short-term buying pressure building',
    };
  }
  else if (price > price5ago && cvdNow < cvd5ago) {
    divergence = {
      type: 'bearish', strength: 'moderate',
      label: '🟡 CVD Mild Bear Div — short-term selling pressure building',
    };
  }

  // Absorption detection: large volume but small price move (CVD flat)
  const recentVol   = V.slice(-3).reduce((a,b)=>a+b,0)/3;
  const avgVol      = V.slice(-20).reduce((a,b)=>a+b,0)/20;
  const cvdChange   = Math.abs(cvdNow - cvd5ago);
  const absorption  = recentVol > avgVol * 2 && cvdChange < avgVol * 0.3;

  return {
    cvd: cvd.slice(-50),
    cvdNow, cvdRising, cvdFalling,
    divergence,
    absorption,
    absorptionBias: absorption ? (cvdNow > 0 ? 'bullish' : 'bearish') : null,
    bullScore: cvdRising ? (divergence?.type==='bullish' ? 18 : 8) : 0,
    bearScore: cvdFalling ? (divergence?.type==='bearish' ? 18 : 8) : 0,
    label: divergence ? divergence.label : cvdRising ? '📈 CVD Rising (net buying)' : cvdFalling ? '📉 CVD Falling (net selling)' : '〰 CVD Neutral',
  };
}

/* ═══════════════════════════════════════════════════════════════════
   CME GAP DETECTION (Bitcoin CME Futures)
   CME trades Mon–Fri (closes Fri 4PM CT, opens Sun 5PM CT)
   Weekend price moves leave gaps → powerful price magnets
   ~80% of CME gaps get filled eventually
   ═══════════════════════════════════════════════════════════════════ */
async function detectCMEGaps(symbol, price) {
  // Only applies to BTC (and ETH on CME)
  if (!symbol.includes('BTC') && !symbol.includes('ETH')) return null;
  try {
    // Fetch daily candles to look for weekend gaps
    const kl = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=30`
    ).then(r => r.json());
    if (!Array.isArray(kl) || kl.length < 7) return null;

    const gaps = [];
    // CME opens Sunday 5PM CT (23:00 UTC)
    // Detect gap: Monday open vs Friday close
    for (let i = 6; i < kl.length - 1; i++) {
      const bar       = { o: parseFloat(kl[i][1]), h: parseFloat(kl[i][2]), l: parseFloat(kl[i][3]), c: parseFloat(kl[i][4]) };
      const prev      = { o: parseFloat(kl[i-1][1]), c: parseFloat(kl[i-1][4]) };
      const openTime  = new Date(kl[i][0]);
      const dayOfWeek = openTime.getUTCDay(); // 1 = Monday

      // Monday bar: check gap from Friday close
      if (dayOfWeek === 1) {
        const gapUp   = bar.o > prev.c * 1.001; // opened above Friday close
        const gapDown = bar.o < prev.c * 0.999; // opened below Friday close
        if (gapUp || gapDown) {
          const gapSize = Math.abs(bar.o - prev.c);
          const gapPct  = gapSize / prev.c * 100;
          if (gapPct >= 0.15) { // minimum 0.15% gap to be meaningful
            const gapHigh = Math.max(bar.o, prev.c);
            const gapLow  = Math.min(bar.o, prev.c);
            const filled  = kl.slice(i+1).some(k =>
              parseFloat(k[2]) >= gapLow && parseFloat(k[3]) <= gapHigh
            );
            if (!filled) {
              const distPct = Math.abs(price - (gapHigh + gapLow) / 2) / price * 100;
              gaps.push({
                type:       gapUp ? 'gap_up' : 'gap_down',
                gapHigh, gapLow,
                mid:        (gapHigh + gapLow) / 2,
                gapPct:     +gapPct.toFixed(2),
                distPct:    +distPct.toFixed(2),
                date:       openTime.toDateString(),
                filled:     false,
                magnet:     distPct < 5,  // within 5% = active magnet
                label:      `${gapUp ? '⬆' : '⬇'} CME Gap ${gapUp?'Up':'Down'} ${gapPct.toFixed(2)}% — ${openTime.toDateString()} (UNFILLED)`,
                bias:       gapUp ? 'bearish' : 'bullish', // gap up = bearish pull (price goes down to fill), gap down = bullish pull
              });
            }
          }
        }
      }
    }

    if (!gaps.length) return { detected: false, gaps: [] };
    // Sort by distance
    gaps.sort((a, b) => a.distPct - b.distPct);
    const nearest = gaps[0];
    return {
      detected:    true,
      gaps:        gaps.slice(0, 3),
      nearestGap:  nearest,
      magnetActive: nearest.magnet,
      label:       nearest.label,
      note: `CME gaps act as price magnets — ~80% historically get filled. ${nearest.magnet ? 'This gap is an ACTIVE magnet (within 5%).' : ''}`,
    };
  } catch (_) { return null; }
}

/* ═══════════════════════════════════════════════════════════════════
   UNMITIGATED ORDER BLOCKS & FVGs
   OBs/FVGs price has NEVER returned to = strongest levels
   "Fresh" = untested = full institutional order still sitting there
   ═══════════════════════════════════════════════════════════════════ */
function filterUnmitigated(mtfOBs, mtfFVGs, H, L, C) {
  const price = C[C.length - 1];
  const result = { unmitOBs: [], unmitFVGs: [], nearestUnmitBull: null, nearestUnmitBear: null };

  if (mtfOBs) {
    const allOBs = [...(mtfOBs.bullOBs || []), ...(mtfOBs.bearOBs || [])];
    for (const ob of allOBs) {
      // Check if price has EVER traded through OB zone since creation
      const startIdx = ob.barIdx !== undefined ? ob.barIdx : 0;
      const traded = H.slice(startIdx).some((h, i) =>
        h >= ob.low && L[startIdx + i] <= ob.high
      );
      if (!traded) {
        result.unmitOBs.push({ ...ob, fresh: true, distPct: Math.abs(price - ob.mid) / price * 100 });
      }
    }
    result.unmitOBs.sort((a, b) => a.distPct - b.distPct);
    result.nearestUnmitBull = result.unmitOBs.filter(o => o.type === 'bull' && o.mid < price)[0] || null;
    result.nearestUnmitBear = result.unmitOBs.filter(o => o.type === 'bear' && o.mid > price)[0] || null;
  }

  if (mtfFVGs) {
    const allFVGs = [...(mtfFVGs.bullFVGs || []), ...(mtfFVGs.bearFVGs || [])];
    for (const fvg of allFVGs) {
      const filled = H.some((h, i) => h >= fvg.low && L[i] <= fvg.high);
      if (!filled) {
        result.unmitFVGs.push({ ...fvg, fresh: true, distPct: Math.abs(price - (fvg.high + fvg.low) / 2) / price * 100 });
      }
    }
    result.unmitFVGs.sort((a, b) => a.distPct - b.distPct);
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════
   MARKET PROFILE LITE — POC, VAH, VAL
   Approximate Point of Control using price clustering
   High volume nodes = where most trading happened = magnets
   ═══════════════════════════════════════════════════════════════════ */
function calcMarketProfile(H, L, C, V, atr) {
  if (!H || H.length < 20 || !V) return null;
  const aV     = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const price  = C[C.length - 1];
  const lb     = Math.min(H.length, 48); // ~2 days on 1H
  const bucket = aV * 0.5; // cluster width

  const recentH = H.slice(-lb), recentL = L.slice(-lb), recentV = V.slice(-lb);
  const rangeHigh = Math.max(...recentH);
  const rangeLow  = Math.min(...recentL);
  const range     = rangeHigh - rangeLow;
  if (range < aV) return null;

  // Build price-volume profile (weighted by volume)
  const profile = {}; // bucket → volume
  for (let i = 0; i < lb; i++) {
    const barRange = recentH[i] - recentL[i];
    if (barRange <= 0) continue;
    const nBuckets = Math.max(1, Math.round(barRange / bucket));
    const volPerBucket = recentV[i] / nBuckets;
    for (let j = 0; j <= nBuckets; j++) {
      const levelPrice = recentL[i] + (barRange / nBuckets) * j;
      const key = Math.round(levelPrice / bucket) * bucket;
      profile[key] = (profile[key] || 0) + volPerBucket;
    }
  }

  // Find POC (highest volume bucket)
  let pocPrice = null, pocVol = 0;
  for (const [k, v] of Object.entries(profile)) {
    if (v > pocVol) { pocVol = v; pocPrice = parseFloat(k); }
  }
  if (!pocPrice) return null;

  // Value Area: 70% of total volume around POC
  const totalVol  = Object.values(profile).reduce((a, b) => a + b, 0);
  const vaTarget  = totalVol * 0.70;
  const sorted    = Object.entries(profile).sort(([a],[b]) => parseFloat(b) - parseFloat(a));
  let   vaVol     = pocVol, vah = pocPrice, val = pocPrice;

  for (const [k, v] of sorted) {
    const p = parseFloat(k);
    vaVol += v;
    if (p > vah) vah = p;
    if (p < val) val = p;
    if (vaVol >= vaTarget) break;
  }

  const abovePOC = price > pocPrice;
  const inVA     = price >= val && price <= vah;
  const distPOC  = ((price - pocPrice) / pocPrice * 100).toFixed(2);

  return {
    poc:         pocPrice,
    vah,
    val,
    rangeHigh,
    rangeLow,
    abovePOC,
    inValueArea: inVA,
    distPOC:     +distPOC,
    pocMagnet:   Math.abs(+distPOC) < 1.5,
    label:       `POC: ${pocPrice.toFixed(4)} · VAH: ${vah.toFixed(4)} · VAL: ${val.toFixed(4)}`,
    bias:        abovePOC ? 'bearish_pull' : 'bullish_pull', // price tends to revert to POC
    note:        `Price is ${Math.abs(+distPOC).toFixed(2)}% ${abovePOC ? 'above' : 'below'} POC. ${Math.abs(+distPOC) < 1.5 ? 'At POC — expect balance.' : 'POC acts as magnet.'}`,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   MTF DIVERGENCE STACKING
   Same divergence across multiple timeframes = exponentially stronger
   1H div alone: moderate. 1H + 4H div: strong. 1H + 4H + 1D: very strong
   ═══════════════════════════════════════════════════════════════════ */
function calcMTFDivergence(C1h, rsi1h, C4h, rsi4h, C1d, rsi1d, obv1h) {
  const lb = 40;
  const divs = [];

  const detectDiv = (prices, indicator, label) => {
    if (!prices || !indicator || prices.length < lb) return null;
    const n  = prices.length;
    const p  = prices.slice(-lb);
    const ind = indicator.slice(-lb);
    // Find recent swing (last 5–20 bars)
    const pNow = p[p.length-1], pPrev = Math.min(...p.slice(-20, -5));
    const iNow = ind[ind.length-1], iPrev = ind[ind.indexOf(Math.min(...p.slice(-20,-5).map((_,i)=>p.slice(-20,-5)[i])))] || iNow;

    const regularBull = pNow < pPrev && iNow > iPrev;
    const regularBear = pNow > pPrev && iNow < iPrev;
    if (regularBull) return { type:'bullish', kind:'regular', label:`Bull Div (${label})` };
    if (regularBear) return { type:'bearish', kind:'regular', label:`Bear Div (${label})` };
    return null;
  };

  const d1h = detectDiv(C1h, rsi1h, 'RSI 1H');
  const d4h = detectDiv(C4h, rsi4h, 'RSI 4H');
  const d1d = detectDiv(C1d, rsi1d, 'RSI 1D');
  const dObv = obv1h ? detectDiv(C1h, obv1h, 'OBV 1H') : null;

  if (d1h) divs.push({ ...d1h, tf: '1H', weight: 1 });
  if (d4h) divs.push({ ...d4h, tf: '4H', weight: 2 });
  if (d1d) divs.push({ ...d1d, tf: '1D', weight: 4 });
  if (dObv) divs.push({ ...dObv, tf: 'OBV', weight: 1 });

  const bullDivs = divs.filter(d => d.type === 'bullish');
  const bearDivs = divs.filter(d => d.type === 'bearish');
  const bullWeight = bullDivs.reduce((s, d) => s + d.weight, 0);
  const bearWeight = bearDivs.reduce((s, d) => s + d.weight, 0);
  const stackCount = divs.length;

  let stackLabel = null, stackBias = null;
  if (bullWeight >= 3) {
    stackBias = 'bullish';
    stackLabel = `🟢 MTF Divergence Stack (${bullDivs.map(d=>d.tf).join('+')} bull div) — ${bullWeight >= 6 ? 'VERY STRONG' : bullWeight >= 3 ? 'STRONG' : 'MODERATE'}`;
  } else if (bearWeight >= 3) {
    stackBias = 'bearish';
    stackLabel = `🔴 MTF Divergence Stack (${bearDivs.map(d=>d.tf).join('+')} bear div) — ${bearWeight >= 6 ? 'VERY STRONG' : bearWeight >= 3 ? 'STRONG' : 'MODERATE'}`;
  }

  return {
    divs,
    bullDivs, bearDivs,
    bullWeight, bearWeight,
    stackBias, stackLabel,
    detected: bullWeight >= 2 || bearWeight >= 2,
    // Scoring: each weight unit = 5pts, max 30pts
    bullScore: Math.min(bullWeight * 5, 30),
    bearScore: Math.min(bearWeight * 5, 30),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   SETUP TYPE CLASSIFIER
   Determines optimal strategy type and adjusts TP/SL ratios
   Mean Reversion: fade the extreme move
   Trend Follow: ride the momentum
   Breakout: momentum entry after consolidation
   ═══════════════════════════════════════════════════════════════════ */
function classifySetupType(adx, bb, atr, rsi, premDisc, regime, wyckoff, liqSweeps, bos, candlePatterns, vol) {
  const scores = { meanReversion: 0, trendFollow: 0, breakout: 0 };

  // ADX: high = trend, low = mean reversion
  if (adx) {
    if (adx.adx >= 35) scores.trendFollow += 25;
    else if (adx.adx >= 25) scores.trendFollow += 15;
    else if (adx.adx < 20) scores.meanReversion += 20;
    else scores.meanReversion += 8;
  }

  // BB: extreme position = mean reversion, middle = breakout potential
  if (bb) {
    if (bb.position <= 0.10 || bb.position >= 0.90) scores.meanReversion += 20;
    else if (bb.width < 0.03) scores.breakout += 25; // tight squeeze → breakout
    else if (bb.position >= 0.40 && bb.position <= 0.60) scores.trendFollow += 10;
  }

  // RSI extremes = mean reversion
  if (rsi !== undefined) {
    if (rsi <= 25 || rsi >= 75) scores.meanReversion += 18;
    else if (rsi <= 35 || rsi >= 65) scores.meanReversion += 8;
    else scores.trendFollow += 6;
  }

  // Premium/Discount: extreme = mean reversion
  if (premDisc) {
    if (premDisc.zone === 'extreme_premium' || premDisc.zone === 'extreme_discount') scores.meanReversion += 15;
    else if (premDisc.zone === 'fair_value_high' || premDisc.zone === 'fair_value_low') scores.trendFollow += 10;
  }

  // Regime
  if (regime) {
    if (regime.isTrending) scores.trendFollow += 20;
    if (regime.isRanging)  scores.meanReversion += 20;
    if (regime.isVolatile) scores.breakout += 15;
  }

  // Wyckoff SOS/LPS = trend follow; SC/BC = mean reversion
  if (wyckoff?.detected) {
    if (['SOS','LPS','SOW'].includes(wyckoff.stage)) scores.trendFollow += 15;
    if (['SC','BC'].includes(wyckoff.stage))          scores.meanReversion += 15;
    if (['Spring','UTAD'].includes(wyckoff.stage))    scores.breakout += 20;
  }

  // Liquidity sweep = mean reversion (fade the sweep)
  if (liqSweeps?.bullSweep || liqSweeps?.bearSweep) scores.meanReversion += 12;

  // BOS = trend follow
  if (bos?.type) scores.trendFollow += 10;

  // Candle pattern strength
  if (candlePatterns) {
    const maxStr = Math.max(candlePatterns.bullScore, candlePatterns.bearScore);
    if (maxStr >= 4) { scores.trendFollow += 8; scores.breakout += 5; }
  }

  // Volume context
  if (vol) {
    const volRatio = vol.ratio || 1;
    if (volRatio >= 2.5) scores.breakout += 15;
    else if (volRatio <= 0.5) scores.meanReversion += 10;
  }

  // Find winner
  const types = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestType, bestScore] = types[0];
  const [secondType, secondScore] = types[1];
  const clarity = bestScore - secondScore; // how decisive the classification is

  // TP/SL multipliers per type
  const typeConfig = {
    meanReversion: {
      label: '↩ Mean Reversion',
      icon:  '↩',
      color: '#a78bfa',
      tp1R:  0.8,  tp2R: 1.5,  slR: 1.0,
      note:  'Fade the extreme. Tighter targets. Quick scalp to equilibrium.',
    },
    trendFollow: {
      label: '📈 Trend Following',
      icon:  '📈',
      color: '#00ff88',
      tp1R:  1.5,  tp2R: 3.0,  slR: 1.0,
      note:  'Ride the momentum. Wide TP2. Trail SL after TP1.',
    },
    breakout: {
      label: '⚡ Breakout',
      icon:  '⚡',
      color: '#fbbf24',
      tp1R:  2.0,  tp2R: 5.0,  slR: 1.0,
      note:  'Momentum entry. Very wide targets. Move SL to BE after TP1 quickly.',
    },
  };

  return {
    type:    bestType,
    config:  typeConfig[bestType],
    scores,
    clarity,
    confident: clarity >= 15,
    label:   `${typeConfig[bestType].icon} ${typeConfig[bestType].label} Setup`,
    note:    typeConfig[bestType].note,
    // Round number levels (used in entry precision)
    allTypes: types,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ROUND NUMBER LEVELS
   Psychological price magnets: $0.001, $0.01, $0.1, $1, $10, $100...
   Also: 0.5 sub-levels (strong) and 0.25 (minor)
   ═══════════════════════════════════════════════════════════════════ */
function calcRoundLevels(price, atr) {
  const aV     = atr ? atr.atr : price * 0.01;
  const levels = [];

  // Find magnitude: 10^n nearest to price
  const mag = Math.pow(10, Math.floor(Math.log10(price)));

  // Major levels (1× mag)
  for (let m = -2; m <= 3; m++) {
    const base = mag * Math.pow(10, m);
    for (const mult of [0.25, 0.5, 1, 2, 2.5, 5]) {
      const lvl = Math.round(price / (base * mult)) * (base * mult);
      const dist = Math.abs(lvl - price);
      const strength = mult === 1 ? 'major' : (mult === 0.5 || mult === 2) ? 'semi' : 'minor';
      if (dist < aV * 8 && dist > 0) {
        levels.push({
          price:     lvl,
          dist,
          distPct:   +((lvl - price) / price * 100).toFixed(2),
          strength,
          label:     `${strength === 'major' ? '🔵' : strength === 'semi' ? '⚪' : '·'} Round Level ${lvl}`,
        });
      }
    }
  }

  levels.sort((a, b) => a.dist - b.dist);
  const nearest = levels[0] || null;
  const inRange = nearest && nearest.dist < aV * 1.5;

  return { levels: levels.slice(0, 6), nearest, inRange };
}


/* ═══════════════════════════════════════════════════════════════════
   ICT-CRT — CANDLE RANGE THEORY (2-Candle Setup)
   The reference candle (RC) defines the range.
   Next candle raids one extreme then reverses through mid → entry
   CRT = manipulation of one side + delivery to other side
   ═══════════════════════════════════════════════════════════════════ */
function detectCRT(O, H, L, C, atr) {
  const result = { detected: false, bias: null, confidence: 0, label: null, entry: null, sl: null };
  if (!O || O.length < 5) return result;
  const aV = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const price = C[C.length - 1];

  // Check last 3 bars: RC=reference, Raid=manipulation, Current=delivery
  for (let offset = 1; offset <= 4; offset++) {
    const rcIdx   = O.length - 2 - offset;
    const raidIdx = O.length - 1 - offset + 1;
    const curIdx  = O.length - 1;
    if (rcIdx < 0 || raidIdx < 0) continue;

    const rc   = { h: H[rcIdx],   l: L[rcIdx],   c: C[rcIdx],   o: O[rcIdx]   };
    const raid = { h: H[raidIdx], l: L[raidIdx], c: C[raidIdx], o: O[raidIdx] };
    const cur  = { h: H[curIdx],  l: L[curIdx],  c: C[curIdx],  o: O[curIdx]  };

    const rcRange = rc.h - rc.l;
    if (rcRange < aV * 0.5) continue; // RC must be meaningful size

    const rcMid = (rc.h + rc.l) / 2;

    // BULLISH CRT: Raid raids below RC low (stop hunt), then close above RC mid
    const raidedLow  = raid.l < rc.l - aV * 0.05 && raid.c > rc.l; // raided low then closed back above
    const deliverUp  = cur.c > rcMid; // current delivering up through midpoint
    if (raidedLow && deliverUp) {
      const conf = 55 + (raid.c > rc.l ? 15 : 0) + (cur.c > rc.h * 0.995 ? 15 : 0);
      return {
        detected: true, bias: 'bullish', confidence: Math.min(conf, 90),
        rcHigh: rc.h, rcLow: rc.l, rcMid,
        entry: rcMid,
        sl: rc.l - aV * 0.2,
        tp1: rc.h, tp2: rc.h + (rc.h - rc.l) * 0.618,
        label: `🟢 CRT Bull — Low raided (${rc.l.toFixed(4)}), delivering above mid (${rcMid.toFixed(4)})`,
        note: 'Classic 2-candle CRT. RC low swept → buy above mid for delivery to RC high.',
      };
    }

    // BEARISH CRT: Raid raids above RC high, then close below RC mid
    const raidedHigh = raid.h > rc.h + aV * 0.05 && raid.c < rc.h;
    const deliverDn  = cur.c < rcMid;
    if (raidedHigh && deliverDn) {
      const conf = 55 + (raid.c < rc.h ? 15 : 0) + (cur.c < rc.l * 1.005 ? 15 : 0);
      return {
        detected: true, bias: 'bearish', confidence: Math.min(conf, 90),
        rcHigh: rc.h, rcLow: rc.l, rcMid,
        entry: rcMid,
        sl: rc.h + aV * 0.2,
        tp1: rc.l, tp2: rc.l - (rc.h - rc.l) * 0.618,
        label: `🔴 CRT Bear — High raided (${rc.h.toFixed(4)}), delivering below mid (${rcMid.toFixed(4)})`,
        note: 'Classic 2-candle CRT. RC high swept → sell below mid for delivery to RC low.',
      };
    }
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════
   SK SYSTEM — AB BC, No AB, Rf Box, DVR, SK High Probability
   SK System concepts from image: AB BC pattern, Rf box,
   DVR (divergence reversal), SK top-down, high probability zones
   ═══════════════════════════════════════════════════════════════════ */
function detectSKSystem(O, H, L, C, V, atr, bos, mtfOBs) {
  const result = { detected: false, bias: null, confidence: 0, highProbability: false, label: null, patterns: [] };
  if (!O || O.length < 20) return result;
  const aV = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const price = C[C.length - 1];
  let conf = 0, bias = null;

  // === AB BC Pattern (2-leg pullback structure) ===
  // A: impulse start, B: end of impulse / start of retrace
  // BC: retrace (38.2–61.8%) → entry at C for continuation
  const lb = Math.min(O.length - 2, 30);
  let abbc = null;
  for (let i = 5; i < lb; i++) {
    const aIdx = O.length - 1 - i;
    const bIdx = O.length - 1 - Math.floor(i/2);
    const cIdx = O.length - 2;
    if (aIdx < 0 || bIdx < 0) continue;
    const abLen = Math.abs(C[bIdx] - C[aIdx]);
    const bcLen = Math.abs(C[cIdx] - C[bIdx]);
    if (!abLen) continue;
    const bcRetrace = bcLen / abLen;
    // BC = 38.2–61.8% of AB (SK optimal zone)
    if (bcRetrace >= 0.382 && bcRetrace <= 0.618) {
      const isBull = C[bIdx] > C[aIdx];
      abbc = { bias: isBull ? 'bullish' : 'bearish', bcRetrace: +bcRetrace.toFixed(3), pts: 20 };
      conf += 20;
      if (!bias) bias = abbc.bias;
      result.patterns.push({ name: 'AB BC', ...abbc, label: `AB BC ${isBull?'Bull':'Bear'} — BC retrace: ${(bcRetrace*100).toFixed(1)}%` });
      break;
    }
  }

  // === Rf Box (Reference Box — consolidation zone before move) ===
  // Tight range (< 0.5 ATR) for 3+ bars then breakout
  let rfBox = null;
  for (let i = 3; i < Math.min(10, lb); i++) {
    const slice = { h: H.slice(-i-3,-i), l: L.slice(-i-3,-i), c: C.slice(-i-3,-i) };
    const boxH = Math.max(...slice.h);
    const boxL = Math.min(...slice.l);
    const boxRange = boxH - boxL;
    if (boxRange < aV * 0.5) {
      // Is current price breaking out of box?
      const breakUp   = price > boxH + aV * 0.05;
      const breakDown = price < boxL - aV * 0.05;
      if (breakUp || breakDown) {
        rfBox = { boxH, boxL, dir: breakUp ? 'bullish' : 'bearish', pts: 14 };
        conf += 14;
        if (!bias) bias = rfBox.dir;
        result.patterns.push({ name: 'Rf Box', ...rfBox, label: `Rf Box ${breakUp?'Bull':'Bear'} breakout — Box: ${boxL.toFixed(4)}–${boxH.toFixed(4)}` });
        break;
      }
    }
  }

  // === DVR — Divergence Reversal (SK version) ===
  // Volume decreasing while price makes new extreme = DVR signal
  let dvr = null;
  if (V && V.length >= 10) {
    const recentV = V.slice(-6);
    const avgV    = recentV.reduce((a,b)=>a+b,0) / recentV.length;
    const lastV   = V[V.length-2];
    const prevV   = V[V.length-3];
    const volDecline = lastV < prevV * 0.75 && lastV < avgV * 0.7;
    const priceExtreme = price > Math.max(...H.slice(-20,-1)) * 0.998 || price < Math.min(...L.slice(-20,-1)) * 1.002;
    if (volDecline && priceExtreme) {
      dvr = { pts: 16, bias: price > C[C.length-10] ? 'bearish' : 'bullish' }; // DVR = reversal
      conf += 16;
      if (!bias) bias = dvr.bias;
      result.patterns.push({ name: 'DVR', ...dvr, label: `DVR — Volume declining at price extreme → reversal signal` });
    }
  }

  // === SK High Probability: multiple SK patterns align ===
  const highProb = result.patterns.length >= 2 && conf >= 35;
  if (highProb) conf += 15;

  // === SK Top-Down: BOS + OB + SK pattern alignment ===
  if (bos?.type === 'bullish' && bias === 'bullish') { conf += 12; }
  if (bos?.type === 'bearish' && bias === 'bearish') { conf += 12; }
  if (mtfOBs?.nearestBullOB && bias === 'bullish') conf += 8;
  if (mtfOBs?.nearestBearOB && bias === 'bearish') conf += 8;

  if (conf < 14 || !bias) return result;

  return {
    detected: true,
    bias,
    confidence: Math.min(conf, 92),
    highProbability: highProb,
    patterns: result.patterns,
    label: `${bias==='bullish'?'🟢':'🔴'} SK System — ${result.patterns.map(p=>p.name).join(' + ')} ${highProb?'(HIGH PROBABILITY)':''}`,
    note: highProb ? 'Multiple SK patterns aligned — highest probability setup.' : 'SK pattern detected — confirm with top-down analysis.',
  };
}

/* ═══════════════════════════════════════════════════════════════════
   IPDA — INTERBANK PRICE DELIVERY ALGORITHM
   ICT concept: price delivers to quarterly, weekly, daily levels
   Key levels: Previous Quarter High/Low, Previous Week High/Low
   Weekly Open, Daily Open — institutional reference points
   ═══════════════════════════════════════════════════════════════════ */
function calcIPDALevels(H, L, C, kl1d, kl4h) {
  if (!kl1d || kl1d.length < 20) return null;
  const price = C[C.length - 1];

  // Daily levels
  const prevDay = kl1d[kl1d.length - 2];
  const prevDayH = parseFloat(prevDay[2]);
  const prevDayL = parseFloat(prevDay[3]);
  const prevDayC = parseFloat(prevDay[4]);
  const todayO   = parseFloat(kl1d[kl1d.length-1][1]);

  // Weekly levels (5 trading days)
  const weekBars = kl1d.slice(-7, -2);
  const prevWeekH = weekBars.length ? Math.max(...weekBars.map(k => parseFloat(k[2]))) : null;
  const prevWeekL = weekBars.length ? Math.min(...weekBars.map(k => parseFloat(k[3]))) : null;
  const weekOpenBar = weekBars[0];
  const weeklyOpen = weekOpenBar ? parseFloat(weekOpenBar[1]) : null;

  // Quarterly levels (approx 60 trading days = 3 months)
  const qBars = kl1d.slice(-65, -5);
  const prevQH = qBars.length ? Math.max(...qBars.map(k => parseFloat(k[2]))) : null;
  const prevQL = qBars.length ? Math.min(...qBars.map(k => parseFloat(k[3]))) : null;

  // Check proximity
  const near = (lvl, pct = 0.005) => lvl && Math.abs(price - lvl) / price < pct;
  const atr5 = kl4h ? Math.abs(parseFloat(kl4h[kl4h.length-1][2]) - parseFloat(kl4h[kl4h.length-1][3])) * 2 : price * 0.01;

  const levels = [];
  if (prevDayH) levels.push({ price: prevDayH, label: 'PDH (Prev Day High)', strength: 3, bias: 'bearish' });
  if (prevDayL) levels.push({ price: prevDayL, label: 'PDL (Prev Day Low)', strength: 3, bias: 'bullish' });
  if (prevWeekH) levels.push({ price: prevWeekH, label: 'PWH (Prev Week High)', strength: 4, bias: 'bearish' });
  if (prevWeekL) levels.push({ price: prevWeekL, label: 'PWL (Prev Week Low)', strength: 4, bias: 'bullish' });
  if (prevQH) levels.push({ price: prevQH, label: 'PQH (Prev Quarter High)', strength: 5, bias: 'bearish' });
  if (prevQL) levels.push({ price: prevQL, label: 'PQL (Prev Quarter Low)', strength: 5, bias: 'bullish' });
  if (weeklyOpen) levels.push({ price: weeklyOpen, label: 'Weekly Open', strength: 3, bias: 'neutral' });
  if (todayO) levels.push({ price: todayO, label: 'Daily Open (Today)', strength: 2, bias: 'neutral' });

  // Add dist to each level
  levels.forEach(l => { l.distPct = +((l.price - price) / price * 100).toFixed(2); });
  levels.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));

  const nearestLevel = levels[0] || null;

  return {
    levels,
    nearestLevel,
    prevDayH, prevDayL, prevWeekH, prevWeekL,
    prevQH, prevQL, weeklyOpen, dailyOpen: todayO,
    atQuarterlyHigh: near(prevQH, 0.008),
    atQuarterlyLow:  near(prevQL, 0.008),
    atWeeklyHigh:    near(prevWeekH, 0.006),
    atWeeklyLow:     near(prevWeekL, 0.006),
    nearWeeklyOpen:  near(weeklyOpen, 0.004),
    nearDailyOpen:   near(todayO, 0.003),
    label: nearestLevel ? `IPDA: Nearest — ${nearestLevel.label} (${nearestLevel.distPct > 0 ? '+' : ''}${nearestLevel.distPct}%)` : null,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   PROPULSION BLOCK (ICT-CRT Concept)
   A consolidation/correction block before a strong impulse move.
   When price returns to Propulsion Block = high probability entry
   Similar to OB but specifically after a consolidation + breakout
   ═══════════════════════════════════════════════════════════════════ */
function detectPropulsionBlock(O, H, L, C, atr) {
  const result = { detected: false, bias: null, strength: 0, label: null, high: null, low: null, mid: null };
  if (!O || O.length < 15) return result;
  const aV = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const price = C[C.length - 1];
  const lb = Math.min(O.length - 2, 50);

  for (let i = 5; i < lb - 3; i++) {
    const idx = O.length - 1 - i;
    if (idx < 3) continue;

    // Find tight consolidation (3–5 bars with range < ATR)
    const consH = H.slice(idx-2, idx+1);
    const consL = L.slice(idx-2, idx+1);
    const consRange = Math.max(...consH) - Math.min(...consL);
    if (consRange > aV * 0.8) continue; // not tight enough

    const pbH = Math.max(...consH);
    const pbL = Math.min(...consL);

    // Strong impulse after consolidation
    const impulseIdx = idx + 2;
    if (impulseIdx >= O.length) continue;
    const impMove = Math.abs(C[impulseIdx] - C[idx]);
    if (impMove < aV * 1.5) continue; // impulse not strong enough

    const isBull = C[impulseIdx] > C[idx];

    // Price returning to propulsion block zone
    const inPB = price >= pbL - aV * 0.2 && price <= pbH + aV * 0.2;
    const nearPB = Math.abs(price - (pbH + pbL) / 2) / price < 0.02;

    if ((inPB || nearPB) && i <= 20) { // recent enough
      return {
        detected: true,
        bias: isBull ? 'bullish' : 'bearish',
        strength: impMove / aV >= 3 ? 3 : impMove / aV >= 2 ? 2 : 1,
        high: pbH, low: pbL, mid: (pbH + pbL) / 2,
        inPB, nearPB,
        label: `${isBull?'🟢':'🔴'} Propulsion Block ${isBull?'Bull':'Bear'} — ${pbL.toFixed(4)}–${pbH.toFixed(4)} (${inPB?'PRICE IN PB':'near PB'})`,
        note: 'Price returning to propulsion consolidation zone — high probability continuation entry.',
      };
    }
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════
   FOOTPRINT LITE — Aggressive/Passive Delta
   From image: Aggressive/passive, Delta change, Max delta, Absorption
   Approximated from OHLCV data (no tick data available)
   ═══════════════════════════════════════════════════════════════════ */
function calcFootprintLite(O, H, L, C, V, atr) {
  if (!O || O.length < 10 || !V) return null;
  const aV = atr ? atr.atr : (H[H.length-1] - L[H.length-1]);
  const lb = Math.min(O.length - 1, 10);

  // Calculate delta for each recent bar
  const bars = [];
  for (let i = 1; i <= lb; i++) {
    const idx = O.length - 1 - i;
    if (idx < 0) continue;
    const o = O[idx], h = H[idx], l = L[idx], c = C[idx], v = V[idx];
    const range = h - l || 1;
    const body  = Math.abs(c - o);
    const isBull = c > o;
    // Approximate aggressive delta: bull bar = aggressive buyers, bear = aggressive sellers
    // Aggressive: closing above open (buyers aggressive) / below open (sellers aggressive)
    const bodyRatio = body / range;
    const aggressiveBuy  = isBull ? v * (0.5 + bodyRatio * 0.45) : v * (0.5 - bodyRatio * 0.45);
    const aggressiveSell = v - aggressiveBuy;
    const delta = aggressiveBuy - aggressiveSell;
    bars.push({ delta, aggressiveBuy, aggressiveSell, v, isBull, bodyRatio });
  }

  if (!bars.length) return null;

  // Cumulative delta trend (last 5 bars)
  const recent5 = bars.slice(0, 5);
  const cumDelta = recent5.reduce((s, b) => s + b.delta, 0);
  const maxDelta  = Math.max(...bars.map(b => Math.abs(b.delta)));
  const avgVol    = bars.reduce((s, b) => s + b.v, 0) / bars.length;

  // Aggressive buying: bull bars with high volume + high body ratio
  const aggressiveBuying = recent5.filter(b => b.isBull && b.bodyRatio >= 0.65 && b.v >= avgVol * 1.3).length >= 2;
  // Aggressive selling: bear bars with high volume + high body ratio
  const aggressiveSelling = recent5.filter(b => !b.isBull && b.bodyRatio >= 0.65 && b.v >= avgVol * 1.3).length >= 2;

  // Passive absorption: high volume but small range = passive players absorbing
  const absorption = bars.slice(0, 3).filter(b => b.v >= avgVol * 1.8 && b.bodyRatio < 0.35);
  const passiveAbsorption = absorption.length >= 1
    ? (bars[0].isBull ? 'bear' : 'bull') // passive is opposite of direction = absorbing aggressive orders
    : null;

  // IMB (Imbalance): large single-sided bar leaving gap = aggressive move
  const lastBar = bars[0];
  const imbalance = lastBar && lastBar.bodyRatio >= 0.80 && lastBar.v >= avgVol * 2.0;

  return {
    cumDelta,
    maxDelta,
    aggressiveBuying,
    aggressiveSelling,
    passiveAbsorption,
    imbalance,
    imbalanceBias: imbalance ? (lastBar.isBull ? 'bullish' : 'bearish') : null,
    deltaRising: cumDelta > 0,
    deltaFalling: cumDelta < 0,
    bars: bars.slice(0, 5),
    label: aggressiveBuying
      ? `📈 Aggressive Buyers — high vol bull bars (${recent5.filter(b=>b.isBull&&b.bodyRatio>=0.65).length}/5 bars)`
      : aggressiveSelling
      ? `📉 Aggressive Sellers — high vol bear bars (${recent5.filter(b=>!b.isBull&&b.bodyRatio>=0.65).length}/5 bars)`
      : passiveAbsorption
      ? `⚖ Passive Absorption (${passiveAbsorption === 'bull' ? 'bulls' : 'bears'} absorbing) — high vol, small spread`
      : `〰 Delta Neutral — mixed aggressive/passive flow`,
    note: imbalance ? `IMB detected — ${lastBar.isBull?'bull':'bear'} imbalance bar signals ${lastBar.isBull?'strong buying':'strong selling'} pressure.` : '',
  };
}


/* ═══════════════════════════════════════════════════════════════════
   NEW INDICATORS v7 — IDM, AVWAP, TTM Squeeze, CMF, Ichimoku, Parabolic SAR
   ═══════════════════════════════════════════════════════════════════ */

/* ─── 1. INDUCEMENT (IDM) DETECTION ─── */
function detectInducement(O, H, L, C, atr, mtfOBs, mtfFVGs) {
  if (!O || O.length < 20 || !atr) return null;
  const aV = atr.atr;
  const tol = aV * 0.5;
  const result = { detected: false, bullIDM: [], bearIDM: [], score: 0 };

  // Look at last 30 bars for equal highs/lows (IDM = engineered liquidity)
  const lb = Math.min(O.length - 1, 30);
  const equalHighs = [], equalLows = [];

  for (let i = lb; i >= 3; i--) {
    const idxI = O.length - 1 - i;
    for (let j = i - 2; j >= 1; j--) {
      const idxJ = O.length - 1 - j;
      // Equal highs within 0.3×ATR = engineered liquidity above
      if (Math.abs(H[idxI] - H[idxJ]) < aV * 0.3 && H[idxI] > H[O.length - 1] - aV * 5) {
        equalHighs.push({ price: (H[idxI] + H[idxJ]) / 2, barI: idxI, barJ: idxJ });
      }
      // Equal lows within 0.3×ATR = engineered liquidity below
      if (Math.abs(L[idxI] - L[idxJ]) < aV * 0.3 && L[idxI] < L[O.length - 1] + aV * 5) {
        equalLows.push({ price: (L[idxI] + L[idxJ]) / 2, barI: idxI, barJ: idxJ });
      }
    }
  }

  const curP = C[C.length - 1];

  // Bull IDM: equal lows below price (retail shorts targeted) → near bullish OB/FVG = high prob LONG
  for (const eq of equalLows) {
    const distBelow = curP - eq.price;
    if (distBelow < 0 || distBelow > aV * 8) continue;
    const nearBullOB = mtfOBs?.nearestBullOB
      ? Math.abs(mtfOBs.nearestBullOB.mid - eq.price) < aV * 2
      : false;
    const nearBullFVG = mtfFVGs?.bullFVGs?.some(f => Math.abs((f.high + f.low) / 2 - eq.price) < aV * 2) || false;
    const confluence = (nearBullOB ? 1 : 0) + (nearBullFVG ? 1 : 0);
    result.bullIDM.push({
      liquidityPrice: eq.price,
      confluenceWithOB: nearBullOB,
      confluenceWithFVG: nearBullFVG,
      confluenceScore: confluence,
      label: `📍 Bull IDM @ ${eq.price.toFixed(4)} — equal lows${nearBullOB ? ' + Bull OB' : ''}${nearBullFVG ? ' + FVG' : ''}`,
      probability: confluence >= 2 ? 'High' : confluence === 1 ? 'Medium' : 'Low',
    });
  }

  // Bear IDM: equal highs above price (retail longs targeted) → near bearish OB/FVG = high prob SHORT
  for (const eq of equalHighs) {
    const distAbove = eq.price - curP;
    if (distAbove < 0 || distAbove > aV * 8) continue;
    const nearBearOB = mtfOBs?.nearestBearOB
      ? Math.abs(mtfOBs.nearestBearOB.mid - eq.price) < aV * 2
      : false;
    const nearBearFVG = mtfFVGs?.bearFVGs?.some(f => Math.abs((f.high + f.low) / 2 - eq.price) < aV * 2) || false;
    const confluence = (nearBearOB ? 1 : 0) + (nearBearFVG ? 1 : 0);
    result.bearIDM.push({
      liquidityPrice: eq.price,
      confluenceWithOB: nearBearOB,
      confluenceWithFVG: nearBearFVG,
      confluenceScore: confluence,
      label: `📍 Bear IDM @ ${eq.price.toFixed(4)} — equal highs${nearBearOB ? ' + Bear OB' : ''}${nearBearFVG ? ' + FVG' : ''}`,
      probability: confluence >= 2 ? 'High' : confluence === 1 ? 'Medium' : 'Low',
    });
  }

  // Keep best 3 each
  result.bullIDM = result.bullIDM.sort((a, b) => b.confluenceScore - a.confluenceScore).slice(0, 3);
  result.bearIDM = result.bearIDM.sort((a, b) => b.confluenceScore - a.confluenceScore).slice(0, 3);
  result.detected = result.bullIDM.length > 0 || result.bearIDM.length > 0;

  // Scoring hint for integration
  const bestBull = result.bullIDM[0];
  const bestBear = result.bearIDM[0];
  result.bestBullScore = bestBull ? bestBull.confluenceScore : 0;
  result.bestBearScore = bestBear ? bestBear.confluenceScore : 0;

  return result;
}

/* ─── 2. ANCHORED VWAP (AVWAP) ─── */
function calcAnchoredVWAP(kl1h, kl1d) {
  if (!kl1h || kl1h.length < 10) return null;

  const curP = parseFloat(kl1h[kl1h.length - 1][4]);

  // Anchor 1: Start of current month (UTC)
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();

  // Anchor 2: Start of current week (Monday UTC)
  const dayOfWeek = now.getUTCDay(); // 0=Sun
  const daysToMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToMon)).getTime();

  // Anchor 3: Find last significant swing (largest single-bar move in last 50 bars)
  let swingAnchorTs = null;
  let maxMove = 0;
  const lb = Math.min(kl1h.length - 1, 50);
  for (let i = kl1h.length - lb; i < kl1h.length - 1; i++) {
    const o = parseFloat(kl1h[i][1]), c = parseFloat(kl1h[i][4]);
    const move = Math.abs(c - o);
    if (move > maxMove) { maxMove = move; swingAnchorTs = parseInt(kl1h[i][0]); }
  }

  function vwapFrom(kl, anchorTs) {
    let cumPV = 0, cumV = 0;
    for (const k of kl) {
      if (parseInt(k[0]) < anchorTs) continue;
      const tp = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
      const v  = parseFloat(k[5]);
      cumPV += tp * v;
      cumV  += v;
    }
    return cumV > 0 ? cumPV / cumV : null;
  }

  const monthlyAVWAP = vwapFrom(kl1h, monthStart);
  const weeklyAVWAP  = vwapFrom(kl1h, weekStart);
  const swingAVWAP   = swingAnchorTs ? vwapFrom(kl1h, swingAnchorTs) : null;

  // Classify price vs each AVWAP
  function classify(avwap) {
    if (!avwap) return null;
    const pct = ((curP - avwap) / avwap) * 100;
    return {
      value: avwap,
      pct: pct,
      above: curP > avwap,
      far: Math.abs(pct) > 3,
      label: pct > 2 ? '↑↑ Far Above' : pct > 0.5 ? '↑ Above' : pct < -2 ? '↓↓ Far Below' : pct < -0.5 ? '↓ Below' : '≈ At AVWAP',
    };
  }

  const monthly = classify(monthlyAVWAP);
  const weekly  = classify(weeklyAVWAP);
  const swing   = classify(swingAVWAP);

  // Institutional bias: all AVWAPs agree = strong directional conviction
  const allAbove = [monthly, weekly, swing].filter(Boolean).every(a => a.above);
  const allBelow = [monthly, weekly, swing].filter(Boolean).every(a => !a.above);

  return {
    monthly, weekly, swing,
    allAbove, allBelow,
    institutionalBias: allAbove ? 'bullish' : allBelow ? 'bearish' : 'mixed',
    label: allAbove
      ? '🏦 All AVWAPs: bullish — institutions in profit, buyers in control'
      : allBelow
      ? '🏦 All AVWAPs: bearish — institutions distributing, sellers in control'
      : '🏦 AVWAP mixed — no clear institutional bias',
  };
}

/* ─── 3. TTM SQUEEZE ─── */
function calcTTMSqueeze(C, H, L, atr, bbData) {
  if (!C || C.length < 22 || !atr) return null;

  // Keltner Channel (EMA20 ± 1.5×ATR)
  const ema20 = calcEMA(C, 20);
  if (!ema20) return null;
  const aV = atr.atr;
  const kcUpper = ema20 + 1.5 * aV;
  const kcLower = ema20 - 1.5 * aV;

  // BB from passed bbData or compute
  const bb = bbData || calcBollingerBands(C, 20, 2);
  if (!bb) return null;

  // SQUEEZE: BB inside KC = compression, big move incoming
  const squeeze = bb.upper < kcUpper && bb.lower > kcLower;
  const sqReleased = !squeeze && bb.width > 0.035; // BB expanded past KC

  // Momentum oscillator: Linear regression of (close - midpoint of (highest high + lowest low)/2 + EMA20) / 2
  const lb = 20;
  const recentC = C.slice(-lb);
  const recentH = H.slice(-lb), recentL = L.slice(-lb);
  const highestH = Math.max(...recentH), lowestL = Math.min(...recentL);
  const midHL = (highestH + lowestL) / 2;
  const midEMA = (midHL + ema20) / 2;

  // Momentum values (last 5 bars)
  const momentumVals = [];
  for (let i = Math.max(0, C.length - 6); i < C.length; i++) {
    const hh = Math.max(...H.slice(Math.max(0, i - lb + 1), i + 1));
    const ll = Math.min(...L.slice(Math.max(0, i - lb + 1), i + 1));
    const em = calcEMA(C.slice(0, i + 1), 20);
    if (!em) continue;
    momentumVals.push(C[i] - ((hh + ll) / 2 + em) / 2);
  }

  const lastMom = momentumVals[momentumVals.length - 1] || 0;
  const prevMom = momentumVals[momentumVals.length - 2] || 0;
  const momRising = lastMom > prevMom;
  const momPositive = lastMom > 0;

  return {
    squeeze,
    sqReleased,
    momentum: lastMom,
    momRising,
    momPositive,
    bbWidth: bb.width,
    kcUpper, kcLower,
    bias: momPositive ? (momRising ? 'strong_bull' : 'weak_bull') : (momRising ? 'weak_bear' : 'strong_bear'),
    label: squeeze
      ? `🔴 TTM SQUEEZE active — compression (BB inside KC). ${momPositive ? 'Bull' : 'Bear'} breakout loading.`
      : sqReleased
      ? `🟢 TTM SQUEEZE released — breakout in progress (${momPositive ? '▲ BULL' : '▼ BEAR'} momentum${momRising ? ' rising' : ' fading'})`
      : `⚪ No squeeze — normal BB/KC relationship`,
    note: squeeze
      ? 'Wait for squeeze release. Direction = momentum color at release.'
      : sqReleased
      ? `Breakout direction: ${momPositive ? 'LONG' : 'SHORT'}. Momentum ${momRising ? 'accelerating' : 'decelerating'}.`
      : '',
  };
}

/* ─── 4. CHAIKIN MONEY FLOW (CMF) ─── */
function calcCMF(C, H, L, V, period) {
  period = period || 20;
  if (!C || C.length < period || !V) return null;

  const mfv = []; // Money Flow Volume per bar
  for (let i = 0; i < C.length; i++) {
    const hl = H[i] - L[i];
    if (hl === 0) { mfv.push(0); continue; }
    const mfm = ((C[i] - L[i]) - (H[i] - C[i])) / hl; // Money Flow Multiplier [-1, +1]
    mfv.push(mfm * V[i]);
  }

  const slice = (arr, p) => arr.slice(-p);
  const sumMFV = slice(mfv, period).reduce((a, b) => a + b, 0);
  const sumVol = slice(V, period).reduce((a, b) => a + b, 0);
  const cmf   = sumVol > 0 ? sumMFV / sumVol : 0;

  // CMF 5-bar ago for trend direction
  const prev5 = (() => {
    if (C.length < period + 5) return null;
    const pmfv = mfv.slice(-period - 5, -5);
    const pv   = V.slice(-period - 5, -5);
    const ps   = pv.reduce((a, b) => a + b, 0);
    return ps > 0 ? pmfv.reduce((a, b) => a + b, 0) / ps : null;
  })();

  const rising = prev5 !== null ? cmf > prev5 : null;
  const strongBuy  = cmf > 0.15;
  const strongSell = cmf < -0.15;
  const weakBuy    = cmf > 0.05 && !strongBuy;
  const weakSell   = cmf < -0.05 && !strongSell;

  return {
    value: cmf,
    rising,
    strongBuy, strongSell, weakBuy, weakSell,
    bullish: cmf > 0,
    label: strongBuy
      ? `💰 CMF ${cmf.toFixed(3)} — Strong Smart Money BUY pressure`
      : weakBuy
      ? `📈 CMF ${cmf.toFixed(3)} — Moderate buying flow`
      : strongSell
      ? `💸 CMF ${cmf.toFixed(3)} — Strong Smart Money SELL pressure`
      : weakSell
      ? `📉 CMF ${cmf.toFixed(3)} — Moderate selling flow`
      : `〰 CMF ${cmf.toFixed(3)} — Neutral money flow`,
    note: rising !== null
      ? (rising ? 'Money flow improving — accumulation signal.' : 'Money flow deteriorating — distribution signal.')
      : '',
  };
}

/* ─── 5. ICHIMOKU CLOUD ─── */
function calcIchimoku(H, L, C) {
  if (!H || H.length < 52) return null;

  function midpoint(arr, start, len) {
    const sl = arr.slice(start, start + len);
    return (Math.max(...sl) + Math.min(...sl)) / 2;
  }

  const n = H.length;
  // Tenkan-sen (Conversion): 9-period midpoint
  const tenkan  = midpoint(H.concat(), n - 9, 9) !== undefined
    ? (Math.max(...H.slice(-9))  + Math.min(...L.slice(-9)))  / 2 : null;
  // Kijun-sen (Base): 26-period midpoint
  const kijun   = (Math.max(...H.slice(-26)) + Math.min(...L.slice(-26))) / 2;
  // Senkou Span A (Cloud top/bottom A): (Tenkan+Kijun)/2, plotted 26 ahead
  const spanA   = tenkan !== null ? (tenkan + kijun) / 2 : null;
  // Senkou Span B (Cloud top/bottom B): 52-period midpoint, plotted 26 ahead
  const spanB   = (Math.max(...H.slice(-52)) + Math.min(...L.slice(-52))) / 2;
  // Chikou Span (Lagging): current close plotted 26 back
  const chikou  = C[C.length - 1]; // vs price 26 bars ago
  const chikouRef = C.length > 26 ? C[C.length - 27] : null;

  const curP    = C[C.length - 1];

  // Cloud colour
  const cloudBull = spanA !== null && spanA > spanB; // green cloud
  const cloudBear = spanA !== null && spanA < spanB; // red cloud

  // Price vs cloud
  const aboveCloud = spanA !== null && curP > Math.max(spanA, spanB);
  const belowCloud = spanA !== null && curP < Math.min(spanA, spanB);
  const insideCloud= !aboveCloud && !belowCloud;

  // TK cross (momentum signal)
  const tkBullCross = tenkan !== null && tenkan > kijun;
  const tkBearCross = tenkan !== null && tenkan < kijun;

  // Kumo twist detection (span A crosses span B = cloud color flip = big trend change)
  // Use 26-bar-ago spans for previous cloud
  let prevSpanA = null, prevSpanB = null;
  if (n >= 52 + 26) {
    const pH = H.slice(0, n - 26), pL = L.slice(0, n - 26);
    const pt = (Math.max(...pH.slice(-9)) + Math.min(...pL.slice(-9))) / 2;
    const pk = (Math.max(...pH.slice(-26)) + Math.min(...pL.slice(-26))) / 2;
    prevSpanA = (pt + pk) / 2;
    prevSpanB = (Math.max(...pH.slice(-52)) + Math.min(...pL.slice(-52))) / 2;
  }
  const kumoTwist = prevSpanA !== null && prevSpanB !== null
    && ((prevSpanA < prevSpanB && spanA > spanB) || (prevSpanA > prevSpanB && spanA < spanB));
  const kumoTwistBull = kumoTwist && spanA > spanB;
  const kumoTwistBear = kumoTwist && spanA < spanB;

  // Chikou confirmation
  const chikouBull = chikouRef !== null && chikou > chikouRef;
  const chikouBear = chikouRef !== null && chikou < chikouRef;

  // Full Ichimoku bullish signal: price above cloud + TK bull + chikou bull + green cloud
  const fullBull = aboveCloud && tkBullCross && chikouBull && cloudBull;
  const fullBear = belowCloud && tkBearCross && chikouBear && cloudBear;

  return {
    tenkan, kijun, spanA, spanB, chikou,
    cloudBull, cloudBear, aboveCloud, belowCloud, insideCloud,
    tkBullCross, tkBearCross,
    kumoTwist, kumoTwistBull, kumoTwistBear,
    chikouBull, chikouBear,
    fullBull, fullBear,
    strength: fullBull ? 'full_bull' : fullBear ? 'full_bear'
      : aboveCloud && tkBullCross ? 'bull'
      : belowCloud && tkBearCross ? 'bear'
      : insideCloud ? 'neutral'
      : aboveCloud ? 'weak_bull' : 'weak_bear',
    label: fullBull
      ? '☁ Ichimoku: FULL BULL — price above cloud + TK cross + Chikou confirm'
      : fullBear
      ? '☁ Ichimoku: FULL BEAR — price below cloud + TK cross + Chikou confirm'
      : kumoTwistBull
      ? '☁ Ichimoku: KUMO TWIST BULL — cloud flipping green = major trend reversal UP'
      : kumoTwistBear
      ? '☁ Ichimoku: KUMO TWIST BEAR — cloud flipping red = major trend reversal DOWN'
      : aboveCloud
      ? `☁ Ichimoku: Above cloud (${cloudBull ? 'green' : 'red'}) — bullish bias`
      : belowCloud
      ? `☁ Ichimoku: Below cloud (${cloudBull ? 'green' : 'red'}) — bearish bias`
      : `☁ Ichimoku: Inside cloud — consolidation / indecision`,
    note: kumoTwist ? '⚠ Kumo Twist detected — major trend change signal. High probability reversal.' : '',
  };
}

/* ─── 6. PARABOLIC SAR (for Trailing SL) ─── */
function calcParabolicSAR(H, L, C, step, max) {
  step = step || 0.02;
  max  = max  || 0.2;
  if (!H || H.length < 10) return null;

  let af = step, rising = true;
  let sar = L[0], ep = H[0];

  for (let i = 1; i < H.length; i++) {
    const prevSAR = sar;
    sar = sar + af * (ep - sar);

    if (rising) {
      if (L[i] < sar) {
        // Flip to falling
        rising = false;
        sar = ep;
        ep  = L[i];
        af  = step;
      } else {
        if (H[i] > ep) { ep = H[i]; af = Math.min(af + step, max); }
        sar = Math.min(sar, L[i - 1], i > 1 ? L[i - 2] : L[i - 1]);
      }
    } else {
      if (H[i] > sar) {
        // Flip to rising
        rising = true;
        sar = ep;
        ep  = H[i];
        af  = step;
      } else {
        if (L[i] < ep) { ep = L[i]; af = Math.min(af + step, max); }
        sar = Math.max(sar, H[i - 1], i > 1 ? H[i - 2] : H[i - 1]);
      }
    }
  }

  const curP  = C[C.length - 1];
  const sarPct = ((curP - sar) / curP) * 100;

  return {
    value: sar,
    rising,
    bullish: rising,
    distPct: sarPct,
    trailingSL: sar, // use directly as trailing stop loss
    tightTrail: Math.abs(sarPct) < 1.5, // very close = tight trailing
    label: rising
      ? `⬆ PSAR ${sar.toFixed(4)} (${sarPct.toFixed(2)}% below) — bullish, trail SL here`
      : `⬇ PSAR ${sar.toFixed(4)} (${Math.abs(sarPct).toFixed(2)}% above) — bearish, trail SL here`,
    note: rising
      ? `Trailing Stop Loss: ${sar.toFixed(4)} — move SL up as price rises.`
      : `Trailing Stop Loss: ${sar.toFixed(4)} — move SL down as price falls.`,
  };
}

