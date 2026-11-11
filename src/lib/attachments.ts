import type { AttachmentMeta, Reference } from "../types";
import { importBook } from "./bookImport";

/**
 * 附件（图片/PDF）的浏览器本地存储：
 * - 二进制字节只写 IndexedDB，按 sessionId 隔离，绝不进 localStorage / sessions JSON / 备份 / 云同步；
 * - localStorage 侧仅由 App 保存元数据清单（含在 sessions.references[].attachment 中）；
 * - 断网或刷新后缩略图仍从 IndexedDB 读取，离线可见。
 */

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

export const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|webp)$/i;
export const PDF_EXTENSION = /\.pdf$/i;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
/** 超过此大小的图片不内联 base64 进请求，只随元数据作为文本描述出现。 */
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_CHARS = 60_000;

const DB_NAME_PREFIX = "zhixu-attachments";
const DB_VERSION = 1;
const STORE = "blobs";
const connections = new Map<string, Promise<IDBDatabase>>();

function dbName(sessionId: string): string {
  return `${DB_NAME_PREFIX}-${sessionId}`;
}

function openDatabase(sessionId: string): Promise<IDBDatabase> {
  const name = dbName(sessionId);
  const existing = connections.get(name);
  if (existing) return existing;
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const tracked = promise.catch(() => {
    connections.delete(name);
    throw new Error("附件存储暂时不可用，请刷新页面后重试。");
  });
  connections.set(name, tracked);
  if (typeof indexedDB === "undefined") {
    reject(new Error("此浏览器不支持 IndexedDB，无法保存附件。"));
    return tracked;
  }
  let request: IDBOpenDBRequest;
  try {
    request = indexedDB.open(name, DB_VERSION);
  } catch (error) {
    reject(error instanceof Error ? error : new Error(String(error)));
    return tracked;
  }
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: "id" });
    }
  };
  request.onerror = () => reject(request.error ?? new Error("附件存储打开失败。"));
  request.onblocked = () => reject(new Error("附件存储被另一个标签页升级阻塞，请关闭其他知序标签页后重试。"));
  request.onsuccess = () => {
    const db = request.result;
    db.onversionchange = () => {
      db.close();
      connections.delete(name);
    };
    resolve(db);
  };
  return tracked;
}

function transaction<T>(
  sessionId: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, setResult: (value: T) => void) => void,
): Promise<T> {
  return openDatabase(sessionId).then(db => {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let tx: IDBTransaction;
    try {
      tx = db.transaction([STORE], mode);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return promise;
    }
    let result: T;
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(result);
    };
    tx.oncomplete = () => settle();
    tx.onerror = () => settle(tx.error);
    tx.onabort = () => settle(tx.error ?? new Error("附件存储事务被中止。"));
    try {
      operation(tx.objectStore(STORE), value => { result = value; });
    } catch (error) {
      settle(error);
      tx.abort();
    }
    return promise;
  });
}

/** 附件二进制的存储记录；只在 IndexedDB 内出现，不参与任何 JSON 序列化。 */
interface StoredAttachment {
  id: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** 保存附件原始字节（按 sessionId 隔离）。 */
export function saveAttachmentBytes(sessionId: string, meta: AttachmentMeta, bytes: Uint8Array): Promise<void> {
  return transaction(sessionId, "readwrite", (store, setResult) => {
    store.put({ id: meta.id, mimeType: meta.mimeType, bytes } satisfies StoredAttachment);
    setResult(undefined);
  });
}

/** 读取附件原始字节；不存在返回 undefined（会话已删除或本机未导入过）。 */
export function readAttachmentBytes(sessionId: string, id: string): Promise<Uint8Array | undefined> {
  return transaction(sessionId, "readonly", (store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const value = request.result as StoredAttachment | undefined;
      setResult(value?.bytes);
    };
  });
}

/** 删除单个附件。 */
export function deleteAttachmentBytes(sessionId: string, id: string): Promise<void> {
  return transaction(sessionId, "readwrite", (store, setResult) => {
    store.delete(id);
    setResult(undefined);
  });
}

/** 清空整个会话的附件库（会话删除或重置时调用）。 */
export function clearSessionAttachments(sessionId: string): Promise<void> {
  return transaction(sessionId, "readwrite", (store, setResult) => {
    store.clear();
    setResult(undefined);
  });
}

/** 清空本机所有附件库（账户数据被整体丢弃/删除时调用）。
 * 枚举所有 zhixu-attachments-* 开头的库并逐个删除；浏览器不支持枚举时静默跳过。 */
export function clearAllAttachments(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (typeof indexedDB === "undefined" || !indexedDB.databases) {
    resolve();
    return promise;
  }
  indexedDB
    .databases()
    .then(databases => {
      const targets = databases
        .map(database => database.name)
        .filter((name): name is string => typeof name === "string")
        .filter(name => name.startsWith("zhixu-attachments-"));
      return Promise.all(targets.map(name => {
        const done = Promise.withResolvers<void>();
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => done.resolve();
        request.onerror = () => done.resolve();
        request.onblocked = () => done.resolve();
        return done.promise;
      }));
    })
    .then(() => resolve())
    .catch(() => resolve());
  return promise;
}

/* ── 附件接收与校验（纯函数，便于测试） ─────────────────────────── */

export function classifyAttachment(file: { name: string; size: number; type?: string }): { kind: "image" | "pdf"; mimeType: string } | { error: string } {
  const name = file.name.toLowerCase();
  const extension = IMAGE_EXTENSIONS.exec(name)?.[0]?.slice(1);
  if (extension) {
    const mimeType = file.type && IMAGE_TYPES[file.type] ? file.type : `image/${extension === "jpg" ? "jpeg" : extension}`;
    return { kind: "image", mimeType };
  }
  if (PDF_EXTENSION.test(name)) return { kind: "pdf", mimeType: "application/pdf" };
  return { error: "目前支持 PNG / JPEG / WebP 图片与 PDF（含文本层）资料；请先将其他格式转换后上传。" };
}

export function checkAttachmentSize(kind: "image" | "pdf", size: number): string | undefined {
  if (kind === "image" && size > MAX_IMAGE_BYTES) return "单张图片请控制在 10 MB 内。";
  if (kind === "pdf" && size > MAX_PDF_BYTES) return "单个 PDF 请控制在 30 MB 内。";
  return undefined;
}

/** 图片字节转 dataURL；>2MB 的图片不内联，只随元数据出现。 */
export function imageInlineDataUrl(bytes: Uint8Array, mimeType: string): string | undefined {
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) return undefined;
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** PDF 抽取文本层：复用书架 bookImport 的解析逻辑，不重复实现 PDF.js 调用。 */
export async function extractPdfText(file: File): Promise<string> {
  const book = await importBook(file);
  const text = book.blocks.map(block => block.text).join("\n\n");
  if (!text.trim()) {
    throw new Error("该 PDF 无文本层（可能是扫描件），请先用书架导入或粘贴文本。");
  }
  return text;
}

/** 组装附件 Reference：元数据 + 文本（PDF 文本层；图片为空正文）。 */
export function buildAttachmentReference(
  meta: AttachmentMeta,
  text: string,
): Reference {
  return {
    name: meta.name,
    text,
    attachment: meta,
  };
}

/** 校验附件元数据（服务端/客户端共用形状检查）。 */
export function isAttachmentMeta(value: unknown): value is AttachmentMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    meta.id.length > 0 &&
    meta.id.length <= 100 &&
    typeof meta.name === "string" &&
    typeof meta.kind === "string" &&
    (meta.kind === "image" || meta.kind === "pdf") &&
    typeof meta.mimeType === "string" &&
    /^[a-z]+\/[a-z0-9.+-]+$/i.test(meta.mimeType) &&
    typeof meta.byteLength === "number" &&
    Number.isSafeInteger(meta.byteLength) &&
    meta.byteLength > 0
  );
}
