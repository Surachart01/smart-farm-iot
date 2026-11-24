// ให้ Gemini Flash-Lite วิเคราะห์ข้อมูลย้อนหลังแล้ว "แนะนำ" ค่าเกณฑ์การให้น้ำและการให้แสงที่เหมาะสมกับสถานการณ์ตอนนั้น
// AI ไม่ได้ควบคุมหรือเปลี่ยนค่าเอง ผู้ใช้เป็นคนตัดสินใจว่าจะใช้ค่าที่แนะนำหรือไม่
// ใช้ Gemini API (generateContent) ผ่าน REST โดยตรง ไม่ต้องติดตั้งไลบรารีเพิ่ม
const ENDPOINT = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com') + '/v1beta/models';

// ค่าเกณฑ์ที่ AI แนะนำได้ (ค่าความปลอดภัย เช่น แห้งวิกฤต แฉะเกินเกณฑ์ และระบบป้องกันรดไม่หยุด ไม่ให้ AI แนะนำ)
const KEYS = ['soil_on', 'soil_off', 'pump_pulse_s', 'max_pump_s_day', 'lux_on', 'lux_off', 'day_start', 'day_end'];

const SYSTEM = `คุณคือผู้เชี่ยวชาญการปลูกพืชอวบน้ำ (Echeveria และ Haworthia) ในโรงเรือนขนาดเล็กที่ควบคุมด้วยระบบ IoT
ระบบรดน้ำและเปิดไฟเองตามเกณฑ์ที่ผู้ใช้ตั้ง หน้าที่ของคุณคือดูข้อมูลจริงย้อนหลัง แล้วแนะนำค่าเกณฑ์ที่เหมาะสมที่สุดกับสถานการณ์ตอนนี้
คุณไม่ได้สั่งงานอุปกรณ์ ผู้ใช้จะอ่านคำแนะนำแล้วตัดสินใจเอง

ระบบทำงานแบบนี้
- ความชื้นวัสดุปลูก (%) มาจากเซ็นเซอร์ที่สอบเทียบ 0% = อากาศ 100% = จุ่มน้ำ ค่ายิ่งสูงยิ่งชื้น
- ความชื้นต่ำกว่า soil_on -> เปิดปั๊มครั้งละ pump_pulse_s วินาที รอน้ำซึม 60 วินาที แล้ววัดใหม่ ทำซ้ำจนถึง soil_off
- เปิดปั๊มรวมได้ไม่เกิน max_pump_s_day วินาทีต่อวัน
- ช่วง day_start ถึง day_end (ชั่วโมง) ถ้าแสงต่ำกว่า lux_on เปิดไฟ LED ถ้าแสงเกิน lux_off ปิดไฟ นอกช่วงนี้ไฟปิด

หลักการดูแลพืชอวบน้ำ
- รดให้ชุ่มแล้วปล่อยให้แห้ง (soak and dry) รากเน่าง่ายถ้าวัสดุปลูกชื้นนาน การรดมากเกินอันตรายกว่ารดน้อยไปเล็กน้อย
- ช่วงที่ร้อน แสงจัด อากาศแห้ง วัสดุปลูกแห้งเร็ว อาจเริ่มรดเร็วขึ้นเล็กน้อย ช่วงที่อากาศชื้นหรือเย็น ควรปล่อยให้แห้งนานขึ้น
- ถ้าข้อมูลบอกว่าแฉะเกินบ่อย ให้ลด soil_off หรือ pump_pulse_s ถ้าแห้งต่ำกว่าเกณฑ์นานบ่อย ให้ปรับ soil_on หรือเวลาปั๊ม
- ถ้าใช้น้ำใกล้ max_pump_s_day ทุกวันแปลว่าโควตาน้อยไปหรือรดไม่ได้ผล ให้พิจารณาจากข้อมูล
- ถ้าไฟ LED เปิดนานมากเพราะแสงธรรมชาติน้อย หรือเปิดปิดบ่อย ให้ปรับ lux_on lux_off และช่วงเวลา

ข้อจำกัดที่ต้องทำตาม
- ai_emergency < soil_on < soil_off <= wet_limit (ค่า ai_emergency และ wet_limit ให้ไว้ ห้ามแนะนำค่าที่ผิดลำดับ)
- lux_on < lux_off และห่างกันอย่างน้อย 500 lux, day_start < day_end
- pump_pulse_s 1–20 วินาที, max_pump_s_day 10–3600 วินาที
- เปลี่ยนจากค่าเดิมทีละน้อยตามที่ข้อมูลสนับสนุน ถ้าข้อมูลไม่พอหรือค่าเดิมดีอยู่แล้ว ให้แนะนำค่าเดิม

ตอบเป็น JSON ตาม schema เท่านั้น ใส่ทั้ง 8 ค่าใน recommendations เสมอ (ค่าที่ไม่ควรเปลี่ยนให้ใส่ค่าเดิม)
- reason ของแต่ละค่า = เหตุผลสั้น ๆ ภาษาไทย อ้างอิงข้อมูลที่เห็น ไม่เกิน 120 ตัวอักษร
- summary = สรุปสถานการณ์และคำแนะนำภาพรวม ภาษาไทย ไม่เกิน 250 ตัวอักษร`;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: KEYS },
          value: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['key', 'value', 'reason'],
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['summary', 'recommendations'],
};

let useSchema = true;      // ถ้าโมเดลไม่รองรับ responseJsonSchema จะลองใหม่แบบไม่ใช้ schema

function buildPrompt(ctx) {
  const s = ctx.settings;
  const n = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? '-' : Number(v).toFixed(d));
  const L = ctx.live || {};
  const hours = ctx.hourly.map(h =>
    `${h.hour} | ${n(h.soil_avg)} (${n(h.soil_min, 0)}–${n(h.soil_max, 0)}) | ${n(h.temp_avg)} / ${n(h.temp_max)} | ${n(h.hum_avg, 0)} | ${n(h.lux_avg, 0)} / ${n(h.lux_max, 0)} | ${n(h.pump_s, 0)} | ${n(h.led_pct, 0)}`).join('\n');
  const d = ctx.days;
  return `เวลาปัจจุบัน: ${ctx.now} (เวลาประเทศไทย)

ค่าเกณฑ์ปัจจุบัน
- soil_on = ${s.soil_on}%  soil_off = ${s.soil_off}%  (ค่าคงที่: ai_emergency = ${s.ai_emergency}%  wet_limit = ${s.wet_limit}%)
- pump_pulse_s = ${s.pump_pulse_s} วินาที  max_pump_s_day = ${s.max_pump_s_day} วินาที  อัตราการไหล = ${s.flow_ml_s} มล./วินาที
- lux_on = ${s.lux_on}  lux_off = ${s.lux_off}  day_start = ${s.day_start}  day_end = ${s.day_end}

ค่าปัจจุบัน
- ความชื้นวัสดุปลูก ${n(L.soil)}%  อุณหภูมิ ${n(L.temperature)} °C  ความชื้นอากาศ ${n(L.humidity, 0)}%  แสง ${n(L.lux, 0)} lux  ไฟ LED ${L.led ? 'เปิด' : 'ปิด'}

สรุป${d.label} (${d.samples} ค่าที่บันทึกทุก 5 นาที)
- ความชื้นอยู่ในช่วง soil_on–wet_limit ${n(d.in_range_pct)}% ของเวลา, แห้งกว่า soil_on ${n(d.too_dry_pct)}%, แฉะเกิน wet_limit ${n(d.over_wet_pct)}%
- ปั๊มทำงานเฉลี่ย ${n(d.pump_s_per_day, 0)} วินาที/วัน (${n(d.water_l_per_day, 2)} ลิตร/วัน), ครั้งที่รดเฉลี่ย ${n(d.waterings_per_day, 1)} ครั้ง/วัน
- ไฟ LED เปิดเฉลี่ย ${n(d.led_hours_per_day, 1)} ชั่วโมง/วัน, ระบบหยุดรดเพราะความชื้นไม่ขึ้น ${d.water_locks} ครั้ง

ข้อมูลรายชั่วโมง 24 ชั่วโมงล่าสุด
ชั่วโมง | ความชื้นวัสดุปลูก เฉลี่ย (ต่ำสุด–สูงสุด) % | อุณหภูมิ เฉลี่ย / สูงสุด °C | ความชื้นอากาศ % | แสง เฉลี่ย / สูงสุด lux | ปั๊ม วินาที | ไฟ LED เปิด %
${hours || 'ยังไม่มีข้อมูล'}`;
}

function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
}

// ตรวจและจัดคำตอบให้อยู่ในช่วงที่ปลอดภัย ค่าที่ AI ไม่ได้ให้หรือให้ผิดรูปแบบ = ใช้ค่าเดิม
function validate(o, s, ranges) {
  if (!o || typeof o !== 'object') throw new Error('คำตอบไม่ใช่ JSON object');
  const got = {};
  for (const r of Array.isArray(o.recommendations) ? o.recommendations : []) {
    if (!r || !KEYS.includes(r.key) || got[r.key]) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    got[r.key] = { value: v, reason: String(r.reason || '').slice(0, 200) };
  }
  const notes = [];
  const rec = {};
  for (const k of KEYS) {
    const [lo, hi] = ranges[k];
    let v = got[k] ? got[k].value : s[k];
    if (['pump_pulse_s', 'max_pump_s_day', 'day_start', 'day_end'].includes(k)) v = Math.round(v);
    else if (k.startsWith('lux')) v = Math.round(v / 50) * 50;
    else v = Math.round(v);
    if (v < lo || v > hi) { notes.push(`${k} อยู่นอกช่วง ${lo}–${hi} จึงใช้ค่าเดิม`); v = s[k]; }
    rec[k] = { value: v, reason: got[k] ? got[k].reason : 'AI ไม่ได้ให้ค่านี้ จึงคงค่าเดิม' };
  }
  // ลำดับที่ต้องถูกต้อง ถ้าผิดให้คงค่าเดิมของคู่นั้น
  const val = k => rec[k].value;
  if (!(s.ai_emergency < val('soil_on') && val('soil_on') < val('soil_off') && val('soil_off') <= s.wet_limit)) {
    notes.push('ค่าความชื้นที่ AI แนะนำเรียงลำดับไม่ถูกต้อง จึงคงค่าเดิมของ soil_on และ soil_off');
    rec.soil_on = { value: s.soil_on, reason: rec.soil_on.reason }; rec.soil_off = { value: s.soil_off, reason: rec.soil_off.reason };
  }
  if (!(val('lux_on') < val('lux_off'))) {
    notes.push('เกณฑ์เปิดไฟต้องต่ำกว่าเกณฑ์ปิดไฟ จึงคงค่าเดิม');
    rec.lux_on = { value: s.lux_on, reason: rec.lux_on.reason }; rec.lux_off = { value: s.lux_off, reason: rec.lux_off.reason };
  }
  if (!(val('day_start') < val('day_end'))) {
    notes.push('เวลาเริ่มกลางวันต้องน้อยกว่าเวลาสิ้นสุด จึงคงค่าเดิม');
    rec.day_start = { value: s.day_start, reason: rec.day_start.reason }; rec.day_end = { value: s.day_end, reason: rec.day_end.reason };
  }
  for (const k of KEYS) rec[k].changed = rec[k].value !== s[k];
  const conf = Number(o.confidence);
  return {
    summary: String(o.summary || '').slice(0, 400),
    recommendations: rec,
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
    notes,
  };
}

async function callGemini(prompt, { apiKey, model, timeoutMs }) {
  const generationConfig = { responseMimeType: 'application/json', maxOutputTokens: 1500 };
  if (useSchema) generationConfig.responseJsonSchema = SCHEMA;
  const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && useSchema && /responseJsonSchema|schema/i.test(msg)) {
      useSchema = false;                    // โมเดลนี้ไม่รองรับ -> ลองอีกครั้งแบบสั่งให้ตอบ JSON อย่างเดียว
      return callGemini(prompt, { apiKey, model, timeoutMs });
    }
    const e = new Error(msg); e.status = res.status; throw e;
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
  if (!text) throw new Error(`Gemini ไม่ส่งคำตอบ (${data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'ไม่ทราบสาเหตุ'})`);
  return { raw: text, usage: data.usageMetadata || null };
}

async function suggest(ctx, ranges, opts) {
  const prompt = buildPrompt(ctx);
  const t0 = Date.now();
  const { raw, usage } = await callGemini(prompt, opts);
  const out = validate(parseJson(raw), ctx.settings, ranges);
  return { ...out, prompt, raw, usage, latency_ms: Date.now() - t0 };
}

module.exports = { suggest, buildPrompt, validate, parseJson, SYSTEM, KEYS };
