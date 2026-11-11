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
  /** 本轮可视化产物；随助手消息持久化，重新打开会话仍可查看。 */
  artifact?: LessonArtifact;
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
  /**
   * 图片/PDF 附件元数据。二进制本体只存浏览器 IndexedDB（按 sessionId 隔离），
   * 绝不进入 sessions 持久化 JSON、备份或云同步；请求只携带元数据与（≤2MB 图片的）base64。
   */
  attachment?: AttachmentMeta;
}

/**
 * 附件元数据：描述一个进入学习对话的图片或 PDF。
 * kind=pdf 的 Reference.text 为已抽取的文本层；扫描件无文本层时在客户端即被拒收。
 */
export interface AttachmentMeta {
  id: string;
  name: string;
  kind: "image" | "pdf";
  mimeType: string;
  byteLength: number;
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
  /**
   * 附件图片的 dataURL（data:image/…;base64,…），≤2MB 图片由客户端内联直传。
   * 服务端把它们并入最后一条用户消息发给视觉模型；references 里只有元数据。
   */
  attachmentImages?: AttachmentImage[];
  /** 本轮先调用内部搜索供应商链，再把搜索摘要片段作为参考资料。 */
  webSearch?: boolean;
  learningState?: LearningState;
  bookContext?: BookStudyContext;
  /**
   * 当前跨会话知识图谱：已核验命题作为“已掌握背景”注入导师上下文，
   * 规划新路线时也在其上追加依赖边。旧客户端不传仍合法。
   */
  knowledgeGraph?: KnowledgeGraph;
}

/** 随请求直传的图片附件（dataURL 形态）。 */
export interface AttachmentImage {
  id: string;
  dataUrl: string;
}

/** 可视化产物内容大小上限（字节）：UTF-8 编码后不得超过此值。 */
export const ARTIFACT_MAX_BYTES = 24 * 1024;

/** 本轮讲解的可视化产物：SVG 图形或离线 HTML 演示。由导师按需生成，内容经服务端质量门禁。 */
export interface LessonArtifact {
  kind: "svg" | "html";
  title: string;
  content: string;
  /** 逐字来自本轮可用材料的来源名称；无材料时为空数组。 */
  sources: string[];
  /** 无障碍文本替代：概括图形/演示所表达的内容，不能为空。 */
  textAlternative: string;
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
  /**
   * 本轮路线规划标注出的依赖边（可能包含请求中原有的命题与依赖）。
   * 客户端只用 mergeGraphs/addDependency 并入本机图谱，不整包覆盖本地已沉淀命题。
   */
  knowledgeGraph?: KnowledgeGraph;
  /**
   * 本轮路线规划的原子命题声明（stepTitle 逐字匹配 plan）。
   * 客户端在步骤核验通过时按声明沉淀原子命题；无声明时回退用步骤标题。
   */
  claims?: StepClaim[];
  /** 本轮按需生成的可视化产物；不存在时不渲染。 */
  artifact?: LessonArtifact;
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
  /**
   * 跨会话沉淀的知识图谱（可选，旧备份没有该字段，按空图谱处理）。
   * 随工作区同步与备份；合并时按 topic/statement LWW、证据取并集。
   */
  knowledgeGraph?: KnowledgeGraph;
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
export type EvidenceKind = "recognition" | "reasoning" | "derivation" | "transfer";
export type QuestionKind =
  | "orientation"
  | "diagnostic"
  | "reasoning"
  | "derivation"
  | "calculation"
  | "transfer"
  | "choice";

export interface LearningEvidence {
  quote: string;
  questionId: string;
  question?: string;
  kind: EvidenceKind;
  /** 独立评审抽取的推导链；旧证据没有该字段。 */
  chain?: { premises: string[]; conclusion: string };
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
  /** 本轮模型调用的 token 用量合计；供应商未返回时缺省。 */
  usage?: ModelUsage;
  limitations: string[];
}

/** 单轮教学所有模型调用的 token 用量合计（供应商响应解析所得，仅估算）。 */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** 命中缓存的输入 token（Gemini cachedContentTokenCount / OpenAI cached_tokens）。 */
  cachedTokens?: number;
}

/* ── 知识图谱：跨会话沉淀的命题与依赖 ───────────────────────────── */

/**
 * 命题节点：一个被核验通过的概念/事实。
 * 只有在会话中获得真实理解证据（核验通过）后才沉淀，不凭空生成。
 */
export interface KnowledgeProposition {
  /** 稳定 id，由内容规范化生成（同概念跨会话复用同一节点）。 */
  id: string;
  /** 命题内容：一句可判定真假的陈述（"导数是函数在某点的瞬时变化率"）。 */
  statement: string;
  /** 所属主题/学科领域，用于分组与筛选。 */
  topic: string;
  /** 首次沉淀的来源会话 id。 */
  sourceSessionId: string;
  /** 最近一次核验时间（LWW 合并依据）。 */
  verifiedAt: number;
  /** 核验强度：understood=能复述/辨认，applied=能独立应用/迁移。 */
  strength: "understood" | "applied";
  /** 支撑证据（来自会话的真实作答引文，可回溯）。 */
  evidence: LearningEvidence[];
}

/**
 * 依赖边：fromId 是理解 toId 的前提（prerequisite，先懂 from 再学 to），
 * 或 from 能推导出 to（derivation，由 from 沿规则推出 to）。
 * 由导师模型在规划路线时标注；derivation 边必须给出 rule。
 */
export type KnowledgeDependencyKind = "prerequisite" | "derivation";

export interface KnowledgeDependency {
  fromId: string;
  toId: string;
  /** 依赖标注时间。 */
  createdAt: number;
  /** 依赖类型：prerequisite=前置，derivation=推导；缺省 prerequisite。 */
  kind?: KnowledgeDependencyKind;
  /** 一句话说明 from 如何推出 to；derivation 边必填。 */
  rule?: string;
}

/** 导师草稿的原子命题声明：把一个步骤拆成可判定真假的陈述句。 */
export interface StepClaim {
  /** 所属步骤的标题，必须与 plan 中的步骤逐字一致。 */
  stepTitle: string;
  /** 原子命题：一句可判定真假的陈述句。 */
  statement: string;
}

/** 知识图谱快照：命题 + 依赖，随工作区同步与备份。 */
export interface KnowledgeGraph {
  propositions: KnowledgeProposition[];
  dependencies: KnowledgeDependency[];
}

/* ── C3 后台研究任务（单节点内存，不持久化，进程重启即丢失） ─────────── */

/** 后台研究任务状态机：pending→running→done / failed / cancelled。 */
export type ResearchJobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/**
 * 后台研究产出的一条来源证据。与 `Reference` 同构但独立，避免把研究任务的
 * 中间产物误当作已挂入教学回合的资料；`quote` 为逐字来自页面/摘要的引文。
 */
export interface ResearchEvidence {
  /** 公开 HTTPS 来源地址。 */
  url: string;
  /** 抓取或搜索命中时间（ISO 8601）。 */
  retrievedAt: string;
  /** 逐字引文：来自搜索摘要或抓取页面原文，绝不臆造。 */
  quote: string;
  /** 域名启发式分级，不是权威认证。 */
  sourceTier: WebSourceTier;
  /** 来源标题（页面标题或搜索结果标题）。 */
  title: string;
  /** 核验方式：search_snippet=搜索摘要，page_fetched/claim_matched=已抓取页面。 */
  verification: WebReferenceVerification;
}

/** 后台研究任务的对外快照（GET /api/research/:id 的响应体）。 */
export interface ResearchJob {
  jobId: string;
  status: ResearchJobStatus;
  query: string;
  maxSources: number;
  ownerId: string | null;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: ResearchEvidence[];
  error?: string;
}

/** POST /api/research 的响应体。 */
export interface CreateResearchResponse {
  jobId: string;
  status: ResearchJobStatus;
}

/** 把研究结果挂入教学回合时可复用的最小资料项（供调用方接线）。 */
export interface ResearchAttachItem {
  name: string;
  text: string;
  url: string;
  retrievedAt: string;
  sourceTier: WebSourceTier;
  verification: WebReferenceVerification;
  verifiedQuote?: string;
}
