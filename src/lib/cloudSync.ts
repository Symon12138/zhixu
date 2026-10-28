import type { AuthResult, AuthUser, CloudWorkspace, StudyBackup } from "../types";
import { createBackup, mergeBackup, parseBackup, resolveSettingsUpdatedAt } from "./backup";

/**
 * 云端同步客户端：所有请求同源携带 Cookie；写请求带 X-Zhixu-Request，
 * 供服务端来源/主机校验。除按来源保存的时钟校准外不持有状态，
 * 便于测试注入 fetcher。
 */

export type Fetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export const REQUEST_HEADER = "X-Zhixu-Request";

/* ── 服务端时钟校准 ───────────────────────────────────────────── */

/** 按来源保存偏移；浏览器 localStorage 本身按 origin 隔离，键里再带 origin 便于测试和排查。 */
export const CLOCK_OFFSET_STORAGE_PREFIX = "zhixu.v1.clock-offset.";

/**
 * 时钟偏移的合理上限：校准值就是 `serverTime - Date.now()`，设备时钟可能因
 * 电池耗尽/长期未联网错数月甚至一年（回归用例覆盖 ±365 天），故取两年；
 * 再大只可能是被篡改或损坏的持久化值。放任它会让本机时间戳整体前移、
 * 压过云端真实更新并污染云端时间戳。
 */
export const MAX_CLOCK_OFFSET_MS = 2 * 365 * 24 * 60 * 60 * 1000;

function isValidClockOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_CLOCK_OFFSET_MS
  );
}

const clockOffsets = new Map<string, number>();

/** 同源键：浏览器按 origin 区分；测试/非浏览器环境使用固定的 default。 */
function clockOrigin(input?: string): string {
  try {
    const base =
      typeof location !== "undefined" && location.origin ? location.origin : undefined;
    return new URL(input ?? "/", base).origin;
  } catch {
    try {
      if (typeof location !== "undefined" && location.origin) return location.origin;
    } catch {
      /* 非浏览器环境 */
    }
    return "default";
  }
}

function clockStorageKey(origin: string): string {
  return `${CLOCK_OFFSET_STORAGE_PREFIX}${origin}`;
}

/**
 * 读取指定来源的时钟偏移（serverTime - Date.now()）。
 * 未校准、存储不可用或数据损坏时返回 0，调用方自然回退到本地时钟。
 */
export function getClockOffset(origin = clockOrigin()): number {
  const cached = clockOffsets.get(origin);
  if (cached !== undefined) return cached;
  try {
    if (typeof localStorage === "undefined") return 0;
    const key = clockStorageKey(origin);
    const raw = localStorage.getItem(key);
    if (!raw) return 0;
    const parsed: unknown = JSON.parse(raw);
    const offset =
      typeof parsed === "object" && parsed !== null && "offset" in parsed
        ? parsed.offset
        : undefined;
    if (isValidClockOffset(offset)) {
      clockOffsets.set(origin, offset);
      return offset;
    }
    // 越界的持久化值若参与换算，会把本机所有时间戳推到未来并污染云端；
    // 回退 0 并清掉，避免后续读取继续命中同一个坏值。
    localStorage.removeItem(key);
    return 0;
  } catch {
    return 0;
  }
}

/**
 * 用工作区响应里的 serverTime 校准本机时钟；每次响应都会更新。
 * serverTime 非法时忽略并返回 null，绝不阻断正常同步。
 */
export function calibrateClock(
  serverTime: unknown,
  origin = clockOrigin(),
): number | null {
  if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) return null;
  const now = Date.now();
  const offset = serverTime - now;
  // 荒谬的 serverTime（被篡改或数值溢出）会整体平移本机时间戳，使陈旧快照
  // 压过云端真实更新；这种校准值不落盘也不进内存，保留原有校准。
  if (!isValidClockOffset(offset)) return null;
  clockOffsets.set(origin, offset);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        clockStorageKey(origin),
        JSON.stringify({ offset, serverTime, at: now }),
      );
    }
  } catch {
    /* 隐私模式/配额不足时保留内存校准即可，不阻断同步。 */
  }
  return offset;
}

/** 校准后的当前时间；未校准或校准失败时等价于 Date.now()。 */
export function calibratedNow(origin = clockOrigin()): number {
  return Date.now() + getClockOffset(origin);
}

/** 测试辅助：清除指定来源或全部来源的时钟校准。 */
export function resetClockCalibration(origin?: string): void {
  if (origin !== undefined) {
    clockOffsets.delete(origin);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(clockStorageKey(origin));
      }
    } catch {
      /* 忽略存储不可用 */
    }
    return;
  }
  clockOffsets.clear();
  try {
    if (typeof localStorage === "undefined") return;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(CLOCK_OFFSET_STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* 忽略存储不可用 */
  }
}

function readServerTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 统一的 API 错误：status 是 HTTP 状态，code 是服务端错误码，retryAfter 来自 Retry-After 头。 */
export class CloudSyncError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  /** 服务端 429 给出的额度重置时间（毫秒时间戳）。 */
  readonly resetAt?: number;

  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfter?: number,
    resetAt?: number,
  ) {
    super(message);
    this.name = "CloudSyncError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.resetAt = resetAt;
  }
}

function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  // HTTP-date 形式：换算成剩余秒数。
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function readRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/** 工作区响应；serverTime 是可选的兼容字段，旧服务端没有时只跳过校准。 */
export type CloudWorkspaceResponse = CloudWorkspace & { serverTime?: number };

/** 认证响应；serverTime 用于首次登录即校准本机时钟。 */
export type AuthResultWithClock = AuthResult & { serverTime?: number };

/** 从错误响应中提取服务端给出的中文说明与错误码，绝不臆造。 */
async function toError(response: Response, fallback: string): Promise<CloudSyncError> {
  let message = "";
  let code: string | undefined;
  let resetAt: number | undefined;
  const value: unknown = await response.json().catch(() => undefined);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if ("error" in value && typeof value.error === "string" && value.error.trim()) {
      message = value.error.trim();
    }
    if ("code" in value && typeof value.code === "string" && value.code) {
      code = value.code;
    }
    if ("resetAt" in value && typeof value.resetAt === "number" && Number.isFinite(value.resetAt)) {
      resetAt = value.resetAt;
    }
  }
  if (!message) {
    if (response.status === 401) message = "登录状态已失效，请重新登录。";
    else if (response.status === 403) message = "请求被服务器拒绝，请刷新页面或重新登录。";
    else if (response.status === 409) message = "云端数据刚被其他设备更新，请稍后重试。";
    else if (response.status === 429) message = "操作太频繁或今日额度已用完，请稍后再试。";
    else message = fallback;
  }
  return new CloudSyncError(
    message,
    response.status,
    code,
    parseRetryAfter(response),
    resetAt,
  );
}

async function requestJson<T>(
  fetcher: Fetcher,
  path: string,
  init: RequestInit = {},
  fallbackError = "请求失败，请检查网络后重试。",
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD";
  let response: Response;
  try {
    response = await fetcher(path, {
      ...init,
      // 始终同源携带会话 Cookie；公开版依赖它识别登录态。
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(init.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(isWrite ? { [REQUEST_HEADER]: "1" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    if (cause instanceof CloudSyncError) throw cause;
    throw new CloudSyncError(
      cause instanceof Error
        ? `网络连接失败：${cause.message}`
        : "网络连接失败，请稍后重试。",
      0,
    );
  }
  if (!response.ok) throw await toError(response, fallbackError);
  // 退出、删除账户等服务端可能返回 204 / 空正文；这不算解析失败。
  if (response.status === 204 || response.status === 205) return undefined as T;
  const text = await response.text().catch(() => "");
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CloudSyncError(
      "服务端返回了无法解析的数据，请稍后重试。",
      response.status,
      "invalid_json",
    );
  }
}

/* ── 响应校验 ─────────────────────────────────────────────────── */

/** 校验 AuthUser：字段必须齐全且类型正确，坏数据不能当作已登录状态。 */
function readAuthUser(value: unknown): AuthUser | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("id" in value) || typeof value.id !== "string" || !value.id.trim()) return null;
  if (!("email" in value) || typeof value.email !== "string" || !value.email.trim()) {
    return null;
  }
  if (
    !("createdAt" in value) ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return null;
  }
  const email = value.email.trim();
  const name =
    "name" in value && typeof value.name === "string" && value.name.trim()
      ? value.name
      : email.split("@")[0] || email;
  return { id: value.id, email, name, createdAt: value.createdAt };
}

/**
 * 云端 data 必须通过 parseBackup 的完整校验（结构、版本、ID、密钥、引用关系）。
 * 绝不把形状可疑的备份直接并入本地或再上传。
 */
function parseCloudBackup(value: unknown, what: string): StudyBackup {
  try {
    return parseBackup(JSON.stringify(value));
  } catch (error) {
    const detail = error instanceof Error && error.message ? `：${error.message}` : "";
    throw new CloudSyncError(
      `云端${what}未通过校验，已停止同步以保护本机数据${detail}`,
      0,
      "invalid_cloud_data",
    );
  }
}

/** 校验 AuthResult；data 允许为 null（新账号还没有云端数据）。 */
function assertAuthResult(value: unknown): AuthResultWithClock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CloudSyncError("登录响应格式不正确，请重新登录。", 0, "invalid_auth_response");
  }
  const user = "user" in value ? readAuthUser(value.user) : null;
  if (!user) {
    throw new CloudSyncError("登录响应缺少有效的账户信息，请重新登录。", 0, "invalid_auth_response");
  }
  const revision = "revision" in value ? readRevision(value.revision) : null;
  if (revision === null) {
    throw new CloudSyncError("登录响应缺少有效的云端版本号，请重新登录。", 0, "invalid_auth_response");
  }
  const rawData = "data" in value ? value.data : null;
  const data = rawData === null || rawData === undefined
    ? null
    : parseCloudBackup(rawData, "学习数据");
  const recoveryCode =
    "recoveryCode" in value &&
    typeof value.recoveryCode === "string" &&
    value.recoveryCode.trim()
      ? value.recoveryCode.trim()
      : undefined;
  const serverTime = "serverTime" in value ? readServerTime(value.serverTime) : null;
  if (serverTime !== null) calibrateClock(serverTime, clockOrigin("/api/auth"));
  return {
    user,
    revision,
    data,
    ...(recoveryCode ? { recoveryCode } : {}),
    ...(serverTime === null ? {} : { serverTime }),
  };
}

/** 校验 CloudWorkspace；data 允许为 null（云端为空）。 */
function assertWorkspace(value: unknown, origin = clockOrigin()): CloudWorkspaceResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CloudSyncError("云端工作区数据不完整，请刷新后重试。", 0, "invalid_workspace");
  }
  const revision = "revision" in value ? readRevision(value.revision) : null;
  if (revision === null) {
    throw new CloudSyncError("云端工作区缺少有效的版本号，请刷新后重试。", 0, "invalid_workspace");
  }
  const rawData = "data" in value ? value.data : null;
  const data = rawData === null || rawData === undefined
    ? null
    : parseCloudBackup(rawData, "学习数据");
  const serverTime = "serverTime" in value ? readServerTime(value.serverTime) : null;
  if (serverTime !== null) calibrateClock(serverTime, origin);
  return { revision, data, ...(serverTime === null ? {} : { serverTime }) };
}

/* ── 认证 ─────────────────────────────────────────────────────── */

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RecoverInput {
  email: string;
  recoveryCode: string;
  password: string;
}

async function authRequest(
  fetcher: Fetcher,
  path: string,
  input: unknown,
  fallback: string,
): Promise<AuthResultWithClock> {
  const value = await requestJson<unknown>(
    fetcher,
    path,
    { method: "POST", body: JSON.stringify(input) },
    fallback,
  );
  return assertAuthResult(value);
}

export function register(
  fetcher: Fetcher,
  input: RegisterInput,
): Promise<AuthResultWithClock> {
  return authRequest(fetcher, "/api/auth/register", input, "注册失败，请稍后重试。");
}

export function login(
  fetcher: Fetcher,
  input: LoginInput,
): Promise<AuthResultWithClock> {
  return authRequest(fetcher, "/api/auth/login", input, "登录失败，请稍后重试。");
}

export function recover(
  fetcher: Fetcher,
  input: RecoverInput,
): Promise<AuthResultWithClock> {
  return authRequest(fetcher, "/api/auth/recover", input, "账户恢复失败，请稍后重试。");
}

export async function rotateRecoveryCode(
  fetcher: Fetcher,
  password: string,
): Promise<string> {
  const value = await requestJson<unknown>(
    fetcher,
    "/api/auth/recovery-code",
    { method: "POST", body: JSON.stringify({ password }) },
    "生成新的恢复码失败，请稍后重试。",
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("recoveryCode" in value) ||
    typeof value.recoveryCode !== "string" ||
    !value.recoveryCode.trim()
  ) {
    throw new CloudSyncError("服务端没有返回新的恢复码，请重试。", 0);
  }
  return value.recoveryCode.trim();
}

export async function me(fetcher: Fetcher): Promise<AuthUser> {
  const value = await requestJson<unknown>(
    fetcher,
    "/api/auth/me",
    {},
    "登录状态校验失败。",
  );
  // 服务端两种常见封装都接受，但内容必须真的是 AuthUser。
  let candidate: unknown = value;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "user" in value
  ) {
    candidate = value.user;
  }
  const user = readAuthUser(candidate);
  if (!user) {
    throw new CloudSyncError("登录状态数据不完整，请重新登录。", 0, "invalid_auth_response");
  }
  return user;
}

export function logout(fetcher: Fetcher): Promise<void> {
  return requestJson<unknown>(
    fetcher,
    "/api/auth/logout",
    { method: "POST", body: JSON.stringify({}) },
    "退出失败，请稍后重试。",
  ).then(() => undefined);
}

export function logoutAll(fetcher: Fetcher): Promise<void> {
  return requestJson<unknown>(
    fetcher,
    "/api/auth/logout-all",
    { method: "POST", body: JSON.stringify({}) },
    "退出全部设备失败，请稍后重试。",
  ).then(() => undefined);
}

export function deleteAccount(
  fetcher: Fetcher,
  password: string,
): Promise<void> {
  return requestJson<unknown>(
    fetcher,
    "/api/account",
    { method: "DELETE", body: JSON.stringify({ password }) },
    "删除账户失败，请稍后重试。",
  ).then(() => undefined);
}

/* ── 工作区 ───────────────────────────────────────────────────── */

function accountHeader(expectedUserId?: string): Record<string, string> {
  return expectedUserId ? { "X-Zhixu-User": expectedUserId } : {};
}

export function getWorkspace(
  fetcher: Fetcher,
  expectedUserId?: string,
): Promise<CloudWorkspaceResponse> {
  return requestJson<unknown>(
    fetcher,
    "/api/workspace",
    { headers: accountHeader(expectedUserId) },
    "云端学习数据读取失败，请稍后重试。",
  ).then((value) => assertWorkspace(value, clockOrigin("/api/workspace")));
}

export function putWorkspace(
  fetcher: Fetcher,
  workspace: CloudWorkspace,
  expectedUserId?: string,
): Promise<CloudWorkspaceResponse> {
  const body = JSON.stringify(workspace);
  // 服务端上限 20 MB；超限时本地直接拒绝，避免传完再被 413 拒绝。
  const bytes = new Blob([body]).size;
  if (bytes > 20 * 1024 * 1024) {
    return Promise.reject(
      new CloudSyncError(
        `云端学习数据约 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过 20 MB 上限，本次未上传。请导出备份并清理过大的会话或资料后重试。`,
        413,
        "backup_too_large",
      ),
    );
  }
  return requestJson<unknown>(
    fetcher,
    "/api/workspace",
    {
      method: "PUT",
      body,
      headers: accountHeader(expectedUserId),
    },
    "云端学习数据保存失败，请稍后重试。",
  ).then((value) => assertWorkspace(value, clockOrigin("/api/workspace")));
}

/** 删除云端同一笔记并推进 revision，避免后台并集同步把刚删除内容复活。 */
export function deleteCloudNote(
  fetcher: Fetcher,
  noteId: string,
  expectedUserId?: string,
): Promise<CloudWorkspaceResponse> {
  return requestJson<unknown>(
    fetcher,
    "/api/workspace/note-delete",
    {
      method: "POST",
      body: JSON.stringify({ noteId }),
      headers: accountHeader(expectedUserId),
    },
    "云端笔记删除失败，本地未执行删除。",
  ).then((value) => assertWorkspace(value, clockOrigin("/api/workspace")));
}

/* ── 纯合并逻辑 ───────────────────────────────────────────────── */

export interface MergeOutcome {
  /**
   * 合并结果。syncWorkspace 发现云端内容已等价（忽略 exportedAt）时不写库，
   * 此处直接回传云端当前备份（exportedAt 保持原值），供调用方判定“无变化”。
   */
  backup: StudyBackup;
  /** 双方新增（对方独有）条目的数量，用于提示。 */
  fromCloud: { sessions: number; notes: number; reviews: number; diagnostics: number };
  toCloud: { sessions: number; notes: number };
}

/** 本地学习数据快照（不含密钥）：云同步与合并的最小输入。 */
export interface LocalWorkspaceData {
  sessions: StudyBackup["sessions"];
  notes: StudyBackup["notes"];
  reviews: StudyBackup["reviews"];
  diagnostics: StudyBackup["diagnostics"];
  activity: string[];
  deletedNoteIds?: string[];
  settingsUpdatedAt?: number;
}

export interface MergeClockOptions {
  /**
   * 覆盖最近一次服务端校准的偏移（serverTime - Date.now()）。
   * 不传时使用当前来源已持久化的校准值；从未校准则按 0 回退本地时钟。
   */
  clockOffset?: number;
  /**
   * 本地快照是否已经按服务端基准写入。App 的本地写入使用 calibratedNow，
   * 状态本身就是服务端基准，传 true 可避免再次叠加时钟偏移；
   * 旧版本遗留的设备时钟快照保持默认 false，合并前会被换算到服务端基准。
   */
  localClockCalibrated?: boolean;
}

/**
 * 把本地学习数据的时间戳从设备时钟换算到服务端基准：只调整参与 LWW
 * 判断的 updatedAt / evaluatedAt / settingsUpdatedAt，不改动消息时间、
 * dueAt 等业务时间。本地时钟偏快 1 小时时，offset 为 -1 小时，
 * 旧快照不会伪装成未来更新。
 *
 * App 合并云端数据前也复用它来迁移旧版本按设备时钟写入的本地状态。
 */
export function shiftLocalWorkspaceClock(
  local: LocalWorkspaceData,
  offset: number,
): LocalWorkspaceData {
  if (offset === 0) return local;
  return {
    ...local,
    sessions: local.sessions.map((session) => ({
      ...session,
      updatedAt: session.updatedAt + offset,
      ...(session.diagnostic === undefined
        ? {}
        : {
            diagnostic: {
              ...session.diagnostic,
              ...(session.diagnostic.evaluatedAt === undefined
                ? {}
                : { evaluatedAt: session.diagnostic.evaluatedAt + offset }),
            },
          }),
      ...(session.reviews === undefined
        ? {}
        : {
            reviews: session.reviews.map((item) => ({
              ...item,
              ...(item.updatedAt === undefined
                ? {}
                : { updatedAt: item.updatedAt + offset }),
            })),
          }),
    })),
    notes: local.notes.map((note) => ({
      ...note,
      ...(note.updatedAt === undefined ? {} : { updatedAt: note.updatedAt + offset }),
    })),
    reviews: local.reviews.map((item) => ({
      ...item,
      ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt + offset }),
    })),
    diagnostics: local.diagnostics.map((profile) => ({
      ...profile,
      ...(profile.evaluatedAt === undefined
        ? {}
        : { evaluatedAt: profile.evaluatedAt + offset }),
    })),
    ...(local.settingsUpdatedAt === undefined
      ? {}
      : {
          settingsUpdatedAt:
            local.settingsUpdatedAt > 0
              ? local.settingsUpdatedAt + offset
              : local.settingsUpdatedAt,
        }),
  };
}

/**
 * 把本地学习数据与云端备份合并：复用 mergeBackup 的方向性合并——
 * 会话按 ID+时间戳双向保留消息增量；笔记按 updatedAt、复习按
 * updatedAt/attempts/dueAt、诊断按 submitted/evaluatedAt 选择较新版本；
 * 双方独有条目都保留，旧副本不得覆盖新进度。
 * 本地先生成备份再合并，保证本地与云端双方数据都不丢。
 * 笔记墓碑取双方并集并过滤笔记；设置按 settingsUpdatedAt 取较新者
 * （本地从未带版本时不压过旧云端设置，云端更新时才覆盖并上传云端时间戳），
 * 本地内存密钥从不进入备份。
 * 合并前按服务端时钟校准本地时间戳，避免错误设备时钟取得不应有的“更新”地位。
 */
export function mergeLocalWithCloud(
  local: LocalWorkspaceData,
  settingsWithoutSecrets: StudyBackup["settingsWithoutSecrets"],
  cloud: StudyBackup | null,
  options: MergeClockOptions = {},
): MergeOutcome {
  const clockOffset = options.clockOffset ?? getClockOffset();
  const adjustedLocal = options.localClockCalibrated
    ? local
    : shiftLocalWorkspaceClock(local, clockOffset);
  const localBackup = createBackup({
    sessions: adjustedLocal.sessions,
    notes: adjustedLocal.notes,
    reviews: adjustedLocal.reviews,
    diagnostics: adjustedLocal.diagnostics,
    settingsWithoutSecrets,
    activity: adjustedLocal.activity,
    deletedNoteIds: adjustedLocal.deletedNoteIds,
    settingsUpdatedAt: adjustedLocal.settingsUpdatedAt,
  });
  if (!cloud) {
    const tombstoned = new Set(localBackup.deletedNoteIds ?? []);
    const notes = localBackup.notes.filter((note) => !tombstoned.has(note.id));
    return {
      // 云端为空也要先应用本地墓碑：墓碑和同 ID 笔记绝不能一起上传。
      backup: { ...localBackup, notes },
      fromCloud: { sessions: 0, notes: 0, reviews: 0, diagnostics: 0 },
      toCloud: {
        sessions: adjustedLocal.sessions.length,
        notes: notes.length,
      },
    };
  }
  // 方向一：以本地为当前，把云端并进来 → 得到"双方都有"的集合。
  const localSettingsAt = resolveSettingsUpdatedAt(adjustedLocal.settingsUpdatedAt);
  const cloudMerged = mergeBackup(
    {
      sessions: adjustedLocal.sessions,
      notes: adjustedLocal.notes,
      reviews: adjustedLocal.reviews,
      diagnostics: adjustedLocal.diagnostics,
      activity: adjustedLocal.activity,
      deletedNoteIds: adjustedLocal.deletedNoteIds,
      // 未带版本的本地设置只代表旧数据，不参与“较新者”比较；
      // 让 mergeBackup 采用云端设置，保持老账号首次登录的设置迁移行为。
      ...(localSettingsAt > 0
        ? { settingsWithoutSecrets: localBackup.settingsWithoutSecrets }
        : {}),
      settingsUpdatedAt: adjustedLocal.settingsUpdatedAt,
    },
    cloud,
  );
  // 统计本地上传给云端的新增条目：本地独有（云端没有同 ID）的会话与笔记。
  const cloudSessionIds = new Set(cloud.sessions.map((session) => session.id));
  const cloudNoteIds = new Set(cloud.notes.map((note) => note.id));
  const tombstonedNoteIds = new Set(cloudMerged.deletedNoteIds);
  return {
    backup: {
      ...localBackup,
      sessions: cloudMerged.sessions,
      notes: cloudMerged.notes,
      reviews: cloudMerged.reviews,
      diagnostics: cloudMerged.diagnostics,
      activity: cloudMerged.activity,
      deletedNoteIds: cloudMerged.deletedNoteIds,
      // 云端设置版本更新时采用云端设置；本地更新时保留本地设置与时间戳。
      settingsWithoutSecrets: cloudMerged.settingsWithoutSecrets,
      settingsUpdatedAt: cloudMerged.settingsUpdatedAt,
      exportedAt: Date.now() + clockOffset,
    },
    fromCloud: {
      sessions: cloudMerged.imported.sessions,
      notes: cloudMerged.imported.notes,
      reviews: cloudMerged.imported.reviews,
      diagnostics: cloudMerged.imported.diagnostics,
    },
    toCloud: {
      sessions: adjustedLocal.sessions.filter((s) => !cloudSessionIds.has(s.id)).length,
      notes: adjustedLocal.notes.filter(
        (note) => !cloudNoteIds.has(note.id) && !tombstonedNoteIds.has(note.id),
      ).length,
    },
  };
}

/* ── 带乐观并发控制的上传 ─────────────────────────────────────── */

export interface SyncWorkspaceInput {
  /** 当前本地学习数据快照。 */
  local: LocalWorkspaceData;
  /** 本地非敏感模型设置（apiKey 之外的 ProviderSettings 字段）。 */
  settingsWithoutSecrets: StudyBackup["settingsWithoutSecrets"];
  /** 最近一次已知的云端工作区（revision + data）。 */
  workspace: CloudWorkspace;
  /** 构造 StudyBackup 的时间戳，默认使用校准后的当前时间。 */
  now?: () => number;
  /** 当前标签页认为已登录的账户；服务端会与 Cookie 会话比对。 */
  expectedUserId?: string;
  /** 覆盖最近校准的时钟偏移（serverTime - Date.now()），主要用于测试。 */
  clockOffset?: number;
  /** 本地快照是否已按服务端基准写入（见 MergeClockOptions.localClockCalibrated）。 */
  localClockCalibrated?: boolean;
}

export interface SyncWorkspaceResult {
  workspace: CloudWorkspaceResponse;
  outcome: MergeOutcome;
  /** 是否因 revision 冲突重新读取过云端（此时 outcome 含其他设备的数据）。 */
  refreshed: boolean;
}

/**
 * 内容等价比较：
 * - 忽略只表示上传时间的 exportedAt；
 * - 缺失的墓碑列表与空列表语义相同，并用排序后的集合比较；
 * - 缺失的 settingsUpdatedAt 与 0 语义相同（旧备份没有版本）；
 * - 会话合并会把缺失的可选 reviews 规范成空数组，这两者语义相同；
 * - 任何非空复习变化仍会出现在比较结果中。
 */
function snapshotContent(backup: StudyBackup): string {
  const settings = backup.settingsWithoutSecrets;
  return JSON.stringify({
    format: backup.format,
    version: backup.version,
    // 字段顺序固定，避免旧客户端写入顺序不同被误判成内容差异。
    sessions: backup.sessions.map((session) => {
      if (!session.reviews || session.reviews.length > 0) return session;
      const { reviews: _empty, ...rest } = session;
      return rest;
    }),
    notes: backup.notes,
    reviews: backup.reviews,
    diagnostics: backup.diagnostics,
    settingsWithoutSecrets: {
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      ...(settings.searchProvider === undefined
        ? {}
        : { searchProvider: settings.searchProvider }),
      ...(settings.structuredOutput === undefined
        ? {}
        : { structuredOutput: settings.structuredOutput }),
      ...(settings.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: settings.thinkingLevel }),
    },
    activity: backup.activity,
    deletedNoteIds: [...new Set(backup.deletedNoteIds ?? [])].sort(),
    settingsUpdatedAt: resolveSettingsUpdatedAt(backup.settingsUpdatedAt),
    exportedAt: 0,
  });
}

function buildOutcome(
  input: SyncWorkspaceInput,
  cloud: StudyBackup | null,
  clockOffset: number,
): MergeOutcome {
  // 没有显式注入时钟时用校准后的服务端时间；校准不可用时 offset 为 0。
  const now = input.now ?? (() => Date.now() + clockOffset);
  const outcome = mergeLocalWithCloud(
    input.local,
    input.settingsWithoutSecrets,
    cloud,
    { clockOffset, localClockCalibrated: input.localClockCalibrated },
  );
  return {
    ...outcome,
    backup: { ...outcome.backup, exportedAt: now() },
  };
}

/**
 * 上传合并结果，409 冲突时重取云端、重新合并、再试一次。
 * 两次都冲突则抛出最后一次的 CloudSyncError（不覆盖云端，等用户重试）；
 * 401/429 等错误原样抛出，由调用方决定登录态/限流提示。
 * 云端内容与合并结果等价（忽略 exportedAt）时不写库：outcome.backup 回传
 * 云端当前备份，调用方按 JSON 比对可据此判定“无变化”，不会重复应用。
 */
export async function syncWorkspace(
  fetcher: Fetcher,
  input: SyncWorkspaceInput,
): Promise<SyncWorkspaceResult> {
  let workspace = input.workspace;
  // 调用方通常已通过 getWorkspace/putWorkspace 校准；若它显式带着 serverTime
  // （例如刚读取但尚未经过 assertWorkspace 的调用方），同步开始前再校准一次。
  const workspaceServerTime =
    "serverTime" in workspace
      ? readServerTime((workspace as CloudWorkspaceResponse).serverTime)
      : null;
  if (workspaceServerTime !== null) calibrateClock(workspaceServerTime);
  let clockOffset = input.clockOffset ?? getClockOffset();
  let cloud = workspace.data
    ? parseCloudBackup(workspace.data, "学习数据")
    : null;
  let outcome = buildOutcome(input, cloud, clockOffset);
  let refreshed = false;
  // 云端已与本地合并结果等价时不写库：避免每次登录、重渲染都制造 revision。
  // 只忽略 exportedAt，任何会话、笔记、证据、设置或活动差异仍会正常上传。
  // 这里必须回传云端原备份（exportedAt 也不变），不能回传带新 exportedAt 的
  // 合并结果：调用方按 JSON 比较 outcome.backup 与 workspace.data，一旦每轮
  // 都生成新时间戳，稳定状态也会被判定为“云端有更新”而反复应用云端数据。
  if (cloud && snapshotContent(outcome.backup) === snapshotContent(cloud)) {
    return {
      workspace,
      outcome: { ...outcome, backup: cloud },
      refreshed: false,
    };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = await putWorkspace(fetcher, {
        revision: workspace.revision,
        data: outcome.backup,
      }, input.expectedUserId);
      return { workspace: next, outcome, refreshed };
    } catch (error) {
      if (!(error instanceof CloudSyncError) || error.status !== 409) throw error;
      // 409 也可能是服务端墓碑拒绝旧快照（code=note_tombstoned）：
      // 同样重取云端、重新合并（墓碑会过滤掉已删笔记）后再试一次。
      // 这是最后一次尝试：不再重取云端，直接上报冲突，两份数据都不覆盖。
      if (attempt === 1) {
        throw new CloudSyncError(
          error.message ||
            "云端数据刚被其他设备更新，合并后仍无法保存。请稍后重试，两份数据都不会丢失。",
          409,
          error.code ?? "revision_conflict",
          error.retryAfter,
          error.resetAt,
        );
      }
      // 重取最新 revision 与数据；服务端 409 只带 revision 等元信息，不携带 data。
      workspace = await getWorkspace(fetcher, input.expectedUserId);
      // getWorkspace 会按响应里的 serverTime 更新校准，重试前取最新偏移。
      clockOffset = input.clockOffset ?? getClockOffset();
      cloud = workspace.data
        ? parseCloudBackup(workspace.data, "学习数据")
        : null;
      outcome = buildOutcome(input, cloud, clockOffset);
      refreshed = true;
    }
  }
  throw new CloudSyncError(
    "云端数据刚被其他设备更新，合并后仍无法保存。请稍后重试，两份数据都不会丢失。",
    409,
    "revision_conflict",
  );
}
