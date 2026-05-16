'use strict';
/**
 * InvestySignals — Backtest Engine v3.0
 * Uses REAL indicator.js + decideEntry from analysis.html via vm sandbox.
 * No duplicate indicator code — add new indicator → auto works in backtest.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const vm    = require('vm');

/* ══════════════════════════════════════════════════
   VM SANDBOX — loads real indicator.js + analysis.html
══════════════════════════════════════════════════ */

let _sandbox = null;

function getSandbox() {
  if (_sandbox) return _sandbox;

  const indicatorPath = path.join(__dirname, 'public', 'analysis', 'indicator.js');
  const analysisPath  = path.join(__dirname, 'public', 'analysis.html');
  if (!fs.existsSync(indicatorPath)) throw new Error('indicator.js not found: ' + indicatorPath);
  if (!fs.existsSync(analysisPath))  throw new Error('analysis.html not found: ' + analysisPath);

  // Mock browser globals
  const sandbox = vm.createContext({
    window: { ISETTINGS: {}, ISETTINGS_LOADED: true, _auth: null },
    fetch:  () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      getElementById:    () => ({ textContent: '', style: {}, innerHTML: '' }),
      querySelector:     () => null,
      querySelectorAll:  () => [],
      addEventListener:  () => {},
    },
    Promise, Math, Date, Array, Object, String, Number, Boolean,
    JSON, parseInt, parseFloat, isNaN, isFinite, console,
    setTimeout: () => {}, clearTimeout: () => {},
    setInterval: () => {}, clearInterval: () => {},
    Infinity, NaN, undefined, globalThis: {},
    navigator: { userAgent: '' },
    location:  { href: '' },
  });

  // ── Load indicator.js ──
  let indCode = fs.readFileSync(indicatorPath, 'utf8');
  // Remove top-level calls that need browser
  indCode = indCode
    .replace(/^loadGlobalIndicatorSettings\(\);\s*$/m, '/* no-op */')
    .replace(/window\.loadGlobalIndicatorSettings\s*=\s*loadGlobalIndicatorSettings;?/g, '/* no-op */');
  vm.runInContext(indCode, sandbox, { filename: 'indicator.js', timeout: 15000 });

  // ── Extract main script block from analysis.html ──
  const html = fs.readFileSync(analysisPath, 'utf8');
  const START_MARKER = '<script>\n/* ================================================================';
  const startIdx = html.indexOf(START_MARKER);
  if (startIdx === -1) throw new Error('Cannot find main script block in analysis.html');
  const endIdx = html.indexOf('</script>', startIdx);
  let jsCode = html.slice(startIdx + 8, endIdx);

  // Only remove ES module syntax (not compatible with vm)
  jsCode = jsCode
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '');

  vm.runInContext(jsCode, sandbox, { filename: 'analysis.html', timeout: 30000 });

  _sandbox = sandbox;
  return sandbox;
}

function reloadSandbox() { _sandbox = null; getSandbox(); }

/* ══════════════════════════════════════════════════
   HTTP / KLINES FETCH
══════════════════════════════════════════════════ */

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchKlines(symbol, interval, startMs, endMs) {
  const all = [];
  let from = startMs;
  while (from < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${endMs}&limit=1000`;
    const batch = await httpsGet(url);
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    from = parseInt(batch[batch.length - 1][0]) + 1;
    await new Promise(r => setTimeout(r, 100));
  }
  return all;
}

function klinesUpTo(klines, tsMs) {
  const idx = klines.findIndex(k => parseInt(k[0]) > tsMs);
  return idx === -1 ? klines : klines.slice(0, idx);
}

/* ══════════════════════════════════════════════════
   RUN decideEntry ON HISTORICAL SLICE
   Uses EXACT same flow as runDeepScan in analysis.html
══════════════════════════════════════════════════ */

function runDecideEntry(fn, kl1h, kl4h, kl1d, kl15m) {
  try {
    const p  = a => parseFloat(a);
    const C   = kl1h.map(k=>p(k[4])),  H  = kl1h.map(k=>p(k[2])),  L  = kl1h.map(k=>p(k[3])),  V  = kl1h.map(k=>p(k[5])),  O  = kl1h.map(k=>p(k[1]));
    const C4  = kl4h.map(k=>p(k[4])),  H4 = kl4h.map(k=>p(k[2])),  L4 = kl4h.map(k=>p(k[3])),  O4 = kl4h.map(k=>p(k[1]));
    const C15 = kl15m.map(k=>p(k[4])), H15= kl15m.map(k=>p(k[2])), L15= kl15m.map(k=>p(k[3])), O15= kl15m.map(k=>p(k[1]));
    const C1D = kl1d.map(k=>p(k[4])),  H1D= kl1d.map(k=>p(k[2])), L1D= kl1d.map(k=>p(k[3])), O1D= kl1d.map(k=>p(k[1]));
    const curP = C[C.length - 1];

    // Core indicators
    const rsi   = fn.calcRSI(C, 14);
    const vol   = fn.analyzeVolume(kl1h);
    const macd  = fn.calcMACD(C);
    const bb    = fn.calcBollingerBands(C);
    const stoch = fn.calcStochasticRSI ? fn.calcStochasticRSI(C) : null;
    const atr   = fn.calcATR(H, L, C);
    const adx   = fn.calcADX(H, L, C);
    const obv   = fn.calcOBV(C, V);
    const es    = fn.calcEMAStack(C);
    const vwap  = fn.calcVWAP(kl1h);
    const spt   = fn.calcSupertrend(H, L, C);
    const bos   = fn.detectBOS(H, L, C);
    const div   = fn.detectDivergenceFull ? fn.detectDivergenceFull(C,H,L,V) : (fn.detectDivergence ? fn.detectDivergence(C,H,L,V) : null);

    if (!rsi || !atr || !adx) return null;

    // MTF
    const mRSI    = fn.calcMTFRSI(C, C4, C15, C1D);
    const t4      = fn.calc4HTrend(kl4h);
    const ema15m  = fn.calcEMAStack(C15);
    const ema1d   = fn.calcEMAStack(C1D);
    const bos15m  = fn.detectBOS(H15, L15, C15, 30);
    const bos4h   = fn.detectBOS(H4,  L4,  C4,  35);
    const rsi15m  = fn.calcRSI(C15, 14);
    const rsi1d   = fn.calcRSI(C1D, 14);
    const rsi1hArr= fn.calcRSIArray(C,   14);
    const rsi4hArr= fn.calcRSIArray(C4,  14);
    const rsi1dArr= fn.calcRSIArray(C1D, 14);
    const trendLine   = fn.calcTrendLine ? fn.calcTrendLine(C,   H,   L,   50) : null;
    const trendLine4h = fn.calcTrendLine ? fn.calcTrendLine(C4,  H4,  L4,  40) : null;

    // Order blocks + FVG
    const ob15m = fn.detectOrderBlocks(O15,H15,L15,C15,'15m');
    const ob1h  = fn.detectOrderBlocks(O,  H,  L,  C,  '1H');
    const ob4h  = fn.detectOrderBlocks(O4, H4, L4, C4, '4H');
    const ob1d  = fn.detectOrderBlocks(O1D,H1D,L1D,C1D,'1D');
    const allBull = [...ob1d.bullOBs,...ob4h.bullOBs,...ob1h.bullOBs,...ob15m.bullOBs];
    const allBear = [...ob1d.bearOBs,...ob4h.bearOBs,...ob1h.bearOBs,...ob15m.bearOBs];
    const sortDist = (a,b) => Math.abs(curP-a.mid)-Math.abs(curP-b.mid);
    const mtfOBs = {
      bullOBs: allBull.slice(0,5), bearOBs: allBear.slice(0,5),
      nearestBullOB: allBull.sort(sortDist)[0] || null,
      nearestBearOB: allBear.sort(sortDist)[0] || null,
    };
    const mtfFVGs = fn.detectFVGMultiTF ? fn.detectFVGMultiTF(kl15m,kl1h,kl4h,kl1d) : { bullFVGs:[], bearFVGs:[] };

    // S/R, Fib, Regime
    const atrVal  = atr?.atr || curP * 0.01;
    const srZones = fn.buildSRZones ? fn.buildSRZones(kl15m,kl1h,kl4h,kl1d,curP,atrVal) : { above:[], below:[] };
    const fibonacci = fn.calcFibonacciMTF ? fn.calcFibonacciMTF(kl15m,kl1h,kl4h,kl1d,curP,atr) : null;
    const regime    = fn.detectMarketRegime ? fn.detectMarketRegime(C,H,L,V,adx,bb,atr) : null;
    const rvol      = fn.calcRVOL ? fn.calcRVOL(kl1h) : null;

    // SMC extras
    const liqSweeps   = fn.detectLiquiditySweeps ? fn.detectLiquiditySweeps(H,L,C,O,atr) : null;
    const liqSweeps15 = fn.detectLiquiditySweeps ? fn.detectLiquiditySweeps(H15,L15,C15,O15,atr) : null;
    const breakers    = fn.detectBreakerBlocks ? fn.detectBreakerBlocks(O,H,L,C,atr) : null;
    const breakers4h  = fn.detectBreakerBlocks ? fn.detectBreakerBlocks(O4,H4,L4,C4,atr) : null;
    const oteZone     = fn.calcOTEZone ? fn.calcOTEZone(H,L,C,O,atr,bos) : null;
    const killzone    = fn.getICTKillzone ? fn.getICTKillzone() : null;
    const amdModel    = fn.detectAMDModel ? fn.detectAMDModel(O,H,L,C,V,atr) : null;
    const vsa         = fn.detectVSA ? fn.detectVSA(O,H,L,C,V,atr) : null;
    const wyckoff     = fn.detectWyckoff ? fn.detectWyckoff(O,H,L,C,V,atr) : null;
    const premDisc    = fn.calcPremiumDiscount ? fn.calcPremiumDiscount(H,L,C,atr) : null;
    const harmonics   = fn.detectHarmonicPatterns ? fn.detectHarmonicPatterns(H,L,C,atr) : null;
    const cvdData     = fn.calcCVD ? fn.calcCVD(O,H,L,C,V,null) : null;
    const unmit       = fn.filterUnmitigated ? fn.filterUnmitigated(mtfOBs,mtfFVGs,H,L,C) : null;
    const marketProf  = fn.calcMarketProfile ? fn.calcMarketProfile(H,L,C,V,atr) : null;
    const mtfDiv      = fn.calcMTFDivergence ? fn.calcMTFDivergence(C,rsi1hArr,C4,rsi4hArr,C1D,rsi1dArr,null) : null;
    const roundLevels = fn.calcRoundLevels ? fn.calcRoundLevels(curP,atr) : null;
    const candlePatterns   = fn.detectCandlePatterns ? fn.detectCandlePatterns(O,H,L,C) : null;
    const candlePatterns4h = fn.detectCandlePatterns ? fn.detectCandlePatterns(O4,H4,L4,C4) : null;
    const pivotPoints = fn.calcPivotPoints ? fn.calcPivotPoints(kl1d) : null;
    const setupType   = fn.classifySetupType ? fn.classifySetupType(adx,bb,atr,rsi,premDisc,regime,wyckoff,liqSweeps,bos,candlePatterns,{ratio:vol}) : null;
    const crtSignal   = fn.detectCRT ? fn.detectCRT(O,H,L,C,atr) : null;
    const skAnalysis  = fn.detectSKSystem ? fn.detectSKSystem(O,H,L,C,V,atr,bos,mtfOBs) : null;
    const ipdaLevels  = fn.calcIPDALevels ? fn.calcIPDALevels(H,L,C,kl1d,kl4h) : null;
    const propulsion  = fn.detectPropulsionBlock ? fn.detectPropulsionBlock(O,H,L,C,atr) : null;
    const footprint   = fn.calcFootprintLite ? fn.calcFootprintLite(O,H,L,C,V,atr) : null;
    const session     = fn.getSession ? fn.getSession() : { session:'Unknown', quality:'medium' };

    const ex = {
      trend4h: t4, fundingRate: null, oiChange: null, divergence: div,
      emaStack: es, vwap, supertrend: spt, bos, mtfRSI: mRSI, session,
      btcContext: null, srZones, fibonacci, trendLine, trendLine4h,
      mtfOBs, mtfFVGs, ema15m, ema1d, rsi15m, rsi1d, bos15m, bos4h,
      liqSweeps, liqSweeps15, breakers, breakers4h, oteZone, killzone,
      amdModel, vsa, wyckoff, premDisc, harmonics, cvdData,
      unmitLevels: unmit, marketProf, mtfDiv, roundLevels,
      setupType, crtSignal, skAnalysis, ipdaLevels, propulsion, footprint,
      candlePatterns, candlePatterns4h, pivotPoints, regime,
      takerRatio: null, lsRatio: null, orderBook: null,
      rvol, candleCloseTimer: null,
    };

    const entry = fn.decideEntry(rsi, vol, O, C, H, L, curP, macd, bb, stoch, adx, obv, atr, ex);
    if (!entry || entry.hardBlock)           return null;
    if (!entry.direction || entry.direction === 'NEUTRAL') return null;
    // Backtest gate: 62 (live gate is 65; backtest scores ~3pts lower due to missing OI/taker/OB live data)
    // Previously 40 — that's why 91% of trades were low-confidence garbage signals
    if ((entry.confidence || 0) < 62)        return null;
    if (!entry.slPrice || !entry.tp1Price)   return null;

    return {
      dir:       entry.direction,
      conf:      entry.confidence,
      ep:        entry.entryPrice || curP,
      sl:        entry.slPrice,
      tp1:       entry.tp1Price,
      tp2:       entry.tp2Price,
      tp3:       entry.tp3Price || null,
      rrr1:      parseFloat(entry.rrr1) || 0,
      rrr2:      parseFloat(entry.rrr2) || 0,
      rrr3:      parseFloat(entry.rrr3) || 0,
      rsi, adx:  adx?.adx,
      trend4h:   t4?.bias,
      entryType: entry.entryType,
    };
  } catch (e) {
    return null;
  }
}

/* ══════════════════════════════════════════════════
   OUTCOME CHECKER — forward-check TP/SL
══════════════════════════════════════════════════ */

function checkOutcome(dir, ep, sl, tp1, tp2, futureKlines) {
  let tp1Hit = false, tp2Hit = false, slHit = false;
  let tp1Candle = null, tp2Candle = null, slCandle = null;
  let closePrice = null, closeCandle = null;

  // After TP1 hit, SL moves to breakeven (entry price)
  // This correctly models: partial close at TP1, remainder runs to TP2 or BE
  let dynamicSL = sl; // starts at original SL

  for (let i = 0; i < futureKlines.length; i++) {
    const h = parseFloat(futureKlines[i][2]);
    const l = parseFloat(futureKlines[i][3]);
    const c = parseFloat(futureKlines[i][4]);

    if (dir === 'LONG') {
      // On same candle: assume bullish wick hits TP1 before bearish wick hits SL
      // (realistic: if candle wicks both ways, partial fill at TP1 protects some profit)
      if (!tp1Hit && h >= tp1) {
        tp1Hit = true;
        tp1Candle = i;
        dynamicSL = ep; // move SL to breakeven after TP1
      }
      // Check TP2 (only after TP1)
      if (tp1Hit && h >= tp2) {
        tp2Hit = true; tp2Candle = i;
        closePrice = tp2; closeCandle = i;
        break;
      }
      // Check SL (dynamic — moved to entry after TP1)
      if (l <= dynamicSL) {
        slHit = true; slCandle = i;
        closePrice = tp1Hit ? ep : sl;
        closeCandle = i;
        break;
      }
    } else { // SHORT
      // On same candle: bearish wick hits TP1 before bullish wick hits SL
      if (!tp1Hit && l <= tp1) {
        tp1Hit = true;
        tp1Candle = i;
        dynamicSL = ep;
      }
      if (tp1Hit && l <= tp2) {
        tp2Hit = true; tp2Candle = i;
        closePrice = tp2; closeCandle = i;
        break;
      }
      if (h >= dynamicSL) {
        slHit = true; slCandle = i;
        closePrice = tp1Hit ? ep : sl;
        closeCandle = i;
        break;
      }
    }
  }

  // Timed out — close at last candle price
  if (!slHit && !tp2Hit) {
    const last = futureKlines[futureKlines.length - 1];
    closePrice  = last ? parseFloat(last[4]) : ep;
    closeCandle = futureKlines.length - 1;
  }

  let outcome = 'OPEN';
  if (tp2Hit)             outcome = 'TP2';
  else if (tp1Hit && slHit) outcome = 'BE';   // TP1 taken, remainder stopped at entry = breakeven
  else if (tp1Hit)          outcome = 'TP1';  // TP1 taken, trade still open at end of window
  else if (slHit)           outcome = 'SL';

  const risk = dir === 'LONG' ? ep - sl : sl - ep;

  // PnL calculation — model partial close:
  // 50% at TP1, 50% at TP2/SL/close. More realistic than all-in.
  let pnlR = 0;
  if (risk > 0) {
    if (outcome === 'TP2') {
      // 50% at TP1 + 50% at TP2
      const r1 = dir === 'LONG' ? (tp1 - ep) / risk : (ep - tp1) / risk;
      const r2 = dir === 'LONG' ? (tp2 - ep) / risk : (ep - tp2) / risk;
      pnlR = parseFloat((0.5 * r1 + 0.5 * r2).toFixed(3));
    } else if (outcome === 'BE') {
      // 50% at TP1 + 50% at 0 (entry) = half the TP1 gain
      const r1 = dir === 'LONG' ? (tp1 - ep) / risk : (ep - tp1) / risk;
      pnlR = parseFloat((0.5 * r1).toFixed(3));
    } else if (outcome === 'TP1') {
      // 50% at TP1, remainder open — count 50% TP1 gain only
      const r1 = dir === 'LONG' ? (tp1 - ep) / risk : (ep - tp1) / risk;
      pnlR = parseFloat((0.5 * r1).toFixed(3));
    } else if (outcome === 'SL') {
      pnlR = -1; // full loss
    } else {
      // OPEN — mark to market
      pnlR = closePrice !== null
        ? parseFloat(((dir === 'LONG' ? closePrice - ep : ep - closePrice) / risk).toFixed(3))
        : 0;
    }
  }

  return { outcome, tp1Hit, tp2Hit, slHit, closePrice, closeCandle, pnlR };
}

/* ══════════════════════════════════════════════════
   MAIN runBacktest
══════════════════════════════════════════════════ */

async function runBacktest(symbol, startMs, endMs, onProgress) {
  const progress = onProgress || (() => {});

  progress(3, 'Loading indicator engine…');
  const sandbox = getSandbox();

  progress(8,  `Fetching 15m klines…`);
  const kl15m_all = await fetchKlines(symbol, '15m', startMs - 86400000 * 3, endMs);
  progress(18, `Fetching 1H klines…`);
  const kl1h_all  = await fetchKlines(symbol, '1h',  startMs, endMs);
  if (!kl1h_all.length) throw new Error(`No 1H data for ${symbol}`);
  progress(30, `Fetching 4H klines…`);
  const kl4h_all  = await fetchKlines(symbol, '4h',  startMs - 86400000 * 30, endMs);
  progress(38, `Fetching 1D klines…`);
  const kl1d_all  = await fetchKlines(symbol, '1d',  startMs - 86400000 * 60, endMs);
  progress(44, `Analysing ${kl1h_all.length} candles…`);

  const signals = [];
  const WARMUP    = 220;
  const MIN_FUTURE = 24;
  const SCAN_STEP  = 6;  // was 4 — scan every 6 candles instead of 4
  const MIN_GAP    = 24; // was 12 — minimum 24H gap between signals to avoid over-trading
  let lastSig = -999;

  for (let i = WARMUP; i < kl1h_all.length - MIN_FUTURE; i += SCAN_STEP) {
    if (i - lastSig < MIN_GAP) continue;

    const ts     = parseInt(kl1h_all[i][0]);
    const sl1h   = kl1h_all.slice(Math.max(0, i - 249), i + 1);
    const sl15m  = klinesUpTo(kl15m_all, ts).slice(-150);
    const sl4h   = klinesUpTo(kl4h_all,  ts).slice(-100);
    const sl1d   = klinesUpTo(kl1d_all,  ts).slice(-60);

    if (sl4h.length < 30 || sl1d.length < 10 || sl15m.length < 50) continue;

    const sig = runDecideEntry(sandbox, sl1h, sl4h, sl1d, sl15m);
    if (!sig) continue;

    const future = kl1h_all.slice(i + 1, i + 1 + 168);
    const res    = checkOutcome(sig.dir, sig.ep, sig.sl, sig.tp1, sig.tp2, future);

    const openDate  = new Date(ts).toISOString().split('T')[0];
    const closeDate = res.closeCandle !== null
      ? new Date(parseInt(kl1h_all[Math.min(i + 1 + res.closeCandle, kl1h_all.length - 1)][0])).toISOString().split('T')[0]
      : null;

    signals.push({
      symbol, openTime: ts, openDate, closeDate,
      direction:  sig.dir,
      confidence: sig.conf,
      entryType:  sig.entryType || '',
      entryPrice: +sig.ep.toFixed(6),
      tp1:        +sig.tp1.toFixed(6),
      tp2:        +sig.tp2.toFixed(6),
      sl:         +sig.sl.toFixed(6),
      rrr1:       sig.rrr1,
      rrr2:       sig.rrr2,
      rsi:        +((sig.rsi||0).toFixed(2)),
      adx:        +((sig.adx||0).toFixed(2)),
      trend4h:    sig.trend4h || 'neutral',
      outcome:    res.outcome,
      tp1Hit:     res.tp1Hit,
      tp2Hit:     res.tp2Hit,
      slHit:      res.slHit,
      closePrice: res.closePrice ? +res.closePrice.toFixed(6) : null,
      pnlR:       res.pnlR,
    });

    lastSig = i;

    if (i % 40 === 0) {
      const pct = 44 + Math.round(((i - WARMUP) / (kl1h_all.length - WARMUP - MIN_FUTURE)) * 48);
      progress(Math.min(pct, 90), `${i}/${kl1h_all.length} candles — ${signals.length} signals…`);
    }
  }

  progress(92, 'Computing statistics…');

  const total   = signals.length;
  const wins    = signals.filter(s => s.outcome==='TP1'||s.outcome==='TP2').length;
  const losses  = signals.filter(s => s.outcome==='SL').length;
  const be      = signals.filter(s => s.outcome==='BE').length;
  const open    = signals.filter(s => s.outcome==='OPEN').length;
  const tp2s    = signals.filter(s => s.outcome==='TP2').length;
  const closed  = wins + losses + be || 1;
  const winRate = (wins / closed) * 100;

  const totalPnlR = signals.reduce((s, x) => {
    if (x.outcome==='TP2') return s + (x.rrr2||0);
    if (x.outcome==='TP1') return s + (x.rrr1||0);
    if (x.outcome==='SL')  return s - 1;
    return s;
  }, 0);

  const longs   = signals.filter(s => s.direction==='LONG');
  const shorts  = signals.filter(s => s.direction==='SHORT');
  const lW      = longs.filter(s => s.outcome==='TP1'||s.outcome==='TP2').length;
  const sW      = shorts.filter(s => s.outcome==='TP1'||s.outcome==='TP2').length;
  const lC      = (longs.filter(s=>s.outcome!=='OPEN').length)||1;
  const sC      = (shorts.filter(s=>s.outcome!=='OPEN').length)||1;

  // Monthly
  const monthly = {};
  for (const s of signals) {
    const mo = s.openDate.slice(0,7);
    if (!monthly[mo]) monthly[mo] = { month:mo, signals:0, wins:0, losses:0, be:0, pnlR:0 };
    monthly[mo].signals++;
    if (s.outcome==='TP1'||s.outcome==='TP2') { monthly[mo].wins++; monthly[mo].pnlR += s.outcome==='TP2'?(s.rrr2||0):(s.rrr1||0); }
    else if (s.outcome==='SL')  { monthly[mo].losses++; monthly[mo].pnlR -= 1; }
    else if (s.outcome==='BE')    monthly[mo].be++;
  }

  // Entry type breakdown
  const byType = {};
  for (const s of signals) {
    const t = s.entryType || 'UNKNOWN';
    if (!byType[t]) byType[t] = { type:t, signals:0, wins:0, losses:0 };
    byType[t].signals++;
    if (s.outcome==='TP1'||s.outcome==='TP2') byType[t].wins++;
    else if (s.outcome==='SL') byType[t].losses++;
  }

  progress(100, 'Done!');

  return {
    symbol,
    period: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    candlesAnalysed: kl1h_all.length,
    engineVersion: 'v3 — uses real indicator.js + decideEntry from analysis.html',
    stats: {
      total, wins, losses, be, open, tp2s,
      winRate:      +winRate.toFixed(1),
      totalPnlR:    +totalPnlR.toFixed(2),
      avgConf:      total>0 ? +(signals.reduce((s,x)=>s+x.confidence,0)/total).toFixed(1) : 0,
      avgRrr1:      total>0 ? +(signals.reduce((s,x)=>s+(x.rrr1||0),0)/total).toFixed(2) : 0,
      longSignals:  longs.length,
      shortSignals: shorts.length,
      longWinRate:  +((lW/lC)*100).toFixed(1),
      shortWinRate: +((sW/sC)*100).toFixed(1),
    },
    monthly:     Object.values(monthly).sort((a,b)=>a.month.localeCompare(b.month)),
    byEntryType: Object.values(byType),
    signals,
  };
}

module.exports = { runBacktest, reloadSandbox, getSandbox };
