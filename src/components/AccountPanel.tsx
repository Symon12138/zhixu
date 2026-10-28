import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  Eye,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import type { AuthResult, AuthUser, CloudWorkspace, ServerConfig, StudyBackup } from "../types";
import {
  CloudSyncError,
  deleteAccount,
  login,
  logout,
  logoutAll,
  recover,
  register,
  rotateRecoveryCode,
  type Fetcher,
} from "../lib/cloudSync";
import { Modal } from "./UI";
import "./AccountPanel.css";

export type SyncStatus =
  | { state: "offline" }
  | { state: "synced"; at: number }
  | { state: "syncing" }
  | { state: "error"; message: string }
  | { state: "local" };

const SYNC_STATUS_LABEL: Record<SyncStatus["state"], string> = {
  offline: "离线",
  synced: "已同步到云端",
  syncing: "正在同步…",
  error: "同步出错",
  local: "仅保存在本机",
};

type PanelMode = "login" | "register" | "recover";

function statusText(status: SyncStatus): string {
  switch (status.state) {
    case "synced":
      return `已同步到云端 · ${new Date(status.at).toLocaleTimeString()}`;
    case "error":
      return `同步出错：${status.message}`;
    default:
      return SYNC_STATUS_LABEL[status.state];
  }
}

function retryHint(seconds: number): string {
  if (seconds <= 90) return `${Math.max(1, Math.round(seconds))} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.ceil(seconds / 3600)} 小时`;
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "操作失败，请稍后重试。";
  if (
    error instanceof CloudSyncError &&
    error.status === 429 &&
    typeof error.retryAfter === "number"
  ) {
    return `${message}（约 ${retryHint(error.retryAfter)}后可重试）`;
  }
  return message;
}

interface FieldProps {
  id: string;
  label: string;
  type?: string;
  value: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  help?: string;
  showVisibilityToggle?: boolean;
  onChange: (value: string) => void;
}

function Field({
  id,
  label,
  type = "text",
  value,
  autoComplete,
  placeholder,
  required,
  minLength,
  help,
  showVisibilityToggle,
  onChange,
}: FieldProps) {
  const [revealed, setRevealed] = useState(false);
  const actualType = showVisibilityToggle && revealed ? "text" : type;
  return (
    <label htmlFor={id}>
      {label}
      <div className={showVisibilityToggle ? "account-password-field" : undefined}>
        <input
          id={id}
          type={actualType}
          value={value}
          autoComplete={autoComplete}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          onChange={(e) => onChange(e.target.value)}
        />
        {showVisibilityToggle && (
          <button
            type="button"
            className="icon-button"
            aria-label={revealed ? "隐藏密码" : "显示密码"}
            aria-pressed={revealed}
            onClick={() => setRevealed(!revealed)}
          >
            <Eye size={17} />
          </button>
        )}
      </div>
      {help && <span className="account-field-help">{help}</span>}
    </label>
  );
}

export function AccountPanel({
  user,
  config,
  fetcher,
  syncStatus,
  workspace,
  onLoginSuccess,
  onLoggedOut,
  onAccountDeleted,
  onRetrySync,
}: {
  user: AuthUser | null;
  config: ServerConfig;
  fetcher: Fetcher;
  syncStatus: SyncStatus;
  workspace: CloudWorkspace | null;
  onLoginSuccess: (user: AuthUser, result: { revision: number; data: StudyBackup | null }) => void;
  onLoggedOut: () => void;
  onAccountDeleted: () => void;
  onRetrySync: () => void;
}) {
  const [mode, setMode] = useState<PanelMode>("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotatePassword, setRotatePassword] = useState("");
  const [rotating, setRotating] = useState(false);
  const [pendingAuth, setPendingAuth] = useState<AuthResult | null>(null);
  const [recoveryShown, setRecoveryShown] = useState<string | null>(null);
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [copied, setCopied] = useState(false);
  const recoveryTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (recoveryTimer.current !== null) window.clearTimeout(recoveryTimer.current);
    },
    [],
  );

  // 恢复码只显示一次：未确认保存前离开页面需要二次确认，避免永久丢失。
  useEffect(() => {
    if (!recoveryShown) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recoveryShown]);

  function resetForm() {
    setEmail("");
    setName("");
    setPassword("");
    setRecoveryCode("");
    setLegalAccepted(false);
    setError(null);
  }

  function switchMode(next: PanelMode) {
    resetForm();
    setMode(next);
  }

  function finishSignIn(result: AuthResult) {
    onLoginSuccess(result.user, {
      revision: result.revision,
      data: result.data,
    });
    setError(null);
    setPendingAuth(null);
    resetForm();
    setMode("login");
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (mode === "register" && !legalAccepted) {
      setError("请先阅读并同意服务条款与隐私说明，再创建账户。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "login"
          ? await login(fetcher, { email: email.trim(), password })
          : mode === "register"
            ? await register(fetcher, {
                email: email.trim(),
                name: name.trim() || email.trim().split("@")[0],
                password,
              })
            : await recover(fetcher, {
                email: email.trim(),
                recoveryCode: recoveryCode.trim(),
                password,
              });
      if (result.recoveryCode) {
        // 注册 / 重置密码后先展示一次性恢复码；用户确认已保存才算完成。
        // 此时服务端已经建立会话，确认后直接使用这次响应的数据，不重复登录。
        setPendingAuth(result);
        setRecoveryShown(result.recoveryCode);
        setRecoveryAck(false);
        return;
      }
      finishSignIn(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmRecoverySaved() {
    if (!recoveryShown || !recoveryAck) return;
    const pending = pendingAuth;
    setRecoveryShown(null);
    setRecoveryAck(false);
    if (pending) finishSignIn(pending);
    else setMode("login");
  }

  async function submitRotateRecovery(event: FormEvent) {
    event.preventDefault();
    if (rotating || !rotatePassword) return;
    setRotating(true);
    setError(null);
    try {
      const code = await rotateRecoveryCode(fetcher, rotatePassword);
      setRotatePassword("");
      setRotateOpen(false);
      setPendingAuth(null);
      setRecoveryShown(code);
      setRecoveryAck(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRotating(false);
    }
  }

  async function submitDelete(event: FormEvent) {
    event.preventDefault();
    if (busy || !deletePassword) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(fetcher, deletePassword);
      setDeleteConfirmOpen(false);
      setDeletePassword("");
      onAccountDeleted();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyRecoveryCode() {
    if (!recoveryShown) return;
    try {
      await navigator.clipboard.writeText(recoveryShown);
      setCopied(true);
      if (recoveryTimer.current !== null) window.clearTimeout(recoveryTimer.current);
      recoveryTimer.current = window.setTimeout(() => setCopied(false), 2400);
    } catch {
      setError("无法访问剪贴板，请手动抄写恢复码。");
    }
  }

  /* ── 一次性恢复码确认页 ─────────────────────────────────────── */
  if (recoveryShown) {
    return (
      <div className="account-card" role="region" aria-label="保存恢复码">
        <h2 className="account-card-title">
          {mode === "recover" ? "密码已重置，这是新的恢复码" : "这是你的一次性恢复码"}
        </h2>
        <div className="account-recovery-code" aria-live="polite">
          <code>{recoveryShown}</code>
          <button
            type="button"
            className="button secondary"
            onClick={() => void copyRecoveryCode()}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <p className="account-field-help">
          只显示这一次。换设备或忘记密码时，凭邮箱和这串码可以恢复账户；服务端不保存原文，丢失后无法找回数据。重置密码会撤销其他设备上的登录。
        </p>
        {error && (
          <p className="account-error" role="alert">
            <X size={15} aria-hidden="true" />
            {error}
          </p>
        )}
        <label className="account-check-row">
          <input
            type="checkbox"
            checked={recoveryAck}
            onChange={(e) => setRecoveryAck(e.target.checked)}
          />
          <span>我已把恢复码保存在安全的地方</span>
        </label>
        <button
          className="button primary full-width"
          disabled={!recoveryAck || busy}
          onClick={confirmRecoverySaved}
        >
          已保存，进入知序
        </button>
      </div>
    );
  }

  /* ── 已登录：账户与云同步状态 ───────────────────────────────── */
  if (user) {
    const cloudCounts = workspace?.data
      ? {
          sessions: workspace.data.sessions.length,
          notes: workspace.data.notes.length,
        }
      : null;
    return (
      <div className="account-card" role="region" aria-label="账户与云同步">
        <div className="account-user-row">
          <span className="account-avatar" aria-hidden="true">
            {user.name.slice(0, 1) || user.email.slice(0, 1)}
          </span>
          <span className="account-user-meta">
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </span>
        </div>
        <dl className="account-status-list">
          <div>
            <dt>云同步状态</dt>
            <dd
              className={`account-sync-state account-sync-${syncStatus.state}`}
              aria-live="polite"
            >
              {statusText(syncStatus)}
            </dd>
          </div>
          {cloudCounts && (
            <div>
              <dt>云端数据</dt>
              <dd>
                {cloudCounts.sessions} 个学习会话 · {cloudCounts.notes} 篇笔记 ·
                版本 {workspace?.revision ?? "-"}
              </dd>
            </div>
          )}
          {config.authRequired && (
            <div>
              <dt>每日额度</dt>
              <dd>
                对话 {config.quotas.chatPerDay} 次 · 诊断 {config.quotas.diagnosticPerDay} 次 ·
                补讲 {config.quotas.reviewPerDay} 次（UTC 零点重置）
              </dd>
            </div>
          )}
        </dl>
        {syncStatus.state === "error" && (
          <button
            type="button"
            className="button secondary full-width"
            onClick={onRetrySync}
          >
            <RefreshCw size={15} />
            重试同步
          </button>
        )}
        {error && !deleteConfirmOpen && (
          <p className="account-error" role="alert">
            <X size={15} aria-hidden="true" />
            {error}
          </p>
        )}
        <div className="account-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void logout(fetcher)
                .then(() => {
                  setDeleteConfirmOpen(false);
                  onLoggedOut();
                })
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            <LogOut size={15} />
            退出登录
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void logoutAll(fetcher)
                .then(() => {
                  setDeleteConfirmOpen(false);
                  onLoggedOut();
                })
                .catch((e) => setError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            <LogOut size={15} />
            退出全部设备
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setRotatePassword("");
              setError(null);
              setRotateOpen((open) => !open);
            }}
          >
            <KeyRound size={15} />
            生成新的恢复码
          </button>
          <button
            type="button"
            className="button danger"
            disabled={busy}
            onClick={() => {
              setDeletePassword("");
              setError(null);
              setDeleteConfirmOpen(true);
            }}
          >
            <Trash2 size={15} />
            删除账户
          </button>
        </div>
        {rotateOpen && (
          <form className="account-form" onSubmit={(e) => void submitRotateRecovery(e)}>
            <Field
              id="rotate-recovery-password"
              label="输入当前密码生成新恢复码"
              type="password"
              value={rotatePassword}
              autoComplete="current-password"
              required
              showVisibilityToggle
              help="旧恢复码会立即失效；新恢复码只显示一次。"
              onChange={setRotatePassword}
            />
            <button
              type="submit"
              className="button secondary"
              disabled={rotating || !rotatePassword}
            >
              {rotating ? "正在生成…" : "生成新恢复码"}
            </button>
          </form>
        )}
        <p className="account-field-help">
          学习数据通过登录状态在设备间同步；开启 BYOK 时，个人密钥加密保存在服务端，仅当前账户可读，不写入学习备份或导出。
        </p>
        <p className="account-legal">
          账户服务依据<a href="/terms.html" target="_blank" rel="noopener noreferrer">《服务条款》</a>与<a href="/privacy.html" target="_blank" rel="noopener noreferrer">《隐私说明》</a>提供。
        </p>
        {deleteConfirmOpen && (
          <Modal
            title="删除账户？"
            subtitle="云端学习数据、会话、笔记与额度记录会一并删除，无法恢复。本机数据也会清空。"
            onClose={() => {
              setDeletePassword("");
              setError(null);
              setDeleteConfirmOpen(false);
            }}
          >
            <form className="account-form" onSubmit={(e) => void submitDelete(e)}>
              <Field
                id="delete-password"
                label="输入当前密码确认"
                type="password"
                value={deletePassword}
                autoComplete="current-password"
                required
                showVisibilityToggle
                onChange={setDeletePassword}
              />
              {error && (
                <p className="account-error" role="alert">
                  <X size={15} aria-hidden="true" />
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    setDeletePassword("");
                    setError(null);
                    setDeleteConfirmOpen(false);
                  }}
                >
                  保留账户
                </button>
                <button
                  type="submit"
                  className="button danger"
                  disabled={busy || !deletePassword}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" aria-hidden="true" />
                  ) : (
                    <Trash2 size={15} />
                  )}
                  永久删除
                </button>
              </div>
            </form>
          </Modal>
        )}
      </div>
    );
  }

  /* ── 未登录：登录 / 注册 / 恢复 ─────────────────────────────── */
  return (
    <div className="account-card" role="region" aria-label="账户登录">
      {mode !== "login" && (
        <button
          type="button"
          className="account-back"
          onClick={() => switchMode("login")}
        >
          返回登录
        </button>
      )}
      <h2 className="account-card-title">
        {mode === "login" ? "登录知序" : mode === "register" ? "创建账户" : "恢复账户"}
      </h2>
      {mode === "login" && (
        <p className="account-lead">
          登录后，学习记录自动同步到云端，换设备也能继续。
        </p>
      )}
      {config.authRequired && (
        <div className="account-info-box">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            {config.allowByok
              ? "公共版必须登录后使用；开启 BYOK 时，模型与搜索请求使用你保存在服务端的个人 Key。"
              : "公共版必须登录后使用；模型调用由服务端密钥完成，网页不会保存或上传个人 API 密钥。"}
          </span>
        </div>
      )}
      {config.authRequired && !config.configured && !config.allowByok && (
        <div className="account-error" role="status">
          <X size={15} aria-hidden="true" />
          服务器尚未配置模型密钥，登录后暂时无法调用 AI；请联系管理员配置后再使用。
        </div>
      )}
      <form className="account-form" onSubmit={(e) => void submitAuth(e)}>
        <Field
          id="auth-email"
          label="邮箱"
          type="email"
          value={email}
          autoComplete="email"
          placeholder="you@example.com"
          required
          onChange={setEmail}
        />
        {mode === "register" && (
          <Field
            id="auth-name"
            label="昵称（可选）"
            value={name}
            autoComplete="nickname"
            placeholder="怎么称呼你"
            onChange={setName}
          />
        )}
        {mode === "recover" && (
          <Field
            id="auth-recovery-code"
            label="一次性恢复码"
            value={recoveryCode}
            autoComplete="off"
            placeholder="注册时保存的恢复码"
            required
            onChange={setRecoveryCode}
          />
        )}
        <Field
          id="auth-password"
          label={mode === "recover" ? "设置新密码" : "密码"}
          type="password"
          value={password}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          placeholder={mode === "login" ? "你的密码" : "至少 10 位字符"}
          required
          minLength={mode === "login" ? undefined : 10}
          showVisibilityToggle
          help={
            mode === "register"
              ? "至少 10 位字符。密码只用于登录本应用；服务端加盐哈希存储，任何人（包括管理员）都看不到原文。"
              : mode === "recover"
                ? "至少 10 位字符。重置成功后旧恢复码失效，并会生成一串新的恢复码。"
                : undefined
          }
          onChange={setPassword}
        />
        {mode === "register" && (
          <label className="account-check-row account-legal-consent">
            <input
              type="checkbox"
              checked={legalAccepted}
              onChange={(e) => setLegalAccepted(e.target.checked)}
            />
            <span>我已阅读并同意服务条款与隐私说明</span>
          </label>
        )}
        {error && (
          <p className="account-error" role="alert">
            <X size={15} aria-hidden="true" />
            {error}
          </p>
        )}
        <button
          type="submit"
          className="button primary full-width"
          disabled={busy || (mode === "register" && !legalAccepted)}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : mode === "login" ? (
            <KeyRound size={16} />
          ) : mode === "register" ? (
            <UserPlus size={16} />
          ) : (
            <KeyRound size={16} />
          )}
          {mode === "login" ? "登录" : mode === "register" ? "创建账户" : "恢复账户"}
        </button>
      </form>
      <p className="account-legal">
        继续即表示你同意<a href="/terms.html" target="_blank" rel="noopener noreferrer">《服务条款》</a>与<a href="/privacy.html" target="_blank" rel="noopener noreferrer">《隐私说明》</a>。
      </p>
      <div className="account-switch-row">
        {mode !== "register" && (
          <button
            type="button"
            className="text-button"
            onClick={() => switchMode("register")}
          >
            没有账户？创建一个
          </button>
        )}
        {mode !== "recover" && (
          <button
            type="button"
            className="text-button"
            onClick={() => switchMode("recover")}
          >
            忘记密码？用恢复码找回
          </button>
        )}
      </div>
    </div>
  );
}
