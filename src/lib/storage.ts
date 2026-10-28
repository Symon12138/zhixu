import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Note, StudySession } from "../types";
import { normalizeDeletedNoteIds, noteUpdatedAt } from "./backup";
import { readStoredValue, STORAGE_PREFIX as prefix } from "./persistentStorage";
import { mergeSessions, mergeSessionIds } from "./sessionMerge";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 消息与复习项按 id 参与合并，校验层必须先确认元素形状：
 * null / 非对象 / 缺少字符串 id 的元素会让下游合并直接抛 TypeError。
 */
function isIdentifiedItem(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  );
}

export function isSession(value: unknown): value is StudySession {
  if (!value || typeof value !== "object") return false;
  const s = value as StudySession;
  return (
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    Array.isArray(s.messages) &&
    s.messages.every(isIdentifiedItem) &&
    Array.isArray(s.completedStages) &&
    Array.isArray(s.quiz) &&
    Array.isArray(s.flashcards) &&
    Array.isArray(s.reviewedCards) &&
    (s.reviews === undefined ||
      (Array.isArray(s.reviews) && s.reviews.every(isIdentifiedItem))) &&
    Array.isArray(s.references) &&
    Array.isArray(s.plan) &&
    typeof s.stageIndex === "number" &&
    !!s.stageAnswers &&
    !!s.quizAnswers &&
    isFiniteNumber(s.createdAt) &&
    isFiniteNumber(s.updatedAt)
  );
}

function isSessionList(value: unknown): value is StudySession[] {
  return Array.isArray(value) && value.every(isSession);
}

/** 与 Note 契约一致：sessionId 可为空串（独立/书架笔记），但字段与类型必须齐全。 */
export function isNote(value: unknown): value is Note {
  if (!value || typeof value !== "object") return false;
  const note = value as Note;
  const updatedAt = "updatedAt" in value ? value.updatedAt : undefined;
  return (
    typeof note.id === "string" &&
    note.id !== "" &&
    typeof note.sessionId === "string" &&
    typeof note.title === "string" &&
    typeof note.content === "string" &&
    isFiniteNumber(note.createdAt) &&
    (updatedAt === undefined ||
      (isFiniteNumber(updatedAt) &&
        Number.isSafeInteger(updatedAt) &&
        updatedAt >= 0))
  );
}

function isNoteList(value: unknown): value is Note[] {
  return Array.isArray(value) && value.every(isNote);
}

/** 已删除笔记墓碑的持久化键；App 写入同一键，storage 合并时读取以避免复活。 */
export const DELETED_NOTE_IDS_KEY = `${prefix}deleted-notes`;

/** 读取本机墓碑；存储不可用或数据损坏时视为没有墓碑（不阻断正常保存）。 */
function readStoredDeletedNoteIds(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(DELETED_NOTE_IDS_KEY);
    return raw ? normalizeDeletedNoteIds(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/**
 * 笔记跨标签页 / 磁盘回读时按 ID 合并：双方独有的笔记都保留。
 * - 墓碑优先：双方列表里任何已墓碑化的笔记都会被过滤，旧标签页不能复活已删笔记；
 * - 有显式 updatedAt 时只有严格更新的记录才能覆盖，旧快照不能写回旧内容；
 * - 旧数据完全没有 updatedAt 时沿用“incoming 是最近一次写入”的既有语义。
 */
export function mergeNotes(
  current: Note[],
  incoming: Note[],
  deletedNoteIds: readonly string[] | undefined = readStoredDeletedNoteIds(),
): Note[] {
  const tombstones = new Set(normalizeDeletedNoteIds(deletedNoteIds));
  const byId = new Map<string, Note>();
  for (const note of current) {
    if (!tombstones.has(note.id)) byId.set(note.id, note);
  }
  for (const note of incoming) {
    if (tombstones.has(note.id)) continue;
    const existing = byId.get(note.id);
    if (!existing) {
      byId.set(note.id, note);
      continue;
    }
    const currentAt = noteUpdatedAt(existing);
    const incomingAt = noteUpdatedAt(note);
    if (currentAt === 0 && incomingAt === 0) {
      // 旧数据没有版本：保持既有行为，最近传入的快照获胜。
      byId.set(note.id, note);
    } else if (incomingAt > currentAt) {
      byId.set(note.id, note);
    }
  }
  return [...byId.values()];
}

function isActivityList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((day) => typeof day === "string");
}

function useStoredList<T>(
  key: string,
  validate: (value: unknown) => value is T[],
  merge: (current: T[], incoming: T[]) => T[] = (_current, incoming) => incoming,
) {
  // useState 惰性初始化：localStorage 读取与 JSON.parse 只在首次挂载时执行一次，
  // 后续渲染（包括频繁的状态更新）不再重复读取。
  const [initial] = useState(() => readStoredValue(localStorage, key, [] as T[], validate));
  const [value, setValue] = useState<T[]>(initial.value);
  const preserveRaw = useRef(initial.preserveRaw);
  const [readWarning, setReadWarning] = useState(initial.preserveRaw);
  const [storageError, setStorageError] = useState(false);
  const [canPersist, setCanPersist] = useState(!initial.preserveRaw);
  // 必须保持身份稳定：App 的认证/云同步回调依赖这些 setter；若每次渲染都变，
  // 会导致登录初始化 effect 反复执行并持续上传工作区。
  const setStoredValue: Dispatch<SetStateAction<T[]>> = useCallback((next) => {
    if (preserveRaw.current && typeof window !== "undefined" && !window.confirm("检测到无法读取的本地记录。继续操作将用当前内容替换原始记录。请先导出备份；是否继续？")) return;
    preserveRaw.current = false;
    setCanPersist(true);
    setValue(next);
  }, []);
  useEffect(() => {
    if (!canPersist || preserveRaw.current) return;
    try {
      const disk = readStoredValue(localStorage, key, [] as T[], validate);
      const next = disk.preserveRaw ? value : merge(disk.value, value);
      localStorage.setItem(prefix + key, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [key, value, canPersist, merge]);
  useEffect(() => {
    function syncFromOtherTab(event: StorageEvent) {
      if (event.storageArea !== localStorage || event.key !== prefix + key)
        return;
      try {
        const next: unknown = JSON.parse(event.newValue ?? "[]");
        if (validate(next)) {
          preserveRaw.current = false;
          setCanPersist(true);
          setReadWarning(false);
          setValue((previous) => {
            const merged = merge(previous, next);
            return JSON.stringify(previous) === JSON.stringify(merged) ? previous : merged;
          });
        }
      } catch {
        /* A malformed external write must not erase the current record. */
      }
    }
    window.addEventListener("storage", syncFromOtherTab);
    return () => window.removeEventListener("storage", syncFromOtherTab);
  }, [key, validate, merge]);
  return [value, setStoredValue, storageError || readWarning] as const;
}

export function useStudyStorage() {
  const [sessions, setSessions, sessionError] = useStoredList(
    "sessions",
    isSessionList,
    mergeSessions,
  );
  const [notes, setNotes, noteError] = useStoredList("notes", isNoteList, mergeNotes);
  // 初始化时也应用墓碑：如果上次在“写墓碑”和“删笔记”之间崩溃，磁盘里可能残留
  // 已删笔记；仅靠保存时的 merge 会让它在当前标签页继续显示/被写回。
  // 同时监听墓碑键：其他标签页删除笔记后，即使笔记列表事件尚未到达，也立即过滤。
  // 本地记录损坏（noteError）时不要触发确认框覆盖原始内容，交给用户先导出备份。
  useEffect(() => {
    if (noteError) return;
    const applyStoredTombstones = () => {
      const tombstones = new Set(readStoredDeletedNoteIds());
      if (tombstones.size === 0) return;
      setNotes((previous) => {
        const next = previous.filter((note) => !tombstones.has(note.id));
        return next.length === previous.length ? previous : next;
      });
    };
    applyStoredTombstones();
    function syncDeletedNoteIds(event: StorageEvent) {
      if (event.storageArea !== localStorage || event.key !== DELETED_NOTE_IDS_KEY) {
        return;
      }
      applyStoredTombstones();
    }
    window.addEventListener("storage", syncDeletedNoteIds);
    return () => window.removeEventListener("storage", syncDeletedNoteIds);
  }, [setNotes, noteError]);
  const [activity, setActivity, activityError] = useStoredList(
    "activity",
    isActivityList,
    mergeSessionIds,
  );
  const storageError = sessionError || noteError || activityError;
  function recordActivity() {
    const date = new Date();
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    setActivity((previous) =>
      previous.includes(day) ? previous : [...previous, day],
    );
  }
  return {
    sessions,
    setSessions,
    notes,
    setNotes,
    activity,
    setActivity,
    recordActivity,
    storageError,
  };
}

export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
