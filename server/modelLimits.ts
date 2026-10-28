/**
 * 模型调用限额。必须在请求时读取环境变量：服务端静态导入发生在 dotenv 加载之前，
 * 模块级常量会漏掉 .env 中的生产配置。
 */
const DEFAULT_MODEL_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 8_192;

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** 单次模型请求上限；最长仍受整轮 150 秒时限约束。 */
export function getModelCallTimeoutMs(): number {
  return envInteger("AI_MODEL_CALL_TIMEOUT_MS", DEFAULT_MODEL_CALL_TIMEOUT_MS, 10_000, 120_000);
}

/** 公开教学输出是短 JSON，限制生成量可避免无界输出拖死整轮。 */
export function getModelMaxOutputTokens(): number {
  return envInteger("AI_MAX_OUTPUT_TOKENS", DEFAULT_MODEL_MAX_OUTPUT_TOKENS, 512, 8_192);
}

/** 只输出耗时与调用目的，不记录提示、回答或密钥。 */
export function modelTimingEnabled(): boolean {
  return process.env.AI_DEBUG_TIMING?.trim().toLowerCase() === "true";
}
