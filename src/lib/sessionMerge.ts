import type { ChatMessage, ReviewItem, StudySession } from "../types";

/**
 * 单字段合并策略：
 * - "lww"：取较新快照（单值字段）；
 * - "lww-nonempty"：较新为空数组时回退到较旧快照；
 * - "union"：双方并集去重；
 * - "union-by-id"：按 id 合并、同 id 取较新（由专用合并函数实现）；
 * - "record-merge"：键级合并、较新覆盖同键；
 * - "lww-optional"：较新有值取较新，否则回退较旧；
 * - "min"：取双方较小值（用于 createdAt：只保留会话首次创建时刻）。
 */
export type SessionMergeStrategy =
  | "lww"
  | "lww-nonempty"
  | "union"
  | "union-by-id"
  | "record-merge"
  | "lww-optional"
  | "min";

/** 会话中需要按策略合并的字段；id 与 updatedAt 由合并循环单独处理。 */
export type MergedSessionField = Exclude<
  keyof StudySession,
  "id" | "updatedAt"
>;

/** 专用合并函数可以同时看到原始顺序与按更新时间判定出的新旧快照。 */
export interface SessionMergeContext {
  /** 调用方传入的当前快照。 */
  previous: StudySession;
  /** 调用方传入的 incoming 快照。 */
  next: StudySession;
  /** 按 updatedAt 判定出的较旧快照。 */
  older: StudySession;
  /** 按 updatedAt 判定出的较新快照。 */
  newer: StudySession;
}

interface CustomMergeRule<Field extends MergedSessionField> {
  strategy: "union-by-id";
  merge: (context: SessionMergeContext) => StudySession[Field];
}

type FieldMergeRule<Field extends MergedSessionField> =
  | Exclude<SessionMergeStrategy, "union-by-id">
  | CustomMergeRule<Field>;

/**
 * 单点声明：覆盖 StudySession 除 id / updatedAt 外的全部字段。
 * 新增字段若未在此登记，Record 的穷尽性检查会直接编译报错。
 */
export type SessionMergeStrategyTable = {
  [Field in MergedSessionField]: FieldMergeRule<Field>;
};

export const SESSION_MERGE_STRATEGIES: SessionMergeStrategyTable = {
  title: "lww",
  topic: "lww",
  courseId: "lww-optional",
  level: "lww",
  goal: "lww",
  messages: {
    strategy: "union-by-id",
    merge: ({ previous, next }) => mergeMessages(previous.messages, next.messages),
  },
  stageIndex: "lww",
  completedStages: "union",
  stageAnswers: "record-merge",
  plan: "lww-nonempty",
  quiz: "lww-nonempty",
  flashcards: "lww-nonempty",
  quizAnswers: "record-merge",
  quizSubmitted: "lww",
  reviewedCards: "union",
  reviews: {
    strategy: "union-by-id",
    // 复习项必须逐项比较版本：会话快照较新不代表其中的每个复习项都较新。
    merge: ({ previous, next }) =>
      mergeReviews(previous.reviews ?? [], next.reviews ?? []),
  },
  diagnostic: "lww-optional",
  transferTrack: "lww-optional",
  references: "lww-nonempty",
  learningState: "lww-optional",
  bookContext: "lww-optional",
  // 创建时间是会话首次创建时刻：合并只能取更早值，不能随快照更新而漂移。
  createdAt: "min",
};

const MERGED_SESSION_FIELDS = Object.keys(
  SESSION_MERGE_STRATEGIES,
) as MergedSessionField[];

/**
 * 跨标签页 / 备份导入的会话合并。
 *
 * 约定：以会话自身的 updatedAt 判断快照新旧；每个字段的取舍只由
 * SESSION_MERGE_STRATEGIES 声明，mergeSessions 本身不再逐字段写规则。
 * reviews 是例外：union-by-id 内部按每个 ReviewItem 的版本逐项比较，
 * 会话快照较新不代表其中的旧复习项可以覆盖对方的新评分。
 *
 * 已知业务限制：这是基于时间戳的最后写入者优先（LWW），没有向量时钟或
 * 字段级冲突标记。两个标签页在同一毫秒内写同一会话时，相等 updatedAt 下
 * incoming 胜出；任何一方删除的消息 / 阶段 / 复习项都会被并集重新保留。
 */
export interface SessionMergeClock {
  /**
   * current 快照的时钟偏移（serverTime - Date.now()）。
   * 云同步时传入可把本地时间换算到服务端基准，避免本地时钟偏快时
   * 用未来的 updatedAt 压过云端真实更新的内容。
   */
  currentClockOffset?: number;
  /** incoming 快照的时钟偏移；默认 0，即服务端/云端基准。 */
  incomingClockOffset?: number;
}

function shiftSessionUpdatedAt(session: StudySession, offset: number): StudySession {
  return offset === 0 ? session : { ...session, updatedAt: session.updatedAt + offset };
}

export function mergeSessions(
  current: StudySession[],
  incoming: StudySession[],
  clock: SessionMergeClock = {},
): StudySession[] {
  const currentOffset = clock.currentClockOffset ?? 0;
  const incomingOffset = clock.incomingClockOffset ?? 0;
  const byId = new Map(
    current.map((session) => [
      session.id,
      shiftSessionUpdatedAt(session, currentOffset),
    ]),
  );
  for (const next of incoming) {
    const previous = byId.get(next.id);
    if (!previous) {
      byId.set(next.id, shiftSessionUpdatedAt(next, incomingOffset));
      continue;
    }

    const incomingSession = shiftSessionUpdatedAt(next, incomingOffset);
    const incomingIsNewer = incomingSession.updatedAt >= previous.updatedAt;
    const context: SessionMergeContext = {
      previous,
      next,
      newer: incomingIsNewer ? incomingSession : previous,
      older: incomingIsNewer ? previous : incomingSession,
    };

    const merged: StudySession = {
      ...context.newer,
      updatedAt: Math.max(previous.updatedAt, incomingSession.updatedAt),
    };
    for (const field of MERGED_SESSION_FIELDS) {
      const rule = SESSION_MERGE_STRATEGIES[field];
      // "lww" 已由上面的 ...newer 完成；保持可选字段“缺省即缺省”的对象形状。
      if (rule === "lww") continue;
      Object.assign(merged, { [field]: mergeField(field, rule, context) });
    }
    byId.set(next.id, merged);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeField(
  field: MergedSessionField,
  rule: FieldMergeRule<MergedSessionField>,
  context: SessionMergeContext,
): StudySession[MergedSessionField] {
  if (typeof rule !== "string") return rule.merge(context);

  const older = context.older[field];
  const newer = context.newer[field];

  switch (rule) {
    case "lww":
      return newer;
    case "lww-nonempty":
      return Array.isArray(newer) && newer.length === 0 ? older : newer;
    case "union":
      // 保持调用方顺序（previous 在前、next 在后），与历史行为一致。
      return [
        ...new Set([
          ...(context.previous[field] as unknown[]),
          ...(context.next[field] as unknown[]),
        ]),
      ] as StudySession[MergedSessionField];
    case "record-merge":
      return {
        ...(older as Record<string, number>),
        ...(newer as Record<string, number>),
      } as StudySession[MergedSessionField];
    case "lww-optional":
      return newer ?? older;
    case "min":
      return Math.min(
        context.previous[field] as number,
        context.next[field] as number,
      ) as StudySession[MergedSessionField];
  }
}

function mergeMessages(
  previous: ChatMessage[],
  next: ChatMessage[],
): ChatMessage[] {
  const messages = new Map<string, ChatMessage>();
  // 纵深防御：已持久化的历史坏数据可能夹带 null 元素，直接读 id 会抛 TypeError。
  for (const message of [...previous, ...next].filter(Boolean)) {
    const existing = messages.get(message.id);
    if (!existing || message.timestamp >= existing.timestamp) {
      // 同 ID 同时间戳时，已发送优先于失败，避免旧失败状态覆盖已成功投递。
      if (existing && message.timestamp === existing.timestamp) {
        if (existing.delivery === "sent" && message.delivery !== "sent") continue;
      }
      messages.set(message.id, message);
    }
  }
  return [...messages.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** 复习项的显式版本时间（毫秒）；缺失或非法视为 0（与 backup.ts 一致）。 */
function reviewUpdatedAt(item: ReviewItem): number {
  const value = item.updatedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * 判断 incoming 复习项是否严格新于 current，与 backup.ts 的
 * isIncomingReviewNewer 等价（兼容没有 updatedAt 的旧数据）：
 * 1. 先比显式 updatedAt；
 * 2. 再比 attempts（真实评分次数）；
 * 3. 再比 dueAt；
 * 4. 最后已评分（有 lastOutcome）优先于初始项。
 * 平局保留 current：旧副本不得覆盖同等或无法证明更新的复习进度。
 *
 * 比较逻辑放在 sessionMerge（而不是从 backup.ts 导入）是为了避免
 * backup.ts → sessionMerge 的反向循环依赖。
 */
export function isIncomingReviewNewer(
  incoming: ReviewItem,
  current: ReviewItem,
): boolean {
  const incomingAt = reviewUpdatedAt(incoming);
  const currentAt = reviewUpdatedAt(current);
  if (incomingAt !== currentAt) return incomingAt > currentAt;
  if (incoming.attempts !== current.attempts) {
    return incoming.attempts > current.attempts;
  }
  if (incoming.dueAt !== current.dueAt) return incoming.dueAt > current.dueAt;
  return incoming.lastOutcome !== undefined && current.lastOutcome === undefined;
}

/**
 * 同一复习项 ID 逐项比较版本，较旧快照独有的复习项仍然保留。
 * 不能用会话 updatedAt 选出的整份快照覆盖：会话较新可能只是改了消息，
 * 其中的复习项仍是未评分的旧副本。
 */
function mergeReviews(previous: ReviewItem[], next: ReviewItem[]): ReviewItem[] {
  const reviews = new Map<string, ReviewItem>();
  // 纵深防御：已持久化的历史坏数据可能夹带 null 元素，直接读 id 会抛 TypeError。
  for (const item of previous.filter(Boolean)) reviews.set(item.id, item);
  for (const item of next.filter(Boolean)) {
    const current = reviews.get(item.id);
    if (!current || isIncomingReviewNewer(item, current)) {
      reviews.set(item.id, item);
    }
  }
  return [...reviews.values()];
}

export function mergeSessionIds(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])];
}
