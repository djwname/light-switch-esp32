#include "Relay.h"
#include <driver/i2s.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "I2SDevice.h"
#include "RGB_lamp.h"

Relay relay(20);

#define I2S_WS 9
#define I2S_SD 5
#define I2S_SCK 19

// ✅ 优化：减小 chunk 大小，提高发送频率
const int CHUNK_DURATION_MS = 50; // 从 100ms 改为 50ms
const int CHUNK_SIZE = 1600; // 从 3200 改为 1600 (50ms @ 16kHz)

const char* SSID = "bob";
const char* PASSWORD = "www.bobjoy.com";
const char* SERVER_HOST = "192.168.8.127";
const uint16_t SERVER_PORT = 3000;
const char* WS_PATH = "/api/audio";

I2SDevice mic(DEVICE_MIC, 16000, 1, I2S_BITS_PER_SAMPLE_16BIT, I2S_WS, I2S_SD, I2S_SCK);
uint8_t audioBuffer[CHUNK_SIZE * 2]; // 裕量，防止溢出
WebSocketsClient webSocket;

void setup() {
  Serial.begin(115200);
  relay.begin();
  relay.on();
  delay(1000);
  
  Serial.println("[ESP32] 启动音频发送器...");
  
  WiFi.begin(SSID, PASSWORD);
  Serial.print("[WiFi] 连接中...");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WiFi] 已连接! IP: " + WiFi.localIP().toString());
  
  if (!mic.begin()) {
    Serial.println("[I2S] 初始化失败!");
    while (1);
  }
  Serial.println("[I2S] 麦克风就绪.");
  
  // ✅ 配置 WebSocket 心跳（保持连接稳定）
  webSocket.begin(SERVER_HOST, SERVER_PORT, WS_PATH);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  webSocket.enableHeartbeat(15000, 3000, 2); // 15s ping, 3s timeout, 2 retries
  
  Serial.println("[WebSocket] 连接到服务器...");
}

void loop() {
  webSocket.loop();
  
  // ✅ 检查连接状态
  if (!webSocket.isConnected()) {
    delay(100);
    return;
  }
  
  size_t bytesRead = mic.read(audioBuffer, CHUNK_SIZE);
  if (bytesRead > 0 && bytesRead == CHUNK_SIZE) {
    // ✅ 直接发送二进制数据
    webSocket.sendBIN(audioBuffer, bytesRead);
  }
}

// ✅ 新增：解析文本并控制继电器
void handleRelayCommand(const char* text) {
  String message = String(text);
  message.toLowerCase(); // 转小写便于匹配
  
  // 检测关灯相关指令
  if (message.indexOf("关灯") != -1 || 
      message.indexOf("关闭") != -1 || 
      message.indexOf("turn off") != -1 ||
      message.indexOf("off") != -1) {
    relay.off();
    Serial.println("[继电器] 🔴 已关闭灯光");
  }
  // 检测开灯相关指令
  else if (message.indexOf("开灯") != -1 || 
           message.indexOf("打开") != -1 || 
           message.indexOf("turn on") != -1 ||
           message.indexOf("on") != -1) {
    relay.on();
    Serial.println("[继电器] 🟢 已打开灯光");
  }
}

void webSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
  Serial.printf("[WebSocket Event] Type: %d, Length: %d\n", type, length);
  
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WebSocket] 🔌 断开连接");
      break;
      
    case WStype_CONNECTED:
      Serial.printf("[WebSocket] ✅ 已连接到: %s\n", payload);
      break;
      
    case WStype_TEXT:
      Serial.printf("[WebSocket] 📩 收到文本: %s\n", (char*)payload);
      // ✅ 新增：解析并执行继电器控制指令
      handleRelayCommand((char*)payload);
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
}