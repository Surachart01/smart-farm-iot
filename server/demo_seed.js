// สร้างข้อมูลจำลอง 3 วันลงฐานข้อมูลแยก "smartfarm_demo" สำหรับดูหน้าตาระบบ (ไม่ยุ่งกับข้อมูลทดลองจริงใน "smartfarm")
// ใช้:  node demo_seed.js   แล้วรัน  DB_NAME=smartfarm_demo node server.js
const { MongoClient } = require('mongodb');
const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB = 'smartfarm_demo';

(async () => {
  const c = await new MongoClient(URI).connect();
  const db = c.db(DB);
  await db.dropDatabase();
  const STEP = 5 * 60e3, DAYS = 3, now = Date.now(), start = now - DAYS * 86400e3;
  const flow = 10, boot = 424242;
  let soil = 42, seq = 0, lastWater = -1e12, carry = null;
  const readings = [], events = [], ai = [];
  let rnd = 7; const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);

  for (let t = start; t <= now; t += STEP) {
    seq++;
    if (r() < 0.006) continue;                         // จำลองการส่งข้อมูลหาย ~0.6%
    const h = ((new Date(t).getUTCHours() + 7) % 24) + new Date(t).getUTCMinutes() / 60;
    const day = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
    const temp = 25 + 8 * day + (r() - 0.5);
    const hum = 72 - 22 * day + (r() - 0.5) * 3;
    const lux = Math.round(day * 9000 * (0.6 + 0.4 * r()));
    soil -= (0.12 + 0.35 * day) * (STEP / 3600e3) * 2.2;  // แห้งเร็วตอนกลางวัน
    let pump_s = 0, action = 'wait', reason, pred = Math.max(5, soil - (0.6 + 2.4 * day) * 3);
    const sinceMin = (t - lastWater) / 60e3;
    if (soil < 20 && sinceMin > 10) { action = 'water'; pump_s = 8; reason = 'ความชื้นต่ำกว่าเกณฑ์แห้งวิกฤต ต้องรดน้ำทันที'; }
    else if (sinceMin > 10 && ((soil < 30) || (pred < 30 && h >= 6 && h < 10)) && soil < 45) {
      action = 'water'; pump_s = soil < 30 ? 12 : 8;
      reason = soil < 30 ? `ความชื้น ${soil.toFixed(0)}% ต่ำกว่า 30% ควรรดน้ำ` : `ช่วงเช้า และคาดว่าอีก 3 ชม. จะเหลือ ${pred.toFixed(0)}% รดล่วงหน้า`;
    } else if (soil >= 45) reason = `ความชื้น ${soil.toFixed(0)}% เพียงพอ ไม่ควรรดเพื่อป้องกันรากเน่า`;
    else if (h >= 18 || h < 6) reason = 'กลางคืน ความชื้นยังไม่ถึงเกณฑ์วิกฤต รอถึงเช้า';
    else reason = `ความชื้น ${soil.toFixed(0)}% ยังอยู่ในช่วงเหมาะสม รอให้แห้งลงก่อน`;

    const ts = new Date(t);
    const doc = {
      timestamp: ts, device: 'farm-01', temperature: +temp.toFixed(2), humidity: +hum.toFixed(1), pressure: +(1009 + 2 * Math.sin(t / 4e7)).toFixed(1),
      lux, soil: +soil.toFixed(1), soil_raw: Math.round(620 - soil * 3.4), boot, seq, pump_s: 0, pump_events: 0, water_ml: 0,
      led: (h >= 6 && h < 18 && lux < 2000) ? 1 : 0, mode: 'ai', decision: action === 'water' ? 'ai_water' : 'ai_wait',
      errors: [], rssi: -58 - Math.round(r() * 8), uptime_s: Math.round((t - start) / 1000), board: 'esp8266', temp_sensor: 'bme280',
      soil_pred_3h: +pred.toFixed(1), ai_action: action, ai_pump_s: pump_s,
    };
    if (carry) { Object.assign(doc, carry); carry = null; }
    readings.push(doc);
    ai.push({ timestamp: ts, model: 'gemini-3.5-flash-lite', soil: doc.soil, temperature: doc.temperature, humidity: doc.humidity, lux,
      id: `demo-${seq}`, proposed: { action, pump_s }, action, pump_s, override: null, predicted_soil_3h: doc.soil_pred_3h,
      confidence: 0.8, reason, latency_ms: 700 + Math.round(r() * 900), tokens: 900 + Math.round(r() * 200), error: null });
    if (action === 'water') {
      // น้ำที่รดรอบนี้จะถูกรายงานในการส่งข้อมูลครั้งถัดไป
      soil = Math.min(58, soil + pump_s * 1.6);
      lastWater = t;
      events.push({ timestamp: ts, type: 'ai_decision', source: 'ai', detail: `รดน้ำ ${pump_s} วินาที — ${reason}` });
      events.push({ timestamp: new Date(t + STEP), type: 'pump_on', source: 'ai', pump_s, water_ml: pump_s * flow, soil: doc.soil });
      carry = { pump_s, water_ml: pump_s * flow, pump_events: 1 };
    }
  }
  await db.collection('readings').insertMany(readings);
  await db.collection('ai_decisions').insertMany(ai);
  await db.collection('events').insertMany(events);
  await db.collection('settings').insertOne({ _id: 'main', mode: 'ai', soil_on: 30, soil_off: 45, wet_limit: 60, ai_emergency: 20,
    pump_pulse_s: 5, ai_max_pump_s: 15, max_pump_s_day: 200, flow_ml_s: flow, lux_on: 2000, lux_off: 3000, day_start: 6, day_end: 18,
    alert_temp: 35, alert_humidity: 80 });
  console.log(`สร้างข้อมูลจำลองใน ${DB}: readings ${readings.length}, ai_decisions ${ai.length}, events ${events.length}`);
  await c.close();
})();
