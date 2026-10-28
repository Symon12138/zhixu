#!/usr/bin/env -S node --import tsx
/**
 * 知序生产环境预检脚本。
 *
 * 检查目标：确保公网部署没有关闭认证、没有退回 HTTP、没有禁用会话 Cookie 安全属性、
 * 数据目录可写，且至少配置了一个模型密钥来源。
 *
 * 用法：npm run check:production
 * 直接入口会自动加载项目根目录的 .env（已存在的进程环境变量优先，不会覆盖）。
 * 环境校验复用 server/config.ts 的生产规则，避免预检与启动各有一套标准。
 *
 * 退出码：0 = 通过（警告会完整打印，需人工确认）；1 = 存在阻断错误。
 */
import { constants, accessSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  loadAiRuntimeConfig,
  loadConfig,
  loadWebConfig,
  type AppConfig,
  type Env,
  type WebConfig,
} from "../server/config";
import { isDirectExecution } from "./cli";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface CheckResult {
  ok: boolean;
  severity: "error" | "warning";
  message: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkDataDirWritable(dir: string): { ok: boolean; message: string } {
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
      return { ok: true, message: `数据目录 ${dir} 原先不存在，已创建。` };
    } catch (err) {
      return { ok: false, message: `数据目录 ${dir} 无法创建：${messageOf(err)}` };
    }
  }
  try {
    accessSync(dir, constants.W_OK);
    return { ok: true, message: `数据目录 ${dir} 存在且可写。` };
  } catch {
    return { ok: false, message: `数据目录 ${dir} 不可写，进程无法保存 SQLite 数据。` };
  }
}

function checkDataDir(env: Env, config: AppConfig | undefined): CheckResult {
  const dir = config?.dataDir || env.ZHIXU_DATA_DIR?.trim() || "./.data";
  const result = checkDataDirWritable(dir);
  return {
    ok: result.ok,
    severity: result.ok ? "warning" : "error",
    message: result.message,
  };
}

function checkTrustProxy(env: Env): CheckResult {
  const value = env.ZHIXU_TRUST_PROXY?.trim().toLowerCase();
  if (value === "true" || value === "1") {
    return { ok: true, severity: "warning", message: "已信任一层反向代理的 X-Forwarded-For。" };
  }
  return {
    ok: false,
    severity: "error",
    message: "ZHIXU_TRUST_PROXY 未设为 true。TLS 必须由反向代理终止；不信任代理会让所有用户共用同一个 IP 限流桶，攻击者可锁死全站登录。",
  };
}

function checkCookieSecure(env: Env, config: AppConfig | undefined): CheckResult {
  if (config) {
    if (!config.cookieSecure) {
      return { ok: false, severity: "error", message: "Cookie 未启用 Secure 属性，公网部署不允许。请删除 ZHIXU_COOKIE_SECURE=false。" };
    }
    return { ok: true, severity: "warning", message: "会话 Cookie 使用 Secure 属性。" };
  }
  const value = env.ZHIXU_COOKIE_SECURE?.trim().toLowerCase();
  if (value === "false" || value === "0") {
    return { ok: false, severity: "error", message: "ZHIXU_COOKIE_SECURE=false 会禁用 Cookie 的 Secure 属性，公网部署不允许。请删除该设置或设为 true。" };
  }
  return { ok: true, severity: "warning", message: "Cookie Secure 设置随生产配置校验一起检查。" };
}

function checkInsecureLocal(env: Env, config: AppConfig | undefined): CheckResult {
  const enabled =
    config?.allowInsecureLocal === true ||
    env.ZHIXU_ALLOW_INSECURE_LOCAL?.trim().toLowerCase() === "true" ||
    env.ZHIXU_ALLOW_INSECURE_LOCAL?.trim() === "1";
  if (enabled) {
    return { ok: false, severity: "error", message: "ZHIXU_ALLOW_INSECURE_LOCAL=true 只允许本机测试，禁止用于公网部署。" };
  }
  return { ok: true, severity: "warning", message: "未启用不安全的本机测试逃生阀。" };
}

function checkModelKeys(env: Env, config: AppConfig | undefined): CheckResult[] {
  const results: CheckResult[] = [];
  const hasGemini = Boolean(env.GEMINI_API_KEY?.trim());
  const hasOpenAI = Boolean(env.OPENAI_API_KEY?.trim());
  const names = [hasGemini && "Gemini", hasOpenAI && "OpenAI"].filter(Boolean);
  const allowByok =
    config?.allowByok === true ||
    (!config &&
      (env.ZHIXU_ALLOW_BYOK?.trim().toLowerCase() === "true" ||
        env.ZHIXU_ALLOW_BYOK?.trim() === "1"));
  if (names.length) {
    results.push({
      ok: true,
      severity: "warning",
      message: `已配置服务端模型密钥（${names.join(" + ")}）。`,
    });
  } else if (allowByok) {
    results.push({
      ok: true,
      severity: "warning",
      message: "未配置服务端模型密钥，但 ZHIXU_ALLOW_BYOK=true 允许用户自带密钥（BYOK）。请确认这是有意选择：每位用户需自行填入 API 密钥。",
    });
  } else {
    results.push({
      ok: false,
      severity: "error",
      message: "未配置任何模型密钥（GEMINI_API_KEY / OPENAI_API_KEY），且 ZHIXU_ALLOW_BYOK 未开启。部署后登录用户将无法调用 AI。",
    });
  }

  if (allowByok) {
    const origins = config?.byokAllowedOrigins ?? [];
    results.push(
      origins.length
        ? {
            ok: true,
            severity: "warning",
            message: `BYOK 额外允许的模型端点：${origins.join("、")}；官方 OpenAI 端点（https://api.openai.com）始终允许。`,
          }
        : {
            ok: true,
            severity: "warning",
            message: "已开启 BYOK 但 ZHIXU_BYOK_BASEURLS 为空：用户只能使用官方 Gemini / OpenAI 端点。如需第三方 OpenAI 兼容端点，请把其 origin（如 https://api.example.com）加入该白名单。",
          },
    );
  }
  return results;
}

function checkWebPolicy(env: Env): CheckResult[] {
  let web: WebConfig;
  try {
    web = loadWebConfig(env);
  } catch (error) {
    return [
      {
        ok: false,
        severity: "error",
        message: `网页配置无效：${messageOf(error)}`,
      },
    ];
  }
  const results: CheckResult[] = [];
  if (!web.fetchEnabled) {
    results.push({ ok: true, severity: "warning", message: "指定网页来源核验未开启。" });
  } else if (!web.allowedHosts.length) {
    results.push({
      ok: true,
      severity: "warning",
      message: "网页来源核验已开启但未配置 ZHIXU_WEB_ALLOWED_HOSTS；服务端会允许任意公开 HTTPS 域名，建议公网部署限制允许域名。",
    });
  } else {
    results.push({
      ok: true,
      severity: "warning",
      message: `网页来源核验已开启，允许域名：${web.allowedHosts.join("、")}。逐字命中只代表引文存在，不代表事实正确。`,
    });
  }
  if (web.searchEnabled) {
    results.push({
      ok: true,
      severity: "warning",
      message: `自动联网搜索已开启，供应商顺序：${web.searchOrder.join(" → ")}。关闭的供应商或缺少密钥时会被跳过。`,
    });
  }
  return results;
}

function checkAiPolicy(env: Env): CheckResult[] {
  try {
    const ai = loadAiRuntimeConfig(env);
    return [
      {
        ok: true,
        severity: "warning",
        message: `模型请求超时 ${ai.modelCallTimeoutMs}ms，输出上限 ${ai.maxOutputTokens} token，思考等级 ${ai.thinkingLevel}，评审思考等级 ${ai.reviewThinkingLevel}。`,
      },
    ];
  } catch (error) {
    return [
      {
        ok: false,
        severity: "error",
        message: `模型配置无效：${messageOf(error)}`,
      },
    ];
  }
}

/**
 * 运行全部预检。传入独立 env 对象即可在不修改全局 process.env 的情况下测试；
 * 生产配置是否合法只由 loadConfig(true, env) 判定。
 */
export function runProductionChecks(env: Env = process.env): {
  exitCode: 0 | 1;
  results: CheckResult[];
} {
  const results: CheckResult[] = [];
  let config: AppConfig | undefined;
  try {
    config = loadConfig(true, env);
    results.push({
      ok: true,
      severity: "warning",
      message: `生产配置校验通过：公网来源 ${config.publicOrigin}，Cookie Secure=${config.cookieSecure}，审计保留 ${config.auditRetentionDays} 天，日用量保留 ${config.usageRetentionDays} 天。`,
    });
  } catch (error) {
    results.push({
      ok: false,
      severity: "error",
      message: `生产配置无效：${messageOf(error)}`,
    });
  }

  results.push(checkDataDir(env, config));
  results.push(checkTrustProxy(env));
  results.push(checkCookieSecure(env, config));
  results.push(checkInsecureLocal(env, config));
  results.push(...checkModelKeys(env, config));
  results.push(...checkWebPolicy(env));
  results.push(...checkAiPolicy(env));

  const hasError = results.some((result) => !result.ok);
  return { exitCode: hasError ? 1 : 0, results };
}

async function main(): Promise<number> {
  // 只在真实入口加载项目根目录的 .env：测试导入本模块时不会污染 process.env，
  // 也避免从其他工作目录直接执行时读到错误的 .env。
  loadDotenv({ path: path.join(SCRIPT_ROOT, ".env"), override: false });
  const { exitCode, results } = runProductionChecks();
  console.log("知序生产环境预检\n================");
  for (const result of results) {
    const mark = result.ok ? "✔" : "✘";
    console.log(`${mark} ${result.message}`);
  }
  if (exitCode === 1) {
    console.error("\n存在必须修复的问题，禁止部署。");
  } else {
    console.log("\n预检通过（含提醒项，请确认上方警告后部署）。");
  }
  return exitCode;
}

if (isDirectExecution(import.meta.url)) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`预检脚本异常：${messageOf(error)}`);
      process.exitCode = 1;
    },
  );
}
