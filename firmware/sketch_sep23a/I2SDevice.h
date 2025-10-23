// ============================================
// I2SDevice.h - I2S 设备控制模块头文件
// ============================================
#ifndef I2SDEVICE_H
#define I2SDEVICE_H

#include <driver/i2s.h>  // ESP32 I2S 驱动
#include <esp_log.h>     // 日志（Arduino 中可用 ESP_LOGI）

// 设备类型枚举
typedef enum {
  DEVICE_MIC,    // 麦克风 (RX, 单声道)
  DEVICE_SENSOR  // 传感器 (TX/RX 可配置，多声道示例)
} i2s_device_type_t;

// 默认端口
#define DEFAULT_I2S_PORT I2S_NUM_0

class I2SDevice {
private:
  i2s_device_type_t type;                 // 设备类型
  int sample_rate;                        // 采样率
  int channels;                           // 声道数
  i2s_bits_per_sample_t bits_per_sample;  // 位深
  int ws_pin;                             // WS/LRCLK 引脚
  int sd_pin;                             // SD/DIN/DOUT 引脚
  int sck_pin;                            // SCK/BCLK 引脚
  i2s_port_t port;                        // I2S 端口
  bool initialized;                       // 初始化状态
  bool rx_mode;                           // 当前是否 RX 模式（输入）

public:
  // 构造函数
  I2SDevice(i2s_device_type_t dev_type, int sr = 16000, int ch = 1,
            i2s_bits_per_sample_t bps = I2S_BITS_PER_SAMPLE_16BIT,
            int ws = 25, int sd = 33, int sck = 32, i2s_port_t p = DEFAULT_I2S_PORT) {
    type = dev_type;
    sample_rate = sr;
    channels = ch;
    bits_per_sample = bps;
    ws_pin = ws;
    sd_pin = sd;
    sck_pin = sck;
    port = p;
    initialized = false;
    rx_mode = (dev_type == DEVICE_MIC);  // 默认麦克风为 RX
    Serial.print("[I2SDevice] 创建 ");
    Serial.print((type == DEVICE_MIC) ? "麦克风" : "传感器");
    Serial.print(" 实例 (采样率: ");
    Serial.print(sr);
    Serial.println(" Hz)");
  }

  // 初始化（类似 Relay::begin()）
  bool begin() {
    if (initialized) {
      Serial.println("[I2SDevice] 已初始化，跳过");
      return true;
    }

    // 配置 i2s_config_t
    i2s_config_t i2s_config = {
      .mode = rx_mode ? (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX) : (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
      .sample_rate = sample_rate,
      .bits_per_sample = bits_per_sample,
      .channel_format = (channels == 1) ? I2S_CHANNEL_FMT_ONLY_LEFT : I2S_CHANNEL_FMT_RIGHT_LEFT,
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 8,
      .dma_buf_len = 1024,
      .use_apll = false,
      .tx_desc_auto_clear = false,
      .fixed_mclk = 0
    };

    

    // 安装驱动
    esp_err_t ret = i2s_driver_install(port, &i2s_config, 0, NULL);
    if (ret != ESP_OK) {
      Serial.printf("[I2SDevice] 驱动安装失败: %s\n", esp_err_to_name(ret));
      return false;
    }

    // 配置引脚
    i2s_pin_config_t pin_config = {
      .bck_io_num = sck_pin,                                 // BCLK
      .ws_io_num = ws_pin,                                   // WS/LRCLK
      .data_out_num = rx_mode ? I2S_PIN_NO_CHANGE : sd_pin,  // TX 输出到 SD
      .data_in_num = rx_mode ? sd_pin : I2S_PIN_NO_CHANGE    // RX 输入从 SD
    };

    ret = i2s_set_pin(port, &pin_config);
    if (ret != ESP_OK) {
      Serial.printf("[I2SDevice] 引脚设置失败: %s\n", esp_err_to_name(ret));
      return false;
    }

    initialized = true;
    Serial.print("[I2SDevice] ");
    Serial.print((type == DEVICE_MIC) ? "麦克风" : "传感器");
    Serial.print(" 初始化成功 (RX: ");
    Serial.print(rx_mode ? "是" : "否");
    Serial.print(", 声道: ");
    Serial.print(channels);
    Serial.println(")");

    return true;
  }

  // 读取数据（麦克风/传感器输入）
  size_t read(uint8_t* buffer, size_t size, TickType_t ticks_to_wait = portMAX_DELAY) {
    if (!initialized) {
      Serial.println("[I2SDevice] 未初始化，无法读取");
      return 0;
    }
    if (!rx_mode) {
      Serial.println("[I2SDevice] 非 RX 模式，无法读取");
      return 0;
    }
    size_t bytes_read = 0;
    esp_err_t ret = i2s_read(port, buffer, size, &bytes_read, ticks_to_wait);
    if (ret != ESP_OK) {
      Serial.printf("[I2SDevice] 读取失败: %s\n", esp_err_to_name(ret));
    }
    return bytes_read;
  }

  // 写入数据（传感器输出示例）
  size_t write(const uint8_t* buffer, size_t size, TickType_t ticks_to_wait = portMAX_DELAY) {
    if (!initialized) {
      Serial.println("[I2SDevice] 未初始化，无法写入");
      return 0;
    }
    if (rx_mode) {
      Serial.println("[I2SDevice] RX 模式，无法写入");
      return 0;
    }
    size_t bytes_written = 0;
    esp_err_t ret = i2s_write(port, buffer, size, &bytes_written, ticks_to_wait);
    if (ret != ESP_OK) {
      Serial.printf("[I2SDevice] 写入失败: %s\n", esp_err_to_name(ret));
    }
    return bytes_written;
  }

  // 切换模式（RX/TX）
  void toggleMode(bool to_rx = true) {
    if (initialized) {
      Serial.println("[I2SDevice] 已初始化，无法切换模式（需重启）");
      return;
    }
    rx_mode = to_rx;
    Serial.print("[I2SDevice] 模式切换为 ");
    Serial.println(to_rx ? "RX (输入)" : "TX (输出)");
  }

  // 清理资源（类似 Relay::off()）
  void end() {
    if (!initialized) {
      Serial.println("[I2SDevice] 未初始化，无需清理");
      return;
    }
    i2s_driver_uninstall(port);
    initialized = false;
    Serial.println("[I2SDevice] 资源清理完成");
  }

  // 获取状态
  bool isInitialized() {
    return initialized;
  }

  bool isRxMode() {
    return rx_mode;
  }

  // 获取配置
  i2s_device_type_t getType() {
    return type;
  }

  int getSampleRate() {
    return sample_rate;
  }

  int getChannels() {
    return channels;
  }

  uint8_t getPin(int pin_type) {  // 0=WS, 1=SD, 2=SCK
    switch (pin_type) {
      case 0: return ws_pin;
      case 1: return sd_pin;
      case 2: return sck_pin;
      default: return 0;
    }
  }
};

#endif  // I2SDEVICE_H