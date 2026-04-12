/**
 * InvestySignals — Fibonacci Entry Engine  v3
 * public/analysis/indicator.js
 *
 * Loaded by analysis.html BEFORE the main inline script.
 * Provides:
 *   loadIndicatorSettings()  — fetches /api/settings/indicators → window.ISETTINGS
 *   snapToFibEntry()         — snaps LIMIT entry to nearest key Fibonacci level
 *   getFibSL()               — stop-loss at Fibonacci trade-invalidation level
 *   getFibTargets()          — TP1 (100% recovery) + TP2 (161.8% extension)
 *
 * Fibonacci level convention used by analysis.html's calcFibonacci():
 *   UPTREND   (!highIsRecent)  — r=0 → swingLow,  r=1 → swingHigh
 *   DOWNTREND (highIsRecent)   — r=0 → swingHigh, r=1 → swingLow
 * Extensions (r > 1) always continue in the dominant direction.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   INDICATOR SETTINGS LOADER
   Fetches admin-controlled indicator params from MongoDB and
   stores them in window.ISETTINGS for use throughout analysis.html.
   ═══════════════════════════════════════════════════════════════ */

window.ISETTINGS        = {};
window.ISETTINGS_LOADED = false;

async function loadIndicatorSettings() {
  try {
    const r = await fetch('/api/settings/indicators');
    const j = await r.json();
    if (j.success && j.data) {
      window.ISETTINGS        = j.data;
      window.ISETTINGS_LOADED = true;
    }
  } catch (_) {}
}

// Helper: read a numeric setting with a hardcoded fallback
function IS(key, def) {
  const v = window.ISETTINGS && window.ISETTINGS[key];
  return (v != null && !isNaN(+v)) ? +v : def;
}

// Kick off fetch immediately on script load
loadIndicatorSettings();


/* ═══════════════════════════════════════════════════════════════
   FIBONACCI ENTRY  —  snapToFibEntry
   ═══════════════════════════════════════════════════════════════

   Finds the best LIMIT entry price by snapping to the nearest
   key Fibonacci retracement level that respects trade direction.

   LONG  (uptrend)   -> highest key level AT or BELOW current price
                        (38.2 / 50 / 61.8 % of the up-swing)
   SHORT (downtrend) -> lowest key level AT or ABOVE current price
                        (same r-values, mirrored prices)

   Returns null when:
     - fibData is null / missing levels
     - trend does not align with direction (e.g. uptrend + SHORT)
     - no key level is within 2xATR of current price
   In all null cases the caller falls back to r5L / r5H logic.
   ═══════════════════════════════════════════════════════════════ */

function snapToFibEntry(price, fibData, direction, atr) {
  if (!fibData || !fibData.levels || !fibData.trend) return null;

  const aV  = atr || price * 0.015;
  const tol = aV * 2.0;   // within 2xATR = "close enough to this level"

  if (direction === 'LONG' && fibData.trend === 'uptrend') {
    const candidates = fibData.levels
      .filter(l => l.key && l.type === 'retrace' && l.price <= price + tol)
      .sort((a, b) => b.price - a.price);   // highest first = nearest support
    return candidates.length ? candidates[0].price : null;
  }

  if (direction === 'SHORT' && fibData.trend === 'downtrend') {
    const candidates = fibData.levels
      .filter(l => l.key && l.type === 'retrace' && l.price >= price - tol)
      .sort((a, b) => a.price - b.price);   // lowest first = nearest resistance
    return candidates.length ? candidates[0].price : null;
  }

  // Trend not aligned with direction — no Fibonacci snap
  return null;
}


/* ═══════════════════════════════════════════════════════════════
   FIBONACCI STOP-LOSS  —  getFibSL
   ═══════════════════════════════════════════════════════════════

   Places the stop at the trade-invalidation Fibonacci level
   (the point beyond which the setup is broken):

   LONG  -> just below the 0% level (= swingLow in uptrend)
            adds a 0.3xATR buffer beyond the level
   SHORT -> just above the 0% level (= swingHigh in downtrend)

   Returns null when no valid invalidation level exists.
   Caller merges with ATR/OB SL and picks the appropriate level.
   ═══════════════════════════════════════════════════════════════ */

function getFibSL(ep, fibData, direction, atr) {
  if (!fibData || !fibData.levels) return null;

  const aV  = atr || ep * 0.015;
  const base = fibData.levels.find(l => l.r === 0);
  if (!base) return null;

  if (direction === 'LONG') {
    // base.price = swingLow (uptrend) — must be below entry
    if (base.price >= ep) return null;
    return base.price - aV * 0.3;
  } else {
    // base.price = swingHigh (downtrend) — must be above entry
    if (base.price <= ep) return null;
    return base.price + aV * 0.3;
  }
}


/* ═══════════════════════════════════════════════════════════════
   FIBONACCI TAKE-PROFITS  —  getFibTargets
   ═══════════════════════════════════════════════════════════════

   TP1 -> 100% Fibonacci level (full recovery to the swing extreme)
           - If 100% level is within 4xrisk -> use it as TP1
           - Otherwise use next key retrace between entry and 100%
           - Last fallback: entry +/- 1.5xrisk

   TP2 -> 161.8% extension beyond the swing extreme
           - Prefers Fibonacci extension level
           - Falls back to next S/R zone, then entry +/- 2.8xrisk

   Returns { tp1, tp2 } — always a valid price pair.
   ═══════════════════════════════════════════════════════════════ */

function getFibTargets(ep, sl, fibData, direction, srZones) {
  const risk = Math.abs(ep - sl);
  if (!risk) return { tp1: ep, tp2: ep };

  let tp1 = null;
  let tp2 = null;

  const hasFib = fibData && fibData.levels && fibData.trend;

  /* ── LONG ── */
  if (direction === 'LONG') {
    if (hasFib && fibData.trend === 'uptrend') {
      const fib100  = fibData.levels.find(l => l.r === 1);
      const fib1618 = fibData.levels.find(l => Math.abs(l.r - 1.618) < 0.01);

      // TP1: swing high (100% level) if within 4xrisk
      if (fib100 && fib100.price > ep && fib100.price - ep <= risk * 4) {
        tp1 = fib100.price;
      } else {
        // Next key retrace above entry but below swing high
        const mid = fibData.levels
          .filter(l => l.key && l.type === 'retrace' && l.price > ep && (!fib100 || l.price < fib100.price))
          .sort((a, b) => a.price - b.price)[0];
        if (mid) tp1 = mid.price;
      }

      // TP2: 161.8% extension above swing high
      if (fib1618 && tp1 !== null && fib1618.price > tp1) tp2 = fib1618.price;
      else if (fib1618 && fib1618.price > ep)             tp2 = fib1618.price;
    }

    // Fallbacks
    if (tp1 === null) tp1 = ep + risk * 1.5;
    if (tp2 === null) {
      const nextResist = srZones && srZones.above && srZones.above.find(z => z.price > tp1);
      tp2 = nextResist ? Math.min(nextResist.price, ep + risk * 2.8) : ep + risk * 2.8;
    }
  }

  /* ── SHORT ── */
  if (direction === 'SHORT') {
    if (hasFib && fibData.trend === 'downtrend') {
      const fib100  = fibData.levels.find(l => l.r === 1);
      const fib1618 = fibData.levels.find(l => Math.abs(l.r - 1.618) < 0.01);

      // TP1: swing low (100% level) if within 4xrisk
      if (fib100 && fib100.price < ep && ep - fib100.price <= risk * 4) {
        tp1 = fib100.price;
      } else {
        const mid = fibData.levels
          .filter(l => l.key && l.type === 'retrace' && l.price < ep && (!fib100 || l.price > fib100.price))
          .sort((a, b) => b.price - a.price)[0];
        if (mid) tp1 = mid.price;
      }

      // TP2: 161.8% extension below swing low
      if (fib1618 && tp1 !== null && fib1618.price < tp1) tp2 = fib1618.price;
      else if (fib1618 && fib1618.price < ep)             tp2 = fib1618.price;
    }

    // Fallbacks
    if (tp1 === null) tp1 = ep - risk * 1.5;
    if (tp2 === null) {
      const nextSupport = srZones && srZones.below && srZones.below.find(z => z.price < tp1);
      tp2 = nextSupport ? Math.max(nextSupport.price, ep - risk * 2.8) : ep - risk * 2.8;
    }
  }

  return { tp1, tp2 };
}
