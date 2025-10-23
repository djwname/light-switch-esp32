import WebSocket from "ws";
import { v4 as uuidv4 } from "uuid";
import type { AsrMessage } from "./types";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// ==================== 配置 ====================
const CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY || "",
  wsUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
  sampleRate: 16000,
  reconnectDelay: 3000,
} as const;

// ==================== 类型定义 ====================
interface AsrCallbacks {
  onResult: (text: string, isEnd: boolean) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

// ==================== ASR 服务（最简化版）====================
export class AsrService {
  private ws: WebSocket | null = null;
  private taskId = "";
  private taskStarted = false;
  private destroyed = false; // ✅ 新增：标记是否已销毁
  private readonly callbacks: Required<AsrCallbacks>;
  private readonly clientId: string;

  constructor(callbacks: AsrCallbacks, clientId: string = "default") {
    this.clientId = clientId;
    this.callbacks = {
      onResult: callbacks.onResult,
      onComplete: callbacks.onComplete || (() => {}),
      onError:
        callbacks.onError ||
        ((err) => console.error(`[ASR ${this.clientId}]`, err)),
    };

    this.connect();
  }

  // ==================== 连接管理 ====================
  private connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    if (!CONFIG.apiKey) {
      this.callbacks.onError("缺少 DASHSCOPE_API_KEY 环境变量");
      return;
    }

    this.taskId = uuidv4().replace(/-/g, "").slice(0, 32);
    this.taskStarted = false;

    this.ws = new WebSocket(CONFIG.wsUrl, {
      headers: {
        Authorization: `bearer ${CONFIG.apiKey}`,
        "X-DashScope-DataInspection": "enable",
      },
    });

    this.setupWebSocketHandlers();
    console.log(`[ASR ${this.clientId}] 连接中... (task_id: ${this.taskId})`);
  }

  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      console.log(`[ASR ${this.clientId}] ✅ WebSocket 已连接`);
      this.sendRunTask();
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const message: AsrMessage = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        console.error(`[ASR ${this.clientId}] 解析消息失败:`, error);
      }
    });

    this.ws.on("close", (code, reason) => {
      console.log(
        `[ASR ${this.clientId}] 连接关闭 (code: ${code}, reason: ${reason.toString()})`,
      );
      this.taskStarted = false;
      this.ws = null;
      if (this.destroyed) {
        console.log(`[ASR ${this.clientId}] 已销毁，不再重连`);
        return;
      }
      // 3秒后自动重连
      setTimeout(() => this.connect(), CONFIG.reconnectDelay);
    });

    this.ws.on("error", (error) => {
      console.error(`[ASR ${this.clientId}] WebSocket 错误:`, error.message);
      this.callbacks.onError(`WebSocket 错误: ${error.message}`);
    });
  }

  // ==================== 任务管理 ====================
  private sendRunTask(): void {
    if (!this.isConnected()) {
      console.error(
        `[ASR ${this.clientId}] WebSocket 未就绪，无法发送 run-task`,
      );
      return;
    }

    const message: AsrMessage = {
      header: {
        action: "run-task",
        task_id: this.taskId,
        streaming: "duplex",
      },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: "paraformer-realtime-v2",
        parameters: {
          format: "pcm",
          sample_rate: CONFIG.sampleRate,
          heartbeat: true,
        },
        input: {},
      },
    };

    this.ws!.send(JSON.stringify(message));
    console.log(`[ASR ${this.clientId}] 已发送 run-task`);
  }

  private sendFinishTask(): void {
    if (!this.isConnected()) return;

    const message: AsrMessage = {
      header: {
        action: "finish-task",
        task_id: this.taskId,
        streaming: "duplex",
      },
      payload: { input: {} },
    };

    this.ws!.send(JSON.stringify(message));
    console.log(`[ASR ${this.clientId}] 已发送 finish-task`);
  }

  // ==================== 消息处理 ====================
  private handleMessage(message: AsrMessage): void {
    if (message.header.task_id !== this.taskId) return;

    const { event } = message.header;

    switch (event) {
      case "task-started":
        console.log(`[ASR ${this.clientId}] ✅ 任务已启动，开始接收音频`);
        this.taskStarted = true;
        break;

      case "result-generated":
        const sentence = message.payload?.output?.sentence;
        if (sentence) {
          this.callbacks.onResult(sentence.text, sentence.sentence_end);

          if (sentence.sentence_end) {
            console.log(
              `[ASR ${this.clientId}] 句子结束: "${sentence.text}" (${sentence.begin_time}-${sentence.end_time}ms)`,
            );
          }
        }
        break;

      case "task-finished":
        console.log(`[ASR ${this.clientId}] 任务完成`);
        this.callbacks.onComplete();
        break;

      case "task-failed":
        const error = `${message.header.error_code}: ${message.header.error_message}`;
        console.error(`[ASR ${this.clientId}] ❌ 任务失败:`, error);
        this.callbacks.onError(error);
        this.taskStarted = false;
        break;

      default:
        console.log(`[ASR ${this.clientId}] 未知事件: ${event}`);
    }
  }

  // ==================== 音频流管理 ====================
  appendAudioChunk(chunk: Buffer): void {
    if (!this.taskStarted || !this.isConnected()) {
      return;
    }

    try {
      this.ws!.send(chunk);
    } catch (error) {
      console.error(`[ASR ${this.clientId}] 发送音频块失败:`, error);
      this.callbacks.onError(`发送失败: ${error}`);
    }
  }

  endStream(): void {
    if (this.taskStarted) {
      this.sendFinishTask();
      this.taskStarted = false;
    }
  }

  // ==================== 工具方法 ====================
  private isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ==================== 销毁 ====================

  destroy(): void {
    if (this.destroyed) return; // 防止重复调用
    console.log(`[ASR ${this.clientId}] 销毁实例`);
    this.destroyed = true; // ✅ 标记为销毁
    try {
      if (this.taskStarted) {
        this.sendFinishTask();
        this.taskStarted = false;
      }

      if (this.ws) {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close(1000, "Client destroyed");
        }
        this.ws = null;
      }
    } catch (err) {
      console.error(`[ASR ${this.clientId}] destroy() 出错:`, err);
    }
  }
}
