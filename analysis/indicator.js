/**
 * InvestySignals — Analysis Indicators
 * analysis/indicator.js
 *
 * Pure indicator / calculation functions used by analysis.html.
 * Separated for clean architecture and reusability.
 */

// ────────────────────────────────────────────────
//  CONSTANTS
// ────────────────────────────────────────────────
const BINANCE_FAPI = 'https://fapi.binance.com';
const SCAN_LIMIT   = 20;    // top N coins by volume
const RSI_PERIOD   = 14;
const KLINE_LIMIT  = 60;    // candles to fetch for RSI
const KLINE_TF     = '1h';  // timeframe

// ────────────────────────────────────────────────
//  FORMAT HELPERS
// ────────────────────────────────────────────────
function fmtPrice(p) {
  p = parseFloat(p);
  if (p >= 1000)  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1)     return '$' + p.toFixed(4);
  if (p >= 0.01)  return '$' + p.toFixed(5);
  return '$' + p.toFixed(6);
}

function fmtVol(v) {
  v = parseFloat(v);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ────────────────────────────────────────────────
//  RSI CALCULATION  (Wilder smoothing)
// ────────────────────────────────────────────────
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;

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
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ────────────────────────────────────────────────
//  VOLUME ANALYSIS
// ────────────────────────────────────────────────
function analyzeVolume(klines) {
  // klines[i] = [openTime, open, high, low, close, volume, ...]
  const vols  = klines.map(k => parseFloat(k[5]));
  const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const last3 = vols.slice(-4, -1).reduce((a, b) => a + b, 0) / 3;
  const ratio = avg20 > 0 ? last3 / avg20 : 1;
  return {
    avg20,
    last3,
    ratio,
    surge: ratio >= 1.5,
    label: ratio >= 2.0 ? 'Very High'
         : ratio >= 1.5 ? 'High'
         : ratio >= 1.0 ? 'Normal'
         : 'Low'
  };
}

// ────────────────────────────────────────────────
//  ENTRY DECISION
// ────────────────────────────────────────────────
function decideEntry(rsi, volInfo, closes, highs, lows, currentPrice) {
  // Direction
  let direction = 'NEUTRAL';
  if      (rsi <= 45) direction = 'LONG';
  else if (rsi >= 55) direction = 'SHORT';

  // Entry type
  // Market: RSI at extreme + volume surge
  // Limit:  RSI not at extreme OR low volume (better price possible)
  let entryType = 'LIMIT';
  if ((direction === 'LONG'  && rsi <= 35 && volInfo.surge) ||
      (direction === 'SHORT' && rsi >= 65 && volInfo.surge)) {
    entryType = 'MARKET';
  }

  // Price levels
  const recent10H  = Math.max(...highs.slice(-10));
  const recent10L  = Math.min(...lows.slice(-10));
  const recent5H   = Math.max(...highs.slice(-5));
  const recent5L   = Math.min(...lows.slice(-5));
  const swingRange = recent10H - recent10L;

  let entryPrice, slPrice, tp1Price, tp2Price;

  if (direction === 'LONG') {
    entryPrice = entryType === 'MARKET' ? currentPrice : recent5L;
    slPrice    = recent10L - swingRange * 0.05;
    const risk = entryPrice - slPrice;
    tp1Price   = entryPrice + risk * 1.5;
    tp2Price   = entryPrice + risk * 2.5;

  } else if (direction === 'SHORT') {
    entryPrice = entryType === 'MARKET' ? currentPrice : recent5H;
    slPrice    = recent10H + swingRange * 0.05;
    const risk = slPrice - entryPrice;
    tp1Price   = entryPrice - risk * 1.5;
    tp2Price   = entryPrice - risk * 2.5;

  } else {
    // Neutral — no trade
    entryPrice = slPrice = tp1Price = tp2Price = currentPrice;
  }

  return { direction, entryType, entryPrice, slPrice, tp1Price, tp2Price };
}

// ────────────────────────────────────────────────
//  BUILD REASON BULLETS
// ────────────────────────────────────────────────
function buildReasons(rsi, volInfo, direction, entryType) {
  const reasons = [];
  const r = rsi.toFixed(1);

  if (direction === 'LONG') {
    if (rsi <= 30)
      reasons.push({ icon: '🟢', text: `RSI at <strong>${r}</strong> — deeply oversold. Strong mean-reversion signal.` });
    else if (rsi <= 45)
      reasons.push({ icon: '🟢', text: `RSI at <strong>${r}</strong> — below 45, showing bearish weakness that often precedes a long reversal.` });

    if (volInfo.surge)
      reasons.push({ icon: '📈', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). High volume confirms buying interest.` });
    else
      reasons.push({ icon: '📊', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). Moderate volume — limit entry preferred for better fill.` });

    if (entryType === 'MARKET')
      reasons.push({ icon: '⚡', text: `<strong>Market entry</strong> recommended — RSI at oversold extreme with volume surge. Momentum favours immediate entry.` });
    else
      reasons.push({ icon: '⏳', text: `<strong>Limit entry</strong> recommended — wait for price to pull back to the recent 5-candle low for a better entry price.` });

  } else if (direction === 'SHORT') {
    if (rsi >= 70)
      reasons.push({ icon: '🔴', text: `RSI at <strong>${r}</strong> — deeply overbought. Strong mean-reversion short signal.` });
    else if (rsi >= 55)
      reasons.push({ icon: '🔴', text: `RSI at <strong>${r}</strong> — above 55, showing bullish exhaustion that often precedes a short setup.` });

    if (volInfo.surge)
      reasons.push({ icon: '📉', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). High volume confirms selling pressure.` });
    else
      reasons.push({ icon: '📊', text: `Volume is <strong>${volInfo.label}</strong> (${volInfo.ratio.toFixed(2)}× avg). Moderate volume — limit entry at recent high zone is safer.` });

    if (entryType === 'MARKET')
      reasons.push({ icon: '⚡', text: `<strong>Market entry</strong> recommended — RSI overbought with volume surge. Momentum favours immediate short entry.` });
    else
      reasons.push({ icon: '⏳', text: `<strong>Limit entry</strong> recommended — wait for a bounce to the recent 5-candle high for a better short entry.` });
  }

  // TP / SL note
  reasons.push({ icon: '🎯', text: `TP1 = 1.5× risk, TP2 = 2.5× risk. Stop is placed beyond the 10-candle swing extreme with a small buffer.` });

  return reasons;
}
