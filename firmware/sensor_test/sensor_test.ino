/*
  ทดสอบเซ็นเซอร์และรีเลย์ทั้งหมด — D1 Mini ESP8266 (ไม่ต้องใช้ Wi-Fi หรือเซิร์ฟเวอร์)
  ขาต่อตามภาพที่ 3-2:  SDA=D2  SCL=D1  Soil=A0  รีเลย์ปั๊ม=D5  รีเลย์ไฟ=D6

  วิธีใช้: อัปโหลด แล้วเปิด Serial Monitor ที่ 115200 baud (ตั้ง line ending เป็น "Newline")
  พิมพ์คำสั่งแล้วกด Enter
    p = เปิดปั๊ม 2 วินาที      l = สลับไฟ LED เปิด/ปิด
    s = สแกนบัส I2C ใหม่       c = โหมดปรับเทียบ soil (แสดงค่า raw ถี่ ๆ)   x = หยุดโหมดปรับเทียบ
*/
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <BH1750.h>

#define RELAY_ACTIVE_LOW true      // ให้ตรงกับ config.h ของเฟิร์มแวร์หลัก
#define SOIL_RAW_DRY 620           // ค่าในอากาศ (แก้หลังปรับเทียบ)
#define SOIL_RAW_WET 280           // ค่าในน้ำ   (แก้หลังปรับเทียบ)

const uint8_t PIN_PUMP = D5, PIN_LED = D6, PIN_SOIL = A0;

Adafruit_BME280 bme;
BH1750 lightMeter(0x23);
bool bmeOk = false, luxOk = false, ledOn = false, calib = false;
uint8_t bmeAddr = 0;
bool bmeOnBus = false;
bool busOk = false;             // สาย SDA/SCL อยู่ในสภาพปกติ          // สแกนเจออุปกรณ์ที่ 0x76/0x77
unsigned long lastPrint = 0;
int passBme = 0, passLux = 0, passSoil = 0, rounds = 0;

void relay(uint8_t pin, bool on) { digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }

bool i2cLinesOk() {
  // บัส I2C ปกติขา SDA/SCL ต้องเป็น HIGH ตอนว่าง ถ้าเป็น LOW แปลว่าลัดลง GND หรือเซ็นเซอร์ไม่มีไฟเลี้ยง
  pinMode(D2, INPUT_PULLUP); pinMode(D1, INPUT_PULLUP); delay(5);
  int sda = digitalRead(D2), scl = digitalRead(D1);
  Serial.printf("  ระดับสัญญาณตอนว่าง: SDA(D2)=%s  SCL(D1)=%s\n", sda ? "HIGH ปกติ" : "LOW ผิดปกติ!", scl ? "HIGH ปกติ" : "LOW ผิดปกติ!");
  Wire.begin(D2, D1);
  Wire.setClockStretchLimit(2000);
  return sda && scl;
}

void scanI2C() {
  Serial.println(F("\n--- สแกนบัส I2C (SDA=D2, SCL=D1) ---"));
  int n = 0;
  bmeOnBus = false;
  busOk = i2cLinesOk();
  if (!busOk) {
    Serial.println(F("  ข้ามการสแกน: สาย SDA หรือ SCL ถูกดึงลง GND — ตรวจว่าเซ็นเซอร์ได้ไฟ 3.3V และสายไม่ลัดวงจร"));
    return;
  }
  for (uint8_t a = 1; a < 127; a++) {
    yield();                                   // ป้องกันบอร์ดรีเซ็ตเองระหว่างสแกน (watchdog)
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      n++;
      if (a == 0x76 || a == 0x77) bmeOnBus = true;
      const char* name = (a == 0x76 || a == 0x77) ? "BME280" : (a == 0x23 || a == 0x5C) ? "BH1750" : "ไม่รู้จัก";
      Serial.printf("  พบอุปกรณ์ที่ 0x%02X  -> %s\n", a, name);
    }
  }
  if (n == 0) Serial.println(F("  ไม่พบอุปกรณ์เลย: ตรวจไฟเลี้ยง 3.3V, GND และสาย SDA/SCL ว่าสลับกันหรือไม่"));
  else if (n < 2) Serial.println(F("  พบไม่ครบ 2 ตัว: ตรวจสายของตัวที่ไม่ขึ้น"));
}

void initSensors() {
  bmeOk = false; luxOk = false;
  if (!busOk) { Serial.println(F("BME280/BH1750: ข้าม เพราะสาย I2C ผิดปกติ (พิมพ์ s เพื่อตรวจใหม่)")); return; }
  if (bme.begin(0x76, &Wire)) { bmeOk = true; bmeAddr = 0x76; }
  else if (bme.begin(0x77, &Wire)) { bmeOk = true; bmeAddr = 0x77; }
  luxOk = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire);
  Serial.printf("BME280: %s", bmeOk ? "พร้อม" : "ไม่พบ");
  if (bmeOk) Serial.printf(" (0x%02X)", bmeAddr);
  else if (bmeOnBus) Serial.print(F(" — แต่สแกนเจอที่ 0x76/0x77: อาจเป็น BMP280 (ไม่มีค่าความชื้น) ไม่ใช่ BME280"));
  Serial.printf("\nBH1750: %s\n", luxOk ? "พร้อม" : "ไม่พบ");
}

int readSoilRaw() {
  long acc = 0;
  for (int i = 0; i < 10; i++) { acc += analogRead(PIN_SOIL); delay(5); }
  return acc / 10;
}

void setup() {
  digitalWrite(PIN_PUMP, RELAY_ACTIVE_LOW ? HIGH : LOW);
  digitalWrite(PIN_LED, RELAY_ACTIVE_LOW ? HIGH : LOW);
  pinMode(PIN_PUMP, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n\n===== ทดสอบเซ็นเซอร์ Smart Farm ====="));
  Serial.printf("สาเหตุการรีเซ็ตครั้งล่าสุด: %s\n", ESP.getResetReason().c_str());
  scanI2C();
  initSensors();
  Serial.println(F("\nคำสั่ง: p=ปั๊ม 2 วินาที  l=สลับไฟ  s=สแกน I2C  c=ปรับเทียบ soil  x=หยุดปรับเทียบ\n"));
}

void printRound() {
  rounds++;
  Serial.printf("\n[รอบที่ %d]\n", rounds);

  // BME280
  if (!bmeOk && busOk) initSensors();
  if (bmeOk) {
    float t = bme.readTemperature(), rh = bme.readHumidity(), p = bme.readPressure() / 100.0f;
    bool ok = !isnan(t) && t > -10 && t < 60 && rh >= 0 && rh <= 100 && p > 800 && p < 1100;
    Serial.printf("  BME280   อุณหภูมิ %.2f °C | ความชื้น %.1f %% | ความกด %.1f hPa  -> %s\n",
                  t, rh, p, ok ? "ผ่าน" : "ค่าผิดปกติ");
    if (ok) passBme++; else bmeOk = false;
  } else Serial.println(F("  BME280   อ่านไม่ได้"));

  // BH1750
  if (luxOk) {
    float lux = lightMeter.readLightLevel();
    bool ok = lux >= 0;
    Serial.printf("  BH1750   แสง %.0f lux  -> %s   (ลองเอามือบัง ค่าควรลดลง)\n", lux, ok ? "ผ่าน" : "อ่านผิดพลาด");
    if (ok) passLux++; else luxOk = false;
  } else { Serial.println(F("  BH1750   อ่านไม่ได้")); if (busOk) luxOk = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23, &Wire); }

  // Soil
  int raw = readSoilRaw();
  bool ok = raw > 30 && raw < 1010;
  float pct = constrain((float)(SOIL_RAW_DRY - raw) * 100.0f / (SOIL_RAW_DRY - SOIL_RAW_WET), 0.0f, 100.0f);
  Serial.printf("  Soil     raw %d -> %.0f %%  -> %s\n", raw, pct,
                ok ? "ผ่าน" : (raw <= 30 ? "ค่าใกล้ 0: สาย AOUT/VCC หลุด?" : "ค่าเต็ม 1023: สาย GND หลุด?"));
  if (ok) passSoil++;

  Serial.printf("  สรุป: ผ่าน BME280 %d/%d  BH1750 %d/%d  Soil %d/%d  | ปั๊ม=off ไฟ=%s\n",
                passBme, rounds, passLux, rounds, passSoil, rounds, ledOn ? "ON" : "off");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'p') {
      Serial.println(F("\n>> เปิดปั๊ม 2 วินาที (ควรได้ยินเสียงรีเลย์ 'แกร๊ก' และปั๊มหมุน)"));
      relay(PIN_PUMP, true); delay(2000); relay(PIN_PUMP, false);
      Serial.println(F(">> ปิดปั๊มแล้ว"));
    } else if (c == 'l') {
      ledOn = !ledOn; relay(PIN_LED, ledOn);
      Serial.printf("\n>> ไฟ LED %s\n", ledOn ? "เปิด" : "ปิด");
    } else if (c == 's') {
      scanI2C(); initSensors();
    } else if (c == 'c') {
      calib = true;
      Serial.println(F("\n>> โหมดปรับเทียบ: ถือเซ็นเซอร์ในอากาศ จดค่า = SOIL_RAW_DRY, จุ่มน้ำถึงขีด จดค่า = SOIL_RAW_WET (พิมพ์ x เพื่อหยุด)"));
    } else if (c == 'x') {
      calib = false;
    }
  }

  if (calib) {
    if (millis() - lastPrint >= 500) { lastPrint = millis(); Serial.printf("  soil raw = %d\n", readSoilRaw()); }
  } else if (millis() - lastPrint >= 3000) {
    lastPrint = millis();
    printRound();
  }
  delay(10);
}
