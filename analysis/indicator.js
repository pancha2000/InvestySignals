/**
 * InvestySignals — Analysis Indicators
 * public/analysis/indicator.js
 *
 * Pure indicator + helper functions used by analysis.html.
 * ★ When adding new indicators, ALWAYS add them to THIS file. ★
 *
 * Load order in analysis.html:
 *   1. Firebase module
 *   2. <script src="analysis/indicator.js">   ← this file
 *   3. Main inline script
 */

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const BINANCE_FAPI = 'https://fapi.binance.com';
const SCAN_LIMIT   = 50;
const RSI_PERIOD   = 14;
const KLINE_LIMIT  = 100;
const KLINE_TF     = '1h';

// ─────────────────────────────────────────────
//  FORMAT HELPERS
// ─────────────────────────────────────────────
function fmtPrice(p) {
  const n = parseFloat(p);
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1)    return '$' + n.toFixed(4);
  if (n >= 0.01) return '$' + n.toFixed(5);
  return '$' + n.toFixed(6);
}

function fmtVol(v) {
  const n = parseFloat(v);
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + (n / 1e3).toFixed(0) + 'K';
}

// ─────────────────────────────────────────────
//  EMA — Exponential Moving Average
//  ★ New indicator — added at top of file ★
//  Uses standard EMA smoothing: k = 2/(period+1)
//  Returns null if not enough candles.
// ─────────────────────────────────────────────
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ─────────────────────────────────────────────
//  RSI — Wilder Smoothing Method
// ─────────────────────────────────────────────
function calcRSI(closes, period) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0))  / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ─────────────────────────────────────────────
//  VOLUME ANALYSIS
// ─────────────────────────────────────────────
function analyzeVolume(klines) {
  const vols  = klines.map(k => parseFloat(k[5]));
  const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const last3 = vols.slice(-4,  -1).reduce((a, b) => a + b, 0) / 3;
  const ratio = avg20 > 0 ? last3 / avg20 : 1;
  return {
    avg20, last3, ratio,
    surge: ratio >= 1.5,
    label: ratio >= 2.0 ? 'Very High'
         : ratio >= 1.5 ? 'High'
         : ratio >= 1.0 ? 'Normal'
         : 'Low'
  };
}

// ─────────────────────────────────────────────
//  ENTRY DECISION
//
//  Returns entryType: 'MARKET' | 'LIMIT'
//
//  MARKET — price already at extreme + volume surge.
//    Enter now at current price.
//
//  LIMIT  — price not at extreme or volume is low.
//    Set a limit order at the recent 5-candle swing
//    low (LONG) or high (SHORT) and wait for fill.
//    The trade is saved as PENDING_LONG / PENDING_SHORT
//    and only becomes OPEN when price reaches it.
// ─────────────────────────────────────────────
function decideEntry(rsi, volInfo, closes, highs, lows, currentPrice) {
  let direction = 'NEUTRAL';
  if      (rsi <= 45) direction = 'LONG';
  else if (rsi >= 55) direction = 'SHORT';

  let entryType = 'LIMIT';
  if ((direction === 'LONG'  && rsi <= 35 && volInfo.surge) ||
      (direction === 'SHORT' && rsi >= 65 && volInfo.surge)) {
    entryType = 'MARKET';
  }

  const recent10H  = Math.max(...highs.slice(-10));
  const recent10L  = Math.min(...lows.slice(-10));
  const recent5H   = Math.max(...highs.slice(-5));
  const recent5L   = Math.min(...lows.slice(-5));
  const swingRange = recent10H - recent10L;

  let entryPrice, slPrice, tp1Price, tp2Price;

  if (direction === 'LONG') {
    // MARKET: enter at current price now
    // LIMIT:  bid at 5-candle low — wait for price to pull back
    entryPrice = entryType === 'MARKET' ? currentPrice : recent5L;
    slPrice    = recent10L - swingRange * 0.05;
    const risk = entryPrice - slPrice;
    tp1Price   = entryPrice + risk * 1.5;
    tp2Price   = entryPrice + risk * 2.5;

  } else if (direction === 'SHORT') {
    // MARKET: enter short now
    // LIMIT:  ask at 5-candle high — wait for price to bounce up
    entryPrice = entryType === 'MARKET' ? currentPrice : recent5H;
    slPrice    = recent10H + swingRange * 0.05;
    const risk = slPrice - entryPrice;
    tp1Price   = entryPrice - risk * 1.5;
    tp2Price   = entryPrice - risk * 2.5;

  } else {
    entryPrice = slPrice = tp1Price = tp2Price = currentPrice;
  }

  return { direction, entryType, entryPrice, slPrice, tp1Price, tp2Price };
}

// ─────────────────────────────────────────────
//  BUILD REASON BULLETS
// ─────────────────────────────────────────────
function buildReasons(rsi, volInfo, direction, entryType, ema20, ema50) {
  const reasons   = [];
  const r         = rsi.toFixed(1);
  const emaTrend  = (ema20 && ema50) ? (ema20 > ema50 ? 'bullish' : 'bearish') : null;

  if (direction === 'LONG') {
    if (rsi <= 30)
      reasons.push({ icon: '🟢', text: `RSI at <strong>${r}</strong> — deeply oversold. Strong mean-reversion long signal.` });
    else if (rsi <= 45)
      reasons.push({ icon: '🟢', text: `RSI at <strong>${r}</strong> — below 45, bearish weakness that often precedes a long reversal.` });

    if (emaTrend === 'bullish')
      reasons.push({ icon: '📈', text: `EMA20 (${fmtPrice(ema20)}) is <strong>above EMA50</strong> (${fmtPrice(ema50)}) — 1H uptrend confirmed. Trade is trend-aligned.` });
    else if (emaTrend === 'bearish')
      reasons.push({ icon: '⚠️', text: `EMA20 is <strong>below EMA50</strong> — counter-trend long. Use smaller position size.` });

    if (volInfo.surge)
      reasons.push({ icon: '📈', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). Elevated buying interest.` });
    else
      reasons.push({ icon: '📊', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). Moderate — limit entry at pullback preferred.` });

    if (entryType === 'MARKET')
      reasons.push({ icon: '⚡', text: `<strong>Market entry</strong> — RSI at oversold extreme with volume surge. Enter at current price.` });
    else
      reasons.push({ icon: '⏳', text: `<strong>Limit entry</strong> — order waits at the recent 5-candle low. Trade only opens when price pulls back to that level.` });

  } else if (direction === 'SHORT') {
    if (rsi >= 70)
      reasons.push({ icon: '🔴', text: `RSI at <strong>${r}</strong> — deeply overbought. Strong mean-reversion short signal.` });
    else if (rsi >= 55)
      reasons.push({ icon: '🔴', text: `RSI at <strong>${r}</strong> — above 55, bullish exhaustion often precedes a short.` });

    if (emaTrend === 'bearish')
      reasons.push({ icon: '📉', text: `EMA20 (${fmtPrice(ema20)}) is <strong>below EMA50</strong> (${fmtPrice(ema50)}) — 1H downtrend confirmed. Trade is trend-aligned.` });
    else if (emaTrend === 'bullish')
      reasons.push({ icon: '⚠️', text: `EMA20 is <strong>above EMA50</strong> — counter-trend short. Use smaller position size.` });

    if (volInfo.surge)
      reasons.push({ icon: '📉', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). Selling pressure confirmed.` });
    else
      reasons.push({ icon: '📊', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). Limit entry at recent high zone is safer.` });

    if (entryType === 'MARKET')
      reasons.push({ icon: '⚡', text: `<strong>Market entry</strong> — RSI overbought with volume surge. Enter short at current price.` });
    else
      reasons.push({ icon: '⏳', text: `<strong>Limit entry</strong> — order waits at the recent 5-candle high. Trade only opens when price bounces up to that level.` });
  }

  reasons.push({ icon: '🎯', text: `TP1 = 1.5× risk, TP2 = 2.5× risk. Stop placed beyond the 10-candle swing extreme with a 5% buffer.` });
  return reasons;
}
