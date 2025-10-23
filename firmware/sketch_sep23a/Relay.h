// ============================================
// Relay.h - 继电器控制模块头文件
// ============================================
#ifndef RELAY_H
#define RELAY_H

#include <Arduino.h>

class Relay {
private:
    uint8_t pin;           // 继电器引脚
    bool state;            // 当前状态
    bool invertLogic;      // 是否反转逻辑（低电平触发）
    
public:
    // 构造函数
    Relay(uint8_t relayPin, bool invert = false) {
        pin = relayPin;
        state = false;
        invertLogic = invert;
    }
    
    // 初始化
    void begin() {
        pinMode(pin, OUTPUT);
        off();  // 默认关闭
        Serial.print("[Relay] 初始化引脚 GPIO");
        Serial.print(pin);
        Serial.println(invertLogic ? " (低电平触发)" : " (高电平触发)");
    }
    
    // 打开继电器
    void on() {
        state = true;
        digitalWrite(pin, invertLogic ? LOW : HIGH);
        Serial.print("[Relay] GPIO");
        Serial.print(pin);
        Serial.println(" 已打开");
    }
    
    // 关闭继电器
    void off() {
        state = false;
        digitalWrite(pin, invertLogic ? HIGH : LOW);
        Serial.print("[Relay] GPIO");
        Serial.print(pin);
        Serial.println(" 已关闭");
    }
    
    // 切换状态
    void toggle() {
        if (state) {
            off();
        } else {
            on();
        }
    }
    
    // 设置状态
    void setState(bool s) {
        if (s) {
            on();
        } else {
            off();
        }
    }
    
    // 获取当前状态
    bool getState() {
        return state;
    }
    
    // 获取引脚号
    uint8_t getPin() {
        return pin;
    }
    
    // 脉冲控制（打开指定时间后自动关闭）
    void pulse(unsigned long duration) {
        on();
        delay(duration);
        off();
    }
};

#endif
