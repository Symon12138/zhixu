import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettings } from "../src/types";
import {
  loadSafeSettings,
  mergeImportedSettings,
  saveSafeSettings,
  stripApiKey,
} from "../src/lib/settings";
import { STORAGE_PREFIX } from "../src/lib/persistentStorage";

const SETTINGS_KEY = "zhixu.v1.provider-settings";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    dump: () => Object.fromEntries(data),
  };
}

const fallback: ProviderSettings = {
  provider: "gemini",
  apiKey: "",
  model: "gemini-2.5-flash",
  baseUrl: "https://api.openai.com/v1",
  thinkingLevel: "auto",
};

const sparseRecord: ProviderSettings = {
  provider: "openai",
  model: "  ",
  baseUrl: "",
  thinkingLevel: "extreme" as ProviderSettings["thinkingLevel"],
  apiKey: "sk-stale",
};

test("saveSafeSettings 只写非敏感字段，apiKey 绝不落盘", () => {
  const storage = memoryStorage();
  saveSafeSettings(
    { ...fallback, apiKey: "sk-user-secret", structuredOutput: false, thinkingLevel: "high" },
    storage as unknown as Storage,
  );
  const raw = storage.dump()[SETTINGS_KEY];
  assert.ok(raw);
  assert.equal(raw.includes("sk-user-secret"), false);
  assert.deepEqual(JSON.parse(raw), {
    provider: "gemini",
    model: "gemini-2.5-flash",
    baseUrl: "https://api.openai.com/v1",
    structuredOutput: false,
    thinkingLevel: "high",
  });
});

test("loadSafeSettings 恢复非敏感配置，apiKey 恒为空", () => {
  const storage = memoryStorage({
    [SETTINGS_KEY]: JSON.stringify({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://example.com/v1",
      structuredOutput: false,
      thinkingLevel: "low",
      // 存储里被夹带的密钥必须被忽略，不能恢复进内存对象。
      apiKey: "sk-stale",
    }),
  });
  const loaded = loadSafeSettings(fallback, storage);
  assert.equal(loaded.apiKey, "");
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.model, "gpt-4o");
  assert.equal(loaded.baseUrl, "https://example.com/v1");
  assert.equal(loaded.structuredOutput, false);
  assert.equal(loaded.thinkingLevel, "low");
});

test("搜索密钥不落盘，搜索供应商作为非敏感偏好保留", () => {
  const storage = memoryStorage();
  saveSafeSettings(
    {
      ...fallback,
      searchProvider: "brave",
      searchApiKey: "search-secret",
    },
    storage as unknown as Storage,
  );
  const raw = storage.dump()[SETTINGS_KEY];
  assert.equal(raw.includes("search-secret"), false);
  assert.equal(JSON.parse(raw).searchProvider, "brave");
  const loaded = loadSafeSettings(fallback, storage);
  assert.equal(loaded.searchApiKey, "");
  assert.equal(loaded.searchProvider, "brave");
});

test("loadSafeSettings 损坏或非法记录逐字段回退，apiKey 不被恢复", () => {
  const fullyBroken = ["{broken json", JSON.stringify({ provider: "claude" }), JSON.stringify("array?")];
  for (const raw of fullyBroken) {
    const storage = memoryStorage({ [SETTINGS_KEY]: raw });
    assert.deepEqual(loadSafeSettings(fallback, storage), { ...fallback, apiKey: "", searchApiKey: "" });
  }

  // 合法 provider 但空串字段：回退到 fallback 的对应字段，密钥不恢复。
  const storage = memoryStorage({ [SETTINGS_KEY]: JSON.stringify(sparseRecord) });
  const loaded = loadSafeSettings(fallback, storage);
  assert.equal(loaded.apiKey, "");
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.model, fallback.model);
  assert.equal(loaded.baseUrl, fallback.baseUrl);
  assert.equal(loaded.thinkingLevel, fallback.thinkingLevel);
});

test("loadSafeSettings 存储读取抛错时干净回退", () => {
  const throwing = {
    getItem: () => {
      throw new DOMException("denied", "SecurityError");
    },
  };
  assert.deepEqual(loadSafeSettings(fallback, throwing), { ...fallback, apiKey: "", searchApiKey: "" });
});

test("saveSafeSettings 存储写入失败时抛出，不静默丢失", () => {
  const failing = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("quota", "QuotaExceededError");
    },
  };
  assert.throws(() =>
    saveSafeSettings({ ...fallback, apiKey: "sk" }, failing as unknown as Storage),
  );
});

test("save→load 往返不丢非敏感字段，也不恢复密钥", () => {
  const storage = memoryStorage();
  saveSafeSettings(
    {
      provider: "openai",
      apiKey: "sk-roundtrip",
      model: "gpt-4o-mini",
      baseUrl: "https://relay.example.com/v1",
      structuredOutput: true,
      thinkingLevel: "medium",
    },
    storage as unknown as Storage,
  );
  const loaded = loadSafeSettings(fallback, storage);
  assert.equal(loaded.apiKey, "");
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.model, "gpt-4o-mini");
  assert.equal(loaded.baseUrl, "https://relay.example.com/v1");
  assert.equal(loaded.structuredOutput, true);
  assert.equal(loaded.thinkingLevel, "medium");
});

test("stripApiKey 输出不含 apiKey 且保持其余字段", () => {
  const stripped = stripApiKey({ ...fallback, apiKey: "sk-x", thinkingLevel: "high" });
  assert.equal("apiKey" in stripped, false);
  assert.equal(stripped.thinkingLevel, "high");
});

test("设置存储键与持久化前缀约定一致", () => {
  assert.equal(SETTINGS_KEY, `${STORAGE_PREFIX}provider-settings`);
});

test("loadSafeSettings 对非布尔 structuredOutput 逐字段回退，密钥仍不恢复", () => {
  const fallbackWithSwitch: ProviderSettings = { ...fallback, structuredOutput: true };
  for (const bad of ["yes", 1, null, {}, []]) {
    const storage = memoryStorage({
      [SETTINGS_KEY]: JSON.stringify({
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://example.com/v1",
        structuredOutput: bad,
        thinkingLevel: "low",
        apiKey: "sk-stale",
      }),
    });
    const loaded = loadSafeSettings(fallbackWithSwitch, storage);
    assert.equal(loaded.structuredOutput, true, `坏值 ${JSON.stringify(bad)} 应回退`);
    assert.equal(loaded.provider, "openai");
    assert.equal(loaded.thinkingLevel, "low");
    assert.equal(loaded.apiKey, "");
  }

  const valid = loadSafeSettings(
    { ...fallbackWithSwitch, structuredOutput: true },
    memoryStorage({
      [SETTINGS_KEY]: JSON.stringify({ structuredOutput: false }),
    }),
  );
  assert.equal(valid.structuredOutput, false, "真实布尔值不能被回退覆盖");
});

test("备份设置合并：仅同服务商同接口保留内存密钥，永不从备份恢复密钥", () => {
  const current = { ...fallback, provider: "openai" as const, apiKey: "sk-memory-only" };
  const same = mergeImportedSettings(current, { ...stripApiKey(current), model: "new-model" });
  assert.equal(same.apiKey, "sk-memory-only");
  assert.equal(same.model, "new-model");
  const changed = mergeImportedSettings(current, { ...stripApiKey(current), baseUrl: "https://other.example/v1" });
  assert.equal(changed.apiKey, "");
  const otherProvider = mergeImportedSettings(current, { ...stripApiKey(current), provider: "gemini" });
  assert.equal(otherProvider.apiKey, "");
});
