import type {
  DiagnosticProfile,
  Note,
  QuizQuestion,
  Reference,
  ReviewItem,
  StudyBackup,
  StudySession,
  ThinkingLevel,
} from "../types";
import { BookContextError, parseBookContext } from "./bookProtocol";
import {
  validateDiagnosticProfile,
  validateQuizQuestion,
} from "./diagnostic";
import { parseLearningState, LearningProtocolError } from "./learningState";
import { isReviewItem } from "./review";
import { mergeSessions, mergeSessionIds } from "./sessionMerge";

const BACKUP_FORMAT = "zhixu-study-backup";

/** 备份里绝不允许出现的字段名（深度扫描，防止密钥被夹带进备份文件）。 */
const FORBIDDEN_KEY = /^(api[-_]?key|apikey|search[-_]?api[-_]?key|secret|password|access[-_]?token|authorization)$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REVIEW_KINDS = ["quiz", "misconception", "concept"] as const;
const REVIEW_SOURCES = ["quiz", "misconception", "concept", "diagnostic"] as const;
const REVIEW_OUTCOMES = ["again", "fuzzy", "known"] as const;
const THINKING_LEVELS: readonly ThinkingLevel[] = ["auto", "low", "medium", "high"];
/** 单用户墓碑上限：远超正常删除量；超出视为损坏备份，避免无限增长。 */
export const MAX_DELETED_NOTE_IDS = 10_000;
/** 单条墓碑 ID 的长度上限（正常 id 为 UUID）。 */
export const MAX_DELETED_NOTE_ID_LENGTH = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * 把设置版本规范成非负整数；缺失、非数字、负数一律视为 0。
 * 0 代表“旧备份/从未带版本”，因此永远压不过真正带版本的新值。
 */
export function resolveSettingsUpdatedAt(value: unknown): number {
  return isNumber(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 笔记 / 复习项的显式版本时间（毫秒）；缺失或非法一律为 0，
 * 0 代表“旧数据/无法证明更新”，不能覆盖当前内容。
 */
export function noteUpdatedAt(note: Note): number {
  return resolveSettingsUpdatedAt(note.updatedAt);
}

/** 复习项的显式版本时间（毫秒）；缺失/非法为 0。 */
export function reviewUpdatedAt(item: ReviewItem): number {
  return resolveSettingsUpdatedAt(item.updatedAt);
}

/**
 * 笔记新旧：只有严格更新的显式 updatedAt 才能覆盖当前笔记。
 * 旧备份没有 updatedAt 时 incomingAt=0，永远压不过当前内容，
 * 避免旧设备/旧云快照把刚编辑的笔记写回旧值。
 */
export function isIncomingNoteNewer(incoming: Note, current: Note): boolean {
  const incomingAt = noteUpdatedAt(incoming);
  return incomingAt > 0 && incomingAt > noteUpdatedAt(current);
}

/**
 * 复习项新旧（兼容没有 updatedAt 的旧数据）：
 * 1. 任一端有显式 updatedAt 时，先比显式时间（严格更大者胜）；
 * 2. 显式时间相同，或两端都没有显式时间时，先比 attempts（真实评分次数），再比 dueAt；
 * 3. attempts/dueAt 都相同时，已评分（有 lastOutcome）优先于初始项。
 * 平局保留当前项：旧副本不得覆盖同等或无法证明更新的复习进度。
 */
export function isIncomingReviewNewer(
  incoming: ReviewItem,
  current: ReviewItem,
): boolean {
  const incomingAt = reviewUpdatedAt(incoming);
  const currentAt = reviewUpdatedAt(current);
  if (incomingAt !== currentAt) return incomingAt > currentAt;
  if (incoming.attempts !== current.attempts) return incoming.attempts > current.attempts;
  if (incoming.dueAt !== current.dueAt) return incoming.dueAt > current.dueAt;
  return incoming.lastOutcome !== undefined && current.lastOutcome === undefined;
}

/**
 * 诊断新旧（兼容没有 updatedAt 的旧数据）：
 * 已提交永远比未提交新；双方都已提交时，只有严格更大的 evaluatedAt 才覆盖。
 * evaluatedAt 缺失/相等一律保留当前画像，旧备份不能抹掉已评价结果。
 */
export function isIncomingDiagnosticNewer(
  incoming: DiagnosticProfile,
  current: DiagnosticProfile,
): boolean {
  if (incoming.submitted !== current.submitted) return incoming.submitted;
  if (!incoming.submitted) return false;
  const incomingAt = resolveSettingsUpdatedAt(incoming.evaluatedAt);
  return incomingAt > 0 && incomingAt > resolveSettingsUpdatedAt(current.evaluatedAt);
}

/**
 * 归一化墓碑列表：只保留非空、未超长的字符串 ID，去重并排序（稳定输出），
 * 超过上限时保留排序后的前 MAX_DELETED_NOTE_IDS 条。
 * createBackup 与本地状态写入共用，避免导出非法墓碑。
 */
export function normalizeDeletedNoteIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const raw of value) {
    if (!isString(raw)) continue;
    const id = raw.trim();
    if (!id || id.length > MAX_DELETED_NOTE_ID_LENGTH) continue;
    unique.add(id);
  }
  return [...unique].sort().slice(0, MAX_DELETED_NOTE_IDS);
}

/** 校验导入备份里的墓碑：类型、长度、去重都必须严格正确，坏数据整体拒绝。 */
function validateDeletedNoteIds(value: unknown): void {
  if (!Array.isArray(value)) fail("备份的已删除笔记列表无效");
  if (value.length > MAX_DELETED_NOTE_IDS) fail("备份的已删除笔记数量过多");
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isString(raw) || !raw || raw !== raw.trim()) {
      fail("备份的已删除笔记 ID 无效");
    }
    if (raw.length > MAX_DELETED_NOTE_ID_LENGTH) fail("备份的已删除笔记 ID 过长");
    if (seen.has(raw)) fail(`备份中已删除笔记 ID 重复：${raw}`);
    seen.add(raw);
  }
}

/** 校验设置版本：必须是安全的非负整数；旧备份缺字段时跳过（按 0 处理）。 */
function validateSettingsUpdatedAt(value: unknown): void {
  if (value === undefined) return;
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) {
    fail("备份的设置版本时间无效");
  }
}

/** 笔记/复习项的可选版本时间：缺失兼容旧备份，出现时必须是安全的非负整数。 */
function validateOptionalUpdatedAt(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label}无效`);
  }
}

export interface BackupCurrent {
  sessions: StudySession[];
  notes: Note[];
  reviews: ReviewItem[];
  diagnostics: DiagnosticProfile[];
  activity?: string[];
  deletedNoteIds?: string[];
  /** 当前设置；提供时按 settingsUpdatedAt 决定是否被备份设置覆盖。 */
  settingsWithoutSecrets?: StudyBackup["settingsWithoutSecrets"];
  settingsUpdatedAt?: number;
}

export interface BackupImportResult extends BackupCurrent {
  activity: string[];
  deletedNoteIds: string[];
  settingsWithoutSecrets: StudyBackup["settingsWithoutSecrets"];
  settingsUpdatedAt: number;
  imported: { sessions: number; notes: number; reviews: number; diagnostics: number };
  conflicts: { sessions: number; notes: number; reviews: number; diagnostics: number };
}

/**
 * 逐字段重建非敏感设置：任何多余字段（包括误传的 apiKey）都不会进入备份或合并结果。
 */
function copySettingsWithoutSecrets(
  settings: StudyBackup["settingsWithoutSecrets"],
): StudyBackup["settingsWithoutSecrets"] {
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    ...(settings.searchProvider === undefined ? {} : { searchProvider: settings.searchProvider }),
    ...(settings.structuredOutput === undefined
      ? {}
      : { structuredOutput: settings.structuredOutput }),
    ...(settings.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: settings.thinkingLevel }),
  };
}

/**
 * 从当前学习数据构建备份。settingsWithoutSecrets 必须来自 stripApiKey：
 * 这里逐字段重建，即使调用方误传了完整 ProviderSettings（含 apiKey），密钥也不会进入备份。
 * 传入的笔记会先按墓碑过滤，保证备份中不会同时出现“已删除 ID”和对应笔记。
 */
export function createBackup(input: {
  sessions: StudySession[];
  notes: Note[];
  reviews: ReviewItem[];
  diagnostics: DiagnosticProfile[];
  settingsWithoutSecrets: StudyBackup["settingsWithoutSecrets"];
  activity: string[];
  exportedAt?: number;
  deletedNoteIds?: string[];
  settingsUpdatedAt?: number;
}): StudyBackup {
  const deletedNoteIds = normalizeDeletedNoteIds(input.deletedNoteIds);
  const tombstonedNoteIds = new Set(deletedNoteIds);
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: input.exportedAt ?? Date.now(),
    sessions: input.sessions,
    // 墓碑与笔记不能同时出现在一份备份里：调用方状态若不干净，导出前也要清掉。
    notes: input.notes.filter((note) => !tombstonedNoteIds.has(note.id)),
    reviews: input.reviews,
    diagnostics: input.diagnostics,
    settingsWithoutSecrets: copySettingsWithoutSecrets(input.settingsWithoutSecrets),
    activity: input.activity,
    // 墓碑始终输出（空数组也明确表达“没有删除”），并在写备份前归一化。
    deletedNoteIds,
    settingsUpdatedAt: resolveSettingsUpdatedAt(input.settingsUpdatedAt),
  };
}

function assertNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      fail(`备份包含敏感字段 ${path}.${key}，已拒绝导入`);
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function validateLearningState(state: unknown, where: string): void {
  if (state === undefined) return;
  try { parseLearningState(state); }
  catch (error) {
    if (error instanceof LearningProtocolError) fail(`${where}${error.message}`);
    throw error;
  }
}

function validateChatMessage(message: unknown): void {
  if (!isObject(message)) fail("会话消息格式无效");
  if (!isString(message.id) || !message.id) fail("会话消息缺少 ID");
  if (message.role !== "user" && message.role !== "assistant") {
    fail("会话消息角色无效");
  }
  if (!isString(message.content)) fail("会话消息内容无效");
  if (!isNumber(message.timestamp)) fail("会话消息时间无效");
  if (
    message.delivery !== undefined &&
    message.delivery !== "sent" &&
    message.delivery !== "failed"
  ) {
    fail("会话消息发送状态无效");
  }
}

export function validateReviewItem(item: unknown): void {
  if (!isReviewItem(item)) fail("复习项格式无效或字段缺失");
  validateOptionalUpdatedAt(item.updatedAt, "复习项更新时间");
}

function validateNote(note: unknown): void {
  if (!isObject(note)) fail("笔记格式无效");
  if (!isString(note.id) || !note.id) fail("笔记缺少 ID");
  // 书架 / 独立笔记不属于任何学习会话，sessionId 允许为空串，但字段必须存在。
  if (!isString(note.sessionId)) fail("笔记所属会话无效");
  if (!isString(note.title) || !isString(note.content)) fail("笔记标题或内容无效");
  if (!isNumber(note.createdAt)) fail("笔记创建时间无效");
  validateOptionalUpdatedAt(
    "updatedAt" in note ? note.updatedAt : undefined,
    "笔记更新时间",
  );
}

export function validateDiagnostic(profile: unknown): void {
  try {
    validateDiagnosticProfile(profile);
  } catch (error) {
    fail(error instanceof Error ? error.message : "诊断记录格式无效或字段缺失");
  }
}

function validateTransferTrack(track: unknown): void {
  if (!isObject(track)) fail("迁移路线格式无效");
  if (!isString(track.id) || !track.id || !isString(track.sessionId)) {
    fail("迁移路线缺少 ID");
  }
  if (!isString(track.currentStepId)) fail("迁移路线当前步骤无效");
  if (!isNumber(track.createdAt) || !isNumber(track.updatedAt)) {
    fail("迁移路线时间无效");
  }
  if (!Array.isArray(track.steps)) fail("迁移路线步骤无效");
  for (const step of track.steps) {
    if (!isObject(step)) fail("迁移路线步骤无效");
    if (
      !isString(step.id) ||
      !step.id ||
      !isString(step.title) ||
      !isString(step.scenario) ||
      !isString(step.prompt) ||
      !isString(step.expectedFocus)
    ) {
      fail("迁移路线步骤内容无效");
    }
    if (step.level !== "variant" && step.level !== "context" && step.level !== "mixed") {
      fail("迁移路线步骤层级无效");
    }
    if (step.status !== "available" && step.status !== "current" && step.status !== "done") {
      fail("迁移路线步骤状态无效");
    }
  }
}

function validateSession(session: unknown): void {
  if (!isObject(session)) fail("会话格式无效");
  if (!isString(session.id) || !session.id) fail("会话缺少有效 ID");
  for (const key of ["title", "topic", "level", "goal"] as const) {
    if (!isString(session[key])) fail(`会话 ${key} 无效`);
  }
  if (!Array.isArray(session.messages)) fail("会话消息列表无效");
  for (const message of session.messages) validateChatMessage(message);
  if (!isNumber(session.stageIndex)) fail("会话阶段进度无效");
  if (!Array.isArray(session.completedStages) || !session.completedStages.every(isString)) {
    fail("会话已完成阶段无效");
  }
  for (const key of ["stageAnswers", "quizAnswers"] as const) {
    if (!isObject(session[key])) fail(`会话 ${key} 无效`);
    for (const answer of Object.values(session[key])) {
      if (!isNumber(answer)) fail(`会话 ${key} 无效`);
    }
  }
  if (!Array.isArray(session.plan) || !session.plan.every(isString)) fail("会话学习计划无效");
  if (!Array.isArray(session.quiz)) fail("会话测验无效");
  for (const question of session.quiz) validateQuizQuestion(question, "会话", "测验题");
  const quizQuestions = session.quiz as QuizQuestion[];
  if (!isObject(session.quizAnswers)) fail("会话 quizAnswers 无效");
  const quizById = new Map(quizQuestions.map((question) => [question.id, question]));
  for (const [questionId, answer] of Object.entries(session.quizAnswers)) {
    if (!isNumber(answer) || !Number.isInteger(answer) || answer < 0) {
      fail(`会话测验作答 ${questionId} 下标无效`);
    }
    const question = quizById.get(questionId);
    if (question && answer >= question.options.length) {
      fail(`会话测验作答 ${questionId} 下标越界`);
    }
  }
  if (!Array.isArray(session.flashcards)) fail("会话闪卡无效");
  for (const card of session.flashcards) {
    if (!isObject(card) || !isString(card.id) || !isString(card.front) || !isString(card.back)) {
      fail("会话闪卡无效");
    }
  }
  if (typeof session.quizSubmitted !== "boolean") fail("会话测验提交状态无效");
  if (!Array.isArray(session.reviewedCards) || !session.reviewedCards.every(isString)) {
    fail("会话已复习闪卡无效");
  }
  if (!Array.isArray(session.references)) fail("会话参考资料无效");
  for (const reference of session.references) {
    if (!isObject(reference) || !isString(reference.name) || !isString(reference.text)) {
      fail("会话参考资料无效");
    }
  }
  if (!isNumber(session.createdAt) || !isNumber(session.updatedAt)) fail("会话时间无效");
  validateLearningState(session.learningState, "会话");
  if (session.reviews !== undefined) {
    if (!Array.isArray(session.reviews)) fail("会话复习项列表无效");
    for (const item of session.reviews) validateReviewItem(item);
  }
  if (session.diagnostic !== undefined) validateDiagnostic(session.diagnostic);
  if (session.transferTrack !== undefined) validateTransferTrack(session.transferTrack);
  try {
    // 书籍会话持久化时只保留定位、清空正文（正文每轮从书架重新取出），
    // 因此校验时给被剥离的正文一个非空占位，仍复用 parseBookContext 的全部结构约束。
    const references = (session.references as Reference[]).map((reference) =>
      reference.text.trim() ? reference : { ...reference, text: "（原文正文未持久化）" },
    );
    parseBookContext(session.bookContext, references);
  } catch (error) {
    if (error instanceof BookContextError) fail(`会话书籍上下文无效：${error.message}`);
    if (error instanceof Error) fail(`会话书籍上下文无效：${error.message}`);
    fail("会话书籍上下文无效");
  }
}

function validateSettingsWithoutSecrets(value: unknown): void {
  if (!isObject(value)) fail("备份缺少有效的非敏感配置");
  if (value.provider !== "gemini" && value.provider !== "openai") {
    fail("备份的模型提供方无效");
  }
  if (!isString(value.model) || !isString(value.baseUrl)) {
    fail("备份的模型名称或接口地址无效");
  }
  if (value.structuredOutput !== undefined && typeof value.structuredOutput !== "boolean") {
    fail("备份的结构化输出开关无效");
  }
  if (
    value.searchProvider !== undefined &&
    !["tavily", "brave", "exa", "firecrawl", "deepseek", "you"].includes(value.searchProvider as string)
  ) {
    fail("备份的搜索供应商无效");
  }
  if (
    value.thinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(value.thinkingLevel as ThinkingLevel)
  ) {
    fail("备份的思考级别无效");
  }
}

/**
 * 解析并完整校验备份 JSON。任何格式、版本、伪造掌握或密钥问题都会抛错；
 * 只有通过全部校验的备份才会被返回，调用方在此之后才能执行合并或替换，
 * 因此校验失败时已有数据不可能被触碰。
 */
export function parseBackup(raw: string): StudyBackup {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("备份文件不是有效的 JSON");
  }
  if (!isObject(value)) fail("备份必须是 JSON 对象");
  if (value.format !== BACKUP_FORMAT || value.version !== 1) {
    fail("不支持的备份格式或版本");
  }
  const backup = value as unknown as StudyBackup;
  for (const [key, label] of [
    ["sessions", "会话"],
    ["notes", "笔记"],
    ["reviews", "复习项"],
    ["diagnostics", "诊断"],
    ["activity", "活动记录"],
  ] as const) {
    if (!Array.isArray(backup[key])) fail(`备份缺少${label}数据`);
  }
  assertNoSecrets(backup, "备份");
  if (!isNumber(backup.exportedAt)) fail("备份缺少有效的导出时间");
  validateSettingsWithoutSecrets(backup.settingsWithoutSecrets);
  if (backup.deletedNoteIds !== undefined) validateDeletedNoteIds(backup.deletedNoteIds);
  validateSettingsUpdatedAt(backup.settingsUpdatedAt);

  const sessionIds = new Set<string>();
  for (const session of backup.sessions) {
    validateSession(session);
    if (sessionIds.has(session.id)) fail(`备份中会话 ID 重复：${session.id}`);
    sessionIds.add(session.id);
  }
  const noteIds = new Set<string>();
  for (const note of backup.notes) {
    validateNote(note);
    if (noteIds.has(note.id)) fail(`备份中笔记 ID 重复：${note.id}`);
    noteIds.add(note.id);
  }
  const reviewIds = new Set<string>();
  for (const item of backup.reviews) {
    validateReviewItem(item);
    if (reviewIds.has(item.id)) fail(`备份中复习项 ID 重复：${item.id}`);
    reviewIds.add(item.id);
  }
  const diagnosticIds = new Set<string>();
  for (const profile of backup.diagnostics) {
    validateDiagnostic(profile);
    if (diagnosticIds.has(profile.id)) fail(`备份中诊断记录 ID 重复：${profile.id}`);
    diagnosticIds.add(profile.id);
  }
  for (const profile of backup.diagnostics) {
    if (!backup.sessions.some(session => session.diagnostic?.id === profile.id)) fail(`诊断 ${profile.id} 缺少所属会话，无法安全恢复`);
  }
  for (const item of backup.reviews) {
    if (!backup.sessions.some(session => session.id === item.sessionId)) fail(`复习项 ${item.id} 缺少所属会话，无法安全恢复`);
  }
  for (const day of backup.activity) {
    if (!isString(day) || !DATE_RE.test(day)) fail("备份活动记录日期无效");
  }
  return backup;
}

/**
 * 合并导入：ID 冲突时按可靠版本判定，只有能证明更新的备份记录才能覆盖当前记录。
 * - 笔记：只认显式 updatedAt；旧备份没有该字段时，同 ID 一律保留当前内容。
 * - 复习项：显式 updatedAt > attempts > dueAt > 是否已评分（兼容旧数据）。
 * - 诊断：submitted 优于未提交；双方已提交时只认严格更大的 evaluatedAt。
 * - 会话沿用跨标签页合并约定：同一会话双向保留消息等增量。
 * 笔记额外受墓碑约束：双方 deletedNoteIds 取并集，先过滤当前笔记，再拒绝备份里
 * 任何已墓碑化的 ID，保证旧云端/旧设备中的已删笔记不会复活。
 * 设置按 settingsUpdatedAt 取较新者（缺失按 0），时间戳取双方较大值。
 */
export function mergeBackup(current: BackupCurrent, backup: StudyBackup): BackupImportResult {
  const currentSessionIds = new Set(current.sessions.map((session) => session.id));
  const sessions = mergeSessions(current.sessions, backup.sessions);
  const importedSessions = backup.sessions.filter(
    (session) => !currentSessionIds.has(session.id),
  ).length;

  const deletedNoteIds = normalizeDeletedNoteIds([
    ...(current.deletedNoteIds ?? []),
    ...(backup.deletedNoteIds ?? []),
  ]);
  const tombstonedNoteIds = new Set(deletedNoteIds);
  const notesById = new Map<string, Note>();
  for (const note of current.notes) {
    // 墓碑优先：当前列表中残留的已删笔记也要先过滤。
    if (!tombstonedNoteIds.has(note.id)) notesById.set(note.id, note);
  }
  let importedNotes = 0;
  let conflictNotes = 0;
  for (const note of backup.notes) {
    // 墓碑优先：无论笔记来自哪一端，只要被删除过就不再出现。
    if (tombstonedNoteIds.has(note.id)) continue;
    const existing = notesById.get(note.id);
    if (existing) {
      conflictNotes += 1;
      // 旧备份 / 旧云快照没有 updatedAt，不得覆盖当前内容。
      if (isIncomingNoteNewer(note, existing)) notesById.set(note.id, note);
      continue;
    }
    notesById.set(note.id, note);
    importedNotes += 1;
  }
  const notes = [...notesById.values()];

  const reviewsById = new Map(current.reviews.map((item) => [item.id, item]));
  let importedReviews = 0;
  let conflictReviews = 0;
  for (const item of backup.reviews) {
    const existing = reviewsById.get(item.id);
    if (existing) {
      conflictReviews += 1;
      if (isIncomingReviewNewer(item, existing)) reviewsById.set(item.id, item);
      continue;
    }
    reviewsById.set(item.id, item);
    importedReviews += 1;
  }
  const reviews = [...reviewsById.values()];

  const diagnosticsById = new Map(
    current.diagnostics.map((profile) => [profile.id, profile]),
  );
  let importedDiagnostics = 0;
  let conflictDiagnostics = 0;
  for (const profile of backup.diagnostics) {
    const existing = diagnosticsById.get(profile.id);
    if (existing) {
      conflictDiagnostics += 1;
      if (isIncomingDiagnosticNewer(profile, existing)) {
        diagnosticsById.set(profile.id, profile);
      }
      continue;
    }
    diagnosticsById.set(profile.id, profile);
    importedDiagnostics += 1;
  }
  const diagnostics = [...diagnosticsById.values()];

  const currentSettingsAt = resolveSettingsUpdatedAt(current.settingsUpdatedAt);
  const backupSettingsAt = resolveSettingsUpdatedAt(backup.settingsUpdatedAt);
  const settingsUpdatedAt = Math.max(currentSettingsAt, backupSettingsAt);
  // 只有严格更新的备份设置才能覆盖当前设置；相同或更旧的版本保留当前值。
  const settingsWithoutSecrets = copySettingsWithoutSecrets(
    current.settingsWithoutSecrets !== undefined && backupSettingsAt <= currentSettingsAt
      ? current.settingsWithoutSecrets
      : backup.settingsWithoutSecrets,
  );

  return {
    sessions,
    notes,
    reviews,
    diagnostics,
    activity: mergeSessionIds(current.activity ?? [], backup.activity),
    deletedNoteIds,
    settingsWithoutSecrets,
    settingsUpdatedAt,
    imported: {
      sessions: importedSessions,
      notes: importedNotes,
      reviews: importedReviews,
      diagnostics: importedDiagnostics,
    },
    conflicts: {
      sessions: backup.sessions.length - importedSessions,
      notes: conflictNotes,
      reviews: conflictReviews,
      diagnostics: conflictDiagnostics,
    },
  };
}
