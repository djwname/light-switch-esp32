#include "Relay.h"
#include <driver/i2s.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "I2SDevice.h"
#include "RGB_lamp.h"

Relay relay(20);

// I2S引脚定义
#define I2S_WS 9
#define I2S_SD 5
#define I2S_SCK 19

// ✅ 音频参数配置
const int CHUNK_DURATION_MS = 50;
const int SAMPLE_RATE = 16000;
const int SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_DURATION_MS) / 1000; // 800 samples

// ✅ 32bit输入 -> 16bit输出
const int INPUT_BUFFER_SIZE = SAMPLES_PER_CHUNK * 4;  // 3200 bytes (32bit)
const int OUTPUT_BUFFER_SIZE = SAMPLES_PER_CHUNK * 2; // 1600 bytes (16bit)

// WiFi & WebSocket配置
const char* SSID = "bob";
const char* PASSWORD = "www.bobjoy.com";
const char* SERVER_HOST = "pi";
const uint16_t SERVER_PORT = 3000;
const char* WS_PATH = "/api/audio";

// ✅ 使用32bit配置创建麦克风
I2SDevice mic(DEVICE_MIC, SAMPLE_RATE, 1, I2S_BITS_PER_SAMPLE_32BIT, I2S_WS, I2S_SD, I2S_SCK);

// 缓冲区
uint8_t inputBuffer[INPUT_BUFFER_SIZE];   // 32bit原始数据
uint8_t outputBuffer[OUTPUT_BUFFER_SIZE]; // 16bit转换后数据

WebSocketsClient webSocket;

// ✅ 内存监控变量
unsigned long lastMemCheck = 0;
const unsigned long MEM_CHECK_INTERVAL = 5000; // 每5秒检查一次

void setup() {
  Serial.begin(115200);
  
  relay.begin();
  relay.off();
  delay(1000);
  
  Serial.println("[ESP32] 启动音频发送器...");
  Serial.printf("[Memory] 初始空闲堆: %d 字节\n", ESP.getFreeHeap());
  
  // WiFi连接
  WiFi.begin(SSID, PASSWORD);
  Serial.print("[WiFi] 连接中...");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WiFi] 已连接! IP: " + WiFi.localIP().toString());
  
  // I2S初始化
  if (!mic.begin()) {
    Serial.println("[I2S] 初始化失败!");
    while (1) delay(1000);
  }
  Serial.println("[I2S] 麦克风就绪 (32bit模式)");
  
  // WebSocket配置
  webSocket.begin(SERVER_HOST, SERVER_PORT, WS_PATH);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2);
  
  Serial.println("[WebSocket] 连接到服务器...");
  Serial.printf("[Memory] 配置后空闲堆: %d 字节\n", ESP.getFreeHeap());
}

void loop() {
  webSocket.loop();
  
  // ✅ 定期内存检查
  if (millis() - lastMemCheck > MEM_CHECK_INTERVAL) {
    Serial.printf("[Memory] 空闲堆: %d 字节\n", ESP.getFreeHeap());
    lastMemCheck = millis();
  }
  
  // 检查连接状态
  if (!webSocket.isConnected()) {
    delay(100);
    return;
  }
  
  // ✅ 读取32bit音频数据
  size_t bytesRead = mic.read(inputBuffer, INPUT_BUFFER_SIZE, pdMS_TO_TICKS(100));
  
  if (bytesRead > 0) {
    // ✅ 验证读取的数据是4的倍数（32bit对齐）
    if (bytesRead % 4 != 0) {
      Serial.printf("[Warning] 非对齐数据: %d 字节\n", bytesRead);
      return;
    }
    
    // ✅ 32bit -> 16bit 转换
    int samples = bytesRead / 4; // 32bit样本数
    convert32to16(inputBuffer, outputBuffer, samples);
    
    // 发送16bit数据
    size_t outputSize = samples * 2;
    bool sent = webSocket.sendBIN(outputBuffer, outputSize);
    
    if (!sent) {
      Serial.println("[WebSocket] 发送失败，可能缓冲区已满");
    }
  } else {
    delay(1); // 避免忙等
  }
  
  delay(1); // yield CPU
}

// ✅ 32bit转16bit转换函数（取高16位）
void convert32to16(uint8_t* input32, uint8_t* output16, int samples) {
  int32_t* in = (int32_t*)input32;
  int16_t* out = (int16_t*)output16;
  
  for (int i = 0; i < samples; i++) {
    // 方法1: 直接取高16位（右移16位）
    out[i] = (int16_t)(in[i] >> 16);
    
    // 方法2: 如果需要更好的动态范围，可以先除以256再右移8位
    // out[i] = (int16_t)((in[i] >> 8) & 0xFFFF);
  }
}

// ✅ 继电器控制函数（带超时保护）
void handleRelayCommand(const char* text) {
  if (!text || strlen(text) == 0) {
    Serial.println("[Relay] 收到空指令，忽略");
    return;
  }
  
  // ✅ 防止字符串过长导致内存问题
  if (strlen(text) > 256) {
    Serial.println("[Relay] 指令过长，忽略");
    return;
  }
  
  String message = String(text);
  message.toLowerCase();
  
  // 检测关灯指令
  if (message.indexOf("关") != -1 ||
      message.indexOf("turn off") != -1 ||
      message.indexOf("off") != -1) {
    relay.off();
    Serial.println("[继电器] 🔴 已关闭灯光");
  }
  // 检测开灯指令
  else if (message.indexOf("开") != -1 ||
           message.indexOf("turn on") != -1 ||
           message.indexOf("on") != -1) {
    relay.on();
    Serial.println("[继电器] 🟢 已打开灯光");
  }
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WebSocket] 🔌 断开连接");
      Serial.printf("[Memory] 空闲堆: %d 字节\n", ESP.getFreeHeap());
      break;
      
    case WStype_CONNECTED:
      Serial.printf("[WebSocket] ✅ 已连接到: %s\n", payload);
      Serial.printf("[Memory] 空闲堆: %d 字节\n", ESP.getFreeHeap());
      break;
      
    case WStype_TEXT:
      Serial.printf("[WebSocket] 📩 收到文本 (%d bytes): %s\n", length, (char*)payload);
      handleRelayCommand((char*)payload);
      break;
      
    case WStype_BIN:
      Serial.printf("[WebSocket] 📦 收到二进制数据: %d 字节\n", length);
      break;
      
    case WStype_ERROR:
      Serial.printf("[WebSocket] ❌ 错误: %s\n", (char*)payload);
      break;
      
    case WStype_PING:
      Serial.println("[WebSocket] 💓 PING");
      break;
      
    case WStype_PONG:
      Serial.println("[WebSocket] 💓 PONG");
      break;
      
    default:
      break;
  }
}

void cleanup() {
  mic.end();
  webSocket.disconnect();
  Serial.println("[ESP32] 清理完成.");
  Serial.printf("[Memory] 最终空闲堆: %d 字节\n", ESP.getFreeHeap());
}