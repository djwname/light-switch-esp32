import { createRequire } from "module";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AudioConfig {
  sampleRate: number;
  channels: number;
  bitDepth: 16 | 24 | 32;
}

/**
 * 保存音频数据为 WAV 文件
 * @param clientId 客户端标识
 * @param buffer 音频数据缓冲区
 * @param config 音频配置
 * @param outputDir 输出目录（可选，默认为 public/audio）
 * @returns 保存的文件路径
 */
export function saveAudioFile(
  clientId: string,
  buffer: Buffer,
  config: AudioConfig,
  outputDir?: string,
): string | null {
  const { WaveFile } = require("wavefile");

  // 验证缓冲区长度
  if (buffer.length % 2 !== 0) {
    console.error(
      `[Audio Save] Invalid buffer length: ${buffer.length} (must be even for 16-bit)`,
    );
    return null;
  }

  if (buffer.length === 0) {
    console.error(`[Audio Save] Buffer is empty, skipping save`);
    return null;
  }

  try {
    // 生成时间戳文件名
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);

    // 确定输出目录
    const audioDir =
      outputDir ||
      path.join(path.dirname(path.dirname(__dirname)), "public", "audio");

    // 确保目录存在
    if (!existsSync(audioDir)) {
      mkdirSync(audioDir, { recursive: true });
      console.log(`[Audio Save] Created directory: ${audioDir}`);
    }

    const fileName = `audio_${clientId}_${timestamp}.wav`;
    const filePath = path.join(audioDir, fileName);

    // 将 Buffer 转换为 Int16Array
    const samples = new Int16Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 2,
    );

    // 创建 WAV 文件
    const wav = new WaveFile();
    wav.fromScratch(
      config.channels,
      config.sampleRate,
      config.bitDepth.toString(),
      samples,
    );

    // 写入文件
    writeFileSync(filePath, wav.toBuffer());

    const fileSizeKB = (buffer.length / 1024).toFixed(2);
    const durationSeconds = (
      buffer.length /
      (config.sampleRate * config.channels * (config.bitDepth / 8))
    ).toFixed(2);

    console.log(
      `[Audio Save] ✅ Saved: ${fileName}\n` +
        `  Size: ${fileSizeKB} KB\n` +
        `  Duration: ${durationSeconds}s\n` +
        `  Sample Rate: ${config.sampleRate} Hz\n` +
        `  Channels: ${config.channels}\n` +
        `  Bit Depth: ${config.bitDepth}-bit`,
    );

    return filePath;
  } catch (error) {
    console.error(`[Audio Save] ❌ Failed to save audio:`, error);
    return null;
  }
}

/**
 * 验证音频缓冲区
 * @param buffer 音频数据缓冲区
 * @param config 音频配置
 * @returns 验证是否通过
 */
export function validateAudioBuffer(
  buffer: Buffer,
  config: AudioConfig,
): boolean {
  if (buffer.length === 0) {
    console.warn("[Audio Validate] Buffer is empty");
    return false;
  }

  if (buffer.length % 2 !== 0) {
    console.warn(
      "[Audio Validate] Buffer length must be even for 16-bit audio",
    );
    return false;
  }

  const bytesPerSample = config.channels * (config.bitDepth / 8);
  if (buffer.length % bytesPerSample !== 0) {
    console.warn(
      `[Audio Validate] Buffer length (${buffer.length}) is not a multiple of bytes per sample (${bytesPerSample})`,
    );
    return false;
  }

  return true;
}

/**
 * 计算音频时长（秒）
 * @param bufferLength 缓冲区长度（字节）
 * @param config 音频配置
 * @returns 音频时长（秒）
 */
export function calculateDuration(
  bufferLength: number,
  config: AudioConfig,
): number {
  const bytesPerSample = config.channels * (config.bitDepth / 8);
  return bufferLength / (config.sampleRate * bytesPerSample);
}
