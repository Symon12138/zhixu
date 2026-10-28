import type { ServerConfig, ThinkingLevel } from "../src/types";

/** 每用户每日额度上限（按 UTC 日期）。 */
export interface QuotaLimits {
  chatPerDay: number;
  diagnosticPerDay: number;
  reviewPerDay: number;
}

/**
 * 服务端集中配置。所有环境变量只在这里读取与校验：
 * 非法值启动即失败，绝不静默回退，避免公网部署时带病运行。
 */
export interface AppConfig {
  /** 由 --production 命令行参数决定；公共模式（多用户正式版）的前提。 */
  production: boolean;
  port: number;
  host: string;
  /** SQLite 数据目录（ZHIXU_DATA_DIR，默认 .data）。 */
  dataDir: string;
  /** 公共模式：聊天/诊断/复习补讲必须登录。 */
  authRequired: boolean;
  /** 公共模式默认只允许服务端环境密钥，禁止请求内 apiKey。 */
  allowByok: boolean;
  /** Cookie 是否带 Secure；生产默认 true，仅本地测试可显式关闭。 */
  cookieSecure: boolean;
  /** 生产环境必须配置的公网来源，如 https://study.example.com。 */
  publicOrigin: string | null;
  /**
   * 是否信任一层反向代理的 X-Forwarded-For（ZHIXU_TRUST_PROXY=true）。
   * 默认 false，避免直连时伪造来源；正式部署在 127.0.0.1 反代后建议开启，
   * 否则登录限流只能看到代理地址。
   */
  trustProxy?: boolean;
  quotas: QuotaLimits;
  /** 单用户同时进行中的 AI 请求上限（单节点进程内保护）。 */
  maxConcurrentAi: number;
  /** 安全审计/日用量保留天数；0 表示不自动清理（生产模式禁止）。 */
  auditRetentionDays: number;
  usageRetentionDays: number;
  /**
   * BYOK 时额外允许的 OpenAI 兼容端点 origin；官方 OpenAI 端点始终允许，
   * 为空时只允许官方端点，第三方兼容端点必须显式加入白名单。
   */
  byokAllowedOrigins: string[];
  /** 仅供本机明示测试：允许 production 模式使用 http 与不安全 Cookie。 */
  allowInsecureLocal: boolean;
}

/** 环境变量来源；预检脚本传入独立对象，避免修改全局 process.env。 */
export type Env = NodeJS.ProcessEnv;

/** 网页抓取/搜索的启动期配置；运行期仍由 web.ts / webSearch.ts 读取同一批变量。 */
export interface WebConfig {
  fetchEnabled: boolean;
  searchEnabled: boolean;
  allowedHosts: string[];
  maxBytes: number;
  maxTextChars: number;
  timeoutMs: number;
  hourlyLimit: number;
  searchOrder: SearchVendor[];
}

/** 模型调用限额与开关；`server/modelLimits.ts` 在请求时读取同一批变量。 */
export interface AiRuntimeConfig {
  structuredOutput: boolean;
  debugTiming: boolean;
  thinkingLevel: ThinkingLevel;
  reviewThinkingLevel: ThinkingLevel;
  modelCallTimeoutMs: number;
  maxOutputTokens: number;
}

const DEV_DEFAULT_HOST = "127.0.0.1";
const DEV_DEFAULT_PORT = 3001;

const THINKING_LEVELS: readonly ThinkingLevel[] = ["auto", "low", "medium", "high"];
const SEARCH_VENDORS = [
  "you",
  "tavily",
  "brave",
  "exa",
  "firecrawl",
  "deepseek",
  "searxng",
] as const;
export type SearchVendor = (typeof SEARCH_VENDORS)[number];

function cleanEnv(name: string, env: Env): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function csvEnv(name: string, env: Env): string[] {
  return cleanEnv(name, env)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function intEnv(name: string, fallback: number, min: number, max: number, env: Env): number {
  const raw = cleanEnv(name, env);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`环境变量 ${name} 必须是 ${min} 到 ${max} 之间的整数，当前值：${raw}`);
  }
  return value;
}

/**
 * 接受 true/false/1/0 的布尔变量。用于真正以布尔语义消费的配置项；
 * 对上游只认字符串 "true" 的开关请使用 strictBoolEnv，避免 1/0 在两侧含义不同。
 */
function boolEnv(name: string, env: Env = process.env): boolean | undefined {
  const raw = cleanEnv(name, env).toLowerCase();
  if (!raw) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`环境变量 ${name} 只接受 true 或 false，当前值：${raw}`);
}

/** 只接受 true/false；用于 web 开关与只比较 "true" 的模型开关。 */
function strictBoolEnv(name: string, env: Env = process.env): boolean | undefined {
  const raw = cleanEnv(name, env).toLowerCase();
  if (!raw) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`环境变量 ${name} 只接受 true 或 false，当前值：${raw}`);
}

function thinkingLevelEnv(name: string, env: Env): ThinkingLevel {
  const raw = cleanEnv(name, env).toLowerCase();
  if (!raw) return "auto";
  if (!THINKING_LEVELS.includes(raw as ThinkingLevel)) {
    throw new Error(
      `环境变量 ${name} 必须是 ${THINKING_LEVELS.join("、")} 之一，当前值：${raw}`,
    );
  }
  return raw as ThinkingLevel;
}

/**
 * 网页允许域名只接受裸域名：协议、端口、路径、通配符和凭证都不能静默忽略，
 * 否则白名单会看起来已配置但运行期永远匹配不到。
 */
function normalizeAllowedHost(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("环境变量 ZHIXU_WEB_ALLOWED_HOSTS 不允许空条目。");
  if (/[\s/\\@:?#*]/.test(value)) {
    throw new Error(
      `环境变量 ZHIXU_WEB_ALLOWED_HOSTS 的条目必须是纯域名（不含协议、端口、路径或通配符），当前值：${value}`,
    );
  }
  if (value.includes("..") || value.startsWith(".") || value.startsWith("-")) {
    throw new Error(`环境变量 ZHIXU_WEB_ALLOWED_HOSTS 的域名不合法：${value}`);
  }
  if (/[^\x00-\x7f]/.test(value)) {
    throw new Error(
      `环境变量 ZHIXU_WEB_ALLOWED_HOSTS 只接受 ASCII 域名；国际化域名请写成 punycode（xn--）形式：${value}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    throw new Error(`环境变量 ZHIXU_WEB_ALLOWED_HOSTS 的域名不合法：${value}`);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) {
    throw new Error(`环境变量 ZHIXU_WEB_ALLOWED_HOSTS 的域名不合法：${value}`);
  }
  return hostname;
}

function searchOrderEnv(env: Env): SearchVendor[] {
  const entries = csvEnv("ZHIXU_SEARCH_ORDER", env).map((item) => item.toLowerCase());
  if (!entries.length) return [...SEARCH_VENDORS];
  for (const entry of entries) {
    if (!SEARCH_VENDORS.includes(entry as SearchVendor)) {
      throw new Error(
        `环境变量 ZHIXU_SEARCH_ORDER 包含不支持的搜索供应商：${entry}。可选值：${SEARCH_VENDORS.join("、")}`,
      );
    }
  }
  return [...new Set(entries as SearchVendor[])];
}

/**
 * 校验网页抓取/搜索配置。范围与 web.ts 的实际接受范围一致；
 * 非法值在启动时直接失败，而不是抓取/搜索请求时才静默回退默认值。
 */
export function loadWebConfig(env: Env = process.env): WebConfig {
  return {
    fetchEnabled: strictBoolEnv("ZHIXU_WEB_FETCH", env) ?? false,
    searchEnabled: strictBoolEnv("ZHIXU_WEB_SEARCH", env) ?? false,
    allowedHosts: [
      ...new Set(csvEnv("ZHIXU_WEB_ALLOWED_HOSTS", env).map(normalizeAllowedHost)),
    ],
    maxBytes: intEnv("ZHIXU_WEB_MAX_BYTES", 2 * 1024 * 1024, 64_000, 5_000_000, env),
    maxTextChars: intEnv("ZHIXU_WEB_MAX_TEXT", 60_000, 5_000, 200_000, env),
    timeoutMs: intEnv("ZHIXU_WEB_TIMEOUT_MS", 15_000, 3_000, 30_000, env),
    hourlyLimit: intEnv("ZHIXU_WEB_HOURLY_LIMIT", 30, 1, 500, env),
    searchOrder: searchOrderEnv(env),
  };
}

/**
 * 校验模型调用限额与开关。`AI_STRUCTURED_OUTPUT` / `AI_DEBUG_TIMING` 在运行期
 * 只比较字符串 "true"/"false"，因此这里也只接受这两个值，避免启动校验与请求行为不一致。
 */
export function loadAiRuntimeConfig(env: Env = process.env): AiRuntimeConfig {
  return {
    structuredOutput: strictBoolEnv("AI_STRUCTURED_OUTPUT", env) ?? true,
    debugTiming: strictBoolEnv("AI_DEBUG_TIMING", env) ?? false,
    thinkingLevel: thinkingLevelEnv("AI_THINKING_LEVEL", env),
    reviewThinkingLevel: thinkingLevelEnv("AI_REVIEW_THINKING_LEVEL", env),
    modelCallTimeoutMs: intEnv("AI_MODEL_CALL_TIMEOUT_MS", 60_000, 10_000, 120_000, env),
    maxOutputTokens: intEnv("AI_MAX_OUTPUT_TOKENS", 8_192, 512, 8_192, env),
  };
}

/**
 * 规范化公网来源：只接受纯粹的 http(s) origin，拒绝路径、查询、片段与
 * 内嵌凭证，避免 Origin/Host 白名单被 `https://a.example@b.example` 之类绕过。
 */
export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`来源不是合法的 URL：${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`来源必须以 http:// 或 https:// 开头，当前值：${raw}`);
  }
  if (url.username || url.password) {
    throw new Error("来源不允许包含用户名或密码。");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`来源只能是协议 + 域名（可带端口），不能包含路径或参数，当前值：${raw}`);
  }
  return url.origin;
}

/**
 * 加载并校验全部服务端配置。
 * - 开发默认 127.0.0.1:3001；生产可通过 ZHIXU_HOST/ZHIXU_PORT 绑定 0.0.0.0。
 * - 公共模式 = --production 或 ZHIXU_AUTH_REQUIRED=true。
 * - 生产默认 Secure Cookie；ZHIXU_COOKIE_SECURE=false 仅限本地测试。
 * - 生产必须配置 ZHIXU_PUBLIC_ORIGIN（写入可信来源/Host 白名单）。
 */
export function loadConfig(production: boolean, env: Env = process.env): AppConfig {
  const port = intEnv("ZHIXU_PORT", DEV_DEFAULT_PORT, 1, 65535, env);
  const host = cleanEnv("ZHIXU_HOST", env) || DEV_DEFAULT_HOST;
  const dataDir = cleanEnv("ZHIXU_DATA_DIR", env) || ".data";

  const authFlag = boolEnv("ZHIXU_AUTH_REQUIRED", env);
  if (production && authFlag === false) {
    throw new Error(
      "生产模式禁止 ZHIXU_AUTH_REQUIRED=false：公网服务必须要求登录。请删除该设置或设为 true。",
    );
  }
  const authRequired = production || authFlag === true;
  const byokFlag = boolEnv("ZHIXU_ALLOW_BYOK", env);
  // 公共模式默认只用服务端密钥，仅 ZHIXU_ALLOW_BYOK=true 放行浏览器密钥；
  // 本地模式保持原有行为（浏览器填写密钥），避免与仅按登录要求显示密钥输入的前端不一致。
  const allowByok = authRequired ? byokFlag === true : true;
  const allowInsecureLocal = boolEnv("ZHIXU_ALLOW_INSECURE_LOCAL", env) === true;
  const cookieFlag = boolEnv("ZHIXU_COOKIE_SECURE", env);
  const cookieSecure = cookieFlag ?? production;

  const publicOriginRaw = cleanEnv("ZHIXU_PUBLIC_ORIGIN", env);
  const publicOrigin = publicOriginRaw ? normalizeOrigin(publicOriginRaw) : null;
  if (production && !publicOrigin) {
    throw new Error(
      "生产模式必须通过 ZHIXU_PUBLIC_ORIGIN 配置公网来源（如 https://study.example.com），用于可信 Host/Origin 校验。",
    );
  }
  if (production && !allowInsecureLocal) {
    if (!publicOrigin || !publicOrigin.startsWith("https://")) {
      throw new Error("生产模式要求 ZHIXU_PUBLIC_ORIGIN 使用 https。仅本机测试可显式设置 ZHIXU_ALLOW_INSECURE_LOCAL=true。");
    }
    if (cookieSecure === false) {
      throw new Error("生产模式禁止 ZHIXU_COOKIE_SECURE=false。仅本机测试可显式设置 ZHIXU_ALLOW_INSECURE_LOCAL=true。");
    }
  }
  if (allowInsecureLocal) {
    if (!production) throw new Error("ZHIXU_ALLOW_INSECURE_LOCAL 只能在 production 本机测试中开启。");
    if (!publicOrigin) throw new Error("本机不安全测试仍需配置 ZHIXU_PUBLIC_ORIGIN。");
    const host = new URL(publicOrigin).hostname.toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
      throw new Error("ZHIXU_ALLOW_INSECURE_LOCAL 只允许 127.0.0.1、localhost 或 ::1 来源。");
    }
  }

  const byokAllowedOrigins = csvEnv("ZHIXU_BYOK_BASEURLS", env).map((item) =>
    normalizeOrigin(item),
  );

  const auditRetentionDays = intEnv("ZHIXU_AUDIT_RETENTION_DAYS", 90, 0, 3650, env);
  const usageRetentionDays = intEnv("ZHIXU_USAGE_RETENTION_DAYS", 90, 0, 3650, env);
  if (production && (auditRetentionDays === 0 || usageRetentionDays === 0)) {
    throw new Error(
      "生产模式要求审计与日用量保留天数大于 0；ZHIXU_AUDIT_RETENTION_DAYS 或 ZHIXU_USAGE_RETENTION_DAYS 为 0 会让数据无限增长。",
    );
  }

  // 启动即校验网页与模型配置；结果本身由运行期模块按同一批环境变量读取。
  loadWebConfig(env);
  loadAiRuntimeConfig(env);

  return {
    production,
    port,
    host,
    dataDir,
    authRequired,
    allowByok,
    cookieSecure,
    publicOrigin,
    trustProxy: boolEnv("ZHIXU_TRUST_PROXY", env) ?? false,
    quotas: {
      chatPerDay: intEnv("ZHIXU_QUOTA_CHAT", 40, 0, 100_000, env),
      diagnosticPerDay: intEnv("ZHIXU_QUOTA_DIAGNOSTIC", 10, 0, 100_000, env),
      reviewPerDay: intEnv("ZHIXU_QUOTA_REVIEW", 30, 0, 100_000, env),
    },
    maxConcurrentAi: intEnv("ZHIXU_MAX_CONCURRENT_AI", 2, 1, 100, env),
    auditRetentionDays,
    usageRetentionDays,
    byokAllowedOrigins: [...new Set(byokAllowedOrigins)],
    allowInsecureLocal,
  };
}

/**
 * /api/config 的认证/额度部分：configured、provider、model 由调用方用
 * resolveEnvStatus() 填充，保持唯一密钥判定来源。
 */
export function authConfig(config: AppConfig): Pick<
  ServerConfig,
  "authRequired" | "allowByok" | "quotas"
> {
  return {
    authRequired: config.authRequired,
    allowByok: config.allowByok,
    quotas: { ...config.quotas },
  };
}
