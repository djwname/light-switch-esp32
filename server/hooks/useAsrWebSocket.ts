"use client";

import { useState, useRef, useCallback, useTransition, use } from "react"; // 添加 use
import { useOptimistic } from "react"; // React 19
import { v4 as uuidv4 } from "uuid";
import { AsrMessage } from "@/lib/types";

const API_KEY = process.env.NEXT_PUBLIC_DASHSCOPE_API_KEY || "";
const URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 100;
const BYTES_PER_CHUNK = ((SAMPLE_RATE * CHUNK_DURATION_MS) / 1000) * 2; // 16-bit PCM

interface UseAsrWebSocketProps {
  audioFile: File | null;
}

export const useAsrWebSocket = ({ audioFile }: UseAsrWebSocketProps) => {
  const [status, setStatus] = useState<
    "idle" | "connecting" | "processing" | "done"
  >("idle");
  const [error, setError] = useState<string>("");
  const [isPending, startTransition] = useTransition(); // React 19: 自动 pending 状态
  const wsRef = useRef<WebSocket | null>(null);
  const taskIdRef = useRef<string>("");
  const audioReaderRef = useRef<FileReader | null>(null);
  const chunkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const messagePromiseRef = useRef<Promise<AsrMessage | null>>(
    Promise.resolve(null),
  ); // 用于 use()

  // 乐观更新：结果列表（立即显示部分结果）
  // TS 修复：如果错误，添加 (useOptimistic as any) 或更新 @types/react@^19.0.0
  const [optimisticResults, addOptimisticResult] = useOptimistic<string[]>(
    [],
    (state, newText: string) => [...state, newText], // 乐观添加
  );

  // Actions: 发送 run-task（async，支持乐观）
  const sendRunTask = useCallback(
    async (taskId: string) => {
      return new Promise<AsrMessage>((resolve, reject) => {
        if (!wsRef.current) reject(new Error("No WebSocket"));
        const message: AsrMessage = {
          header: { action: "run-task", task_id, streaming: "duplex" },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: "paraformer-realtime-v2",
            parameters: { format: "pcm", sample_rate: SAMPLE_RATE },
            input: {},
          },
        };
        wsRef.current?.send(JSON.stringify(message));
        console.log("已发送 run-task");
        // 乐观：立即更新状态
        addOptimisticResult(""); // 占位
        resolve(message); // 简化，实际可监听 onmessage
      });
    },
    [addOptimisticResult],
  );

  // Action: 发送 finish-task
  const sendFinishTask = useCallback(async (taskId: string) => {
    return new Promise<void>((resolve) => {
      if (!wsRef.current) return;
      const message: AsrMessage = {
        header: { action: "finish-task", task_id, streaming: "duplex" },
        payload: { input: {} },
      };
      wsRef.current.send(JSON.stringify(message));
      console.log("已发送 finish-task");
      resolve();
    });
  }, []);

  // 连接 WebSocket
  const connectWebSocket = useCallback(() => {
    if (!API_KEY) {
      setError("缺少 API Key");
      return;
    }

    setStatus("connecting");
    const ws = new WebSocket(URL, [], {
      headers: {
        Authorization: `bearer ${API_KEY}`,
        "X-DashScope-DataInspection": "enable",
      },
    });

    wsRef.current = ws;

    ws.onopen = () => {
      console.log("已连接到服务器");
      startTransition(async () => {
        await sendRunTask(taskIdRef.current); // 用 Transition 包裹
      });
    };

    // onmessage: 包装为 Promise，供 use() 消费
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as AsrMessage;
      messagePromiseRef.current = Promise.resolve(message); // 更新最新 Promise
    };

    ws.onclose = () => {
      console.log("连接已关闭");
      setStatus("idle");
    };

    ws.onerror = (error) => {
      console.error("WebSocket 错误：", error);
      setError("WebSocket 连接错误");
      setStatus("idle");
    };
  }, [startTransition, sendRunTask]);

  // 处理消息（用 use() 消费 Promise） - React 19 新特性
  const latestMessage = use(messagePromiseRef.current);
  if (latestMessage?.header.event === "task-started") {
    setStatus("processing");
    sendAudioStream();
  } else if (latestMessage?.header.event === "result-generated") {
    const sentence = latestMessage.payload?.output?.sentence;
    if (sentence) {
      addOptimisticResult(sentence.text); // 乐观更新
      if (sentence.sentence_end) {
        console.log(
          "句子结束：",
          sentence.begin_time,
          "-",
          sentence.end_time,
          "ms",
        );
        if (latestMessage.payload?.usage) {
          console.log("计费时长：", latestMessage.payload.usage.duration, "秒");
        }
      }
    }
  } else if (latestMessage?.header.event === "task-finished") {
    setStatus("done");
  } else if (latestMessage?.header.event === "task-failed") {
    setError(
      `${latestMessage.header.error_code} - ${latestMessage.header.error_message}`,
    );
    setStatus("idle");
  }

  // 发送音频流
  const sendAudioStream = useCallback(() => {
    if (!audioFile) return;

    audioReaderRef.current = new FileReader();
    let offset = 0;
    const totalSize = audioFile.size;

    const readChunk = () => {
      if (offset >= totalSize || !wsRef.current) {
        if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
        startTransition(async () => {
          await sendFinishTask(taskIdRef.current);
        });
        return;
      }

      const slice = audioFile.slice(offset, offset + BYTES_PER_CHUNK);
      audioReaderRef.current.readAsArrayBuffer(slice);

      audioReaderRef.current.onload = (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        wsRef.current?.send(buffer);
        offset += BYTES_PER_CHUNK;
      };
    };

    chunkIntervalRef.current = setInterval(readChunk, CHUNK_DURATION_MS);
    readChunk();
  }, [audioFile, sendFinishTask, startTransition]);

  useEffect(() => {
    if (!audioFile) return;

    taskIdRef.current = uuidv4().replace(/-/g, "").slice(0, 32);
    connectWebSocket();

    return () => {
      wsRef.current?.close();
      if (chunkIntervalRef.current) clearInterval(chunkIntervalRef.current);
    };
  }, [audioFile, connectWebSocket]);

  return {
    status,
    error,
    isPending, // pending 状态，用于 UI loading
    optimisticResults, // 乐观结果
  };
};
