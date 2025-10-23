#include "Relay.h"
#include <driver/i2s.h>
#include <arduinoFFT.h>

Relay relay(20);

#define I2S_WS 9
#define I2S_SD 5
#define I2S_SCK 19

#define SAMPLE_RATE 16000
#define SAMPLES 512
#define I2S_PORT I2S_NUM_0

float vReal[SAMPLES];
float vImag[SAMPLES];
ArduinoFFT<float> FFT = ArduinoFFT<float>(vReal, vImag, SAMPLES, SAMPLE_RATE);

// 用于双击判断
unsigned long lastSnapTime = 0;
int snapCount = 0;

void setup() {
  Serial.begin(115200);
  relay.begin();
  relay.off();
  Serial.println("🎧 INMP441 Double Finger Snap Detector");

  // 配置 I2S
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = SAMPLES,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = -1,
    .data_in_num = I2S_SD
  };

  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
}

void loop() {

  int32_t buffer[SAMPLES];
  size_t bytesRead;

  i2s_read(I2S_PORT, buffer, sizeof(buffer), &bytesRead, portMAX_DELAY);

  for (int i = 0; i < SAMPLES; i++) {
    int16_t sample16 = buffer[i] >> 14;
    vReal[i] = (float)sample16;
    vImag[i] = 0.0;
  }

  FFT.windowing(FFTWindow::Hamming, FFTDirection::Forward);
  FFT.compute(FFTDirection::Forward);
  FFT.complexToMagnitude();

  float peak = 0.0;
  int peakIndex = 0;
  for (int i = 1; i < SAMPLES / 2; i++) {
    if (vReal[i] > peak) {
      peak = vReal[i];
      peakIndex = i;
    }
  }

  float dominantFreq = peakIndex * ((float)SAMPLE_RATE / SAMPLES);

  // 检测单个响指
  bool isSnap = (dominantFreq > 2000 && dominantFreq < 5000 && peak > 6000);

  if (isSnap) {
    unsigned long now = millis();

   
    // 第二次检测（时间在0.2~0.8秒之间）
       Serial.println("👏 Double snap detected! Trigger!");
      relay.toggle();
      snapCount = 0;  // 重置
     // 超时则重置
   
    delay(300);  // 防止同一次响指多次触发
  }

  delay(20);
}
