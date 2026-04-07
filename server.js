/**
 * InvestySignals — Server v2 (Fixed)
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
const PORT       = process.env.PORT || 2000;
const HOST       = process.env.HOST || '0.0.0.0';
const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'dev_secret_change_in_production';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

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

const Signal       = mongoose.model('Signal',       signalSchema);
const Settings     = mongoose.model('Settings',     settingsSchema);
const Announcement = mongoose.model('Announcement', announcementSchema);
const Stats        = mongoose.model('Stats',        statsSchema);
const UserRecord   = mongoose.model('UserRecord',   userSettingsSchema);

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
  { key:'ind_min_confidence',value:38,label:'Min Confidence % to Signal',group:'indicators' },
  { key:'ind_market_entry_conf',value:65,label:'Market Entry Min Confidence',group:'indicators' },
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
    console.log('   → Falling back to hardcoded signals');
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
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    firebaseAdmin = admin; firebaseAdminReady = true;
    console.log('✅ Firebase Admin initialized');
  } else {
    console.log('⚠️  FIREBASE_SERVICE_ACCOUNT not set — Firebase Admin disabled');
  }
} catch (e) { console.log('⚠️  firebase-admin not available:', e.message); }

/* ── Admin JWT middleware ── */
function adminAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ success:false, error:'No token' });
  try { req.admin = jwt.verify(auth.slice(7), JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ success:false, error:'Invalid token' }); }
}

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

/* Admin login */
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username !== (process.env.ADMIN_USERNAME||'admin') || password !== (process.env.ADMIN_PASSWORD||'admin123'))
    return res.status(401).json({ success:false, error:'Invalid credentials' });
  const token = jwt.sign({ username, role:'admin' }, JWT_SECRET, { expiresIn:'12h' });
  res.json({ success:true, token, expiresIn:'12h' });
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
  try { const s = await Signal.create({ ...req.body, postedBy:req.admin.username }); broadcastSignalUpdate(); res.json({ success:true, data:s }); }
  catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.put('/api/admin/signals/:id', adminAuth, async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.status==='CLOSED' && !update.closedAt) update.closedAt = new Date();
    const s = await Signal.findByIdAndUpdate(req.params.id, update, { new:true });
    if (!s) return res.status(404).json({ success:false, error:'Not found' });
    broadcastSignalUpdate(); res.json({ success:true, data:s });
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
  try { const s = await Settings.findOneAndUpdate({ key:req.params.key }, { value:req.body.value }, { new:true, upsert:true }); res.json({ success:true, data:s }); }
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
    const r = await UserRecord.findOneAndUpdate({ firebaseUid:req.params.uid }, { suspended:true, suspendedAt:new Date(), suspendReason:req.body.reason||'Suspended by admin' }, { new:true });
    if (!r) return res.status(404).json({ success:false, error:'User not found' });
    if (firebaseAdminReady) try { await firebaseAdmin.auth().updateUser(req.params.uid, { disabled:true }); } catch (_) {}
    res.json({ success:true, message:'User suspended', data:r });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.post('/api/admin/users/:uid/unsuspend', adminAuth, async (req, res) => {
  try {
    const r = await UserRecord.findOneAndUpdate({ firebaseUid:req.params.uid }, { suspended:false, $unset:{ suspendedAt:1, suspendReason:1 } }, { new:true });
    if (!r) return res.status(404).json({ success:false, error:'User not found' });
    if (firebaseAdminReady) try { await firebaseAdmin.auth().updateUser(req.params.uid, { disabled:false }); } catch (_) {}
    res.json({ success:true, message:'User unsuspended', data:r });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.delete('/api/admin/users/:uid', adminAuth, async (req, res) => {
  try {
    await UserRecord.findOneAndDelete({ firebaseUid:req.params.uid });
    if (firebaseAdminReady) try { await firebaseAdmin.auth().deleteUser(req.params.uid); } catch (_) {}
    res.json({ success:true, message:'User deleted' });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.put('/api/admin/users/:uid/role', adminAuth, async (req, res) => {
  try {
    if (!['user','premium','admin'].includes(req.body.role)) return res.status(400).json({ success:false, error:'Invalid role' });
    res.json({ success:true, data: await UserRecord.findOneAndUpdate({ firebaseUid:req.params.uid }, { role:req.body.role }, { new:true }) });
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
    const r = await UserRecord.findOneAndUpdate({ firebaseUid:req.firebaseUser.uid }, { $set:{ settings:updates } }, { new:true, upsert:true });
    res.json({ success:true, data:r.settings });
  } catch (e) { res.status(400).json({ success:false, error:e.message }); }
});
app.delete('/api/user/settings', verifyFirebaseToken, async (req, res) => {
  try { await UserRecord.findOneAndUpdate({ firebaseUid:req.firebaseUser.uid }, { $set:{ settings:{} } }); res.json({ success:true }); }
  catch (e) { res.status(500).json({ success:false, error:e.message }); }
});

/* Public APIs */
const HARDCODED_SIGNALS = [
  { id:1, pair:'BTC/USDT', coin:'BTC', emoji:'₿', direction:'LONG', timeframe:'4H', entry:83500, tp1:87000, tp2:91500, sl:80000, grade:'A+', rrr:'2.1:1', status:'ACTIVE', confidence:92, posted:'2026-04-01 08:00', exchange:'Binance Futures' },
  { id:2, pair:'ETH/USDT', coin:'ETH', emoji:'Ξ', direction:'LONG', timeframe:'1H', entry:1870, tp1:1980, tp2:2100, sl:1800, grade:'A', rrr:'2.4:1', status:'ACTIVE', confidence:85, posted:'2026-04-01 09:30', exchange:'Binance Futures' },
  { id:3, pair:'SOL/USDT', coin:'SOL', emoji:'◎', direction:'SHORT', timeframe:'4H', entry:142, tp1:128, tp2:118, sl:150, grade:'B+', rrr:'1.8:1', status:'WAITING', confidence:78, posted:'2026-04-01 10:00', exchange:'Binance Futures' },
];
app.get('/api/signals', async (req, res) => {
  if (mongoConnected) {
    try {
      const { status } = req.query;
      const signals = await Signal.find(status?{status}:{}).sort({ postedAt:-1 }).limit(50);
      if (signals.length > 0) return res.json({ success:true, count:signals.length, data:signals, source:'mongodb' });
    } catch (e) { console.error('[API]', e.message); }
  }
  res.json({ success:true, count:HARDCODED_SIGNALS.length, data:HARDCODED_SIGNALS, source:'hardcoded' });
});
app.get('/api/announcement', async (req, res) => {
  if (!mongoConnected) return res.json({ success:true, data:null });
  try {
    const now = new Date();
    res.json({ success:true, data: await Announcement.findOne({ active:true, showFrom:{ $lte:now }, $or:[{ showUntil:null },{ showUntil:{ $gte:now } }] }).sort({ createdAt:-1 }) });
  } catch (e) { res.status(500).json({ success:false, error:e.message }); }
});
app.get('/api/settings/public', async (req, res) => {
  if (!mongoConnected) return res.json({ success:true, data:{} });
  try {
    const PUBLIC_KEYS = ['site_name','site_tagline','site_url','footer_text','adsense_enabled','adsense_publisher_id','adsense_auto_ads','adsense_slot_header','adsense_slot_sidebar','adsense_slot_inline','adsense_slot_footer','seo_title','seo_description','seo_keywords','og_image','google_analytics_id','signals_disclaimer','social_telegram','social_twitter','social_discord','social_youtube','maintenance_mode','register_open'];
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
app.get('/health', (req, res) => res.json({ status:'ok', clients:wss.clients.size, uptime:process.uptime(), marketCoins:Object.keys(marketData).length, wsState:binanceWsState, mongoConnected }));

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
