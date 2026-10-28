import type { RequestHandler, Router } from "express";
import type { ProviderSettings } from "../src/types";
import { requireAuth } from "./auth";
import type { AppConfig } from "./config";
import type { ZhixuDatabase } from "./db";
import { CredentialVault, type CredentialKeyHealth } from "./credentialVault";
import { HttpError, assertAllowedModelEndpoints, parseProviderSettings } from "./http";
import { auditRequest } from "./security";

export type { CredentialKeyHealth, CredentialKeyStatus } from "./credentialVault";

/**
 * 每用户加密保存的个人模型/搜索配置。
 *
 * - GET/PUT/DELETE 都要求登录；不同用户只能读写自己的行。
 * - 客户端带 X-Zhixu-User 时必须是当前 Cookie 会话账户，否则 409
 *   account_mismatch，避免旧标签页跨账户读取、覆盖或删除凭据。
 * - 只有 ZHIXU_ALLOW_BYOK=true 的部署开放；公共服务端密钥模式不使用此表。
 * - 返回给前端的配置包含 Key，仅用于该用户编辑/发起请求；审计不记录 Key。
 * - 已有密文时，保存前必须确认当前 credentials.key 仍能解密既有样本；
 *   缺 key/损坏/key 被替换一律拒绝写入，避免产生重启后无法恢复的新密文。
 */
export class UserCredentialStore {
  private readonly vault: CredentialVault;

  constructor(
    private readonly db: ZhixuDatabase,
    dataDir: string,
  ) {
    this.vault = new CredentialVault(dataDir);
  }

  get(userId: string): { settings: ProviderSettings; updatedAt: number } | null {
    const row = this.db.getCredentials(userId);
    if (!row) return null;
    const raw = this.vault.decrypt(userId, row.payload);
    const settings = parseProviderSettings(raw);
    if (!settings) throw new Error("已保存的个人配置为空。");
    return { settings, updatedAt: row.updatedAt };
  }

  save(userId: string, settings: ProviderSettings): number {
    const existing = this.db.anyCredentials();
    return this.db.saveCredentials(userId, this.vault.encryptForStore(userId, settings, existing));
  }

  /** 供 /api/ready 等启动检查使用：同时检查 key 文件与既有密文是否自洽。 */
  health(): CredentialKeyHealth {
    const storedCredentials = this.db.countCredentials();
    const sample = storedCredentials > 0 ? this.db.anyCredentials() : undefined;
    return this.vault.health(storedCredentials, sample);
  }

  delete(userId: string): void {
    this.db.deleteCredentials(userId);
  }
}

function requireByok(config: AppConfig): void {
  if (!config.allowByok) {
    throw new HttpError(
      403,
      "当前部署不允许保存个人模型/搜索密钥，请使用服务端配置。",
      { code: "byok_not_allowed" },
    );
  }
}

/**
 * 旧标签页可能仍认为自己是 A，但 Cookie 已被其他标签页换成 B。
 * 客户端发送它认为的账户 ID；与当前 Cookie 会话不一致时拒绝，
 * 避免跨账户读取、覆盖或删除个人密钥。
 * 与工作区/书架使用同一头语义（X-Zhixu-User），不带头时保持兼容。
 */
function accountBinding(): RequestHandler {
  return (req, _res, next) => {
    const expected = req.headers["x-zhixu-user"];
    if (expected === undefined) {
      next();
      return;
    }
    if (typeof expected !== "string" || expected !== req.authUser?.id) {
      next(
        new HttpError(409, "登录账户已在本浏览器的其他标签页变化，请刷新后重试。", {
          code: "account_mismatch",
        }),
      );
      return;
    }
    next();
  };
}

export function registerCredentialRoutes(
  router: Router,
  config: AppConfig,
  db: ZhixuDatabase,
  store: UserCredentialStore,
): void {
  router.get("/credentials", requireAuth(), accountBinding(), (req, res) => {
    requireByok(config);
    const user = req.authUser;
    if (!user) throw new HttpError(401, "请先登录。", { code: "auth_required" });
    const saved = store.get(user.id);
    res.json({
      settings: saved?.settings ?? null,
      updatedAt: saved?.updatedAt ?? 0,
    });
  });

  router.put("/credentials", requireAuth(), accountBinding(), (req, res) => {
    requireByok(config);
    const user = req.authUser;
    if (!user) throw new HttpError(401, "请先登录。", { code: "auth_required" });
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const settings = parseProviderSettings(body.settings);
    if (!settings) {
      throw new HttpError(400, "缺少个人模型/搜索配置。", { code: "settings_required" });
    }
    assertAllowedModelEndpoints(settings, config.byokAllowedOrigins);
    const updatedAt = store.save(user.id, settings);
    auditRequest(db, req, "credentials.save", "ok");
    res.json({ ok: true, updatedAt });
  });

  router.delete("/credentials", requireAuth(), accountBinding(), (req, res) => {
    const user = req.authUser;
    if (!user) throw new HttpError(401, "请先登录。", { code: "auth_required" });
    store.delete(user.id);
    auditRequest(db, req, "credentials.delete", "ok");
    res.json({ ok: true });
  });
}
