/**
 * InvestySignals — Server v2.1 (Security + Bug Fixes)
 */
require('dotenv').config();
const express   = require('express');
const path      = require('path');
const http      = require('http');
const WebSocket = require('ws');
const https     = require('https');
const mongoose  = require('mongoose');
const jwt       = require('jsonwebtoken');


const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT       = process.env.PORT || 2000;
const HOST       = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'dev_secret_change_in_production';

/* ── Security headers (Helmet) ── */
try {
  const helmet = require('helmet');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  console.log('✅ Helmet security headers active');
} catch (_) { console.warn('⚠️  helmet not installed — run: npm install helmet express-rate-limit'); }

/* ── Rate limiter (login brute-force protection) ── */
let loginLimiter = (req, res, next) => next();
try {
  const rateLimit = require('express-rate-limit');
  loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
  });
  console.log('✅ Rate limiter active (login: 20/15min)');
} catch (_) {}

/* ── Body parser (5mb covers base64 image uploads; must come before routes) ── */
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Schemas ── */
const signalSchema = new mongoose.Schema({
  pair:{ type:String,required:true },coin:{ type:String,required:true },emoji:{ type:String,default:'●' },
  direction:{ type:String,enum:['LONG','SHORT'],required:true },timeframe:{ type:String,default:'1H' },
  entry:{ type:Number,required:true },tp1:{ type:Number,required:true },tp2:Number,sl:{ type:Number,required:true },
  grade:{ type:String,default:'B' },rrr:String,status:{ type:String,enum:['ACTIVE','WAITING','CLOSED','CANCELLED'],default:'ACTIVE' },
  confidence:{ type:Number,min:0,max:100,default:70 },exchange:{ type:String,default:'Binance Futures' },
  notes:String,postedBy:{ type:String,default:'admin' },postedAt:{ type:Date,default:Date.now },
  closedAt:Date,closePrice:Number,result:{ type:String,enum:['WIN','LOSS','BE',null],default:null },
},{ timestamps:true });

const settingsSchema = new mongoose.Schema({
  key:{ type:String,unique:true,required:true },value:{ type:mongoose.Schema.Types.Mixed },
  label:String,group:{ type:String,default:'general' },
},{ timestamps:true });

const announcementSchema = new mongoose.Schema({
  title:{ type:String,required:true },message:{ type:String,required:true },
  type:{ type:String,enum:['info','warning','success','danger'],default:'info' },
  active:{ type:Boolean,default:true },showFrom:{ type:Date,default:Date.now },showUntil:Date,createdBy:{ type:String,default:'admin' },
},{ timestamps:true });

const statsSchema = new mongoose.Schema({
  date:{ type:String,required:true,unique:true },signalsSent:{ type:Number,default:0 },
  activeSignals:{ type:Number,default:0 },wins:{ type:Number,default:0 },losses:{ type:Number,default:0 },
},{ timestamps:true });

const userSettingsSchema = new mongoose.Schema({
  firebaseUid:{ type:String,required:true,unique:true,index:true },
  email:String,displayName:String,settings:{ type:mongoose.Schema.Types.Mixed,default:{} },
  suspended:{ type:Boolean,default:false },suspendedAt:Date,suspendReason:String,
  role:{ type:String,enum:['user','premium','admin'],default:'user' },lastSeen:{ type:Date,default:Date.now },
},{ timestamps:true });

const reportSchema = new mongoose.Schema({
  reporterUid:   { type:String, default:'anonymous' },
  reporterEmail: { type:String, default:'' },
  category: { type:String, enum:['signal_accuracy','technical_bug','inappropriate_content','other'], required:true },
  message:  { type:String, required:true, maxlength:2000 },
  context:  { type:String, default:'' },
  imageBase64: { type:String, default:'' },
  status:   { type:String, enum:['open','in_review','resolved','dismissed'], default:'open' },
  adminNote:{ type:String, default:'' },
  adminReply:{ type:String, default:'' },
  resolvedBy:{ type:String, default:'' },
  resolvedAt:{ type:Date },
  readByAdmin:{ type:Boolean, default:false },
},{ timestamps:true });

const Signal       = mongoose.model('Signal',       signalSchema);
const Settings     = mongoose.model('Settings',     settingsSchema);
const Announcement = mongoose.model('Announcement', announcementSchema);
const Stats        = mongoose.model('Stats',        statsSchema);
const UserRecord   = mongoose.model('UserRecord',   userSettingsSchema);
const Report       = mongoose.model('Report',       reportSchema);

/* ── Paper Trade Schema ── */
const paperTradeSchema = new mongoose.Schema({
  uid:       { type:String, required:true, index:true },
  id:        { type:Number, required:true },  // client-side timestamp id
  symbol:    { type:String, required:true },
  pair:      { type:String, required:true },
  direction: { type:String, enum:['LONG','SHORT'], required:true },
  entryType: { type:String, default:'MARKET' },
  entryPrice:{ type:Number, required:true },
  tp1:       { type:Number, required:true },
  tp2:       Number,
  sl:        { type:Number, required:true },
  amount:    { type:Number, required:true },
  leverage:  { type:Number, default:5 },
  size:      Number,
  notional:  Number,
  liqPrice:  Number,
  status:    { type:String, default:'OPEN' },
  openTime:  String,
  fillTime:  String,
  closeTime: String,
  closePrice:Number,
  pnl:       Number,
  roe:       Number,
  totalPnl:  Number,
  totalRoe:  Number,
  tp1Pnl:    Number,
  tp1HitPrice:Number,
  tp1HitTime: String,
  currentSl: Number,
  trailOffset:Number,
}, { timestamps:true });

const paperBalanceSchema = new mongoose.Schema({
  uid:     { type:String, required:true, unique:true, index:true },
  balance: { type:Number, default:1000 },
}, { timestamps:true });

const PaperTrade   = mongoose.model('PaperTrade',   paperTradeSchema);
const PaperBalance = mongoose.model('PaperBalance', paperBalanceSchema);

/* ── Signal Outcome Schema (win rate tracking) ── */
const signalOutcomeSchema = new mongoose.Schema({
  symbol:     { type:String, required:true, index:true },
  direction:  { type:String, enum:['LONG','SHORT'], required:true },
  confidence: Number,
  entryPrice: Number,
  tp1Price:   Number,
  tp2Price:   Number,
  slPrice:    Number,
  rrr1:       Number,
  rrr2:       Number,
  session:    String,
  outcome:    { type:String, enum:['TP1','TP2','SL','BE','OPEN','CANCELLED'], default:'OPEN' },
  pnlR:       Number,  // P&L in R multiples
  closePrice: Number,
  openTime:   { type:Date, default:Date.now },
  closeTime:  Date,
  uid:        String,
}, { timestamps:true });

const SignalOutcome = mongoose.model('SignalOutcome', signalOutcomeSchema);

/* ── Indicator defaults ── */
const indicatorDefaults = [
  { key:'ind_rsi_period',value:14,label:'RSI Period',group:'indicators' },
  { key:'ind_ema_fast',value:20,label:'EMA Fast Period',group:'indicators' },
  { key:'ind_ema_slow',value:50,label:'EMA Slow Period',group:'indicators' },
  { key:'ind_ema_long',value:200,label:'EMA Long Period (200)',group:'indicators' },
  { key:'ind_macd_fast',value:12,label:'MACD Fast',group:'indicators' },
  { key:'ind_macd_slow',value:26,label:'MACD Slow',group:'indicators' },
  { key:'ind_macd_signal',value:9,label:'MACD Signal',group:'indicators' },
  { key:'ind_bb_period',value:20,label:'Bollinger Bands Period',group:'indicators' },
  { key:'ind_bb_mult',value:2,label:'Bollinger Bands Multiplier',group:'indicators' },
  { key:'ind_stoch_rsi_period',value:14,label:'Stoch RSI Period',group:'indicators' },
  { key:'ind_stoch_k',value:3,label:'Stoch RSI K Smooth',group:'indicators' },
  { key:'ind_stoch_d',value:3,label:'Stoch RSI D Smooth',group:'indicators' },
  { key:'ind_adx_period',value:14,label:'ADX Period',group:'indicators' },
  { key:'ind_adx_choppy_gate',value:18,label:'ADX Choppy Market Gate',group:'indicators' },
  { key:'ind_atr_period',value:14,label:'ATR Period',group:'indicators' },
  { key:'ind_supertrend_period',value:10,label:'Supertrend Period',group:'indicators' },
  { key:'ind_supertrend_mult',value:3,label:'Supertrend Multiplier',group:'indicators' },
  { key:'ind_vwap_lookback',value:24,label:'VWAP Lookback (candles)',group:'indicators' },
  { key:'ind_kline_limit',value:200,label:'Kline History (bars)',group:'indicators' },
  { key:'ind_kline_tf',value:'1h',label:'Primary Timeframe',group:'indicators' },
  { key:'ind_min_confidence',value:68,label:'Min Confidence % to Signal',group:'indicators' },
  { key:'ind_market_entry_conf',value:75,label:'Market Entry Min Confidence',group:'indicators' },
  { key:'ind_funding_gate',value:0.25,label:'Funding Rate Hard Gate (%)',group:'indicators' },
  { key:'pt_tp1_trail_mult',value:0.5,label:'TP1 Trail Offset Multiplier',group:'paper_trade' },
  { key:'pt_default_leverage',value:5,label:'Default Leverage',group:'paper_trade' },
  { key:'pt_default_amount',value:100,label:'Default Trade Amount (USDT)',group:'paper_trade' },
];

/* ── MongoDB ── */
let mongoConnected = false;
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/investysignals')
  .then(async () => {
    mongoConnected = true;
    console.log('✅ MongoDB connected');
    await seedDefaultSettings();
  })
  .catch(err => {
    console.error('⚠️  MongoDB failed:', err.message);
  });

async function seedDefaultSettings() {
  const defaults = [
    { key:'site_name',value:'InvestySignals',label:'Site Name',group:'general' },
    { key:'site_tagline',value:'Professional Crypto Signals',label:'Site Tagline',group:'general' },
    { key:'site_url',value:'https://investysignals.store',label:'Site URL',group:'general' },
    { key:'maintenance_mode',value:false,label:'Maintenance Mode',group:'general' },
    { key:'register_open',value:true,label:'Allow New Registrations',group:'general' },
    { key:'footer_text',value:'© 2026 InvestySignals. For educational purposes only.',label:'Footer Text',group:'general' },
    { key:'seo_title',value:'InvestySignals — Free Crypto Trading Signals',label:'SEO Meta Title',group:'seo' },
    { key:'seo_description',value:'Get free professional crypto trading signals for Binance Futures.',label:'SEO Meta Description',group:'seo' },
    { key:'seo_keywords',value:'crypto signals, binance futures signals, bitcoin trading signals',label:'SEO Keywords',group:'seo' },
    { key:'og_image',value:'',label:'OG Share Image URL',group:'seo' },
    { key:'google_analytics_id',value:'',label:'Google Analytics ID',group:'seo' },
    { key:'adsense_enabled',value:true,label:'Enable Google AdSense',group:'adsense' },
    { key:'adsense_publisher_id',value:'ca-pub-5034247623532581',label:'AdSense Publisher ID',group:'adsense' },
    { key:'adsense_auto_ads',value:false,label:'Auto Ads',group:'adsense' },
    { key:'adsense_slot_header',value:'',label:'Header Ad Slot ID',group:'adsense' },
    { key:'adsense_slot_sidebar',value:'',label:'Sidebar Ad Slot ID',group:'adsense' },
    { key:'adsense_slot_inline',value:'',label:'Inline Content Ad Slot ID',group:'adsense' },
    { key:'adsense_slot_footer',value:'',label:'Footer Ad Slot ID',group:'adsense' },
    { key:'scan_limit',value:50,label:'Market Scan Limit',group:'analysis' },
    { key:'max_signals_shown',value:20,label:'Max Signals on Page',group:'signals' },
    { key:'auto_close_signals',value:true,label:'Auto-close Signals',group:'signals' },
    { key:'signals_disclaimer',value:'These signals are for educational purposes only. Not financial advice.',label:'Signals Disclaimer',group:'signals' },
    { key:'social_telegram',value:'',label:'Telegram Channel URL',group:'social' },
    { key:'social_twitter',value:'',label:'Twitter / X URL',group:'social' },
    { key:'social_discord',value:'',label:'Discord Server URL',group:'social' },
    { key:'social_youtube',value:'',label:'YouTube Channel URL',group:'social' },
    /* ── Feature Flags ── */
    { key:'feature_analysis',value:true,label:'Analysis Feature',group:'features' },
    { key:'feature_live_signals',value:true,label:'Live Signals Feature',group:'features' },
    { key:'feature_paper_trading',value:true,label:'Paper Trading Feature',group:'features' },
    { key:'feature_backtest',value:true,label:'Backtest Feature',group:'features' },
    { key:'feature_scanner',value:true,label:'Scanner Feature',group:'features' },
    { key:'allow_registration',value:true,label:'Allow New Registrations',group:'features' },
    { key:'maintenance_message',value:'We are making improvements. Please check back shortly.',label:'Maintenance Message',group:'general' },
    { key:'gate_analysis_login',value:false,label:'Analysis requires login',group:'gates' },
    { key:'gate_analysis_premium',value:false,label:'Analysis requires premium',group:'gates' },
    { key:'gate_signals_login',value:false,label:'Signals require login',group:'gates' },
    { key:'gate_paper_login',value:false,label:'Paper trading requires login',group:'gates' },
    { key:'min_publish_grade',value:'C',label:'Min Signal Grade to Publish',group:'signals' },
    ...indicatorDefaults,
  ];
  for (const d of defaults) {
    await Settings.findOneAndUpdate({ key:d.key }, d, { upsert:true, new:true });
  }
  console.log('[MongoDB] Settings seeded (' + defaults.length + ' keys)');
}

/* ── Firebase Admin ── */
let firebaseAdmin = null, firebaseAdminReady = false;
try {
  const admin = require('firebase-admin');
  let credential = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Option 1: JSON string in env var
    try {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    } catch(parseErr) {
      console.log('⚠️  FIREBASE_SERVICE_ACCOUNT JSON parse failed:', parseErr.message);
    }
  }

  if (!credential && process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    // Option 2: Path to JSON file
    const saPath = require('path').resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    try {
      const saJson = require(saPath);
      credential = admin.credential.cert(saJson);
    } catch(fileErr) {
      console.log('⚠️  Firebase service account file load failed:', fileErr.message);
    }
  }

  if (credential) {
    admin.initializeApp({ credential });
    firebaseAdmin = admin; firebaseAdminReady = true;
    console.log('✅ Firebase Admin initialized');
  } else {
    console.log('⚠️  Firebase Admin disabled — set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH in .env');
  }
} catch (e) { console.log('⚠️  firebase-admin not available:', e.message); }

/* ── Admin JWT middleware ── */
function adminAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ success:false, error:'No token' });
  try { req.admin = jwt.verify(auth.slice(7), JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ success:false, error:'Invalid token' }); }
}

/* ── User status check endpoint (suspend/role/maintenance) ── */
let _cachedMaintenance = false;
app.get('/api/user/status', async (req, res) => {
  try {
    if (!mongoConnected) return res.json({ success:true, status:{ maintenance:_cachedMaintenance, maintenanceMsg:'We are making improvements. Please check back shortly.', suspended:false } });
    const [modeRow, msgRow] = await Promise.all([
      Settings.findOne({ key:'maintenance_mode' }),
      Settings.findOne({ key:'maintenance_message' }),
    ]);
    const v = modeRow?.value;
    const maintenance = v === true || v === 'true' || v === 1 || v === '1';
    _cachedMaintenance = maintenance;
    const maintenanceMsg = msgRow?.value || 'We are making improvements. Please check back shortly.';
    const { uid } = req.query;
    // Load feature flags always (needed even without uid)
    const flagKeys = ['feature_analysis','feature_live_signals','feature_paper_trading',
      'feature_backtest','feature_scanner','gate_analysis_login','gate_analysis_premium',
      'gate_signals_login','gate_paper_login','allow_registration'];
    const flagRows = await Settings.find({ key:{ $in:flagKeys } });
    const flags = {};
    flagRows.forEach(r => { flags[r.key] = r.value; });
    if (!uid) return res.json({ success:true, status:{ maintenance, maintenanceMsg, suspended:false, flags } });
    const record = await UserRecord.findOne({ firebaseUid: uid });
    res.json({ success:true, status:{
      maintenance,
      maintenanceMsg,
      suspended: record?.suspended || false,
      suspendReason: record?.suspendReason || '',
      role: record?.role || 'user',
      flags,
    }});
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

/* ── Firebase token middleware ── */
async function verifyFirebaseToken(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ success:false, error:'No token' });
  if (firebaseAdminReady) {
    try {
      const decoded = await firebaseAdmin.auth().verifyIdToken(auth.slice(7));
      req.firebaseUser = decoded;
      await UserRecord.findOneAndUpdate(
        { firebaseUid:decoded.uid },
        { email:decoded.email, displayName:decoded.name, lastSeen:new Date() },
        { upsert:true, new:true, setDefaultsOnInsert:true }
      );
      const record = await UserRecord.findOne({ firebaseUid:decoded.uid });
      if (record?.suspended) return res.status(403).json({ success:false, error:'Account suspended', reason:record.suspendReason });
      req.userRecord = record; next();
    } catch (e) { res.status(401).json({ success:false, error:'Invalid Firebase token' }); }
  } else {
    req.firebaseUser = { uid:'dev_user', email:'dev@local' }; next();
  }
}

/* ══════════════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════════════ */

/* Admin login — rate limited */
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success:false, error:'Username and password required' });
    const expectedUser = process.env.ADMIN_USERNAME || 'admin';
    const expectedPass = process.env.ADMIN_PASSWORD || 'admin123';
    if (username !== expectedUser || password !== expectedPass) {
      console.warn(`[ADMIN] Failed login attempt — user: "${username}" from IP: ${req.ip}`);
      return res.status(401).json({ success:false, error:'Invalid credentials' });
    }
    const token = jwt.sign({ username, role:'admin' }, JWT_SECRET, { expiresIn:'12h' });
    console.log(`[ADMIN] Login success — user: "${username}" from IP: ${req.ip}`);
    res.json({ success:true, token, expiresIn:'12h' });
  } catch(e) {
    console.error('[ADMIN] Login error:', e.message);
    res.status(500).json({ success:false, error:'Server error during login' });
  }
});
app.get('/api/admin/verify', adminAuth, (req, res) => res.json({ success:true, admin:req.admin }));

/* Admin signals */
app.get('/api/admin/signals', adminAuth, async (req, res) => {
  try {
    const { status, limit=50, skip=0 } = req.query;
    const filter = status ? { status } : {};
    const [signals, total] = await Promise.all([Signal.find(filter).sort({ postedAt:-1 }).limit(+limit).skip(+skip), Signal.countDocuments(filter)]);
    res.json({ success:true, total, data:signals });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/admin/signals', adminAuth, async (req, res) => {
  try {
    const s = await Signal.create({ ...req.body, postedBy:req.admin.username });
    const today = new Date().toISOString().slice(0,10);
    await Stats.findOneAndUpdate({ date:today }, { $inc:{ signalsSent:1 } }, { upsert:true });
    broadcastSignalUpdate();
    res.json({ success:true, data:s });
  } catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.put('/api/admin/signals/:id', adminAuth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.status==='CLOSED' && !update.closedAt) update.closedAt = new Date();
    const s = await Signal.findByIdAndUpdate(req.params.id, update, { new:true });
    if (!s) return res.status(404).json({ success:false, error:'Not found' });
    if (update.result === 'WIN' || update.result === 'LOSS' || update.result === 'BE') {
      const today = new Date().toISOString().slice(0,10);
      const inc = {};
      if (update.result === 'WIN')  inc.wins   = 1;
      if (update.result === 'LOSS') inc.losses  = 1;
      await Stats.findOneAndUpdate({ date:today }, { $inc:inc }, { upsert:true });
    }
    broadcastSignalUpdate();
    res.json({ success:true, data:s });
  } catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.delete('/api/admin/signals/:id', adminAuth, async (req, res) => {
  try { await Signal.findByIdAndDelete(req.params.id); res.json({ success:true }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* Admin settings */
app.get('/api/admin/settings', adminAuth, async (req, res) => {
  try { res.json({ success:true, data: await Settings.find().sort({ group:1, key:1 }) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/admin/settings/:key', adminAuth, async (req, res) => {
  try {
    const saved = await Settings.findOneAndUpdate({ key:req.params.key }, { value:req.body.value }, { new:true, upsert:true });
    // Instantly push maintenance changes to all connected clients
    if (req.params.key === 'maintenance_mode' || req.params.key === 'maintenance_message') {
      const [modeRow, msgRow] = await Promise.all([
        Settings.findOne({ key:'maintenance_mode' }),
        Settings.findOne({ key:'maintenance_message' }),
      ]);
      const v = modeRow?.value;
      const active = v === true || v === 'true' || v === 1 || v === '1';
      _cachedMaintenance = active;
      const message = msgRow?.value || 'We are making improvements. Please check back shortly.';
      wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
          try { c.send(JSON.stringify({ type:'maintenance', active, message })); } catch(_) {}
        }
      });
    }
    res.json({ success:true, data:saved });
  }
  catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.post('/api/admin/settings/bulk', adminAuth, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || typeof updates !== 'object') return res.status(400).json({ success:false, error:'updates object required' });
    const results = [];
    for (const [key, value] of Object.entries(updates)) results.push(await Settings.findOneAndUpdate({ key }, { value }, { new:true, upsert:true }));
    res.json({ success:true, updated:results.length, data:results });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* Admin announcements */
app.get('/api/admin/announcements', adminAuth, async (req, res) => {
  try { res.json({ success:true, data: await Announcement.find().sort({ createdAt:-1 }) }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/admin/announcements', adminAuth, async (req, res) => {
  try { const a = await Announcement.create({ ...req.body, createdBy:req.admin.username }); broadcastAnnouncement(a); res.json({ success:true, data:a }); }
  catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.put('/api/admin/announcements/:id', adminAuth, async (req, res) => {
  try { res.json({ success:true, data: await Announcement.findByIdAndUpdate(req.params.id, req.body, { new:true }) }); }
  catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.delete('/api/admin/announcements/:id', adminAuth, async (req, res) => {
  try { await Announcement.findByIdAndDelete(req.params.id); res.json({ success:true }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* Admin stats */
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [tot, act, cls, wins, losses] = await Promise.all([Signal.countDocuments(), Signal.countDocuments({ status:'ACTIVE' }), Signal.countDocuments({ status:'CLOSED' }), Signal.countDocuments({ result:'WIN' }), Signal.countDocuments({ result:'LOSS' })]);
    res.json({ success:true, data:{ signals:{ total:tot, active:act, closed:cls }, performance:{ wins, losses, winRate:(wins+losses)>0?Math.round(wins/(wins+losses)*100):0 }, marketData:{ liveCoins:Object.keys(marketData).length, wsStatus:binanceWsState, clients:wss.clients.size, uptime:Math.round(process.uptime()) }, mongoConnected, recentSignals: await Signal.find().sort({ postedAt:-1 }).limit(5), recentStats: await Stats.find().sort({ date:-1 }).limit(30) } });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* Admin user management */
app.get('/api/admin/users/stats', adminAuth, async (req, res) => {
  try {
    const [total, suspended, premium, sevenDays] = await Promise.all([UserRecord.countDocuments(), UserRecord.countDocuments({ suspended:true }), UserRecord.countDocuments({ role:'premium' }), UserRecord.countDocuments({ lastSeen:{ $gte:new Date(Date.now()-7*24*60*60*1000) } })]);
    res.json({ success:true, data:{ total, suspended, premium, activeLastWeek:sevenDays } });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { skip=0, limit=50, suspended } = req.query;
    const filter = {};
    if (suspended==='true') filter.suspended=true;
    if (suspended==='false') filter.suspended={ $ne:true };
    const [users, total] = await Promise.all([UserRecord.find(filter).sort({ lastSeen:-1 }).skip(+skip).limit(+limit), UserRecord.countDocuments(filter)]);
    let enriched = users.map(u => u.toObject());
    if (firebaseAdminReady) {
      enriched = await Promise.all(users.map(async u => {
        try { const fb=await firebaseAdmin.auth().getUser(u.firebaseUid); return { ...u.toObject(), firebaseEmail:fb.email, firebaseDisplayName:fb.displayName, firebaseDisabled:fb.disabled, firebaseCreated:fb.metadata.creationTime, firebaseLastLogin:fb.metadata.lastSignInTime }; }
        catch (_) { return u.toObject(); }
      }));
    }
    res.json({ success:true, total, data:enriched });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/admin/users/:uid/suspend', adminAuth, async (req, res) => {
  try {
    const r = await UserRecord.findOneAndUpdate({ firebaseUid:req.params.uid }, { suspended:true, suspendedAt:new Date(), suspendReason:req.body.reason||'Suspended by admin' }, { new:true, upsert:true, setDefaultsOnInsert:true });
    if (!r) return res.status(404).json({ success:false, error:'User not found' });
    if (firebaseAdminReady) try { await firebaseAdmin.auth().updateUser(req.params.uid, { disabled:true }); } catch (_) {}
    res.json({ success:true, message:'User suspended', data:r });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/admin/users/:uid/unsuspend', adminAuth, async (req, res) => {
  try {
    const r = await UserRecord.findOneAndUpdate({ firebaseUid:req.params.uid }, { suspended:false, $unset:{ suspendedAt:1, suspendReason:1 } }, { new:true, upsert:true, setDefaultsOnInsert:true });
    if (!r) return res.status(404).json({ success:false, error:'User not found' });
    if (firebaseAdminReady) try { await firebaseAdmin.auth().updateUser(req.params.uid, { disabled:false }); } catch (_) {}
    res.json({ success:true, message:'User unsuspended', data:r });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.delete('/api/admin/users/:uid', adminAuth, async (req, res) => {
  try {
    const uid = req.params.uid;
    // Try by firebaseUid first, fallback to _id (ObjectId)
    let deleted = await UserRecord.findOneAndDelete({ firebaseUid: uid });
    if (!deleted) {
      try { deleted = await UserRecord.findByIdAndDelete(uid); } catch (_) {}
    }
    if (!deleted) return res.status(404).json({ success:false, error:'User not found in database' });
    // Delete from Firebase Auth
    const fbUid = deleted.firebaseUid || (uid.length < 36 ? uid : null);
    if (firebaseAdminReady && fbUid) {
      try { await firebaseAdmin.auth().deleteUser(fbUid); } catch (_) {}
    }
    res.json({ success:true, message:'User deleted' });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/admin/users/:uid/role', adminAuth, async (req, res) => {
  try {
    if (!['user','premium','admin'].includes(req.body.role)) return res.status(400).json({ success:false, error:'Invalid role' });
    const r = await UserRecord.findOneAndUpdate(
      { firebaseUid:req.params.uid },
      { $set:{ role:req.body.role } },
      { new:true, upsert:true, setDefaultsOnInsert:true }
    );
    if (!r) return res.status(404).json({ success:false, error:'User not found' });
    res.json({ success:true, data:r });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* Admin indicator defaults */
app.get('/api/admin/indicators', adminAuth, async (req, res) => {
  try {
    const rows = await Settings.find({ group:{ $in:['indicators','paper_trade'] } });
    const data = {};
    rows.forEach(r => { data[r.key] = { value:r.value, label:r.label, group:r.group }; });
    res.json({ success:true, data });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/admin/indicators', adminAuth, async (req, res) => {
  try {
    const allowed = indicatorDefaults.map(d => d.key);
    const results = [];
    for (const [key, value] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      results.push(await Settings.findOneAndUpdate({ key }, { value }, { new:true, upsert:true }));
    }
    res.json({ success:true, updated:results.length });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* User indicator settings */
app.get('/api/user/settings', verifyFirebaseToken, async (req, res) => {
  try {
    const rows = await Settings.find({ group:{ $in:['indicators','paper_trade'] } });
    const adminDefaults = {};
    rows.forEach(r => { adminDefaults[r.key] = r.value; });
    const record = await UserRecord.findOne({ firebaseUid:req.firebaseUser.uid });
    const userOverrides = record?.settings || {};
    res.json({ success:true, data:{ ...adminDefaults, ...userOverrides }, defaults:adminDefaults, overrides:userOverrides });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/user/settings', verifyFirebaseToken, async (req, res) => {
  try {
    const allowed = indicatorDefaults.map(d => d.key);
    const updates = {};
    Object.entries(req.body).forEach(([k, v]) => { if (allowed.includes(k)) updates[k] = v; });
    // Merge new values into existing user settings (don't overwrite unrelated keys)
    const setFields = {};
    Object.entries(updates).forEach(([k, v]) => { setFields[`settings.${k}`] = v; });
    const r = await UserRecord.findOneAndUpdate({ firebaseUid:req.firebaseUser.uid }, { $set:setFields }, { new:true, upsert:true });
    res.json({ success:true, data:r.settings });
  } catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.delete('/api/user/settings', verifyFirebaseToken, async (req, res) => {
  try { await UserRecord.findOneAndUpdate({ firebaseUid:req.firebaseUser.uid }, { $set:{ settings:{} } }); res.json({ success:true }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* ── Public APIs ── */
app.get('/api/signals', async (req, res) => {
  if (mongoConnected) {
    try {
      const { status } = req.query;
      const signals = await Signal.find(status?{status}:{}).sort({ postedAt:-1 }).limit(50);
      // Always return MongoDB data — never show fake hardcoded signals
      return res.json({ success:true, count:signals.length, data:signals, source:'mongodb' });
    } catch (e) { console.error('[API]', e.message); }
  }
  // MongoDB is down — return empty, never fake data
  res.json({ success:true, count:0, data:[], source:'unavailable' });
});
app.get('/api/announcement', async (req, res) => {
  if (!mongoConnected) return res.json({ success:true, data:null });
  try {
    const now = new Date();
    res.json({ success:true, data: await Announcement.findOne({ active:true, showFrom:{ $lte:now }, $or:[{ showUntil:null },{ showUntil:{ $gte:now } }] }).sort({ createdAt:-1 }) });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
/* ═══════════════════════════════════════════════════════════════
   PAPER TRADING API — server-side persistence
   All routes require Firebase auth (userAuth middleware)
   ═══════════════════════════════════════════════════════════════ */

/* userAuth — lightweight: verify Firebase token, attach uid */
async function userAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ success:false, error:'Unauthorized' });
  try {
    if (!firebaseAdminReady) return res.status(503).json({ success:false, error:'Auth service unavailable' });
    const decoded = await firebaseAdmin.auth().verifyIdToken(auth.slice(7));
    req.uid = decoded.uid;
    next();
  } catch (e) { res.status(401).json({ success:false, error:'Invalid token' }); }
}

/* GET /api/paper/trades — get all trades for user */
app.get('/api/paper/trades', userAuth, async (req, res) => {
  try {
    const trades = await PaperTrade.find({ uid: req.uid }).sort({ id: -1 }).lean();
    res.json({ success:true, trades });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* POST /api/paper/trades — open a new trade */
app.post('/api/paper/trades', userAuth, async (req, res) => {
  try {
    const trade = new PaperTrade({ uid: req.uid, ...req.body });
    await trade.save();
    res.json({ success:true, trade });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* PATCH /api/paper/trades/:id — update trade (TP/SL hit, close, fill, trailing) */
app.patch('/api/paper/trades/:id', userAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const trade = await PaperTrade.findOneAndUpdate(
      { uid: req.uid, id },
      { $set: req.body },
      { new: true }
    );
    if (!trade) return res.status(404).json({ success:false, error:'Trade not found' });
    res.json({ success:true, trade });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* DELETE /api/paper/trades/:id — cancel/remove a trade */
app.delete('/api/paper/trades/:id', userAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await PaperTrade.findOneAndDelete({ uid: req.uid, id });
    res.json({ success:true });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* DELETE /api/paper/trades — clear all closed trades */
app.delete('/api/paper/trades', userAuth, async (req, res) => {
  try {
    const { scope } = req.body;
    if (scope === 'all') {
      await PaperTrade.deleteMany({ uid: req.uid });
    } else {
      // default: closed only
      const closedStatuses = ['TP2','BE_CLOSE','TRAIL_WIN','SL','CLOSED','CANCELLED'];
      await PaperTrade.deleteMany({ uid: req.uid, status: { $in: closedStatuses } });
    }
    res.json({ success:true });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* GET /api/paper/balance — get user's paper balance */
app.get('/api/paper/balance', userAuth, async (req, res) => {
  try {
    let rec = await PaperBalance.findOne({ uid: req.uid });
    if (!rec) rec = await PaperBalance.create({ uid: req.uid, balance: 1000 });
    res.json({ success:true, balance: rec.balance });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* PUT /api/paper/balance — set/reset balance */
app.put('/api/paper/balance', userAuth, async (req, res) => {
  try {
    const { balance } = req.body;
    if (typeof balance !== 'number' || balance < 0) return res.status(400).json({ success:false, error:'Invalid balance' });
    const rec = await PaperBalance.findOneAndUpdate(
      { uid: req.uid },
      { balance },
      { upsert: true, new: true }
    );
    res.json({ success:true, balance: rec.balance });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* ═══════════════════════════════════════════════════════════════
   WIN RATE TRACKING API
   ═══════════════════════════════════════════════════════════════ */

/* POST /api/signals/track — save a new signal for outcome tracking */
app.post('/api/signals/track', userAuth, async (req, res) => {
  try {
    const sig = new SignalOutcome({ ...req.body, uid: req.uid });
    await sig.save();
    res.json({ success:true, id: sig._id });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

/* PATCH /api/signals/track/:id — update outcome (TP1/TP2/SL hit) */
app.patch('/api/signals/track/:id', userAuth, async (req, res) => {
  try {
    const sig = await SignalOutcome.findOneAndUpdate(
      { _id: req.params.id, uid: req.uid },
      { $set: { ...req.body, closeTime: new Date() } },
      { new:true }
    );
    if (!sig) return res.status(404).json({ success:false, error:'Signal not found' });
    res.json({ success:true, signal: sig });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

/* GET /api/signals/winrate — user's win rate stats */
app.get('/api/signals/winrate', userAuth, async (req, res) => {
  try {
    const closed = await SignalOutcome.find({
      uid: req.uid, outcome: { $in: ['TP1','TP2','SL','BE'] }
    }).sort({ closeTime:-1 }).limit(200).lean();

    const total  = closed.length;
    const wins   = closed.filter(s => s.outcome === 'TP1' || s.outcome === 'TP2').length;
    const losses = closed.filter(s => s.outcome === 'SL').length;
    const be     = closed.filter(s => s.outcome === 'BE').length;
    const winRate = total > 0 ? (wins / total * 100).toFixed(1) : null;
    const avgPnlR = total > 0 ? (closed.reduce((s, x) => s + (x.pnlR || 0), 0) / total).toFixed(2) : null;

    // By direction
    const longs  = closed.filter(s => s.direction === 'LONG');
    const shorts = closed.filter(s => s.direction === 'SHORT');
    const longWR = longs.length  ? (longs.filter(s=>s.outcome==='TP1'||s.outcome==='TP2').length/longs.length*100).toFixed(1) : null;
    const shortWR= shorts.length ? (shorts.filter(s=>s.outcome==='TP1'||s.outcome==='TP2').length/shorts.length*100).toFixed(1) : null;

    // Last 20 signals (equity curve)
    const recent = closed.slice(0, 20).map(s => ({ outcome:s.outcome, pnlR:s.pnlR, symbol:s.symbol, direction:s.direction, closeTime:s.closeTime }));

    res.json({ success:true, stats:{ total, wins, losses, be, winRate, avgPnlR, longWR, shortWR }, recent });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get('/api/settings/public', async (req, res) => {
  if (!mongoConnected) return res.json({ success:true, data:{} });
  try {
    const PUBLIC_KEYS = ['site_name','site_tagline','site_url','footer_text','adsense_enabled','adsense_publisher_id','adsense_auto_ads','adsense_slot_header','adsense_slot_sidebar','adsense_slot_inline','adsense_slot_footer','seo_title','seo_description','seo_keywords','og_image','google_analytics_id','signals_disclaimer','social_telegram','social_twitter','social_discord','social_youtube','maintenance_mode','maintenance_message','register_open','allow_registration','feature_analysis','feature_live_signals','feature_paper_trading','feature_backtest','feature_scanner','gate_analysis_login','gate_analysis_premium','gate_signals_login','gate_paper_login','min_publish_grade'];
    const rows = await Settings.find({ key:{ $in:PUBLIC_KEYS } });
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json({ success:true, data });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.get('/api/settings/indicators', async (req, res) => {
  try {
    const rows = await Settings.find({ group:{ $in:['indicators','paper_trade'] } });
    const data = {};
    rows.forEach(r => { data[r.key] = r.value; });
    res.json({ success:true, data });
  } catch (e) {
    const fallback = {};
    indicatorDefaults.forEach(d => { fallback[d.key] = d.value; });
    res.json({ success:true, data:fallback, source:'fallback' });
  }
});
app.get('/api/stats/public', async (req, res) => {
  if (!mongoConnected) return res.json({ success:true, data:null });
  try {
    const [total, active, wins, losses] = await Promise.all([Signal.countDocuments(), Signal.countDocuments({ status:'ACTIVE' }), Signal.countDocuments({ result:'WIN' }), Signal.countDocuments({ result:'LOSS' })]);
    res.json({ success:true, data:{ total, active, wins, losses, winRate:(wins+losses)>0?Math.round(wins/(wins+losses)*100):null } });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.get('/api/market/top-gainers', (req, res) => res.json({ success:true, data:topGainers.slice(0,5) }));
app.get('/api/market/ticker',      (req, res) => res.json({ success:true, data:tickerCoins }));
app.get('/api/ping', (req, res) => res.json({ ok:true, ts:Date.now(), mongo:mongoConnected }));
app.get('/health', (req, res) => res.json({ status:'ok', clients:wss.clients.size, uptime:process.uptime(), marketCoins:Object.keys(marketData).length, wsState:binanceWsState, mongoConnected }));

/* ══ USER REPORT SUBMISSION ══ */
app.post('/api/reports', async (req, res) => {
  try {
    if (!mongoConnected) return res.status(503).json({ success:false, error:'Database not available. Please try again shortly.' });
    const { category, message, context, reporterUid, reporterEmail, imageBase64 } = req.body;
    if (!category || !message || message.trim().length < 3)
      return res.status(400).json({ success:false, error:'category and message required' });
    const allowed = ['signal_accuracy','technical_bug','inappropriate_content','other'];
    if (!allowed.includes(category))
      return res.status(400).json({ success:false, error:'Invalid category' });
    if (imageBase64 && imageBase64.length > 2*1024*1024)
      return res.status(400).json({ success:false, error:'Image too large (max 2MB)' });
    const report = await Report.create({
      category, message:message.trim().slice(0,2000),
      context:(context||'').slice(0,500),
      imageBase64: imageBase64 || '',
      reporterUid:  reporterUid  || 'anonymous',
      reporterEmail:reporterEmail|| '',
    });
    // Broadcast notification to admin via WebSocket
    broadcastAdminNotification({ type:'new_report', report:{
      _id:report._id, category:report.category, message:report.message.slice(0,100),
      reporterEmail:report.reporterEmail, createdAt:report.createdAt
    }});
    res.json({ success:true, message:'Report submitted. Thank you.' });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* ══ ADMIN REPORT MANAGEMENT ══ */
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const { status, skip=0, limit=50 } = req.query;
    const filter = status ? { status } : {};
    const [data, total, openCount] = await Promise.all([
      Report.find(filter).sort({ createdAt:-1 }).skip(+skip).limit(+limit),
      Report.countDocuments(filter),
      Report.countDocuments({ status:'open' }),
    ]);
    res.json({ success:true, total, openCount, data });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* MUST be before /:id — otherwise 'unread-count' is caught as an id param */
app.get('/api/admin/reports/unread-count', adminAuth, async (req, res) => {
  try {
    const count = await Report.countDocuments({ status:'open' });
    res.json({ success:true, count });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* Admin: get single report with image */
app.get('/api/admin/reports/:id/detail', adminAuth, async (req, res) => {
  try {
    const r = await Report.findById(req.params.id);
    if (!r) return res.status(404).json({ success:false, error:'Not found' });
    res.json({ success:true, data:r });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.put('/api/admin/reports/:id', adminAuth, async (req, res) => {
  try {
    const { status, adminNote, adminReply, readByAdmin } = req.body;
    const update = {};
    if (status) update.status = status;
    if (adminNote !== undefined) update.adminNote = adminNote;
    if (adminReply !== undefined) update.adminReply = adminReply;
    if (readByAdmin !== undefined) update.readByAdmin = readByAdmin;
    if (status === 'resolved' || status === 'dismissed') {
      update.resolvedBy = req.admin.username;
      update.resolvedAt = new Date();
    }
    const r = await Report.findByIdAndUpdate(req.params.id, update, { new:true });
    if (!r) return res.status(404).json({ success:false, error:'Not found' });
    res.json({ success:true, data:r });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

app.delete('/api/admin/reports/:id', adminAuth, async (req, res) => {
  try {
    await Report.findByIdAndDelete(req.params.id);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* User: get own reports */
app.get('/api/my-reports', async (req, res) => {
  try {
    if (!mongoConnected) return res.status(503).json({ success:false, error:'DB unavailable' });
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ success:false, error:'uid required' });
    const data = await Report.find({ reporterUid: uid })
      .sort({ createdAt:-1 }).limit(20)
      .select('-imageBase64'); // exclude heavy base64 from list
    res.json({ success:true, data });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

/* User: get single report (with image) */
app.get('/api/my-reports/:id', async (req, res) => {
  try {
    if (!mongoConnected) return res.status(503).json({ success:false, error:'DB unavailable' });
    const { uid } = req.query;
    const r = await Report.findById(req.params.id);
    if (!r) return res.status(404).json({ success:false, error:'Not found' });
    if (r.reporterUid !== uid) return res.status(403).json({ success:false, error:'Forbidden' });
    res.json({ success:true, data:r });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

/* ── Market data ── */
let marketData={}, topGainers=[], tickerCoins={};
const WATCH_SYMBOLS=['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT'], MIN_VOLUME_USDT=10_000_000;
const EXCLUDE_SYMBOLS=new Set(['USDCUSDT','BUSDUSDT','TUSDUSDT','USDTUSDT','DAIUSDT','FDUSDUSDT','EURUSDT','GBPUSDT','AUDUSDT','BRLBUSD']);
function parseTicker(t){return{symbol:t.s||t.symbol,base:(t.s||t.symbol).replace('USDT',''),price:parseFloat(t.c||t.lastPrice||0),change:parseFloat(t.P||t.priceChangePercent||0),volume:parseFloat(t.q||t.quoteVolume||0),high:parseFloat(t.h||t.highPrice||0),low:parseFloat(t.l||t.lowPrice||0)};}
function isValidTicker(o){if(!o.symbol||!o.symbol.endsWith('USDT'))return false;if(EXCLUDE_SYMBOLS.has(o.symbol))return false;if(/DOWN|UP|BEAR|BULL|LONG|SHORT|3L|3S|5L|5S/.test(o.symbol))return false;if(o.price<=0||o.volume<=0)return false;return true;}
function rebuildTopGainers(){topGainers=Object.values(marketData).filter(t=>t.volume>=MIN_VOLUME_USDT).sort((a,b)=>b.change-a.change).slice(0,5);}
function refreshTickerSnapshot(){WATCH_SYMBOLS.forEach(s=>{if(marketData[s])tickerCoins[s]=marketData[s];});}

/* ── WebSocket ── */
function broadcastUpdate(){if(!wss.clients.size)return;const p=JSON.stringify({type:'market_update',topGainers:topGainers.slice(0,5),ticker:WATCH_SYMBOLS.map(s=>marketData[s]).filter(Boolean)});wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)try{c.send(p);}catch(_){}});}
function broadcastSignalUpdate(){wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)try{c.send(JSON.stringify({type:'signal_update'}));}catch(_){}});}
function broadcastAnnouncement(a){wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)try{c.send(JSON.stringify({type:'announcement',data:a}));}catch(_){}});}
function broadcastAdminNotification(payload){wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)try{c.send(JSON.stringify({type:'admin_notification',...payload}));}catch(_){}});}
wss.on('connection',ws=>{console.log(`[WS] Client + total:${wss.clients.size}`);try{ws.send(JSON.stringify({type:'market_update',topGainers:topGainers.slice(0,5),ticker:WATCH_SYMBOLS.map(s=>marketData[s]).filter(Boolean)}));}catch(_){}ws.on('close',()=>console.log(`[WS] Client - total:${wss.clients.size}`));ws.on('error',()=>{});});

/* ── Binance stream ── */
let binanceWs=null,binanceWsState='disconnected',broadcastTimer=null,reconnectTimer=null,reconnectDelay=3000,healthTimer=null,lastMessageAt=0,restFallbackTimer=null;
const MAX_RECONNECT_DELAY=60000;
function startBroadcastLoop(){if(!broadcastTimer)broadcastTimer=setInterval(broadcastUpdate,2000);}
function stopBroadcastLoop(){if(broadcastTimer){clearInterval(broadcastTimer);broadcastTimer=null;}}
function startHealthCheck(){if(healthTimer)return;healthTimer=setInterval(()=>{if(binanceWsState!=='connected')return;const ms=Date.now()-lastMessageAt;if(ms>45000){console.warn('[Binance] Silent, reconnecting');if(binanceWs)try{binanceWs.terminate();}catch(_){}}},15000);}
function scheduleReconnect(){if(reconnectTimer)return;if(restFallbackTimer)clearTimeout(restFallbackTimer);restFallbackTimer=setTimeout(fetchViaREST,8000);reconnectTimer=setTimeout(()=>{reconnectTimer=null;connectBinance();},reconnectDelay);reconnectDelay=Math.min(reconnectDelay*1.6,MAX_RECONNECT_DELAY);}
function fetchViaREST(){const req=https.get('https://api.binance.com/api/v3/ticker/24hr',{timeout:12000},res=>{if(res.statusCode!==200){res.resume();return;}let raw='';res.on('data',c=>raw+=c);res.on('end',()=>{try{JSON.parse(raw).forEach(t=>{const o=parseTicker(t);if(!isValidTicker(o))return;marketData[o.symbol]=o;});refreshTickerSnapshot();rebuildTopGainers();broadcastUpdate();}catch(e){console.error('[REST]',e.message);}});});req.on('error',e=>console.error('[REST]',e.message));req.on('timeout',()=>{req.destroy();});}
function connectBinance(){if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}binanceWsState='connecting';let ws;try{ws=new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr',{handshakeTimeout:15000});}catch(e){scheduleReconnect();return;}binanceWs=ws;ws.on('open',()=>{binanceWsState='connected';reconnectDelay=3000;lastMessageAt=Date.now();startBroadcastLoop();startHealthCheck();console.log('✅ Binance WS connected');});ws.on('message',raw=>{lastMessageAt=Date.now();try{const t=JSON.parse(raw);if(!Array.isArray(t))return;t.forEach(x=>{const o=parseTicker(x);if(!isValidTicker(o))return;marketData[o.symbol]=o;});refreshTickerSnapshot();rebuildTopGainers();}catch(_){}});ws.on('error',e=>console.error('[Binance]',e.message));ws.on('close',code=>{binanceWsState='disconnected';stopBroadcastLoop();scheduleReconnect();});}

/* ── Startup ── */
fetchViaREST();
setTimeout(connectBinance, 2000);
server.listen(PORT, HOST, () => { console.log(`🚀 InvestySignals running → http://${HOST}:${PORT}`); });
