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
  taskStartTimeout: 5000,
  reconnectDelay: 3000,
} as const;

// ==================== 类型定义 ====================
interface AsrCallbacks {
  onResult: (text: string, isEnd: boolean) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

// ==================== ASR 服务 ====================
export class AsrService {
  private static instance: AsrService | null = null;

  private ws: WebSocket | null = null;
  private taskId = "";
  private taskStarted = false;
  private taskStartTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly callbacks: Required<AsrCallbacks>;

  private constructor(callbacks: AsrCallbacks) {
    this.callbacks = {
      onResult: callbacks.onResult,
      onComplete: callbacks.onComplete || (() => {}),
      onError:
        callbacks.onError || ((err) => console.error("[ASR Error]", err)),
    };
  }

  // ==================== 单例模式 ====================
  static getInstance(callbacks: AsrCallbacks): AsrService {
    if (!AsrService.instance) {
      AsrService.instance = new AsrService(callbacks);
      AsrService.instance.connect();
    }
    return AsrService.instance;
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
    console.log(`[ASR] 连接中... (task_id: ${this.taskId})`);
  }

  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on("open", () => {
      console.log("[ASR] ✅ WebSocket 已连接");
      this.startTaskWithTimeout();
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      try {
        const message: AsrMessage = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        console.error("[ASR] 解析消息失败:", error);
      }
    });

    this.ws.on("close", (code, reason) => {
      console.log(
        `[ASR] 连接关闭 (code: ${code}, reason: ${reason.toString()})`,
      );
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      console.error("[ASR] WebSocket 错误:", error.message);
      this.callbacks.onError(`WebSocket 错误: ${error.message}`);
    });
  }

  // ==================== 任务管理 ====================
  private startTaskWithTimeout(): void {
    this.sendRunTask();
    this.taskStartTimer = setTimeout(() => {
      if (!this.taskStarted) {
        console.warn("[ASR] ⚠️ task-started 超时，重试...");
        this.startTaskWithTimeout();
      }
    }, CONFIG.taskStartTimeout);
  }

  private sendRunTask(): void {
    if (!this.isConnected()) {
      console.error("[ASR] WebSocket 未就绪，无法发送 run-task");
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
    console.log("[ASR] 已发送 run-task");
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
    console.log("[ASR] 已发送 finish-task");
  }

  // ==================== 消息处理 ====================
  private handleMessage(message: AsrMessage): void {
    if (message.header.task_id !== this.taskId) return;

    const { event } = message.header;

    switch (event) {
      case "task-started":
        this.onTaskStarted();
        break;

      case "result-generated":
        this.onResultGenerated(message);
        break;

      case "task-finished":
        console.log("[ASR] 任务完成");
        this.callbacks.onComplete();
        break;

      case "task-failed":
        this.onTaskFailed(message);
        break;

      default:
        console.log(`[ASR] 未知事件: ${event}`);
    }
  }

  private onTaskStarted(): void {
    console.log("[ASR] ✅ 任务已启动，开始接收音频");
    this.taskStarted = true;
    this.clearTaskStartTimer();
  }

  private onResultGenerated(message: AsrMessage): void {
    const sentence = message.payload?.output?.sentence;
    if (!sentence) return;

    this.callbacks.onResult(sentence.text, sentence.sentence_end);

    if (sentence.sentence_end) {
      console.log(
        `[ASR] 句子结束: "${sentence.text}" (${sentence.begin_time}-${sentence.end_time}ms)`,
      );
    }
  }

  private onTaskFailed(message: AsrMessage): void {
    const error = `${message.header.error_code}: ${message.header.error_message}`;
    console.error("[ASR] ❌ 任务失败:", error);
    this.callbacks.onError(error);
    this.taskStarted = false;
    this.clearTaskStartTimer();
  }

  // ==================== 音频流管理 ====================
  appendAudioChunk(chunk: Buffer): void {
    if (!this.taskStarted || !this.isConnected()) {
      return;
    }

    try {
      this.ws!.send(chunk);
    } catch (error) {
      console.error("[ASR] 发送音频块失败:", error);
      this.callbacks.onError(`发送失败: ${error}`);
    }
  }

  endStream(): void {
    if (this.taskStarted) {
      setTimeout(() => this.sendFinishTask(), 500);
      this.taskStarted = false;
    }
  }

  // ==================== 工具方法 ====================
  private isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private clearTaskStartTimer(): void {
    if (this.taskStartTimer) {
      clearTimeout(this.taskStartTimer);
      this.taskStartTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      console.log("[ASR] 尝试重新连接...");
      this.reconnectTimer = null;
      this.connect();
    }, CONFIG.reconnectDelay);
  }

  private cleanup(): void {
    this.ws = null;
    this.taskStarted = false;
    this.clearTaskStartTimer();
  }

  // ==================== 销毁 ====================
  destroy(): void {
    console.log("[ASR] 销毁实例");
    this.clearTaskStartTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.sendFinishTask();
      this.ws.close();
      this.ws = null;
    }

    AsrService.instance = null;
  }
}
