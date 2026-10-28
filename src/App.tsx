import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  BookMarked,
  BookOpen,
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Compass,
  ExternalLink,
  FileText,
  Globe,
  GraduationCap,
  Layers3,
  Lightbulb,
  LoaderCircle,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sprout,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { BrandMark, CourseArt, HeroArt, Modal } from "./components/UI";
import {
  LearningProgress,
  MobileLearningProgress,
  TeachingReceiptCard,
  masteryLabels,
} from "./components/LearningProgress";
import { RichText } from "./components/RichText";
import {
  FlashcardPanel,
  QuizPanel,
  SettingsModal,
} from "./components/StudyTools";
import DerivativeLab from "./components/LazyDerivativeLab";
import { courses, getCourse } from "./lib/courses";
import { downloadText, useStudyStorage } from "./lib/storage";
import { STORAGE_PREFIX } from "./lib/persistentStorage";
import { loadSafeSettings, mergeImportedSettings, saveSafeSettings } from "./lib/settings";
import {
  accountSwitchReducer,
  accountSwitchStateReducer,
  applyAccountSwitchGate,
  initialAccountSwitchState,
  type AccountSwitchEvent,
  type AccountSwitchReason,
  type AccountSwitchState,
} from "./lib/accountSwitch";
import { CredentialsError, getCredentials, saveCredentials } from "./lib/credentials";
import { createBackup, parseBackup, mergeBackup, normalizeDeletedNoteIds, resolveSettingsUpdatedAt, type BackupImportResult } from "./lib/backup";
import {
  rateReviewItem,
  sessionReviewItems,
  misconceptionToReviewItem,
} from "./lib/review";
import { createDiagnosticProfile, submitDiagnostic } from "./lib/diagnostic";
import { computePathProgress, describePathProgress } from "./lib/learningPath";
import { recordTransferAnswer, syncTransferQuestion } from "./lib/transfer";
import { TransferPractice } from "./components/TransferPractice";
import { DiagnosticPanel } from "./components/DiagnosticPanel";
import { LearningReport } from "./components/LearningReport";
import { LearningPath } from "./components/LearningPath";
import { ReviewWorkspace } from "./components/ReviewWorkspace";
import "./components/LearningWorkspace.css";
import { withTabRequestLock } from "./lib/requestLock";
import {
  CloudSyncError,
  calibratedNow,
  deleteCloudNote,
  getClockOffset,
  getWorkspace,
  me as cloudMe,
  shiftLocalWorkspaceClock,
  syncWorkspace,
  type Fetcher,
  type LocalWorkspaceData,
} from "./lib/cloudSync";
import {
  AccountPanel,
  type SyncStatus,
} from "./components/AccountPanel";
import { prepareBookStudy } from "./lib/bookStudy";
import { clearBookLibrary, getBook, setBookOwner } from "./lib/bookStorage";
import { BookLibrary } from "./components/LazyBookLibrary";
import type { BookDocument, BookSourceLocation, BookStudySelection } from "./bookTypes";
import type {
  AuthUser,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  CloudWorkspace,
  Course,
  DiagnosticProfile,
  LearningEvidence,
  LearningQuestion,
  LearningState,
  LearningTrack,
  Note,
  PathStep,
  ProviderSettings,
  QuizQuestion,
  Reference,
  ReviewItem,
  ReviewRating,
  ServerConfig,
  Stage,
  StudyBackup,
  StudySession,
} from "./types";

type LearningStateState = LearningState;

type View = "home" | "study" | "notes" | "review" | "books";
type StudyTab = "lesson" | "quiz" | "cards" | "workspace";
type WorkspaceSubView = "path" | "transfer" | "review" | "report";
type Action = ChatRequest["action"];

type PendingAccountSwitchContext = {
  user: AuthUser;
  result: { revision: number; data: StudyBackup | null } | null;
  previousUser: string | null;
  reason: AccountSwitchReason;
};

/**
 * 缺 Key 时挂起的原动作：保存模型配置后自动继续。
 * 复习补讲额外保留 Promise 的 resolve/reject，让发起补讲的卡片拿到结果。
 */
type PendingWork =
  | { kind: "chat"; action: Action; text?: string; target?: StudySession }
  | { kind: "diagnostic"; topic: string; level: string; goal: string }
  | { kind: "review"; item: ReviewItem };

type PendingReviewExplain = {
  resolve: (explanation: string) => void;
  reject: (reason: Error) => void;
};

// 兼容旧调用方/旧测试：门禁实现与类型已迁移到 src/lib/accountSwitch.ts。
export { applyAccountSwitchGate };

const defaults: ProviderSettings = {
  provider: "gemini",
  apiKey: "",
  model: "gemini-2.5-flash",
  baseUrl: "https://api.openai.com/v1",
  thinkingLevel: "auto",
  searchProvider: "tavily",
  searchApiKey: "",
};
const uid = () => crypto.randomUUID();

/** 浏览器里最近一次登录的账户，用于识别"换账户"并避免把上一个账户的数据合并进新账户。 */
const LAST_USER_KEY = "zhixu.v1.last-user";

/** 已删除笔记墓碑的独立持久化键（与笔记列表分开，且绝不写入任何密钥）。 */
const DELETED_NOTE_IDS_KEY = `${STORAGE_PREFIX}deleted-notes`;
/** 非敏感设置的版本时间，单独持久化，便于跨设备判断谁更新。 */
const SETTINGS_UPDATED_AT_KEY = `${STORAGE_PREFIX}settings-updated-at`;
/**
 * 本地学习数据时间戳所基于的时钟偏移。旧版本按设备时钟写入时没有该键，
 * 默认 0；首次合并云端数据时按当前校准值换算一次并写入，此后本地写入
 * 统一使用 calibratedNow()，状态与云端同基准。
 */
export const LOCAL_CLOCK_BASELINE_KEY = `${STORAGE_PREFIX}local-clock-baseline`;

let localClockBaselineCache: number | null = null;

function readLocalClockBaseline(): number {
  if (localClockBaselineCache !== null) return localClockBaselineCache;
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(LOCAL_CLOCK_BASELINE_KEY);
    const value = raw === null ? 0 : Number(raw);
    localClockBaselineCache = Number.isFinite(value) ? value : 0;
  } catch {
    localClockBaselineCache = 0;
  }
  return localClockBaselineCache;
}

/** 记录本地时间戳当前所基于的偏移；供合并/恢复云端快照后同步基准。 */
export function markLocalClockBaseline(offset: number): void {
  localClockBaselineCache = Number.isFinite(offset) ? offset : 0;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOCAL_CLOCK_BASELINE_KEY, String(localClockBaselineCache));
    }
  } catch {
    /* 存储不可用时保留内存基准，至少当前标签页的合并判断仍正确。 */
  }
}

/** 测试辅助：清除内存与持久化的本地时间基准。 */
export function resetLocalClockBaselineForTests(): void {
  localClockBaselineCache = null;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(LOCAL_CLOCK_BASELINE_KEY);
    }
  } catch {
    /* 忽略存储不可用 */
  }
}

/**
 * 本地状态写入统一入口：所有会进入云同步/LWW 判断的时间戳都用服务端基准。
 * 未校准时 calibratedNow() 等价于 Date.now()，行为与旧版本兼容。
 */
function localNow(): number {
  const now = calibratedNow();
  markLocalClockBaseline(getClockOffset());
  return now;
}

export interface CloudBackupMergeOptions {
  /** 本地快照现有时间戳所基于的偏移；旧版本本地数据默认 0（设备时钟）。 */
  localClockOffset?: number;
  /** 当前服务端偏移；不传时使用已持久化的校准值。 */
  serverClockOffset?: number;
}

/**
 * applyCloudData 的纯合并部分。
 *
 * 先把本地 LWW 时间戳从写入时基准换算到当前服务端基准，再与云端备份合并：
 * - 正常路径下本地写入使用 calibratedNow，两个偏移相等，delta 为 0，不重复换算；
 * - 升级前遗留的设备时钟快照（基准 0）会在首次合并时被矫正，避免设备时钟
 *   偏快产生的未来 updatedAt 压过云端真实更新。
 */
export function mergeCloudBackupIntoLocal(
  local: LocalWorkspaceData,
  settings: ProviderSettings,
  backup: StudyBackup,
  options: CloudBackupMergeOptions = {},
): BackupImportResult {
  const serverOffset = options.serverClockOffset ?? getClockOffset();
  const delta = serverOffset - (options.localClockOffset ?? 0);
  const adjustedLocal = delta === 0 ? local : shiftLocalWorkspaceClock(local, delta);
  const localVersion = resolveSettingsUpdatedAt(adjustedLocal.settingsUpdatedAt);
  return mergeBackup(
    {
      ...adjustedLocal,
      ...(localVersion > 0
        ? { settingsWithoutSecrets: settingsWithoutSecretsOf(settings) }
        : {}),
    },
    backup,
  );
}

function settingsWithoutSecretsOf(
  settings: ProviderSettings,
): StudyBackup["settingsWithoutSecrets"] {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    ...(settings.searchProvider === undefined ? {} : { searchProvider: settings.searchProvider }),
    structuredOutput: settings.structuredOutput,
    thinkingLevel: settings.thinkingLevel,
  };
}

/** 未登录或 BYOK 关闭时，从内存清掉个人密钥与备用配置；服务端保存不在此处删除。 */
function clearPersonalKeys(settings: ProviderSettings): ProviderSettings {
  return {
    ...settings,
    apiKey: "",
    searchApiKey: "",
    modelFallbacks: [],
    searchFallbacks: [],
  };
}

function readStoredDeletedNoteIds(): string[] {
  try {
    const raw = localStorage.getItem(DELETED_NOTE_IDS_KEY);
    if (!raw) return [];
    return normalizeDeletedNoteIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

function persistDeletedNoteIds(ids: string[]): void {
  try {
    if (ids.length > 0) localStorage.setItem(DELETED_NOTE_IDS_KEY, JSON.stringify(ids));
    else localStorage.removeItem(DELETED_NOTE_IDS_KEY);
  } catch {
    // 存储不可用时墓碑仍留在内存中；持久化失败由既有 storageError 提示。
  }
}

function readStoredSettingsUpdatedAt(): number {
  try {
    const raw = localStorage.getItem(SETTINGS_UPDATED_AT_KEY);
    return raw === null ? 0 : resolveSettingsUpdatedAt(Number(raw));
  } catch {
    return 0;
  }
}

function persistSettingsUpdatedAt(value: number): void {
  try {
    if (value > 0) localStorage.setItem(SETTINGS_UPDATED_AT_KEY, String(value));
    else localStorage.removeItem(SETTINGS_UPDATED_AT_KEY);
  } catch {
    // 版本时间无法持久化时仍参与本页同步；下次保存会再次尝试。
  }
}

/** 服务端要求所有非 GET 请求带 JSON 内容类型与 CSRF 标记头。 */
const WRITE_REQUEST_HEADERS = {
  "Content-Type": "application/json",
  "X-Zhixu-Request": "1",
} as const;

/**
 * AI 路由（chat/diagnostic/review）要求账户绑定：登录时附带客户端认为的账户 id，
 * 服务端与 Cookie 会话不一致会返回 409，避免旧标签页把请求记到新账户。
 */
function writeHeadersForUser(userId: string | undefined): Record<string, string> {
  return userId
    ? { ...WRITE_REQUEST_HEADERS, "X-Zhixu-User": userId }
    : { ...WRITE_REQUEST_HEADERS };
}

const FALLBACK_CONFIG: ServerConfig = {
  configured: false,
  provider: "gemini",
  model: "",
  authRequired: false,
  allowByok: true,
  webFetchEnabled: false,
  webSearchEnabled: false,
  quotas: { chatPerDay: 40, diagnosticPerDay: 10, reviewPerDay: 30 },
};

/** 服务端配置是网络数据：逐字段校验，旧版服务端缺少的新字段用安全默认值补齐。 */
function normalizeServerConfig(value: unknown): ServerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...FALLBACK_CONFIG, quotas: { ...FALLBACK_CONFIG.quotas } };
  }
  const quotaEntries = new Map<string, number>();
  if (
    "quotas" in value &&
    typeof value.quotas === "object" &&
    value.quotas !== null &&
    !Array.isArray(value.quotas)
  ) {
    for (const [key, raw] of Object.entries(value.quotas)) {
      if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
        quotaEntries.set(key, raw);
      }
    }
  }
  const quota = (key: keyof ServerConfig["quotas"], fallbackValue: number): number =>
    quotaEntries.get(key) ?? fallbackValue;
  return {
    configured: "configured" in value && value.configured === true,
    provider:
      "provider" in value && value.provider === "openai" ? "openai" : "gemini",
    model: "model" in value && typeof value.model === "string" ? value.model : "",
    authRequired: "authRequired" in value && value.authRequired === true,
    allowByok: !("allowByok" in value) || value.allowByok !== false,
    webFetchEnabled: "webFetchEnabled" in value && value.webFetchEnabled === true,
    webSearchEnabled: "webSearchEnabled" in value && value.webSearchEnabled === true,
    quotas: {
      chatPerDay: quota("chatPerDay", FALLBACK_CONFIG.quotas.chatPerDay),
      diagnosticPerDay: quota("diagnosticPerDay", FALLBACK_CONFIG.quotas.diagnosticPerDay),
      reviewPerDay: quota("reviewPerDay", FALLBACK_CONFIG.quotas.reviewPerDay),
    },
  };
}

/** 只允许 http/https 外部来源；损坏备份里的其它协议不进入可点击链接。 */
function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 备份里的复习项与诊断是扁平列表，恢复时必须挂回所属会话；
 * 会话自身已有的条目一并保留（同一 ID 以备份列表为准）。
 */
function attachSessionExtras(
  source: Pick<StudyBackup, "sessions" | "reviews" | "diagnostics">,
): StudySession[] {
  const reviewsBySession = new Map<string, ReviewItem[]>();
  for (const item of source.reviews) {
    const list = reviewsBySession.get(item.sessionId);
    if (list) list.push(item);
    else reviewsBySession.set(item.sessionId, [item]);
  }
  const diagnosticsById = new Map<string, DiagnosticProfile>(
    source.diagnostics.map((profile) => [profile.id, profile] as const),
  );
  return source.sessions.map((session) => {
    const mergedReviews = new Map<string, ReviewItem>();
    for (const item of session.reviews ?? []) mergedReviews.set(item.id, item);
    for (const item of reviewsBySession.get(session.id) ?? []) {
      const existing = mergedReviews.get(item.id);
      if (!existing || (item.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
        mergedReviews.set(item.id, item);
      }
    }
    return {
      ...session,
      reviews: [...mergedReviews.values()],
      diagnostic: session.diagnostic
        ? diagnosticsById.get(session.diagnostic.id) ?? session.diagnostic
        : session.diagnostic,
    };
  });
}

function createSession(
  topic: string,
  level: string,
  references: Reference[] = [],
  goal = topic,
): StudySession {
  const now = localNow();
  return {
    id: uid(),
    title: topic,
    topic,
    level,
    goal: goal.trim() || topic,
    messages: [],
    stageIndex: 0,
    completedStages: [],
    stageAnswers: {},
    plan: [],
    quiz: [],
    flashcards: [],
    quizAnswers: {},
    quizSubmitted: false,
    reviewedCards: [],
    references,
    createdAt: now,
    updatedAt: now,
  };
}

function sessionGoal(session: StudySession): string {
  const currentGoal = session.learningState?.goal;
  return currentGoal && currentGoal !== session.topic ? currentGoal : session.goal;
}

/* ── 学习工作台辅助 ──────────────────────────────────────────────
   路径 / 迁移题 / 诊断的派生逻辑集中在这里，全部只依据真实数据，
   不编造题目、解释或掌握状态。 */

const WORKSPACE_SUB_VIEWS: [WorkspaceSubView, string][] = [
  ["path", "学习路径"],
  ["transfer", "迁移练习"],
  ["review", "复习"],
  ["report", "学习报告"],
];

/** 从 AI 学习状态派生路径：完成只认 understood/applied；导师可决定授课顺序。 */
function learningStatePathSteps(state: LearningStateState): PathStep[] {
  return state.steps.map((step, index) => {
    const done = step.mastery === "understood" || step.mastery === "applied";
    return {
      id: step.id,
      title: step.title,
      goal:
        step.evidence.length > 0
          ? `本步已有 ${step.evidence.length} 条独立作答证据；最近：${step.evidence.at(-1)?.quote ?? ""}`
          : `还没有独立作答证据。达到这一步需要能解释推理，而不是认出答案。`,
      dependencyIds: [],
      estimatedMinutes: 15,
      status: done
        ? ("done" as const)
        : step.id === state.currentStepId
          ? ("current" as const)
          : ("available" as const),
      pendingPrompt:
        state.pendingQuestion && state.pendingQuestion.stepId === step.id
          ? state.pendingQuestion.prompt
          : undefined,
    };
  });
}

/** 内置课程路径：stages + completedStages + stageIndex 派生。 */
function coursePathSteps(
  stageList: { id: string; title: string; content: string }[],
  completedStages: string[],
  stageIndex: number,
): PathStep[] {
  return stageList.map((item, index) => ({
    id: item.id,
    title: item.title,
    goal: item.content.slice(0, 120) || "查看本节讲解并完成理解检查。",
    dependencyIds: [],
    estimatedMinutes: 15,
    status: completedStages.includes(item.id)
      ? ("done" as const)
      : index === stageIndex
        ? ("current" as const)
        : ("available" as const),
  }));
}


/**
 * 读取服务端保存的个人配置。
 *
 * 只有服务端明确返回空配置（settings: null）或 404，才能断定当前账户没有
 * 已保存凭据。网络错误、超时、5xx 等一律视为“未知”：此时不能提示用户先配置，
 * 而应让 BYOK 请求照常发出，由服务端用已保存凭据处理或返回明确错误。
 */
export type ServerCredentialRead =
  | { state: "present"; settings: ProviderSettings }
  | { state: "missing" }
  | { state: "unknown" };

export async function readServerCredentials(
  fetcher: Fetcher,
  expectedUserId?: string,
): Promise<ServerCredentialRead> {
  try {
    const settings = await getCredentials(fetcher, expectedUserId);
    return settings ? { state: "present", settings } : { state: "missing" };
  } catch (error) {
    return error instanceof CredentialsError && error.status === 404
      ? { state: "missing" }
      : { state: "unknown" };
  }
}

/**
 * 是否必须先打开“模型与设置”才能发请求。
 * 服务端凭据读取失败（可能已有配置）时不阻断，让服务端自行判定。
 */
export function requiresModelSetup(options: {
  canUsePersonalKeys: boolean;
  hasLocalApiKey: boolean;
  serverCredentialsMayExist: boolean;
  serverConfigured: boolean;
}): boolean {
  if (!options.canUsePersonalKeys) return !options.serverConfigured;
  return !options.hasLocalApiKey && !options.serverCredentialsMayExist;
}

/**
 * 内置课程理解检查的当前展示状态。
 * 已答对（completedStages 已记录）后答案锁定；旧数据若先答对又改错，
 * 也统一显示为锁定的正确答案，避免“学懂了”和“再想一步”同时出现。
 */
export function resolveStageAnswer(
  stage: Pick<Stage, "id" | "correctIndex">,
  session: Pick<StudySession, "completedStages" | "stageAnswers">,
): { locked: boolean; selectedIndex: number | undefined; correct: boolean } {
  const locked = session.completedStages.includes(stage.id);
  const selectedIndex = locked
    ? stage.correctIndex
    : session.stageAnswers[stage.id];
  return {
    locked,
    selectedIndex,
    correct: selectedIndex === stage.correctIndex,
  };
}

/**
 * 选择理解检查选项；已答对并锁定的检查返回 null。
 * 调用方只在返回非 null 时写入会话，保证完成状态与作答不会互相矛盾。
 */
export function selectStageAnswer(
  session: Pick<StudySession, "completedStages" | "stageAnswers">,
  stage: Pick<Stage, "id" | "correctIndex">,
  index: number,
): Pick<StudySession, "stageAnswers" | "completedStages"> | null {
  if (session.completedStages.includes(stage.id)) return null;
  return {
    stageAnswers: { ...session.stageAnswers, [stage.id]: index },
    completedStages:
      index === stage.correctIndex
        ? [...session.completedStages, stage.id]
        : session.completedStages,
  };
}

/** 切换会话时丢弃原会话草稿；回到同一会话仍保留未发送内容。 */
export function draftForSessionSwitch(
  previousSessionId: string | null,
  nextSessionId: string,
  draft: string,
): string {
  return previousSessionId === nextSessionId ? draft : "";
}

/**
 * 附件校验错误的归属：只有学习页属于当前会话；首页等页面用空 sessionId，
 * 否则首页会按 `!error.sessionId` 过滤而把错误藏起来。
 */
export function attachmentErrorSessionId(
  view: View,
  activeId: string | null,
): string | null {
  return view === "study" ? activeId : null;
}

/** 归档失败后的唯一出口：明确重试，或确认丢弃本机数据继续切换。 */
function AccountSwitchRecoveryDialog({
  state,
  onRetry,
  onDiscard,
  onExport,
}: {
  state: AccountSwitchState;
  onRetry: () => void;
  onDiscard: () => void;
  onExport: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    setConfirmingDiscard(false);
  }, [state]);
  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby="account-switch-title"
      onCancel={(event) => {
        /* 身份已经切换一半，必须先明确选择重试或丢弃，不能直接关掉。 */
        event.preventDefault();
      }}
    >
      <div className="modal-head">
        <div>
          <h2 id="account-switch-title">旧本机学习记录无法备份</h2>
          <p>新账户已登录，但旧记录还没有安全归档。</p>
        </div>
      </div>
      {confirmingDiscard ? (
        <>
          <p>
            确认丢弃本机旧学习数据并继续切换？旧记录会从当前浏览器清除，之后无法恢复，也不会出现在新账户中。
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setConfirmingDiscard(false)}
            >
              返回
            </button>
            <button type="button" className="button danger" onClick={onDiscard}>
              确认丢弃并继续切换
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            当前浏览器无法保存归档备份，通常是本地存储空间不足或被禁用。你可以先导出备份、清理浏览器空间，再重试切换。
          </p>
          <p>
            如果确认不再需要本机旧记录，也可以丢弃它们并直接使用新账户；旧记录不会上传到新账户。
          </p>
          <button type="button" className="text-button" onClick={onExport}>
            先导出本机旧记录备份
          </button>
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => setConfirmingDiscard(true)}
            >
              丢弃本机数据并继续切换
            </button>
            <button type="button" className="button primary" onClick={onRetry}>
              重试
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

export default function App() {
  const {
    sessions,
    setSessions,
    notes,
    setNotes,
    activity,
    setActivity,
    recordActivity,
    storageError,
  } = useStudyStorage();
  const [view, setView] = useState<View>("home");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tab, setTab] = useState<StudyTab>("lesson");
  const [prompt, setPrompt] = useState("");
  const [learningGoal, setLearningGoal] = useState("");
  const [level, setLevel] = useState("从零开始");
  const [references, setReferences] = useState<Reference[]>([]);
  const [webSearchOn, setWebSearchOn] = useState(false);
  const [webSourceOpen, setWebSourceOpen] = useState(false);
  const [webSourceUrl, setWebSourceUrl] = useState("");
  const [webSourceClaim, setWebSourceClaim] = useState("");
  const [webSourceBusy, setWebSourceBusy] = useState(false);
  const [webSourceError, setWebSourceError] = useState("");
  const [filter, setFilter] = useState("all");
  const [settings, setSettings] = useState<ProviderSettings>(() => loadSafeSettings(defaults));
  const [config, setConfig] = useState<ServerConfig>(() => normalizeServerConfig(null));
  const [configReady, setConfigReady] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 从“连接你的 AI 导师”去登录时置位：登录成功后自动回到模型配置流程。 */
  const [resumeSettingsAfterLogin, setResumeSettingsAfterLogin] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<PendingWork | null>(null);
  const pendingReviewExplainRef = useRef<PendingReviewExplain | null>(null);
  const [error, setError] = useState<{ sessionId: string | null; text: string } | null>(null);
  const [toast, setToast] = useState("");
  const [noteEditor, setNoteEditor] = useState<Note | null>(null);
  const [deleteNoteId, setDeleteNoteId] = useState<string | null>(null);
  const [noteDeleting, setNoteDeleting] = useState(false);
  // 删除笔记的墓碑与设置版本都独立持久化；墓碑只存 ID，绝不存任何密钥。
  const [deletedNoteIds, setDeletedNoteIds] = useState<string[]>(readStoredDeletedNoteIds);
  const [settingsUpdatedAt, setSettingsUpdatedAt] = useState<number>(readStoredSettingsUpdatedAt);
  const [bookLocation, setBookLocation] = useState<BookSourceLocation | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [hintCount, setHintCount] = useState(0);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [accountSwitch, dispatchAccountSwitchAction] = useReducer(
    accountSwitchStateReducer,
    initialAccountSwitchState,
  );
  // dispatch 需要同步拿到下一状态（归档结果、重试是否已放行），
  // 因此用 ref 镜像 reducer 状态；React 渲染仍以 useReducer 的 state 为准。
  const accountSwitchStateRef = useRef(accountSwitch);
  accountSwitchStateRef.current = accountSwitch;
  const pendingAccountSwitchRef = useRef<PendingAccountSwitchContext | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  // GET /api/credentials 失败（网络错误等非 404）时，本地 Key 为空并不代表
  // 服务端没有配置；保留“可能已有”状态，让请求先由服务端用已保存凭据处理。
  const [serverCredentialsMayExist, setServerCredentialsMayExist] = useState(false);
  const [cloudWorkspace, setCloudWorkspace] = useState<CloudWorkspace | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: "offline" });
  const [quotaNotice, setQuotaNotice] = useState<{ title: string; text: string } | null>(null);
  const [noteSearch, setNoteSearch] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceSubView>("path");
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [reviewedTransferId, setReviewedTransferId] = useState<string | undefined>();
  const [reviewExplainBusy, setReviewExplainBusy] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const studyEndRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = sessions.find((s) => s.id === activeId);
  const course = active?.courseId ? getCourse(active.courseId) : undefined;
  const stage = course?.stages[active?.stageIndex ?? 0];
  const stageAnswer = stage && active ? resolveStageAnswer(stage, active) : null;
  const currentStep = active?.learningState?.steps.find(
    (step) => step.id === active.learningState?.currentStepId,
  );
  const currentFocus = active?.learningState?.detours.at(-1)?.topic ?? currentStep?.title;
  // 公共模式默认禁用网页内的个人密钥；本地开发保留 BYOK。
  const allowByok = !config.authRequired || config.allowByok !== false;
  const canUsePersonalKeys = allowByok && !!authUser;
  const hasPersonalSearchKey =
    !!settings.searchApiKey?.trim() ||
    !!settings.searchFallbacks?.some((item) => item.apiKey?.trim());
  const canUsePersonalSearch = canUsePersonalKeys && hasPersonalSearchKey;
  // 登录且开启个人密钥后，不再用服务端共享搜索/模型兜底。
  const canAutoSearch = canUsePersonalKeys
    ? canUsePersonalSearch || settings.searchProvider === "you"
    : config.webSearchEnabled;
  const ready = canUsePersonalKeys
    ? !!settings.apiKey?.trim() || serverCredentialsMayExist
    : config.configured;

  useEffect(() => {
    if (!credentialsLoading && !canAutoSearch) setWebSearchOn(false);
  }, [credentialsLoading, canAutoSearch]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    fetch("/api/config", {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((value: unknown) => {
        if (cancelled) return;
        setConfig(normalizeServerConfig(value));
        setConfigError(null);
        setApiAvailable(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setApiAvailable(false);
        setConfigError(
          e instanceof Error && e.name === "AbortError"
            ? "读取运行配置超时，无法确认登录要求。"
            : "无法连接知序服务，无法确认登录要求。",
        );
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancelled) setConfigReady(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

  /* ── 云同步：登录态、迁移与防抖上传 ──────────────────────────── */

  const fetcher: Fetcher = useCallback(
    (input, init) => fetch(input, init),
    [],
  );
  // 引用最新状态，让同步与回调不依赖 effect 闭包的过期快照。
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const deletedNoteIdsRef = useRef(deletedNoteIds);
  deletedNoteIdsRef.current = deletedNoteIds;
  const settingsUpdatedAtRef = useRef(settingsUpdatedAt);
  settingsUpdatedAtRef.current = settingsUpdatedAt;
  /** 墓碑变化同时写入内存引用、React 状态和独立 localStorage 键。 */
  const rememberDeletedNoteIds = useCallback((ids: string[]) => {
    const next = normalizeDeletedNoteIds(ids);
    const current = deletedNoteIdsRef.current;
    if (
      next.length === current.length &&
      next.every((id, index) => id === current[index])
    ) {
      return;
    }
    deletedNoteIdsRef.current = next;
    setDeletedNoteIds(next);
    persistDeletedNoteIds(next);
  }, []);
  /** 设置保存或云端版本更新后记录新的版本时间并持久化。 */
  const rememberSettingsUpdatedAt = useCallback((value: number) => {
    const next = resolveSettingsUpdatedAt(value);
    if (next === settingsUpdatedAtRef.current) return;
    settingsUpdatedAtRef.current = next;
    setSettingsUpdatedAt(next);
    persistSettingsUpdatedAt(next);
  }, []);
  const authUserRef = useRef(authUser);
  authUserRef.current = authUser;
  const cloudWorkspaceRef = useRef<CloudWorkspace | null>(cloudWorkspace);
  cloudWorkspaceRef.current = cloudWorkspace;
  const authChannelRef = useRef<BroadcastChannel | null>(null);
  const syncInFlightRef = useRef(false);
  const syncTimerRef = useRef<number | null>(null);
  const pendingSyncRef = useRef(false);

  /** 当前本地学习数据快照（密钥永不进入；review/diagnostic 从会话汇总）。 */
  const localBackupData = useCallback(() => {
    const current = sessionsRef.current;
    return {
      sessions: current,
      notes: notesRef.current,
      reviews: current.flatMap((session) => session.reviews ?? []),
      diagnostics: current
        .map((session) => session.diagnostic)
        .filter((profile): profile is DiagnosticProfile => !!profile),
      activity: activityRef.current,
      deletedNoteIds: deletedNoteIdsRef.current,
      settingsUpdatedAt: settingsUpdatedAtRef.current,
    };
  }, []);

  /**
   * 登录/恢复后把本地状态从旧基准迁移到当前服务端基准。
   * 正常情况下本地写入已用 calibratedNow，delta 为 0；只有升级前
   * 按设备时钟写入的旧数据需要一次性换算，避免未来时间戳压过云端。
   */
  const normalizeLocalClockBaseline = useCallback(() => {
    const offset = getClockOffset();
    const delta = offset - readLocalClockBaseline();
    if (delta !== 0) {
      const shifted = shiftLocalWorkspaceClock(localBackupData(), delta);
      // setState 要到下一次渲染才更新 ref，而 handleSignedIn 随后会同步调用
      // applyCloudData；这里先同步 ref，避免它继续读到未换算的旧快照。
      sessionsRef.current = shifted.sessions;
      notesRef.current = shifted.notes;
      setSessions(shifted.sessions);
      setNotes(shifted.notes);
      if (shifted.settingsUpdatedAt !== undefined) {
        rememberSettingsUpdatedAt(shifted.settingsUpdatedAt);
      }
    }
    markLocalClockBaseline(offset);
  }, [localBackupData, rememberSettingsUpdatedAt, setNotes, setSessions]);

  /**
   * 把云端备份合并进本地状态：双方数据都保留，与导入备份同一约定。
   * 墓碑取并集并过滤笔记；设置只有云端版本更新时才覆盖本地，
   * 本地设置从未带版本时沿用旧的“采用云端设置”迁移行为。
   * 本地时间戳先按当前时钟校准换算到服务端基准，再参与 LWW 比较。
   */
  const applyCloudData = useCallback(
    (backup: StudyBackup) => {
      const offset = getClockOffset();
      const merged = mergeCloudBackupIntoLocal(
        localBackupData(),
        settingsRef.current,
        backup,
        {
          localClockOffset: readLocalClockBaseline(),
          serverClockOffset: offset,
        },
      );
      setSessions(attachSessionExtras(merged));
      setNotes(merged.notes);
      setActivity(merged.activity);
      rememberDeletedNoteIds(merged.deletedNoteIds);
      const nextSettings = mergeImportedSettings(
        settingsRef.current,
        merged.settingsWithoutSecrets,
      );
      setSettings(nextSettings);
      try {
        saveSafeSettings(nextSettings);
      } catch {
        notifyRef.current("已合并云端数据，但模型设置无法保存到本机浏览器。");
      }
      rememberSettingsUpdatedAt(merged.settingsUpdatedAt);
      markLocalClockBaseline(offset);
    },
    [
      localBackupData,
      rememberDeletedNoteIds,
      rememberSettingsUpdatedAt,
      setSessions,
      setNotes,
      setActivity,
    ],
  );

  /**
   * 启动时先做一次本地时钟基准迁移：浏览器可能带着上一次的校准值和旧版本
   * 按设备时钟写入的数据，必须在用户继续写入前统一到服务端基准。
   */
  useEffect(() => {
    normalizeLocalClockBaseline();
  }, [normalizeLocalClockBaseline]);

  /**
   * 换账户前把本机未归属记录另存为独立备份键（不进入新账户云端）。
   * 返回键名供界面提示；密钥不会写入。
   */
  const archiveLocalStudyData = useCallback(
    (reason: string, archivedAt = localNow()): string | null => {
      try {
        const backup = createBackup({
          ...localBackupData(),
          settingsWithoutSecrets: settingsWithoutSecretsOf(settingsRef.current),
          exportedAt: archivedAt,
        });
        const key = `zhixu.orphan.${reason}.${archivedAt}`;
        localStorage.setItem(key, JSON.stringify(backup));
        return key;
      } catch {
        return null;
      }
    },
    [localBackupData],
  );

  /** 清空本机学习数据与非敏感设置（换账户 / 删除账户）。先删键，避免存储层把旧记录合并回来。 */
  const clearLocalStudyData = useCallback(() => {
    setSessions([]);
    setNotes([]);
    setActivity([]);
    setSettings({ ...defaults });
    rememberDeletedNoteIds([]);
    rememberSettingsUpdatedAt(0);
    setActiveId(null);
    setView("home");
    setTab("lesson");
    setWorkspaceView("path");
    setPrompt("");
    setLearningGoal("");
    setReferences([]);
    setChatInput("");
    setNoteEditor(null);
    setDeleteNoteId(null);
    setSettingsOpen(false);
    cancelPending();
    setError(null);
    setBackupError(null);
    setBookLocation(null);
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("zhixu.v1.")) localStorage.removeItem(key);
      }
    } catch {
      /* 存储不可用时状态已清空；持久化失败由 storageError 提示。 */
    }
  }, [rememberDeletedNoteIds, rememberSettingsUpdatedAt, setSessions, setNotes, setActivity]);

  /**
   * 唯一派发入口：先用纯 reducer 算出下一状态与 effects，再同步执行 effects。
   * 归档结果会立即通过 ARCHIVE_OK / ARCHIVE_FAIL 回到 reducer，因此
   * handleSignedIn 可以在同一次调用里拿到“放行还是 blocked”的确定结果。
   */
  const dispatchAccountSwitchRef = useRef<(event: AccountSwitchEvent) => AccountSwitchState>(
    () => initialAccountSwitchState,
  );
  const dispatchAccountSwitch = useCallback(
    (event: AccountSwitchEvent): AccountSwitchState => {
      const transition = accountSwitchReducer(accountSwitchStateRef.current, event);
      accountSwitchStateRef.current = transition.state;
      dispatchAccountSwitchAction(event);

      for (const effect of transition.effects) {
        if (effect.type === "archive") {
          const archiveKey = archiveLocalStudyData(
            effect.reason ?? "account-switch",
            effect.requestedAt,
          );
          return dispatchAccountSwitchRef.current(
            archiveKey
              ? { type: "ARCHIVE_OK", archiveKey, timestamp: effect.requestedAt }
              : {
                  type: "ARCHIVE_FAIL",
                  error: "旧本机学习记录无法建立安全备份",
                  timestamp: effect.requestedAt,
                },
          );
        }
        if (effect.type === "clearLocal") {
          clearLocalStudyData();
        } else if (effect.type === "setAuthUser") {
          setBookOwner(effect.user.id);
          setAuthUser(effect.user);
        }
      }
      return transition.state;
    },
    [archiveLocalStudyData, clearLocalStudyData],
  );
  dispatchAccountSwitchRef.current = dispatchAccountSwitch;

  /** 防抖上传：登录后本地数据变化时调用，冲突自动重取合并再试一次。 */
  const performSync = useCallback(
    async () => {
      const ownerId = authUserRef.current?.id;
      if (!ownerId) return;
      if (syncInFlightRef.current) {
        // 同步期间本地又有变化：等本轮结束后补一次，避免这次改动被丢掉。
        pendingSyncRef.current = true;
        return;
      }
      // 异步返回时账户可能已切换；所有响应只能落入发起同步的账户。
      const stillOwner = () => authUserRef.current?.id === ownerId;
      syncInFlightRef.current = true;
      setSyncStatus({ state: "syncing" });
      try {
        // 没有已知 workspace（如刷新会话）时先拉取，避免用空数据覆盖云端。
        const knownBefore = cloudWorkspaceRef.current;
        const known = knownBefore ?? (await getWorkspace(fetcher, ownerId));
        if (!stillOwner()) return;
        const result = await syncWorkspace(fetcher, {
          expectedUserId: ownerId,
          local: localBackupData(),
          settingsWithoutSecrets: settingsWithoutSecretsOf(settingsRef.current),
          workspace: known,
          // App 写入的 updatedAt 已使用 calibratedNow，不能再叠加一次偏移。
          localClockCalibrated: true,
        });
        if (!stillOwner()) return;
        setCloudWorkspace(result.workspace);
        setSyncStatus({ state: "synced", at: Date.now() });
        // 冲突重取或云端已领先时，其他设备的条目也要并回本机。
        // 不能只看 PUT 是否发生：云端本身较新时 syncWorkspace 正确地不写库。
        if (
          result.refreshed ||
          (!knownBefore && known.data !== null) ||
          (result.workspace.data !== null &&
            JSON.stringify(result.outcome.backup) !== JSON.stringify(result.workspace.data))
        ) {
          applyCloudData(result.outcome.backup);
        }
      } catch (e) {
        if (!stillOwner()) return;
        if (e instanceof CloudSyncError && e.status === 401) {
          // 会话过期：回到未登录，停止同步；本地数据保留。
          pendingSyncRef.current = false;
          handleSignedOutRef.current({
            notify: true,
            reason: "登录已过期，请重新登录后继续云同步。",
          });
          return;
        }
        const suffix =
          e instanceof CloudSyncError && e.status === 429 && e.retryAfter
            ? `（约 ${Math.max(1, Math.ceil(e.retryAfter / 60))} 分钟后可重试）`
            : "";
        setSyncStatus({
          state: "error",
          message: `${
            e instanceof Error && e.message ? e.message : "同步失败，请稍后重试。"
          }${suffix}`,
        });
      } finally {
        syncInFlightRef.current = false;
        if (pendingSyncRef.current && authUserRef.current) {
          pendingSyncRef.current = false;
          window.setTimeout(() => void performSyncRef.current(), 250);
        }
      }
    },
    [applyCloudData, fetcher, localBackupData],
  );
  const performSyncRef = useRef(performSync);
  performSyncRef.current = performSync;
  const notifyRef = useRef<(text: string) => void>(() => {});

  /**
   * 登录成功：云端为空时把本地数据迁移上传；云端有数据时先并入本地再上传，
   * 保证换设备 / 首次注册两条路径下双方数据都不丢。
   * 同一浏览器切换到另一个账户时，先清空上一个账户残留的本机数据，
   * 只恢复新账户自己的云端备份，绝不把别人的学习记录合并进新账户。
   */
  const handleSignedIn = useCallback(
    (
      user: AuthUser,
      result: { revision: number; data: StudyBackup | null } | null,
      options?: { discardLocalData?: boolean },
    ) => {
      const workspace: CloudWorkspace | null = result
        ? { revision: result.revision, data: result.data }
        : null;
      let previousUser: string | null = null;
      try {
        previousUser = localStorage.getItem(LAST_USER_KEY);
      } catch {
        previousUser = null;
      }
      const unownedLocalRecords =
        sessionsRef.current.length > 0 || notesRef.current.length > 0;
      const switchingAccount = !!previousUser && previousUser !== user.id;
      const adoptingUnownedRecords =
        !previousUser && !!workspace?.data && unownedLocalRecords;
      const switching = switchingAccount || adoptingUnownedRecords;
      const archiveReason: AccountSwitchReason = switchingAccount
        ? "account-switch"
        : "unowned";

      pendingAccountSwitchRef.current = null;

      if (
        accountSwitchStateRef.current.phase === "archiving" ||
        accountSwitchStateRef.current.phase === "switching"
      ) {
        // 已有切换在进行，忽略重复登录回调，避免重复归档或身份竞态。
        return;
      }
      if (!switching && accountSwitchStateRef.current.phase === "blocked") {
        // 阻塞弹窗属于另一次身份切换尝试；当前登录不需要门禁，先收起旧弹窗。
        dispatchAccountSwitch({ type: "CANCEL", timestamp: Date.now() });
      }

      if (!switching) {
        // 非换账户登录没有归档门禁：沿用同步适配器直接确认身份。
        applyAccountSwitchGate({
          switching: false,
          hasLocalRecords: unownedLocalRecords,
          reason: archiveReason,
          archive: archiveLocalStudyData,
          user,
          setAuthUser: (nextUser) => {
            setBookOwner(nextUser.id);
            setAuthUser(nextUser);
          },
        });
        // 登录响应已带 serverTime 并完成校准：先把旧本地数据迁移到
        // 服务端基准，后续 applyCloudData 与本地写入才在同一时间轴上。
        normalizeLocalClockBaseline();
      } else {
        // 换账户，或浏览器里的旧记录没有归属标记而云端已有数据：
        // 所有状态转换交给 accountSwitchReducer；归档失败保持旧身份，
        // 由 blocked 弹窗的重试/丢弃出口继续。
        const current = accountSwitchStateRef.current;
        if (current.phase === "blocked" && current.targetUser?.id !== user.id) {
          dispatchAccountSwitch({ type: "CANCEL", timestamp: Date.now() });
        }

        const blocked = accountSwitchStateRef.current.phase === "blocked";
        const gateState = blocked
          ? dispatchAccountSwitch(
              options?.discardLocalData
                ? { type: "DISCARD_AND_CONTINUE", timestamp: Date.now() }
                : { type: "RETRY", reason: archiveReason, timestamp: Date.now() },
            )
          : dispatchAccountSwitch({
              type: "START_SWITCH",
              targetUser: user,
              requiresArchive: unownedLocalRecords && !options?.discardLocalData,
              reason: archiveReason,
              timestamp: Date.now(),
            });

        if (gateState.phase === "blocked") {
          setBookOwner(previousUser ?? authUserRef.current?.id ?? null);
          setCredentialsLoading(false);
          pendingAccountSwitchRef.current = {
            user,
            result,
            previousUser,
            reason: archiveReason,
          };
          notifyRef.current(
            "旧本机学习记录无法建立安全备份，已保留在当前浏览器。请先导出备份或清理空间后重试，也可以选择丢弃本机旧数据并继续切换。",
          );
          return;
        }
      }

      const archivedKey = accountSwitchStateRef.current.archiveKey ?? null;
      setCredentialsLoading(true);
      // 新账户尚未读取云端配置：先按“服务端可能已有”处理，避免误报未配置。
      setServerCredentialsMayExist(true);
      // 上一个身份的内存密钥绝不能沿用到新账户。
      setSettings((previous) => clearPersonalKeys(previous));
      authChannelRef.current?.postMessage({ type: "login", userId: user.id });
      setCloudWorkspace(workspace);
      // 旧本机记录已归档（或按用户选择丢弃）；clearLocal 已由 reducer effect 执行，
      // 这里只恢复新账户自己的云端备份。
      if (switching) {
        if (workspace?.data) {
          const cloudDeletedNoteIds = workspace.data.deletedNoteIds ?? [];
          const cloudDeleted = new Set(cloudDeletedNoteIds);
          setSessions(attachSessionExtras(workspace.data));
          setNotes(workspace.data.notes.filter((note) => !cloudDeleted.has(note.id)));
          setActivity(workspace.data.activity);
          rememberDeletedNoteIds(cloudDeletedNoteIds);
          const restoredSettings = mergeImportedSettings(
            { ...defaults },
            workspace.data.settingsWithoutSecrets,
          );
          setSettings(restoredSettings);
          try {
            saveSafeSettings(restoredSettings);
          } catch {
            notifyRef.current("已恢复云端数据，但模型设置无法保存到本机浏览器。");
          }
          rememberSettingsUpdatedAt(resolveSettingsUpdatedAt(workspace.data.settingsUpdatedAt));
        }
        // 新账户数据直接来自服务端，本地状态从此刻起就是服务端基准。
        markLocalClockBaseline(getClockOffset());
        if (switchingAccount)
          notifyRef.current(
            archivedKey
              ? `已切换账户；旧本机记录未上传，已保存在浏览器备份键 ${archivedKey}。`
              : options?.discardLocalData
                ? "已切换账户；本机旧记录已按你的选择丢弃，未上传。"
                : "已切换账户；旧本机记录未上传。",
          );
        else
          notifyRef.current(
            archivedKey
              ? `检测到未归属旧记录；已仅载入账户云端数据，旧记录保存在浏览器备份键 ${archivedKey}。`
              : "检测到未归属旧记录；已仅载入账户云端数据，未上传旧记录。",
          );
      } else if (workspace?.data) {
        // applyCloudData 内部按设置版本决定是否覆盖本地设置，并同步墓碑。
        applyCloudData(workspace.data);
      }
      try {
        localStorage.setItem(LAST_USER_KEY, user.id);
      } catch {
        /* 存储不可用时只是无法识别换账户；数据仍按当前账户隔离在服务端。 */
      }
      setSyncStatus(
        workspace
          ? { state: "syncing" }
          : { state: "error", message: "云端数据读取失败，稍后会自动重试。" },
      );
      // 门禁与身份/本地数据切换都已执行完毕，状态机进入 done；
      // 若归档成功路径已是 done，reducer 会忽略这次完成事件。
      if (switching) {
        dispatchAccountSwitch({ type: "SWITCH_COMPLETE", timestamp: Date.now() });
      }
      window.setTimeout(() => void performSyncRef.current(), 0);
    },
    [
      applyCloudData,
      archiveLocalStudyData,
      dispatchAccountSwitch,
      normalizeLocalClockBaseline,
      rememberDeletedNoteIds,
      rememberSettingsUpdatedAt,
    ],
  );

  /** 归档失败后重试：用户可先导出备份或清理空间，再走同一套归档判定。 */
  function retryAccountSwitch() {
    const pending = pendingAccountSwitchRef.current;
    if (!pending) return;
    handleSignedIn(pending.user, pending.result);
  }

  /** 明确确认丢弃本机旧数据后跳过归档，直接完成身份切换。 */
  function discardLocalDataAndSwitch() {
    const pending = pendingAccountSwitchRef.current;
    if (!pending) return;
    handleSignedIn(pending.user, pending.result, {
      discardLocalData: true,
    });
  }

  /** 归档失败时仍允许先导出本机旧记录；导出不写 localStorage，不受配额限制。 */
  function exportPendingAccountSwitchBackup() {
    try {
      const backup = createBackup({
        ...localBackupData(),
        settingsWithoutSecrets: settingsWithoutSecretsOf(settingsRef.current),
        exportedAt: localNow(),
      });
      downloadText(
        `知序旧账户备份-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(backup, null, 2),
      );
      notify("已导出当前浏览器中的旧学习记录备份（不含 API 密钥）。");
    } catch {
      notify("导出备份失败，请检查浏览器的下载权限。");
    }
  }

  /** 退出登录 / 删除账户 / 会话过期：停止同步。个人配置保留在服务端。 */
  const handleSignedOut = useCallback(
    (options: { notify: boolean; wipeLocal?: boolean; reason?: string }) => {
      const previousUserId = authUserRef.current?.id;
      pendingAccountSwitchRef.current = null;
      dispatchAccountSwitch({ type: "CANCEL", timestamp: Date.now() });
      if (previousUserId) {
        authChannelRef.current?.postMessage({ type: "logout", userId: previousUserId });
      }
      pendingSyncRef.current = false;
      setBookOwner(null);
      setAuthUser(null);
      setCredentialsLoading(false);
      setServerCredentialsMayExist(false);
      setSettings((previous) => clearPersonalKeys(previous));
      setSettingsOpen(false);
      cancelPending();
      setCloudWorkspace(null);
      setSyncStatus({ state: "offline" });
      if (options.wipeLocal) clearLocalStudyData();
      if (options.notify) notifyRef.current(options.reason ?? "已退出登录。");
    },
    [clearLocalStudyData, dispatchAccountSwitch],
  );

  // 同源多标签页共享 Cookie 与 localStorage；其他标签页换号/退出后，
  // 旧页面必须立即重载，不能继续用旧身份向新账户同步。
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("zhixu.auth");
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!value || typeof value !== "object") return;
      const data = value as { type?: unknown; userId?: unknown };
      if (typeof data.userId !== "string") return;
      const current = authUserRef.current?.id;
      if (data.type === "login" && current && current !== data.userId) {
        window.location.reload();
      } else if (data.type === "logout" && current === data.userId) {
        window.location.reload();
      }
    };
    authChannelRef.current = channel;
    return () => {
      authChannelRef.current = null;
      channel.close();
    };
  }, []);

  // 启动：读取配置与登录态。authRequired 模式未登录时不渲染主应用。
  useEffect(() => {
    let cancelled = false;
    cloudMe(fetcher)
      .then(async (user) => {
        // 云端快照未知时不能进入自动合并/上传：否则无法判断本机旧记录归属。
        // 读取失败就让用户重新登录；登录响应本身携带受校验的 workspace。
        const workspace = await getWorkspace(fetcher, user.id);
        if (cancelled) return;
        handleSignedIn(user, { revision: workspace.revision, data: workspace.data });
      })
      .catch(() => {
        /* 未登录、服务不可达或云端快照未知：停留在登录门禁，不自动同步。 */
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, handleSignedIn]);

  useEffect(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (
          key.startsWith("zhixu.v1.personal-credentials.") ||
          key.startsWith("zhixu.v1.fallback-credentials.")
        ) {
          localStorage.removeItem(key);
        }
      }
    } catch {
      /* 浏览器存储不可用时没有旧凭据可清理。 */
    }
  }, []);

  // 登录后从服务端读取当前账户的个人配置；浏览器不保存 Key。
  useEffect(() => {
    let cancelled = false;
    if (!authUser || !canUsePersonalKeys) {
      setCredentialsLoading(false);
      setServerCredentialsMayExist(false);
      setSettings((previous) =>
        previous.apiKey ||
        previous.searchApiKey ||
        previous.modelFallbacks?.length ||
        previous.searchFallbacks?.length
          ? clearPersonalKeys(previous)
          : previous,
      );
      return;
    }
    setCredentialsLoading(true);
    // 读取完成前按“可能已有”处理，避免刚登录时的空本地状态阻断请求。
    setServerCredentialsMayExist(true);
    readServerCredentials(fetcher, authUser.id)
      .then((result) => {
        if (cancelled) return;
        if (result.state === "missing") {
          setServerCredentialsMayExist(false);
          return;
        }
        if (result.state === "unknown") {
          // 网络错误/服务端异常：保留“可能已有”，本次请求交给服务端判断。
          setServerCredentialsMayExist(true);
          return;
        }
        setServerCredentialsMayExist(true);
        setSettings(result.settings);
        try {
          saveSafeSettings(result.settings);
        } catch {
          /* 非敏感配置持久化失败由设置保存路径提示。 */
        }
      })
      .finally(() => {
        if (!cancelled) setCredentialsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser, canUsePersonalKeys, fetcher]);

  // sessions / notes / activity 变化后防抖上传（仅登录后）。
  useEffect(() => {
    if (!authUser) return;
    if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      syncTimerRef.current = null;
      void performSyncRef.current();
    }, 2500);
    return () => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, [sessions, notes, activity, settings, settingsUpdatedAt, deletedNoteIds, authUser]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setHintCount(0);
    setExampleOpen(false);
    setError(null);
    setTransferError(null);
    setDiagnosticError(null);
    setReviewedTransferId(undefined);
  }, [activeId, active?.stageIndex, view]);
  useEffect(() => {
    if (active?.messages.length)
      studyEndRef.current?.scrollIntoView({
        behavior: "instant",
        block: "end",
      });
  }, [active?.messages.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
      const target = e.target as HTMLElement | null;
      if (
        e.key.toLowerCase() === "n" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !target?.closest('input, textarea, select, [contenteditable="true"]') &&
        !document.querySelector("dialog[open]")
      ) {
        setView("home");
        setActiveId(null);
        setMobileOpen(false);
        setFocus(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!active?.quizSubmitted && !active?.learningState?.misconceptions.length) return;
    const frame = requestAnimationFrame(() => ensureReviews(active));
    return () => cancelAnimationFrame(frame);
  }, [active?.id, active?.quizSubmitted, active?.quizAnswers, active?.learningState]);
  useEffect(() => {
    if (!mobileOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.querySelector<HTMLButtonElement>(".sidebar .brand")?.focus();
    return () => previousFocus?.focus();
  }, [mobileOpen]);

  function notify(text: string) {
    setToast(text);
  }
  notifyRef.current = notify;
  /** 公共模式禁止 BYOK，或当前未登录时，请求里绝不携带个人密钥。 */
  function settingsForRequest(base: ProviderSettings): ProviderSettings {
    return canUsePersonalKeys ? base : clearPersonalKeys(base);
  }
  /**
   * 缺少本地 Key 时，只有明确知道服务端也没有保存凭据才要求先配置。
   * 读取失败时保持“服务端可能已有”，让请求发出由服务端用已保存凭据处理。
   */
  function needsModelConfiguration(chosen: ProviderSettings): boolean {
    return requiresModelSetup({
      canUsePersonalKeys,
      hasLocalApiKey: !!chosen.apiKey?.trim(),
      serverCredentialsMayExist,
      serverConfigured: config.configured,
    });
  }
  /** 429 时把服务端给出的额度说明展示给用户（含重置时间或 Retry-After）。 */
  function showQuotaNotice(value: unknown, retryAfter: string | null) {
    let text = "今天的额度已用完，请稍后再试。";
    let title = "今天的额度已用完";
    let resetAt: number | null = null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if ("error" in value && typeof value.error === "string" && value.error) {
        text = value.error;
      }
      if ("code" in value && typeof value.code === "string" && value.code === "rate_limited") {
        title = "请求太频繁";
      }
      if (
        "resetAt" in value &&
        typeof value.resetAt === "number" &&
        Number.isFinite(value.resetAt)
      ) {
        resetAt = value.resetAt;
      }
    }
    if (resetAt !== null) {
      text += ` 将于 ${new Date(resetAt).toLocaleTimeString()} 重置。`;
    } else if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        const hint =
          seconds <= 90
            ? `${Math.max(1, Math.round(seconds))} 秒`
            : seconds < 3600
              ? `${Math.ceil(seconds / 60)} 分钟`
              : `${Math.ceil(seconds / 3600)} 小时`;
        text += ` 请约 ${hint}后重试。`;
      }
    }
    setQuotaNotice({ title, text });
  }
  const handleSignedOutRef = useRef(handleSignedOut);
  handleSignedOutRef.current = handleSignedOut;
  function updateSession(
    id: string,
    changes:
      | Partial<StudySession>
      | ((previous: StudySession) => Partial<StudySession>),
  ) {
    setSessions((previous) =>
      previous.map((s) => {
        if (s.id !== id) return s;
        const patch = typeof changes === "function" ? changes(s) : changes;
        // 后台整理不产生真实变更时，不把旧设备时间戳刷新成“最新”。
        if (Object.keys(patch).length === 0) return s;
      const merged = { ...s, ...patch };
      // 同一会话写回时若恰好同毫秒，明确使用更新快照，避免旧学习状态残留。
      // 统一用校准后的服务端时间，避免设备时钟偏差制造未来时间戳。
      merged.updatedAt = Math.max(localNow(), s.updatedAt + 1);
      return merged;
      }),
    );
  }
  function changeActive(changes: Partial<StudySession>) {
    if (active) {
      updateSession(active.id, changes);
      recordActivity();
    }
  }
  function navigate(next: View) {
    setView(next);
    setMobileOpen(false);
    setError(null);
  }
  function openSession(session: StudySession, nextTab: StudyTab = "lesson") {
    // 草稿属于具体会话：切到另一会话时清空，避免 A 的未发送内容出现在 B。
    setChatInput((draft) => draftForSessionSwitch(activeId, session.id, draft));
    setActiveId(session.id);
    setTab(nextTab);
    navigate("study");
  }
  function openBookSource(location: BookSourceLocation) {
    setBookLocation({ ...location });
    setFocus(false);
    navigate("books");
  }
  function startBookStudy(book: BookDocument, selection: BookStudySelection) {
    if (requestInFlight.current) {
      notify("请先完成或停止当前教学回合，再开启书籍陪读");
      return;
    }
    try {
      const prepared = prepareBookStudy(book, selection);
      const existing = selection.mode !== "review" && sessions.find(session =>
        session.bookContext?.bookId === book.id &&
        session.bookContext.mode === selection.mode &&
        session.bookContext.chapterId === prepared.context.chapterId &&
        session.bookContext.suppliedBlockIds.join("|") === prepared.context.suppliedBlockIds.join("|")
      );
      if (existing) {
        openSession(existing);
        return;
      }
      const session: StudySession = {
        ...createSession(prepared.topic, level, prepared.references.map(reference => ({ ...reference, text: "" }))),
        goal: selection.mode === "review" ? "依据原文主动回忆，区分看过与真正理解" : "结合原文理解作者的论证，并能自己解释和应用",
        bookContext: prepared.context,
      };
      void runAI("start", prepared.prompt, session);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "未能准备这段书籍内容");
    }
  }
  function saveBookNote(content: string, title: string) {
    const now = localNow();
    setNoteEditor({ id: uid(), sessionId: "", title, content, createdAt: now, updatedAt: now });
  }
  function openCourse(id: string) {
    const found = getCourse(id);
    if (!found) return;
    const existing = sessions.find((s) => s.courseId === id);
    if (existing) {
      openSession(existing);
      return;
    }
    const session = {
      ...createSession(found.title, found.level),
      courseId: found.id,
      plan: found.stages.map((s) => s.title),
      quiz: found.quiz,
      flashcards: found.flashcards,
    };
    setSessions((previous) => [session, ...previous]);
    openSession(session);
    recordActivity();
  }
  function saveNote(content: string, title?: string) {
    if (!content.trim()) return;
    if (
      notes.some(
        (n) => n.content === content && n.sessionId === (active?.id ?? ""),
      )
    ) {
      notify("这段内容已经在你的知识笔记中了");
      return;
    }
    const note: Note = {
      id: uid(),
      sessionId: active?.id ?? "",
      title: title ?? active?.title ?? "学习笔记",
      content,
      createdAt: localNow(),
      updatedAt: localNow(),
    };
    setNotes((previous) => [note, ...previous]);
    notify("已收藏到知识笔记");
    recordActivity();
  }
  function exportSession() {
    if (!active) return;
    const sections = [
      `# ${active.title}`,
      `学习基础：${active.level}\n\n初始学习目标：${active.goal}`,
    ];
    if (active.bookContext) sections.push(`## 书籍学习范围\n\n《${active.bookContext.title}》${active.bookContext.author ? ` · ${active.bookContext.author}` : ""}\n\n${active.bookContext.chapterTitle ?? "目录导览"}；本轮提供 ${active.bookContext.suppliedBlockIds.length}/${active.bookContext.totalBlocks} 段。${active.bookContext.completeBook ? "已提供全部提取文本" : "未提供部分不代表已经通读"}；阅读进度不等于掌握。`);
    function formatTrack(track: LearningTrack): string {
      const lines = [`### 目标：${track.goal}`];
      for (const step of track.steps) {
        lines.push(`#### ${step.title} · ${masteryLabels[step.mastery]}`);
        if (!step.evidence.length) lines.push("尚无独立作答证据。");
        for (const evidence of step.evidence)
          lines.push(
            `原问题：${evidence.question ?? "未保存原问题"}\n\n我的回答：${evidence.quote}\n\n证据类型：${evidence.kind}`,
          );
      }
      if (track.pendingQuestion)
        lines.push(`#### 待继续的问题\n\n${track.pendingQuestion.prompt}`);
      for (const detour of track.detours)
        lines.push(
          `#### 临时插问：${detour.topic}\n\n返回主线后继续：${detour.returnQuestion?.prompt ?? "原步骤讲解"}`,
        );
      if (track.misconceptions.length)
        lines.push(
          "#### 误区与修复记录\n\n" +
            track.misconceptions
              .map(
                (item) =>
                  `- ${item.topic}：${item.description}（${item.status === "resolved" ? "已通过迁移核验" : "待巩固"}）\n  当时的回答：${item.evidenceQuote}`,
              )
              .join("\n"),
        );
      if (track.assumptions.length)
        lines.push(
          "#### 采用的前提\n\n" +
            track.assumptions.map((item) => `- ${item}`).join("\n"),
        );
      return lines.join("\n\n");
    }
    if (course)
      sections.push(
        "## 课程路线（检查完成不等于全面掌握）\n\n" +
          course.stages
            .map(
              (item) =>
                `- [${active.completedStages.includes(item.id) ? "x" : " "}] ${item.title}`,
            )
            .join("\n"),
      );
    else if (!active.learningState && active.plan.length)
      sections.push(
        "## 旧学习路线（尚无理解证据）\n\n" +
          active.plan.map((item) => `- ${item}`).join("\n"),
      );
    if (active.learningState) {
      sections.push(
        "## AI 引导学习与理解证据\n\n" + formatTrack(active.learningState),
      );
      for (const track of active.learningState.savedTracks)
        sections.push("## 暂停的主线\n\n" + formatTrack(track));
      if (active.learningState.deferredTopics.length)
        sections.push(
          "## 待学主题\n\n" +
            active.learningState.deferredTopics
              .map((item) => `- ${item}`)
              .join("\n"),
        );
    }
    if (course)
      sections.push(
        "## 课程讲解\n\n" +
          course.stages
            .map(
              (item) =>
                `### ${item.title}\n\n${item.content}\n\n另一个例子：${item.example}`,
            )
            .join("\n\n"),
      );
    if (active.messages.length)
      sections.push(
        "## 学习对话\n\n" +
          active.messages
            .map(
              (message) =>
                `### ${message.role === "user" ? "我" : "知序"}${message.delivery === "failed" ? " · 未获导师回复" : ""}\n\n${message.content}${message.teaching?.sources.length ? `\n\n材料引文：\n\n${message.teaching.sources.map(source => `> ${source.quote.replace(/\n/g, "\n> ")}\n\n出处：${source.name}${source.location ? ` · ${source.location.locator}` : ""}`).join("\n\n")}` : ""}`, 
            )
            .join("\n\n"),
      );
    if (active.quiz.length)
      sections.push(
        "## 随堂练习\n\n" +
          active.quiz
            .map((question, index) => {
              const selected = active.quizAnswers[question.id];
              const answer =
                selected === undefined
                  ? "尚未作答"
                  : `${String.fromCharCode(65 + selected)}. ${question.options[selected]}`;
              return `### ${index + 1}. ${question.question}\n\n${question.options.map((option, i) => `${String.fromCharCode(65 + i)}. ${option}`).join("\n\n")}\n\n我的选择：${answer}${active.quizSubmitted ? `\n\n正确答案：${String.fromCharCode(65 + question.correctIndex)}\n\n解析：${question.explanation}` : ""}`;
            })
            .join("\n\n"),
      );
    if (active.flashcards.length)
      sections.push(
        "## 记忆卡片\n\n" +
          active.flashcards
            .map((card) => `### ${card.front}\n\n${card.back}`)
            .join("\n\n"),
      );
    if (active.references.length)
      sections.push(
        "## 参考资料\n\n仅记录名称与网页链接，正文请保留原始来源。\n\n" +
          active.references
            .map((reference) => `- ${reference.name}${reference.url ? `（${reference.url}）` : ""}`)
            .join("\n"),
      );
    downloadText(
      `${active.title.replace(/[\\/:*?"<>|]/g, "-")}.md`,
      sections.join("\n\n"),
    );
    notify("学习记录与理解证据已导出为 Markdown");
  }
  async function uploadReference(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    // 只有学习页的附件属于当前会话；首页即使还保留 activeId，错误也必须用空
    // sessionId 写入，否则首页的 `!error.sessionId` 过滤会把它藏起来。
    const studySession = view === "study" ? active : undefined;
    const errorSessionId = attachmentErrorSessionId(view, studySession?.id ?? null);
    if (studySession?.bookContext) {
      setError({ sessionId: errorSessionId, text: "书籍陪读的原文范围由书架选择。请回到原书选择章节或段落，不把额外文件混入本书引用。" });
      return;
    }
    if (!/\.(txt|md|markdown)$/i.test(file.name)) {
      setError({
        sessionId: errorSessionId,
        text: "目前支持 .txt 和 Markdown 文本资料。请先将其他格式转换为文本。",
      });
      return;
    }
    if (file.size > 120_000) {
      setError({ sessionId: errorSessionId, text: "单份资料请控制在 120 KB 内，避免超过模型上下文限制。" });
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error("资料中没有可读取的文本。");
      if (text.includes("\u0000"))
        throw new Error("这份文件不是纯文本，请转换为 UTF-8 文本后再上传。");
      if (
        [
          ...(studySession ? studySession.references : references),
          { name: file.name, text },
        ].reduce((sum, r) => sum + r.text.length, 0) > 60_000
      )
        throw new Error(
          "资料总长度不能超过 60,000 字符，请拆分为更小的学习主题。",
        );
      const reference = { name: file.name, text };
      if (studySession)
        updateSession(studySession.id, {
          references: [...studySession.references, reference],
        });
      else setReferences((previous) => [...previous, reference]);
      notify("资料已添加；下一次 AI 对话会结合资料讲解");
      setError(null);
    } catch (e) {
      setError({ sessionId: errorSessionId, text: e instanceof Error ? e.message : "读取文件失败，请重试。" });
    }
  }

  async function addWebSource() {
    if (webSourceBusy) return;
    if (active?.bookContext && view === "study") {
      setWebSourceError("书籍陪读的来源由当前原书决定，不能混入网页资料。请在普通学习会话中添加网页。");
      return;
    }
    const url = webSourceUrl.trim();
    if (!url) {
      setWebSourceError("请填写公开 HTTPS 网页地址。");
      return;
    }
    setWebSourceBusy(true);
    setWebSourceError("");
    try {
      const response = await fetch("/api/web/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: WRITE_REQUEST_HEADERS,
        body: JSON.stringify({
          url,
          ...(webSourceClaim.trim() ? { claim: webSourceClaim.trim() } : {}),
        }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof value.error === "string" ? value.error : "网页抓取失败，请稍后重试。");
      }
      if (typeof value.text !== "string" || !value.text.trim() || typeof value.finalUrl !== "string") {
        throw new Error("网页没有返回可用的正文。");
      }
      const text = value.text;
      const currentReferences = active && view === "study" ? active.references : references;
      if ([...currentReferences, { name: "web", text }].reduce((sum, item) => sum + item.text.length, 0) > 60_000) {
        throw new Error("网页正文会使资料总长度超过 60,000 字符，请换更短的页面或拆分学习主题。");
      }
      const matched = value.claim?.matched === true && typeof value.claim.quote === "string";
      const verification: Reference["verification"] = matched ? "claim_matched" : "page_fetched";
      const name = String(value.title || new URL(value.finalUrl).hostname).slice(0, 300);
      const reference: Reference = {
        name,
        text,
        url: value.finalUrl,
        retrievedAt: typeof value.retrievedAt === "string" ? value.retrievedAt : new Date().toISOString(),
        verification,
        ...(matched ? { verifiedQuote: String(value.claim.quote) } : {}),
        ...(value.sourceTier === "official" || value.sourceTier === "primary" || value.sourceTier === "secondary" || value.sourceTier === "unknown"
          ? { sourceTier: value.sourceTier }
          : {}),
      };
      if (active && view === "study") {
        updateSession(active.id, { references: [...active.references, reference] });
      } else {
        setReferences((previous) => [...previous, reference]);
      }
      setWebSourceOpen(false);
      setWebSourceUrl("");
      setWebSourceClaim("");
      setError(null);
      if (value.claim && !matched) {
        notify("网页已添加，但没有找到你输入的逐字引文；该说法仍未核验。");
      } else if (matched) {
        notify("已找到网页逐字引文并添加来源；这只证明文字出现在页面中，不等于事实认证。");
      } else {
        notify("网页正文已添加为来源；引用时会保留网页地址和抓取时间。");
      }
    } catch (cause) {
      setWebSourceError(cause instanceof Error ? cause.message : "网页抓取失败，请稍后重试。");
    } finally {
      setWebSourceBusy(false);
    }
  }

  async function runAI(
    action: Action,
    text?: string,
    target?: StudySession,
    override?: ProviderSettings,
  ): Promise<{ response: ChatResponse; submittedAnswer?: string } | undefined> {
    if (requestInFlight.current) {
      notify("导师还在思考，完成后再继续吧");
      return undefined;
    }
    const chosen = settingsForRequest(override ?? settings);
    if (needsModelConfiguration(chosen)) {
      if (!allowByok) {
        notify("服务器尚未配置模型密钥，暂时无法调用 AI；请联系管理员配置后再使用。");
        return undefined;
      }
      setPending({ kind: "chat", action, text, target });
      setSettingsOpen(true);
      return undefined;
    }
    if (!navigator.locks) {
      notify("此浏览器不支持跨标签页互斥。请先关闭其他知序标签页再提问，避免重复回复。");
      return undefined;
    }
    const session =
      target ??
      active ??
      createSession(text?.trim() || prompt.trim(), level, references, learningGoal);
    if (!session.topic.trim()) return undefined;
    const effectiveAction =
      action === "message" &&
      !session.courseId &&
      !session.plan.length &&
      !session.messages.some((message) => message.role === "assistant")
        ? "start"
        : action;
    const isNew = !sessions.some((s) => s.id === session.id);
    let history = [...session.messages];
    let submittedMessageId: string | undefined;
    if (isNew && action === "start") {
      submittedMessageId = uid();
      history = [
        {
          id: submittedMessageId,
          role: "user",
          content: text?.trim() || session.topic,
          timestamp: localNow(),
        },
      ];
    } else if (text?.trim()) {
      const normalizedText = text.trim();
      const last = history.at(-1);
      if (last?.role === "user" && last.content === normalizedText) {
        submittedMessageId = last.id;
      } else {
        const retryIndex = history.findLastIndex(
          (message) =>
            message.role === "user" &&
            message.delivery === "failed" &&
            message.content === normalizedText,
        );
        if (retryIndex >= 0) {
          const [retry] = history.splice(retryIndex, 1);
          history.push(retry);
          submittedMessageId = retry.id;
        } else {
          submittedMessageId = uid();
          history.push({
            id: submittedMessageId,
            role: "user",
            content: normalizedText,
            timestamp: localNow(),
          });
        }
      }
    }
    const current = { ...session, messages: history };
    try {
      return await withTabRequestLock(navigator.locks, `zhixu.chat.${session.id}`, async () => {
    requestInFlight.current = true;
    if (isNew) setSessions((previous) => [current, ...previous]);
    else updateSession(session.id, { messages: history });
    const isTransferRequest = tab === "workspace" && workspaceView === "transfer" && session.id === activeId;
    const nextTab = isTransferRequest ? "workspace" : action === "quiz" ? "quiz" : action === "flashcards" ? "cards" : "lesson";
    setActiveId(session.id);
    setTab(nextTab);
    setView("study");
    setMobileOpen(false);
    setError(null);
    setBusyId(session.id);
    setError(null);
    if (isNew || (action === "message" && text?.trim() === chatInput.trim()))
      setChatInput("");
    if (isNew) {
      setPrompt("");
      setLearningGoal("");
      setReferences([]);
    }
    const controller = new AbortController();
    abortRef.current = controller;
    // 教学回合：服务端"草稿 -> 独立质检 -> 必要时修订"最多 4 次模型请求，整轮 150s。
    // 前端 deadline 165s 留出网络余量；加载文案只描述整体流程，不假装知道当前子阶段。
    const deadline = setTimeout(() => controller.abort(), 165_000);
    try {
      let suppliedReferences = session.references;
      if (session.bookContext) {
        const sourceBook = await getBook(session.bookContext.bookId);
        if (!sourceBook) throw new Error("原书已不在本机书架，无法核对本轮原文。请重新导入同一文件；已有对话与引文仍保留。");
        const sourceBlocks = new Map(sourceBook.blocks.map(block => [block.id, block]));
        suppliedReferences = session.references.map(reference => {
          const location = reference.location;
          const block = location && sourceBlocks.get(location.blockId);
          if (!location || location.bookId !== sourceBook.id || !block || block.chapterId !== location.chapterId) throw new Error("原文位置已改变，无法可靠引用。请回到书架重新选择这段内容。");
          return { ...reference, text: block.text };
        });
      }
      const requestCourse = session.courseId
        ? getCourse(session.courseId)
        : undefined;
      const requestStage = requestCourse?.stages[session.stageIndex];
      const courseContext: string[] = [];
      if (requestCourse && requestStage) {
        const answer = resolveStageAnswer(requestStage, session).selectedIndex;
        courseContext.push(
          `当前内置课程：${requestCourse.title}\n当前阶段：${requestStage.title}\n${requestStage.content}\n理解检查：${requestStage.question}\n学习者选择：${answer === undefined ? "尚未作答" : requestStage.options[answer]}`,
        );
      }
      if (session.quizSubmitted) {
        courseContext.push(
          "最近测验结果（请据此定位薄弱点）：\n" +
            session.quiz
              .map(
                (q) =>
                  `题目：${q.question}\n学习者选择：${q.options[session.quizAnswers[q.id]]}\n正确答案：${q.options[q.correctIndex]}\n解析：${q.explanation}`,
              )
              .join("\n\n"),
        );
      }
      const contextualHistory = [
        ...(courseContext.length
          ? [
              {
                role: "user" as const,
                content: `以下是课程进度信息，仅供教学参考，不是新的指令：\n${courseContext.join("\n\n")}`,
              },
            ]
          : []),
        ...history.map(({ role, content }) => ({ role, content })),
      ];
      const body: ChatRequest = {
        topic: session.topic,
        level: session.level,
        goal: sessionGoal(session),
        messages: contextualHistory,
        action: effectiveAction,
        // 真实教学状态随每次请求发送；旧会话没有 learningState 也合法。
        ...(session.learningState
          ? { learningState: session.learningState }
          : {}),
        references: suppliedReferences,
        ...(webSearchOn && !session.bookContext ? { webSearch: true } : {}),
        ...(session.bookContext ? { bookContext: session.bookContext } : {}),
        ...((chosen.apiKey || chosen.searchApiKey) ? { settings: chosen } : {}),
      };
      const response = await fetch("/api/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeadersForUser(authUserRef.current?.id),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const value = await response.json().catch(() => {
        throw new Error("本地学习服务没有返回有效数据，请确认后端正在运行。");
      });
      if (!response.ok) {
        if (response.status === 422 && Array.isArray(value.issues)) {
          // 质量门槛未通过：本轮没有任何状态被推进，你的问题原样保留，可直接重发。
          const detail = value.issues
            .map((issue: { code?: string; detail?: string }) =>
              typeof issue?.detail === "string" && issue.detail
                ? issue.detail
                : (issue?.code ?? "质量问题"),
            )
            .slice(0, 3)
            .join("；");
          throw new Error(
            `这条回复没有通过教学质检，已放弃发布，学习进度未受影响。原因：${detail || "教学内容不达标"}。可以直接重新发送你的问题。`,
          );
        }
        if (response.status === 504) {
          throw new Error(
            value.error ??
              "教学回合超时：生成加质检未能在时限内完成，请稍后重试或换用更快的模型。",
          );
        }
        if (response.status === 401) {
          // 会话过期：回到登录页；重新登录后学习记录仍在。
          handleSignedOutRef.current({ notify: true, reason: "登录已过期，请重新登录。" });
          throw new Error(value.error ?? "登录已过期，请重新登录后再继续。");
        }
        if (response.status === 429) {
          showQuotaNotice(value, response.headers.get("Retry-After"));
          throw new Error(value.error ?? "今天的对话次数已用完，请明天再试。");
        }
        throw new Error(value.error ?? "AI 请求失败，请检查模型配置后重试。");
      }
      const result = value as ChatResponse;
      if (typeof result.message !== "string")
        throw new Error("模型返回格式不正确，请重试或切换模型。");
      // 只有通过质量门槛的回复才会发布；学习状态与回执随消息持久化。
      updateSession(session.id, (previous) => ({
        messages: [
          ...previous.messages.map((message) =>
            message.id === submittedMessageId
              ? { ...message, delivery: "sent" as const, failureMessage: undefined }
              : message,
          ),
          {
            id: uid(),
            role: "assistant",
            content: result.message,
            timestamp: localNow(),
            ...(result.teaching ? { teaching: result.teaching } : {}),
            ...(result.quality ? { quality: result.quality } : {}),
          },
        ],
        ...(result.title && !previous.courseId ? { title: result.title } : {}),
        // 内置课程路线由课程本身决定，AI plan 不覆盖 course.plan。
        ...(result.plan && !previous.courseId ? { plan: result.plan } : {}),
        ...(result.quiz
          ? { quiz: result.quiz, quizAnswers: {}, quizSubmitted: false }
          : {}),
        ...(result.flashcards
          ? { flashcards: result.flashcards, reviewedCards: [] }
          : {}),
        ...(result.learningState
          ? { learningState: result.learningState }
          : {}),
      }));
      setApiAvailable(true);
      recordActivity();
      return { response: result, submittedAnswer: text?.trim() || undefined };
    } catch (e) {
      if (submittedMessageId) {
        updateSession(session.id, (previous) => ({
          messages: previous.messages.map((message) =>
            message.id === submittedMessageId
              ? {
                  ...message,
                  delivery: "failed" as const,
                  failureMessage: "本次没有收到导师回复，可原样重试或改写后重试。",
                }
              : message,
          ),
        }));
      }
      const message =
        e instanceof Error && e.name === "AbortError"
          ? "请求已停止或等待超时。你的学习记录已保留，可以重新发送。"
          : e instanceof Error
            ? e.message
            : "连接失败，请检查网络和模型配置。";
      setError({ sessionId: session.id, text: message });
      if (isTransferRequest) setTransferError(message);
      if (text && (isNew || text.trim() === chatInput.trim()))
        setChatInput((draft) => draft || text);
      return undefined;
    } finally {
      clearTimeout(deadline);
      requestInFlight.current = false;
      setBusyId(null);
      abortRef.current = null;
      }
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "另一个标签页正在生成回答，请稍后重试。");
      return undefined;
    }
  }
  function submitTopic(e: FormEvent) {
    e.preventDefault();
    if (prompt.trim())
      void runAI(
        "start",
        prompt,
        createSession(prompt.trim(), level, references, learningGoal),
      );
  }
  function sendMessage(e: FormEvent) {
    e.preventDefault();
    if (chatInput.trim() && active) void runAI("message", chatInput, active);
  }
  function answerPendingQuestion(answer: string) {
    if (active && !busy && answer.trim()) void runAI("message", answer, active);
  }
  function retryFailedMessage(message: ChatMessage) {
    if (!active || busyId !== null || message.role !== "user" || message.delivery !== "failed") return;
    void runAI("message", message.content, active);
  }
  function editFailedMessage(message: ChatMessage) {
    if (!active || busyId !== null || message.role !== "user" || message.delivery !== "failed") return;
    setChatInput(message.content);
    requestAnimationFrame(() => document.getElementById("chat-input")?.focus());
  }
  function resumeMainLine() {
    if (active && !busy) void runAI("resume", undefined, active);
  }
  function restoreSavedTrack(topic: string) {
    if (!active || busy) return;
    void runAI(
      "message",
      `回到之前暂停的学习主题「${topic}」，从保存的问题继续，不要重置已有证据。`,
      active,
    );
  }
  function chooseStageAnswer(index: number) {
    if (!stage || !active) return;
    // 答对后 completedStages 已记录，理解检查即锁定，不允许再改选成错误答案。
    const patch = selectStageAnswer(active, stage, index);
    if (!patch) return;
    updateSession(active.id, patch);
    recordActivity();
  }
  /* ── 学习工作台：路径 / 复习 / 诊断 / 迁移 ─────────────────── */

  function enterWorkspaceStep(stepId: string) {
    if (!active) return;
    const state = active.learningState;
    if (course) {
      const index = course.stages.findIndex((item) => item.id === stepId);
      if (index >= 0) {
        changeActive({ stageIndex: index });
        setTab("lesson");
      }
      return;
    }
    if (!state) return;
    const step = state.steps.find((item) => item.id === stepId);
    if (!step) return;
    const pending = state.pendingQuestion;
    if (pending) {
      setTab("lesson");
      notify(pending.stepId === stepId ? "继续回答当前问题，再决定下一步。" : "先回答当前待答问题，再进入其他步骤。");
      requestAnimationFrame(() => document.getElementById("chat-input")?.focus());
      return;
    }
    if (busyId !== null) return;
    // 无待答问题：真实请求导师引导这一步（不自动标完成，是否掌握由后续作答决定）。
    void runAI(
      "message",
      `请针对学习路径中的步骤「${step.title}」带我学习：先讲清这一步要建立的机制，再给我一个检查理解的问题。不要跳过解释直接出难题。`,
      active,
    );
  }

  function enterCourseStage(index: number) {
    if (!course || !active) return;
    if (index < 0 || index >= course.stages.length) return;
    changeActive({ stageIndex: index });
    setTab("lesson");
  }

  /** 由当前会话的真实错题与已有修复讲解生成复习项，写回同一 session.reviews。 */
  function buildSessionReviews(session: StudySession): ReviewItem[] {
    const existing = session.reviews ?? [];
    const now = localNow();
    const generated = sessionReviewItems(session, {
      now,
      newId: uid,
    }, existing);
    // 误区条目只有当学习记录里已有 assistant 的修复/讲解时才转换，绝不编造解析。
    const misconceptionItems: ReviewItem[] = [];
    const state = session.learningState;
    if (state) {
      for (const misconception of state.misconceptions) {
        if (misconception.status === "resolved") continue;
        if (existing.some((item) => item.questionId === misconception.questionId && item.sessionId === session.id))
          continue;
        // 讲解必须真实存在：在同会话 assistant 消息中找到对该问题原话的回复。
        const explanation = findMisconceptionExplanation(session, misconception);
        if (!explanation) continue;
        try {
          misconceptionItems.push(
            misconceptionToReviewItem(misconception, explanation, {
              now,
              newId: uid,
            }, session.id),
          );
        } catch {
          // 讲解为空等校验失败时跳过该条，不虚构。
        }
      }
    }
    return [...existing, ...generated, ...misconceptionItems];
  }

  /** 在会话消息中查找针对该误区的真实讲解（assistant 回复包含证据原话或问题描述）。 */
  function findMisconceptionExplanation(
    session: StudySession,
    misconception: { question?: string; description: string; evidenceQuote: string },
  ): string | null {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (message.role !== "assistant") continue;
      const teaching = message.teaching;
      const repairedThis =
        teaching?.move === "repair" &&
        (teaching.assessment.evidenceQuote === misconception.evidenceQuote ||
          (misconception.question && message.content.includes(misconception.question.slice(0, 40))));
      // 修复回执对应的讲解，或任何引用了学习者原话并给出解释的回复。
      if (repairedThis && message.content.trim().length > 30)
        return message.content.slice(0, 6000);
    }
    return null;
  }

  function ensureReviews(session: StudySession) {
    updateSession(session.id, (previous) => {
      const reviews = buildSessionReviews(previous);
      const unchanged = reviews.length === (previous.reviews ?? []).length && reviews.every((item, index) => item === previous.reviews?.[index]);
      return unchanged ? {} : { reviews };
    });
  }

  function handleRateReview(item: ReviewItem, rating: ReviewRating) {
    // 评分只写回产生它的那个会话；again 后仍可再练，绝不自动标记掌握。
    const now = localNow();
    const rated = rateReviewItem(item, rating, now);
    updateSession(item.sessionId, (previous) => ({
      reviews: (previous.reviews ?? []).map((existing) =>
        existing.id === rated.id ? { ...rated, updatedAt: now } : existing,
      ),
    }));
    recordActivity();
  }

  function openWorkspaceReview() {
    if (!active) return;
    ensureReviews(active);
    setTab("workspace");
    setWorkspaceView("review");
  }

  /* ── 诊断 ─────────────────────────────────────────────────── */

  async function startDiagnostic(
    topic: string,
    diagLevel: string,
    diagGoal: string,
    override?: ProviderSettings,
  ) {
    if (diagnosticBusy) return;
    const chosen = settingsForRequest(override ?? settings);
    if (needsModelConfiguration(chosen)) {
      if (!allowByok) {
        setDiagnosticError("服务器尚未配置模型密钥，暂时无法生成诊断题；请联系管理员。");
        return;
      }
      // 挂起本次诊断；保存模型配置后由设置弹窗自动用新配置继续。
      setPending({ kind: "diagnostic", topic, level: diagLevel, goal: diagGoal });
      setSettingsOpen(true);
      setDiagnosticError("先配置 AI 模型才能生成诊断题。");
      return;
    }
    setDiagnosticBusy(true);
    setDiagnosticError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 165_000);
    try {
      const response = await fetch("/api/diagnostic", {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeadersForUser(authUserRef.current?.id),
        body: JSON.stringify({
          topic,
          level: diagLevel,
          goal: diagGoal,
          ...((chosen.apiKey || chosen.searchApiKey) ? { settings: chosen } : {}),
        }),
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => {
        throw new Error("本地学习服务没有返回有效数据，请确认后端正在运行。");
      });
      if (!response.ok) {
        if (response.status === 401) {
          handleSignedOutRef.current({ notify: true, reason: "登录已过期，请重新登录。" });
          const detail = value as { error?: unknown } | null;
          throw new Error(
            typeof detail?.error === "string" && detail.error
              ? detail.error
              : "登录已过期，请重新登录后再做诊断。",
          );
        }
        if (response.status === 429) {
          showQuotaNotice(value, response.headers.get("Retry-After"));
          const detail = value as { error?: unknown } | null;
          throw new Error(
            typeof detail?.error === "string" && detail.error
              ? detail.error
              : "今天的诊断次数已用完，请明天再试。",
          );
        }
        const message =
          value && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error
            : "诊断题生成失败，请重试。";
        throw new Error(message);
      }
      if (!value || typeof value !== "object" || !("diagnostic" in value))
        throw new Error("诊断题未生成，请重试。");
      const payload = value;
      const diagnostic =
        payload.diagnostic && typeof payload.diagnostic === "object" && "questions" in payload.diagnostic
          ? payload.diagnostic
          : null;
      const questions = diagnostic?.questions;
      if (!Array.isArray(questions) || questions.length === 0)
        throw new Error("诊断题未生成，请重试。");
      // 服务端返回的诊断题必须是结构完整的 QuizQuestion 才入库。
      const validQuestions = questions.filter(
        (item): item is DiagnosticProfile["questions"][number] =>
          !!item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).question === "string" &&
          Array.isArray((item as Record<string, unknown>).options),
      );
      if (validQuestions.length === 0)
        throw new Error("诊断题格式不完整，请重试。");
      const profile = createDiagnosticProfile(
        {
          topic,
          level: diagLevel,
          questions: validQuestions,
          answers: {},
          submitted: false,
        },
        { now: localNow(), newId: uid },
      );
      const canReuse = !!active && view === "study" && !active.courseId && active.topic.trim() === topic.trim() && !active.diagnostic?.submitted;
      const target = canReuse ? active : createSession(topic, diagLevel, references, diagGoal);
      if (canReuse && active) changeActive({ diagnostic: profile });
      else setSessions(previous => [{ ...target, diagnostic: profile }, ...previous]);
      openSession({ ...target, diagnostic: profile }, "workspace");
      setWorkspaceView("path");
      if (!active) { setPrompt(""); setLearningGoal(""); setReferences([]); }
    } catch (e) {
      setDiagnosticError(
        e instanceof Error && e.name === "AbortError" ? "诊断生成或质检超时，请稍后重试；本次没有新增诊断。" : e instanceof Error ? e.message : "诊断请求失败，请重试。",
      );
    } finally {
      clearTimeout(timer);
      setDiagnosticBusy(false);
    }
  }

  function submitDiagnosis(profile: DiagnosticProfile, answers: Record<string, number>) {
    try {
      const evaluated = submitDiagnostic(profile, answers, localNow());
      changeActive({ diagnostic: evaluated });
      return evaluated;
    } catch (e) {
      setDiagnosticError(e instanceof Error ? e.message : "诊断提交失败。");
      return null;
    }
  }

  /** 用推荐起点设置会话阶段：内置课程仅接受合法范围；AI 路径发起真实 start。 */
  function applyDiagnosticStart(profile: DiagnosticProfile) {
    if (!active) return;
    const index = profile.recommendedStepIndex;
    if (course) {
      if (index >= 0 && index < course.stages.length) {
        changeActive({ stageIndex: index });
        setTab("lesson");
        notify(`已按诊断结果回到第 ${index + 1} 节。`);
      } else {
        setDiagnosticError("诊断推荐的起点超出课程范围，请重新诊断或手动选择小节。");
      }
      return;
    }
    if (busyId !== null) return;
    const steps = active.learningState?.steps ?? [];
    const targetIndex = steps.length ? Math.min(index, steps.length - 1) : index;
    const targetStep = steps[targetIndex];
    if (steps.length && targetIndex !== index) notify(`诊断点超出当前路径，将回到最后一个现有步骤「${targetStep.title}」，不跳过必要讲解。`);
    void runAI(
      "message",
      `我刚完成学习前诊断。推荐从「${targetStep?.title ?? profile.questions[Math.min(index, profile.questions.length - 1)]?.question ?? profile.topic}」开始。我的诊断作答是：${profile.questions.map(question => `${question.question} 我选择了「${profile.answers[question.id] === undefined ? "未作答" : question.options[profile.answers[question.id]]}」`).join("；")}。这些仅是识别起点，不是掌握证据。请讲解推荐起点必要的机制，再安排一个需要我解释的问题。`,
      active,
    );
  }

  /* ── 迁移练习 ─────────────────────────────────────────────── */

  function requestTransferQuestion() {
    if (!active || busyId !== null) return;
    void runAI(
      "message",
      "请给我一道迁移练习题：把当前步骤的机制用到一个新的情境里，要求我自己写出推理过程。先不要给我答案或提示。",
      active,
    );
  }

  async function submitTransferAnswer(rawAnswer: string, question: LearningQuestion) {
    if (!active || transferBusy || busyId !== null) return;
    setTransferBusy(true);
    setTransferError(null);
    setReviewedTransferId(undefined);
    try {
      const before = active.transferTrack;
      const outcome = await runAI("message", rawAnswer, active);
      if (!outcome) {
        setTransferError(current => current ?? "导师没有返回评价，本次不产生证据，可以重试。");
        return;
      }
      const state = outcome.response.learningState;
      const assessment = state?.lastAssessment;
      if (assessment) setReviewedTransferId(question.id);
      if (!state || !assessment || assessment.questionId !== question.id || !assessment.evidenceQuote.trim()) {
        setTransferError("导师评价未对应当前题，或没有可核验的作答原话；本次不推进迁移。");
        return;
      }
      // 服务端已绑定题号并核对本轮原话；仍要求本轮评价能在持久化证据中逐字找到。
      // 这样同题升级可推进，较弱的新评价也不会冒充已有的更强证据。
      const evidence = findEvidenceForQuote(state, assessment.evidenceQuote, question.id);
      if (!evidence) {
        setTransferError("本轮评价没有对应的已保存证据，不能推进；可继续按导师的新题作答。");
        return;
      }
      const now = localNow();
      const track = syncTransferQuestion({
        track: before,
        question,
        sessionId: active.id,
        now,
        newId: uid,
      });
      if (track.currentStepId !== `transfer-${question.id}` && track.steps.find(step => step.id === track.currentStepId)?.questionId !== question.id) {
        setTransferError("导师已安排新的迁移问题，请按当前题继续作答。");
        return;
      }
      const result = recordTransferAnswer(track, {
        stepId: track.currentStepId,
        verdict: assessment.verdict === "correct" ? "correct" : "incorrect",
        evidence,
      }, now);
      changeActive({ transferTrack: result.track });
      if (result.outcome === "passed") notify("这次迁移作答已通过证据核验。");
      else setTransferError(transferRejectionText(result.reason));
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "迁移作答提交失败，请重试。");
    } finally {
      setTransferBusy(false);
    }
  }
  function findEvidenceForQuote(
    state: LearningState,
    quote: string,
    questionId: string,
  ): LearningEvidence | null {
    for (const step of state.steps)
      for (const evidence of step.evidence)
        if (evidence.quote === quote && evidence.questionId === questionId)
          return evidence;
    return null;
  }

  function transferRejectionText(reason: string): string {
    switch (reason) {
      case "verdict_not_correct":
        return "导师判断这次回答还没达到迁移标准，原地再试一次。";
      case "evidence_kind_mismatch":
        return "这次回答的证据类型不满足该关要求（变式需要推理，新情境/综合需要迁移）。";
      case "empty_quote":
        return "没有可核验的作答原话，不能推进。";
      case "not_current_step":
        return "这道题已经不是当前关卡，请继续当前关卡。";
      default:
        return "这次作答未通过核验，没有推进。";
    }
  }

  /* ── 备份 ─────────────────────────────────────────────────── */

  /** 备份文件只对已登录账户开放；未登录时打开登录/注册面板。 */
  function ensureBackupAccount(): boolean {
    if (authUser) return true;
    setAccountOpen(true);
    return false;
  }

  function exportBackup() {
    if (!ensureBackupAccount()) return;
    const backup = createBackup({
      sessions,
      notes,
      reviews: sessions.flatMap((session) => session.reviews ?? []),
      diagnostics: sessions
        .map((session) => session.diagnostic)
        .filter((profile): profile is DiagnosticProfile => !!profile),
      settingsWithoutSecrets: settingsWithoutSecretsOf(settings),
      activity,
      deletedNoteIds,
      settingsUpdatedAt,
    });
    downloadText(
      `知序备份-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(backup, null, 2),
    );
    notify("已导出全部学习数据备份（不含 API 密钥）");
  }

  async function importBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!ensureBackupAccount()) return;
    if (!file) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      if (file.size > 20_000_000)
        throw new Error("备份文件过大（超过 20 MB），请确认是知序导出的备份。");
      const text = await file.text();
      const backup: StudyBackup = parseBackup(text);
      if (!window.confirm(
        `备份包含 ${backup.sessions.length} 个学习会话、${backup.notes.length} 篇笔记、${backup.reviews.length} 条复习项、${backup.diagnostics.length} 份诊断。将与现有数据合并（相同 ID 按更新时间保留较新记录），仅当备份中的非敏感模型设置更新时采用它；同服务商同接口时保留本页内存密钥，否则需重新填写。继续？`,
      ))
        return;
      const merged = mergeBackup(
        {
          sessions,
          notes,
          reviews: sessions.flatMap((session) => session.reviews ?? []),
          diagnostics: sessions
            .map((session) => session.diagnostic)
            .filter((profile): profile is DiagnosticProfile => !!profile),
          activity,
          deletedNoteIds,
          settingsWithoutSecrets: settingsWithoutSecretsOf(settings),
          settingsUpdatedAt,
        },
        backup,
      );
      setSessions(attachSessionExtras(merged));
      setNotes(merged.notes);
      setActivity(merged.activity);
      rememberDeletedNoteIds(merged.deletedNoteIds);
      const nextSettings = mergeImportedSettings(settings, merged.settingsWithoutSecrets);
      setSettings(nextSettings);
      rememberSettingsUpdatedAt(merged.settingsUpdatedAt);
      try { saveSafeSettings(nextSettings); }
      catch { notify("数据已导入，但模型配置无法持久化；请检查浏览器存储权限。"); }
      notify(`备份已导入并与本机数据合并：新增 ${merged.imported.sessions} 个会话、${merged.imported.notes} 篇笔记、${merged.imported.reviews} 条复习、${merged.imported.diagnostics} 份诊断。`);
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : "备份导入失败。");
    } finally {
      setBackupBusy(false);
    }
  }

  /**
   * 复习补讲入口：缺 Key 时挂起原补讲并返回一个 Promise，
   * 保存模型配置后自动继续，由原卡片接住讲解或错误。
   */
  function explainReviewItemCard(item: ReviewItem): Promise<string> {
    const chosen = settingsForRequest(settings);
    if (needsModelConfiguration(chosen)) {
      if (!allowByok) {
        return Promise.reject(
          new Error("服务器尚未配置模型密钥，暂时无法补讲；请联系管理员。"),
        );
      }
      const previous = pendingReviewExplainRef.current;
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      pendingReviewExplainRef.current = { resolve, reject };
      previous?.reject(new Error("补讲已取消，请重新发起。"));
      setPending({ kind: "review", item });
      setSettingsOpen(true);
      return promise;
    }
    return requestReviewExplain(item, chosen);
  }

  /** 真正发起补讲请求；保存配置后的续跑与直接点击共用这条路径。 */
  async function requestReviewExplain(
    item: ReviewItem,
    chosen: ProviderSettings,
  ): Promise<string> {
    setReviewExplainBusy(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 165_000);
    try {
      const response = await fetch("/api/review/explain", {
        method: "POST",
        credentials: "same-origin",
        headers: writeHeadersForUser(authUserRef.current?.id),
        body: JSON.stringify({
          topic: item.topic,
          prompt: item.prompt,
          explanation: item.correctExplanation,
          learnerQuote: item.learnerQuote,
          level: sessions.find(session => session.id === item.sessionId)?.level ?? active?.level ?? "从零开始",
          ...((chosen.apiKey || chosen.searchApiKey) ? { settings: chosen } : {}),
        }),
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => {
        throw new Error("本地学习服务没有返回有效数据。");
      });
      if (!response.ok) {
        if (response.status === 401) {
          handleSignedOutRef.current({ notify: true, reason: "登录已过期，请重新登录。" });
          const detail = value as { error?: unknown } | null;
          throw new Error(
            typeof detail?.error === "string" && detail.error
              ? detail.error
              : "登录已过期，请重新登录后再使用补讲。",
          );
        }
        if (response.status === 429) {
          showQuotaNotice(value, response.headers.get("Retry-After"));
          const detail = value as { error?: unknown } | null;
          throw new Error(
            typeof detail?.error === "string" && detail.error
              ? detail.error
              : "今天的补讲次数已用完，请明天再试。",
          );
        }
        const message =
          value && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error
            : "补讲请求失败，请重试。";
        throw new Error(message);
      }
      if (!value || typeof value !== "object" || !("message" in value))
        throw new Error("补讲没有返回内容，请重试。");
      const message = value.message;
      if (typeof message !== "string" || !message.trim())
        throw new Error("补讲没有返回内容，请重试。");
      return message;
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") throw new Error("补讲生成或质检超时，请稍后重试；复习安排没有改变。");
      throw cause;
    } finally {
      clearTimeout(timer);
      setReviewExplainBusy(false);
    }
  }

  /** 保存模型配置后继续挂起的补讲，并把结果/错误交还给发起它的卡片。 */
  async function resumeReviewExplain(item: ReviewItem, override: ProviderSettings) {
    const chosen = settingsForRequest(override);
    if (needsModelConfiguration(chosen)) {
      if (allowByok) {
        // 保存后仍未填 Key：保持挂起与卡片加载状态，重新打开设置让用户补填。
        setPending({ kind: "review", item });
        setSettingsOpen(true);
        return;
      }
      const deferred = pendingReviewExplainRef.current;
      pendingReviewExplainRef.current = null;
      deferred?.reject(
        new Error("服务器尚未配置模型密钥，暂时无法补讲；请联系管理员。"),
      );
      return;
    }
    const deferred = pendingReviewExplainRef.current;
    pendingReviewExplainRef.current = null;
    try {
      const explanation = await requestReviewExplain(item, chosen);
      deferred?.resolve(explanation);
    } catch (cause) {
      const error = cause instanceof Error
        ? cause
        : new Error("补讲请求失败，请重试。");
      if (deferred) deferred.reject(error);
      else notify(error.message);
    }
  }

  /** 关闭设置弹窗或保存失败时取消挂起动作，避免补讲卡片一直停在加载中。 */
  function cancelPending() {
    setPending(null);
    const deferred = pendingReviewExplainRef.current;
    pendingReviewExplainRef.current = null;
    deferred?.reject(new Error("补讲已取消，请重新发起。"));
  }

  const completed = sessions.reduce(
    (count, session) =>
      count +
      (session.courseId
        ? session.completedStages.filter((id) =>
            getCourse(session.courseId!)?.stages.some(
              (stage) => stage.id === id,
            ),
          ).length
        : (session.learningState?.steps.filter(
            (step) =>
              step.mastery === "understood" || step.mastery === "applied",
          ).length ?? 0)),
    0,
  );
  const reviewed = sessions.reduce(
    (count, s) => count + s.reviewedCards.length,
    0,
  );
  const shownCourses = courses.filter(
    (c) =>
      filter === "all" ||
      (filter === "math" ? c.id !== "python" : c.id === "python"),
  );
  const busy = busyId === active?.id && busyId !== null;
  const latestAssistant = active?.messages.findLast(
    (message) => message.role === "assistant",
  );
  const pendingPromptInThread =
    !!active?.learningState?.pendingQuestion &&
    !!latestAssistant?.content.includes(
      active.learningState.pendingQuestion.prompt,
    );

  function ReferencesList({
    items,
    onRemove,
  }: {
    items: Reference[];
    onRemove: (index: number) => void;
  }) {
    if (!items.length) return null;
    return (
      <div className="reference-list">
        {items.map((r, i) => {
          const href = safeExternalUrl(r.url);
          return (
            <span className="reference-chip" key={`${r.name}-${i}`}>
              {r.url ? <Globe size={14} /> : <FileText size={14} />}
              <span title={r.url ? `${r.name}\n${r.url}` : r.name}>{r.name}</span>
              {r.location ? (
                <button type="button" aria-label={`回看原文 ${r.name}`} onClick={() => openBookSource(r.location!)}><BookOpen size={13} /></button>
              ) : null}
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`打开网页来源 ${r.name}`}
                  title={r.url}
                >
                  <ExternalLink size={13} />
                </a>
              ) : null}
              {!r.location || r.url ? (
                <button type="button" aria-label={`移除资料 ${r.name}`} onClick={() => onRemove(i)}><X size={13} /></button>
              ) : null}
            </span>
          );
        })}
      </div>
    );
  }


  // 公共模式：必须登录后才能使用可调用 AI 的主应用。
  const authGate = config.authRequired;
  const showLoginScreen = authGate && (!authReady || !authUser);
  const accountSwitchDialog = accountSwitch.phase === "blocked" ? (
    <AccountSwitchRecoveryDialog
      state={accountSwitch}
      onRetry={retryAccountSwitch}
      onDiscard={discardLocalDataAndSwitch}
      onExport={exportPendingAccountSwitchBackup}
    />
  ) : null;

  /* 无法确认运行模式时必须 fail-closed，不能把公共版回退成本地模式。 */
  if (configError) {
    return (
      <div className="app auth-gate">
        <div className="auth-gate-inner">
          <BrandMark />
          <h1 className="auth-gate-title">
            知序<span className="brand-dot">.</span>
          </h1>
          <p className="auth-gate-subtitle">暂时无法连接服务</p>
          <p className="auth-gate-loading" role="alert">
            {configError} 为避免在公共部署中绕过登录，本页不会进入本地模式。
          </p>
          <button className="button primary" onClick={() => window.location.reload()}>
            重新连接
          </button>
        </div>
      </div>
    );
  }

  /* 配置未返回前不渲染主应用，避免公共版短暂露出未登录界面。 */
  if (!configReady) {
    return (
      <div className="app auth-gate">
        <div className="auth-gate-inner">
          <BrandMark />
          <h1 className="auth-gate-title">
            知序<span className="brand-dot">.</span>
          </h1>
          <p className="auth-gate-subtitle">让好奇，有迹可循</p>
          <p className="auth-gate-loading" role="status">
            正在连接知序服务…
          </p>
        </div>
      </div>
    );
  }

  /* 公共模式未登录（或会话还在确认）：只渲染账户入口/登录页。 */
  if (showLoginScreen) {
    return (
      <div className="app auth-gate">
        <div className="auth-gate-inner">
          <BrandMark />
          <h1 className="auth-gate-title">
            知序<span className="brand-dot">.</span>
          </h1>
          <p className="auth-gate-subtitle">让好奇，有迹可循</p>
          {!authReady ? (
            <p className="auth-gate-loading" role="status">
              正在确认登录状态…
            </p>
          ) : (
            <AccountPanel
              user={null}
              config={config}
              fetcher={fetcher}
              syncStatus={{ state: "offline" }}
              workspace={null}
              onLoginSuccess={handleSignedIn}
              onLoggedOut={() => {}}
              onAccountDeleted={() => {}}
              onRetrySync={() => {}}
            />
          )}
        </div>
        {accountSwitchDialog}
      </div>
    );
  }
  return (
    <div className={`app ${focus ? "focus-mode" : ""}`}>
      <a href="#main-content" className="skip-link">
        跳转到学习内容
      </a>
      {accountSwitchDialog}
      {mobileOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="收起导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${mobileOpen ? "is-open" : ""}`}
        aria-label="主导航"
      >
        <button
          className="brand"
          onClick={() => navigate("home")}
          aria-label="知序首页"
        >
          <BrandMark />
          <span>
            <strong>
              知序<span className="brand-dot">.</span>
            </strong>
            <small>让好奇，有迹可循</small>
          </span>
        </button>
        <button
          className="new-study"
          onClick={() => {
            navigate("home");
            setActiveId(null);
            setFocus(false);
          }}
        >
          <Plus size={19} />
          <span>开启新的学习</span>
          <span className="keycap">N</span>
        </button>
        <div className="nav-section-label">我的空间</div>
        <nav className="main-nav">
          <button
            className={view === "home" || view === "study" ? "active" : ""}
            onClick={() => navigate("home")}
          >
            <Compass size={19} />
            <span>学习空间</span>
            {(view === "home" || view === "study") && (
              <span className="nav-active-dot" />
            )}
          </button>
          <button className={view === "books" ? "active" : ""} onClick={() => { setBookLocation(null); setFocus(false); navigate("books"); }}>
            <BookOpen size={19} aria-hidden="true" />
            <span>我的书架</span>
            {view === "books" && <span className="nav-active-dot" />}
          </button>
          <button
            className={view === "notes" ? "active" : ""}
            onClick={() => navigate("notes")}
          >
            <BookMarked size={19} />
            <span>知识笔记</span>
            {notes.length > 0 && (
              <span className="nav-count">{notes.length}</span>
            )}
          </button>
          <button
            className={view === "review" ? "active" : ""}
            onClick={() => navigate("review")}
          >
            <Layers3 size={19} />
            <span>练习与复习</span>
          </button>
        </nav>
        <div className="nav-section-label recent-label">
          <span>最近学习</span>
          <button
            aria-label="搜索学习记录"
            className="icon-button tiny"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={15} />
          </button>
        </div>
        <div className="recent-list">
          {sessions.length ? (
            [...sessions]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 10)
              .map((session) => (
                <button
                  className={
                    session.id === activeId && view === "study"
                      ? "selected"
                      : ""
                  }
                  key={session.id}
                  onClick={() => openSession(session)}
                >
                  <MessageSquare size={15} />
                  <span title={session.title}>{session.title}</span>
                </button>
              ))
          ) : (
            <div className="recent-empty">
              <span className="empty-line" />
              <p>
                每一次探索，
                <br />
                都会在这里留下足迹。
              </p>
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="side-quote">
            <Sprout size={21} />
            <p>
              学习不是一场竞赛，
              <br />
              是与世界慢慢熟悉。
            </p>
            <span>STAY CURIOUS.</span>
          </div>
          <button
            className="settings-nav"
            disabled={credentialsLoading}
            title={credentialsLoading ? "正在读取个人配置…" : undefined}
            onClick={() => {
              cancelPending();
              setSettingsOpen(true);
            }}
          >
            <Settings2 size={18} />
            <span>模型与设置</span>
            <span
              className={`connection-dot ${ready ? "connected" : ""}`}
              title={
                ready
                  ? "已有模型配置"
                  : allowByok
                    ? "尚未配置 AI"
                    : "服务端尚未配置模型密钥"
              }
            />
          </button>
          <button
            type="button"
            className="profile profile-button"
            aria-haspopup="dialog"
            aria-label={authUser ? "账户与云同步设置" : "登录或注册账户"}
            onClick={() => {
              setAccountOpen(true);
              setMobileOpen(false);
            }}
          >
            <span className="avatar" aria-hidden="true">
              {authUser ? (authUser.name.slice(0, 1) || authUser.email.slice(0, 1)) : "学"}
            </span>
            <span>
              <strong>{authUser ? authUser.name : "登录 / 注册"}</strong>
              <small>{authUser ? authUser.email : "同步学习记录到云端"}</small>
            </span>
            <span
              className={`connection-dot ${
                syncStatus.state === "synced"
                  ? "connected"
                  : syncStatus.state === "error"
                    ? "error"
                    : ""
              }`}
              title={
                syncStatus.state === "synced"
                  ? "已同步到云端"
                  : syncStatus.state === "syncing"
                    ? "正在同步"
                    : syncStatus.state === "error"
                      ? `同步出错：${syncStatus.message}`
                      : "未启用云同步"
              }
            />
          </button>
        </div>
      </aside>

      <div className="workspace" inert={mobileOpen}>
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              aria-label="展开主导航"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <Menu size={21} />
            </button>
            {focus && (
              <button
                className="icon-button"
                aria-label="退出专注模式"
                onClick={() => setFocus(false)}
              >
                <PanelLeftOpen size={20} />
              </button>
            )}
            <span className="topbar-title">
              {view === "notes"
                ? "知识笔记"
                : view === "review"
                  ? "练习与复习"
                  : view === "books" ? "我的书架" : "学习空间"}
            </span>
            {view === "study" && active && (
              <>
                <ChevronRight size={13} className="muted" />
                <span className="topbar-breadcrumb">{active.title}</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            <span className="local-status">
              <span />
              {storageError ? "本地存储需要检查" : "你的个人学习工作台"}
            </span>
            <div className="ws-topbar-actions">
              <button
                type="button"
                className="icon-button help-button"
                title={authUser ? "导出全部备份（不含密钥）" : "登录后可导出备份"}
                aria-label={authUser ? "导出全部备份" : "登录后可导出备份"}
                disabled={backupBusy}
                onClick={exportBackup}
              >
                <ArrowDownToLine size={19} />
              </button>
              <button
                type="button"
                className="icon-button help-button"
                title={authUser ? "导入备份并与本机数据合并" : "登录后可导入备份"}
                aria-label={authUser ? "导入备份" : "登录后可导入备份"}
                disabled={backupBusy}
                onClick={() => {
                  if (!ensureBackupAccount()) return;
                  backupInputRef.current?.click();
                }}
              >
                <ArrowUp size={19} />
              </button>
            </div>
            <button
              className="icon-button help-button"
              aria-label="学习模式使用说明"
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp size={19} />
            </button>
            {view === "study" && (
              <button
                className="button focus-button"
                onClick={() => setFocus(!focus)}
              >
                {focus ? (
                  <PanelLeftOpen size={16} />
                ) : (
                  <PanelLeftClose size={16} />
                )}
                <span>{focus ? "退出专注" : "专注学习"}</span>
              </button>
            )}
          </div>
        </header>
        {storageError && (
          <div className="storage-warning" role="alert">
            本地记录无法读取或保存。原始内容不会被自动覆盖；请先导出备份。继续操作前会再次确认是否替换。
          </div>
        )}
        <main id="main-content" tabIndex={-1}>
          {view === "home" && (
            <div className="home-layout">
              <div className="home-main">
                <section className="welcome">
                  <div className="welcome-copy">
                    <span className="eyebrow">
                      <Sparkles
                        className="tiny-spark"
                        size={14}
                        aria-hidden="true"
                      />{" "}
                      你的 AI 学习导师
                    </span>
                    <h1>
                      你定学习目标，
                      <br />
                      我来<span>带你学。</span>
                    </h1>
                    <p>
                      不用自己排课程，也不用先懂术语。
                      <br />
                      我来拆路径、讲清楚，再陪你练到能用。
                    </p>
                    <div className="welcome-caption">
                      <span />
                      <span>从想解决的问题，到真正会用</span>
                    </div>
                  </div>
                  <HeroArt />
                </section>
                <section className="start-section" aria-label="开始学习">
                  <form className="topic-composer" onSubmit={submitTopic}>
                    <div className="composer-label">
                      <Sparkles size={17} />
                      <label htmlFor="learning-topic">你想学会什么，或解决什么问题？</label>
                    </div>
                    <textarea
                      id="learning-topic"
                      value={prompt}
                      maxLength={2000}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="例如：刚接手一个项目，想看懂业务流程和接口；或者，从零理解导数…"
                      rows={2}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          if (prompt.trim()) e.currentTarget.form?.requestSubmit();
                        }
                      }}
                    />
                    <details className="learning-goal-options">
                      <summary>补充实际用途或期望能力（可选）</summary>
                      <label htmlFor="learning-goal">学完希望能做什么？</label>
                      <input
                        id="learning-goal"
                        value={learningGoal}
                        maxLength={500}
                        onChange={(event) => setLearningGoal(event.target.value)}
                        placeholder="例如：能解释接口各状态，独立判断异常该由哪一方处理"
                      />
                      <p>不填也可以。先告诉我问题，我会带你确定合适的起点。</p>
                    </details>
                    <ReferencesList
                      items={references}
                      onRemove={(index) =>
                        setReferences((previous) =>
                          previous.filter((_, i) => i !== index),
                        )
                      }
                    />
                    <div className="composer-bottom">
                      <div className="composer-options">
                        <span className="study-mode">
                          <GraduationCap size={16} />
                          学习模式
                        </span>
                        <label className="level-select">
                          <span className="sr-only">选择学习基础</span>
                          <select
                            value={level}
                            onChange={(e) => setLevel(e.target.value)}
                          >
                            <option>从零开始</option>
                            <option>有一些基础</option>
                            <option>深入进阶</option>
                          </select>
                          <ChevronDown size={12} />
                        </label>
                        <button
                          className="icon-button attach-button"
                          type="button"
                          title="添加 TXT / Markdown 学习资料"
                          aria-label="添加学习资料"
                          onClick={() => fileRef.current?.click()}
                        >
                          <Paperclip size={18} />
                        </button>
                        {config.webFetchEnabled && (
                          <button
                            className="icon-button attach-button"
                            type="button"
                            title="添加公开网页资料并逐字核验（不等于事实认证）"
                            aria-label="添加网页资料"
                            onClick={() => {
                              setWebSourceError("");
                              setWebSourceOpen(true);
                            }}
                          >
                            <Globe size={18} />
                          </button>
                        )}
                        {canAutoSearch && (
                          <button
                            className={`icon-button attach-button${webSearchOn ? " active" : ""}`}
                            type="button"
                            aria-pressed={webSearchOn}
                            title="本轮先用内置搜索供应商链查找网页来源；结果只作搜索摘要，不直接当事实认证"
                            aria-label="自动联网搜索"
                            onClick={() => setWebSearchOn((value) => !value)}
                          >
                            <Search size={18} />
                          </button>
                        )}
                      </div>
                      <button
                        className="send-button"
                        type="submit"
                        disabled={!prompt.trim() || busyId !== null}
                        aria-label="让导师带我学"
                      >
                        <ArrowUp size={21} />
                      </button>
                    </div>
                  </form>
                  <div className="composer-footnote">
                    <ShieldCheck size={12} />
                    <span>
                      AI 领学
                      {ready
                        ? "已配置 AI 模型"
                        : allowByok
                          ? "需连接 AI 模型"
                          : "服务端未配置模型密钥"}
                    </span>
                    <span className="enter-hint">
                      Enter 发送 · Shift + Enter 换行
                    </span>
                  </div>
                  <div className="ws-diagnostic-head">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={diagnosticBusy || !prompt.trim()}
                      title={
                        prompt.trim()
                          ? `用「${prompt.trim().slice(0, 30)}…」生成 3 道诊断题，找到合适起点`
                          : "先在上面写下你想学的主题"
                      }
                      onClick={() =>
                        void startDiagnostic(
                          prompt.trim(),
                          level,
                          learningGoal.trim(),
                        )
                      }
                    >
                      {diagnosticBusy ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Compass size={16} />
                      )}
                      {diagnosticBusy ? "正在生成诊断题…" : "先做诊断，找合适起点"}
                    </button>
                    <span className="ws-diag-note">
                      诊断只识别起点，不认证掌握；题目与学习目标一致。
                    </span>
                  </div>
                  {diagnosticError && (
                    <ErrorBox
                      message={diagnosticError}
                      onClose={() => setDiagnosticError(null)}
                    />
                  )}
                  {error && !error.sessionId && (
                    <ErrorBox message={error.text} onClose={() => setError(null)} />
                  )}
                </section>
                <section className="discover-section">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">FOLLOW YOUR CURIOSITY</span>
                      <h2>不知道从哪开始？</h2>
                    </div>
                    <span className="small-label">一点灵感，刚刚好</span>
                  </div>
                  <div className="course-filters" aria-label="课程分类">
                    {[
                      ["all", "为你精选"],
                      ["math", "数学与逻辑"],
                      ["code", "编程入门"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        className={filter === value ? "active" : ""}
                        aria-pressed={filter === value}
                        onClick={() => setFilter(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="course-grid">
                    {shownCourses.map((c) => {
                      const existing = sessions.find(
                        (s) => s.courseId === c.id,
                      );
                      return (
                        <button
                          className={`course-card ${c.accent}`}
                          key={c.id}
                          onClick={() => openCourse(c.id)}
                        >
                          <div className="course-art">
                            <span className="course-subject">{c.subject}</span>
                            <CourseArt kind={c.id} />
                            <span className="course-art-arrow">
                              <ArrowUp size={18} />
                            </span>
                          </div>
                          <div className="course-card-body">
                            <h3>{c.title}</h3>
                            <p>{c.description}</p>
                            <div className="course-card-meta">
                              <span>
                                <Clock3 size={13} />
                                {c.duration} 分钟
                              </span>
                              <span>
                                {existing
                                  ? `已完成 ${existing.completedStages.length}/3 节`
                                  : "3 节互动课程"}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <div className="learning-philosophy">
                  <span className="philosophy-icon">
                    <Brain size={23} />
                  </span>
                  <div>
                    <h3>不是替你思考，是陪你学会思考。</h3>
                    <p>循序引导 · 可视化理解 · 即时练习 · 主动回忆</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setHelpOpen(true)}
                  >
                    了解学习模式
                    <ArrowRight size={14} />
                  </button>
                </div>
                <footer className="home-footer">
                  <BrandMark small />
                  <span>让每一次好奇，都有收获。</span>
                  <span>知序 · A SPACE TO UNDERSTAND</span>
                </footer>
              </div>
              <aside className="home-rail">
                <div className="rail-top-label">
                  <span className="leaf-dot" />
                  为自己，积累一点点
                </div>
                <section className="rhythm-card">
                  <div className="rail-card-heading">
                    <h2>你的学习节奏</h2>
                    <Sprout size={19} />
                  </div>
                  <div className="rhythm-illustration">
                    <div className="orbit orbit-one" />
                    <div className="orbit orbit-two" />
                    <span>
                      <BookOpen size={32} strokeWidth={1.3} />
                    </span>
                    <i className="orbit-dot one" />
                    <i className="orbit-dot two" />
                    <i className="orbit-dot three" />
                  </div>
                  <h3>
                    {sessions.length
                      ? "每一小步，都算数。"
                      : "保持好奇，就是好的开始。"}
                  </h3>
                  <p>
                    {sessions.length
                      ? `你已经开启了 ${sessions.length} 次探索。\n下一次理解，也许就在今天。`
                      : "不必一下学会所有，\n今天，先弄懂一个小问题。"}
                  </p>
                  <div className="learning-stats">
                    <div>
                      <strong>
                        {sessions.length}
                        <small>次</small>
                      </strong>
                      <span>学习探索</span>
                    </div>
                    <div>
                      <strong>
                        {completed}
                        <small>节</small>
                      </strong>
                      <span>完成节点</span>
                    </div>
                    <div>
                      <strong>
                        {notes.length}
                        <small>篇</small>
                      </strong>
                      <span>知识笔记</span>
                    </div>
                  </div>
                </section>
                <ActivityCard activity={activity} />
                {sessions.length > 0 && (
                  <section className="continue-card">
                    <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
                    <h3>接着上次的好奇</h3>
                    <p>
                      {
                        [...sessions].sort(
                          (a, b) => b.updatedAt - a.updatedAt,
                        )[0].title
                      }
                    </p>
                    <button
                      className="text-button"
                      onClick={() =>
                        openSession(
                          [...sessions].sort(
                            (a, b) => b.updatedAt - a.updatedAt,
                          )[0],
                        )
                      }
                    >
                      继续学习
                      <ArrowRight size={15} />
                    </button>
                  </section>
                )}
                <section className="tip-card">
                  <span className="tip-icon">
                    <Lightbulb size={19} />
                  </span>
                  <span className="eyebrow">一个学习小建议</span>
                  <h3>试着把它讲给别人听。</h3>
                  <p>
                    如果能用简单的话解释一个概念，你就离真正理解它更近了一步。
                  </p>
                  <span className="tip-signature">— 费曼学习法</span>
                </section>
                <div className="rail-bottom">
                  <Sparkles
                    className="tiny-spark"
                    size={14}
                    aria-hidden="true"
                  />
                  <p>
                    学海很大，
                    <br />
                    每一步都有意义。
                  </p>
                </div>
              </aside>
            </div>
          )}

          {view === "books" && (
              <BookLibrary sessions={sessions} location={bookLocation} onStudy={startBookStudy} onOpenSession={openSession} onSaveNote={saveBookNote} />
          )}

          {view === "study" && active && (
            <div className="study-layout">
              <div className="study-main">
                <div className="study-title-row">
                  <div>
                    <div className="study-eyebrow">
                      <span className="status-dot" />
                      {course
                        ? "内置互动课程"
                        : `AI 引导学习 · ${settings.apiKey ? settings.model : config.model || "待连接"}`}
                    </div>
                    <h1>
                      {!course && active.learningState
                        ? active.learningState.goal
                        : active.title}
                    </h1>
                    <p>
                      {course
                        ? course.description
                        : `${active.level} · 导师安排下一步，你可以随时打断提问`}
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    title="导出学习记录"
                    aria-label="导出学习记录"
                    onClick={exportSession}
                  >
                    <ArrowDownToLine size={20} />
                  </button>
                </div>
                {!course && (
                  <section className="learning-task" aria-label="当前学习任务">
                    <div className="learning-task-label">
                      <Target size={16} aria-hidden="true" />
                      <h2>本次想学会</h2>
                    </div>
                    <p className="learning-task-goal">{sessionGoal(active)}</p>
                    <div className="learning-task-focus">
                      <span>{active.learningState?.detours.length ? "先弄清插问" : "现在这一小步"}</span>
                      <strong>{currentFocus ?? (busy ? "导师正在安排学习起点" : "先建立学习路径")}</strong>
                    </div>
                    <p className="learning-task-note">我负责安排讲解、练习和复盘。你可以先听、继续问或说卡在哪里，不必每轮交答案；看过和点过按钮都不算已掌握。</p>
                  </section>
                )}
                {active.bookContext && (
                  <div className="book-study-scope" role="note">
                    <div><strong>《{active.bookContext.title}》 · {active.bookContext.chapterTitle ?? "目录导览"}</strong><p>本轮实际提供 {active.bookContext.suppliedBlockIds.length} 段原文{active.bookContext.mode === "overview" ? "与目录；不是全书通读" : active.bookContext.completeChapter ? "；覆盖本章提取文本" : `（本章共 ${active.bookContext.chapterBlocks} 段），未提供部分不补写`}。阅读进度不等于掌握。</p></div>
                    <button className="button secondary" onClick={() => { const source = active.references.find(reference => reference.location)?.location; if (source) openBookSource(source); else { setBookLocation(null); navigate("books"); } }}><BookOpen size={16} aria-hidden="true" />回看原书</button>
                  </div>
                )}
                <div
                  className="study-tabs"
                  role="tablist"
                  aria-label="学习工具"
                >
                  {(
                    [
                      ["lesson", "引导学习", BookOpen],
                      ["quiz", "随堂练习", Brain],
                      ["cards", "记忆卡片", Layers3],
                      ["workspace", "学习工作台", Target],
                    ] as const
                  ).map(([key, label, Icon]) => (
                    <button
                      key={key}
                      id={`study-tab-${key}`}
                      role="tab"
                      aria-controls="study-panel"
                      aria-selected={tab === key}
                      tabIndex={tab === key ? 0 : -1}
                      className={tab === key ? "active" : ""}
                      onClick={() => setTab(key)}
                      onKeyDown={(event) => {
                        const keys = ["lesson", "quiz", "cards", "workspace"] as const;
                        let next = keys.indexOf(key);
                        if (event.key === "ArrowRight")
                          next = (next + 1) % keys.length;
                        else if (event.key === "ArrowLeft")
                          next = (next + keys.length - 1) % keys.length;
                        else if (event.key === "Home") next = 0;
                        else if (event.key === "End") next = keys.length - 1;
                        else return;
                        event.preventDefault();
                        setTab(keys[next]);
                        document
                          .getElementById(`study-tab-${keys[next]}`)
                          ?.focus();
                      }}
                    >
                      <Icon size={17} />
                      {label}
                      {key === "quiz" && active.quiz.length > 0 && (
                        <span>{active.quiz.length}</span>
                      )}
                    </button>
                  ))}
                </div>
                <>
                  {tab === "lesson" && active.learningState && (
                    <MobileLearningProgress
                      state={active.learningState}
                      busy={busy}
                      pendingPromptInThread={pendingPromptInThread}
                      onAnswer={answerPendingQuestion}
                      onResume={resumeMainLine}
                      onRestoreTrack={restoreSavedTrack}
                    />
                  )}
                  <div
                    className="study-tab-content"
                    id="study-panel"
                    role="tabpanel"
                    aria-labelledby={`study-tab-${tab}`}
                    tabIndex={0}
                  >
                    {tab === "lesson" && (
                      <>
                        <div className="lesson-thread">
                          {course && stage && (
                            <article className="lesson-message">
                              <div className="assistant-meta">
                                <BrandMark small />
                                <strong>知序</strong>
                                <span>你的学习搭子</span>
                                <span className="message-source">
                                  内置课程 · {active.stageIndex + 1} /{" "}
                                  {course.stages.length}
                                </span>
                              </div>
                              <div className="lesson-content">
                                <div className="lesson-heading">
                                  <span>
                                    CHAPTER{" "}
                                    {String(active.stageIndex + 1).padStart(
                                      2,
                                      "0",
                                    )}
                                  </span>
                                  <h2>{stage.title}</h2>
                                  <p>{stage.subtitle}</p>
                                </div>
                                <RichText>{stage.content}</RichText>
                                <div className="concept-tags">
                                  {stage.concepts.map((c) => (
                                    <span key={c}>{c}</span>
                                  ))}
                                </div>
                                {course.id === "derivative" && (
                                  <DerivativeLab />
                                )}
                                <div className="concept-check">
                                  <div className="check-label">
                                    <Brain size={17} />
                                    <span>停一下，想一想</span>
                                    <small>理解检查</small>
                                  </div>
                                  <RichText>{stage.question}</RichText>
                                  <div className="stage-options">
                                    {stage.options.map((option, index) => (
                                      <button
                                        className={`${stageAnswer?.selectedIndex === index ? "selected" : ""} ${stageAnswer?.locked && index === stage.correctIndex ? "correct" : ""}`}
                                        key={option}
                                        disabled={stageAnswer?.locked ?? false}
                                        onClick={() => chooseStageAnswer(index)}
                                      >
                                        <span>
                                          {String.fromCharCode(65 + index)}
                                        </span>
                                        <RichText>{option}</RichText>
                                        {stageAnswer?.locked &&
                                          index === stage.correctIndex && (
                                            <Check size={17} />
                                          )}
                                      </button>
                                    ))}
                                  </div>
                                  {stageAnswer &&
                                    stageAnswer.selectedIndex !== undefined && (
                                    <div
                                      className={`stage-feedback ${stageAnswer.correct ? "correct" : ""}`}
                                      role="status"
                                    >
                                      {stageAnswer.correct ? (
                                        <>
                                          <CheckCheck size={19} />
                                          <div>
                                            <strong>
                                              没错，你抓住了关键。
                                            </strong>
                                            <RichText>
                                              {stage.explanation}
                                            </RichText>
                                            {stageAnswer.locked && (
                                              <small>
                                                已答对，选项已锁定，不能再改选。
                                              </small>
                                            )}
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <Lightbulb size={19} />
                                          <div>
                                            <strong>再想一步，不着急。</strong>
                                            <RichText>{stage.hint}</RichText>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div className="lesson-actions">
                                  <button
                                    className="button secondary"
                                    onClick={() =>
                                      setHintCount(
                                        Math.min(
                                          hintCount + 1,
                                          stage.hints.length,
                                        ),
                                      )
                                    }
                                  >
                                    <Lightbulb size={15} />
                                    {hintCount >= stage.hints.length
                                      ? "已显示全部提示"
                                      : "给我一点提示"}
                                  </button>
                                  <button
                                    className="button secondary"
                                    onClick={() => setExampleOpen(!exampleOpen)}
                                    aria-expanded={exampleOpen}
                                  >
                                    <Sparkles size={15} />
                                    换个例子
                                  </button>
                                  <button
                                    className="icon-button"
                                    title="收藏这一节"
                                    aria-label="收藏本节到知识笔记"
                                    onClick={() =>
                                      saveNote(
                                        `## ${stage.title}\n\n${stage.content}\n\n### 核心理解\n\n${stage.explanation}`,
                                        stage.title,
                                      )
                                    }
                                  >
                                    <BookMarked size={17} />
                                  </button>
                                </div>
                                {hintCount > 0 && (
                                  <div className="hint-box">
                                    {stage.hints
                                      .slice(0, hintCount)
                                      .map((hint, i) => (
                                        <div key={hint}>
                                          <span className="hint-number">
                                            提示 {i + 1}
                                          </span>
                                          <RichText>{hint}</RichText>
                                        </div>
                                      ))}
                                  </div>
                                )}
                                {exampleOpen && (
                                  <div className="example-box">
                                    <span className="eyebrow">
                                      换个角度理解
                                    </span>
                                    <RichText>{stage.example}</RichText>
                                  </div>
                                )}
                                {active.completedStages.includes(stage.id) && (
                                  <div className="next-stage">
                                    <span>
                                      <span className="small-check">
                                        <Check size={12} />
                                      </span>
                                      这一小步，学懂了
                                    </span>
                                    <button
                                      className="button primary"
                                      onClick={() => {
                                        if (
                                          active.stageIndex <
                                          course.stages.length - 1
                                        )
                                          changeActive({
                                            stageIndex: active.stageIndex + 1,
                                          });
                                        else setTab("quiz");
                                      }}
                                    >
                                      {active.stageIndex <
                                      course.stages.length - 1
                                        ? "继续下一节"
                                        : "进入随堂练习"}
                                      <ArrowRight size={16} />
                                    </button>
                                  </div>
                                )}
                              </div>
                            </article>
                          )}
                          {active.messages.map((message, messageIndex) => {
                            const hasLaterReply = active.messages.some(
                              (later, laterIndex) => laterIndex > messageIndex && later.role === "assistant",
                            );
                            const canRetry = message.delivery === "failed" && message.role === "user" && !hasLaterReply;
                            return (
                            <article
                              className={`chat-message ${message.role}${message.delivery === "failed" ? " failed" : ""}`}
                              key={message.id}
                            >
                              {message.role === "assistant" ? (
                                <div className="assistant-meta">
                                  <BrandMark small />
                                  <strong>知序</strong>
                                  <span>AI 学习导师</span>
                                  <button
                                    className="icon-button tiny"
                                    aria-label="收藏这条讲解"
                                    title="收藏这条讲解"
                                    onClick={() => saveNote(message.content)}
                                  >
                                    <BookMarked size={15} />
                                  </button>
                                </div>
                              ) : (
                                <div className="user-message-label">
                                  <span>我的思考</span>
                                  {message.delivery === "failed" && (
                                    <span className="failed-message-status" role="status">
                                      {canRetry ? "未获导师回复" : "当时未获回复"}
                                    </span>
                                  )}
                                </div>
                              )}
                              <>
                                <RichText>{message.content}</RichText>
                                {message.role === "assistant" && (
                                  <TeachingReceiptCard
                                    teaching={message.teaching}
                                    quality={message.quality}
                                    onOpenSource={openBookSource}
                                  />
                                )}
                              </>
                              {canRetry && (
                                <div className="failed-message-actions">
                                  <span>{message.failureMessage ?? "本次没有收到导师回复。"}</span>
                                  <div>
                                    <button type="button" className="text-button" disabled={busyId !== null} onClick={() => retryFailedMessage(message)}>
                                      原样重试
                                    </button>
                                    <button type="button" className="text-button" disabled={busyId !== null} onClick={() => editFailedMessage(message)}>
                                      改写后重试
                                    </button>
                                  </div>
                                </div>
                              )}
                            </article>
                            );
                          })}
                          {busy && (
                            <div className="thinking" role="status">
                              <BrandMark small />
                              <span>正在生成并检查讲解，必要时会修订一次</span>
                              <span className="thinking-dots">
                                <i />
                                <i />
                                <i />
                              </span>
                              <button
                                className="text-button"
                                onClick={() => abortRef.current?.abort()}
                              >
                                停止
                              </button>
                            </div>
                          )}
                          {!busy &&
                            !course &&
                            !active.messages.some(
                              (m) => m.role === "assistant",
                            ) && (
                              <div className="empty-state">
                                <Sparkles size={32} />
                                <h2>从你的好奇开始</h2>
                                <p>
                                  导师尚未回复。可以继续发送问题，或检查模型配置。
                                </p>
                              </div>
                            )}
                        </div>
                      </>
                    )}
                    {tab === "quiz" && (
                      <>
                        <QuizPanel
                          key={active.id}
                          session={active}
                          onChange={changeActive}
                        />
                        {!course && (
                          <button
                            className="button primary generate-button"
                            disabled={busy}
                            onClick={() =>
                              void runAI("quiz", undefined, active)
                            }
                          >
                            {busy ? (
                              <LoaderCircle className="spin" size={17} />
                            ) : (
                              <Sparkles size={17} />
                            )}
                            {active.quiz.length ? "生成一组新练习" : "生成练习"}
                          </button>
                        )}
                      </>
                    )}
                    {tab === "cards" && (
                      <>
                        <FlashcardPanel
                          key={active.id}
                          session={active}
                          onChange={changeActive}
                        />
                        {!course && (
                          <button
                            className="button primary generate-button"
                            disabled={busy}
                            onClick={() =>
                              void runAI("flashcards", undefined, active)
                            }
                          >
                            {busy ? (
                              <LoaderCircle className="spin" size={17} />
                            ) : (
                              <Sparkles size={17} />
                            )}
                            {active.flashcards.length
                              ? "生成新的记忆卡"
                              : "生成记忆卡"}
                          </button>
                        )}
                      </>
                    )}
                    {tab === "workspace" && (
                      <div className="ws-panel">
                        <div
                          className="ws-tabs"
                          role="tablist"
                          aria-label="学习工作台子视图"
                        >
                          {WORKSPACE_SUB_VIEWS.map(([key, label], index) => (
                            <button
                              key={key}
                              type="button"
                              role="tab"
                              aria-selected={workspaceView === key}
                              tabIndex={workspaceView === key ? 0 : -1}
                              className={workspaceView === key ? "active" : ""}
                              onClick={() => setWorkspaceView(key)}
                              onKeyDown={(event) => {
                                let next = index;
                                if (event.key === "ArrowRight")
                                  next = (next + 1) % WORKSPACE_SUB_VIEWS.length;
                                else if (event.key === "ArrowLeft")
                                  next =
                                    (next + WORKSPACE_SUB_VIEWS.length - 1) %
                                    WORKSPACE_SUB_VIEWS.length;
                                else if (event.key === "Home") next = 0;
                                else if (event.key === "End")
                                  next = WORKSPACE_SUB_VIEWS.length - 1;
                                else return;
                                event.preventDefault();
                                setWorkspaceView(WORKSPACE_SUB_VIEWS[next][0]);
                                const tabButtons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(":scope > button");
                                tabButtons?.[next]?.focus();
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <WorkspacePanels
                          session={active}
                          course={course}
                          workspaceView={workspaceView}
                          busy={busyId !== null}
                          transferBusy={transferBusy}
                          transferError={transferError}
                          reviewExplainBusy={reviewExplainBusy}
                          diagnosticBusy={diagnosticBusy}
                          diagnosticError={diagnosticError}
                          onClearDiagnosticError={() => setDiagnosticError(null)}
                          onEnterStep={enterWorkspaceStep}
                          onFocusChatInput={() => {
                            setTab("lesson");
                            requestAnimationFrame(() => document.getElementById("chat-input")?.focus());
                          }}
                          onNotify={notify}
                          onApplyDiagnosticStart={applyDiagnosticStart}
                          onSubmitDiagnostic={submitDiagnosis}
                          onChangeDiagnostic={(profile) => changeActive({ diagnostic: profile })}
                          onRestartDiagnostic={() => void startDiagnostic(active.topic, active.level, sessionGoal(active))}
                          onSetWorkspaceView={setWorkspaceView}
                          onClearTransferError={() => setTransferError(null)}
                          reviewedTransferId={reviewedTransferId}
                          onSubmitTransfer={(answer, question) =>
                            void submitTransferAnswer(answer, question)
                          }
                          onRequestTransferQuestion={requestTransferQuestion}
                          onRateReview={handleRateReview}
                          onOpenReviewTopic={(item) => {
                            const target = sessions.find((s) => s.id === item.sessionId);
                            if (target) {
                              ensureReviews(target);
                              openSession(target);
                            } else notify("产生这条复习的学习记录已不存在。");
                          }}
                          onExplainReview={explainReviewItemCard}
                        />
                      </div>
                    )}
                    {tab !== "lesson" && active.bookContext && latestAssistant?.teaching && (
                      <TeachingReceiptCard teaching={latestAssistant.teaching} quality={latestAssistant.quality} onOpenSource={openBookSource} />
                    )}
                    {error && error.sessionId === active.id && !(tab === "workspace" && workspaceView === "transfer") && (
                      <ErrorBox message={error.text} onClose={() => setError(null)} />
                    )}
                  </div>
                </>
                {tab === "lesson" && (
                  <div className="study-composer-wrap">
                    {!course && active.messages.some((message) => message.role === "assistant") && (
                      <div className="ai-tools" role="group" aria-label="让导师带我学">
                        <button
                          className="button primary"
                          disabled={busyId !== null}
                          onClick={() => void runAI("continue", undefined, active)}
                        >
                          <ArrowRight size={16} aria-hidden="true" />
                          你来安排下一步
                        </button>
                        <button
                          className="button secondary"
                          disabled={busyId !== null}
                          onClick={() => void runAI("message", "我卡住了。请先补清这一步必要的术语和机制，用一个更简单的例子带我理解，不要用更难的问题反问我。", active)}
                        >
                          <Lightbulb size={15} aria-hidden="true" />
                          我卡住了
                        </button>
                        <button
                          className="button secondary"
                          disabled={busyId !== null}
                          onClick={() => void runAI("example", undefined, active)}
                        >
                          <Sparkles size={15} aria-hidden="true" />
                          换个例子
                        </button>
                        <button
                          className="button secondary"
                          disabled={busyId !== null}
                          onClick={() => void runAI("hint", undefined, active)}
                        >
                          <Lightbulb size={15} aria-hidden="true" />
                          给点提示
                        </button>
                        <button
                          className="button secondary"
                          disabled={busyId !== null}
                          onClick={() => void runAI("summary", undefined, active)}
                        >
                          <FileText size={15} aria-hidden="true" />
                          帮我复盘
                        </button>
                      </div>
                    )}
                    <form className="study-composer" onSubmit={sendMessage}>
                      <label htmlFor="chat-input" className="sr-only">
                        向 AI 导师提问或分享你的理解
                      </label>
                      <textarea
                        id="chat-input"
                        value={chatInput}
                        maxLength={8000}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder={
                          course && !ready
                            ? "还有不明白的？连接 AI，获得专属讲解…"
                            : "哪里没听懂，想追问什么，或试着用自己的话解释…"
                        }
                        rows={1}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            if (chatInput.trim())
                              void runAI("message", chatInput, active);
                          }
                        }}
                      />
                      <div>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="添加学习资料"
                          title="添加 TXT / Markdown 资料"
                          onClick={() => fileRef.current?.click()}
                        >
                          <Paperclip size={18} />
                        </button>
                        {config.webFetchEnabled && !active?.bookContext && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="添加网页资料"
                            title="添加公开网页资料并逐字核验（不等于事实认证）"
                            onClick={() => {
                              setWebSourceError("");
                              setWebSourceOpen(true);
                            }}
                          >
                            <Globe size={18} />
                          </button>
                        )}
                        {canAutoSearch && !active?.bookContext && (
                          <button
                            type="button"
                            className={`icon-button${webSearchOn ? " active" : ""}`}
                            aria-pressed={webSearchOn}
                            aria-label="自动联网搜索"
                            title="本轮先用内置搜索供应商链查找网页来源；结果只作搜索摘要，不直接当事实认证"
                            onClick={() => setWebSearchOn((value) => !value)}
                          >
                            <Search size={18} />
                          </button>
                        )}
                        <button
                          type="submit"
                          className="send-button"
                          disabled={!chatInput.trim() || busyId !== null}
                          aria-label="发送问题"
                        >
                          <ArrowUp size={19} />
                        </button>
                      </div>
                    </form>
                    <ReferencesList
                      items={active.references}
                      onRemove={(index) =>
                        changeActive({
                          references: active.references.filter(
                            (_, i) => i !== index,
                          ),
                        })
                      }
                    />
                    <div className="study-composer-note">
                      <ShieldCheck size={12} />
                      <span>
                        {course
                          ? "内置内容可离线学习；自由问答使用 AI 模型。"
                          : "AI 可能出错，重要知识请核对可靠来源。"}
                      </span>
                      <span>理解比速度更重要</span>
                    </div>
                  </div>
                )}
                <div ref={studyEndRef} />
              </div>
              <aside className="study-rail">
                <>
                  <section className="learning-path">
                    {course ? (
                      <>
                        <div className="rail-card-heading">
                          <h2>
                            <Target size={17} />
                            本次课程路线
                          </h2>
                          <span>
                            {active.completedStages.length}/
                            {course.stages.length}
                          </span>
                        </div>
                        <p>完成理解检查，不等于整个领域已掌握。</p>
                        <div className="path-steps">
                          {course.stages.map((item, index) => {
                            const done = active.completedStages.includes(
                              item.id,
                            );
                            return (
                              <button
                                key={item.id}
                                className={`${done ? "done" : ""} ${index === active.stageIndex ? "current" : ""}`}
                                onClick={() => {
                                  changeActive({ stageIndex: index });
                                  setTab("lesson");
                                }}
                                title={`学习${item.title}`}
                              >
                                <span className="path-node">
                                  {done ? (
                                    <Check size={13} />
                                  ) : (
                                    String(index + 1).padStart(2, "0")
                                  )}
                                </span>
                                <div>
                                  <strong>{item.title}</strong>
                                  <small>
                                    {done
                                      ? "检查已通过"
                                      : index === active.stageIndex
                                        ? "正在探索"
                                        : "等待探索"}
                                  </small>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        <div className="path-progress">
                          <div>
                            <span>课程检查完成</span>
                            <strong>
                              {active.completedStages.length}/
                              {course.stages.length}
                            </strong>
                          </div>
                          <progress
                            max={course.stages.length}
                            value={active.completedStages.length}
                            aria-label="课程检查完成进度"
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="rail-card-heading">
                          <h2>
                            <Target size={17} />
                            理解证据与主线
                          </h2>
                        </div>
                        <p>按真实作答记录；选择正确不等于解释清楚。</p>
                        {active.learningState ? (
                          <LearningProgress
                            state={active.learningState}
                            busy={busy}
                            pendingPromptInThread={pendingPromptInThread}
                            onAnswer={answerPendingQuestion}
                            onResume={resumeMainLine}
                            onRestoreTrack={restoreSavedTrack}
                          />
                        ) : (
                          <div className="lp-legacy">
                            <p>
                              下一轮对话将建立可核验的学习状态。旧记录保留，但自评不会冒充理解证据。
                            </p>
                            {active.plan.length > 0 && (
                              <details>
                                <summary>查看旧路线（未核验）</summary>
                                <ol>
                                  {active.plan.map((title, index) => (
                                    <li key={index}>{title}</li>
                                  ))}
                                </ol>
                              </details>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </section>
                  {course && active.learningState && (
                    <section className="learning-path lp-followup">
                      <div className="rail-card-heading">
                        <h2>AI 追问记录</h2>
                      </div>
                      <LearningProgress
                        state={active.learningState}
                        busy={busy}
                        pendingPromptInThread={pendingPromptInThread}
                        onAnswer={answerPendingQuestion}
                        onResume={resumeMainLine}
                        onRestoreTrack={restoreSavedTrack}
                      />
                    </section>
                  )}
                </>
                <section className="learning-goal">
                  <span className="eyebrow">TODAY'S LITTLE GOAL</span>
                  <h3>
                    不是复述一句结论，
                    <br />
                    而是理解它为什么成立。
                  </h3>
                  <p>
                    {course
                      ? "试着完成本节思考题，再用自己的话讲一遍。"
                      : (active.learningState?.goal ?? active.goal)}
                  </p>
                  <div>
                    <Lightbulb size={15} />
                    <span>答错也没关系，思考本身就有价值。</span>
                  </div>
                </section>
                <section className="study-tool-list">
                  <h3>给知识一个落点</h3>
                  <button onClick={() => setTab("quiz")}>
                    <span className="tool-icon">
                      <Brain size={18} />
                    </span>
                    <div>
                      <strong>做一组练习</strong>
                      <small>
                        {active.quiz.length
                          ? `${active.quiz.length} 道题，检查理解`
                          : "根据学习内容生成"}
                      </small>
                    </div>
                    <ChevronRight size={15} />
                  </button>
                  <button onClick={() => setTab("cards")}>
                    <span className="tool-icon warm">
                      <Layers3 size={18} />
                    </span>
                    <div>
                      <strong>翻翻记忆卡</strong>
                      <small>
                        {active.flashcards.length
                          ? `${active.reviewedCards.length} / ${active.flashcards.length} 张已回顾`
                          : "把概念带走，随时复习"}
                      </small>
                    </div>
                    <ChevronRight size={15} />
                  </button>
                  <button
                    onClick={() => {
                      const latest = [...active.messages]
                        .reverse()
                        .find((m) => m.role === "assistant");
                      if (latest) saveNote(latest.content);
                      else if (stage) saveNote(stage.content, stage.title);
                      else notify("先开始一段学习，再收藏讲解吧");
                    }}
                  >
                    <span className="tool-icon blue">
                      <BookMarked size={18} />
                    </span>
                    <div>
                      <strong>收藏这次理解</strong>
                      <small>留在你的知识笔记里</small>
                    </div>
                    <Plus size={15} />
                  </button>
                </section>
                <div className="rail-bottom">
                  <BrandMark small />
                  <p>
                    不求一下全懂，
                    <br />
                    但求每次更懂一点。
                  </p>
                </div>
              </aside>
            </div>
          )}

          {view === "notes" && (
            <div className="collection-page">
              <div className="collection-heading">
                <div>
                  <span className="eyebrow">YOUR GROWING KNOWLEDGE</span>
                  <h1>把理解，留给未来的自己。</h1>
                  <p>那些让你恍然大悟的瞬间，值得被记下来。</p>
                </div>
                <button
                  className="button primary"
                  onClick={() =>
                    setNoteEditor({
                      id: uid(),
                      sessionId: "",
                      title: "",
                      content: "",
                      createdAt: localNow(),
                    })
                  }
                >
                  <Plus size={17} />
                  写一篇笔记
                </button>
              </div>
              <div className="collection-toolbar">
                <div className="search-field">
                  <Search size={17} />
                  <input
                    aria-label="搜索知识笔记"
                    placeholder="寻找一个概念、一点灵感…"
                    value={noteSearch}
                    onChange={(e) => setNoteSearch(e.target.value)}
                  />
                </div>
                <span>{notes.length} 篇知识笔记</span>
                <button
                  className="text-button"
                  disabled={!notes.length}
                  onClick={() =>
                    downloadText(
                      "知序-全部知识笔记.md",
                      notes
                        .map((n) => `# ${n.title}\n\n${n.content}`)
                        .join("\n\n---\n\n"),
                    )
                  }
                >
                  <ArrowDownToLine size={15} />
                  导出全部
                </button>
              </div>
              {notes.length ? (
                <div className="notes-grid">
                  {notes
                    .filter((n) =>
                      `${n.title}${n.content}`
                        .toLowerCase()
                        .includes(noteSearch.toLowerCase()),
                    )
                    .map((note) => (
                      <article className="note-card" key={note.id}>
                        <button
                          className="note-open"
                          onClick={() => setNoteEditor(note)}
                        >
                          <span className="note-date">
                            <FileText size={15} />
                            {new Date(note.createdAt).toLocaleDateString(
                              "zh-CN",
                            )}
                          </span>
                          <h2>{note.title}</h2>
                          <p>
                            {note.content.replace(/[#*$`>]/g, "").slice(0, 160)}
                          </p>
                        </button>
                        <div className="note-footer">
                          <button
                            className="text-button"
                            disabled={
                              !sessions.some((s) => s.id === note.sessionId)
                            }
                            onClick={() => {
                              const s = sessions.find(
                                (s) => s.id === note.sessionId,
                              );
                              if (s) openSession(s);
                            }}
                          >
                            回到学习
                            <ArrowRight size={13} />
                          </button>
                          <button
                            className="icon-button tiny"
                            aria-label={`删除笔记 ${note.title}`}
                            onClick={() => setDeleteNoteId(note.id)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </article>
                    ))}
                </div>
              ) : (
                <div className="empty-state large">
                  <div className="empty-illustration">
                    <BookMarked size={40} strokeWidth={1.3} />
                  </div>
                  <h2>你的知识花园，还在等待第一颗种子。</h2>
                  <p>
                    学习时点击收藏，或写下自己的理解。
                    <br />
                    未登录时只保存在当前浏览器；登录后同步到云端，也可以随时导出。
                  </p>
                  <button
                    className="button secondary"
                    onClick={() => navigate("home")}
                  >
                    去发现新知识
                    <ArrowRight size={15} />
                  </button>
                </div>
              )}
              {notes.length > 0 &&
                !notes.some((n) =>
                  `${n.title}${n.content}`
                    .toLowerCase()
                    .includes(noteSearch.toLowerCase()),
                ) && (
                  <div className="empty-state">
                    <Search size={32} />
                    <h2>还没有找到相关笔记</h2>
                    <p>换一个关键词试试看。</p>
                  </div>
                )}
            </div>
          )}

          {view === "review" && (
            <div className="collection-page">
              <div className="collection-heading">
                <div>
                  <span className="eyebrow">MAKE IT YOUR OWN</span>
                  <h1>再回想一次，就更近一点。</h1>
                  <p>用练习发现盲点，用回忆巩固理解。</p>
                </div>
                <span className="review-summary">
                  <Layers3 size={18} />
                  已回顾 {reviewed} 张知识卡
                </span>
              </div>
              <GlobalReviewWorkspace
                sessions={sessions}
                busy={busyId !== null || reviewExplainBusy}
                onRate={handleRateReview}
                onOpenSession={(target) => {
                  ensureReviews(target);
                  openSession(target);
                }}
                onExplain={explainReviewItemCard}
                onRefreshReviews={() => {
                  for (const session of sessions) ensureReviews(session);
                }}
              />
              {sessions.length ? (
                <div className="review-grid">
                  {sessions.map((s) => (
                    <article className="review-card" key={s.id}>
                      <div className="review-card-top">
                        <span className="tool-icon">
                          <GraduationCap size={23} />
                        </span>
                        <span>{s.courseId ? "互动课程" : "AI 学习"}</span>
                      </div>
                      <h2>{s.title}</h2>
                      <p>
                        {s.quizSubmitted
                          ? `上次练习答对 ${s.quiz.filter((q) => s.quizAnswers[q.id] === q.correctIndex).length} / ${s.quiz.length} 题`
                          : "从一次小练习，检查自己的理解。"}
                      </p>
                      <div className="review-card-actions">
                        <button
                          className="button secondary"
                          onClick={() => openSession(s, "quiz")}
                        >
                          <Brain size={16} />
                          随堂练习{s.quiz.length ? ` · ${s.quiz.length}` : ""}
                        </button>
                        <button
                          className="button secondary"
                          onClick={() => openSession(s, "cards")}
                        >
                          <Layers3 size={16} />
                          记忆卡
                          {s.flashcards.length
                            ? ` · ${s.flashcards.length}`
                            : ""}
                        </button>
                      </div>
                      <div className="review-card-bottom">
                        <span>记忆卡回顾</span>
                        <progress
                          max={Math.max(s.flashcards.length, 1)}
                          value={s.reviewedCards.length}
                          aria-label={`${s.title}记忆卡回顾进度`}
                        />
                        <strong>
                          {s.reviewedCards.length}/{s.flashcards.length}
                        </strong>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state large">
                  <div className="empty-illustration">
                    <Brain size={42} strokeWidth={1.3} />
                  </div>
                  <h2>先理解，再让知识留下来。</h2>
                  <p>开启一门互动课程，就能获得配套练习和记忆卡。</p>
                  <button
                    className="button primary"
                    onClick={() => openCourse("derivative")}
                  >
                    从导数的直觉开始
                    <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        onChange={uploadReference}
        tabIndex={-1}
        aria-label="上传学习资料"
      />
      <input
        ref={backupInputRef}
        className="sr-only"
        type="file"
        accept=".json,application/json"
        onChange={(event) => void importBackup(event)}
        tabIndex={-1}
        aria-label="导入备份文件"
      />
      {backupError && (
        <Modal
          title="备份导入失败"
          onClose={() => setBackupError(null)}
        >
          <p>{backupError}</p>
          <button
            className="button primary full-width"
            onClick={() => setBackupError(null)}
          >
            知道了
          </button>
        </Modal>
      )}
      {accountOpen && (
        <Modal
          title="账户与云同步"
          subtitle="登录后学习记录在设备间自动同步；开启 BYOK 时，个人密钥加密保存在服务端，不写入学习备份或导出。"
          onClose={() => {
            setAccountOpen(false);
            if (resumeSettingsAfterLogin) {
              // 从设置弹窗去登录又放弃：与“暂不连接”一致，丢弃挂起的提问，
              // 避免之后再登录时突然继续一次过期请求。
              setResumeSettingsAfterLogin(false);
              cancelPending();
            }
          }}
        >
          <AccountPanel
            user={authUser}
            config={config}
            fetcher={fetcher}
            syncStatus={syncStatus}
            workspace={cloudWorkspace}
            onLoginSuccess={(user, result) => {
              handleSignedIn(user, result);
              if (!resumeSettingsAfterLogin) return;
              setResumeSettingsAfterLogin(false);
              // 归档失败进入 blocked：先让用户处理账户切换弹窗，不叠加设置弹窗。
              if (accountSwitchStateRef.current.phase === "blocked") return;
              // 从“连接你的 AI 导师”来的登录：直接回到配置流程，pending 提问保留。
              setAccountOpen(false);
              setSettingsOpen(true);
            }}
            onLoggedOut={() => {
              handleSignedOut({ notify: true });
              setAccountOpen(false);
            }}
            onAccountDeleted={() => {
              // 先启动针对当前账户书架库的清理（内部已捕获目标 DB），
              // 随即同步清空本机学习数据；不等待 IndexedDB，避免刷新后残留。
              const bookCleanup = clearBookLibrary();
              handleSignedOut({ notify: false, wipeLocal: true });
              setAccountOpen(false);
              void bookCleanup
                .then(() => notify("账户已删除；本机学习数据与书架也已清空。"))
                .catch((error: unknown) =>
                  notify(
                    `账户已删除，但本机书架清理失败：${
                      error instanceof Error ? error.message : "请清理浏览器站点数据"
                    }`,
                  ),
                );
            }}
            onRetrySync={() => void performSyncRef.current()}
          />
        </Modal>
      )}
      {webSourceOpen && (
        <Modal
          title="添加网页资料"
          subtitle="指定公开网页，服务端抓取正文；可选逐字核验一段原文。"
          onClose={() => {
            if (webSourceBusy) return;
            setWebSourceOpen(false);
            setWebSourceError("");
          }}
        >
          <form
            className="web-source-form"
            onSubmit={(event) => {
              event.preventDefault();
              void addWebSource();
            }}
          >
            <label>
              <span>网页地址</span>
              <input
                type="url"
                value={webSourceUrl}
                onChange={(event) => setWebSourceUrl(event.target.value)}
                placeholder="https://example.com/reference"
                maxLength={2048}
                autoFocus
                required
              />
            </label>
            <label>
              <span>可选：要在页面中逐字核验的原文</span>
              <textarea
                value={webSourceClaim}
                onChange={(event) => setWebSourceClaim(event.target.value)}
                placeholder="粘贴需要确认是否出现在页面中的一段原文；不填则只添加网页资料。"
                maxLength={1000}
                rows={3}
              />
            </label>
            <div className="info-box">
              <ShieldCheck size={14} aria-hidden="true" />
              <span>
                只抓取公开 HTTPS 网页，不登录、不携带 Cookie。逐字命中只证明这段文字出现在页面中，不证明该说法正确、完整或最新。网址、抓取时间与正文会随资料保存，并发送给所选模型。
              </span>
            </div>
            {webSourceError && (
              <p className="web-source-error" role="alert">{webSourceError}</p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={webSourceBusy}
                onClick={() => {
                  setWebSourceOpen(false);
                  setWebSourceError("");
                }}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={webSourceBusy || !webSourceUrl.trim()}
              >
                {webSourceBusy ? "抓取中…" : "抓取并核验"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {quotaNotice && (
        <Modal title={quotaNotice.title} onClose={() => setQuotaNotice(null)}>
          <p>{quotaNotice.text}</p>
          <button
            className="button primary full-width"
            onClick={() => setQuotaNotice(null)}
          >
            知道了
          </button>
        </Modal>
      )}
      {settingsOpen && (
        <SettingsModal
          initial={settings}
          config={config}
          pending={!!pending}
          savedCredentials={serverCredentialsMayExist || undefined}
          onClose={() => {
            setSettingsOpen(false);
            cancelPending();
          }}
          canConfigureKeys={canUsePersonalKeys}
          onLogin={
            allowByok && !authUser
              ? () => {
                  // 不清除 pending：登录后回到设置弹窗，保存配置即继续原提问、诊断或补讲。
                  setResumeSettingsAfterLogin(true);
                  setSettingsOpen(false);
                  setAccountOpen(true);
                }
              : undefined
          }
          onSave={(value) => {
            const nextValue = canUsePersonalKeys ? value : clearPersonalKeys(value);
            const savingUserId = authUser?.id ?? null;
            setSettingsOpen(false);
            void (async () => {
              if (canUsePersonalKeys && authUser) {
                try {
                  await saveCredentials(fetcher, nextValue, authUser.id);
                } catch (error) {
                  cancelPending();
                  if (authUserRef.current?.id !== savingUserId) return;
                  notify(
                    error instanceof Error
                      ? `个人配置未保存到服务端，本次修改未应用：${error.message}`
                      : "个人配置未保存到服务端，本次修改未应用。",
                  );
                  return;
                }
              }
              if (savingUserId && authUserRef.current?.id !== savingUserId) {
                cancelPending();
                return;
              }
              setSettings(nextValue);
              // 保存成功即代表服务端当前保存的就是这份配置；空 Key 表示已清空。
              setServerCredentialsMayExist(!!nextValue.apiKey?.trim());
              // 设置版本时间随保存持久化：其他设备登录时只有更新的版本才会覆盖本地设置。
              rememberSettingsUpdatedAt(localNow());
              let localWarning: string | null = null;
              try {
                saveSafeSettings(nextValue);
              } catch {
                localWarning = "配置已应用到本页，但非敏感设置无法保存到浏览器。";
              }
              if (pending) {
                const next = pending;
                setPending(null);
                if (next.kind === "chat") {
                  void runAI(next.action, next.text, next.target, nextValue);
                } else if (next.kind === "diagnostic") {
                  // 用刚保存的配置续跑原诊断，不再依赖尚未刷新的 settings 状态。
                  void startDiagnostic(
                    next.topic,
                    next.level,
                    next.goal,
                    nextValue,
                  );
                } else if (next.kind === "review") {
                  void resumeReviewExplain(next.item, nextValue);
                }
              }
              if (localWarning) {
                notify(localWarning);
              } else if (!pending) {
                notify(
                  !canUsePersonalKeys
                    ? "将使用服务器配置的模型"
                    : nextValue.apiKey
                      ? "配置已保存到服务端，发送问题即可开始验证"
                      : "配置已保存；当前未设置个人模型 Key，AI 请求会被拒绝。",
                );
              }
            })();
          }}
        />
      )}
      {helpOpen && (
        <Modal
          title="你定目标，导师带你学"
          subtitle="学习路径由导师安排，是否学会依据你的真实表现。"
          onClose={() => setHelpOpen(false)}
        >
          <div className="help-content">
            <div>
              <span>
                <Compass size={21} />
              </span>
              <section>
                <h3>告诉我你要解决什么问题</h3>
                <p>
                  首页直接写目标，实际用途可选填。导师会安排起点和学习路线，不要求你先懂术语或自己排课程。也可以从书籍章节或资料开始。
                </p>
              </section>
            </div>
            <div>
              <span>
                <Lightbulb size={21} />
              </span>
              <section>
                <h3>听不懂就打断，不必每轮考试</h3>
                <p>
                  用“你来安排下一步”继续听讲，“我卡住了”回到必要基础，也可以随时追问、换例子或要提示。点击操作不算独立作答，不会把看过记成掌握。
                </p>
              </section>
            </div>
            <div>
              <span>
                <Brain size={21} />
              </span>
              <section>
                <h3>把知识变成自己的</h3>
                <p>
                  需要时用练习和自己的解释核验理解；“帮我复盘”区分讲过、已核验和待巩固，并给下次具体起点。书架、笔记与记录只是辅助，不替你宣称学会。
                </p>
              </section>
            </div>
            <div>
              <span><BookOpen size={21} aria-hidden="true" /></span>
              <section><h3>带着原书一起学</h3><p>从「我的书架」导入 PDF 文本层、EPUB、TXT 或 Markdown。解析与原文件保存在本机；AI 只收到本轮选定片段，引用可回到对应段落。扫描件先做 OCR，已读不等于已掌握。</p><p>教学方法参考 book-study、ljg-book，已适配本产品的理解证据与材料边界。<a href="/book-credits.txt" target="_blank" rel="noopener noreferrer">来源与许可</a></p></section>
            </div>
            <div className="info-box">
              <ShieldCheck size={18} />
              <p>
                {authUser
                  ? "登录后学习记录会自动同步到云端，并在本机保留一份；开启 BYOK 时，个人模型与搜索密钥加密保存在服务端，仅当前账户可用，不进入学习备份或导出。"
                  : config.authRequired
                    ? "公共版登录后学习记录会同步到云端，本机也会保留一份。"
                    : "学习记录只保存在本机浏览器，不是云端备份。请定期导出。"}
                内置课程不需要密钥；AI 效果取决于模型，不等同于 Gemini 官方产品。
                {apiAvailable === false
                  ? config.authRequired
                    ? "当前无法连接知序服务，请稍后重试。"
                    : "当前无法连接本地 AI 后端，请确认 npm run dev 正在运行。"
                  : ""}
              </p>
            </div>
          </div>
          <button
            className="button primary full-width"
            onClick={() => setHelpOpen(false)}
          >
            带着好奇，开始吧
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {searchOpen && (
        <Modal
          title="寻找你的学习足迹"
          onClose={() => {
            setSearchOpen(false);
            setSearch("");
          }}
        >
          <div className="search-field modal-search">
            <Search size={18} />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索主题、课程或学习记录"
              aria-label="搜索主题"
            />
          </div>
          <div className="search-results">
            {sessions
              .filter((s) =>
                s.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    openSession(s);
                    setSearchOpen(false);
                  }}
                >
                  <MessageSquare size={18} />
                  <span>
                    {s.title}
                    <small>我的学习记录</small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))}
            {courses
              .filter((c) =>
                `${c.title}${c.subject}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    openCourse(c.id);
                    setSearchOpen(false);
                  }}
                >
                  <BookOpen size={18} />
                  <span>
                    {c.title}
                    <small>内置互动课程 · {c.duration} 分钟</small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))}
            {search &&
              !sessions.some((s) =>
                s.title.toLowerCase().includes(search.toLowerCase()),
              ) &&
              !courses.some((c) =>
                `${c.title}${c.subject}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ) && (
                <p className="search-empty">还没有相关内容，试试其他关键词。</p>
              )}
          </div>
        </Modal>
      )}
      {noteEditor && (
        <NoteEditor
          note={noteEditor}
          onClose={() => setNoteEditor(null)}
          onSave={(note) => {
            setNotes((previous) =>
              previous.some((n) => n.id === note.id)
                ? previous.map((n) => (n.id === note.id ? { ...note, updatedAt: localNow() } : n))
                : [note, ...previous],
            );
            setNoteEditor(null);
            recordActivity();
            notify(authUser ? "笔记已保存，等待同步到云端" : "笔记已保存到本机");
          }}
        />
      )}
      {deleteNoteId && (
        <Modal
          title="删除这篇笔记？"
          subtitle="删除后无法恢复，其他学习记录不会受影响。"
          onClose={() => setDeleteNoteId(null)}
        >
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDeleteNoteId(null)}
            >
              保留笔记
            </button>
            <button
              className="button danger"
              disabled={noteDeleting}
              onClick={() => {
                const target = deleteNoteId;
                if (!target) return;
                const removeLocal = () => {
                  // 墓碑先于列表更新写入：之后任何旧云端/旧设备快照合并时都不能复活这篇笔记。
                  rememberDeletedNoteIds([...deletedNoteIdsRef.current, target]);
                  // useStoredList 在持久化时会与磁盘做并集；必须先把磁盘里的项删掉，
                  // 否则刚删除的笔记会被旧值合并回来。
                  try {
                    const key = `${STORAGE_PREFIX}notes`;
                    const raw = localStorage.getItem(key);
                    const current: unknown = raw ? JSON.parse(raw) : [];
                    if (Array.isArray(current)) {
                      localStorage.setItem(
                        key,
                        JSON.stringify(
                          current.filter((item) => {
                            if (
                              !item ||
                              typeof item !== "object" ||
                              Array.isArray(item)
                            ) {
                              return true;
                            }
                            if (!("id" in item)) return true;
                            return item.id !== target;
                          }),
                        ),
                      );
                    }
                  } catch {
                    // 存储不可用时仍更新内存；失败由既有 storageError 提示。
                  }
                  setNotes((previous) => previous.filter((n) => n.id !== target));
                  setDeleteNoteId(null);
                  notify("笔记已删除");
                };
                if (!authUser) {
                  removeLocal();
                  return;
                }
                setNoteDeleting(true);
                void deleteCloudNote(fetcher, target, authUser.id)
                  .then((workspace) => {
                    setCloudWorkspace(workspace);
                    removeLocal();
                  })
                  .catch((error: unknown) => {
                    notify(
                      `云端删除失败，笔记仍保留：${
                        error instanceof Error ? error.message : "请稍后重试"
                      }`,
                    );
                  })
                  .finally(() => setNoteDeleting(false));
              }}
            >
              {noteDeleting ? "正在同步删除…" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

interface WorkspacePanelsProps {
  session: StudySession;
  course: Course | undefined;
  workspaceView: WorkspaceSubView;
  busy: boolean;
  transferBusy: boolean;
  transferError: string | null;
  reviewExplainBusy: boolean;
  diagnosticBusy: boolean;
  diagnosticError: string | null;
  onClearDiagnosticError: () => void;
  onEnterStep: (stepId: string) => void;
  onFocusChatInput: () => void;
  onNotify: (text: string) => void;
  onApplyDiagnosticStart: (profile: DiagnosticProfile) => void;
  onSubmitDiagnostic: (
    profile: DiagnosticProfile,
    answers: Record<string, number>,
  ) => DiagnosticProfile | null;
  onChangeDiagnostic: (profile: DiagnosticProfile) => void;
  onRestartDiagnostic: () => void;
  onSetWorkspaceView: (view: WorkspaceSubView) => void;
  onClearTransferError: () => void;
  reviewedTransferId?: string;
  onSubmitTransfer: (answer: string, question: LearningQuestion) => void;
  onRequestTransferQuestion: () => void;
  onRateReview: (item: ReviewItem, rating: ReviewRating) => void;
  onOpenReviewTopic: (item: ReviewItem) => void;
  onExplainReview: (item: ReviewItem) => Promise<string>;
}

function WorkspacePanels({ session, course, workspaceView, busy, transferBusy, transferError, reviewExplainBusy, diagnosticBusy, diagnosticError, onClearDiagnosticError, onEnterStep, onFocusChatInput, onNotify, onApplyDiagnosticStart, onSubmitDiagnostic, onChangeDiagnostic, onRestartDiagnostic, onSetWorkspaceView, onClearTransferError, reviewedTransferId, onSubmitTransfer, onRequestTransferQuestion, onRateReview, onOpenReviewTopic, onExplainReview }: WorkspacePanelsProps) {
  const pathSteps = course ? coursePathSteps(course.stages, session.completedStages, session.stageIndex) : session.learningState ? learningStatePathSteps(session.learningState) : [];
  const requested = pathSteps.find(step => step.id === (course ? course.stages[session.stageIndex]?.id : session.learningState?.currentStepId));
  const progress = pathSteps.length ? computePathProgress(pathSteps, pathSteps.filter(step => step.status === "done").map(step => step.id), requested?.status === "done" ? null : requested?.id) : null;
  const diagnostic = session.diagnostic;
  const questionsById = Object.fromEntries(session.quiz.map(question => [question.id, question]));
  const reviews = session.reviews ?? [];
  if (workspaceView === "path") return <div className="ws-path-view">
    {diagnosticError && <ErrorBox message={diagnosticError} onClose={onClearDiagnosticError} />}
    {diagnostic && <>
      <DiagnosticPanel profile={diagnostic} busy={busy || diagnosticBusy} onChange={answers => onChangeDiagnostic({ ...diagnostic, answers })} onSubmit={() => { onSubmitDiagnostic(diagnostic, diagnostic.answers); }} onRestart={onRestartDiagnostic} />
      {diagnostic.submitted && <button type="button" className="button secondary" disabled={busy && !course} onClick={() => onApplyDiagnosticStart(diagnostic)}>{course ? "回到推荐小节" : "从推荐起点开始学习"}<ArrowRight size={15} /></button>}
    </>}
    {progress ? <>
      <LearningPath steps={progress.steps} suggestedStepId={requested?.status === "done" ? progress.currentStepId : null} busy={busy} onEnterStep={onEnterStep} onResumePending={onFocusChatInput} onLockedStepInfo={(stepId, missing) => onNotify(`「${progress.steps.find(step => step.id === stepId)?.title ?? "这一步"}」还需完成：${missing.map(id => progress.steps.find(step => step.id === id)?.title ?? id).join("、")}`)} />
      <p className="ws-diag-note">{describePathProgress(progress, requested?.status === "done")}。预计时间只是学习安排，不代表掌握程度。</p>
    </> : <div className="empty-state"><Target size={32} /><h2>还没有学习路径</h2><p>回到「引导学习」让导师安排起点；需要诊断时可从首页选择「先做诊断」。路径不会因为听讲而自动标记掌握。</p></div>}
  </div>;
  if (workspaceView === "transfer") return <div>
    {session.learningState ? <TransferPractice state={session.learningState} track={session.transferTrack} busy={busy || transferBusy} reviewedQuestionId={reviewedTransferId} onRequestQuestion={onRequestTransferQuestion} onSubmitAnswer={onSubmitTransfer} /> : <div className="empty-state"><Brain size={32} /><h2>先建立真实学习主线</h2><p>内置课程的选择题只用于理解检查，不能冒充迁移证据。可回到引导学习，连接导师后用开放式回答做迁移练习。</p></div>}
    {transferError && <ErrorBox message={transferError} onClose={onClearTransferError} />}
  </div>;
  if (workspaceView === "review") return <ReviewWorkspace reviews={reviews} questionsById={questionsById} busy={busy || reviewExplainBusy} onRate={onRateReview} onOpenTopic={onOpenReviewTopic} onExplain={onExplainReview} />;
  return session.learningState ? <LearningReport state={session.learningState} reviews={reviews} diagnostic={diagnostic} busy={busy} onOpenReviews={() => onSetWorkspaceView("review")} onResumeQuestion={onFocusChatInput} onJumpToStep={onEnterStep} /> : <div className="empty-state"><FileText size={32} /><h2>还没有 AI 理解证据报告</h2><p>{course ? `已完成 ${session.completedStages.length}/${course.stages.length} 个课程理解检查；这些记录不等于推理或迁移证据。` : "先开始真实学习并作答，报告会区分辨认、推理与迁移。"} {reviews.length ? `当前有 ${reviews.length} 条真实错题或误区复习记录。` : "还没有复习项。"}</p></div>;
}

/** 全局复习页：跨会话汇总真实复习项；题目原文从各自会话的 quiz 取。 */
function GlobalReviewWorkspace({
  sessions,
  busy,
  onRate,
  onOpenSession,
  onExplain,
  onRefreshReviews,
}: {
  sessions: StudySession[];
  busy: boolean;
  onRate: (item: ReviewItem, rating: ReviewRating) => void;
  onOpenSession: (session: StudySession) => void;
  onExplain: (item: ReviewItem) => Promise<string>;
  onRefreshReviews: () => void;
}) {
  const allReviews = sessions.flatMap((session) => session.reviews ?? []);
  const questionsById: Record<string, QuizQuestion> = {};
  for (const session of sessions)
    for (const question of session.quiz) questionsById[question.id] = question;
  return (
    <>
      <ReviewWorkspace
        reviews={allReviews}
        questionsById={questionsById}
        busy={busy}
        onRate={onRate}
        onOpenTopic={(item) => {
          const target = sessions.find((session) => session.id === item.sessionId);
          if (target) onOpenSession(target);
        }}
        onExplain={onExplain}
      />
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={onRefreshReviews}
      >
        从各学习记录的真实错题重新整理复习项
      </button>
    </>
  );
}

/** 诊断作答表单：radio 逐题作答、显示未答状态与提示（不泄露答案）；提交走真实 evaluateDiagnostic。 */


function ErrorBox({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <CircleHelp size={18} />
      <p>{message}</p>
      <button
        className="icon-button tiny"
        aria-label="关闭错误提示"
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </div>
  );
}

function ActivityCard({ activity }: { activity: string[] }) {
  const days = Array.from({ length: 35 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - 34 + i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { key, active: activity.includes(key) };
  });
  const recentCount = days.filter((day) => day.active).length;
  return (
    <section className="activity-card">
      <div className="rail-card-heading">
        <h2>好奇心足迹</h2>
        <span>近 35 天</span>
      </div>
      <div
        className="activity-grid"
        role="img"
        aria-label={`近35天有${recentCount}天学习记录`}
      >
        {days.map((day) => (
          <span
            key={day.key}
            className={day.active ? "has-activity" : ""}
            title={`${day.key} · ${day.active ? "有学习记录" : "暂无记录"}`}
          />
        ))}
      </div>
      <div className="activity-caption">
        <span>
          {recentCount ? (
            <>
              <strong>{recentCount}</strong> 天与新知识相遇
            </>
          ) : (
            "下一格，等你的好奇点亮"
          )}
        </span>
        <div>
          <i />
          <span>未学</span>
          <i />
          <span>已学</span>
        </div>
      </div>
    </section>
  );
}

function NoteEditor({
  note,
  onClose,
  onSave,
}: {
  note: Note;
  onClose: () => void;
  onSave: (note: Note) => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [preview, setPreview] = useState(false);
  return (
    <Modal
      title={note.title ? "整理我的理解" : "写下新的理解"}
      subtitle="用自己的话再讲一遍，让知识真正属于你。"
      onClose={onClose}
      wide
    >
      <form
        className="note-editor"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...note, title: title.trim(), content: content.trim() });
        }}
      >
        <label>
          笔记标题
          <input
            required
            maxLength={150}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="给这份理解起个名字"
          />
        </label>
        <div className="editor-label">
          <label htmlFor="note-content">我的理解</label>
          <button
            type="button"
            className="text-button"
            onClick={() => setPreview(!preview)}
          >
            {preview ? "继续编辑" : "预览 Markdown"}
          </button>
        </div>
        {preview ? (
          <div className="note-preview">
            <RichText>
              {content || "还没有内容。切换编辑，写下你的理解吧。"}
            </RichText>
          </div>
        ) : (
          <textarea
            id="note-content"
            required
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            placeholder="一个关键概念、一段推导，或一个新的发现…支持 Markdown 和数学公式。"
          />
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={!content.trim()}
            onClick={() =>
              downloadText(
                `${(title || "学习笔记").replace(/[\\/:*?"<>|]/g, "-")}.md`,
                `# ${title}\n\n${content}`,
              )
            }
          >
            <ArrowDownToLine size={16} />
            导出笔记
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={!title.trim() || !content.trim()}
          >
            <Check size={17} />
            保存笔记
          </button>
        </div>
      </form>
    </Modal>
  );
}
