const express = require('express');
const path    = require('path');
const http    = require('http');
const WebSocket = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = 2000;
const HOST = '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ─── Market Data Store ─────────────────────────────────── */
let marketData  = {};   // symbol → ticker object
let topGainers  = [];
let tickerCoins = {};   // BTC, ETH, BNB, SOL, XRP snapshot

const WATCH_SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'];
const MIN_VOLUME_USDT = 5_000_000; // $5M min 24h volume for gainers

/* ─── Hardcoded Signals (replace with real analysis later) ─ */
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

/* ─── REST API Endpoints ────────────────────────────────── */
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
  res.json({ status: 'ok', clients: wss.clients.size, uptime: process.uptime() });
});

/* ─── WebSocket: Broadcast to browsers ─────────────────── */
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  console.log(`[WS] Client connected — total: ${wss.clients.size}`);

  // Send current snapshot immediately
  if (topGainers.length > 0) {
    ws.send(JSON.stringify({
      type: 'market_update',
      topGainers: topGainers.slice(0, 5),
      ticker: WATCH_SYMBOLS.map(s => marketData[s]).filter(Boolean)
    }));
  }

  ws.on('close', () => console.log(`[WS] Client left — total: ${wss.clients.size}`));
});

/* ─── Binance WebSocket Stream ──────────────────────────── */
function connectBinance() {
  const bWS = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');

  bWS.on('open', () => console.log('✅ Binance stream connected'));

  bWS.on('message', (raw) => {
    try {
      const tickers = JSON.parse(raw);

      // Update market data store
      tickers.forEach(t => {
        if (!t.s.endsWith('USDT')) return;
        if (/DOWN|UP|BEAR|BULL/.test(t.s)) return;
        marketData[t.s] = {
          symbol  : t.s,
          base    : t.s.replace('USDT',''),
          price   : parseFloat(t.c),
          change  : parseFloat(t.P),  // 24h % change
          volume  : parseFloat(t.q),  // 24h quote vol (USDT)
          high    : parseFloat(t.h),
          low     : parseFloat(t.l),
        };
      });

      // Snapshot watch coins
      WATCH_SYMBOLS.forEach(s => {
        if (marketData[s]) tickerCoins[s] = marketData[s];
      });

      // Top 5 gainers (min volume filter)
      topGainers = Object.values(marketData)
        .filter(t => t.volume >= MIN_VOLUME_USDT && t.price > 0.0001)
        .sort((a, b) => b.change - a.change)
        .slice(0, 5);

    } catch (e) { console.error('[Binance] Parse error:', e.message); }
  });

  bWS.on('error', err => console.error('[Binance] Error:', err.message));
  bWS.on('close', () => {
    console.log('[Binance] Disconnected — reconnecting in 5s...');
    setTimeout(connectBinance, 5000);
  });

  // Push to browsers every 2s
  const interval = setInterval(() => {
    if (topGainers.length === 0) return;
    broadcast({
      type      : 'market_update',
      topGainers: topGainers.slice(0, 5),
      ticker    : WATCH_SYMBOLS.map(s => marketData[s]).filter(Boolean)
    });
  }, 2000);

  bWS.on('close', () => clearInterval(interval));
}

connectBinance();

server.listen(PORT, HOST, () => {
  console.log(`🚀 InvestySignals running → http://${HOST}:${PORT}`);
});
