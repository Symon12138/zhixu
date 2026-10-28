import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { readServerCredentials, requiresModelSetup } from "../src/App";
import type { ProviderSettings } from "../src/types";
import type { Fetcher } from "../src/lib/cloudSync";

/*
 * App.tsx 直接 import 了 CSS，Node 测试无法直接加载；用 esbuild 打包成临时 ESM
 * （CSS 置空）后取凭据读取与发送守卫做纯函数测试。
 */
let app: {
  readServerCredentials: typeof readServerCredentials;
  requiresModelSetup: typeof requiresModelSetup;
};

test.before(async () => {
  const outfile = join(process.cwd(), `.app-credential-read-${process.pid}.mjs`);
  try {
    await build({
      entryPoints: ["src/App.tsx"],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      external: ["react", "react-dom", "react-dom/*", "lucide-react"],
      loader: {
        ".css": "empty",
        ".woff": "empty",
        ".woff2": "empty",
        ".ttf": "empty",
      },
      logLevel: "silent",
    });
    // 构建产物路径在运行时才确定，静态 import 无法引用。
    app = (await import(
      `${pathToFileURL(outfile).href}?v=${Date.now()}`
    )) as unknown as typeof app;
  } finally {
    await rm(outfile, { force: true });
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAVED: ProviderSettings = {
  provider: "gemini",
  apiKey: "AIza-saved-secret",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
};

test("凭据 GET 网络失败时保持未知，BYOK 请求仍会发出", async () => {
  const networkError: Fetcher = async () => {
    throw new TypeError("fetch failed");
  };
  const result = await app.readServerCredentials(networkError, "user-a");
  assert.deepEqual(result, { state: "unknown" });

  // App 把非 missing 一律视为“服务端可能已有配置”；此时不得打开设置面板。
  const serverCredentialsMayExist = result.state !== "missing";
  assert.equal(
    app.requiresModelSetup({
      canUsePersonalKeys: true,
      hasLocalApiKey: false,
      serverCredentialsMayExist,
      serverConfigured: false,
    }),
    false,
    "网络失败时应让 BYOK 请求发出，由服务端用已保存凭据处理",
  );
});

test("凭据明确为空或 404 时才提示先配置", async () => {
  const empty: Fetcher = async () => json({ settings: null, updatedAt: 0 });
  assert.deepEqual(await app.readServerCredentials(empty, "user-a"), { state: "missing" });

  const notFound: Fetcher = async () => json({ error: "not found" }, 404);
  assert.deepEqual(await app.readServerCredentials(notFound, "user-a"), { state: "missing" });

  assert.equal(
    app.requiresModelSetup({
      canUsePersonalKeys: true,
      hasLocalApiKey: false,
      serverCredentialsMayExist: false,
      serverConfigured: false,
    }),
    true,
  );
});

test("凭据读取成功时使用服务端配置；5xx 仍保持未知", async () => {
  const present: Fetcher = async () => json({ settings: SAVED, updatedAt: 1 });
  assert.deepEqual(await app.readServerCredentials(present, "user-a"), {
    state: "present",
    settings: SAVED,
  });

  const unavailable: Fetcher = async () => json({ error: "database down" }, 503);
  assert.deepEqual(await app.readServerCredentials(unavailable, "user-a"), {
    state: "unknown",
  });
});

test("App 使用统一的凭据读取结果和模型配置守卫", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /readServerCredentials\(fetcher, authUser\.id\)/);
  assert.match(source, /result\.state === "unknown"[\s\S]{0,200}setServerCredentialsMayExist\(true\)/);
  assert.match(source, /const ready = canUsePersonalKeys[\s\S]{0,120}serverCredentialsMayExist/);
  assert.equal((source.match(/needsModelConfiguration\(chosen\)/g) ?? []).length, 4);
});
