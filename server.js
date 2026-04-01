const express   = require('express');
const path      = require('path');
const http      = require('http');
const WebSocket = require('ws');
const https     = require('https');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = 2000;
const HOST = '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ═══════════════════════════════════════════════════════
   Market Data Store
═══════════════════════════════════════════════════════ */
let marketData   = {};   // symbol → { symbol, base, price, change, volume, high, low }
let topGainers   = [];   // top 5 sorted by 24h change
let tickerCoins  = {};   // BTC, ETH, BNB, SOL, XRP snapshot

const WATCH_SYMBOLS   = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
const MIN_VOLUME_USDT = 10_000_000;  // $10M minimum 24h volume
const EXCLUDE_SYMBOLS = new Set([
  'USDCUSDT','BUSDUSDT','TUSDUSDT','USDTUSDT','DAIUSDT',
  'FDUSDUSDT','EURUSDT','GBPUSDT','AUDUSDT','BRLBUSD'
]);

/* ═══════════════════════════════════════════════════════
   Hardcoded Signals
═══════════════════════════════════════════════════════ */
const SIGNALS = [
  {
    id: 1, pair: 'BTC/USDT', coin: 'BTC', emoji: '₿',
    direction: 'LONG', timeframe: '4H',
    entry: 83500, tp1: 87000, tp2: 91500, sl: 80000,
    grade: 'A+', rrr: '2.1:1', status: 'ACTIVE',
    confidence: 92, posted: '2026-04-01 08:00', exchange: 'Binance Futures'
  },
  {
    id: 2, pair: 'ETH/USDT', coin: 'ETH', emoji: 'Ξ',
    direction: 'LONG', timeframe: '1H',
    entry: 1870, tp1: 1980, tp2: 2100, sl: 1800,
    grade: 'A', rrr: '2.4:1', status: 'ACTIVE',
    confidence: 85, posted: '2026-04-01 09:30', exchange: 'Binance Futures'
  },
  {
    id: 3, pair: 'SOL/USDT', coin: 'SOL', emoji: '◎',
    direction: 'SHORT', timeframe: '4H',
    entry: 142, tp1: 128, tp2: 118, sl: 150,
    grade: 'B+', rrr: '1.8:1', status: 'WAITING',
    confidence: 78, posted: '2026-04-01 10:00', exchange: 'Binance Futures'
  },
  {
    id: 4, pair: 'BNB/USDT', coin: 'BNB', emoji: '◆',
    direction: 'LONG', timeframe: '1D',
    entry: 575, tp1: 620, tp2: 660, sl: 548,
    grade: 'A', rrr: '2.2:1', status: 'ACTIVE',
    confidence: 88, posted: '2026-03-31 18:00', exchange: 'Binance Futures'
  },
  {
    id: 5, pair: 'XRP/USDT', coin: 'XRP', emoji: '✕',
    direction: 'LONG', timeframe: '4H',
    entry: 2.08, tp1: 2.35, tp2: 2.60, sl: 1.92,
    grade: 'A+', rrr: '2.8:1', status: 'ACTIVE',
    confidence: 91, posted: '2026-04-01 06:00', exchange: 'Binance Futures'
  },
  {
    id: 6, pair: 'DOGE/USDT', coin: 'DOGE', emoji: 'Ð',
    direction: 'SHORT', timeframe: '1H',
    entry: 0.178, tp1: 0.155, tp2: 0.140, sl: 0.190,
    grade: 'B', rrr: '1.9:1', status: 'CLOSED',
    confidence: 74, posted: '2026-03-31 12:00', exchange: 'Binance Futures'
  },
];

/* ═══════════════════════════════════════════════════════
   REST API Endpoints
═══════════════════════════════════════════════════════ */
app.get('/api/signals', (req, res) => {
  res.json({ success: true, count: SIGNALS.length, data: SIGNALS });
});

app.get('/api/market/top-gainers', (req, res) => {
  res.json({ success: true, data: topGainers.slice(0, 5) });
});

app.get('/api/market/ticker', (req, res) => {
  res.json({ success: true, data: tickerCoins });
});

app.get('/health', (req, res) => {
  res.json({
    status      : 'ok',
    clients     : wss.clients.size,
    uptime      : process.uptime(),
    marketCoins : Object.keys(marketData).length,
    topGainers  : topGainers.length,
    wsState     : binanceWsState,
  });
});

/* ═══════════════════════════════════════════════════════
   Helpers
═══════════════════════════════════════════════════════ */
function parseTicker(t) {
  /* Works for both:
     WS  !miniTicker@arr  → fields: s, c, P, q, h, l
     REST ticker/24hr     → fields: symbol, lastPrice, priceChangePercent, quoteVolume, highPrice, lowPrice */
  const symbol = t.s      || t.symbol;
  const price  = parseFloat(t.c  || t.lastPrice             || 0);
  const change = parseFloat(t.P  || t.priceChangePercent    || 0);
  const volume = parseFloat(t.q  || t.quoteVolume           || 0);
  const high   = parseFloat(t.h  || t.highPrice             || 0);
  const low    = parseFloat(t.l  || t.lowPrice              || 0);
  return { symbol, base: symbol.replace('USDT',''), price, change, volume, high, low };
}

function isValidTicker(obj) {
  if (!obj.symbol || !obj.symbol.endsWith('USDT'))  return false;
  if (EXCLUDE_SYMBOLS.has(obj.symbol))               return false;
  if (/DOWN|UP|BEAR|BULL|LONG|SHORT|3L|3S|5L|5S/.test(obj.symbol)) return false;
  if (obj.price  <= 0) return false;
  if (obj.volume <= 0) return false;
  return true;
}

function rebuildTopGainers() {
  topGainers = Object.values(marketData)
    .filter(t => t.volume >= MIN_VOLUME_USDT)
    .sort((a, b) => b.change - a.change)
    .slice(0, 5);
}

function refreshTickerSnapshot() {
  WATCH_SYMBOLS.forEach(s => {
    if (marketData[s]) tickerCoins[s] = marketData[s];
  });
}

/* ═══════════════════════════════════════════════════════
   REST Fallback — Binance /api/v3/ticker/24hr
   Called on startup to pre-fill data before WS connects,
   and automatically when WS is down.
═══════════════════════════════════════════════════════ */
let restFallbackTimer = null;

function fetchViaREST() {
  const url = 'https://api.binance.com/api/v3/ticker/24hr';
  console.log('[REST] Fetching full ticker snapshot…');

  const req = https.get(url, { timeout: 12000 }, (res) => {
    if (res.statusCode !== 200) {
      console.error('[REST] HTTP', res.statusCode);
      res.resume();
      return;
    }
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const tickers = JSON.parse(raw);
        let count = 0;
        tickers.forEach(t => {
          const obj = parseTicker(t);
          if (!isValidTicker(obj)) return;
          marketData[obj.symbol] = obj;
          count++;
        });
        refreshTickerSnapshot();
        rebuildTopGainers();
        console.log(`[REST] ✅ Loaded ${count} coins — topGainers: ${topGainers.map(g => g.base + ' ' + g.change.toFixed(2) + '%').join(', ')}`);
        broadcastUpdate();
      } catch (e) {
        console.error('[REST] Parse error:', e.message);
      }
    });
  });
  req.on('error', err => console.error('[REST] Request error:', err.message));
  req.on('timeout', ()   => { req.destroy(); console.error('[REST] Timeout'); });
}

/* ═══════════════════════════════════════════════════════
   Browser WebSocket — broadcast to all connected browsers
═══════════════════════════════════════════════════════ */
function broadcastUpdate() {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify({
    type      : 'market_update',
    topGainers: topGainers.slice(0, 5),
    ticker    : WATCH_SYMBOLS.map(s => marketData[s]).filter(Boolean),
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (_) {}
    }
  });
}

wss.on('connection', (ws) => {
  console.log(`[WS:Browser] Client connected — total: ${wss.clients.size}`);

  // Send current snapshot immediately so the browser shows data right away
  const snap = {
    type      : 'market_update',
    topGainers: topGainers.slice(0, 5),
    ticker    : WATCH_SYMBOLS.map(s => marketData[s]).filter(Boolean),
  };
  try { ws.send(JSON.stringify(snap)); } catch (_) {}

  ws.on('close', () => console.log(`[WS:Browser] Client left — total: ${wss.clients.size}`));
  ws.on('error', () => {});
});

/* ═══════════════════════════════════════════════════════
   Binance WebSocket — !miniTicker@arr live stream
═══════════════════════════════════════════════════════ */
let binanceWs      = null;
let binanceWsState = 'disconnected';
let broadcastTimer = null;
let reconnectTimer = null;
let reconnectDelay = 3000;
let healthTimer    = null;
let lastMessageAt  = 0;

const MAX_RECONNECT_DELAY = 60000;

function startBroadcastLoop() {
  if (broadcastTimer) return;
  broadcastTimer = setInterval(broadcastUpdate, 2000);
  console.log('[Broadcast] Loop started (2s interval)');
}

function stopBroadcastLoop() {
  if (!broadcastTimer) return;
  clearInterval(broadcastTimer);
  broadcastTimer = null;
  console.log('[Broadcast] Loop stopped');
}

function startHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    if (binanceWsState !== 'connected') return;
    const silentMs = Date.now() - lastMessageAt;
    if (silentMs > 45000) {
      console.warn(`[Binance] No message for ${Math.round(silentMs/1000)}s — forcing reconnect`);
      if (binanceWs) {
        try { binanceWs.terminate(); } catch (_) {}
      }
    }
  }, 15000);
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  // While WS is down, keep data fresh via REST every 30s
  if (restFallbackTimer) clearTimeout(restFallbackTimer);
  restFallbackTimer = setTimeout(fetchViaREST, 8000);

  console.log(`[Binance] Reconnecting in ${reconnectDelay / 1000}s…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBinance();
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 1.6, MAX_RECONNECT_DELAY);
}

function connectBinance() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  binanceWsState = 'connecting';
  console.log('[Binance] Connecting to Binance !miniTicker@arr …');

  let ws;
  try {
    ws = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr', {
      handshakeTimeout: 15000,
    });
  } catch (e) {
    console.error('[Binance] Constructor error:', e.message);
    scheduleReconnect();
    return;
  }

  binanceWs = ws;

  /* ── open ── */
  ws.on('open', () => {
    console.log('✅ Binance stream CONNECTED');
    binanceWsState = 'connected';
    reconnectDelay = 3000;       // reset backoff
    lastMessageAt  = Date.now();
    startBroadcastLoop();
    startHealthCheck();
  });

  /* ── message ── */
  ws.on('message', (raw) => {
    lastMessageAt = Date.now();
    try {
      const tickers = JSON.parse(raw);
      if (!Array.isArray(tickers)) return;

      tickers.forEach(t => {
        const obj = parseTicker(t);
        if (!isValidTicker(obj)) return;
        marketData[obj.symbol] = obj;
      });

      refreshTickerSnapshot();
      rebuildTopGainers();
    } catch (e) {
      console.error('[Binance] Parse error:', e.message);
    }
  });

  /* ── error ── */
  ws.on('error', (err) => {
    console.error('[Binance] Error:', err.message);
    // 'close' fires right after 'error' — let close handle reconnect
  });

  /* ── close ── (single handler — no leaks) ── */
  ws.on('close', (code, reason) => {
    const why = reason ? reason.toString() : 'none';
    console.log(`[Binance] DISCONNECTED — code:${code}  reason:${why}`);
    binanceWsState = 'disconnected';
    stopBroadcastLoop();
    scheduleReconnect();
  });
}

/* ═══════════════════════════════════════════════════════
   Startup
   Step 1: Fetch REST snapshot immediately (data ready before WS)
   Step 2: After 2s, open Binance WS stream
═══════════════════════════════════════════════════════ */
fetchViaREST();
setTimeout(connectBinance, 2000);

server.listen(PORT, HOST, () => {
  console.log(`🚀 InvestySignals running → http://${HOST}:${PORT}`);
});
