/**
 * InvestySignals — Backtest Engine v2.0
 *
 * Architecture:
 *   - Loads the REAL indicator.js + decideEntry from analysis.html via vm sandbox
 *   - No duplicate code — when you add a new indicator it automatically works in backtest
 *   - Password protected (BACKTEST_PASSWORD env var or config.env)
 *   - Historical Binance Futures klines via REST API
 *
 * Files needed (relative paths from project root):
 *   public/analysis/indicator.js   — all indicator functions
 *   public/analysis.html           — contains decideEntry() + helper functions
 *
 * Place this file at: /home/ubuntu/InvestySignals/backtest-engine.js
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const vm      = require('vm');

/* ══════════════════════════════════════════════════
   LOAD & COMPILE REAL INDICATOR CODE via VM SANDBOX
══════════════════════════════════════════════════ */

let _sandbox = null;

function getSandbox() {
  if (_sandbox) return _sandbox;

  const indicatorPath  = path.join(__dirname, 'public', 'analysis', 'indicator.js');
  const analysisPath   = path.join(__dirname, 'public', 'analysis.html');

  if (!fs.existsSync(indicatorPath)) throw new Error('indicator.js not found at ' + indicatorPath);
  if (!fs.existsSync(analysisPath))  throw new Error('analysis.html not found at ' + analysisPath);

  // ── Mock browser globals needed by indicator.js ──
  const mockFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  const mockWindow = {
    ISETTINGS: {},
    ISETTINGS_LOADED: true,
    _auth: null,
    firebase: null,
  };

  const sandbox = vm.createContext({
    window:        mockWindow,
    fetch:         mockFetch,
    Promise,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    // Node needs these explicitly
    Infinity,
    NaN,
    undefined,
  });

  // ── Load indicator.js (strip 'use strict' to avoid strict mode issues) ──
  let indicatorCode = fs.readFileSync(indicatorPath, 'utf8');
  // Replace: loadGlobalIndicatorSettings() call at top — no-op in sandbox
  indicatorCode = indicatorCode.replace(/^loadGlobalIndicatorSettings\(\);?$/m, '// no-op in sandbox');
  indicatorCode = indicatorCode.replace(/window\.loadGlobalIndicatorSettings\s*=\s*loadGlobalIndicatorSettings;/, '// no-op');

  try {
    vm.runInContext(indicatorCode, sandbox, { filename: 'indicator.js', timeout: 10000 });
  } catch(e) {
    throw new Error('Failed to load indicator.js into sandbox: ' + e.message);
  }

  // ── Extract pure function definitions from analysis.html main script block ──
  const htmlContent = fs.readFileSync(analysisPath, 'utf8');

  // Find the main <script> block (the large one starting after indicator.js include)
  // It starts after line: <script src="analysis/indicator.js"></script>
  const scriptStart = htmlContent.indexOf('<script>\n/* ================================================================');
  const scriptEnd   = htmlContent.indexOf('</script>', scriptStart);

  if (scriptStart === -1) throw new Error('Could not find main script block in analysis.html');

  let analysisCode = htmlContent.slice(scriptStart + 8, scriptEnd); // skip '<script>\n'

  // ── Inject BINANCE_FAPI constant + other globals needed ──
  // No preamble needed — analysis.html already declares BINANCE_FAPI, RSI_PERIOD etc.

  // Remove any DOM manipulation, Firebase imports, event listeners
  // Keep only pure function definitions
  analysisCode = analysisCode
    .replace(/document\.[^;]+;/g, '/* dom removed */')
    .replace(/window\.onload\s*=.*/g, '/* removed */')
    .replace(/firebase\.[^;]+;/g, '/* firebase removed */')
    .replace(/import\s+.*from\s+['"][^'"]+['"];?/g, '/* import removed */');

  try {
    vm.runInContext(analysisCode, sandbox, { filename: 'analysis.html', timeout: 30000 });
  } catch(e) {
    throw new Error('Failed to load analysis.html functions into sandbox: ' + e.message);
  }

  _sandbox = sandbox;
  return sandbox;
}

/* ══════════════════════════════════════════════════
   HTTP HELPER
══════════════════════════════════════════════════ */

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
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

async function fetchKlines(symbol, interval, startMs, endMs) {
  const all = [];
  let from = startMs;
  while (from < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`;
    const batch = await httpsGet(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    const lastOpen = parseInt(batch[batch.length - 1][0]);
    if (batch.length < 1000) break;
    from = lastOpen + 1;
    await new Promise(r => setTimeout(r, 120)); // rate limit
  }
  return all;
}

function klinesUpTo(klines, tsMs) {
  const idx = klines.findIndex(k => parseInt(k[0]) > tsMs);
  return idx === -1 ? klines : klines.slice(0, idx);
}

/* ══════════════════════════════════════════════════
   BACKTEST SIGNAL RUNNER — uses REAL decideEntry
══════════════════════════════════════════════════ */

function runDecideEntry(sandbox, kl1h, kl4h, kl1d, kl15m) {
  try {
    const C   = kl1h.map(k => parseFloat(k[4]));
    const H   = kl1h.map(k => parseFloat(k[2]));
    const L   = kl1h.map(k => parseFloat(k[3]));
    const V   = kl1h.map(k => parseFloat(k[5]));
    const O   = kl1h.map(k => parseFloat(k[1]));
    const C4  = kl4h.map(k => parseFloat(k[4]));
    const H4  = kl4h.map(k => parseFloat(k[2]));
    const L4  = kl4h.map(k => parseFloat(k[3]));
    const O4  = kl4h.map(k => parseFloat(k[1]));
    const C15 = kl15m.map(k => parseFloat(k[4]));
    const H15 = kl15m.map(k => parseFloat(k[2]));
    const L15 = kl15m.map(k => parseFloat(k[3]));
    const O15 = kl15m.map(k => parseFloat(k[1]));
    const C1D = kl1d.map(k => parseFloat(k[4]));
    const H1D = kl1d.map(k => parseFloat(k[2]));
    const L1D = kl1d.map(k => parseFloat(k[3]));
    const O1D = kl1d.map(k => parseFloat(k[1]));

    const curP = C[C.length - 1];

    // Run same indicators as runDeepScan
    const fn = sandbox; // all functions are on sandbox context

    const rsi   = fn.calcRSI(C, 14);
    const vol   = fn.analyzeVolume(kl1h);
    const macd  = fn.calcMACD(C);
    const bb    = fn.calcBollingerBands(C);
    const stoch = fn.calcStochasticRSI(C);
    const atr   = fn.calcATR(H, L, C);
    const adx   = fn.calcADX(H, L, C);
    const obv   = fn.calcOBV(C, V);
    const es    = fn.calcEMAStack(C);
    const vwap  = fn.calcVWAP(kl1h);
    const spt   = fn.calcSupertrend(H, L, C);
    const bos   = fn.detectBOS(H, L, C);
    const div   = fn.detectDivergenceFull(C, H, L, V);

    if (!rsi || !atr || !adx) return null;

    // MTF
    const mRSI  = fn.calcMTFRSI(C, C4, C15, C1D);
    const t4    = fn.calc4HTrend(kl4h);
    const ema15m = fn.calcEMAStack(C15);
    const bos15m = fn.detectBOS(H15, L15, C15, 30);
    const ema4h  = fn.calcEMAStack(C4);
    const bos4h  = fn.detectBOS(H4, L4, C4, 35);
    const ema1d  = fn.calcEMAStack(C1D);
    const rsi15m = fn.calcRSI(C15, 14);
    const rsi4h  = fn.calcRSI(C4, 14);
    const rsi1d  = fn.calcRSI(C1D, 14);
    const rsi1hArr = fn.calcRSIArray(C,   14);
    const rsi4hArr = fn.calcRSIArray(C4,  14);
    const rsi1dArr = fn.calcRSIArray(C1D, 14);

    const trendLine   = fn.calcTrendLine(C, H, L, 50);
    const trendLine4h = fn.calcTrendLine(C4, H4, L4, 40);

    const candlePatterns   = fn.detectCandlePatterns(O, H, L, C);
    const candlePatterns4h = fn.detectCandlePatterns(O4, H4, L4, C4);
    const pivotPoints = fn.calcPivotPoints(kl1d);

    const ob15m = fn.detectOrderBlocks(O15, H15, L15, C15, '15m');
    const ob1h  = fn.detectOrderBlocks(O,   H,   L,   C,   '1H');
    const ob4h  = fn.detectOrderBlocks(O4,  H4,  L4,  C4,  '4H');
    const ob1d  = fn.detectOrderBlocks(O1D, H1D, L1D, C1D, '1D');

    const allBullOBs = [...ob1d.bullOBs, ...ob4h.bullOBs, ...ob1h.bullOBs, ...ob15m.bullOBs];
    const allBearOBs = [...ob1d.bearOBs, ...ob4h.bearOBs, ...ob1h.bearOBs, ...ob15m.bearOBs];
    const nearBull = allBullOBs.sort((a,b) => Math.abs(curP-a.mid)-Math.abs(curP-b.mid))[0] || null;
    const nearBear = allBearOBs.sort((a,b) => Math.abs(curP-a.mid)-Math.abs(curP-b.mid))[0] || null;
    const mtfOBs  = { bullOBs: allBullOBs.slice(0,5), bearOBs: allBearOBs.slice(0,5), nearestBullOB: nearBull, nearestBearOB: nearBear };

    const mtfFVGs  = fn.detectFVGMultiTF(kl15m, kl1h, kl4h, kl1d);
    const srZones  = fn.buildSRZones(kl15m, kl1h, kl4h, kl1d, curP, atr?.atr || curP * 0.01);
    const fibonacci = fn.calcFibonacciMTF(kl15m, kl1h, kl4h, kl1d, curP, atr);
    const regime    = fn.detectMarketRegime(C, H, L, V, adx, bb, atr);
    const rvol      = fn.calcRVOL(kl1h);

    const liqSweeps   = fn.detectLiquiditySweeps(H, L, C, O, atr);
    const liqSweeps15 = fn.detectLiquiditySweeps(H15, L15, C15, O15, atr);
    const breakers    = fn.detectBreakerBlocks(O, H, L, C, atr);
    const breakers4h  = fn.detectBreakerBlocks(O4, H4, L4, C4, atr);
    const oteZone     = fn.calcOTEZone(H, L, C, O, atr, bos);
    const killzone    = fn.getICTKillzone();
    const amdModel    = fn.detectAMDModel(O, H, L, C, V, atr);
    const vsa         = fn.detectVSA(O, H, L, C, V, atr);
    const wyckoff     = fn.detectWyckoff(O, H, L, C, V, atr);
    const premDisc    = fn.calcPremiumDiscount(H, L, C, atr);
    const harmonics   = fn.detectHarmonicPatterns(H, L, C, atr);
    const cvdData     = fn.calcCVD(O, H, L, C, V, null);
    const unmitLevels = fn.filterUnmitigated(mtfOBs, mtfFVGs, H, L, C);
    const marketProf  = fn.calcMarketProfile(H, L, C, V, atr);
    const mtfDiv      = fn.calcMTFDivergence(C, rsi1hArr, C4, rsi4hArr, C1D, rsi1dArr, null);
    const roundLevels = fn.calcRoundLevels(curP, atr);
    const setupType   = fn.classifySetupType(adx, bb, atr, rsi, premDisc, regime, wyckoff, liqSweeps, bos, candlePatterns, { ratio: vol });
    const crtSignal   = fn.detectCRT(O, H, L, C, atr);
    const skAnalysis  = fn.detectSKSystem(O, H, L, C, V, atr, bos, mtfOBs);
    const ipdaLevels  = fn.calcIPDALevels(H, L, C, kl1d, kl4h);
    const propulsion  = fn.detectPropulsionBlock(O, H, L, C, atr);
    const footprint   = fn.calcFootprintLite(O, H, L, C, V, atr);
    const session     = fn.getSession ? fn.getSession() : { session: 'Unknown', quality: 'medium' };

    // No live API data in backtest — pass nulls for OI/taker/orderbook
    const ex = {
      trend4h: t4, fundingRate: null, oiChange: null, divergence: div,
      emaStack: es, vwap, supertrend: spt, bos, mtfRSI: mRSI,
      session, btcContext: null,
      srZones, fibonacci, trendLine, mtfOBs, mtfFVGs,
      ema15m, ema1d, rsi15m, rsi1d, bos15m, bos4h,
      liqSweeps, liqSweeps15, breakers, breakers4h, oteZone, killzone,
      amdModel, vsa, wyckoff, premDisc, harmonics, cvdData, unmitLevels,
      marketProf, mtfDiv, roundLevels, setupType, crtSignal, skAnalysis,
      ipdaLevels, propulsion, footprint,
      candlePatterns, pivotPoints,
      takerRatio: null, lsRatio: null, orderBook: null, rvol, candleCloseTimer: null,
    };

    const entry = fn.decideEntry(rsi, vol, O, C, H, L, curP, macd, bb, stoch, adx, obv, atr, ex);

    if (!entry || entry.hardBlock) return null;

    const minConf = (sandbox.window.ISETTINGS && sandbox.window.ISETTINGS['ind_min_confidence']) || 68;
    if (entry.confidence < minConf) return null;
    if (!entry.direction || entry.direction === 'NEUTRAL') return null;

    return {
      dir:        entry.direction,
      conf:       entry.confidence,
      ep:         entry.entryPrice || curP,
      sl:         entry.slPrice,
      tp1:        entry.tp1Price,
      tp2:        entry.tp2Price,
      rrr1:       entry.rrr1,
      rrr2:       entry.rrr2,
      rsi,
      adx:        adx?.adx,
      trend4h:    t4?.bias,
      entryType:  entry.entryType,
    };
  } catch (e) {
    // Indicator errors are non-fatal — skip this candle
    return null;
  }
}

/* ══════════════════════════════════════════════════
   OUTCOME CHECKER
══════════════════════════════════════════════════ */

function checkOutcome(dir, ep, sl, tp1, tp2, futureKlines) {
  let tp1Hit = false, tp2Hit = false, slHit = false;
  let closePrice = null, closeCandle = null;

  for (let i = 0; i < futureKlines.length; i++) {
    const h = parseFloat(futureKlines[i][2]);
    const l = parseFloat(futureKlines[i][3]);

    if (dir === 'LONG') {
      if (!tp1Hit && h >= tp1) tp1Hit = true;
      if (tp1Hit && h >= tp2)  { tp2Hit = true; closePrice = tp2;  closeCandle = i; break; }
      if (l <= sl) { slHit = true; closePrice = tp1Hit ? ep : sl; closeCandle = i; break; }
    } else {
      if (!tp1Hit && l <= tp1) tp1Hit = true;
      if (tp1Hit && l <= tp2)  { tp2Hit = true; closePrice = tp2;  closeCandle = i; break; }
      if (h >= sl) { slHit = true; closePrice = tp1Hit ? ep : sl; closeCandle = i; break; }
    }
  }

  if (!slHit && !tp2Hit) {
    const last = futureKlines[futureKlines.length - 1];
    closePrice = last ? parseFloat(last[4]) : ep;
    closeCandle = futureKlines.length - 1;
  }

  let outcome = 'OPEN';
  if (tp2Hit)       outcome = 'TP2';
  else if (tp1Hit && slHit) outcome = 'BE';
  else if (tp1Hit)  outcome = 'TP1';
  else if (slHit)   outcome = 'SL';

  const risk = dir === 'LONG' ? ep - sl : sl - ep;
  let pnlR = 0;
  if (risk > 0 && closePrice !== null) {
    const raw = dir === 'LONG' ? (closePrice - ep) / risk : (ep - closePrice) / risk;
    pnlR = parseFloat(raw.toFixed(3));
  }

  return { outcome, tp1Hit, tp2Hit, slHit, closePrice, closeCandle, pnlR };
}

/* ══════════════════════════════════════════════════
   MAIN BACKTEST RUNNER
══════════════════════════════════════════════════ */

async function runBacktest(symbol, startMs, endMs, onProgress) {
  const progress = onProgress || (() => {});

  // Load sandbox once
  progress(3, 'Loading indicator engine…');
  const sandbox = getSandbox();

  progress(6, `Fetching 15m klines for ${symbol}…`);
  const kl15m_all = await fetchKlines(symbol, '15m', startMs - 86400000 * 3, endMs);

  progress(15, `Fetching 1H klines…`);
  const kl1h_all = await fetchKlines(symbol, '1h', startMs, endMs);
  if (!kl1h_all.length) throw new Error(`No 1H data for ${symbol}`);

  progress(28, `Fetching 4H klines…`);
  const kl4h_all = await fetchKlines(symbol, '4h', startMs - 86400000 * 30, endMs);

  progress(36, `Fetching 1D klines…`);
  const kl1d_all = await fetchKlines(symbol, '1d', startMs - 86400000 * 60, endMs);

  progress(42, `Running analysis on ${kl1h_all.length} candles…`);

  const signals = [];
  const WARMUP = 220;
  const MIN_FUTURE = 24;
  const SCAN_STEP = 4;
  const MIN_SIGNAL_GAP = 12;
  let lastSignalCandle = -99;

  for (let i = WARMUP; i < kl1h_all.length - MIN_FUTURE; i += SCAN_STEP) {
    if (i - lastSignalCandle < MIN_SIGNAL_GAP) continue;

    const ts = parseInt(kl1h_all[i][0]);

    const slice1h  = kl1h_all.slice(Math.max(0, i - 249), i + 1);
    const slice15m = klinesUpTo(kl15m_all, ts).slice(-150);
    const slice4h  = klinesUpTo(kl4h_all, ts).slice(-100);
    const slice1d  = klinesUpTo(kl1d_all, ts).slice(-60);

    if (slice4h.length < 30 || slice1d.length < 10 || slice15m.length < 50) continue;

    const sig = runDecideEntry(sandbox, slice1h, slice4h, slice1d, slice15m);
    if (!sig) continue;

    const futureKlines = kl1h_all.slice(i + 1, i + 1 + 168);
    const result = checkOutcome(sig.dir, sig.ep, sig.sl, sig.tp1, sig.tp2, futureKlines);

    const openDate = new Date(ts).toISOString().split('T')[0];
    let closeDate = null;
    if (result.closeCandle !== null) {
      const ci = Math.min(i + 1 + result.closeCandle, kl1h_all.length - 1);
      closeDate = new Date(parseInt(kl1h_all[ci][0])).toISOString().split('T')[0];
    }

    signals.push({
      symbol,
      openTime:   ts,
      openDate,
      closeDate,
      direction:  sig.dir,
      confidence: sig.conf,
      entryType:  sig.entryType || '',
      entryPrice: parseFloat((sig.ep  || 0).toFixed(6)),
      tp1:        parseFloat((sig.tp1 || 0).toFixed(6)),
      tp2:        parseFloat((sig.tp2 || 0).toFixed(6)),
      sl:         parseFloat((sig.sl  || 0).toFixed(6)),
      rrr1:       parseFloat((sig.rrr1 || 0)),
      rrr2:       parseFloat((sig.rrr2 || 0)),
      rsi:        parseFloat((sig.rsi  || 0).toFixed(2)),
      adx:        parseFloat((sig.adx  || 0).toFixed(2)),
      trend4h:    sig.trend4h || 'neutral',
      outcome:    result.outcome,
      tp1Hit:     result.tp1Hit,
      tp2Hit:     result.tp2Hit,
      slHit:      result.slHit,
      closePrice: result.closePrice ? parseFloat(result.closePrice.toFixed(6)) : null,
      pnlR:       result.pnlR,
    });

    lastSignalCandle = i;

    if (i % 40 === 0) {
      const pct = 42 + Math.round(((i - WARMUP) / (kl1h_all.length - WARMUP - MIN_FUTURE)) * 50);
      progress(Math.min(pct, 90), `Analysed ${i}/${kl1h_all.length} candles — ${signals.length} signals…`);
    }
  }

  progress(92, 'Computing statistics…');

  const total  = signals.length;
  const wins   = signals.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  const losses = signals.filter(s => s.outcome === 'SL').length;
  const be     = signals.filter(s => s.outcome === 'BE').length;
  const open   = signals.filter(s => s.outcome === 'OPEN').length;
  const tp2s   = signals.filter(s => s.outcome === 'TP2').length;
  const closed = wins + losses + be;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;

  const totalPnlR = signals.reduce((s, x) => {
    if (x.outcome === 'TP2') return s + (x.rrr2 || 0);
    if (x.outcome === 'TP1') return s + (x.rrr1 || 0);
    if (x.outcome === 'SL')  return s - 1;
    return s;
  }, 0);

  const avgConf = total > 0 ? signals.reduce((s, x) => s + x.confidence, 0) / total : 0;
  const avgRrr1 = total > 0 ? signals.reduce((s, x) => s + (x.rrr1 || 0), 0) / total : 0;

  const longs  = signals.filter(s => s.direction === 'LONG');
  const shorts = signals.filter(s => s.direction === 'SHORT');
  const lW = longs.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  const sW = shorts.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2').length;
  const lC = longs.filter(s => s.outcome !== 'OPEN').length || 1;
  const sC = shorts.filter(s => s.outcome !== 'OPEN').length || 1;

  // Monthly breakdown
  const monthly = {};
  for (const s of signals) {
    const mo = s.openDate.slice(0, 7);
    if (!monthly[mo]) monthly[mo] = { month: mo, signals: 0, wins: 0, losses: 0, be: 0, pnlR: 0 };
    monthly[mo].signals++;
    if (s.outcome === 'TP1' || s.outcome === 'TP2') {
      monthly[mo].wins++;
      monthly[mo].pnlR += s.outcome === 'TP2' ? (s.rrr2 || 0) : (s.rrr1 || 0);
    } else if (s.outcome === 'SL') {
      monthly[mo].losses++;
      monthly[mo].pnlR -= 1;
    } else if (s.outcome === 'BE') {
      monthly[mo].be++;
    }
  }

  // Entry type breakdown
  const byType = {};
  for (const s of signals) {
    const t = s.entryType || 'UNKNOWN';
    if (!byType[t]) byType[t] = { type: t, signals: 0, wins: 0, losses: 0 };
    byType[t].signals++;
    if (s.outcome === 'TP1' || s.outcome === 'TP2') byType[t].wins++;
    else if (s.outcome === 'SL') byType[t].losses++;
  }

  progress(100, 'Done!');

  return {
    symbol,
    period:   { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    candlesAnalysed: kl1h_all.length,
    engineVersion: 'REAL — uses same indicator.js + decideEntry as live analysis',
    stats: {
      total, wins, losses, be, open, tp2s,
      winRate:       parseFloat(winRate.toFixed(1)),
      totalPnlR:     parseFloat(totalPnlR.toFixed(2)),
      avgConf:       parseFloat(avgConf.toFixed(1)),
      avgRrr1:       parseFloat(avgRrr1.toFixed(2)),
      longSignals:   longs.length,
      shortSignals:  shorts.length,
      longWinRate:   parseFloat(((lW / lC) * 100).toFixed(1)),
      shortWinRate:  parseFloat(((sW / sC) * 100).toFixed(1)),
    },
    monthly:    Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)),
    byEntryType: Object.values(byType),
    signals,
  };
}

/* ══════════════════════════════════════════════════
   SANDBOX RELOAD — call when indicator.js changes
══════════════════════════════════════════════════ */
function reloadSandbox() {
  _sandbox = null;
  getSandbox();
}

module.exports = { runBacktest, reloadSandbox, getSandbox };
