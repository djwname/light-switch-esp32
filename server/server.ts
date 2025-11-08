import { createRequire } from "module";
import { createServer } from "http";
import { parse } from "url";
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import next from "next";
import { WebSocketServer } from "ws";
import type { WebSocket as WsWebSocket } from "ws";
import { AsrService } from "./lib/asrService";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
  dev: process.env.NODE_ENV !== "production",
  hostname: "localhost",
  port: 3000,
  audio: {
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    bufferDurationMs: 10000,
    autoSaveIntervalMs: 60000, // ✅ 每60秒自动保存
  },
} as const;

const BYTES_PER_SAMPLE = CONFIG.audio.channels * (CONFIG.audio.bitDepth / 8);
const BUFFER_SIZE =
  (CONFIG.audio.bufferDurationMs / 1000) *
  CONFIG.audio.sampleRate *
  BYTES_PER_SAMPLE;

function saveAudioFile(
  clientId: string,
  buffer: Buffer,
  segmentIndex?: number,
): void {
  const { WaveFile } = require("wavefile");
  if (buffer.length % 2 !== 0) {
    console.error(`Invalid buffer length: ${buffer.length}`);
    return;
  }

  // ✅ 如果没有数据就不保存
  if (buffer.length === 0) {
    console.log(`[${clientId}] 缓冲区为空，跳过保存`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const segmentStr = segmentIndex !== undefined ? `_seg${segmentIndex}` : "";
  const filePath = path.join(
    __dirname,
    "public",
    "audio",
    `audio_${clientId}${segmentStr}_${timestamp}.wav`,
  );

  const samples = new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 2,
  );

  const wav = new WaveFile();
  wav.fromScratch(
    CONFIG.audio.channels,
    CONFIG.audio.sampleRate,
    "16",
    samples,
  );
  writeFileSync(filePath, wav.toBuffer());
  console.log(`✅ 保存: ${filePath} (${(buffer.length / 1024).toFixed(2)} KB)`);
}

const app = next({
  dev: CONFIG.dev,
  hostname: CONFIG.hostname,
  port: CONFIG.port,
});

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    console.log(`${req.method} ${req.url} from ${req.socket.remoteAddress}`);
    try {
      await app.getRequestHandler()(req, res, parse(req.url!, true));
    } catch (err) {
      console.error("Error handling request:", req.url, err);
      res.statusCode = 500;
      res.end("Internal server error");
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
  });

  // 连接管理
  const audioBuffers = new Map<string, Buffer>();
  const playbackClients = new Set<WsWebSocket>();
  const asrInstances = new Map<string, AsrService>();
  const saveTimers = new Map<string, NodeJS.Timeout>(); // ✅ 保存定时器
  const segmentCounters = new Map<string, number>(); // ✅ 文件段计数器
  let clientCounter = 0;

  // 广播音频数据到所有播放客户端
  function broadcastAudio(data: Buffer) {
    playbackClients.forEach((client) => {
      if (client.readyState === 1) {
        try {
          client.send(data);
        } catch (error) {
          console.error("[Broadcast Audio] 失败:", error);
        }
      }
    });
  }

  // 广播 JSON 数据到所有播放客户端
  function broadcastData(data: any) {
    const message = JSON.stringify(data);
    playbackClients.forEach((client) => {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (error) {
          console.error("[Broadcast Data] 失败:", error);
        }
      }
    });
  }

  // 手动处理 WebSocket 升级请求
  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url!, `http://${request.headers.host}`)
      .pathname;

    if (pathname === "/api/audio") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleAudioInput(ws);
      });
    } else if (pathname === "/api/playback") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handlePlaybackClient(ws);
      });
    } else {
      socket.destroy();
    }
  });

  // 处理 ESP32 音频输入
  function handleAudioInput(ws: WsWebSocket) {
    const clientId = `client_${++clientCounter}`;
    console.log(`[Audio Input] ESP32 连接: ${clientId}`);

    audioBuffers.set(clientId, Buffer.alloc(0));
    segmentCounters.set(clientId, 0);

    let audioChunkCount = 0;

    // ✅ 启动定时保存
    const saveTimer = setInterval(() => {
      const buffer = audioBuffers.get(clientId);
      if (buffer && buffer.length > 0) {
        const segmentIndex = segmentCounters.get(clientId) || 0;
        console.log(`[${clientId}] ⏰ 定时保存 (段 ${segmentIndex + 1})`);
        saveAudioFile(clientId, buffer, segmentIndex);

        // 保存后清空缓冲区，开始新的段
        audioBuffers.set(clientId, Buffer.alloc(0));
        segmentCounters.set(clientId, segmentIndex + 1);
      }
    }, CONFIG.audio.autoSaveIntervalMs);

    saveTimers.set(clientId, saveTimer);

    // 为当前客户端创建独立的 ASR 实例
    const asrService = new AsrService(
      {
        onResult: (text, isEnd) => {
          console.log(`[识别 ${clientId}] ${isEnd ? "✅" : "📝"} "${text}"`);

          // 广播到浏览器
          broadcastData({
            type: "asr_result",
            text,
            isEnd,
            clientId,
          });

          // 只发送给对应的 ESP32
          if (ws.readyState === 1 && isEnd) {
            try {
              ws.send(text);
            } catch (error) {
              console.error(`[ESP32 ${clientId}] 发送失败:`, error);
            }
          }
        },
        onComplete: () => {
          console.log(`[ASR ${clientId}] 流结束`);
        },
        onError: (error) => {
          console.error(`[ASR ${clientId}] 错误:`, error);

          if (error.includes("NO_INPUT_AUDIO_ERROR")) {
            console.warn(`[${clientId}] 已收到 ${audioChunkCount} 个音频块`);
          }
        },
      },
      clientId,
    );

    asrInstances.set(clientId, asrService);

    ws.on("message", (data: Buffer) => {
      const currentBuffer = audioBuffers.get(clientId);
      if (!currentBuffer) return;

      audioChunkCount++;

      // 广播实时音频到播放客户端
      broadcastAudio(data);

      // 发送到该客户端专属的 ASR 服务
      const asr = asrInstances.get(clientId);
      if (asr) {
        asr.appendAudioChunk(data);
      }

      // ✅ 追加到缓冲区（不再检查 BUFFER_SIZE）
      const newBuffer = Buffer.concat([currentBuffer, data]);
      audioBuffers.set(clientId, newBuffer);
    });

    ws.on("close", () => {
      // ✅ 清除定时器
      const timer = saveTimers.get(clientId);
      if (timer) {
        clearInterval(timer);
        saveTimers.delete(clientId);
      }

      // ✅ 保存最后的数据
      const remainingBuffer = audioBuffers.get(clientId);
      if (remainingBuffer?.length) {
        const segmentIndex = segmentCounters.get(clientId) || 0;
        console.log(
          `[${clientId}] 连接断开，保存最后数据 (段 ${segmentIndex + 1})...`,
        );
        saveAudioFile(clientId, remainingBuffer, segmentIndex);
      }

      // 清理资源
      audioBuffers.delete(clientId);
      segmentCounters.delete(clientId);
      const asr = asrInstances.get(clientId);
      if (asr) {
        asr.destroy();
        asrInstances.delete(clientId);
      }

      console.log(
        `[Audio Input] ESP32 断开: ${clientId} (剩余: ${asrInstances.size})`,
      );
    });

    ws.on("error", (error) => {
      console.error(`[${clientId}] WebSocket 错误:`, error);

      // ✅ 清除定时器
      const timer = saveTimers.get(clientId);
      if (timer) {
        clearInterval(timer);
        saveTimers.delete(clientId);
      }

      // 错误时也要清理
      audioBuffers.delete(clientId);
      segmentCounters.delete(clientId);
      const asr = asrInstances.get(clientId);
      if (asr) {
        asr.destroy();
        asrInstances.delete(clientId);
      }
    });
  }

  // 处理浏览器播放客户端
  function handlePlaybackClient(ws: WsWebSocket) {
    console.log(`[Playback] 浏览器连接 (总数: ${playbackClients.size + 1})`);
    playbackClients.add(ws);

    // 发送音频配置
    ws.send(
      JSON.stringify({
        type: "config",
        sampleRate: CONFIG.audio.sampleRate,
        channels: CONFIG.audio.channels,
        bitDepth: CONFIG.audio.bitDepth,
      }),
    );

    ws.on("close", () => {
      playbackClients.delete(ws);
      console.log(`[Playback] 浏览器断开 (剩余: ${playbackClients.size})`);
    });

    ws.on("error", (error) => {
      console.error("[Playback] 错误:", error);
      playbackClients.delete(ws);
    });
  }

  httpServer.listen(CONFIG.port, (err?: Error) => {
    if (err) throw err;
    console.log(
      `\n🚀 Server ready on http://${CONFIG.hostname}:${CONFIG.port}`,
    );
    console.log(
      `📡 Audio Input: ws://${CONFIG.hostname}:${CONFIG.port}/api/audio`,
    );
    console.log(
      `🔊 Audio Playback: ws://${CONFIG.hostname}:${CONFIG.port}/api/playback`,
    );
    console.log(
      `⏰ Auto-save: Every ${CONFIG.audio.autoSaveIntervalMs / 1000}s\n`,
    );
  });
});
