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


/* ── New indicator settings defaults ── */
const indicatorDefaults = [
  // Analysis engine
  { key: 'ind_rsi_period',        value: 14,    label: 'RSI Period',               group: 'indicators' },
  { key: 'ind_ema_fast',          value: 20,    label: 'EMA Fast Period',           group: 'indicators' },
  { key: 'ind_ema_slow',          value: 50,    label: 'EMA Slow Period',           group: 'indicators' },
  { key: 'ind_ema_long',          value: 200,   label: 'EMA Long Period (200)',      group: 'indicators' },
  { key: 'ind_macd_fast',         value: 12,    label: 'MACD Fast',                 group: 'indicators' },
  { key: 'ind_macd_slow',         value: 26,    label: 'MACD Slow',                 group: 'indicators' },
  { key: 'ind_macd_signal',       value: 9,     label: 'MACD Signal',               group: 'indicators' },
  { key: 'ind_bb_period',         value: 20,    label: 'Bollinger Bands Period',     group: 'indicators' },
  { key: 'ind_bb_mult',           value: 2,     label: 'Bollinger Bands Multiplier', group: 'indicators' },
  { key: 'ind_stoch_rsi_period',  value: 14,    label: 'Stoch RSI Period',           group: 'indicators' },
  { key: 'ind_stoch_k',           value: 3,     label: 'Stoch RSI K Smooth',         group: 'indicators' },
  { key: 'ind_stoch_d',           value: 3,     label: 'Stoch RSI D Smooth',         group: 'indicators' },
  { key: 'ind_adx_period',        value: 14,    label: 'ADX Period',                 group: 'indicators' },
  { key: 'ind_adx_choppy_gate',   value: 18,    label: 'ADX Choppy Market Gate',     group: 'indicators' },
  { key: 'ind_atr_period',        value: 14,    label: 'ATR Period',                 group: 'indicators' },
  { key: 'ind_supertrend_period', value: 10,    label: 'Supertrend Period',           group: 'indicators' },
  { key: 'ind_supertrend_mult',   value: 3,     label: 'Supertrend Multiplier',       group: 'indicators' },
  { key: 'ind_vwap_lookback',     value: 24,    label: 'VWAP Lookback (candles)',     group: 'indicators' },
  { key: 'ind_kline_limit',       value: 200,   label: 'Kline History (bars)',         group: 'indicators' },
  { key: 'ind_kline_tf',          value: '1h',  label: 'Primary Timeframe',            group: 'indicators' },
  // Scoring gates
  { key: 'ind_min_confidence',    value: 38,    label: 'Min Confidence % to Signal',  group: 'indicators' },
  { key: 'ind_market_entry_conf', value: 65,    label: 'Market Entry Min Confidence', group: 'indicators' },
  { key: 'ind_funding_gate',      value: 0.25,  label: 'Funding Rate Hard Gate (%)',   group: 'indicators' },
  // Paper trading
  { key: 'pt_tp1_trail_mult',     value: 0.5,   label: 'TP1 Trail Offset Multiplier', group: 'paper_trade' },
  { key: 'pt_default_leverage',   value: 5,     label: 'Default Leverage',             group: 'paper_trade' },
  { key: 'pt_default_amount',     value: 100,   label: 'Default Trade Amount (USDT)',  group: 'paper_trade' },
];

async function seedDefaultSettings() {
  const generalDefaults = [
    { key: 'site_name',            value: 'InvestySignals',         label: 'Site Name',                   group: 'general' },
    { key: 'site_tagline',         value: 'Professional Crypto Signals', label: 'Site Tagline',           group: 'general' },
    { key: 'site_url',             value: 'https://investysignals.store', label: 'Site URL',              group: 'general' },
    { key: 'maintenance_mode',     value: false,                    label: 'Maintenance Mode',            group: 'general' },
    { key: 'register_open',        value: true,                     label: 'Allow New Registrations',     group: 'general' },
    { key: 'footer_text',          value: '© 2026 InvestySignals. For educational purposes only.', label: 'Footer Text', group: 'general' },
    { key: 'seo_title',            value: 'InvestySignals — Free Crypto Trading Signals', label: 'SEO Meta Title', group: 'seo' },
    { key: 'seo_description',      value: 'Get free professional crypto trading signals for Binance Futures.', label: 'SEO Meta Description', group: 'seo' },
    { key: 'seo_keywords',         value: 'crypto signals, binance futures signals, bitcoin trading signals', label: 'SEO Keywords', group: 'seo' },
    { key: 'og_image',             value: '',   label: 'OG Share Image URL',        group: 'seo' },
    { key: 'google_analytics_id',  value: '',   label: 'Google Analytics ID',       group: 'seo' },
    { key: 'adsense_enabled',      value: true, label: 'Enable Google AdSense',     group: 'adsense' },
    { key: 'adsense_publisher_id', value: 'ca-pub-5034247623532581', label: 'AdSense Publisher ID', group: 'adsense' },
    { key: 'adsense_auto_ads',     value: false, label: 'Auto Ads',                 group: 'adsense' },
    { key: 'scan_limit',           value: 50,   label: 'Market Scan Limit',         group: 'analysis' },
    { key: 'max_signals_shown',    value: 20,   label: 'Max Signals on Page',       group: 'signals' },
    { key: 'auto_close_signals',   value: true, label: 'Auto-close Signals',        group: 'signals' },
    { key: 'signals_disclaimer',   value: 'These signals are for educational purposes only. Not financial advice.', label: 'Signals Disclaimer', group: 'signals' },
    { key: 'social_telegram',      value: '',   label: 'Telegram Channel URL',      group: 'social' },
    { key: 'social_twitter',       value: '',   label: 'Twitter / X URL',           group: 'social' },
    { key: 'social_discord',       value: '',   label: 'Discord Server URL',        group: 'social' },
    { key: 'social_youtube',       value: '',   label: 'YouTube Channel URL',       group: 'social' },
  ];
  const all = [...generalDefaults, ...indicatorDefaults];
  for (const d of all) {
    await Settings.findOneAndUpdate({ key: d.key }, d, { upsert: true, new: true });
  }
  console.log('[MongoDB] Default settings seeded (' + all.length + ' keys)');
}

/* ═══════════════════════════════════════════════════════
   USER SETTINGS SCHEMA (per-user indicator overrides)
═══════════════════════════════════════════════════════ */
const userSettingsSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  email:       { type: String },
  displayName: { type: String },
  settings:    { type: mongoose.Schema.Types.Mixed, default: {} },
  // Admin-managed fields
  suspended:   { type: Boolean, default: false },
  suspendedAt: { type: Date },
  suspendReason:{ type: String },
  deletedAt:   { type: Date },
  role:        { type: String, enum: ['user','premium','admin'], default: 'user' },
  lastSeen:    { type: Date, default: Date.now },
  createdAt:   { type: Date, default: Date.now },
}, { timestamps: true });

const UserRecord = mongoose.model('UserRecord', userSettingsSchema);

/* ═══════════════════════════════════════════════════════
   FIREBASE ADMIN SDK (optional — degrades gracefully)
═══════════════════════════════════════════════════════ */
let firebaseAdmin = null;
let firebaseAdminReady = false;

try {
  const admin = require('firebase-admin');
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseAdmin = admin;
    firebaseAdminReady = true;
    console.log('✅ Firebase Admin SDK initialized');
  } else {
    console.log('⚠️  FIREBASE_SERVICE_ACCOUNT not set — Firebase Admin features disabled');
  }
} catch (e) {
  console.log('⚠️  firebase-admin not installed — Firebase Admin features disabled');
}

/* Firebase ID token verification middleware */
async function verifyFirebaseToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }
  const idToken = auth.slice(7);
  if (firebaseAdminReady) {
    try {
      const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
      req.firebaseUser = decoded;
      // Upsert user record
      await UserRecord.findOneAndUpdate(
        { firebaseUid: decoded.uid },
        { email: decoded.email, displayName: decoded.name, lastSeen: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      const record = await UserRecord.findOne({ firebaseUid: decoded.uid });
      if (record?.suspended) {
        return res.status(403).json({ success: false, error: 'Account suspended', reason: record.suspendReason });
      }
      req.userRecord = record;
      next();
    } catch (e) {
      return res.status(401).json({ success: false, error: 'Invalid Firebase token' });
    }
  } else {
    // Fallback: decode without verification (dev mode)
    req.firebaseUser = { uid: 'dev_user', email: 'dev@local' };
    next();
  }
}

/* ═══════════════════════════════════════════════════════
   USER API — Indicator Settings
═══════════════════════════════════════════════════════ */

/* GET /api/user/settings — user's own indicator settings (merged with admin defaults) */
app.get('/api/user/settings', verifyFirebaseToken, async (req, res) => {
  try {
    // Load admin defaults from Settings collection
    const adminDefaults = {};
    const rows = await Settings.find({ group: { $in: ['indicators', 'paper_trade'] } });
    rows.forEach(r => { adminDefaults[r.key] = r.value; });

    // Load user overrides
    const record = await UserRecord.findOne({ firebaseUid: req.firebaseUser.uid });
    const userOverrides = record?.settings || {};

    // Merge: user overrides take priority over admin defaults
    const merged = { ...adminDefaults, ...userOverrides };
    res.json({ success: true, data: merged, defaults: adminDefaults, overrides: userOverrides });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* PUT /api/user/settings — save user's indicator overrides */
app.put('/api/user/settings', verifyFirebaseToken, async (req, res) => {
  try {
    const allowed = indicatorDefaults.map(d => d.key);
    const updates = {};
    Object.entries(req.body).forEach(([k, v]) => { if (allowed.includes(k)) updates[k] = v; });
    const record = await UserRecord.findOneAndUpdate(
      { firebaseUid: req.firebaseUser.uid },
      { $set: { settings: updates } },
      { new: true, upsert: true }
    );
    res.json({ success: true, data: record.settings });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

/* DELETE /api/user/settings — reset user settings to admin defaults */
app.delete('/api/user/settings', verifyFirebaseToken, async (req, res) => {
  try {
    await UserRecord.findOneAndUpdate({ firebaseUid: req.firebaseUser.uid }, { $set: { settings: {} } });
    res.json({ success: true, message: 'Settings reset to admin defaults' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — USER MANAGEMENT
═══════════════════════════════════════════════════════ */

/* GET /api/admin/users — list all registered users */
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { skip = 0, limit = 50, suspended } = req.query;
    const filter = {};
    if (suspended === 'true')  filter.suspended = true;
    if (suspended === 'false') filter.suspended = { $ne: true };
    const [users, total] = await Promise.all([
      UserRecord.find(filter).sort({ lastSeen: -1 }).skip(+skip).limit(+limit),
      UserRecord.countDocuments(filter),
    ]);

    // Enrich with Firebase user data if available
    let enriched = users;
    if (firebaseAdminReady) {
      enriched = await Promise.all(users.map(async u => {
        try {
          const fbUser = await firebaseAdmin.auth().getUser(u.firebaseUid);
          return {
            ...u.toObject(),
            firebaseEmail:       fbUser.email,
            firebaseDisplayName: fbUser.displayName,
            firebaseDisabled:    fbUser.disabled,
            firebaseCreated:     fbUser.metadata.creationTime,
            firebaseLastLogin:   fbUser.metadata.lastSignInTime,
          };
        } catch (_) { return u.toObject(); }
      }));
    }
    res.json({ success: true, total, data: enriched });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* POST /api/admin/users/:uid/suspend — suspend a user */
app.post('/api/admin/users/:uid/suspend', adminAuth, async (req, res) => {
  try {
    const { reason = 'Suspended by admin' } = req.body;
    const record = await UserRecord.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { suspended: true, suspendedAt: new Date(), suspendReason: reason },
      { new: true }
    );
    if (!record) return res.status(404).json({ success: false, error: 'User not found' });
    // Also disable in Firebase if available
    if (firebaseAdminReady) {
      try { await firebaseAdmin.auth().updateUser(req.params.uid, { disabled: true }); } catch (_) {}
    }
    res.json({ success: true, message: 'User suspended', data: record });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* POST /api/admin/users/:uid/unsuspend — restore a user */
app.post('/api/admin/users/:uid/unsuspend', adminAuth, async (req, res) => {
  try {
    const record = await UserRecord.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { suspended: false, $unset: { suspendedAt: 1, suspendReason: 1 } },
      { new: true }
    );
    if (!record) return res.status(404).json({ success: false, error: 'User not found' });
    if (firebaseAdminReady) {
      try { await firebaseAdmin.auth().updateUser(req.params.uid, { disabled: false }); } catch (_) {}
    }
    res.json({ success: true, message: 'User unsuspended', data: record });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* DELETE /api/admin/users/:uid — delete a user permanently */
app.delete('/api/admin/users/:uid', adminAuth, async (req, res) => {
  try {
    await UserRecord.findOneAndDelete({ firebaseUid: req.params.uid });
    if (firebaseAdminReady) {
      try { await firebaseAdmin.auth().deleteUser(req.params.uid); } catch (_) {}
    }
    res.json({ success: true, message: 'User deleted permanently' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* PUT /api/admin/users/:uid/role — change user role */
app.put('/api/admin/users/:uid/role', adminAuth, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user','premium','admin'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }
    const record = await UserRecord.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { role },
      { new: true }
    );
    res.json({ success: true, data: record });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* GET /api/admin/users/stats — user stats summary */
app.get('/api/admin/users/stats', adminAuth, async (req, res) => {
  try {
    const [total, suspended, premium, sevenDays] = await Promise.all([
      UserRecord.countDocuments(),
      UserRecord.countDocuments({ suspended: true }),
      UserRecord.countDocuments({ role: 'premium' }),
      UserRecord.countDocuments({ lastSeen: { $gte: new Date(Date.now() - 7*24*60*60*1000) } }),
    ]);
    res.json({ success: true, data: { total, suspended, premium, activeLastWeek: sevenDays } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════
   ADMIN — INDICATOR DEFAULTS (bulk update)
═══════════════════════════════════════════════════════ */

/* GET /api/admin/indicators — get current indicator defaults */
app.get('/api/admin/indicators', adminAuth, async (req, res) => {
  try {
    const rows = await Settings.find({ group: { $in: ['indicators','paper_trade'] } });
    const data = {};
    rows.forEach(r => { data[r.key] = { value: r.value, label: r.label, group: r.group }; });
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* PUT /api/admin/indicators — update indicator defaults */
app.put('/api/admin/indicators', adminAuth, async (req, res) => {
  try {
    const allowed = indicatorDefaults.map(d => d.key);
    const results = [];
    for (const [key, value] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      const s = await Settings.findOneAndUpdate({ key }, { value }, { new: true, upsert: true });
      results.push(s);
    }
    res.json({ success: true, updated: results.length });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* Public endpoint — returns indicator defaults for analysis.html to load */
app.get('/api/settings/indicators', async (req, res) => {
  try {
    const rows = await Settings.find({ group: { $in: ['indicators','paper_trade'] } });
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json({ success: true, data });
  } catch (e) {
    // Return hardcoded defaults as fallback
    const fallback = {};
    indicatorDefaults.forEach(d => { fallback[d.key] = d.value; });
    res.json({ success: true, data: fallback, source: 'fallback' });
  }
});


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
