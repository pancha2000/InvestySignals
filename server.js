/**
 * InvestySignals — Server
 * ─────────────────────────────────────────────────────────────
 * Existing features preserved:
 *   • Static file serving (public/)
 *   • Binance WebSocket live market stream
 *   • REST fallback for market data
 *   • Browser WebSocket broadcast
 *   • Hardcoded signals (kept — MongoDB signals take priority)
 *
 * New additions:
 *   • MongoDB via Mongoose (signals, settings, announcements, stats)
 *   • Admin REST API  /api/admin/*  (JWT protected)
 *   • Public API      /api/signals  now serves MongoDB signals
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express   = require('express');
const path      = require('path');
const http      = require('http');
const WebSocket = require('ws');
const https     = require('https');
const mongoose  = require('mongoose');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 2000;
const HOST = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'dev_secret_change_in_production';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ═══════════════════════════════════════════════════════
   MONGODB SCHEMAS
═══════════════════════════════════════════════════════ */

/* Signal Schema */
const signalSchema = new mongoose.Schema({
  pair:       { type: String, required: true },   // 'BTC/USDT'
  coin:       { type: String, required: true },   // 'BTC'
  emoji:      { type: String, default: '●' },
  direction:  { type: String, enum: ['LONG','SHORT'], required: true },
  timeframe:  { type: String, default: '1H' },
  entry:      { type: Number, required: true },
  tp1:        { type: Number, required: true },
  tp2:        { type: Number },
  sl:         { type: Number, required: true },
  grade:      { type: String, default: 'B' },
  rrr:        { type: String },
  status:     { type: String, enum: ['ACTIVE','WAITING','CLOSED','CANCELLED'], default: 'ACTIVE' },
  confidence: { type: Number, min: 0, max: 100, default: 70 },
  exchange:   { type: String, default: 'Binance Futures' },
  notes:      { type: String },
  postedBy:   { type: String, default: 'admin' },
  postedAt:   { type: Date, default: Date.now },
  closedAt:   { type: Date },
  closePrice: { type: Number },
  result:     { type: String, enum: ['WIN','LOSS','BE',null], default: null },
}, { timestamps: true });

/* Site Settings Schema */
const settingsSchema = new mongoose.Schema({
  key:   { type: String, unique: true, required: true },
  value: { type: mongoose.Schema.Types.Mixed },
  label: { type: String },
  group: { type: String, default: 'general' },
}, { timestamps: true });

/* Announcement Schema */
const announcementSchema = new mongoose.Schema({
  title:    { type: String, required: true },
  message:  { type: String, required: true },
  type:     { type: String, enum: ['info','warning','success','danger'], default: 'info' },
  active:   { type: Boolean, default: true },
  showFrom: { type: Date, default: Date.now },
  showUntil:{ type: Date },
  createdBy:{ type: String, default: 'admin' },
}, { timestamps: true });

/* Stats Snapshot Schema (daily snapshots for graphs) */
const statsSchema = new mongoose.Schema({
  date:          { type: String, required: true, unique: true }, // 'YYYY-MM-DD'
  signalsSent:   { type: Number, default: 0 },
  activeSignals: { type: Number, default: 0 },
  wins:          { type: Number, default: 0 },
  losses:        { type: Number, default: 0 },
}, { timestamps: true });

const Signal      = mongoose.model('Signal',      signalSchema);
const Settings    = mongoose.model('Settings',    settingsSchema);
const Announcement= mongoose.model('Announcement',announcementSchema);
const Stats       = mongoose.model('Stats',       statsSchema);

/* ═══════════════════════════════════════════════════════
   MONGODB CONNECTION
═══════════════════════════════════════════════════════ */
let mongoConnected = false;

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/investysignals')
  .then(async () => {
    mongoConnected = true;
    console.log('✅ MongoDB connected');
    await seedDefaultSettings();
  })
  .catch(err => {
    console.error('⚠️  MongoDB connection failed:', err.message);
    console.log('   → Falling back to hardcoded signals');
  });

/* Seed default settings if not present */
async function seedDefaultSettings() {
  const defaults = [
    // General
    { key: 'site_name',            value: 'InvestySignals',         label: 'Site Name',                   group: 'general' },
    { key: 'site_tagline',         value: 'Professional Crypto Signals', label: 'Site Tagline',           group: 'general' },
    { key: 'site_url',             value: 'https://investysignals.store', label: 'Site URL',              group: 'general' },
    { key: 'maintenance_mode',     value: false,                    label: 'Maintenance Mode',            group: 'general' },
    { key: 'register_open',        value: true,                     label: 'Allow New Registrations',     group: 'general' },
    { key: 'footer_text',          value: '© 2026 InvestySignals. For educational purposes only.',
                                                                     label: 'Footer Text',                group: 'general' },
    // SEO
    { key: 'seo_title',            value: 'InvestySignals — Free Crypto Trading Signals',
                                                                     label: 'SEO Meta Title',             group: 'seo' },
    { key: 'seo_description',      value: 'Get free professional crypto trading signals for Binance Futures. RSI, EMA, MACD analysis with precise entry, TP and SL levels.',
                                                                     label: 'SEO Meta Description',       group: 'seo' },
    { key: 'seo_keywords',         value: 'crypto signals, binance futures signals, bitcoin trading signals, free crypto signals, BTC ETH signals',
                                                                     label: 'SEO Keywords',               group: 'seo' },
    { key: 'og_image',             value: '',                        label: 'OG Share Image URL',         group: 'seo' },
    { key: 'google_analytics_id',  value: '',                        label: 'Google Analytics ID (G-xxx)',group: 'seo' },
    // AdSense
    { key: 'adsense_enabled',      value: false,                    label: 'Enable Google AdSense',       group: 'adsense' },
    { key: 'adsense_publisher_id', value: '',                        label: 'AdSense Publisher ID (ca-pub-xxxxx)',  group: 'adsense' },
    { key: 'adsense_auto_ads',     value: false,                    label: 'Auto Ads (auto insert ads)',  group: 'adsense' },
    { key: 'adsense_slot_header',  value: '',                        label: 'Header Ad Slot ID',          group: 'adsense' },
    { key: 'adsense_slot_sidebar', value: '',                        label: 'Sidebar Ad Slot ID',         group: 'adsense' },
    { key: 'adsense_slot_inline',  value: '',                        label: 'Inline Content Ad Slot ID',  group: 'adsense' },
    { key: 'adsense_slot_footer',  value: '',                        label: 'Footer Ad Slot ID',          group: 'adsense' },
    // Analysis
    { key: 'scan_limit',           value: 50,                       label: 'Market Scan Limit',           group: 'analysis' },
    { key: 'rsi_period',           value: 14,                       label: 'RSI Period',                  group: 'analysis' },
    { key: 'rsi_long_threshold',   value: 45,                       label: 'RSI Long Threshold',          group: 'analysis' },
    { key: 'rsi_short_threshold',  value: 55,                       label: 'RSI Short Threshold',         group: 'analysis' },
    { key: 'kline_timeframe',      value: '1h',                     label: 'Kline Timeframe',             group: 'analysis' },
    { key: 'kline_limit',          value: 150,                      label: 'Kline History Limit',         group: 'analysis' },
    // Signals
    { key: 'max_signals_shown',    value: 20,                       label: 'Max Signals on Page',         group: 'signals' },
    { key: 'auto_close_signals',   value: true,                     label: 'Auto-close Signals',          group: 'signals' },
    { key: 'signals_disclaimer',   value: 'These signals are for educational purposes only. Not financial advice.',
                                                                     label: 'Signals Disclaimer',         group: 'signals' },
    // Social
    { key: 'social_telegram',      value: '',                        label: 'Telegram Channel URL',       group: 'social' },
    { key: 'social_twitter',       value: '',                        label: 'Twitter / X URL',            group: 'social' },
    { key: 'social_discord',       value: '',                        label: 'Discord Server URL',         group: 'social' },
    { key: 'social_youtube',       value: '',                        label: 'YouTube Channel URL',        group: 'social' },
  ];
  for (const d of defaults) {
    await Settings.findOneAndUpdate({ key: d.key }, d, { upsert: true, new: true });
  }
  console.log('[MongoDB] Default settings seeded (' + defaults.length + ' keys)');
}

/* ═══════════════════════════════════════════════════════
   ADMIN AUTH MIDDLEWARE
═══════════════════════════════════════════════════════ */
function adminAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/* ═══════════════════════════════════════════════════════
   ADMIN AUTH ENDPOINTS
═══════════════════════════════════════════════════════ */

/* POST /api/admin/login */
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const validPass = process.env.ADMIN_PASSWORD || 'admin123';

  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
  const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ success: true, token, expiresIn: '12h' });
});

/* GET /api/admin/verify */
app.get('/api/admin/verify', adminAuth, (req, res) => {
  res.json({ success: true, admin: req.admin });
});

/* ═══════════════════════════════════════════════════════
   ADMIN — SIGNALS API
═══════════════════════════════════════════════════════ */

/* GET /api/admin/signals */
app.get('/api/admin/signals', adminAuth, async (req, res) => {
  try {
    const { status, limit = 50, skip = 0 } = req.query;
    const filter = status ? { status } : {};
    const signals = await Signal.find(filter).sort({ postedAt: -1 }).limit(+limit).skip(+skip);
    const total   = await Signal.countDocuments(filter);
    res.json({ success: true, total, data: signals });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* POST /api/admin/signals */
app.post('/api/admin/signals', adminAuth, async (req, res) => {
  try {
    const signal = await Signal.create({ ...req.body, postedBy: req.admin.username });
    broadcastSignalUpdate();
    res.json({ success: true, data: signal });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* PUT /api/admin/signals/:id */
app.put('/api/admin/signals/:id', adminAuth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.status === 'CLOSED' && !update.closedAt) update.closedAt = new Date();
    const signal = await Signal.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!signal) return res.status(404).json({ success: false, error: 'Signal not found' });
    broadcastSignalUpdate();
    res.json({ success: true, data: signal });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* DELETE /api/admin/signals/:id */
app.delete('/api/admin/signals/:id', adminAuth, async (req, res) => {
  try {
    await Signal.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — SETTINGS API
═══════════════════════════════════════════════════════ */

/* GET /api/admin/settings */
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try {
    const settings = await Settings.find().sort({ group: 1, key: 1 });
    res.json({ success: true, data: settings });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* PUT /api/admin/settings/:key */
app.put('/api/admin/settings/:key', adminAuth, async (req, res) => {
  try {
    const setting = await Settings.findOneAndUpdate(
      { key: req.params.key },
      { value: req.body.value },
      { new: true, upsert: true }
    );
    res.json({ success: true, data: setting });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — ANNOUNCEMENTS API
═══════════════════════════════════════════════════════ */

/* GET /api/admin/announcements */
app.get('/api/admin/announcements', adminAuth, async (req, res) => {
  try {
    const items = await Announcement.find().sort({ createdAt: -1 });
    res.json({ success: true, data: items });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* POST /api/admin/announcements */
app.post('/api/admin/announcements', adminAuth, async (req, res) => {
  try {
    const ann = await Announcement.create({ ...req.body, createdBy: req.admin.username });
    broadcastAnnouncement(ann);
    res.json({ success: true, data: ann });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* PUT /api/admin/announcements/:id */
app.put('/api/admin/announcements/:id', adminAuth, async (req, res) => {
  try {
    const ann = await Announcement.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, data: ann });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* DELETE /api/admin/announcements/:id */
app.delete('/api/admin/announcements/:id', adminAuth, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — DASHBOARD STATS API
═══════════════════════════════════════════════════════ */

/* GET /api/admin/stats */
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [totalSignals, activeSignals, closedSignals, wins, losses] = await Promise.all([
      Signal.countDocuments(),
      Signal.countDocuments({ status: 'ACTIVE' }),
      Signal.countDocuments({ status: 'CLOSED' }),
      Signal.countDocuments({ result: 'WIN' }),
      Signal.countDocuments({ result: 'LOSS' }),
    ]);
    const winRate = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : 0;
    const recentSignals = await Signal.find().sort({ postedAt: -1 }).limit(5);
    const recentStats   = await Stats.find().sort({ date: -1 }).limit(30);

    res.json({
      success: true,
      data: {
        signals: { total: totalSignals, active: activeSignals, closed: closedSignals },
        performance: { wins, losses, winRate },
        marketData: {
          liveCoins:  Object.keys(marketData).length,
          wsStatus:   binanceWsState,
          clients:    wss.clients.size,
          uptime:     Math.round(process.uptime()),
        },
        mongoConnected,
        recentSignals,
        recentStats,
      }
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   PUBLIC API — Signals (MongoDB first, fallback hardcoded)
═══════════════════════════════════════════════════════ */

/* Hardcoded fallback signals (preserved from original) */
const HARDCODED_SIGNALS = [
  { id:1, pair:'BTC/USDT', coin:'BTC', emoji:'₿', direction:'LONG', timeframe:'4H', entry:83500, tp1:87000, tp2:91500, sl:80000, grade:'A+', rrr:'2.1:1', status:'ACTIVE', confidence:92, posted:'2026-04-01 08:00', exchange:'Binance Futures' },
  { id:2, pair:'ETH/USDT', coin:'ETH', emoji:'Ξ', direction:'LONG', timeframe:'1H', entry:1870, tp1:1980, tp2:2100, sl:1800, grade:'A', rrr:'2.4:1', status:'ACTIVE', confidence:85, posted:'2026-04-01 09:30', exchange:'Binance Futures' },
  { id:3, pair:'SOL/USDT', coin:'SOL', emoji:'◎', direction:'SHORT', timeframe:'4H', entry:142, tp1:128, tp2:118, sl:150, grade:'B+', rrr:'1.8:1', status:'WAITING', confidence:78, posted:'2026-04-01 10:00', exchange:'Binance Futures' },
  { id:4, pair:'BNB/USDT', coin:'BNB', emoji:'◆', direction:'LONG', timeframe:'1D', entry:575, tp1:620, tp2:660, sl:548, grade:'A', rrr:'2.2:1', status:'ACTIVE', confidence:88, posted:'2026-03-31 18:00', exchange:'Binance Futures' },
  { id:5, pair:'XRP/USDT', coin:'XRP', emoji:'✕', direction:'LONG', timeframe:'4H', entry:2.08, tp1:2.35, tp2:2.60, sl:1.92, grade:'A+', rrr:'2.8:1', status:'ACTIVE', confidence:91, posted:'2026-04-01 06:00', exchange:'Binance Futures' },
  { id:6, pair:'DOGE/USDT', coin:'DOGE', emoji:'Ð', direction:'SHORT', timeframe:'1H', entry:0.178, tp1:0.155, tp2:0.140, sl:0.190, grade:'B', rrr:'1.9:1', status:'CLOSED', confidence:74, posted:'2026-03-31 12:00', exchange:'Binance Futures' },
];

app.get('/api/signals', async (req, res) => {
  if (mongoConnected) {
    try {
      const { status } = req.query;
      const filter  = status ? { status } : {};
      const signals = await Signal.find(filter).sort({ postedAt: -1 }).limit(50);
      if (signals.length > 0) {
        return res.json({ success: true, count: signals.length, data: signals, source: 'mongodb' });
      }
    } catch (e) { console.error('[API] MongoDB signal fetch error:', e.message); }
  }
  // Fallback to hardcoded
  res.json({ success: true, count: HARDCODED_SIGNALS.length, data: HARDCODED_SIGNALS, source: 'hardcoded' });
});

/* Public active announcement */
app.get('/api/announcement', async (req, res) => {
  if (!mongoConnected) return res.json({ success: true, data: null });
  try {
    const now = new Date();
    const ann = await Announcement.findOne({
      active: true,
      showFrom: { $lte: now },
      $or: [{ showUntil: null }, { showUntil: { $gte: now } }]
    }).sort({ createdAt: -1 });
    res.json({ success: true, data: ann });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   PUBLIC API — Site Settings (public subset)
═══════════════════════════════════════════════════════ */

/* GET /api/settings/public — returns only safe public settings */
app.get('/api/settings/public', async (req, res) => {
  if (!mongoConnected) {
    return res.json({ success: true, data: {} });
  }
  try {
    const PUBLIC_KEYS = [
      'site_name', 'site_tagline', 'site_url', 'footer_text',
      'adsense_enabled', 'adsense_publisher_id', 'adsense_auto_ads',
      'adsense_slot_header', 'adsense_slot_sidebar', 'adsense_slot_inline', 'adsense_slot_footer',
      'seo_title', 'seo_description', 'seo_keywords', 'og_image', 'google_analytics_id',
      'signals_disclaimer', 'social_telegram', 'social_twitter', 'social_discord', 'social_youtube',
      'maintenance_mode', 'register_open',
    ];
    const rows = await Settings.find({ key: { $in: PUBLIC_KEYS } });
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   PUBLIC API — Bulk settings update (admin only via key)
   POST /api/admin/settings/bulk
═══════════════════════════════════════════════════════ */
app.post('/api/admin/settings/bulk', adminAuth, async (req, res) => {
  try {
    const { updates } = req.body; // { key: value, key2: value2, ... }
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ success: false, error: 'updates object required' });
    }
    const results = [];
    for (const [key, value] of Object.entries(updates)) {
      const s = await Settings.findOneAndUpdate({ key }, { value }, { new: true, upsert: true });
      results.push(s);
    }
    res.json({ success: true, updated: results.length, data: results });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   PUBLIC API — Admin overview stats (for stats dashboard widget)
═══════════════════════════════════════════════════════ */
app.get('/api/stats/public', async (req, res) => {
  if (!mongoConnected) return res.json({ success: true, data: null });
  try {
    const [total, active, wins, losses] = await Promise.all([
      Signal.countDocuments(),
      Signal.countDocuments({ status: 'ACTIVE' }),
      Signal.countDocuments({ result: 'WIN' }),
      Signal.countDocuments({ result: 'LOSS' }),
    ]);
    const winRate = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null;
    res.json({ success: true, data: { total, active, wins, losses, winRate } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});


/* ═══════════════════════════════════════════════════════
   Market Data Store (PRESERVED FROM ORIGINAL)
═══════════════════════════════════════════════════════ */
let marketData   = {};
let topGainers   = [];
let tickerCoins  = {};

const WATCH_SYMBOLS   = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
const MIN_VOLUME_USDT = 10_000_000;
const EXCLUDE_SYMBOLS = new Set([
  'USDCUSDT','BUSDUSDT','TUSDUSDT','USDTUSDT','DAIUSDT',
  'FDUSDUSDT','EURUSDT','GBPUSDT','AUDUSDT','BRLBUSD'
]);

app.get('/api/market/top-gainers', (req, res) => {
  res.json({ success: true, data: topGainers.slice(0, 5) });
});
app.get('/api/market/ticker', (req, res) => {
  res.json({ success: true, data: tickerCoins });
});
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', clients: wss.clients.size, uptime: process.uptime(),
    marketCoins: Object.keys(marketData).length, topGainers: topGainers.length,
    wsState: binanceWsState, mongoConnected,
  });
});

/* ═══════════════════════════════════════════════════════
   WebSocket — Broadcast helpers (PRESERVED + extended)
═══════════════════════════════════════════════════════ */
function broadcastUpdate() {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify({
    type: 'market_update',
    topGainers: topGainers.slice(0, 5),
    ticker: WATCH_SYMBOLS.map(s => marketData[s]).filter(Boolean),
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (_) {}
    }
  });
}

function broadcastSignalUpdate() {
  if (wss.clients.size === 0) return;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(JSON.stringify({ type: 'signal_update' })); } catch (_) {}
    }
  });
}

function broadcastAnnouncement(ann) {
  if (wss.clients.size === 0) return;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(JSON.stringify({ type: 'announcement', data: ann })); } catch (_) {}
    }
  });
}

/* ═══════════════════════════════════════════════════════
   All original market data helpers (PRESERVED)
═══════════════════════════════════════════════════════ */
function parseTicker(t) {
  const symbol = t.s || t.symbol;
  const price  = parseFloat(t.c  || t.lastPrice          || 0);
  const change = parseFloat(t.P  || t.priceChangePercent || 0);
  const volume = parseFloat(t.q  || t.quoteVolume        || 0);
  const high   = parseFloat(t.h  || t.highPrice          || 0);
  const low    = parseFloat(t.l  || t.lowPrice           || 0);
  return { symbol, base: symbol.replace('USDT',''), price, change, volume, high, low };
}
function isValidTicker(obj) {
  if (!obj.symbol || !obj.symbol.endsWith('USDT')) return false;
  if (EXCLUDE_SYMBOLS.has(obj.symbol)) return false;
  if (/DOWN|UP|BEAR|BULL|LONG|SHORT|3L|3S|5L|5S/.test(obj.symbol)) return false;
  if (obj.price <= 0 || obj.volume <= 0) return false;
  return true;
}
function rebuildTopGainers() {
  topGainers = Object.values(marketData)
    .filter(t => t.volume >= MIN_VOLUME_USDT)
    .sort((a, b) => b.change - a.change).slice(0, 5);
}
function refreshTickerSnapshot() {
  WATCH_SYMBOLS.forEach(s => { if (marketData[s]) tickerCoins[s] = marketData[s]; });
}

let restFallbackTimer = null;
function fetchViaREST() {
  const url = 'https://api.binance.com/api/v3/ticker/24hr';
  console.log('[REST] Fetching full ticker snapshot…');
  const req = https.get(url, { timeout: 12000 }, (res) => {
    if (res.statusCode !== 200) { console.error('[REST] HTTP', res.statusCode); res.resume(); return; }
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const tickers = JSON.parse(raw);
        let count = 0;
        tickers.forEach(t => { const obj = parseTicker(t); if (!isValidTicker(obj)) return; marketData[obj.symbol]=obj; count++; });
        refreshTickerSnapshot(); rebuildTopGainers();
        console.log(`[REST] ✅ Loaded ${count} coins`);
        broadcastUpdate();
      } catch (e) { console.error('[REST] Parse error:', e.message); }
    });
  });
  req.on('error', err => console.error('[REST] Request error:', err.message));
  req.on('timeout', () => { req.destroy(); console.error('[REST] Timeout'); });
}

wss.on('connection', (ws) => {
  console.log(`[WS:Browser] Client connected — total: ${wss.clients.size}`);
  const snap = { type:'market_update', topGainers:topGainers.slice(0,5), ticker:WATCH_SYMBOLS.map(s=>marketData[s]).filter(Boolean) };
  try { ws.send(JSON.stringify(snap)); } catch (_) {}
  ws.on('close', () => console.log(`[WS:Browser] Client left — total: ${wss.clients.size}`));
  ws.on('error', () => {});
});

let binanceWs=null, binanceWsState='disconnected', broadcastTimer=null;
let reconnectTimer=null, reconnectDelay=3000, healthTimer=null, lastMessageAt=0;
const MAX_RECONNECT_DELAY = 60000;

function startBroadcastLoop() { if (broadcastTimer) return; broadcastTimer=setInterval(broadcastUpdate,2000); }
function stopBroadcastLoop()  { if (!broadcastTimer) return; clearInterval(broadcastTimer); broadcastTimer=null; }
function startHealthCheck() {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    if (binanceWsState!=='connected') return;
    const silentMs = Date.now()-lastMessageAt;
    if (silentMs>45000) { console.warn(`[Binance] No message for ${Math.round(silentMs/1000)}s — forcing reconnect`); if (binanceWs) try{binanceWs.terminate();}catch(_){} }
  }, 15000);
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  if (restFallbackTimer) clearTimeout(restFallbackTimer);
  restFallbackTimer = setTimeout(fetchViaREST, 8000);
  console.log(`[Binance] Reconnecting in ${reconnectDelay/1000}s…`);
  reconnectTimer = setTimeout(() => { reconnectTimer=null; connectBinance(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay*1.6, MAX_RECONNECT_DELAY);
}
function connectBinance() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer=null; }
  binanceWsState='connecting';
  let ws;
  try { ws=new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr',{handshakeTimeout:15000}); }
  catch(e) { console.error('[Binance] Constructor error:',e.message); scheduleReconnect(); return; }
  binanceWs=ws;
  ws.on('open', ()=>{ console.log('✅ Binance stream CONNECTED'); binanceWsState='connected'; reconnectDelay=3000; lastMessageAt=Date.now(); startBroadcastLoop(); startHealthCheck(); });
  ws.on('message', (raw)=>{
    lastMessageAt=Date.now();
    try { const tickers=JSON.parse(raw); if(!Array.isArray(tickers))return; tickers.forEach(t=>{const obj=parseTicker(t);if(!isValidTicker(obj))return;marketData[obj.symbol]=obj;}); refreshTickerSnapshot(); rebuildTopGainers(); }
    catch(e){console.error('[Binance] Parse error:',e.message);}
  });
  ws.on('error', (err)=>console.error('[Binance] Error:',err.message));
  ws.on('close', (code,reason)=>{ console.log(`[Binance] DISCONNECTED code:${code}`); binanceWsState='disconnected'; stopBroadcastLoop(); scheduleReconnect(); });
}

/* ═══════════════════════════════════════════════════════
   Startup
═══════════════════════════════════════════════════════ */
fetchViaREST();
setTimeout(connectBinance, 2000);

server.listen(PORT, HOST, () => {
  console.log(`🚀 InvestySignals running → http://${HOST}:${PORT}`);
});
