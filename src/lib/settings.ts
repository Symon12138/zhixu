import type { ProviderSettings, SearchProviderId, ThinkingLevel } from "../types";

/** 非敏感配置：只含 provider/model/baseUrl/structuredOutput/thinkingLevel/searchProvider，绝不含 apiKey。 */
export type SafeSettings = Omit<ProviderSettings, "apiKey" | "searchApiKey">;

const KEY = "zhixu.v1.provider-settings";

const PROVIDERS = ["gemini", "openai"] as const;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["auto", "low", "medium", "high"];
const SEARCH_PROVIDERS: readonly SearchProviderId[] = ["tavily", "brave", "exa", "firecrawl", "deepseek", "you"];

/**
 * 从完整 ProviderSettings 提取可持久化的非敏感部分。
 * 即使 settings 里带着 apiKey，返回值里也没有它——密钥只在内存中使用。
 */
export function stripApiKey(settings: ProviderSettings): SafeSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    structuredOutput: settings.structuredOutput,
    thinkingLevel: settings.thinkingLevel,
    ...(settings.searchProvider === undefined ? {} : { searchProvider: settings.searchProvider }),
  };
}

/** 导入的非敏感配置生效；只有同一服务商和接口才能保留本页已有的内存密钥。 */
export function mergeImportedSettings(current: ProviderSettings, imported: SafeSettings): ProviderSettings {
  const compatible = current.provider === imported.provider && current.baseUrl === imported.baseUrl;
  const searchCompatible =
    imported.searchProvider === undefined ||
    current.searchProvider === undefined ||
    imported.searchProvider === current.searchProvider;
  return {
    ...current,
    ...imported,
    apiKey: compatible ? current.apiKey : "",
    searchApiKey: searchCompatible ? current.searchApiKey : "",
  };
}

function sanitizeSafe(value: Partial<SafeSettings> | null | undefined): Partial<SafeSettings> | null {
  if (!value || value.provider !== undefined && !PROVIDERS.includes(value.provider)) return null;
  return {
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl }),
    ...(value.searchProvider === undefined || !SEARCH_PROVIDERS.includes(value.searchProvider)
      ? {}
      : { searchProvider: value.searchProvider }),
    // 开关只接受真正的布尔值；字符串等坏数据在加载时回退到 fallback。
    ...(typeof value.structuredOutput === "boolean"
      ? { structuredOutput: value.structuredOutput }
      : {}),
    ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel }),
  };
}

/**
 * 保存非敏感配置。任何情况下都不写入 apiKey；
 * 存储不可用时抛出，调用方决定是否提示（不静默吞掉用户期望的保存）。
 */
export function saveSafeSettings(settings: ProviderSettings, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(stripApiKey(settings)));
}

/**
 * 加载非敏感配置，返回完整 ProviderSettings，apiKey 恒为空串（密钥不落盘）。
 * 存储不可用、记录损坏或字段非法时逐字段回退到 fallback，apiKey 永远不从存储恢复。
 */
export function loadSafeSettings(
  fallback: ProviderSettings,
  storage: Pick<Storage, "getItem"> = localStorage,
): ProviderSettings {
  let raw: string | null = null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return { ...fallback, apiKey: "", searchApiKey: "" };
  }
  if (raw === null) return { ...fallback, apiKey: "", searchApiKey: "" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...fallback, apiKey: "", searchApiKey: "" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...fallback, apiKey: "", searchApiKey: "" };
  }
  const record = value as Record<string, unknown>;
  const safe = sanitizeSafe(record as Partial<SafeSettings>);
  if (!safe) return { ...fallback, apiKey: "", searchApiKey: "" };
  return {
    provider:
      safe.provider ?? fallback.provider,
    model:
      typeof safe.model === "string" && safe.model.trim()
        ? safe.model
        : fallback.model,
    baseUrl:
      typeof safe.baseUrl === "string" && safe.baseUrl.trim()
        ? safe.baseUrl
        : fallback.baseUrl,
    structuredOutput:
      safe.structuredOutput === undefined ? fallback.structuredOutput : safe.structuredOutput,
    thinkingLevel:
      safe.thinkingLevel !== undefined && THINKING_LEVELS.includes(safe.thinkingLevel)
        ? safe.thinkingLevel
        : fallback.thinkingLevel,
    searchProvider:
      safe.searchProvider !== undefined && SEARCH_PROVIDERS.includes(safe.searchProvider)
        ? safe.searchProvider
        : fallback.searchProvider,
    // 密钥从不持久化：加载结果里永远是空串。
    apiKey: "",
    searchApiKey: "",
  };
}
