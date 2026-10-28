import type { BookSourceLocation, BookStudyContext } from "./bookTypes";

export type Provider = "gemini" | "openai";
export type ThinkingLevel = "auto" | "low" | "medium" | "high";
export type SearchProviderId = "tavily" | "brave" | "exa" | "firecrawl" | "deepseek" | "you";

export interface ModelFallback {
  provider: Provider;
  /** 登录后加密保存到服务端，仅当前账户可读取。 */
  apiKey?: string;
  model: string;
  baseUrl: string;
  structuredOutput?: boolean;
  thinkingLevel?: ThinkingLevel;
}

export interface SearchFallback {
  provider: SearchProviderId;
  /** 登录后加密保存到服务端，仅当前账户可读取。 */
  apiKey?: string;
}

export interface ProviderSettings {
  provider: Provider;
  /** 登录后加密保存到服务端，仅当前账户可读取。 */
  apiKey: string;
  model: string;
  baseUrl: string;
  structuredOutput?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** 用户自带的搜索供应商；搜索密钥只随当前请求发送。 */
  searchProvider?: SearchProviderId;
  /** 登录后加密保存到服务端，仅当前账户可读取。 */
  searchApiKey?: string;
  /** 备用模型配置，按顺序在主配置失败时尝试。 */
  modelFallbacks?: ModelFallback[];
  /** 备用搜索配置，按顺序失败回退；主搜索配置排在最前。 */
  searchFallbacks?: SearchFallback[];
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  hint: string;
}

export interface Flashcard {
  id: string;
  front: string;
  back: string;
}

export interface Stage extends QuizQuestion {
  title: string;
  subtitle: string;
  content: string;
  example: string;
  hints: string[];
  concepts: string[];
}

export interface Course {
  id: string;
  title: string;
  subject: string;
  description: string;
  level: string;
  duration: number;
  accent: "green" | "blue" | "orange";
  intro: string;
  stages: Stage[];
  quiz: QuizQuestion[];
  flashcards: Flashcard[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  delivery?: "sent" | "failed";
  failureMessage?: string;
  teaching?: TeachingReceipt;
  quality?: TeachingQuality;
}

export type WebReferenceVerification = "page_fetched" | "claim_matched" | "search_snippet";

export type WebSourceTier = "official" | "primary" | "secondary" | "unknown";

export interface Reference {
  name: string;
  text: string;
  location?: BookSourceLocation;
  /** 指定网页来源的公开 HTTPS 地址。 */
  url?: string;
  /** 服务端抓取时间（ISO 8601）。 */
  retrievedAt?: string;
  /** 搜索供应商返回的发布时间或页面日期，可能为空。 */
  publishedAt?: string;
  /** claim_matched 仅表示引文逐字命中页面，不表示事实正确。 */
  verification?: WebReferenceVerification;
  /** 服务端从页面原文中返回的逐字命中引文。 */
  verifiedQuote?: string;
  /** 仅按域名启发式分级，不是权威认证。 */
  sourceTier?: WebSourceTier;
}

export interface ChatRequest {
  settings?: ProviderSettings;
  topic: string;
  level: string;
  goal: string;
  messages: Pick<ChatMessage, "role" | "content">[];
  action:
    | "start"
    | "message"
    | "continue"
    | "hint"
    | "example"
    | "quiz"
    | "summary"
    | "flashcards"
    | "resume";
  references?: Reference[];
  /** 本轮先调用内部搜索供应商链，再把搜索摘要片段作为参考资料。 */
  webSearch?: boolean;
  learningState?: LearningState;
  bookContext?: BookStudyContext;
}

export interface ChatResponse {
  message: string;
  title?: string;
  plan?: string[];
  quiz?: QuizQuestion[];
  flashcards?: Flashcard[];
  learningState?: LearningState;
  teaching?: TeachingReceipt;
  quality?: TeachingQuality;
}

export interface ServerConfig {
  configured: boolean;
  provider: Provider;
  model: string;
  /** 公共正式版必须登录；本地开发默认不强制。 */
  authRequired: boolean;
  /** 公共模式默认只允许服务端密钥，避免把共享密钥暴露给浏览器。 */
  allowByok: boolean;
  /** 服务端是否允许抓取指定公开网页作为来源。 */
  webFetchEnabled: boolean;
  /** 是否启用内部搜索供应商链的自动搜索。 */
  webSearchEnabled: boolean;
  quotas: {
    chatPerDay: number;
    diagnosticPerDay: number;
    reviewPerDay: number;
  };
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

/** 服务端保存的是不含密钥的数据备份；revision 用于乐观并发控制。 */
export interface CloudWorkspace {
  revision: number;
  data: StudyBackup | null;
}

export interface AuthResult extends CloudWorkspace {
  user: AuthUser;
  recoveryCode?: string;
}

export interface StudySession {
  id: string;
  title: string;
  topic: string;
  courseId?: string;
  level: string;
  goal: string;
  messages: ChatMessage[];
  stageIndex: number;
  completedStages: string[];
  stageAnswers: Record<string, number>;
  plan: string[];
  quiz: QuizQuestion[];
  flashcards: Flashcard[];
  quizAnswers: Record<string, number>;
  quizSubmitted: boolean;
  reviewedCards: string[];
  reviews?: ReviewItem[];
  diagnostic?: DiagnosticProfile;
  transferTrack?: TransferTrack;
  references: Reference[];
  learningState?: LearningState;
  bookContext?: BookStudyContext;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  createdAt: number;
  /** 内容最后修改时间；旧记录可缺省，合并时按旧数据处理。 */
  updatedAt?: number;
}

export type ReviewRating = "again" | "fuzzy" | "known";
export interface ReviewItem {
  id: string;
  sessionId: string;
  topic: string;
  questionId?: string;
  prompt: string;
  kind: "quiz" | "misconception" | "concept";
  reason: string;
  hint: string;
  learnerQuote?: string;
  correctExplanation: string;
  createdAt: number;
  dueAt: number;
  intervalDays: number;
  streak: number;
  attempts: number;
  lastOutcome?: ReviewRating;
  /** 复习调度最后更新时间；旧记录用 attempts/dueAt 兼容合并。 */
  updatedAt?: number;
  source: "quiz" | "misconception" | "concept" | "diagnostic";
}

export interface DiagnosticProfile {
  id: string;
  topic: string;
  level: string;
  questions: QuizQuestion[];
  answers: Record<string, number>;
  submitted: boolean;
  evaluatedAt?: number;
  recommendedStepIndex: number;
  evidenceSummary: string[];
  weakConcepts: string[];
  skippedConcepts: string[];
}

export interface PathStep {
  id: string;
  title: string;
  goal: string;
  dependencyIds: string[];
  estimatedMinutes: number;
  status: "locked" | "available" | "current" | "done";
  pendingPrompt?: string;
}

export interface TransferStep {
  id: string;
  title: string;
  scenario: string;
  prompt: string;
  expectedFocus: string;
  level: "variant" | "context" | "mixed";
  status: "available" | "current" | "done";
  questionId?: string;
}

export interface TransferTrack {
  id: string;
  sessionId: string;
  steps: TransferStep[];
  currentStepId: string;
  createdAt: number;
  updatedAt: number;
}

export type SafeModelFallback = Omit<ModelFallback, "apiKey">;
export type SafeSearchFallback = Omit<SearchFallback, "apiKey">;
export type ProviderSettingsWithoutSecrets =
  Omit<ProviderSettings, "apiKey" | "searchApiKey" | "modelFallbacks" | "searchFallbacks"> & {
    modelFallbacks?: SafeModelFallback[];
    searchFallbacks?: SafeSearchFallback[];
  };

export interface StudyBackup {
  format: "zhixu-study-backup";
  version: 1;
  exportedAt: number;
  sessions: StudySession[];
  notes: Note[];
  reviews: ReviewItem[];
  diagnostics: DiagnosticProfile[];
  settingsWithoutSecrets: ProviderSettingsWithoutSecrets;
  activity: string[];
  /**
   * 已删除笔记的墓碑 ID（可选，旧备份没有该字段）。
   * 合并时双方取并集并过滤笔记，避免旧云端/旧设备快照把删除过的笔记复活。
   */
  deletedNoteIds?: string[];
  /**
   * 非敏感设置的最近修改时间（可选，旧备份没有该字段，按 0 处理）。
   * 只有更新的版本才能覆盖另一端的设置，防止旧设备压掉新改动。
   */
  settingsUpdatedAt?: number;
}

export type MasteryLevel = "new" | "learning" | "understood" | "applied";
export type LearnerIntent =
  | "answer"
  | "uncertain"
  | "challenge"
  | "side_question"
  | "topic_switch"
  | "request_explanation"
  | "continue";
export type TeachingMove =
  | "orient"
  | "explain"
  | "probe"
  | "hint"
  | "repair"
  | "clarify"
  | "answer"
  | "return"
  | "transfer"
  | "recap";
export type AssessmentVerdict =
  | "not_assessed"
  | "uncertain"
  | "incorrect"
  | "partial"
  | "correct";
export type EvidenceKind = "recognition" | "reasoning" | "transfer";
export type QuestionKind =
  | "orientation"
  | "diagnostic"
  | "reasoning"
  | "calculation"
  | "transfer"
  | "choice";

export interface LearningEvidence {
  quote: string;
  questionId: string;
  question?: string;
  kind: EvidenceKind;
  turn: number;
}

export interface LearningStep {
  id: string;
  title: string;
  mastery: MasteryLevel;
  evidence: LearningEvidence[];
}

export interface LearningQuestion {
  id: string;
  stepId: string;
  prompt: string;
  kind: QuestionKind;
  options: string[];
  successCriteria: string[];
  protectedAnswers?: string[];
  scope: "main" | "detour";
}

export interface LearningAssessment {
  verdict: AssessmentVerdict;
  evidenceQuote: string;
  questionId: string | null;
  demonstrated: "none" | EvidenceKind;
  feedback: string;
}

export interface LearningMisconception {
  id: string;
  stepId: string;
  questionId: string;
  question?: string;
  scope: "main" | "detour";
  topic: string;
  description: string;
  evidenceQuote: string;
  status: "open" | "repairing" | "resolved";
}

export interface LearningDetour {
  topic: string;
  returnStepId: string;
  returnQuestion: LearningQuestion | null;
  mastery: MasteryLevel;
  evidence: LearningEvidence[];
}

export interface LearningState {
  version: 1;
  revision: number;
  goal: string;
  steps: LearningStep[];
  currentStepId: string;
  pendingQuestion: LearningQuestion | null;
  detours: LearningDetour[];
  misconceptions: LearningMisconception[];
  deferredTopics: string[];
  savedTracks: LearningTrack[];
  assumptions: string[];
  lastAssessment: LearningAssessment | null;
  lastMove: TeachingMove | null;
}

export type LearningTrack = Pick<
  LearningState,
  | "goal"
  | "steps"
  | "currentStepId"
  | "pendingQuestion"
  | "detours"
  | "misconceptions"
  | "assumptions"
>;

export interface TeachingSource {
  name: string;
  quote: string;
  location?: BookSourceLocation;
  url?: string;
  retrievedAt?: string;
  publishedAt?: string;
  verification?: WebReferenceVerification;
  sourceTier?: WebSourceTier;
}

export interface TeachingNavigation {
  kind: "stay" | "focus" | "advance" | "detour" | "resume" | "switch";
  targetStepId?: string;
  topic?: string;
}

export interface TeachingReceipt {
  intent: LearnerIntent;
  move: TeachingMove;
  focusTitle: string;
  assessment: LearningAssessment;
  navigation: TeachingNavigation;
  assumptions: string[];
  retractedAssumptions?: string[];
  sources: TeachingSource[];
}

export interface TeachingQuality {
  checked: true;
  repaired: boolean;
  modelCalls: number;
  /** 实际完成本轮教学的模型名。 */
  model?: string;
  /** 仅在主配置失败、确实切换备用模型时为 true。 */
  fallback?: boolean;
  grounding: "provided_material" | "model_knowledge";
  formatRepairs?: string[];
  reviewAttempts?: number;
  limitations: string[];
}
