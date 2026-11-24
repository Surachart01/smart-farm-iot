// REST API + Web Dashboard — ระบบฟาร์มอัจฉริยะ IoT และการจัดการฐานข้อมูลคลาวด์สำหรับธุรกิจเพาะเลี้ยงพืชอวบน้ำ
// อุปกรณ์ส่งข้อมูลทุก 5 นาที -> เก็บลง MongoDB -> หน้าเว็บแสดงผลและสั่งงาน
// AI (Gemini Flash-Lite) ใช้เฉพาะ "แนะนำค่าเกณฑ์" เมื่อผู้ใช้กดขอ ไม่ได้ควบคุมอุปกรณ์และไม่เปลี่ยนค่าเอง
// รันได้ 2 แบบ: ในเครื่อง (node server.js) หรือบน Vercel (ใช้ไฟล์นี้เป็น Vercel Function ผ่าน module.exports = app)
// บน Vercel ห้ามเก็บสถานะไว้ในหน่วยความจำ เพราะแต่ละคำขออาจรันคนละเครื่อง สถานะทั้งหมดจึงเก็บใน MongoDB
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const crypto = require('crypto');
const express = require('express');
const { MongoClient } = require('mongodb');
const gemini = require('./gemini');

const {
  MONGODB_URI = 'mongodb://127.0.0.1:27017', DB_NAME = 'smartfarm', API_KEY = '', PORT = 3000,
  GEMINI_API_KEY = '', GEMINI_MODEL = 'gemini-3.5-flash-lite',
} = process.env;
const ON_VERCEL = !!process.env.VERCEL;
const CONFIG_ERROR = !API_KEY || API_KEY.startsWith('เปลี่ยน')
  ? `ยังไม่ได้ตั้ง API_KEY ${ON_VERCEL ? 'ใน Environment Variables ของ Vercel' : 'ในไฟล์ .env (คัดลอกจาก .env.example แล้วแก้ค่า)'}`
  : (ON_VERCEL && /127\.0\.0\.1|localhost/.test(MONGODB_URI) ? 'ยังไม่ได้ตั้ง MONGODB_URI (MongoDB Atlas) ใน Environment Variables ของ Vercel' : null);
const geminiReady = () => !!GEMINI_API_KEY && !GEMINI_API_KEY.startsWith('ใส่');

const SEND_INTERVAL_S = 300;                       // อุปกรณ์ส่งข้อมูลทุก 5 นาที
const NO_DATA_ALERT_MS = 12 * 60 * 1000;           // ไม่ได้รับข้อมูลเกิน 2 รอบ + เผื่อ 2 นาที
const OFFLINE_AFTER_MS = 2 * 60 * 1000;            // อุปกรณ์ส่งค่าสดทุก 5 วินาที (รุ่นเก่าทุก 60 วินาที)
const AI_MIN_GAP_MS = 30 * 1000;                   // ขอคำแนะนำจาก Gemini ได้ห่างกันอย่างน้อย 30 วินาที (กันกดรัวเปลืองโควตา)
const DAY_MS = 86400e3, TZ_MS = 7 * 3600e3;

const DEFAULT_SETTINGS = {
  mode: 'auto',
  soil_on: 30, soil_off: 45, wet_limit: 60, ai_emergency: 20,
  pump_pulse_s: 5, max_pump_s_day: 200, flow_ml_s: 10,
  lux_on: 2000, lux_off: 3000, day_start: 6, day_end: 18,
  alert_temp: 35, alert_humidity: 80,
  guard_pump_s: 30, guard_min_rise: 2,    // ป้องกันรดไม่หยุด: รดอัตโนมัติรวมเกินกี่วินาทีแล้วความชื้นขึ้นไม่ถึงกี่ % -> หยุด
};
// [ต่ำสุด, สูงสุด] ของค่าตั้งที่ผู้ใช้แก้ได้
const SETTING_RANGES = {
  soil_on: [0, 100], soil_off: [0, 100], wet_limit: [0, 100], ai_emergency: [0, 100],
  pump_pulse_s: [1, 20], max_pump_s_day: [10, 3600], flow_ml_s: [0.1, 1000],
  lux_on: [0, 65535], lux_off: [0, 65535], day_start: [0, 23], day_end: [1, 24],
  alert_temp: [0, 60], alert_humidity: [0, 100],
  guard_pump_s: [10, 300], guard_min_rise: [0.5, 20],
};
const OLD_SETTING_KEYS = ['max_pulses_day', 'ai_pred_min', 'ai_start', 'ai_end', 'ai_max_pump_s'];
const MODES = ['auto', 'manual'];                   // ยกเลิกโหมด AI แล้ว (AI ใช้แนะนำค่าเกณฑ์เท่านั้น)
// ช่วงค่าที่เป็นไปได้ของเซ็นเซอร์ (ค่านอกช่วง = ปฏิเสธ)
const READING_RANGES = {
  temperature: [-10, 60], humidity: [0, 100], pressure: [800, 1100], lux: [0, 65535], soil: [0, 100],
};

let readings, settingsCol, events, aiCol, liveCol;

// ---------------- เชื่อมต่อฐานข้อมูล (ครั้งแรกที่มีคำขอ แล้วใช้ซ้ำ) ----------------
let readyPromise = null;
async function init() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5 });
  await client.connect();
  const db = client.db(DB_NAME);
  readings = db.collection('readings');
  settingsCol = db.collection('settings');
  events = db.collection('events');
  aiCol = db.collection('ai_suggestions');   // คำแนะนำค่าเกณฑ์จาก AI ทุกครั้งที่ผู้ใช้กดขอ
  liveCol = db.collection('live');           // ค่าสดล่าสุดของแต่ละอุปกรณ์ (ทับทุก 5 วินาที ไม่ใช้ในสถิติ)
  await Promise.all([readings.createIndex({ timestamp: -1 }), events.createIndex({ timestamp: -1 }), aiCol.createIndex({ timestamp: -1 })]);
  await settingsCol.updateOne({ _id: 'main' }, { $setOnInsert: DEFAULT_SETTINGS }, { upsert: true });
  // เพิ่มค่าตั้งใหม่ที่ยังไม่มี และลบค่าตั้งของเวอร์ชันเก่า
  const cur = await settingsCol.findOne({ _id: 'main' });
  const add = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => cur[k] === undefined));
  await settingsCol.updateOne({ _id: 'main' }, {
    ...(Object.keys(add).length ? { $set: add } : {}),
    $unset: Object.fromEntries(OLD_SETTING_KEYS.map(k => [k, ''])),
  });
  if (!MODES.includes(cur.mode)) await settingsCol.updateOne({ _id: 'main' }, { $set: { mode: 'auto' } });   // เคยเป็นโหมด AI -> ตามเกณฑ์
}
function ready() {
  if (!readyPromise) readyPromise = init().catch(e => { readyPromise = null; throw e; });   // ล้มเหลว = ลองใหม่ในคำขอถัดไป
  return readyPromise;
}

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));     // บน Vercel ไฟล์ใน public/ ถูกเสิร์ฟผ่าน CDN แทน
app.use('/api', async (req, res, next) => {
  if (CONFIG_ERROR) return res.status(500).json({ error: CONFIG_ERROR });
  try { await ready(); next(); }
  catch (e) { console.error('เชื่อมต่อ MongoDB ไม่ได้:', e.message); res.status(503).json({ error: 'เชื่อมต่อฐานข้อมูลไม่ได้' }); }
});
// Express 4 ไม่จับ error ของฟังก์ชัน async เอง -> ส่งต่อให้ตัวจัดการ error ด้านล่าง
for (const m of ['get', 'post', 'put']) {
  const orig = app[m].bind(app);
  app[m] = (p, ...fns) => (fns.length ? orig(p, ...fns.map(f => (req, res, next) => Promise.resolve(f(req, res, next)).catch(next))) : orig(p));
}

function requireKey(req, res, next) {
  const k = req.get('x-api-key') || '';
  const a = Buffer.from(k), b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'API key ไม่ถูกต้อง' });
  next();
}

async function getSettings() {
  const s = await settingsCol.findOne({ _id: 'main' });
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
const publicSettings = s => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, s[k]]));
const localDate = d => new Date(d.getTime() + TZ_MS).toISOString().slice(0, 10);
const localMidnight = d => new Date(Math.floor((d.getTime() + TZ_MS) / DAY_MS) * DAY_MS - TZ_MS);
const hhmm = d => new Date(d.getTime() + TZ_MS).toISOString().slice(11, 16);

// คำสั่งจากเว็บที่ค้างอยู่ -> ส่งให้อุปกรณ์ครั้งเดียวแล้วลบ (และบันทึกเวลาที่อุปกรณ์ติดต่อมาล่าสุด)
async function takeCommand() {
  const before = await settingsCol.findOneAndUpdate(
    { _id: 'main' }, { $unset: { pending_command: '' }, $set: { last_seen: new Date() } }, { returnDocument: 'before', upsert: true });
  return { settings: { ...DEFAULT_SETTINGS, ...(before || {}) }, command: before?.pending_command || null };
}

async function pumpSecondsSince(from) {
  const [a] = await readings.aggregate([
    { $match: { timestamp: { $gte: from } } }, { $group: { _id: null, s: { $sum: '$pump_s' } } }]).toArray();
  return a ? a.s : 0;
}

// ---------------- AI: แนะนำค่าเกณฑ์ (Gemini Flash-Lite) ----------------
// สรุปข้อมูลจริงให้ AI: รายชั่วโมง 24 ชม.ล่าสุด + ภาพรวม 3 วันล่าสุด
async function buildSuggestContext(s) {
  const now = new Date();
  const [live, rows, waterings, locks] = await Promise.all([
    liveCol.find({}, { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(1).next(),
    readings.find({ timestamp: { $gte: new Date(now - 3 * DAY_MS) } })
      .project({ _id: 0, timestamp: 1, soil: 1, temperature: 1, humidity: 1, lux: 1, pump_s: 1, led: 1 }).sort({ timestamp: 1 }).toArray(),
    events.countDocuments({ type: 'pump_on', timestamp: { $gte: new Date(now - 3 * DAY_MS) } }),
    events.countDocuments({ type: 'water_lock', timestamp: { $gte: new Date(now - 3 * DAY_MS) } }),
  ]);
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const nums = (rs, k) => rs.map(r => r[k]).filter(v => typeof v === 'number');
  // รายชั่วโมง 24 ชม.ล่าสุด
  const hourly = [];
  const recent = rows.filter(r => r.timestamp >= new Date(now - DAY_MS));
  const byHour = new Map();
  for (const r of recent) {
    const k = Math.floor(r.timestamp.getTime() / 3600e3);
    if (!byHour.has(k)) byHour.set(k, []);
    byHour.get(k).push(r);
  }
  for (const [k, rs] of [...byHour.entries()].sort((x, y) => x[0] - y[0])) {
    const soil = nums(rs, 'soil'), temp = nums(rs, 'temperature'), lux = nums(rs, 'lux');
    hourly.push({
      hour: `${localDate(new Date(k * 3600e3)).slice(5)} ${hhmm(new Date(k * 3600e3))}`,
      soil_avg: avg(soil), soil_min: soil.length ? Math.min(...soil) : null, soil_max: soil.length ? Math.max(...soil) : null,
      temp_avg: avg(temp), temp_max: temp.length ? Math.max(...temp) : null, hum_avg: avg(nums(rs, 'humidity')),
      lux_avg: avg(lux), lux_max: lux.length ? Math.max(...lux) : null,
      pump_s: rs.reduce((x, r) => x + (r.pump_s || 0), 0), led_pct: avg(rs.map(r => (r.led ? 100 : 0))),
    });
  }
  // ภาพรวมทั้งช่วง (สูงสุด 3 วัน)
  const soils = nums(rows, 'soil');
  const span = rows.length > 1 ? (rows[rows.length - 1].timestamp - rows[0].timestamp) / DAY_MS : 0;
  const per = Math.max(span, 1);
  const pct = n => (soils.length ? (n / soils.length) * 100 : null);
  const days = {
    label: span >= 1 ? ` ${Math.round(span * 10) / 10} วันล่าสุด` : ` ${Math.round(span * 240) / 10} ชั่วโมงล่าสุด (ข้อมูลยังไม่ครบวัน ใช้ตัดสินใจอย่างระวัง)`,
    samples: rows.length,
    in_range_pct: pct(soils.filter(v => v >= s.soil_on && v <= s.wet_limit).length),
    too_dry_pct: pct(soils.filter(v => v < s.soil_on).length),
    over_wet_pct: pct(soils.filter(v => v > s.wet_limit).length),
    pump_s_per_day: rows.reduce((x, r) => x + (r.pump_s || 0), 0) / per,
    waterings_per_day: waterings / per,
    led_hours_per_day: rows.filter(r => r.led).length * (SEND_INTERVAL_S / 3600) / per,
    water_locks: locks,
  };
  days.water_l_per_day = days.pump_s_per_day * s.flow_ml_s / 1000;
  // ไม่มีค่าสด (บอร์ดรุ่นเก่า/ออฟไลน์) -> ใช้ค่าที่บันทึกล่าสุดแทน
  return { now: `${localDate(now)} ${hhmm(now)}`, settings: s, live: live || rows[rows.length - 1] || null, hourly, days };
}

// ---------------- อุปกรณ์ส่งข้อมูล (ทุก 5 นาที): POST /api/readings ----------------
app.post('/api/readings', requireKey, async (req, res) => {
  const b = req.body || {};
  if (typeof b.device !== 'string' || !b.device) return res.status(400).json({ error: 'ต้องมี device' });
  const doc = { timestamp: new Date(), device: b.device.slice(0, 32) };
  for (const [k, [lo, hi]] of Object.entries(READING_RANGES)) {
    const v = b[k];
    if (v === null || v === undefined) { doc[k] = null; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      return res.status(400).json({ error: `ค่า ${k} ไม่ถูกต้อง: ${v}` });
    }
    doc[k] = v;
  }
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  doc.soil_raw = int(b.soil_raw, 0, 65535);
  doc.boot = int(b.boot, 0, 2 ** 32 - 1);
  doc.seq = int(b.seq, 1, 2 ** 32 - 1);
  doc.pump_s = typeof b.pump_s === 'number' && b.pump_s >= 0 && b.pump_s <= SEND_INTERVAL_S * 3 ? Math.round(b.pump_s * 10) / 10 : 0;
  doc.pump_events = int(b.pump_events, 0, 1000) ?? 0;
  doc.led = b.led ? 1 : 0;
  doc.mode = MODES.includes(b.mode) ? b.mode : null;
  doc.decision = typeof b.decision === 'string' ? b.decision.slice(0, 40) : null;
  doc.errors = Array.isArray(b.errors) ? b.errors.filter(e => typeof e === 'string').slice(0, 5) : [];
  doc.rssi = Number.isFinite(b.rssi) ? b.rssi : null;
  doc.uptime_s = Number.isFinite(b.uptime_s) ? b.uptime_s : null;
  doc.board = typeof b.board === 'string' ? b.board.slice(0, 16) : null;
  doc.temp_sensor = typeof b.temp_sensor === 'string' ? b.temp_sensor.slice(0, 16) : null;
  doc.water_lock = b.water_lock ? 1 : 0;

  const s = await getSettings();
  doc.water_ml = Math.round(doc.pump_s * s.flow_ml_s);
  await readings.insertOne(doc);

  if (doc.pump_s > 0) {
    const src = MODES.includes(b.pump_source) ? b.pump_source : 'auto';
    await events.insertOne({ timestamp: doc.timestamp, type: 'pump_on', source: src, pump_s: doc.pump_s, water_ml: doc.water_ml, soil: doc.soil });
  }
  if (doc.errors.length) await events.insertOne({ timestamp: doc.timestamp, type: 'sensor_error', detail: doc.errors.join(',') });

  const { settings, command } = await takeCommand();
  res.json({
    settings: publicSettings(settings),
    command,
    server_time: new Date().toISOString(),
  });
});

// ---------------- อุปกรณ์ถามค่าตั้งและคำสั่ง + ส่งค่าสด (ทุก 5 วินาที): POST /api/device/poll ----------------
// ค่าสดเก็บทับไว้ใน collection "live" เพื่อแสดงบน Dashboard แบบเกือบเรียลไทม์
// ข้อมูลสำหรับกราฟและสถิติยังเป็น readings ที่ส่งทุก 5 นาทีตามบทที่ 3
async function devicePoll(req, res) {
  const b = req.body || {};
  if (typeof b.device === 'string' && b.device) {
    const live = { timestamp: new Date() };
    for (const [k, [lo, hi]] of Object.entries(READING_RANGES)) {
      const v = b[k];
      live[k] = typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
    }
    live.pump = b.pump ? 1 : 0;
    live.led = b.led ? 1 : 0;
    live.mode = MODES.includes(b.mode) ? b.mode : null;
    live.rssi = Number.isFinite(b.rssi) ? b.rssi : null;
    live.water_lock = b.water_lock ? 1 : 0;
    const prev = await liveCol.findOneAndUpdate({ _id: b.device.slice(0, 32) }, { $set: live }, { upsert: true, returnDocument: 'before' });
    if (prev && (prev.water_lock ? 1 : 0) !== live.water_lock) {
      await events.insertOne(live.water_lock
        ? { timestamp: live.timestamp, type: 'water_lock', detail: `หยุดรดอัตโนมัติ: รดแล้วความชื้นไม่ขึ้น (ความชื้นตอนนี้ ${live.soil ?? '-'}%)` }
        : { timestamp: live.timestamp, type: 'water_unlock', detail: 'กลับมารดอัตโนมัติได้' });
    }
  }
  const { settings, command } = await takeCommand();
  res.json({ settings: publicSettings(settings), command, server_time: new Date().toISOString() });
}
app.get('/api/device/poll', requireKey, devicePoll);       // เฟิร์มแวร์รุ่นเก่า (ไม่มีค่าสด)
app.post('/api/device/poll', requireKey, devicePoll);

// ---------------- ข้อมูลล่าสุดและย้อนหลัง: GET /api/readings ----------------
function rangeQuery(req, defDays) {
  const q = {};
  const days = Number(req.query.days);
  let from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  if (!from && Number.isFinite(days) && days > 0) from = new Date(Date.now() - days * DAY_MS);
  if (!from && defDays) from = new Date(Date.now() - defDays * DAY_MS);
  if (from && !isNaN(from)) q.timestamp = { ...(q.timestamp || {}), $gte: from };
  if (to && !isNaN(to)) q.timestamp = { ...(q.timestamp || {}), $lte: to };
  return q;
}

app.get('/api/readings', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 1440, 20000);
  const rows = await readings.find(rangeQuery(req), { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(limit).toArray();
  res.json(rows.reverse());
});

// ---------------- ค่าสดสำหรับ Dashboard (เรียกทุก 5 วินาที จึงทำให้เบาที่สุด) ----------------
app.get('/api/live', async (req, res) => {
  const [live, s] = await Promise.all([
    liveCol.find({}, { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(1).next(),
    settingsCol.findOne({ _id: 'main' }, { projection: { mode: 1, last_seen: 1, pending_command: 1 } }),
  ]);
  const seen = Math.max(s?.last_seen ? s.last_seen.getTime() : 0, live ? live.timestamp.getTime() : 0);
  res.set('Cache-Control', 'no-store');
  res.json({ online: Date.now() - seen < OFFLINE_AFTER_MS, live, mode: s?.mode || DEFAULT_SETTINGS.mode, pending_command: s?.pending_command || null });
});

// ---------------- สถานะรวมสำหรับ Dashboard ----------------
app.get('/api/status', async (req, res) => {
  const latest = await readings.find({}, { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(1).next();
  const s = await getSettings();
  const live = await liveCol.find({}, { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(1).next();
  const seen = Math.max(s.last_seen ? s.last_seen.getTime() : 0, latest ? latest.timestamp.getTime() : 0, live ? live.timestamp.getTime() : 0);
  const online = Date.now() - seen < OFFLINE_AFTER_MS;
  const lastAi = await aiCol.find({}, { projection: { _id: 0, prompt: 0, raw: 0 } }).sort({ timestamp: -1 }).limit(1).next();
  const waterTodayMl = (await pumpSecondsSince(localMidnight(new Date()))) * s.flow_ml_s;
  const alerts = [];
  if (!latest) alerts.push({ level: 'warn', text: 'ยังไม่มีข้อมูลจากอุปกรณ์' });
  else {
    if (!online) alerts.push({ level: 'crit', text: 'อุปกรณ์ขาดการเชื่อมต่อเกิน 2 นาที' });
    else if (Date.now() - latest.timestamp.getTime() > NO_DATA_ALERT_MS) alerts.push({ level: 'crit', text: 'ไม่ได้รับข้อมูลขึ้นคลาวด์เกิน 12 นาที' });
    if (latest.temperature != null && latest.temperature > s.alert_temp) alerts.push({ level: 'crit', text: `อุณหภูมิสูง ${latest.temperature.toFixed(1)} °C` });
    if (latest.humidity != null && latest.humidity > s.alert_humidity) alerts.push({ level: 'warn', text: `ความชื้นอากาศสูง ${latest.humidity.toFixed(0)}%` });
    if (latest.soil != null && latest.soil < s.ai_emergency) alerts.push({ level: 'crit', text: `วัสดุปลูกแห้งวิกฤต ${latest.soil.toFixed(0)}% (ต่ำกว่า ${s.ai_emergency}%)` });
    if (latest.soil != null && latest.soil > s.wet_limit) alerts.push({ level: 'crit', text: `วัสดุปลูกแฉะเกินเกณฑ์ ${latest.soil.toFixed(0)}% (เสี่ยงรากเน่า)` });
    if (latest.errors && latest.errors.length) alerts.push({ level: 'crit', text: `อ่านค่าเซ็นเซอร์ไม่ได้: ${latest.errors.join(', ')}` });
  }
  const lockSrc = (live && (!latest || live.timestamp > latest.timestamp)) ? live : latest;
  if (lockSrc?.water_lock) alerts.unshift({ level: 'crit', code: 'water_lock',
    text: `หยุดรดน้ำอัตโนมัติแล้ว: รดไปแต่ความชื้นไม่ขึ้น ตรวจว่าเซ็นเซอร์ปักอยู่ในดินบริเวณที่น้ำลง แล้วกด "ปลดล็อกการรดน้ำ"` });
  res.json({
    online, latest, live, settings: publicSettings(s), pending_command: s.pending_command || null, alerts,
    ai: { ready: geminiReady(), model: GEMINI_MODEL, last: lastAi },
    water_today_l: Math.round(waterTodayMl) / 1000,
    send_interval_s: SEND_INTERVAL_S,
  });
});

app.get('/api/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000);
  res.json(await events.find({}, { projection: { _id: 0 } }).sort({ timestamp: -1 }).limit(limit).toArray());
});

// ---------------- AI แนะนำค่าเกณฑ์: POST /api/ai/suggest (ผู้ใช้กดขอจากหน้าเว็บ) ----------------
app.post('/api/ai/suggest', async (req, res) => {
  if (!geminiReady()) return res.status(503).json({ error: 'ยังไม่ได้ตั้ง GEMINI_API_KEY บนเซิร์ฟเวอร์' });
  // จองสิทธิ์แบบ atomic ในฐานข้อมูล กันกดรัว (ใช้ได้แม้รันหลายเครื่องบน Vercel)
  const nowD = new Date();
  const slot = await settingsCol.updateOne(
    { _id: 'main', $or: [{ ai_last_call: { $exists: false } }, { ai_last_call: { $lt: new Date(nowD - AI_MIN_GAP_MS) } }] },
    { $set: { ai_last_call: nowD } });
  if (!slot.modifiedCount) return res.status(429).json({ error: 'เพิ่งขอคำแนะนำไป รอสักครู่ (30 วินาที) แล้วลองใหม่' });
  const s = await getSettings();
  const ctx = await buildSuggestContext(s);
  const rec = { timestamp: nowD, model: GEMINI_MODEL, settings_before: Object.fromEntries(gemini.KEYS.map(k => [k, s[k]])), context: ctx.days };
  try {
    const out = await gemini.suggest(ctx, SETTING_RANGES, { apiKey: GEMINI_API_KEY, model: GEMINI_MODEL, timeoutMs: 45000 });
    Object.assign(rec, {
      id: crypto.randomUUID(), summary: out.summary, recommendations: out.recommendations, notes: out.notes, confidence: out.confidence,
      latency_ms: out.latency_ms, tokens: out.usage?.totalTokenCount ?? null, prompt: out.prompt, raw: out.raw, error: null,
    });
    await aiCol.insertOne(rec);
    await events.insertOne({ timestamp: nowD, type: 'ai_suggest', source: 'web',
      detail: `เปลี่ยน ${gemini.KEYS.filter(k => out.recommendations[k].changed).length} ค่า — ${out.summary.slice(0, 120)}` });
    const { prompt, raw, _id, ...pub } = rec;
    res.json(pub);
  } catch (e) {
    rec.error = e.name === 'TimeoutError' ? 'Gemini ตอบช้าเกิน 45 วินาที' : e.message;
    await aiCol.insertOne(rec);
    console.error('[Gemini]', rec.error);
    res.status(502).json({ error: `ขอคำแนะนำไม่สำเร็จ: ${rec.error}` });
  }
});

app.get('/api/ai/suggestions', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 500);
  res.json(await aiCol.find(rangeQuery(req), { projection: { _id: 0, prompt: 0, raw: 0 } }).sort({ timestamp: -1 }).limit(limit).toArray());
});

// ---------------- สถิติสำหรับบทที่ 4: GET /api/stats?days=14 ----------------
app.get('/api/stats', async (req, res) => {
  const q = rangeQuery(req, 14);
  const s = await getSettings();
  const rows = await readings.find(q).project({ _id: 0, timestamp: 1, soil: 1, boot: 1, seq: 1, pump_s: 1, water_ml: 1 }).sort({ timestamp: 1 }).toArray();

  // 1) อัตราการส่งข้อมูลขึ้นคลาวด์สำเร็จ: นับตามลำดับ seq ของแต่ละรอบเปิดเครื่อง
  const boots = new Map();
  for (const r of rows) {
    if (r.boot == null || r.seq == null) continue;
    const b = boots.get(r.boot) || { n: 0, min: Infinity, max: 0 };
    b.n++; b.min = Math.min(b.min, r.seq); b.max = Math.max(b.max, r.seq);
    boots.set(r.boot, b);
  }
  let received = 0, expected = 0;
  for (const b of boots.values()) { received += b.n; expected += b.max - b.min + 1; }

  // 2) การรักษาระดับความชื้น
  const soils = rows.filter(r => r.soil != null);
  const pct = n => (soils.length ? Math.round((n / soils.length) * 10000) / 100 : null);
  const inRange = soils.filter(r => r.soil >= s.soil_on && r.soil <= s.wet_limit).length;
  const overWet = soils.filter(r => r.soil > s.wet_limit).length;
  const tooDry = soils.filter(r => r.soil < s.soil_on).length;

  // 3) ปริมาณน้ำ (ลิตร) รายวัน
  const perDay = {};
  let totalMl = 0;
  for (const r of rows) {
    const ml = r.water_ml ?? Math.round((r.pump_s || 0) * s.flow_ml_s);
    totalMl += ml;
    const d = localDate(r.timestamp);
    perDay[d] = (perDay[d] || 0) + ml;
  }
  const days = Object.keys(perDay).length;

  // 4) จำนวนครั้งที่ขอคำแนะนำจาก AI
  const aiSuggestions = await aiCol.countDocuments({ ...q, error: null });

  res.json({
    period: { from: rows[0]?.timestamp ?? null, to: rows[rows.length - 1]?.timestamp ?? null, readings: rows.length },
    upload: { received, expected, success_pct: expected ? Math.round((received / expected) * 10000) / 100 : null },
    soil: { samples: soils.length, in_range_pct: pct(inRange), over_wet_pct: pct(overWet), too_dry_pct: pct(tooDry),
      range: [s.soil_on, s.wet_limit] },
    water: { total_l: Math.round(totalMl) / 1000, avg_l_per_day: days ? Math.round(totalMl / days) / 1000 : null,
      per_day_l: Object.fromEntries(Object.entries(perDay).map(([k, v]) => [k, Math.round(v) / 1000])) },
    ai: { model: GEMINI_MODEL, suggestions: aiSuggestions },
  });
});

// ---------------- ส่งออกข้อมูลเป็น CSV (เปิดด้วย Excel): GET /api/export.csv?days=14 ----------------
app.get('/api/export.csv', async (req, res) => {
  const cols = ['timestamp', 'soil', 'temperature', 'humidity', 'pressure', 'lux', 'soil_raw', 'pump_s', 'water_ml', 'led', 'mode',
    'decision', 'water_lock', 'seq', 'boot', 'rssi', 'errors'];
  const rows = await readings.find(rangeQuery(req, 14)).sort({ timestamp: 1 }).toArray();
  const cell = v => {
    if (v == null) return '';
    if (v instanceof Date) return new Date(v.getTime() + TZ_MS).toISOString().replace('T', ' ').slice(0, 19);
    const t = Array.isArray(v) ? v.join(' ') : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="smartfarm_${localDate(new Date())}.csv"`);
  res.send('﻿' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n'));
});

// ---------------- ค่าตั้ง ----------------
app.get('/api/settings', async (req, res) => res.json(publicSettings(await getSettings())));

// หน้าเว็บแก้ค่าตั้งและสั่งงานได้โดยไม่ต้องใส่รหัส (ผู้ใช้ขอ) ส่วนเส้นทางของบอร์ดยังต้องใช้ API_KEY
// ข้อมูลทดลองจึงยังปลอมจากภายนอกไม่ได้
app.put('/api/settings', async (req, res) => {
  const b = req.body || {};
  const upd = {};
  if (b.mode !== undefined) {
    if (!MODES.includes(b.mode)) return res.status(400).json({ error: 'mode ต้องเป็น auto (ตามเกณฑ์) หรือ manual (สั่งเอง)' });
    upd.mode = b.mode;
  }
  for (const [k, [lo, hi]] of Object.entries(SETTING_RANGES)) {
    if (b[k] === undefined) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) return res.status(400).json({ error: `${k} ต้องอยู่ระหว่าง ${lo}–${hi}` });
    upd[k] = v;
  }
  const cur = await getSettings();
  const m = { ...cur, ...upd };
  if (!(m.ai_emergency < m.soil_on && m.soil_on < m.soil_off && m.soil_off <= m.wet_limit))
    return res.status(400).json({ error: 'ต้องเรียงค่า: แห้งวิกฤต < เริ่มให้น้ำ < หยุดให้น้ำ ≤ แฉะเกินเกณฑ์' });
  if (m.lux_on >= m.lux_off) return res.status(400).json({ error: 'เกณฑ์เปิดไฟต้องต่ำกว่าเกณฑ์ปิดไฟ' });
  if (m.day_start >= m.day_end) return res.status(400).json({ error: 'เวลาเริ่มต้องน้อยกว่าเวลาสิ้นสุด' });
  await settingsCol.updateOne({ _id: 'main' }, { $set: { ...upd, updated_at: new Date() } }, { upsert: true });
  // บันทึกเฉพาะค่าที่เปลี่ยนจริง ในรูป { ชื่อค่า: [ค่าเดิม, ค่าใหม่] } ประวัติจะอ่านง่าย
  const diff = Object.fromEntries(Object.keys(upd).filter(k => cur[k] !== upd[k]).map(k => [k, [cur[k], upd[k]]]));
  if (Object.keys(diff).length) await events.insertOne({ timestamp: new Date(), type: 'settings_changed', detail: JSON.stringify(diff) });
  res.json(publicSettings(await getSettings()));
});

// ---------------- สั่งงานจากเว็บ: POST /api/control ----------------
// { "device": "pump", "action": "pulse" } หรือ { "device": "led", "action": "on" | "off" }
app.post('/api/control', async (req, res) => {
  const { device, action } = req.body || {};
  const ok = (device === 'pump' && ['pulse', 'unlock'].includes(action)) || (device === 'led' && ['on', 'off'].includes(action));
  if (!ok) return res.status(400).json({ error: 'คำสั่งไม่ถูกต้อง' });
  const cmd = { id: crypto.randomUUID(), device, action, at: new Date() };
  await settingsCol.updateOne({ _id: 'main' }, { $set: { pending_command: cmd } }, { upsert: true });
  await events.insertOne({ timestamp: cmd.at, type: `manual_${device}_${action}`, source: 'web' });
  res.json({ queued: cmd, note: 'อุปกรณ์จะรับคำสั่งภายใน 5 วินาที' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ error: err.type === 'entity.parse.failed' ? 'JSON ไม่ถูกต้อง' : 'เซิร์ฟเวอร์ผิดพลาด' });
});

module.exports = app;          // Vercel ใช้ตัวนี้

// รันในเครื่องด้วย node server.js
if (require.main === module) (async () => {
  if (CONFIG_ERROR) { console.error(CONFIG_ERROR); process.exit(1); }
  await ready();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Smart Farm server พร้อมใช้งานที่ http://localhost:${PORT}`);
    console.log(geminiReady() ? `AI แนะนำค่าเกณฑ์: ใช้ ${GEMINI_MODEL}` : 'AI แนะนำค่าเกณฑ์: ยังไม่ได้ตั้ง GEMINI_API_KEY');
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets)) for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal) console.log(`  ใส่ใน config.h:  #define SERVER_URL "http://${n.address}:${PORT}"`);
  });
})().catch(e => { console.error('เชื่อมต่อ MongoDB ไม่ได้:', e.message); process.exit(1); });
