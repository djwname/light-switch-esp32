#include "LED.h"

// LED类实现
LED::LED(byte ledPin) {
    pin = ledPin;
    state = false;
}

void LED::begin() {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
    state = false;
}

void LED::on() {
    digitalWrite(pin, HIGH);
    state = true;
}

void LED::off() {
    digitalWrite(pin, LOW);
    state = false;
}

void LED::toggle() {
    if (state) {
        off();
    } else {
        on();
    }
}

bool LED::isOn() const {
    return state;
}

byte LED::getPin() const {
    return pin;
}

void LED::blink(unsigned int onTime, unsigned int offTime) {
    on();
    delay(onTime);
    off();
    delay(offTime);
}

// ServoMotor类实现
ServoMotor::ServoMotor(byte servoPin, int minA, int maxA) {
    pin = servoPin;
    minAngle = minA;
    maxAngle = maxA;
    currentAngle = (minA + maxA) / 2;  // 初始角度为中间位置
}

void ServoMotor::begin() {
    servo.attach(pin);
    servo.write(currentAngle);
    delay(500);  // 等待舵机移动到初始位置
}

void ServoMotor::moveTo(int angle) {
    // 限制角度范围
    if (angle < minAngle) angle = minAngle;
    if (angle > maxAngle) angle = maxAngle;
    
    servo.write(angle);
    currentAngle = angle;
    delay(500);  // 短暂延迟确保舵机开始移动
}

void ServoMotor::smoothMoveTo(int targetAngle, int stepDelay) {
    // 限制目标角度范围
    if (targetAngle < minAngle) targetAngle = minAngle;
    if (targetAngle > maxAngle) targetAngle = maxAngle;
    
    // 确定移动方向
    int step = (targetAngle > currentAngle) ? 1 : -1;
    
    // 逐步移动到目标角度
    while (currentAngle != targetAngle) {
        currentAngle += step;
        servo.write(currentAngle);
        delay(stepDelay);
    }
}

void ServoMotor::sweep(int sweepDelay) {
    smoothMoveTo(maxAngle, sweepDelay);
    smoothMoveTo(minAngle, sweepDelay);
}

void ServoMotor::sweepTimes(int times, int sweepDelay) {
    for (int i = 0; i < times; i++) {
        sweep(sweepDelay);
    }
    // 回到中间位置
    smoothMoveTo((minAngle + maxAngle) / 2, sweepDelay);
}

int ServoMotor::getAngle() {
    return currentAngle;
}

void ServoMotor::detach() {
    servo.detach();
}

void ServoMotor::reattach() {
    servo.attach(pin);
    servo.write(currentAngle);
    delay(100);
}
