export const STORAGE_PREFIX = "zhixu.v1.";

export interface StorageLike {
  getItem(key: string): string | null;
}

export interface StoredValueReader<T> {
  value: T;
  preserveRaw: boolean;
}

export function readStoredValue<T>(
  storage: StorageLike,
  key: string,
  fallback: T,
  validate: (value: unknown) => value is T,
): StoredValueReader<T> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_PREFIX + key);
  } catch {
    // 存储被禁用（隐私模式、企业策略等）时按“没有记录”处理，不能让整个 App 初始化崩溃。
    return { value: fallback, preserveRaw: false };
  }
  if (raw === null) return { value: fallback, preserveRaw: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed)
      ? { value: parsed, preserveRaw: false }
      : { value: fallback, preserveRaw: true };
  } catch {
    return { value: fallback, preserveRaw: true };
  }
}
