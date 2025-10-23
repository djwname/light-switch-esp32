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
  },
} as const;

const BYTES_PER_SAMPLE = CONFIG.audio.channels * (CONFIG.audio.bitDepth / 8);
const BUFFER_SIZE =
  (CONFIG.audio.bufferDurationMs / 1000) *
  CONFIG.audio.sampleRate *
  BYTES_PER_SAMPLE;

function saveAudioFile(clientId: string, buffer: Buffer): void {
  const { WaveFile } = require("wavefile");
  if (buffer.length % 2 !== 0) {
    console.error(`Invalid buffer length: ${buffer.length}`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(
    __dirname,
    "public",
    "audio",
    `audio_${clientId}_${timestamp}.wav`,
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
  console.log(`Saved: ${filePath} (${(buffer.length / 1024).toFixed(2)} KB)`);
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

    let audioChunkCount = 0; // ✅ 统计收到的音频块数量

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

          // ✅ 如果是 NO_INPUT_AUDIO_ERROR，检查是否真的没收到音频
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

      // 广播实时音频到播放客户端
      broadcastAudio(data);

      // 发送到该客户端专属的 ASR 服务
      const asr = asrInstances.get(clientId);
      if (asr) {
        asr.appendAudioChunk(data);
      }

      const newBuffer = Buffer.concat([currentBuffer, data]);
      audioBuffers.set(clientId, newBuffer);

      if (newBuffer.length >= BUFFER_SIZE) {
        audioBuffers.set(clientId, Buffer.alloc(0));
      }
    });

    ws.on("close", () => {
      const remainingBuffer = audioBuffers.get(clientId);
      if (remainingBuffer?.length) {
        console.log(`[${clientId}] 连接断开，保存剩余数据...`);
        //saveAudioFile(clientId, remainingBuffer);
      }

      // 清理资源
      audioBuffers.delete(clientId);
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

      // 错误时也要清理
      audioBuffers.delete(clientId);
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
      `💾 Buffer: ${(BUFFER_SIZE / 1024 / 1024).toFixed(2)} MB (${CONFIG.audio.bufferDurationMs / 1000}s)\n`,
    );
  });
});
