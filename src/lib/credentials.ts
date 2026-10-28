import type { ProviderSettings } from "../types";
import type { Fetcher } from "./cloudSync";
import { REQUEST_HEADER } from "./cloudSync";

export class CredentialsError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "CredentialsError";
    this.status = status;
    this.code = code;
  }
}

async function requestError(response: Response, fallback: string): Promise<CredentialsError> {
  const value: unknown = await response.json().catch(() => undefined);
  let message = fallback;
  let code: string | undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) message = record.error;
    if (typeof record.code === "string" && record.code) code = record.code;
  }
  return new CredentialsError(message, response.status, code);
}

function isFallbackArray<T>(value: unknown, check: (item: unknown) => boolean): value is T[] {
  return Array.isArray(value) && value.every(check);
}

/** 服务端只会返回校验过的配置；客户端仍做边界检查，避免坏响应污染状态。 */
function isProviderSettings(value: unknown): value is ProviderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.provider !== "gemini" && record.provider !== "openai") return false;
  if (typeof record.apiKey !== "string" || typeof record.model !== "string" || typeof record.baseUrl !== "string") {
    return false;
  }
  if (record.searchProvider !== undefined && typeof record.searchProvider !== "string") return false;
  if (record.searchApiKey !== undefined && typeof record.searchApiKey !== "string") return false;
  if (record.structuredOutput !== undefined && typeof record.structuredOutput !== "boolean") return false;
  if (record.thinkingLevel !== undefined && !["auto", "low", "medium", "high"].includes(record.thinkingLevel as string)) {
    return false;
  }
  if (record.modelFallbacks !== undefined && !isFallbackArray(record.modelFallbacks, (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const fallback = item as Record<string, unknown>;
    return (fallback.provider === "gemini" || fallback.provider === "openai") &&
      typeof fallback.model === "string" && typeof fallback.baseUrl === "string" &&
      (fallback.apiKey === undefined || typeof fallback.apiKey === "string");
  })) return false;
  if (record.searchFallbacks !== undefined && !isFallbackArray(record.searchFallbacks, (item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const fallback = item as Record<string, unknown>;
    return typeof fallback.provider === "string" &&
      (fallback.apiKey === undefined || typeof fallback.apiKey === "string");
  })) return false;
  return true;
}

/**
 * 旧标签页可能仍认为自己是 A，但 Cookie 已被其他标签页换成 B。
 * 传 expectedUserId 时服务端会与当前 Cookie 会话比对，不一致返回
 * 409 account_mismatch；不传时保持原有按 Cookie 账户读写的兼容行为。
 */
function accountHeader(expectedUserId?: string): Record<string, string> {
  return expectedUserId ? { "X-Zhixu-User": expectedUserId } : {};
}

export async function getCredentials(
  fetcher: Fetcher,
  expectedUserId?: string,
): Promise<ProviderSettings | null> {
  const response = await fetcher("/api/credentials", {
    headers: { Accept: "application/json", ...accountHeader(expectedUserId) },
  });
  if (!response.ok) {
    throw await requestError(response, "读取个人配置失败，请稍后重试。");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CredentialsError("个人配置响应格式不正确。", 500);
  }
  const settings = (body as Record<string, unknown>).settings;
  if (settings === null) return null;
  if (!isProviderSettings(settings)) {
    throw new CredentialsError("个人配置字段不完整。", 500);
  }
  return settings;
}

/** 是否真的保存了需要服务端保管的密钥；只有非敏感偏好时无需 user_credentials 行。 */
export function hasCredentialSecrets(settings: ProviderSettings): boolean {
  return Boolean(
    settings.apiKey?.trim() ||
      settings.searchApiKey?.trim() ||
      settings.modelFallbacks?.some((item) => item.apiKey?.trim()) ||
      settings.searchFallbacks?.some((item) => item.apiKey?.trim()),
  );
}

/** 删除后清空内存中的全部个人密钥与备用配置，只保留非敏感偏好。 */
export function clearCredentialSettings(settings: ProviderSettings): ProviderSettings {
  return {
    ...settings,
    apiKey: "",
    searchApiKey: "",
    modelFallbacks: [],
    searchFallbacks: [],
  };
}

/**
 * 标记这份已清空的配置来自一次成功的服务端删除。
 * App 的保存回调随后会调用 saveCredentials；识别标记后直接跳过，避免重新创建空行。
 */
const deletedCredentialSettings = new WeakSet<ProviderSettings>();

export function markCredentialSettingsDeleted(settings: ProviderSettings): void {
  deletedCredentialSettings.add(settings);
}

export async function saveCredentials(
  fetcher: Fetcher,
  settings: ProviderSettings,
  expectedUserId?: string,
): Promise<void> {
  if (deletedCredentialSettings.has(settings)) {
    deletedCredentialSettings.delete(settings);
    return;
  }
  // 没有任何个人密钥时，服务端不需要保留凭据行；按删除处理，避免保存空配置后
  // 再次出现“已保存”状态并让删除按钮复现。
  if (!hasCredentialSecrets(settings)) {
    await deleteCredentials(fetcher, expectedUserId);
    return;
  }
  const response = await fetcher("/api/credentials", {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [REQUEST_HEADER]: "1",
      ...accountHeader(expectedUserId),
    },
    body: JSON.stringify({ settings }),
  });
  if (!response.ok) {
    throw await requestError(response, "保存个人配置失败，请稍后重试。");
  }
}

/** 清除当前账户在服务端保存的个人配置；带 expectedUserId 时拒绝跨账户删除。 */
export async function deleteCredentials(
  fetcher: Fetcher,
  expectedUserId?: string,
): Promise<void> {
  const response = await fetcher("/api/credentials", {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [REQUEST_HEADER]: "1",
      ...accountHeader(expectedUserId),
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw await requestError(response, "删除个人配置失败，请稍后重试。");
  }
}
