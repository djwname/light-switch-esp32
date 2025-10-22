"use client";

import { useState, useRef, useEffect } from "react";

interface AudioConfig {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

interface AsrResult {
  text: string;
  isEnd: boolean;
  timestamp: number;
  clientId?: string;
}

export default function LiveAudioPlayer() {
  const [isConnected, setIsConnected] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [bufferSize, setBufferSize] = useState(0);
  const [bytesReceived, setBytesReceived] = useState(0);
  const [latency, setLatency] = useState(0);
  const [audioContextState, setAudioContextState] =
    useState<string>("未初始化");
  const [asrResults, setAsrResults] = useState<AsrResult[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferQueueRef = useRef<Float32Array[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const configRef = useRef<AudioConfig | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const isPlayingRef = useRef(false);

  const asrContainerRef = useRef<HTMLDivElement | null>(null); // ✅ 新增: ASR 容器 ref

  // ✅ 自动滚动到底部
  useEffect(() => {
    if (asrContainerRef.current) {
      asrContainerRef.current.scrollTop = asrContainerRef.current.scrollHeight;
    }
  }, [asrResults]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  const connect = async () => {
    const ws = new WebSocket("ws://pi:3000/api/playback");
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("✅ 已连接到音频服务器");
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "config") {
            configRef.current = {
              sampleRate: data.sampleRate,
              channels: data.channels,
              bitDepth: data.bitDepth,
            };
            console.log("📡 收到音频配置:", configRef.current);
            initAudioContext();
          } else if (data.type === "asr_result") {
            const result: AsrResult = {
              text: data.text,
              isEnd: data.isEnd,
              timestamp: data.timestamp,
              clientId: data.clientId,
            };
            setAsrResults((prev) => [...prev, result]);
            console.log(
              "🗣️ 实时 ASR 结果:",
              data.text,
              data.isEnd ? "(句子结束)" : "(部分)",
            );
          } else if (data.type === "asr_error") {
            console.error("🗣️ ASR 错误:", data.error);
          } else {
            console.log("📡 收到其他数据:", data);
          }
        } catch (error) {
          console.error("解析 JSON 失败:", error);
        }
      } else if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          processAudioChunk(buffer);
        });
      }
    };

    ws.onclose = () => {
      console.log("🔌 已断开连接");
      setIsConnected(false);
      setIsPlaying(false);
      isPlayingRef.current = false;
    };

    ws.onerror = (error) => {
      console.error("❌ WebSocket 错误:", error);
      setIsConnected(false);
    };
  };

  const disconnect = () => {
    isPlayingRef.current = false;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    audioBufferQueueRef.current = [];
    nextPlayTimeRef.current = 0;
    setIsConnected(false);
    setIsPlaying(false);
    setAudioContextState("未初始化");
    setAsrResults([]);
  };

  const initAudioContext = async () => {
    if (!configRef.current) return;

    try {
      const audioContext = new AudioContext({
        sampleRate: configRef.current.sampleRate,
      });
      audioContextRef.current = audioContext;

      const gainNode = audioContext.createGain();
      gainNode.connect(audioContext.destination);
      gainNode.gain.value = volume;
      gainNodeRef.current = gainNode;

      nextPlayTimeRef.current = audioContext.currentTime;

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      setAudioContextState(audioContext.state);
      console.log("🎵 AudioContext 已初始化，状态:", audioContext.state);

      audioContext.addEventListener("statechange", () => {
        setAudioContextState(audioContext.state);
        console.log("🎵 AudioContext 状态变化:", audioContext.state);
      });
    } catch (error) {
      console.error("❌ 初始化 AudioContext 失败:", error);
    }
  };

  const processAudioChunk = (arrayBuffer: ArrayBuffer) => {
    if (!audioContextRef.current || !configRef.current) {
      console.warn("⚠️ AudioContext 或配置未就绪");
      return;
    }

    setBytesReceived((prev) => prev + arrayBuffer.byteLength);

    const int16Data = new Int16Array(arrayBuffer);
    const float32Data = new Float32Array(int16Data.length);

    let maxAmplitude = 0;
    for (let i = 0; i < int16Data.length; i++) {
      const normalized = int16Data[i] / 32768.0;
      float32Data[i] = normalized;
      maxAmplitude = Math.max(maxAmplitude, Math.abs(normalized));
    }

    if (Math.random() < 0.02) {
      console.log(
        `🎚️ 音频幅度: ${(maxAmplitude * 100).toFixed(1)}% (${int16Data.length} 样本)`,
      );
    }

    audioBufferQueueRef.current.push(float32Data);
    setBufferSize(audioBufferQueueRef.current.length);

    if (!isPlayingRef.current && audioBufferQueueRef.current.length >= 5) {
      console.log("▶️ 缓冲充足，开始自动播放");
      startPlayback();
    }
  };

  const startPlayback = async () => {
    if (!audioContextRef.current) return;

    if (audioContextRef.current.state === "suspended") {
      try {
        await audioContextRef.current.resume();
        console.log("🎵 AudioContext 已恢复");
      } catch (error) {
        console.error("❌ 恢复 AudioContext 失败:", error);
        return;
      }
    }

    isPlayingRef.current = true;
    setIsPlaying(true);
    schedulePlayback();
  };

  const schedulePlayback = () => {
    if (
      !audioContextRef.current ||
      !gainNodeRef.current ||
      !configRef.current
    ) {
      console.warn("⚠️ 播放组件未就绪");
      return;
    }

    const processQueue = () => {
      if (!isPlayingRef.current) {
        console.log("⏸️ 停止播放循环");
        return;
      }

      while (audioBufferQueueRef.current.length > 0) {
        const audioData = audioBufferQueueRef.current.shift()!;
        const audioContext = audioContextRef.current!;
        const config = configRef.current!;

        try {
          const audioBuffer = audioContext.createBuffer(
            config.channels,
            audioData.length,
            config.sampleRate,
          );

          audioBuffer.getChannelData(0).set(audioData);

          const source = audioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(gainNodeRef.current!);

          const currentTime = audioContext.currentTime;
          const scheduleTime = Math.max(nextPlayTimeRef.current, currentTime);

          source.start(scheduleTime);
          nextPlayTimeRef.current = scheduleTime + audioBuffer.duration;

          const latencyMs = (nextPlayTimeRef.current - currentTime) * 1000;
          setLatency(latencyMs);
          setBufferSize(audioBufferQueueRef.current.length);
        } catch (error) {
          console.error("❌ 播放音频失败:", error);
        }
      }

      if (isPlayingRef.current) {
        requestAnimationFrame(processQueue);
      }
    };

    processQueue();
  };

  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = newVolume;
    }
  };

  const togglePlayback = async () => {
    if (isPlayingRef.current) {
      isPlayingRef.current = false;
      setIsPlaying(false);
      audioBufferQueueRef.current = [];
      nextPlayTimeRef.current = audioContextRef.current?.currentTime || 0;
    } else {
      await startPlayback();
    }
  };

  const testAudio = () => {
    if (!audioContextRef.current || !gainNodeRef.current) return;

    const duration = 0.5;
    const frequency = 440;
    const audioContext = audioContextRef.current;
    const sampleRate = audioContext.sampleRate;
    const numSamples = sampleRate * duration;

    const audioBuffer = audioContext.createBuffer(1, numSamples, sampleRate);
    const channelData = audioBuffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      channelData[i] =
        Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.3;
    }

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gainNodeRef.current);
    source.start();
  };

  const clearAsrResults = () => {
    setAsrResults([]);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 py-8 px-4">
      <div className="max-w-4xl mx-auto space-y-8">
        <h1 className="text-4xl font-bold text-center text-white mb-8 drop-shadow-lg">
          🎤 实时音频播放器 & ASR 测试
        </h1>

        <div className="bg-white/10 backdrop-blur-lg rounded-2xl shadow-2xl p-8 space-y-6 border border-white/20">
          {/* --- 连接、播放、测试控制 --- */}
          <div className="flex gap-4">
            <button
              onClick={connect}
              disabled={isConnected}
              className="flex-1 bg-green-500 hover:bg-green-600 disabled:bg-gray-500 text-white font-bold py-3 px-6 rounded-xl transition"
            >
              {isConnected ? "✅ 已连接" : "🔌 连接服务器"}
            </button>
            <button
              onClick={disconnect}
              disabled={!isConnected}
              className="flex-1 bg-red-500 hover:bg-red-600 disabled:bg-gray-500 text-white font-bold py-3 px-6 rounded-xl transition"
            >
              ❌ 断开连接
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={togglePlayback}
              disabled={!isConnected}
              className="bg-blue-500 hover:bg-blue-600 disabled:bg-gray-500 text-white font-bold py-3 px-6 rounded-xl transition"
            >
              {isPlaying ? "⏸️ 暂停播放" : "▶️ 开始播放"}
            </button>
            <button
              onClick={testAudio}
              disabled={!audioContextRef.current}
              className="bg-yellow-500 hover:bg-yellow-600 disabled:bg-gray-500 text-white font-bold py-3 px-6 rounded-xl transition"
            >
              🔔 测试音频
            </button>
          </div>

          {/* --- ASR 实时识别结果 --- */}
          <div className="bg-white/5 rounded-xl p-6 border border-white/10">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-white font-semibold text-lg">
                🗣️ 实时 ASR 识别结果
              </h3>
              <button
                onClick={clearAsrResults}
                disabled={asrResults.length === 0}
                className="bg-gray-600 hover:bg-gray-700 disabled:bg-gray-800 text-white px-4 py-2 rounded-lg text-sm transition"
              >
                清空结果
              </button>
            </div>
            {asrResults.length === 0 ? (
              <div className="text-gray-400 text-center py-4">
                等待 ASR 结果... (确保 ESP32 发送音频)
              </div>
            ) : (
              <div
                ref={asrContainerRef}
                className="space-y-2 max-h-48 overflow-y-auto scroll-smooth"
              >
                {asrResults.map((result, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded-lg ${
                      result.isEnd
                        ? "bg-green-500/20 border border-green-500/30 text-green-300"
                        : "bg-blue-500/20 border border-blue-500/30 text-blue-300"
                    }`}
                  >
                    <div className="font-mono text-sm">{result.text}</div>
                    <div className="text-xs opacity-70 mt-1">
                      {result.isEnd ? "句子结束" : "部分结果"} •{" "}
                      {new Date(result.timestamp).toLocaleTimeString()} •{" "}
                      {result.clientId || "未知客户端"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* --- 状态显示 --- */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatusBox
              label="连接状态"
              value={isConnected ? "在线" : "离线"}
              color={isConnected ? "text-green-400" : "text-red-400"}
            />
            <StatusBox
              label="播放状态"
              value={isPlaying ? "播放中" : "已暂停"}
              color={isPlaying ? "text-blue-400" : "text-gray-400"}
            />
            <StatusBox
              label="缓冲队列"
              value={`${bufferSize} 块`}
              color="text-yellow-400"
            />
            <StatusBox
              label="延迟"
              value={`${latency.toFixed(0)} ms`}
              color="text-purple-400"
            />
          </div>

          {/* --- 数据统计 --- */}
          <div className="bg-white/5 rounded-xl p-6 border border-white/10">
            <h3 className="text-white font-semibold text-lg mb-3">
              📊 数据统计
            </h3>
            <div className="space-y-2 text-gray-300">
              <Stat
                label="已接收数据"
                value={`${(bytesReceived / 1024).toFixed(2)} KB`}
              />
              {configRef.current && (
                <>
                  <Stat
                    label="采样率"
                    value={`${configRef.current.sampleRate} Hz`}
                  />
                  <Stat
                    label="声道数"
                    value={`${configRef.current.channels}`}
                  />
                  <Stat
                    label="位深"
                    value={`${configRef.current.bitDepth} bit`}
                  />
                </>
              )}
              <Stat label="ASR 结果数" value={`${asrResults.length}`} />
            </div>
          </div>

          {/* --- 使用说明 --- */}
          <div className="bg-blue-500/10 rounded-xl p-6 border border-blue-500/30">
            <h3 className="text-white font-semibold text-lg mb-3">
              💡 使用说明
            </h3>
            <ul className="text-gray-300 space-y-2 text-sm">
              <li>• 点击"连接服务器"建立 WebSocket 连接</li>
              <li>• 点击"测试音频"按钮验证音频输出是否正常</li>
              <li>• ESP32 开始发送音频后，播放器会自动播放 + 实时识别</li>
              <li>• 绿色为句子结束结果，蓝色为中间部分</li>
              <li>• 如果 AudioContext 被挂起，点击"开始播放"激活</li>
              <li>• 使用滑块调节音量；"清空结果"可重置 ASR 显示</li>
              <li>• 缓冲队列建议保持在 2~5 块之间</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ✅ 提取的 UI 小组件
function StatusBox({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-white/5 rounded-xl p-4 text-center border border-white/10">
      <div className="text-gray-300 text-sm mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span>{label}:</span>
      <span className="font-mono text-blue-400">{value}</span>
    </div>
  );
}
