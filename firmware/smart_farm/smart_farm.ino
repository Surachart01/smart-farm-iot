/*
  ระบบฟาร์มอัจฉริยะ IoT และการจัดการฐานข้อมูลคลาวด์สำหรับธุรกิจเพาะเลี้ยงพืชอวบน้ำ — เฟิร์มแวร์
  ใช้ได้ทั้ง ESP32 (ตามเล่มบทที่ 3) และ NodeMCU ESP8266 (ชุดที่ต่ออยู่ตอนนี้) — เลือกบอร์ดใน Arduino IDE ได้เลย

  ขาต่อ                ESP8266 (NodeMCU)    ESP32 DevKit
    SDA / SCL (I2C)    D2 / D1              GPIO21 / GPIO22     BH1750 (+ BME280 ถ้าใช้)
    DHT22 (ถ้าใช้)      D7                   GPIO4
    Soil Moisture      A0                   GPIO34
    รีเลย์ปั๊ม 12V      D5                   GPIO26
    รีเลย์ไฟ LED        D6                   GPIO27

  ไลบรารี (Library Manager): BH1750 (Christopher Laws), ArduinoJson (v7),
    Adafruit BME280 Library (ถ้าใช้ BME280) หรือ DHT sensor library ของ Adafruit (ถ้าใช้ DHT22)

  การทำงาน
    ทุก 5 วินาที  : ส่งค่าสดให้หน้าเว็บ -> รับค่าตั้งและคำสั่ง -> ตัดสินใจเปิดปิดไฟตามแสง
    ทุก 60 วินาที : อ่านเซ็นเซอร์ -> ตรวจความปลอดภัย -> ควบคุมปั๊มตามเกณฑ์ความชื้น
    ทุก 5 นาที    : ส่งข้อมูลขึ้นฐานข้อมูลคลาวด์ (ใช้ทำกราฟ สถิติ และให้ AI ใช้แนะนำค่าเกณฑ์บนหน้าเว็บ)
    บอร์ดตัดสินใจเองทั้งหมดตามค่าเกณฑ์ ถ้าเน็ตหลุดก็ยังรดน้ำและเปิดไฟตามค่าเกณฑ์ล่าสุดได้
*/
#include "config.h"

#if defined(ESP32)
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <WiFiClientSecure.h>
  #define BOARD_NAME "esp32"
  const uint8_t PIN_SDA = 21, PIN_SCL = 22, PIN_SOIL = 34, PIN_PUMP = 26, PIN_LED = 27, PIN_DHT = 4;
  const int ADC_MAX = 4095;
  #define HW_RANDOM() esp_random()
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
  #include <WiFiClientSecureBearSSL.h>
  #define BOARD_NAME "esp8266"
  const uint8_t PIN_SDA = D2, PIN_SCL = D1, PIN_SOIL = A0, PIN_PUMP = D5, PIN_LED = D6, PIN_DHT = D7;
  const int ADC_MAX = 1023;
  #define HW_RANDOM() ESP.random()
#else
  #error "รองรับเฉพาะบอร์ด ESP32 หรือ ESP8266"
#endif

#include <Wire.h>
#include <BH1750.h>
#include <ArduinoJson.h>
#include <time.h>

#if defined(TEMP_SENSOR_DHT22)
  #include <DHT.h>
  DHT dht(PIN_DHT, DHT22);
  #define TEMP_SENSOR_NAME "dht22"
#else
  #include <Adafruit_BME280.h>
  Adafruit_BME280 bme;
  #define TEMP_SENSOR_NAME "bme280"
#endif

const unsigned PUMP_HARD_MAX_S = 20;   // ป้องกันชั้นสุดท้าย: ปั๊มเปิดได้ไม่เกิน 20 วินาทีต่อครั้งเสมอ

// ---------------- ค่าตั้ง (ค่าเริ่มต้น; เซิร์ฟเวอร์ส่งค่าใหม่มาแทนได้จากหน้าเว็บ) ----------------
struct Settings {
  char  mode[8]      = "auto";  // auto = ตามเกณฑ์, manual = สั่งเองจากเว็บ
  float soilOn       = 30;      // ความชื้นต่ำกว่านี้ -> เริ่มให้น้ำ (โหมดเกณฑ์)
  float soilOff      = 45;      // ให้น้ำจนถึงค่านี้ / ห้ามรดถ้าสูงกว่านี้
  float luxOn        = 2000;    // กลางวันและแสงต่ำกว่านี้ -> เปิดไฟ
  float luxOff       = 3000;    // แสงเกินนี้ -> ปิดไฟ
  int   dayStart     = 6;
  int   dayEnd       = 18;
  int   pumpPulseSec = 5;       // เปิดปั๊มกี่วินาทีต่อรอบ (โหมดเกณฑ์และปุ่มบนเว็บ)
  int   maxPumpSDay  = 200;     // เปิดปั๊มรวมได้ไม่เกินกี่วินาทีต่อวัน
  float guardPumpS   = 30;      // ป้องกันรดไม่หยุด: รดอัตโนมัติรวมเกินกี่วินาที...
  float guardMinRise = 2;       // ...แล้วความชื้นขึ้นไม่ถึงกี่ % -> หยุดรดอัตโนมัติ (ล็อก)
} cfg;

struct Reading {
  float t = NAN, rh = NAN, p = NAN, lux = NAN, soil = NAN;
  int   soilRaw = -1;
  bool  okTH = false, okLux = false, okSoil = false;
  bool ok() const { return okTH && okLux && okSoil; }
};

BH1750 lightMeter(0x23);
bool thReady = false, luxReady = false;

// ---------------- สถานะ ----------------
bool  pumpOn = false, ledOn = false, ledManual = false, watering = false;
unsigned long pumpOffAt = 0, pumpStartMs = 0, lastControl = 0, lastSend = 0, lastWifiTry = 0, lastLive = 0;
#ifndef LIVE_INTERVAL_SEC
#define LIVE_INTERVAL_SEC 5      // ส่งค่าสดให้หน้าเว็บ + รับคำสั่งทุก 5 วินาที
#endif
float pumpSToReport = 0, pumpSToday = 0;  // วินาทีที่ปั๊มทำงาน (สำหรับคำนวณปริมาณน้ำ)
int   pumpEventsToReport = 0, today = -1;
uint32_t bootId = 0, seq = 0;             // ใช้คำนวณอัตราการส่งข้อมูลสำเร็จบนเซิร์ฟเวอร์
const char* pumpSource = "auto";
String decision = "start";
bool  firstRun = true, serverOk = false;
// ป้องกันรดน้ำไม่หยุด: ถ้ารดอัตโนมัติไปหลายครั้งแต่ค่าความชื้นไม่ขึ้น แปลว่าเซ็นเซอร์ไม่ได้วัดดินที่โดนน้ำ
// (หลุด/ถูกดึงขึ้น/อยู่คนละกระถาง/สายหลวม) -> ล็อกไม่ให้รดอัตโนมัติจนกว่าจะกดปลดล็อกบนเว็บ
bool  waterLock = false;
float guardStartSoil = NAN, guardPumpS = 0, lastSoil = NAN;
unsigned long guardLastPumpMs = 0;

// ======================================================================
void relayWrite(uint8_t pin, bool on) {
  digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void pumpStart(unsigned sec, const char* source) {
  if (pumpOn) return;
  bool automatic = strcmp(source, "manual") != 0;
  if (automatic && waterLock) { decision = "water_lock"; return; }
  sec = constrain(sec, 1u, PUMP_HARD_MAX_S);
  float left = cfg.maxPumpSDay - pumpSToday;
  if (left < 1) { decision = "daily_limit"; return; }
  if (sec > left) sec = (unsigned)left;
  if (automatic && guardPumpS == 0) guardStartSoil = lastSoil;   // เริ่มชุดการรดใหม่ จำความชื้นตอนเริ่ม
  pumpSource = source;
  pumpStartMs = millis();
  pumpOffAt = pumpStartMs + sec * 1000UL;
  pumpOn = true;
  pumpEventsToReport++;
  relayWrite(PIN_PUMP, true);
  Serial.printf("[ปั๊ม] เปิด %u วินาที (%s)\n", sec, source);
}

void pumpStop() {
  if (pumpOn) {
    float s = (millis() - pumpStartMs) / 1000.0f;
    pumpSToReport += s; pumpSToday += s;
    if (strcmp(pumpSource, "manual") != 0) { guardPumpS += s; guardLastPumpMs = millis(); }
  }
  pumpOn = false;
  relayWrite(PIN_PUMP, false);
}

void setLed(bool on) {
  if (!USE_LED_RELAY) on = false;
  ledOn = on;
  relayWrite(PIN_LED, on);
}

// ---------------- เวลา ----------------
bool timeValid() { return time(nullptr) > 1700000000; }

float hourNow() {                       // ชั่วโมงแบบทศนิยม (-1 = ยังไม่ได้เวลาจาก NTP)
  if (!timeValid()) return -1;
  time_t now = time(nullptr);
  struct tm* lt = localtime(&now);
  return lt->tm_hour + lt->tm_min / 60.0f;
}

int dayOfYear() {
  if (!timeValid()) return (int)(millis() / 86400000UL);
  time_t now = time(nullptr);
  return localtime(&now)->tm_yday;
}

// ---------------- Wi-Fi ----------------
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (lastWifiTry != 0 && millis() - lastWifiTry < 30000UL) return;   // ลองใหม่ทุก 30 วินาที ไม่บล็อกการควบคุม
  lastWifiTry = millis();
  Serial.println(F("[WiFi] กำลังเชื่อมต่อใหม่..."));
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ---------------- เซ็นเซอร์ ----------------
void initSensors() {
#if defined(TEMP_SENSOR_DHT22)
  thReady = true;                       // DHT22 ไม่มีขั้นตอนตรวจหา จะรู้ผลตอนอ่านค่า
#else
  if (!thReady) thReady = bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire);
#endif
  if (!luxReady) luxReady = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire);
}

Reading readSensors() {
  Reading r;
  initSensors();                        // ถ้าเซ็นเซอร์หลุดแล้วต่อกลับ จะเริ่มใหม่ได้เอง
#if defined(TEMP_SENSOR_DHT22)
  r.t  = dht.readTemperature();
  r.rh = dht.readHumidity();
#else
  if (thReady) {
    r.t  = bme.readTemperature();
    r.rh = bme.readHumidity();
    r.p  = bme.readPressure() / 100.0f;
    if (isnan(r.p) || r.p < 800 || r.p > 1100) r.p = NAN;
  }
#endif
  r.okTH = !isnan(r.t) && !isnan(r.rh) && r.t > -10 && r.t < 60 && r.rh >= 0 && r.rh <= 100;
  if (r.okTH) {
    r.t += TEMP_OFFSET;
    r.rh = constrain(r.rh + (float)HUM_OFFSET, 0.0f, 100.0f);
  } else {
#if !defined(TEMP_SENSOR_DHT22)
    thReady = false;
#endif
  }

  if (luxReady) {
    r.lux = lightMeter.readLightLevel();
    r.okLux = r.lux >= 0 && r.lux < 65536;
    if (!r.okLux) luxReady = false;
  }

  long acc = 0;
  for (int i = 0; i < 10; i++) { acc += analogRead(PIN_SOIL); delay(5); }
  r.soilRaw = acc / 10;
  // สายหลุดหรือเซ็นเซอร์เสีย ค่ามักจะชิด 0 หรือค่าสูงสุดของ ADC
  r.okSoil = r.soilRaw > ADC_MAX * 0.03 && r.soilRaw < ADC_MAX * 0.985;
  if (r.okSoil) {
    float pct = (float)(SOIL_RAW_DRY - r.soilRaw) * 100.0f / (SOIL_RAW_DRY - SOIL_RAW_WET);
    r.soil = constrain(pct + (float)SOIL_OFFSET, 0.0f, 100.0f);
    lastSoil = r.soil;
  }
  return r;
}

// ---------------- HTTP ----------------
// ส่งคำขอไปเซิร์ฟเวอร์ แล้วแปลงคำตอบเป็น JSON (body ว่าง = GET)
bool httpJson(const char* path, const String& body, JsonDocument& resp, uint16_t timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) return false;
  String url = String(SERVER_URL) + path;
  bool https = url.startsWith("https");
  // เก็บการเชื่อมต่อไว้ใช้ซ้ำ (keep-alive): จับมือ TLS ครั้งเดียว ไม่ต้องทำใหม่ทุก 5 วินาที
  // ทุกคำขอใช้การเชื่อมต่อเดียวกัน จึงมีบัฟเฟอร์ TLS แค่ชุดเดียวในหน่วยความจำ
  static HTTPClient http;
  static WiFiClient plain;
#if defined(ESP32)
  static WiFiClientSecure secure;
#else
  static BearSSL::WiFiClientSecure secure;
  // เซิร์ฟเวอร์ส่วนใหญ่ (รวม Vercel) ไม่รองรับการย่อขนาดแพ็กเก็ต TLS จึงต้องใช้บัฟเฟอร์รับ 16 KB
  // ตรวจครั้งแรกครั้งเดียว ถ้าเซิร์ฟเวอร์รองรับ (MFLN) จะใช้แค่ 4 KB ประหยัดหน่วยความจำ
  static int rxBuf = 0;
  if (!rxBuf && https) {
    String host = url.substring(8);
    int cut = host.indexOf('/'); if (cut >= 0) host = host.substring(0, cut);
    cut = host.indexOf(':'); if (cut >= 0) host = host.substring(0, cut);
    rxBuf = BearSSL::WiFiClientSecure::probeMaxFragmentLength(host.c_str(), 443, 4096) ? 4096 : 16384;
    secure.setBufferSizes(rxBuf, 1024);
    Serial.printf("[HTTPS] %s บัฟเฟอร์รับ %d ไบต์ (หน่วยความจำว่าง %u)\n", host.c_str(), rxBuf, ESP.getFreeHeap());
  }
#endif
  http.setReuse(true);
  bool began;
  if (https) { secure.setInsecure(); began = http.begin(secure, url); }   // ไม่ตรวจใบรับรอง (พอสำหรับต้นแบบ)
  else began = http.begin(plain, url);
  if (!began) return false;
  http.setTimeout(timeoutMs);
  http.addHeader("x-api-key", API_KEY);
  int code;
  if (body.length()) { http.addHeader("Content-Type", "application/json"); code = http.POST(body); }
  else code = http.GET();
  bool success = false;
  if (code == 200) success = !deserializeJson(resp, http.getString());
  else Serial.printf("[HTTP] %s ไม่สำเร็จ code=%d %s\n", path, code, http.errorToString(code).c_str());
  http.end();                                   // ยังคงการเชื่อมต่อไว้สำหรับคำขอถัดไป
  if (code <= 0) { if (https) secure.stop(); else plain.stop(); }   // การเชื่อมต่อเสีย -> เริ่มใหม่รอบหน้า
  return success;
}

void putNum(JsonDocument& d, const char* k, float v, bool ok, int digits) {
  if (ok && !isnan(v)) d[k] = serialized(String(v, digits)); else d[k] = nullptr;
}

// ส่งข้อมูลขึ้นคลาวด์ (ทุก 5 นาที)
bool postReading(const Reading& r, JsonDocument& resp) {
  seq++;                                // นับทุกครั้งที่ถึงรอบส่ง แม้ส่งไม่สำเร็จ
  if (pumpOn) {                         // ปั๊มกำลังทำงาน -> นับเวลาที่ผ่านไปแล้วเข้ารอบนี้
    float s = (millis() - pumpStartMs) / 1000.0f;
    pumpSToReport += s; pumpSToday += s; pumpStartMs = millis();
  }
  JsonDocument d;
  d["device"] = DEVICE_ID;
  d["boot"] = bootId;
  d["seq"] = seq;
  putNum(d, "temperature", r.t, r.okTH, 2);
  putNum(d, "humidity", r.rh, r.okTH, 2);
  putNum(d, "pressure", r.p, r.okTH, 2);
  putNum(d, "lux", r.lux, r.okLux, 1);
  putNum(d, "soil", r.soil, r.okSoil, 2);
  d["soil_raw"] = r.soilRaw;
  d["pump_s"] = serialized(String(pumpSToReport, 1));   // วินาทีที่ปั๊มทำงานนับจากรายงานครั้งก่อน
  d["pump_events"] = pumpEventsToReport;
  d["pump_source"] = pumpSource;
  d["led"] = ledOn ? 1 : 0;
  d["mode"] = cfg.mode;
  d["decision"] = decision;
  d["water_lock"] = waterLock ? 1 : 0;
  JsonArray err = d["errors"].to<JsonArray>();
  if (!r.okTH) err.add(TEMP_SENSOR_NAME);
  if (!r.okLux) err.add("bh1750");
  if (!r.okSoil) err.add("soil");
  d["rssi"] = WiFi.RSSI();
  d["uptime_s"] = millis() / 1000;
  d["board"] = BOARD_NAME;
  d["temp_sensor"] = TEMP_SENSOR_NAME;
  String body; serializeJson(d, body);

  bool ok = httpJson("/api/readings", body, resp, 15000);
  if (ok) { pumpSToReport = 0; pumpEventsToReport = 0; }  // ส่งไม่สำเร็จ -> เก็บไว้รายงานรอบหน้า
  return ok;
}

// ---------------- รับค่าตั้งและคำสั่ง ----------------
void applySettings(JsonObjectConst s) {
  if (s.isNull()) return;
  const char* m = s["mode"] | cfg.mode;
  if (!strcmp(m, "auto") || !strcmp(m, "manual")) strlcpy(cfg.mode, m, sizeof(cfg.mode));
  else if (!strcmp(m, "ai")) strlcpy(cfg.mode, "auto", sizeof(cfg.mode));   // โหมด AI เดิม -> ตามเกณฑ์
  cfg.soilOn       = s["soil_on"]        | cfg.soilOn;
  cfg.soilOff      = s["soil_off"]       | cfg.soilOff;
  cfg.luxOn        = s["lux_on"]         | cfg.luxOn;
  cfg.luxOff       = s["lux_off"]        | cfg.luxOff;
  cfg.dayStart     = s["day_start"]      | cfg.dayStart;
  cfg.dayEnd       = s["day_end"]        | cfg.dayEnd;
  cfg.pumpPulseSec = s["pump_pulse_s"]   | cfg.pumpPulseSec;
  cfg.maxPumpSDay  = s["max_pump_s_day"] | cfg.maxPumpSDay;
  cfg.guardPumpS   = s["guard_pump_s"]   | cfg.guardPumpS;
  cfg.guardMinRise = s["guard_min_rise"] | cfg.guardMinRise;
}

void runCommand(JsonObjectConst c, const Reading& r) {
  if (c.isNull()) return;
  const char* dev = c["device"] | "";
  const char* act = c["action"] | "";
  Serial.printf("[คำสั่งจากเว็บ] %s %s\n", dev, act);
  if (!strcmp(dev, "pump") && !strcmp(act, "pulse")) {
    if (r.okSoil && r.soil < cfg.soilOff) { pumpStart(cfg.pumpPulseSec, "manual"); decision = "manual_pulse"; }
    else decision = r.okSoil ? "manual_blocked_wet" : "manual_blocked_sensor_error";
  } else if (!strcmp(dev, "pump") && !strcmp(act, "unlock")) {
    waterLock = false; guardPumpS = 0; guardStartSoil = NAN; watering = false;
    decision = "water_unlock";
  } else if (!strcmp(dev, "led")) {
    ledManual = !strcmp(act, "on");
  }
}

// ---------------- ควบคุม ----------------
// ไฟ LED (โหมดตามเกณฑ์): กลางวัน + hysteresis เรียกทุกรอบค่าสด (5 วินาที) จึงตอบสนองต่อแสงได้เร็ว
void updateLed(const Reading& r) {
  if (!strcmp(cfg.mode, "manual")) { setLed(ledManual); return; }
  if (!r.okLux) { setLed(false); return; }
  float h = hourNow();
  bool day = h >= 0 && h >= cfg.dayStart && h < cfg.dayEnd;
  if (!day) setLed(false);
  else if (r.lux < cfg.luxOn) setLed(true);
  else if (r.lux > cfg.luxOff) setLed(false);
}

// ตรวจทุกรอบควบคุม (60 วินาที หลังน้ำซึมแล้ว) ก่อนตัดสินใจรดครั้งถัดไป
void guardUpdate(const Reading& r) {
  if (!r.okSoil) return;
  if (waterLock && r.soil >= cfg.soilOff) {                 // เซ็นเซอร์กลับมาอ่านว่าชื้นพอ -> ปลดล็อกเอง
    waterLock = false; guardPumpS = 0; guardStartSoil = NAN;
    Serial.println(F("[ป้องกัน] ความชื้นถึงเกณฑ์หยุดแล้ว ปลดล็อกการรดน้ำอัตโนมัติ"));
  }
  if (guardPumpS <= 0) return;
  if (!isnan(guardStartSoil) && r.soil >= guardStartSoil + cfg.guardMinRise) {   // ค่าขึ้นตามที่รด = ปกติ
    guardPumpS = 0; guardStartSoil = NAN; return;
  }
  if (!pumpOn && millis() - guardLastPumpMs > 30UL * 60000UL) {                  // ไม่ได้รดนานแล้ว เริ่มนับใหม่
    guardPumpS = 0; guardStartSoil = NAN; return;
  }
  if (!waterLock && guardPumpS >= cfg.guardPumpS) {
    waterLock = true; pumpStop(); watering = false;
    Serial.printf("[ป้องกัน] รดไปแล้ว %.0f วินาที แต่ความชื้น %.1f%% -> %.1f%% ไม่ขึ้น หยุดรดอัตโนมัติ\n",
                  guardPumpS, guardStartSoil, r.soil);
  }
}

void control(const Reading& r) {
  guardUpdate(r);
  if (!strcmp(cfg.mode, "manual")) {     // โหมดสั่งเอง: ไฟตามปุ่มบนเว็บ ปั๊มเฉพาะเมื่อกดสั่ง
    setLed(ledManual);
    watering = false;
    if (decision == "-") decision = "manual_mode";
    return;
  }

  if (!r.ok()) {                         // อ่านค่าไม่ได้ -> ตัดรีเลย์ทั้งหมด
    pumpStop(); setLed(false); watering = false;
    decision = "sensor_error";
    return;
  }

  updateLed(r);

  if (pumpOn) return;                    // กำลังรดน้ำจากคำสั่งก่อนหน้า

  // โหมดตามเกณฑ์: ต่ำกว่า soil_on เริ่มรด เป็นช่วง ๆ จนถึง soil_off
  if (decision == "-") decision = "threshold";
  if (r.soil < cfg.soilOn) watering = true;
  if (r.soil >= cfg.soilOff) watering = false;
  if (waterLock) { watering = false; decision = "water_lock"; return; }
  if (watering) pumpStart(cfg.pumpPulseSec, "auto");   // เปิดเป็นช่วง ๆ รอให้น้ำซึม 60 วินาทีก่อนวัดใหม่
}

// ---------------- ค่าสดสำหรับ Dashboard (ทุก LIVE_INTERVAL_SEC) ----------------
// ไม่บันทึกเป็นข้อมูลย้อนหลัง (ข้อมูลย้อนหลังยังส่งทุก 5 นาทีตามบทที่ 3) แต่ทำให้หน้าเว็บเห็นค่าปัจจุบันและรับคำสั่งเร็วขึ้น
String liveBody(const Reading& r) {
  JsonDocument d;
  d["device"] = DEVICE_ID;
  putNum(d, "temperature", r.t, r.okTH, 2);
  putNum(d, "humidity", r.rh, r.okTH, 2);
  putNum(d, "pressure", r.p, r.okTH, 2);
  putNum(d, "lux", r.lux, r.okLux, 1);
  putNum(d, "soil", r.soil, r.okSoil, 2);
  d["pump"] = pumpOn ? 1 : 0;
  d["led"] = ledOn ? 1 : 0;
  d["mode"] = cfg.mode;
  d["rssi"] = WiFi.RSSI();
  d["water_lock"] = waterLock ? 1 : 0;
  String body; serializeJson(d, body);
  return body;
}

void livePoll() {
  Reading r = readSensors();
  updateLed(r);                                            // ตัดสินใจไฟก่อน แล้วรายงานสถานะที่เป็นปัจจุบัน
  JsonDocument resp;
  serverOk = httpJson("/api/device/poll", liveBody(r), resp, 8000);
  if (!serverOk) return;
  applySettings(resp["settings"]);
  runCommand(resp["command"], r);                          // คำสั่งจากเว็บทำทันที ไม่ต้องรอรอบควบคุม
  updateLed(r);                                            // ไฟตอบสนองต่อแสงทุก 5 วินาที (ปั๊มยังตัดสินใจทุก 60 วินาที)
  // เพิ่งทำตามคำสั่ง -> รายงานสถานะใหม่ในอีก 1 วินาที หน้าเว็บจะเห็นผลเร็วขึ้น
  if (!resp["command"].isNull()) lastLive = millis() - (LIVE_INTERVAL_SEC - 1) * 1000UL;
}

// ======================================================================
void tick() {
  int d = dayOfYear();
  if (d != today) { today = d; pumpSToday = 0; }

  Reading r = readSensors();
  decision = "-";

  JsonDocument resp;
  bool sendDue = firstRun || millis() - lastSend >= SEND_INTERVAL_SEC * 1000UL;
  bool sent = false;
  if (sendDue) {
    lastSend = millis();
    sent = serverOk = postReading(r, resp);
  } else {
    serverOk = httpJson("/api/device/poll", liveBody(r), resp, 8000);   // ส่งค่าสด + รับค่าตั้งและคำสั่ง
  }
  if (serverOk) {
    applySettings(resp["settings"]);
    runCommand(resp["command"], r);
  }
  control(r);

  Serial.printf("T=%.1fC RH=%.0f%% Lux=%.0f Soil=%.0f%% (raw %d) | ปั๊ม=%s ไฟ=%s | โหมด=%s %s | %s WiFi=%s server=%s\n",
                r.t, r.rh, r.lux, r.soil, r.soilRaw,
                pumpOn ? "ON" : "off", ledOn ? "ON" : "off", cfg.mode, decision.c_str(),
                sendDue ? (sent ? "ส่งข้อมูลแล้ว" : "ส่งข้อมูลไม่สำเร็จ") : "",
                WiFi.status() == WL_CONNECTED ? "ok" : "หลุด", serverOk ? "ok" : "ไม่ตอบ");
  firstRun = false;
}

void setup() {
  // ตั้งขารีเลย์ให้ "ปิด" ก่อนเป็น OUTPUT ป้องกันปั๊มกระตุกตอนเปิดเครื่อง
  digitalWrite(PIN_PUMP, RELAY_ACTIVE_LOW ? HIGH : LOW);
  digitalWrite(PIN_LED,  RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(PIN_PUMP, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  pumpStop(); setLed(false);

  Serial.begin(115200);
  delay(200);
  bootId = HW_RANDOM();
  Serial.printf("\n=== Smart Farm (%s, %s) ===\n", BOARD_NAME, TEMP_SENSOR_NAME);

  Wire.begin(PIN_SDA, PIN_SCL);
#if defined(TEMP_SENSOR_DHT22)
  dht.begin();
#endif
  initSensors();
  Serial.printf("%s: %s  BH1750: %s\n", TEMP_SENSOR_NAME, thReady ? "พบ" : "ไม่พบ!", luxReady ? "พบ" : "ไม่พบ!");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); Serial.print('.'); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[WiFi] เชื่อมต่อแล้ว IP=%s\n", WiFi.localIP().toString().c_str());
  else Serial.println(F("[WiFi] ยังเชื่อมต่อไม่ได้ จะลองใหม่ระหว่างทำงาน"));

  configTime(TZ_OFFSET_SEC, 0, "pool.ntp.org", "time.google.com");
}

void loop() {
  if (pumpOn && (long)(millis() - pumpOffAt) >= 0) pumpStop();   // ตัดปั๊มเมื่อครบเวลา
  ensureWifi();
  if (firstRun || millis() - lastControl >= CONTROL_INTERVAL_SEC * 1000UL) {
    lastControl = lastLive = millis();
    tick();
  } else if (!pumpOn && millis() - lastLive >= LIVE_INTERVAL_SEC * 1000UL) {   // ไม่ส่งระหว่างปั๊มทำงาน ให้ตัดปั๊มตรงเวลา
    lastLive = millis();
    livePoll();
  }
  delay(20);
}
