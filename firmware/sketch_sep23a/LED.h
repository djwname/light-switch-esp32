#ifndef LED_H
#define LED_H

#include <Arduino.h>
#include <ESP32Servo.h>


class LED {
private:
  byte pin;
  bool state;

public:
    // 构造函数
    LED(byte ledPin);

    // 初始化
    void begin();           
    // 点亮
    void on();     
    // 熄灭        
    void off();         
    // 切换状态   
    void toggle();         
    // 获取当前状态
    bool isOn() const;     
    // 获取引脚号
    byte getPin() const;   
    // 闪烁控制（阻塞式）
    void blink(unsigned int onTime = 1000, unsigned int offTime = 1000);

};

class ServoMotor {
private:
    Servo servo;
    byte pin;
    int currentAngle;
    int minAngle;
    int maxAngle;

public:
    // 构造函数
    ServoMotor(byte servoPin, int minA = 0, int maxA = 180) ;

    // 初始化
    void begin() ;
    // 移动到指定角度
    void moveTo(int angle) ;
    // 缓慢移动到指定角度
    void smoothMoveTo(int targetAngle, int stepDelay = 20) ;
    // 扫描动作（左右摆动）
    void sweep(int sweepDelay = 20) ;
    // 摆动指定次数
    void sweepTimes(int times, int sweepDelay = 20) ;
    // 获取当前角度
    int getAngle();
    // 分离舵机（省电）
    void detach() ;
    // 重新连接舵机
    void reattach();
};

#endif  // LED_H
