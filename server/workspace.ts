import express, { Router, type Request, type RequestHandler } from "express";
import type { CloudWorkspace, StudyBackup } from "../src/types";
import {
  MAX_DELETED_NOTE_ID_LENGTH,
  MAX_DELETED_NOTE_IDS,
  normalizeDeletedNoteIds,
  parseBackup,
} from "../src/lib/backup";
import { requireAuth, workspaceSnapshot } from "./auth";
import type { ZhixuDatabase } from "./db";
import { HttpError } from "./http";
import { acquireConcurrencySlot } from "./quota";
import { auditRequest } from "./security";

/**
 * 每用户一份学习工作区（StudyBackup v1）：
 * - 按 user_id 隔离，不接受任何客户端 userId；
 * - revision 乐观并发，冲突 409 只返回服务端当前 revision 等元信息，不携带完整 data；
 * - 复用前端 parseBackup 全量校验（格式、敏感字段、重复 ID、学习证据）；
 * - 请求体独立上限 25 MB，序列化后数据上限 20 MB。
 */

export const WORKSPACE_BODY_LIMIT = "25mb";
export const MAX_WORKSPACE_BYTES = 20 * 1024 * 1024;

/**
 * 工作区响应统一附带服务端当前毫秒时间戳，供客户端校准设备时钟。
 * 只提供基准，不改写备份里客户端生成的 updatedAt。
 */
function workspaceResponse(workspace: CloudWorkspace): CloudWorkspace & { serverTime: number } {
  return { ...workspace, serverTime: Date.now() };
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "请求体必须是一个 JSON 对象。");
  }
  return body as Record<string, unknown>;
}

function readRevision(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new HttpError(400, "revision 必须是非负整数。");
  }
  return value;
}

interface PreparedBackup {
  serialized: string | null;
  data: StudyBackup | null;
}

/** 序列化并校验备份；null 表示清空云端数据（revision 仍前进）。 */
function serializeBackup(value: unknown): PreparedBackup {
  if (value === null) return { serialized: null, data: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "data 必须是 StudyBackup 对象或 null。");
  }
  let serialized: string;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") {
      throw new HttpError(400, "data 不是可序列化的 JSON 数据。");
    }
    serialized = encoded;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "data 不是可序列化的 JSON 数据。");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKSPACE_BYTES) {
    throw new HttpError(
      413,
      `云端学习数据过大，最大允许 ${MAX_WORKSPACE_BYTES / (1024 * 1024)} MB。`,
      { code: "backup_too_large" },
    );
  }
  let parsed: StudyBackup;
  try {
    parsed = parseBackup(serialized);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "格式错误";
    throw new HttpError(
      400,
      `云端学习数据不合法：${detail.slice(0, 300)}`,
      { code: "invalid_backup" },
    );
  }
  return { serialized, data: parsed };
}

const WRITE_WINDOW_MS = 60_000;
const WRITES_PER_MINUTE = 10;
const workspaceWriteWindows = new Map<string, { start: number; count: number }>();

/** 与 webHits 一样定期清理过期窗口，避免不活跃用户的 ID 永久占用内存。 */
function cleanupWorkspaceWriteWindows(now = Date.now()): void {
  for (const [userId, entry] of workspaceWriteWindows) {
    if (now - entry.start >= WRITE_WINDOW_MS) workspaceWriteWindows.delete(userId);
  }
}
const workspaceWriteWindowsCleanupTimer = setInterval(
  cleanupWorkspaceWriteWindows,
  WRITE_WINDOW_MS,
);
workspaceWriteWindowsCleanupTimer.unref();

/** 每用户 PUT 频率限制；单节点进程内状态，返回剩余秒数或放行。 */
function workspaceRateLimit(userId: string, now = Date.now()): number | undefined {
  cleanupWorkspaceWriteWindows(now);
  const current = workspaceWriteWindows.get(userId);
  if (!current || now - current.start >= WRITE_WINDOW_MS) {
    workspaceWriteWindows.set(userId, { start: now, count: 1 });
    return undefined;
  }
  if (current.count >= WRITES_PER_MINUTE) {
    return Math.max(1, Math.ceil((current.start + WRITE_WINDOW_MS - now) / 1000));
  }
  current.count += 1;
  return undefined;
}

/**
 * 工作区写入门禁：在解析 25 MB 请求体之前执行。
 * - 每用户 10 次/分钟；
 * - 每用户同一时刻最多 1 个、全进程最多 2 个上传；
 * - 响应结束/断开即释放，幂等。
 */
function workspaceWriteGate(db: ZhixuDatabase): RequestHandler {
  return (req, res, next) => {
    const userId = req.authUser?.id;
    if (!userId) {
      next(new HttpError(401, "请先登录后再继续。", { code: "auth_required" }));
      return;
    }
    try {
      assertAccountBinding(req);
    } catch (error) {
      next(error);
      return;
    }
    const retry = workspaceRateLimit(userId);
    if (retry !== undefined) {
      auditRequest(db, req, "workspace.rate_limit", "denied");
      res.setHeader("Retry-After", String(retry));
      res.status(429).json({
        error: "云端保存过于频繁，请稍后再试。",
        code: "rate_limited",
        resetAt: Date.now() + retry * 1000,
      });
      return;
    }
    const userRelease = acquireConcurrencySlot(`workspace:user:${userId}`, 1);
    if (!userRelease) {
      auditRequest(db, req, "workspace.concurrency", "denied");
      res.setHeader("Retry-After", "2");
      res.status(429).json({
        error: "上一份云端数据仍在保存，请稍后再试。",
        code: "concurrency_limit",
        resetAt: Date.now() + 2_000,
      });
      return;
    }
    const globalRelease = acquireConcurrencySlot("workspace:global", 2);
    if (!globalRelease) {
      userRelease();
      auditRequest(db, req, "workspace.concurrency", "denied", "global");
      res.setHeader("Retry-After", "2");
      res.status(429).json({
        error: "服务器正在处理其他大型保存，请稍后再试。",
        code: "concurrency_limit",
        resetAt: Date.now() + 2_000,
      });
      return;
    }
    const release = () => {
      userRelease();
      globalRelease();
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

/**
 * 旧标签页可能仍认为自己是 A，但 Cookie 已被另一个标签页换成 B。
 * 客户端发送它认为的账户 ID；与当前 Cookie 会话不一致时拒绝，避免跨账户写。
 */
function assertAccountBinding(req: Request): void {
  const expected = req.headers["x-zhixu-user"];
  if (expected === undefined) return;
  if (typeof expected !== "string" || expected !== req.authUser?.id) {
    throw new HttpError(409, "登录账户已在本浏览器的其他标签页变化，请刷新后重试。", {
      code: "account_mismatch",
    });
  }
}

/**
 * 中间件形式：供工作区之外的账户级写路由复用（如 AI 路由），
 * 语义与 workspace/library/credentials 完全一致。
 */
export function accountBinding(): RequestHandler {
  return (req, _res, next) => {
    try {
      assertAccountBinding(req);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function registerWorkspaceRoutes(router: Router, db: ZhixuDatabase): void {
  router.get("/workspace", requireAuth(), (req, res) => {
    const user = req.authUser;
    if (!user) throw new HttpError(401, "请先登录后再继续。", { code: "auth_required" });
    assertAccountBinding(req);
    if (!db.getWorkspace(user.id)) db.initWorkspace(user.id);
    res.status(200).json(workspaceResponse(workspaceSnapshot(db, user.id)));
  });

  // 云笔记删除必须显式落库并推进 revision；否则后续“并集合并”会把旧笔记复活。
  // 即使笔记已经不存在，也要写入墓碑（防止旧快照按同 ID 回写）；已有墓碑则不重复推进。
  router.post("/workspace/note-delete", requireAuth(), workspaceWriteGate(db), (req, res) => {
    const user = req.authUser;
    if (!user) throw new HttpError(401, "请先登录后再继续。", { code: "auth_required" });
    const noteId = typeof req.body?.noteId === "string" ? req.body.noteId.trim() : "";
    if (!noteId || noteId.length > MAX_DELETED_NOTE_ID_LENGTH) {
      throw new HttpError(400, "noteId 必须是有效字符串。");
    }
    if (!db.getWorkspace(user.id)) db.initWorkspace(user.id);
    // revision 冲突说明其他设备刚写过：重新读取最新工作区后再尝试写入墓碑，
    // 不能直接返回成功，更不能把删除意图丢掉（旧快照仍可能带着这篇笔记）。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = workspaceSnapshot(db, user.id);
      if (!current.data) {
        res.status(200).json(workspaceResponse(current));
        return;
      }
      const tombstones = normalizeDeletedNoteIds(current.data.deletedNoteIds);
      const notes = current.data.notes.filter((note) => note.id !== noteId);
      const noteRemoved = notes.length !== current.data.notes.length;
      if (tombstones.includes(noteId) && !noteRemoved) {
        // 幂等：同一墓碑已存在且笔记不在，不制造新 revision。
        res.status(200).json(workspaceResponse(current));
        return;
      }
      // 达到上限时拒绝新的墓碑，避免 normalize 截断时把其他仍被引用的旧墓碑挤掉。
      if (!tombstones.includes(noteId) && tombstones.length >= MAX_DELETED_NOTE_IDS) {
        throw new HttpError(409, "已删除笔记数量达到上限，无法记录新的删除墓碑。", {
          code: "tombstone_limit",
        });
      }
      const nextTombstones = normalizeDeletedNoteIds([...tombstones, noteId]);
      if (!nextTombstones.includes(noteId)) {
        throw new HttpError(409, "已删除笔记数量达到上限，无法记录新的删除墓碑。", {
          code: "tombstone_limit",
        });
      }
      const data: StudyBackup = {
        ...current.data,
        notes,
        deletedNoteIds: nextTombstones,
        exportedAt: Date.now(),
      };
      const updated = db.updateWorkspace(
        user.id,
        current.revision,
        JSON.stringify(data),
      );
      if (!updated) continue;
      auditRequest(db, req, "workspace.note_delete", "ok", `revision:${updated.revision}`);
      res.status(200).json(workspaceResponse({ revision: updated.revision, data }));
      return;
    }
    const latest = workspaceSnapshot(db, user.id);
    throw new HttpError(409, "云端数据刚被其他设备更新，请刷新后重试删除。", {
      code: "revision_conflict",
      details: { revision: latest.revision },
    });
  });

  // 大请求体只在该路由内、经过鉴权和门禁后解析；禁用压缩避免 zip bomb。
  const parseWorkspaceJson = express.json({
    limit: WORKSPACE_BODY_LIMIT,
    inflate: false,
  });
  router.put("/workspace", requireAuth(), workspaceWriteGate(db), parseWorkspaceJson, (req, res) => {
    const user = req.authUser;
    if (!user) throw new HttpError(401, "请先登录后再继续。", { code: "auth_required" });
    const body = bodyObject(req.body);
    const revision = readRevision(body.revision);
    if (!("data" in body)) {
      throw new HttpError(400, "缺少 data 字段（可为 null）。");
    }
    const prepared = serializeBackup(body.data);

    if (!db.getWorkspace(user.id)) db.initWorkspace(user.id);
    const current = workspaceSnapshot(db, user.id);
    // revision 不匹配时先按既有语义返回冲突（并带上最新墓碑），不尝试合并旧快照。
    if (revision !== current.revision) {
      auditRequest(db, req, "workspace.save", "denied", `revision_conflict:${revision}`);
      throw new HttpError(409, "云端数据已被其他设备更新，请先刷新后再保存。", {
        code: "revision_conflict",
        details: { revision: current.revision },
      });
    }
    const currentData = current.data;
    const incomingData = prepared.data;
    let nextPrepared = prepared;
    if (incomingData) {
      // 服务端墓碑是追加式事实：旧客户端上传的快照即使漏带墓碑，也必须保留。
      const currentTombstones = currentData
        ? normalizeDeletedNoteIds(currentData.deletedNoteIds)
        : [];
      const incomingTombstones = normalizeDeletedNoteIds(incomingData.deletedNoteIds);
      const tombstones = normalizeDeletedNoteIds([
        ...currentTombstones,
        ...incomingTombstones,
      ]);
      const tombstoneSet = new Set(tombstones);
      const resurrected = incomingData.notes.filter((note) => tombstoneSet.has(note.id));
      if (resurrected.length > 0) {
        auditRequest(
          db,
          req,
          "workspace.save",
          "denied",
          `note_tombstoned:${resurrected.length}`,
        );
        throw new HttpError(
          409,
          "云端已删除的笔记不能由旧快照重新写入，请刷新后重试。",
          {
            code: "note_tombstoned",
            details: { revision: current.revision },
          },
        );
      }
      const incomingRawTombstones = incomingData.deletedNoteIds;
      const needsNormalization =
        incomingRawTombstones !== undefined &&
        (incomingRawTombstones.length !== incomingTombstones.length ||
          incomingRawTombstones.some(
            (id, index) => id !== incomingTombstones[index],
          ));
      const incomingTombstoneSet = new Set(incomingTombstones);
      const needsMerge = tombstones.some(
        (id) => !incomingTombstoneSet.has(id),
      );
      if (needsNormalization || needsMerge) {
        nextPrepared = serializeBackup({
          ...incomingData,
          deletedNoteIds: tombstones,
        });
      }
    }
    const updated = db.updateWorkspace(user.id, revision, nextPrepared.serialized);
    if (!updated) {
      const latest = workspaceSnapshot(db, user.id);
      auditRequest(db, req, "workspace.save", "denied", `revision_conflict:${revision}`);
      throw new HttpError(409, "云端数据已被其他设备更新，请先刷新后再保存。", {
        code: "revision_conflict",
        details: { revision: latest.revision },
      });
    }

    auditRequest(db, req, "workspace.save", "ok", `revision:${updated.revision}`);
    res.status(200).json(workspaceResponse({ revision: updated.revision, data: nextPrepared.data }));
  });
}
