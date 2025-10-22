"use client";

import { useState, useRef, useEffect } from "react";

interface LogEntry {
  timestamp: string;
  message: string;
  isError: boolean;
}

export default function WebSocketTestTool() {
  const [server, setServer] = useState("127.0.0.1");
  const [port, setPort] = useState("3000");
  const [status, setStatus] = useState<{
    message: string;
    isSuccess: boolean;
  } | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [bytesSent, setBytesSent] = useState(0);
  const [bytesReceived, setBytesReceived] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const addLog = (message: string, isError = false) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { timestamp, message, isError }]);
  };

  const updateStatus = (message: string, isSuccess: boolean) => {
    setStatus({ message, isSuccess });
  };

  const handleConnect = () => {
    if (!server.trim() || !port) {
      updateStatus("请输入服务器地址和端口号", false);
      return;
    }

    const url = `ws://${server}:${port}/api/audio`;
    addLog(`尝试连接到 WebSocket: ${url}`);

    if (wsRef.current) {
      wsRef.current.close();
    }

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        addLog(`✅ 连接成功！ReadyState: ${ws.readyState}`);
        updateStatus("连接成功", true);
        setIsConnected(true);
      };

      ws.onerror = (error) => {
        addLog(`❌ WebSocket 错误: ${error}`, true);
        updateStatus("连接错误", false);
        setIsConnected(false);
      };

      ws.onclose = (event) => {
        addLog(
          `🔌 连接关闭: Code ${event.code}, Reason: ${event.reason || "无"}`,
        );
        updateStatus("连接已关闭", false);
        setIsConnected(false);
      };

      ws.onmessage = (event) => {
        const size = event.data.size || event.data.length || 0;
        setBytesReceived((prev) => prev + size);
        addLog(`📩 收到消息: ${size} bytes (总计: ${bytesReceived + size})`);
      };
    } catch (error: any) {
      addLog(`❌ 创建 WebSocket 失败: ${error.message}`, true);
      updateStatus("连接失败: " + error.message, false);
    }
  };

  const handleDisconnect = () => {
    if (wsRef.current) {
      wsRef.current.close();
      addLog("主动断开连接");
    }
  };

  const sendTestChunk = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog("❌ 未连接，无法发送 chunk", true);
      return;
    }

    const chunkSize = 3200;
    const fakeChunk = new Uint8Array(chunkSize);

    for (let i = 0; i < chunkSize; i++) {
      fakeChunk[i] = Math.floor(Math.random() * 256);
    }

    try {
      wsRef.current.send(fakeChunk.buffer);
      setBytesSent((prev) => prev + chunkSize);
      addLog(
        `📤 发送测试 chunk: ${chunkSize} bytes (总计: ${bytesSent + chunkSize})`,
      );
    } catch (error: any) {
      addLog(`❌ 发送失败: ${error.message}`, true);
    }
  };

  const sendContinuousAudio = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog("❌ 未连接，无法开始连续发送", true);
      return;
    }

    addLog("🔄 开始连续发送音频（模拟 ESP32 流）...");
    let count = 0;
    const maxChunks = 100;

    const interval = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        clearInterval(interval);
        addLog("⏹️ 连续发送已停止（连接关闭）");
        return;
      }

      if (count >= maxChunks) {
        clearInterval(interval);
        addLog(
          `✅ 连续发送完成：${maxChunks} chunks (${maxChunks * 3200} bytes)`,
        );
        return;
      }

      const chunkSize = 3200;
      const fakeChunk = new Uint8Array(chunkSize);
      for (let i = 0; i < chunkSize; i++) {
        fakeChunk[i] = Math.floor(Math.random() * 256);
      }

      try {
        wsRef.current.send(fakeChunk.buffer);
        setBytesSent((prev) => prev + chunkSize);
        count++;

        if (count % 10 === 0) {
          addLog(`📤 已发送 ${count}/${maxChunks} chunks`);
        }
      } catch (error: any) {
        clearInterval(interval);
        addLog(`❌ 发送失败: ${error.message}`, true);
      }
    }, 100);
  };

  const clearLogs = () => {
    setLogs([]);
    setBytesSent(0);
    setBytesReceived(0);
    addLog("日志已清空");
  };

  return (
    <div className="min-h-screen bg-gray-100 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-center text-gray-800 mb-6">
          🎤 WebSocket 音频流测试工具
        </h1>

        <div className="bg-white rounded-lg shadow-lg p-6 space-y-4">
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block font-semibold mb-2">服务器地址:</label>
                <input
                  type="text"
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  placeholder="例如: 192.168.1.2"
                  className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold mb-2">端口号:</label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="例如: 3000"
                  min="1"
                  max="65535"
                  className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={handleConnect}
                disabled={isConnected}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition"
              >
                {isConnected ? "已连接" : "连接"}
              </button>

              <button
                onClick={handleDisconnect}
                disabled={!isConnected}
                className="bg-red-600 hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition"
              >
                断开连接
              </button>
            </div>
          </div>

          {status && (
            <div
              className={`p-4 rounded font-semibold ${
                status.isSuccess
                  ? "bg-green-100 text-green-800 border border-green-300"
                  : "bg-red-100 text-red-800 border border-red-300"
              }`}
            >
              {status.message}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded border border-gray-300">
            <div>
              <div className="text-sm text-gray-600">已发送数据</div>
              <div className="text-2xl font-bold text-blue-600">
                {(bytesSent / 1024).toFixed(2)} KB
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-600">已接收数据</div>
              <div className="text-2xl font-bold text-green-600">
                {(bytesReceived / 1024).toFixed(2)} KB
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              onClick={sendTestChunk}
              disabled={!isConnected}
              className="bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition"
            >
              📤 发送单个 Chunk
            </button>

            <button
              onClick={sendContinuousAudio}
              disabled={!isConnected}
              className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition"
            >
              🔄 发送连续音频流
            </button>

            <button
              onClick={clearLogs}
              className="bg-gray-600 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded transition"
            >
              🗑️ 清空日志
            </button>
          </div>

          <div>
            <h2 className="font-semibold text-lg mb-2">连接日志:</h2>
            <div className="h-80 overflow-y-auto border border-gray-300 rounded p-4 bg-gray-50 font-mono text-sm space-y-1">
              {logs.length === 0 && (
                <div className="text-gray-400">等待日志...</div>
              )}
              {logs.map((log, index) => (
                <div
                  key={index}
                  className={log.isError ? "text-red-600" : "text-gray-700"}
                >
                  <span className="text-gray-500">[{log.timestamp}]</span>{" "}
                  {log.message}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>

          <div className="text-sm text-gray-600 bg-blue-50 p-4 rounded border border-blue-200">
            <h3 className="font-semibold mb-2">💡 使用说明：</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>输入服务器 IP 和端口（例如：192.168.1.2:3000）</li>
              <li>点击"连接"建立 WebSocket 连接</li>
              <li>"发送单个 Chunk" 模拟发送一次 3.2KB 音频数据</li>
              <li>
                "发送连续音频流" 模拟 ESP32 发送 10 秒音频（100 个 chunk）
              </li>
              <li>服务器收到 60 秒音频后会自动保存为 WAV 文件</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
