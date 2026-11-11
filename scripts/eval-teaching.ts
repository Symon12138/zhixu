#!/usr/bin/env -S node --import tsx
/**
 * 知序教学发布评测门禁（真实模型）。
 *
 * 该脚本复用 server/ai.ts 的供应商配置与 model invoker，以及 server/tutor.ts 的
 * 完整质量编排（草稿 → 独立评审 → 必要时修订/复审 → 服务端提交状态）。评测只发送
 * 请求到当前环境配置的模型供应商端点（或本地兼容端点），不访问其它公网服务。
 *
 * 判定原则：不采信模型自述的 verdict。每个用例的结论来自本文件的独立程序断言：
 *   - 结构化状态可被 parseLearningState 完整校验（版本、轮次、步骤、证据）；
 *   - 题号身份：判分与证据必须绑定真正在问的问题，证据引文必须逐字来自学习者原话；
 *   - 题型门槛：选择题最多辨认、计算题必须有私有答案、迁移必须换题；
 *   - 答案泄露：讲解/选项/前提中不得出现未解出的私有结果；
 *   - 数值预期：程序自行核算学习者数值，算错就不能判对或记为推理证据。
 *
 * 用法：
 *   npm run eval:teaching                      # 运行全部用例
 *   npx tsx scripts/eval-teaching.ts --json    # 机器可读输出
 *   npx tsx scripts/eval-teaching.ts --case numeric-error --timeout 180
 *   npx tsx scripts/eval-teaching.ts --list
 *
 * 环境变量（与正式服务一致，从 GEMINI_* / OPENAI_* 读取；也支持 .env）：
 *   GEMINI_API_KEY / GEMINI_MODEL / GEMINI_BASE_URL
 *   OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL
 *   AI_STRUCTURED_OUTPUT / AI_THINKING_LEVEL
 *
 * 退出码：
 *   0 = 全部用例通过（真实模型已运行）
 *   1 = 教学失败（结构性断言或门禁结果不达标）
 *   2 = 环境未配置 / 套件无效 / 用法错误（未运行真实模型，不能视为通过）
 *   3 = 供应商或网络错误、回合超时（评测未完成）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  EvidenceKind,
  KnowledgeGraph,
  KnowledgeProposition,
  LearningEvidence,
  LearningQuestion,
  LearningState,
  MasteryLevel,
  QuestionKind,
  Reference,
  ReviewItem,
} from "../src/types";
import type {
  BookFormat,
  BookSourceLocation,
  BookStudyContext,
} from "../src/bookTypes";
import { parseLearningState } from "../src/lib/learningState";
import { parseBookContext, parseBookSourceLocation } from "../src/lib/bookProtocol";
import { emptyGraph, propositionId, reachable, upsertProposition } from "../src/lib/knowledgeGraph";
import { isKnowledgeGraphReviewItem, knowledgeGraphReviewItems } from "../src/lib/review";
import { protectedAnswersFor } from "../server/answers";
import { loadAiRuntimeConfig, loadWebConfig } from "../server/config";
import { isDirectExecution } from "./cli";
import {
  ApiError,
  createTeachingPipeline,
  redactSecrets,
  resolveConfig,
  type ResolvedConfig,
  type TeachingPipeline,
} from "../server/ai";
import {
  runTeachingTurn,
  TeachingQualityError,
  type ModelInvoker,
} from "../server/tutor";

// ── 套件数据类型 ────────────────────────────────────────────────────────────

export const EVAL_CHECKS = [
  "route",
  "question_identity",
  "no_answer_leak",
  "no_advance",
  "misconception_recorded",
  "evidence_verbatim",
  "numeric_gate",
  "no_forged_transfer",
  "choice_not_reasoning",
  "recap_separation",
  "state_unchanged",
  "detour_preserved",
  "resume_returned",
  "known_proposition_used",
  "graph_dependency_returned",
  "graph_review_generated",
  "book_quote_bound",
  "web_claim_matched",
] as const;

export type EvalCheckId = (typeof EVAL_CHECKS)[number];

/** 发布门禁必须覆盖的教学场景标签。 */
export const REQUIRED_COVERAGE = [
  "opening_route",
  "no_answer_leak",
  "first_error_repair",
  "same_prompt_new_id",
  "recap_separation",
  "choice_not_reasoning",
  "numeric_error",
  "knowledge_graph_continuity",
  "graph_review_generation",
  "book_grounding",
  "web_grounding",
] as const;

const CORE_ACTIONS: ChatRequest["action"][] = [
  "start",
  "message",
  "continue",
  "hint",
  "example",
  "resume",
];

const ACTIONS: ChatRequest["action"][] = [
  "start",
  "message",
  "continue",
  "hint",
  "example",
  "quiz",
  "summary",
  "flashcards",
  "resume",
];

export interface CaseDefaults {
  topic: string;
  level: string;
  goal: string;
}

export interface SeedEvidence {
  quote: string;
  questionId: string;
  question?: string;
  kind: EvidenceKind;
  turn: number;
}

export interface SeedStep {
  id: string;
  title: string;
  mastery?: MasteryLevel;
  evidence?: SeedEvidence[];
}

export interface SeedQuestion {
  id: string;
  prompt: string;
  kind: QuestionKind;
  options?: string[];
  successCriteria: string[];
  protectedAnswers?: string[];
  stepId?: string;
  scope?: "main" | "detour";
}

export interface SeedMisconception {
  id: string;
  stepId: string;
  questionId: string;
  question?: string;
  scope?: "main" | "detour";
  topic: string;
  description: string;
  evidenceQuote: string;
  status?: "open" | "repairing" | "resolved";
}

export interface SeedSpec {
  goal: string;
  revision: number;
  steps: SeedStep[];
  currentStepId?: string;
  pendingQuestion?: SeedQuestion | null;
  misconceptions?: SeedMisconception[];
  assumptions?: string[];
  history?: Pick<ChatMessage, "role" | "content">[];
}

export interface EvalTurn {
  action: ChatRequest["action"];
  learner: string;
  expect: EvalCheckId[];
  /** 允许被程序门禁拒绝：拒绝即代表门禁守住（不提交状态）。 */
  allowRejection?: boolean;
  /** 被拒时必须命中的问题代码，避免把无关失败误当成门禁生效。 */
  rejectionCodes?: string[];
}

export interface BookFixtureBlock {
  id: string;
  text: string;
  locator?: string;
  page?: number;
}

/**
 * 可复现的书籍原文夹具：由评测程序自行构造 bookContext + References，
 * 避免依赖真实上传文件；模型仍必须逐字引用这里提供的原文。
 */
export interface BookFixture {
  bookId: string;
  title: string;
  author: string;
  format: BookFormat;
  chapterId: string;
  chapterTitle: string;
  mode?: "chapter" | "review";
  /** 目录；缺省只有本章。长度即总章节数，必须包含本章标题。 */
  tableOfContents?: string[];
  /** 全书段落总数；缺省等于提供的段落数。 */
  totalBlocks?: number;
  blocks: BookFixtureBlock[];
}

export interface EvalCase {
  id: string;
  title: string;
  description?: string;
  covers: string[];
  topic?: string;
  level?: string;
  goal?: string;
  groundTruth?: { numbers?: string[] };
  seed?: SeedSpec;
  /** 跨会话已核验命题；作为 knownPropositions 注入导师上下文。 */
  knowledgeGraph?: KnowledgeGraph;
  /** 书籍原文夹具；与 references 互斥（生产书籍回合只接受同书原文）。 */
  bookFixture?: BookFixture;
  /** 网页/外部资料，随请求发送；可配合 webSearch 模拟已检索来源。 */
  references?: Reference[];
  /** 本轮允许内部搜索供应商链（评测中通常配合固定 references）。 */
  webSearch?: boolean;
  turns: EvalTurn[];
}

export interface EvalSuite {
  version: 1;
  name: string;
  description?: string;
  /** 缺省 true：发布运行缺少 REQUIRED_COVERAGE 时以退出码 2 拒绝。 */
  requiredCoverage?: boolean;
  defaults: CaseDefaults;
  cases: EvalCase[];
}

export class EvalSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalSuiteError";
  }
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SUITE_PATH = path.resolve(SCRIPT_DIR, "..", "eval", "teaching-suite.json");
export const DEFAULT_OUTCOME_SUITE_PATH = path.resolve(
  SCRIPT_DIR,
  "..",
  "eval",
  "outcome-suite.example.json",
);
export const HARNESS_VERSION = "1.1.0";

/** 报告必须带版本；读取失败明确写 unknown，不伪造版本号。 */
function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(path.resolve(SCRIPT_DIR, "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof raw.version === "string" && raw.version.trim() ? raw.version : "unknown";
  } catch {
    return "unknown";
  }
}

// ── 套件加载与校验 ──────────────────────────────────────────────────────────

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvalSuiteError(`${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new EvalSuiteError(`${where} 必须是数组`);
  return value;
}

function asString(value: unknown, where: string, options: { empty?: boolean } = {}): string {
  if (typeof value !== "string" || (!options.empty && !value.trim())) {
    throw new EvalSuiteError(`${where} 必须是${options.empty ? "" : "非空"}字符串`);
  }
  return value;
}

function asFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EvalSuiteError(`${where} 必须是有限数值`);
  }
  return value;
}

function parseHistory(value: unknown, where: string): Pick<ChatMessage, "role" | "content">[] {
  return asArray(value, where).map((item, index) => {
    const entry = asRecord(item, `${where}[${index}]`);
    const role = asString(entry.role, `${where}[${index}].role`);
    if (role === "user" || role === "assistant") {
      return { role, content: asString(entry.content, `${where}[${index}].content`) };
    }
    throw new EvalSuiteError(`${where}[${index}].role 只能是 user 或 assistant`);
  });
}

function parseSeed(value: unknown, where: string): SeedSpec {
  const seed = asRecord(value, where);
  const steps: SeedStep[] = asArray(seed.steps, `${where}.steps`).map((item, index) => {
    const step = asRecord(item, `${where}.steps[${index}]`);
    return {
      id: asString(step.id, `${where}.steps[${index}].id`),
      title: asString(step.title, `${where}.steps[${index}].title`),
      ...(step.mastery === undefined
        ? {}
        : { mastery: asString(step.mastery, `${where}.steps[${index}].mastery`) as MasteryLevel }),
      ...(step.evidence === undefined
        ? {}
        : { evidence: asArray(step.evidence, `${where}.steps[${index}].evidence`) as SeedEvidence[] }),
    };
  });
  if (!steps.length) throw new EvalSuiteError(`${where}.steps 不能为空`);
  const pending = seed.pendingQuestion;
  const pendingQuestion: SeedQuestion | null = pending === undefined || pending === null
    ? null
    : (() => {
        const question = asRecord(pending, `${where}.pendingQuestion`);
        return {
          id: asString(question.id, `${where}.pendingQuestion.id`),
          prompt: asString(question.prompt, `${where}.pendingQuestion.prompt`),
          kind: asString(question.kind, `${where}.pendingQuestion.kind`) as QuestionKind,
          options: question.options === undefined
            ? []
            : asArray(question.options, `${where}.pendingQuestion.options`).map((item, index) =>
                asString(item, `${where}.pendingQuestion.options[${index}]`),
              ),
          successCriteria: asArray(question.successCriteria, `${where}.pendingQuestion.successCriteria`).map(
            (item, index) => asString(item, `${where}.pendingQuestion.successCriteria[${index}]`),
          ),
          ...(question.protectedAnswers === undefined
            ? {}
            : {
                protectedAnswers: asArray(
                  question.protectedAnswers,
                  `${where}.pendingQuestion.protectedAnswers`,
                ).map((item, index) =>
                  asString(item, `${where}.pendingQuestion.protectedAnswers[${index}]`),
                ),
              }),
          ...(question.stepId === undefined
            ? {}
            : { stepId: asString(question.stepId, `${where}.pendingQuestion.stepId`) }),
          ...(question.scope === undefined
            ? {}
            : { scope: asString(question.scope, `${where}.pendingQuestion.scope`) as "main" | "detour" }),
        };
      })();
  return {
    goal: asString(seed.goal, `${where}.goal`),
    revision: asFiniteNumber(seed.revision, `${where}.revision`),
    steps,
    ...(seed.currentStepId === undefined
      ? {}
      : { currentStepId: asString(seed.currentStepId, `${where}.currentStepId`) }),
    pendingQuestion,
    ...(seed.misconceptions === undefined
      ? {}
      : {
          misconceptions: asArray(seed.misconceptions, `${where}.misconceptions`) as SeedMisconception[],
        }),
    ...(seed.assumptions === undefined
      ? {}
      : {
          assumptions: asArray(seed.assumptions, `${where}.assumptions`).map((item, index) =>
            asString(item, `${where}.assumptions[${index}]`),
          ),
        }),
    ...(seed.history === undefined ? {} : { history: parseHistory(seed.history, `${where}.history`) }),
  };
}

function parseGraphEvidence(value: unknown, where: string): LearningEvidence {
  const entry = asRecord(value, where);
  const kind = asString(entry.kind, `${where}.kind`);
  if (kind !== "recognition" && kind !== "reasoning" && kind !== "transfer") {
    throw new EvalSuiteError(`${where}.kind 只能是 recognition/reasoning/transfer`);
  }
  const turn = asFiniteNumber(entry.turn, `${where}.turn`);
  if (!Number.isInteger(turn) || turn < 1) throw new EvalSuiteError(`${where}.turn 必须是正整数`);
  return {
    quote: asString(entry.quote, `${where}.quote`),
    questionId: asString(entry.questionId, `${where}.questionId`),
    ...(entry.question === undefined ? {} : { question: asString(entry.question, `${where}.question`) }),
    kind,
    turn,
  };
}

function parseKnowledgeGraphFixture(value: unknown, where: string): KnowledgeGraph {
  const graph = asRecord(value, where);
  const propositions = asArray(graph.propositions, `${where}.propositions`).map((item, index) => {
    const node = asRecord(item, `${where}.propositions[${index}]`);
    const strength = asString(node.strength, `${where}.propositions[${index}].strength`) as KnowledgeProposition["strength"];
    if (strength !== "understood" && strength !== "applied") {
      throw new EvalSuiteError(`${where}.propositions[${index}].strength 只能是 understood 或 applied`);
    }
    return {
      id: asString(node.id, `${where}.propositions[${index}].id`),
      statement: asString(node.statement, `${where}.propositions[${index}].statement`),
      topic: asString(node.topic, `${where}.propositions[${index}].topic`),
      sourceSessionId: asString(node.sourceSessionId, `${where}.propositions[${index}].sourceSessionId`),
      verifiedAt: asFiniteNumber(node.verifiedAt, `${where}.propositions[${index}].verifiedAt`),
      strength,
      evidence: asArray(node.evidence, `${where}.propositions[${index}].evidence`).map(
        (entry, entryIndex) =>
          parseGraphEvidence(entry, `${where}.propositions[${index}].evidence[${entryIndex}]`),
      ),
    };
  });
  const ids = new Set<string>();
  for (const proposition of propositions) {
    if (ids.has(proposition.id)) {
      throw new EvalSuiteError(`${where}.propositions 含重复 id：${proposition.id}`);
    }
    ids.add(proposition.id);
  }
  const pairSeen = new Set<string>();
  const dependencies = asArray(graph.dependencies, `${where}.dependencies`).map((item, index) => {
    const dependency = asRecord(item, `${where}.dependencies[${index}]`);
    const fromId = asString(dependency.fromId, `${where}.dependencies[${index}].fromId`);
    const toId = asString(dependency.toId, `${where}.dependencies[${index}].toId`);
    if (fromId === toId) throw new EvalSuiteError(`${where}.dependencies[${index}] 不能是自环`);
    const key = `${fromId}→${toId}`;
    if (pairSeen.has(key)) throw new EvalSuiteError(`${where}.dependencies 含重复依赖：${key}`);
    pairSeen.add(key);
    return {
      fromId,
      toId,
      createdAt: asFiniteNumber(dependency.createdAt, `${where}.dependencies[${index}].createdAt`),
    };
  });
  return { propositions, dependencies };
}

function parseReferenceFixture(value: unknown, where: string): Reference {
  const reference = asRecord(value, where);
  const verification = reference.verification === undefined
    ? undefined
    : asString(reference.verification, `${where}.verification`);
  if (
    verification !== undefined &&
    verification !== "page_fetched" &&
    verification !== "claim_matched" &&
    verification !== "search_snippet"
  ) {
    throw new EvalSuiteError(`${where}.verification 不受支持：${verification}`);
  }
  const sourceTier = reference.sourceTier === undefined
    ? undefined
    : asString(reference.sourceTier, `${where}.sourceTier`);
  if (
    sourceTier !== undefined &&
    sourceTier !== "official" &&
    sourceTier !== "primary" &&
    sourceTier !== "secondary" &&
    sourceTier !== "unknown"
  ) {
    throw new EvalSuiteError(`${where}.sourceTier 不受支持：${sourceTier}`);
  }
  let location: BookSourceLocation | undefined;
  if (reference.location !== undefined) {
    try {
      location = parseBookSourceLocation(reference.location);
    } catch (error) {
      throw new EvalSuiteError(
        `${where}.location 不合法：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    name: asString(reference.name, `${where}.name`),
    text: asString(reference.text, `${where}.text`),
    ...(location ? { location } : {}),
    ...(reference.url === undefined ? {} : { url: asString(reference.url, `${where}.url`) }),
    ...(reference.retrievedAt === undefined
      ? {}
      : { retrievedAt: asString(reference.retrievedAt, `${where}.retrievedAt`) }),
    ...(reference.publishedAt === undefined
      ? {}
      : { publishedAt: asString(reference.publishedAt, `${where}.publishedAt`) }),
    ...(verification === undefined ? {} : { verification }),
    ...(reference.verifiedQuote === undefined
      ? {}
      : { verifiedQuote: asString(reference.verifiedQuote, `${where}.verifiedQuote`) }),
    ...(sourceTier === undefined ? {} : { sourceTier }),
  };
}

function parseBookFixture(value: unknown, where: string): BookFixture {
  const fixture = asRecord(value, where);
  const format = asString(fixture.format, `${where}.format`);
  if (!["pdf", "epub", "txt", "md"].includes(format)) {
    throw new EvalSuiteError(`${where}.format 只能是 pdf/epub/txt/md`);
  }
  const mode = fixture.mode === undefined ? "chapter" : asString(fixture.mode, `${where}.mode`);
  if (mode !== "chapter" && mode !== "review") {
    throw new EvalSuiteError(`${where}.mode 只能是 chapter 或 review`);
  }
  const blocks = asArray(fixture.blocks, `${where}.blocks`).map((item, index) => {
    const block = asRecord(item, `${where}.blocks[${index}]`);
    return {
      id: asString(block.id, `${where}.blocks[${index}].id`),
      text: asString(block.text, `${where}.blocks[${index}].text`),
      ...(block.locator === undefined
        ? {}
        : { locator: asString(block.locator, `${where}.blocks[${index}].locator`) }),
      ...(block.page === undefined ? {} : { page: asFiniteNumber(block.page, `${where}.blocks[${index}].page`) }),
    };
  });
  if (!blocks.length || blocks.length > 20) {
    throw new EvalSuiteError(`${where}.blocks 需要 1–20 段原文`);
  }
  const ids = new Set(blocks.map((block) => block.id));
  if (ids.size !== blocks.length) throw new EvalSuiteError(`${where}.blocks 段落 id 重复`);
  return {
    bookId: asString(fixture.bookId, `${where}.bookId`),
    title: asString(fixture.title, `${where}.title`),
    author: asString(fixture.author, `${where}.author`),
    format: format as BookFormat,
    chapterId: asString(fixture.chapterId, `${where}.chapterId`),
    chapterTitle: asString(fixture.chapterTitle, `${where}.chapterTitle`),
    mode,
    ...(fixture.tableOfContents === undefined
      ? {}
      : {
          tableOfContents: asArray(fixture.tableOfContents, `${where}.tableOfContents`).map(
            (item, index) => asString(item, `${where}.tableOfContents[${index}]`),
          ),
        }),
    ...(fixture.totalBlocks === undefined
      ? {}
      : { totalBlocks: asFiniteNumber(fixture.totalBlocks, `${where}.totalBlocks`) }),
    blocks,
  };
}

/** 由书籍夹具构造生产同构的 bookContext + References，并复用生产校验器。 */
export function buildBookFixture(
  fixture: BookFixture,
): { bookContext: BookStudyContext; references: Reference[] } {
  const totalBlocks = fixture.totalBlocks ?? fixture.blocks.length;
  if (!Number.isInteger(totalBlocks) || totalBlocks < fixture.blocks.length) {
    throw new EvalSuiteError(`书籍夹具 ${fixture.bookId} 的 totalBlocks 必须覆盖全部提供段落`);
  }
  const tableOfContents = fixture.tableOfContents?.length
    ? fixture.tableOfContents
    : [fixture.chapterTitle];
  if (!tableOfContents.includes(fixture.chapterTitle)) {
    throw new EvalSuiteError(`书籍夹具 ${fixture.bookId} 的目录必须包含本章标题`);
  }
  if (tableOfContents.length > 1000) throw new EvalSuiteError("书籍夹具目录过长");
  const references: Reference[] = fixture.blocks.map((block, index) => ({
    name: `${fixture.title} · ${fixture.chapterTitle} · 段${index + 1}`,
    text: block.text,
    location: {
      bookId: fixture.bookId,
      chapterId: fixture.chapterId,
      blockId: block.id,
      chapterTitle: fixture.chapterTitle,
      locator: block.locator ?? `第${index + 1}段`,
      ...(block.page === undefined ? {} : { page: block.page }),
    },
  }));
  const bookContext: BookStudyContext = {
    bookId: fixture.bookId,
    title: fixture.title,
    author: fixture.author,
    format: fixture.format,
    mode: fixture.mode ?? "chapter",
    chapterId: fixture.chapterId,
    chapterTitle: fixture.chapterTitle,
    tableOfContents,
    totalChapters: tableOfContents.length,
    totalBlocks,
    chapterBlocks: fixture.blocks.length,
    suppliedBlockIds: fixture.blocks.map((block) => block.id),
    completeChapter: true,
    completeBook: totalBlocks === fixture.blocks.length,
  };
  try {
    const parsed = parseBookContext(bookContext, references);
    if (!parsed) throw new EvalSuiteError("书籍夹具缺少 bookContext");
    return { bookContext: parsed, references };
  } catch (error) {
    throw new EvalSuiteError(
      `书籍夹具 ${fixture.bookId} 不合法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseEvalCase(value: unknown, where: string): EvalCase {
  const entry = asRecord(value, where);
  const id = asString(entry.id, `${where}.id`);
  const turns: EvalTurn[] = asArray(entry.turns, `${where}.turns`).map((turn, turnIndex) => {
    const turnWhere = `${where}.turns[${turnIndex}]`;
    const parsed = asRecord(turn, turnWhere);
    const action = asString(parsed.action, `${turnWhere}.action`);
    if (!ACTIONS.includes(action as ChatRequest["action"])) {
      throw new EvalSuiteError(`${turnWhere}.action 不受支持：${action}`);
    }
    const expect = asArray(parsed.expect, `${turnWhere}.expect`).map((check, checkIndex) => {
      const checkId = asString(check, `${turnWhere}.expect[${checkIndex}]`);
      if (!(EVAL_CHECKS as readonly string[]).includes(checkId)) {
        throw new EvalSuiteError(`${turnWhere}.expect 含未知检查：${checkId}`);
      }
      return checkId as EvalCheckId;
    });
    if (!expect.length) throw new EvalSuiteError(`${turnWhere}.expect 不能为空`);
    return {
      action: action as ChatRequest["action"],
      learner: asString(parsed.learner, `${turnWhere}.learner`, { empty: true }),
      expect,
      ...(parsed.allowRejection === undefined
        ? {}
        : { allowRejection: parsed.allowRejection === true }),
      ...(parsed.rejectionCodes === undefined
        ? {}
        : {
            rejectionCodes: asArray(parsed.rejectionCodes, `${turnWhere}.rejectionCodes`).map(
              (code, codeIndex) => asString(code, `${turnWhere}.rejectionCodes[${codeIndex}]`),
            ),
          }),
    };
  });
  if (!turns.length) throw new EvalSuiteError(`${where}.turns 不能为空`);
  const references = entry.references === undefined
    ? undefined
    : asArray(entry.references, `${where}.references`).map((reference, referenceIndex) =>
        parseReferenceFixture(reference, `${where}.references[${referenceIndex}]`),
      );
  const bookFixture = entry.bookFixture === undefined
    ? undefined
    : parseBookFixture(entry.bookFixture, `${where}.bookFixture`);
  if (bookFixture && references?.length) {
    throw new EvalSuiteError(`${where} 不能同时提供 bookFixture 与 references（生产书籍回合只接受同书原文）`);
  }
  const webSearch = entry.webSearch === true;
  return {
    id,
    title: asString(entry.title, `${where}.title`),
    ...(entry.description === undefined
      ? {}
      : { description: asString(entry.description, `${where}.description`) }),
    covers: asArray(entry.covers, `${where}.covers`).map((cover, coverIndex) =>
      asString(cover, `${where}.covers[${coverIndex}]`),
    ),
    ...(entry.topic === undefined ? {} : { topic: asString(entry.topic, `${where}.topic`) }),
    ...(entry.level === undefined ? {} : { level: asString(entry.level, `${where}.level`) }),
    ...(entry.goal === undefined ? {} : { goal: asString(entry.goal, `${where}.goal`) }),
    ...(entry.groundTruth === undefined
      ? {}
      : (() => {
          const truth = asRecord(entry.groundTruth, `${where}.groundTruth`);
          return {
            groundTruth: {
              ...(truth.numbers === undefined
                ? {}
                : {
                    numbers: asArray(truth.numbers, `${where}.groundTruth.numbers`).map(
                      (number, numberIndex) =>
                        asString(number, `${where}.groundTruth.numbers[${numberIndex}]`),
                    ),
                  }),
            },
          };
        })()),
    ...(entry.seed === undefined ? {} : { seed: parseSeed(entry.seed, `${where}.seed`) }),
    ...(entry.knowledgeGraph === undefined
      ? {}
      : { knowledgeGraph: parseKnowledgeGraphFixture(entry.knowledgeGraph, `${where}.knowledgeGraph`) }),
    ...(bookFixture ? { bookFixture } : {}),
    ...(references?.length ? { references } : {}),
    ...(webSearch ? { webSearch: true } : {}),
    turns,
  };
}

function parseCases(value: unknown, where: string): EvalCase[] {
  const cases = asArray(value, where).map((item, index) => parseEvalCase(item, `${where}[${index}]`));
  if (!cases.length) throw new EvalSuiteError(`${where} 至少需要一个用例`);
  const duplicate = cases.find((item, index) => cases.findIndex((other) => other.id === item.id) !== index);
  if (duplicate) throw new EvalSuiteError(`用例 id 重复：${duplicate.id}`);
  return cases;
}

export function parseSuite(value: unknown): EvalSuite {
  const raw = asRecord(value, "套件");
  if (raw.version !== 1) throw new EvalSuiteError("套件 version 必须为 1");
  if (raw.mode !== undefined && raw.mode !== "turn") {
    throw new EvalSuiteError("turn 套件的 mode 只能是 turn；outcome 套件请使用 --outcome");
  }
  const defaults = asRecord(raw.defaults, "套件.defaults");
  return {
    version: 1,
    name: asString(raw.name, "套件.name"),
    ...(raw.description === undefined
      ? {}
      : { description: asString(raw.description, "套件.description") }),
    ...(raw.requiredCoverage === undefined
      ? {}
      : { requiredCoverage: raw.requiredCoverage === true }),
    defaults: {
      topic: asString(defaults.topic, "套件.defaults.topic"),
      level: asString(defaults.level, "套件.defaults.level"),
      goal: asString(defaults.goal, "套件.defaults.goal"),
    },
    cases: parseCases(raw.cases, "套件.cases"),
  };
}

export function loadSuite(filePath: string = DEFAULT_SUITE_PATH): EvalSuite {
  const parsed = readSuiteJson(filePath);
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).mode === "outcome"
  ) {
    throw new EvalSuiteError("这是 outcome 协议套件，请使用 --outcome 加载，不能当作教学回合门禁运行");
  }
  return parseSuite(parsed);
}

function readSuiteJson(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new EvalSuiteError(
      `无法读取评测套件 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new EvalSuiteError(`评测套件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 学习效果（outcome）协议 ─────────────────────────────────────────────────

export const OUTCOME_METRICS = [
  "normalized_gain",
  "retention_rate",
  "transfer_rate",
] as const;

export type OutcomeMetricId = (typeof OUTCOME_METRICS)[number];

export interface OutcomeTestItem {
  id: string;
  prompt: string;
  /** 可接受答案；数值题按规范化数值比较，文本题按规范化文本比较。 */
  expected: string[];
  kind?: "numeric" | "text";
}

export interface OutcomeTestSpec {
  items: OutcomeTestItem[];
}

export interface DelayedOutcomeTestSpec extends OutcomeTestSpec {
  /** 学习开始后计划延迟多久进行延迟后测（毫秒），用于记录 scheduledAt。 */
  scheduleAfterMs: number;
}

export interface OutcomeCase extends EvalCase {
  preTest: OutcomeTestSpec;
  postTest: OutcomeTestSpec;
  delayedTest: DelayedOutcomeTestSpec;
  transferTest: OutcomeTestSpec;
}

export interface OutcomePhaseResponses {
  responses: Record<string, string>;
  /** 延迟后测实际完成时间相对学习开始的偏移；早于计划时间时保持率判为 skipped。 */
  completedAtOffsetMs?: number;
}

export interface OutcomeCaseResponses {
  preTest?: OutcomePhaseResponses;
  postTest?: OutcomePhaseResponses;
  delayedTest?: OutcomePhaseResponses;
  transferTest?: OutcomePhaseResponses;
}

export interface OutcomeResponsesFile {
  source: "recorded-human" | "simulated";
  cohort?: string;
  collectedAt?: string;
  cases: Record<string, OutcomeCaseResponses>;
}

export interface OutcomeSuite {
  mode: "outcome";
  version: 1;
  name: string;
  description?: string;
  requiredCoverage?: boolean;
  defaults: CaseDefaults;
  cases: OutcomeCase[];
  /** 仅用于 --offline 走通流程；永远标记为 simulated，绝不冒充真实效果。 */
  simulatedResponses?: OutcomeResponsesFile;
}

function parseOutcomeTestItem(value: unknown, where: string): OutcomeTestItem {
  const item = asRecord(value, where);
  const kind = item.kind === undefined ? "text" : asString(item.kind, `${where}.kind`);
  if (kind !== "numeric" && kind !== "text") {
    throw new EvalSuiteError(`${where}.kind 只能是 numeric 或 text`);
  }
  const expected = asArray(item.expected, `${where}.expected`).map((answer, index) =>
    asString(answer, `${where}.expected[${index}]`),
  );
  if (!expected.length) throw new EvalSuiteError(`${where}.expected 不能为空`);
  return {
    id: asString(item.id, `${where}.id`),
    prompt: asString(item.prompt, `${where}.prompt`),
    expected,
    kind,
  };
}

function parseOutcomeTest(value: unknown, where: string): OutcomeTestSpec {
  const test = asRecord(value, where);
  const items = asArray(test.items, `${where}.items`).map((item, index) =>
    parseOutcomeTestItem(item, `${where}.items[${index}]`),
  );
  if (!items.length) throw new EvalSuiteError(`${where}.items 不能为空`);
  return { items };
}

function parsePhaseResponses(value: unknown, where: string): OutcomePhaseResponses {
  const phase = asRecord(value, where);
  const raw = asRecord(phase.responses, `${where}.responses`);
  const responses: Record<string, string> = {};
  for (const [key, answer] of Object.entries(raw)) {
    responses[asString(key, `${where}.responses 的题目 id`)] = asString(
      answer,
      `${where}.responses[${key}]`,
      { empty: true },
    );
  }
  return {
    responses,
    ...(phase.completedAtOffsetMs === undefined
      ? {}
      : {
          completedAtOffsetMs: asFiniteNumber(
            phase.completedAtOffsetMs,
            `${where}.completedAtOffsetMs`,
          ),
        }),
  };
}

function parseCaseResponses(value: unknown, where: string): OutcomeCaseResponses {
  const entry = asRecord(value, where);
  return {
    ...(entry.preTest === undefined
      ? {}
      : { preTest: parsePhaseResponses(entry.preTest, `${where}.preTest`) }),
    ...(entry.postTest === undefined
      ? {}
      : { postTest: parsePhaseResponses(entry.postTest, `${where}.postTest`) }),
    ...(entry.delayedTest === undefined
      ? {}
      : { delayedTest: parsePhaseResponses(entry.delayedTest, `${where}.delayedTest`) }),
    ...(entry.transferTest === undefined
      ? {}
      : { transferTest: parsePhaseResponses(entry.transferTest, `${where}.transferTest`) }),
  };
}

export function parseOutcomeResponses(
  value: unknown,
  where = "responses",
  expectedSource?: OutcomeResponsesFile["source"],
): OutcomeResponsesFile {
  const raw = asRecord(value, where);
  const source = asString(raw.source, `${where}.source`);
  if (source !== "recorded-human" && source !== "simulated") {
    throw new EvalSuiteError(`${where}.source 只能是 recorded-human 或 simulated`);
  }
  if (expectedSource && source !== expectedSource) {
    throw new EvalSuiteError(`${where}.source 必须为 ${expectedSource}`);
  }
  const cases = asRecord(raw.cases, `${where}.cases`);
  const parsed: Record<string, OutcomeCaseResponses> = {};
  for (const [id, entry] of Object.entries(cases)) {
    parsed[id] = parseCaseResponses(entry, `${where}.cases[${id}]`);
  }
  return {
    source,
    ...(raw.cohort === undefined ? {} : { cohort: asString(raw.cohort, `${where}.cohort`) }),
    ...(raw.collectedAt === undefined
      ? {}
      : { collectedAt: asString(raw.collectedAt, `${where}.collectedAt`) }),
    cases: parsed,
  };
}

function assertHeldOut(test: OutcomeTestSpec, learning: EvalCase, phase: string): void {
  const learningText = new Set(
    [
      ...learning.turns.map((turn) => turn.learner),
      learning.seed?.pendingQuestion?.prompt ?? "",
    ]
      .map(normalizedText)
      .filter(Boolean),
  );
  for (const item of test.items) {
    if (learningText.has(normalizedText(item.prompt))) {
      throw new EvalSuiteError(
        `${phase} 题目 ${item.id} 与学习会话逐字相同，不是 held-out；请换题或改问法`,
      );
    }
  }
}

function assertOutcomePhases(evalCase: OutcomeCase, where: string): void {
  const phases: [string, OutcomeTestSpec][] = [
    ["preTest", evalCase.preTest],
    ["postTest", evalCase.postTest],
    ["delayedTest", evalCase.delayedTest],
    ["transferTest", evalCase.transferTest],
  ];
  const ids = new Set<string>();
  const prompts = new Map<string, string>();
  for (const [phase, test] of phases) {
    for (const item of test.items) {
      if (ids.has(item.id)) throw new EvalSuiteError(`${where} 的测试题 id 重复：${item.id}`);
      ids.add(item.id);
      const prompt = normalizedText(item.prompt);
      const existing = prompts.get(prompt);
      if (existing) {
        throw new EvalSuiteError(`${where} 的 ${phase} 题目 ${item.id} 与 ${existing} 重复，相位必须换题`);
      }
      prompts.set(prompt, `${phase}/${item.id}`);
    }
  }
  assertHeldOut(evalCase.preTest, evalCase, `${where}.preTest`);
  assertHeldOut(evalCase.postTest, evalCase, `${where}.postTest`);
  assertHeldOut(evalCase.delayedTest, evalCase, `${where}.delayedTest`);
  assertHeldOut(evalCase.transferTest, evalCase, `${where}.transferTest`);
}

function parseOutcomeCase(value: unknown, where: string): OutcomeCase {
  const base = parseEvalCase(value, where);
  const entry = asRecord(value, where);
  const delayed = parseOutcomeTest(entry.delayedTest, `${where}.delayedTest`);
  const delayedRaw = asRecord(entry.delayedTest, `${where}.delayedTest`);
  const scheduleAfterMs = asFiniteNumber(
    delayedRaw.scheduleAfterMs,
    `${where}.delayedTest.scheduleAfterMs`,
  );
  if (!Number.isFinite(scheduleAfterMs) || scheduleAfterMs < 60_000) {
    throw new EvalSuiteError(`${where}.delayedTest.scheduleAfterMs 至少为 60000 毫秒`);
  }
  const outcomeCase: OutcomeCase = {
    ...base,
    preTest: parseOutcomeTest(entry.preTest, `${where}.preTest`),
    postTest: parseOutcomeTest(entry.postTest, `${where}.postTest`),
    delayedTest: { ...delayed, scheduleAfterMs },
    transferTest: parseOutcomeTest(entry.transferTest, `${where}.transferTest`),
  };
  assertOutcomePhases(outcomeCase, where);
  return outcomeCase;
}

export function parseOutcomeSuite(value: unknown): OutcomeSuite {
  const raw = asRecord(value, "outcome 套件");
  if (raw.version !== 1) throw new EvalSuiteError("outcome 套件 version 必须为 1");
  if (raw.mode !== "outcome") throw new EvalSuiteError("outcome 套件 mode 必须为 outcome");
  const defaults = asRecord(raw.defaults, "outcome 套件.defaults");
  const cases = asArray(raw.cases, "outcome 套件.cases").map((item, index) =>
    parseOutcomeCase(item, `outcome 套件.cases[${index}]`),
  );
  if (!cases.length) throw new EvalSuiteError("outcome 套件至少需要一个用例");
  const duplicate = cases.find(
    (item, index) => cases.findIndex((other) => other.id === item.id) !== index,
  );
  if (duplicate) throw new EvalSuiteError(`用例 id 重复：${duplicate.id}`);
  return {
    mode: "outcome",
    version: 1,
    name: asString(raw.name, "outcome 套件.name"),
    ...(raw.description === undefined
      ? {}
      : { description: asString(raw.description, "outcome 套件.description") }),
    ...(raw.requiredCoverage === undefined
      ? {}
      : { requiredCoverage: raw.requiredCoverage === true }),
    defaults: {
      topic: asString(defaults.topic, "outcome 套件.defaults.topic"),
      level: asString(defaults.level, "outcome 套件.defaults.level"),
      goal: asString(defaults.goal, "outcome 套件.defaults.goal"),
    },
    cases,
    ...(raw.simulatedResponses === undefined
      ? {}
      : {
          simulatedResponses: parseOutcomeResponses(
            raw.simulatedResponses,
            "outcome 套件.simulatedResponses",
            "simulated",
          ),
        }),
  };
}

export function loadOutcomeSuite(filePath: string): OutcomeSuite {
  return parseOutcomeSuite(readSuiteJson(filePath));
}

export function loadOutcomeResponses(filePath: string): OutcomeResponsesFile {
  return parseOutcomeResponses(readSuiteJson(filePath));
}

/** 由用例种子构建受控学习状态；非法种子立即失败，避免评测基于坏状态运行。 */
export function buildSeedState(spec: SeedSpec): LearningState {
  const currentStepId = spec.currentStepId ?? spec.steps[0].id;
  const raw = {
    version: 1,
    revision: spec.revision,
    goal: spec.goal,
    steps: spec.steps.map((step) => ({
      id: step.id,
      title: step.title,
      mastery: step.mastery ?? "new",
      evidence: step.evidence ?? [],
    })),
    currentStepId,
    pendingQuestion: spec.pendingQuestion
      ? {
          ...spec.pendingQuestion,
          stepId: spec.pendingQuestion.stepId ?? currentStepId,
          scope: spec.pendingQuestion.scope ?? "main",
          options: spec.pendingQuestion.options ?? [],
        }
      : null,
    detours: [],
    misconceptions: (spec.misconceptions ?? []).map((entry) => ({
      ...entry,
      scope: entry.scope ?? "main",
      status: entry.status ?? "repairing",
    })),
    deferredTopics: [],
    savedTracks: [],
    assumptions: spec.assumptions ?? [],
    lastAssessment: null,
    lastMove: null,
  };
  const state = parseLearningState(raw);
  if (!state) throw new EvalSuiteError("种子状态构建失败：parseLearningState 返回空值");
  return state;
}

// ── 独立数值核算（刻意不复用被测管线） ──────────────────────────────────────

const NUMERIC_PATTERN =
  /(?<![A-Za-z0-9])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/(?:\d+(?:\.\d+)?|\.\d+))?%?(?!\d)/g;

function canonicalNumber(token: string): string {
  const percent = token.endsWith("%") ? "%" : "";
  const raw = percent ? token.slice(0, -1) : token;
  if (raw.includes("/")) return raw.split("/").map(canonicalNumber).join("/") + percent;
  const negative = raw.startsWith("-");
  const unsigned = raw.replace(/^[+-]/, "");
  const [integerPart = "", fractionalPart = ""] = unsigned.split(".");
  const integer = (integerPart || "0").replace(/^0+(?=\d)/, "");
  const fraction = fractionalPart.replace(/0+$/, "");
  const sign = negative && (integer !== "0" || fraction) ? "-" : "";
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}${percent}`;
}

function numberKeys(text: string): Set<string> {
  const withoutSeparators = text
    .normalize("NFKC")
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/^\s*\d+[.)、]\s+/gm, "");
  return new Set((withoutSeparators.match(NUMERIC_PATTERN) ?? []).map(canonicalNumber));
}

function normalizedText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "");
}

function isNumericAnswer(value: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/(?:\d+(?:\.\d+)?|\.\d+))?%?$/.test(value);
}

// ── 断言基础设施 ────────────────────────────────────────────────────────────

export interface EvalCheckContext {
  learnerText: string;
  groundTruthNumbers?: string[];
}

export interface TurnObservation {
  request: ChatRequest;
  response: ChatResponse;
  previousState?: LearningState;
}

export interface EvalCheckResult {
  id: string;
  passed: boolean;
  detail: string;
}

function pass(id: string, detail: string): EvalCheckResult {
  return { id, passed: true, detail };
}

function fail(id: string, detail: string): EvalCheckResult {
  return { id, passed: false, detail };
}

interface EvidenceContainer {
  id: string;
  mastery: MasteryLevel;
  evidence: LearningEvidence[];
}

function containers(state: LearningState): EvidenceContainer[] {
  return [
    ...state.steps.map((step) => ({ id: step.id, mastery: step.mastery, evidence: step.evidence })),
    ...state.detours.map((detour) => ({
      id: detour.topic,
      mastery: detour.mastery,
      evidence: detour.evidence,
    })),
  ];
}

function addedEvidence(previous: LearningState | undefined, next: LearningState): LearningEvidence[] {
  const key = (entry: LearningEvidence) => `${entry.questionId}|${entry.kind}|${entry.turn}|${entry.quote}`;
  const known = new Set<string>();
  if (previous) for (const item of containers(previous)) for (const entry of item.evidence) known.add(key(entry));
  return containers(next).flatMap((item) => item.evidence).filter((entry) => !known.has(key(entry)));
}

function publicFields(observation: TurnObservation): string[] {
  const teaching = observation.response.teaching;
  return [
    observation.response.message,
    ...(teaching?.sources ?? []).map((source) => source.quote),
    ...(teaching?.assumptions ?? []),
  ];
}

function masterySnapshot(state: LearningState): string {
  return JSON.stringify({
    currentStepId: state.currentStepId,
    pendingQuestion: state.pendingQuestion,
    steps: state.steps.map((step) => ({ id: step.id, mastery: step.mastery, evidence: step.evidence })),
    detours: state.detours,
    misconceptions: state.misconceptions,
  });
}

// ── 单项断言 ────────────────────────────────────────────────────────────────

function assertStructuredState(observation: TurnObservation): EvalCheckResult {
  const id = "structured_state";
  const raw = observation.response.learningState;
  if (raw === undefined) {
    return observation.previousState
      ? fail(id, "已有学习状态，但本轮响应没有返回结构化状态")
      : pass(id, "本轮没有结构化状态（首次之外的工具动作）");
  }
  let state: LearningState | undefined;
  try {
    state = parseLearningState(raw);
  } catch (error) {
    return fail(id, `结构化状态不合法：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!state) return fail(id, "结构化状态为空");
  if (observation.previousState && state.revision < observation.previousState.revision) {
    return fail(id, `学习轮次回退：${observation.previousState.revision} → ${state.revision}`);
  }
  if (state.pendingQuestion && state.pendingQuestion.stepId !== state.currentStepId) {
    return fail(id, "待答问题没有绑定当前步骤");
  }
  return pass(
    id,
    `${state.steps.length} 步路线，轮次 ${state.revision}，待答问题 ${state.pendingQuestion?.id ?? "无"}`,
  );
}

function checkRoute(observation: TurnObservation): EvalCheckResult {
  const id = "route";
  const state = observation.response.learningState;
  if (!state) return fail(id, "开场没有建立结构化学习路线");
  if (state.steps.length < 3 || state.steps.length > 6) {
    return fail(id, `路线应为 3–6 步，实际 ${state.steps.length} 步`);
  }
  const ids = new Set(state.steps.map((step) => step.id));
  if (ids.size !== state.steps.length) return fail(id, "步骤编号重复");
  if (!ids.has(state.currentStepId)) return fail(id, "当前步骤不在路线中");
  const titles = state.steps.map((step) => normalizedText(step.title));
  if (new Set(titles).size !== titles.length) return fail(id, "步骤标题重复");
  if (observation.response.plan) {
    const plan = observation.response.plan.map(normalizedText);
    if (JSON.stringify(plan) !== JSON.stringify(titles)) {
      return fail(id, "返回的 plan 与结构化路线不一致");
    }
  }
  const evidence = containers(state).reduce((total, item) => total + item.evidence.length, 0);
  if (evidence) return fail(id, "开场不应携带学习者理解证据");
  if (state.misconceptions.length) return fail(id, "开场不应已有待巩固误区");
  return pass(id, `${state.steps.length} 步路线，当前步骤 ${state.currentStepId}`);
}

function checkQuestionIdentity(observation: TurnObservation): EvalCheckResult {
  const id = "question_identity";
  const state = observation.response.learningState ?? observation.previousState;
  if (!state) return fail(id, "没有可校验的结构化状态");
  const previousPending = observation.previousState?.pendingQuestion ?? null;
  const question = state.pendingQuestion;
  const lastAssessment = state.lastAssessment;

  if (lastAssessment && ["correct", "partial", "incorrect"].includes(lastAssessment.verdict)) {
    if (!previousPending) return fail(id, "上一轮没有待答问题，却出现了判分");
    if (lastAssessment.questionId !== previousPending.id) {
      return fail(id, `判分绑定了另一道题：${lastAssessment.questionId ?? "null"} ≠ ${previousPending.id}`);
    }
  }

  const newEvidence = addedEvidence(observation.previousState, state);
  for (const entry of newEvidence) {
    if (!previousPending || entry.questionId !== previousPending.id) {
      return fail(id, `新增证据绑定了非本轮问题：${entry.questionId}`);
    }
  }

  if (!question) return pass(id, "本轮没有新的待答问题");

  if (!question.id.trim()) return fail(id, "待答问题缺少编号");
  if (question.stepId !== state.currentStepId) {
    return fail(id, "待答问题没有对应当前讲解步骤");
  }
  const expectedScope = state.detours.length ? "detour" : "main";
  if (question.scope !== expectedScope) {
    return fail(id, `待答问题范围应为 ${expectedScope}，实际 ${question.scope}`);
  }
  if (!question.prompt.trim()) return fail(id, "待答问题缺少题干");
  if (question.kind === "choice" && question.options.length < 2) {
    return fail(id, "选择题至少需要两个选项");
  }
  if (question.kind === "calculation") {
    const keys = protectedAnswersFor(question);
    if (!keys.some((answer) => isNumericAnswer(answer.normalize("NFKC").trim()) || numberKeys(answer).size > 0)) {
      return fail(id, "计算题缺少私有数值答案，无法防止泄露与核算");
    }
  }
  if (["reasoning", "transfer", "calculation"].includes(question.kind) && !question.successCriteria.length) {
    return fail(id, `${question.kind} 题缺少私有判定标准`);
  }
  if (previousPending && previousPending.id === question.id && question.prompt !== previousPending.prompt) {
    return fail(id, "同一题号被改写成了另一道题");
  }
  return pass(id, `待答问题 ${question.id}（${question.kind}）绑定 ${question.stepId}`);
}

function leakIn(question: LearningQuestion, learnerText: string, fields: string[]): string | undefined {
  const answers = protectedAnswersFor(question);
  if (!answers.length) return undefined;
  const given = numberKeys(`${question.prompt}\n${learnerText}`);
  const publicText = fields.filter((field) => typeof field === "string" && field.trim()).join("\n");
  const visible = numberKeys(publicText);
  const normalizedInput = normalizedText(`${question.prompt}\n${learnerText}`);
  const normalizedPublic = normalizedText(publicText);
  for (const answer of answers) {
    const value = answer.normalize("NFKC").trim();
    if (!value) continue;
    if (isNumericAnswer(value)) {
      const key = canonicalNumber(value);
      if (!given.has(key) && visible.has(key)) return value;
    } else if (value.length >= 2) {
      const key = normalizedText(value);
      if (key && !normalizedInput.includes(key) && normalizedPublic.includes(key)) return value;
      // 带标签的私有答案（如“单位净值1.05”）仍保护其中的数值结果。
      if (question.kind === "calculation") {
        for (const token of numberKeys(value)) {
          if (!given.has(token) && visible.has(token)) return token;
        }
      }
    }
  }
  return undefined;
}

function checkAnswerLeak(observation: TurnObservation, context: EvalCheckContext): EvalCheckResult {
  const id = "no_answer_leak";
  const state = observation.response.learningState ?? observation.previousState;
  if (!state) return fail(id, "没有可校验的结构化状态");
  const fields = publicFields(observation);
  const active = state.pendingQuestion;
  if (active) {
    const leaked = leakIn(active, context.learnerText, fields);
    if (leaked) return fail(id, `新问题 ${active.id} 的私有结果「${leaked}」出现在公开讲解中`);
  }
  const answered = observation.previousState?.pendingQuestion ?? null;
  const verdict = state.lastAssessment?.verdict;
  if (answered && CORE_ACTIONS.includes(observation.request.action) && verdict !== "correct") {
    const leaked = leakIn(answered, context.learnerText, fields);
    if (leaked) return fail(id, `未解出的结果「${leaked}」被公开；只应提示机制或中间步骤`);
  }
  return pass(id, active ? `活动问题 ${active.id} 未泄露私有结果` : "本轮没有可泄露的待答结果");
}

function checkNoAdvance(observation: TurnObservation): EvalCheckResult {
  const id = "no_advance";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  if (!previous || !next) return fail(id, "缺少前后结构化状态，无法确认是否推进");
  if (next.currentStepId !== previous.currentStepId) {
    return fail(id, `答错后仍切换了步骤：${previous.currentStepId} → ${next.currentStepId}`);
  }
  if (
    JSON.stringify(previous.steps.map((step) => step.id)) !==
    JSON.stringify(next.steps.map((step) => step.id))
  ) {
    return fail(id, "答错回合改写了学习路线");
  }
  const current = next.steps.find((step) => step.id === next.currentStepId);
  if (!current) return fail(id, "当前步骤不在路线中");
  if (current.mastery === "understood" || current.mastery === "applied") {
    return fail(id, `答错后当前步骤仍被标为 ${current.mastery}`);
  }
  const added = addedEvidence(previous, next);
  const strong = added.filter((entry) => entry.kind === "reasoning" || entry.kind === "transfer");
  if (strong.length) {
    return fail(id, `答错后仍新增了 ${strong.map((entry) => entry.kind).join("/")} 证据`);
  }
  if (next.lastAssessment?.verdict === "correct") {
    return fail(id, "答错回合被判定为正确");
  }
  if (next.pendingQuestion && next.pendingQuestion.stepId !== next.currentStepId) {
    return fail(id, "修复问题没有停留在当前概念");
  }
  return pass(id, `停留在 ${next.currentStepId}，掌握度 ${current.mastery}`);
}

function checkMisconceptionRecorded(observation: TurnObservation, context: EvalCheckContext): EvalCheckResult {
  const id = "misconception_recorded";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  if (!previous?.pendingQuestion) return fail(id, "上一轮没有待答问题，无法核对误区记录");
  if (!next) return fail(id, "缺少结构化状态");
  const answered = previous.pendingQuestion;
  const entry = next.misconceptions.find(
    (item) =>
      item.questionId === answered.id ||
      (item.question !== undefined && normalizedText(item.question) === normalizedText(answered.prompt)),
  );
  if (!entry) return fail(id, "答错后没有记录本轮具体误区");
  if (entry.status === "resolved") return fail(id, "首错就直接清除了误区");
  if (!entry.evidenceQuote.trim()) return fail(id, "误区缺少证据引文");
  if (!context.learnerText.includes(entry.evidenceQuote)) {
    return fail(id, "误区证据不是本轮学习者原话的逐字片段");
  }
  return pass(id, `误区记录引用本轮原话，状态 ${entry.status}`);
}

function checkEvidenceVerbatim(observation: TurnObservation, context: EvalCheckContext): EvalCheckResult {
  const id = "evidence_verbatim";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  if (!next) return fail(id, "缺少结构化状态");
  const learner = context.learnerText;
  const added = addedEvidence(previous, next);
  for (const entry of added) {
    if (!learner.includes(entry.quote)) {
      return fail(id, `${entry.kind} 证据不是本轮学习者原话的逐字片段`);
    }
    if (entry.turn !== next.revision) {
      return fail(id, `证据轮次 ${entry.turn} 与状态轮次 ${next.revision} 不一致`);
    }
  }
  const quote = next.lastAssessment?.evidenceQuote;
  if (quote && !learner.includes(quote)) {
    return fail(id, "判分引用的证据不是本轮学习者原话");
  }
  return pass(id, added.length ? `${added.length} 条新证据均逐字来自本轮回答` : "本轮没有新增理解证据，判分引文已核对");
}

function checkNumericGate(
  observation: TurnObservation,
  context: EvalCheckContext,
): EvalCheckResult {
  const id = "numeric_gate";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  const answered = previous?.pendingQuestion;
  if (!answered) return fail(id, "上一轮没有待答问题，无法执行数值核算");
  if (answered.kind !== "calculation") return fail(id, "该检查只适用于上一轮的计算题");
  if (!context.groundTruthNumbers?.length) return fail(id, "用例缺少独立数值预期（groundTruth.numbers）");
  if (!next) return fail(id, "缺少结构化状态");

  const expected = context.groundTruthNumbers.map((value) => canonicalNumber(value.trim()));
  const key = new Set(
    protectedAnswersFor(answered).flatMap((value) => {
      const normalized = value.normalize("NFKC").trim();
      return isNumericAnswer(normalized) ? [canonicalNumber(normalized)] : [...numberKeys(normalized)];
    }),
  );
  const missingInKey = expected.filter((value) => !key.has(value));
  if (missingInKey.length) {
    return fail(id, `计算题私有答案缺少程序预期结果：${missingInKey.join("、")}`);
  }

  const learnerNumbers = numberKeys(context.learnerText);
  const matches = expected.every((value) => learnerNumbers.has(value));
  const verdict = next.lastAssessment?.verdict;
  const demonstrated = next.lastAssessment?.demonstrated;
  const added = addedEvidence(previous, next).filter(
    (entry) => entry.questionId === answered.id && (entry.kind === "reasoning" || entry.kind === "transfer"),
  );
  const step = next.steps.find((item) => item.id === answered.stepId);

  if (matches) {
    if (verdict === "incorrect") return fail(id, "学习者数值与私有答案一致，却被判为错误");
    return pass(id, `学习者数值命中预期 ${expected.join("、")}，判定 ${verdict ?? "无"}`);
  }
  if (verdict === "correct") {
    return fail(id, "学习者数值与程序预期不一致，却被判定为正确");
  }
  if (demonstrated === "reasoning" || demonstrated === "transfer") {
    return fail(id, `数值错误仍被记为 ${demonstrated} 证据`);
  }
  if (added.length) return fail(id, "数值错误仍新增了推理/迁移证据");
  if (step && (step.mastery === "understood" || step.mastery === "applied")) {
    return fail(id, `数值错误仍把步骤标为 ${step.mastery}`);
  }
  return pass(id, `程序核算数值不符（预期 ${expected.join("、")}），未被认证`);
}

function checkNoForgedTransfer(observation: TurnObservation): EvalCheckResult {
  const id = "no_forged_transfer";
  const next = observation.response.learningState ?? observation.previousState;
  if (!next) return fail(id, "缺少结构化状态");
  // 同一题干出现在不同题号上就说明只是换编号；迁移必须换题，不能重答原题。
  const seenPrompts = new Map<string, Set<string>>();
  const remember = (prompt: string | undefined, questionId: string) => {
    if (prompt === undefined) return;
    const key = normalizedText(prompt);
    if (!key) return;
    const ids = seenPrompts.get(key) ?? new Set<string>();
    ids.add(questionId);
    seenPrompts.set(key, ids);
  };
  for (const container of containers(next)) {
    for (const entry of container.evidence) remember(entry.question, entry.questionId);
  }
  for (const entry of next.misconceptions) remember(entry.question, entry.questionId);
  for (const container of containers(next)) {
    const transfer = container.evidence.filter((entry) => entry.kind === "transfer");
    const reasoning = container.evidence.filter((entry) => entry.kind === "reasoning");
    for (const entry of transfer) {
      const prompt = entry.question === undefined ? "" : normalizedText(entry.question);
      if (!prompt) return fail(id, "迁移证据缺少题干，无法证明换了问题");
      const previousIds = seenPrompts.get(prompt);
      if (previousIds && [...previousIds].some((previousId) => previousId !== entry.questionId)) {
        return fail(id, "迁移证据与已答问题同题同文，仅换了编号");
      }
      const prior = reasoning.some((item) => {
        const priorPrompt = item.question === undefined ? "" : normalizedText(item.question);
        return (
          item.questionId !== entry.questionId && priorPrompt !== "" && priorPrompt !== prompt
        );
      });
      if (!prior) return fail(id, "迁移证据与已有解释证据同题（或仅换编号），不能证明迁移");
    }
    if (container.mastery === "applied" && !transfer.length) {
      return fail(id, "已应用状态缺少迁移证据");
    }
  }
  const verdict = next.lastAssessment;
  if (verdict?.demonstrated === "transfer" && !["not_assessed"].includes(verdict.verdict)) {
    const answered = observation.previousState?.pendingQuestion;
    if (!answered) return fail(id, "没有任何待答问题时声明迁移");
    const duplicate = containers(next)
      .flatMap((item) => item.evidence)
      .some(
        (entry) =>
          entry.kind === "reasoning" &&
          entry.question !== undefined &&
          normalizedText(entry.question) === normalizedText(answered.prompt),
      );
    if (duplicate) return fail(id, "同题重答被声称为迁移");
  }
  return pass(id, "未发现同题换编号冒充迁移");
}

function checkChoiceNotReasoning(observation: TurnObservation): EvalCheckResult {
  const id = "choice_not_reasoning";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  const answered = previous?.pendingQuestion;
  if (!answered) return fail(id, "上一轮没有待答问题，无法核对题型门槛");
  if (answered.kind !== "choice") return fail(id, "该检查只适用于上一轮的选择题");
  if (!next) return fail(id, "缺少结构化状态");
  if (next.lastAssessment?.demonstrated === "reasoning" || next.lastAssessment?.demonstrated === "transfer") {
    return fail(id, `只选中选项却被记为 ${next.lastAssessment.demonstrated} 证据`);
  }
  const added = addedEvidence(previous, next).filter((entry) => entry.questionId === answered.id);
  const strong = added.filter((entry) => entry.kind === "reasoning" || entry.kind === "transfer");
  if (strong.length) return fail(id, "选择题被记为解释或迁移证据");
  const before = previous.steps.find((step) => step.id === answered.stepId)?.mastery;
  const after = next.steps.find((step) => step.id === answered.stepId)?.mastery;
  const upgraded =
    after !== undefined &&
    (after === "understood" || after === "applied") &&
    (before === undefined || (before !== "understood" && before !== "applied"));
  if (upgraded) return fail(id, "仅凭选择题就把步骤标记为已理解/已应用");
  return pass(id, `选择题最多留下辨认证据，判分 ${next.lastAssessment?.verdict ?? "无"}`);
}

const POSITIVE_CLAIM =
  /(?:已经?|确实|独立|由)[^。\n！？!?]{0,16}(?:核验|验证|掌握|学会|证实|作答|解出|完成)/;
const NEGATIVE_CLAIM =
  /(?:未|尚未|还未|还没有|没有|无|无法|不能|不曾|不代表|不算|并未|仍未)[^。\n！？!?]{0,24}(?:核验|验证|掌握|学会|完成|作答|解题|解出|证实|证据)/;
const FUTURE_CLAIM =
  /(?:将|要|会|打算|计划|争取|下一步|接着|继续|目标)[^。\n！？!?]{0,12}(?:核验|验证|掌握|学会|完成|作答|解题|解出|证实)/;
const EMPTY_HEADING =
  /^(?:学习者)?(?:已|已经)?(?:独立)?(?:核验|验证|掌握|学会)(?:的)?(?:部分|内容|项目)?$/;

function unsupportedMasteryClaims(message: string, state: LearningState): string[] {
  const claims = message
    .normalize("NFKC")
    .split(/[。\n！？!?；;]/)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .filter((clause) => {
      const heading = clause.replace(/[\s*#_`：:]/g, "");
      if (EMPTY_HEADING.test(heading)) return false;
      if (/(?:什么|哪些|吗|呢)$/.test(heading)) return false;
      if (NEGATIVE_CLAIM.test(clause) || FUTURE_CLAIM.test(clause)) return false;
      return POSITIVE_CLAIM.test(clause);
    });
  if (!claims.length) return [];
  const unverified = containers(state)
    .filter((item) => item.mastery !== "understood" && item.mastery !== "applied")
    .map((item) => item.id);
  const titles = state.steps.map((step) => ({ id: step.id, title: normalizedText(step.title) }));
  const verified = state.steps.some((step) => step.mastery === "understood" || step.mastery === "applied");
  const failures: string[] = [];
  for (const claim of claims) {
    const normalized = normalizedText(claim);
    for (const step of titles) {
      if (unverified.includes(step.id) && normalized.includes(step.title)) {
        failures.push(`把未核验步骤《${step.id}》说成已核验：${claim}`);
      }
    }
    if (!verified) failures.push(`学习状态没有任何独立理解证据，却声称已核验：${claim}`);
  }
  return failures;
}

function checkRecapSeparation(observation: TurnObservation): EvalCheckResult {
  const id = "recap_separation";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  if (observation.request.action !== "summary") return fail(id, "该检查只适用于复盘（summary）动作");
  if (!previous || !next) return fail(id, "复盘需要前后结构化状态");
  if (next.revision !== previous.revision) return fail(id, "复盘改写了学习轮次");
  if (masterySnapshot(previous) !== masterySnapshot(next)) {
    return fail(id, "复盘改动了步骤、证据、误区或待答问题");
  }
  if (observation.response.quiz?.length) return fail(id, "复盘不能另出练习冒充复盘");
  const message = observation.response.message;
  if (!message.trim()) return fail(id, "复盘没有内容");
  const claims = unsupportedMasteryClaims(message, previous);
  if (claims.length) return fail(id, claims[0]);
  const hasUnverified = containers(previous).some(
    (item) => item.mastery !== "understood" && item.mastery !== "applied",
  );
  if (hasUnverified && !/(?:未|尚未|还未|还没有|没有|无|待)[^。\n！？!?]{0,24}(?:核验|验证|掌握|学会|作答|解出|应用|完成)/.test(message)) {
    return fail(id, "还有未核验内容，复盘没有明确写出未核验");
  }
  if (!/(?:本次|这次|这一轮|这轮|本轮|刚才|复盘|回顾|总结|讲过|已讲)/.test(message)) {
    return fail(id, "复盘没有标明本次已讲内容，无法与继续讲解区分");
  }
  return pass(id, "复盘未宣称未核验内容已掌握，并保留了原状态");
}

function checkStateUnchanged(observation: TurnObservation): EvalCheckResult {
  const id = "state_unchanged";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  if (!previous || !next) return fail(id, "缺少前后结构化状态");
  if (previous.revision !== next.revision) {
    return fail(id, `工具动作改写了学习轮次：${previous.revision} → ${next.revision}`);
  }
  if (masterySnapshot(previous) !== masterySnapshot(next)) {
    return fail(id, "工具动作改动了学习状态或待答问题");
  }
  return pass(id, "学习状态与待答问题未变");
}

function checkDetourPreserved(observation: TurnObservation): EvalCheckResult {
  const id = "detour_preserved";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  if (!previous || !next) return fail(id, "缺少前后结构化状态");
  const pending = previous.pendingQuestion;
  if (!pending) return fail(id, "插问前没有待答问题，无法核对返回点");
  if (next.detours.length !== previous.detours.length + 1) {
    return fail(id, `插问没有新增且仅新增一个返回点：${previous.detours.length} → ${next.detours.length}`);
  }
  const detour = next.detours.at(-1)!;
  if (!detour.topic.trim()) return fail(id, "插问缺少主题");
  if (next.currentStepId !== previous.currentStepId) {
    return fail(id, "插问改变了主线当前步骤");
  }
  if (detour.returnStepId !== previous.currentStepId) {
    return fail(id, "插问保存了错误的主线返回步骤");
  }
  if (detour.returnQuestion?.id !== pending.id || detour.returnQuestion.prompt !== pending.prompt) {
    return fail(id, "插问没有逐字保存原待答问题");
  }
  if (next.pendingQuestion) {
    if (next.pendingQuestion.scope !== "detour") {
      return fail(id, "插问中的新问题没有标记为 detour 范围");
    }
    if (next.pendingQuestion.stepId !== next.currentStepId) {
      return fail(id, "插问问题没有绑定当前主线步骤");
    }
  }
  return pass(id, `已保存返回点 ${detour.returnStepId} 与原题 ${pending.id}`);
}

function checkResumeReturned(observation: TurnObservation): EvalCheckResult {
  const id = "resume_returned";
  const previous = observation.previousState;
  const next = observation.response.learningState;
  if (!previous || !next) return fail(id, "缺少前后结构化状态");
  const detour = previous.detours.at(-1);
  if (!detour) return fail(id, "上一轮没有可恢复的插问返回点");
  if (next.detours.length !== previous.detours.length - 1) {
    return fail(id, `恢复主线没有移除一个返回点：${previous.detours.length} → ${next.detours.length}`);
  }
  if (next.currentStepId !== detour.returnStepId) {
    return fail(id, "恢复后没有回到保存的主线步骤");
  }
  if (detour.returnQuestion && next.pendingQuestion?.id !== detour.returnQuestion.id) {
    return fail(id, "恢复后没有回到原题号");
  }
  const expectedScope = next.detours.length ? "detour" : "main";
  if (next.pendingQuestion && next.pendingQuestion.scope !== expectedScope) {
    return fail(id, `恢复后待答问题范围应为 ${expectedScope}`);
  }
  return pass(id, `已恢复到 ${detour.returnStepId}${detour.returnQuestion ? ` / ${detour.returnQuestion.id}` : ""}`);
}

/** 已掌握命题必须真正进入公开讲解或新路线，而不是被注入后完全忽略。 */
function checkKnownPropositionUsed(observation: TurnObservation): EvalCheckResult {
  const id = "known_proposition_used";
  const known = (observation.request.knowledgeGraph?.propositions ?? []).filter(
    (proposition) =>
      proposition.strength === "understood" || proposition.strength === "applied",
  );
  if (!known.length) {
    return fail(id, "用例没有提供已核验命题（knowledgeGraph），无法检查是否利用已知背景");
  }
  const teaching = observation.response.teaching;
  const publicText = normalizedText(
    [
      observation.response.message,
      ...(observation.response.plan ?? []),
      ...(teaching?.sources ?? []).map((source) => `${source.name}${source.quote}`),
      ...(teaching?.assumptions ?? []),
    ].join("\n"),
  );
  const used = known.filter((proposition) => {
    const statement = normalizedText(proposition.statement);
    return statement.length >= 2 && publicText.includes(statement);
  });
  if (!used.length) {
    return fail(
      id,
      `讲解/路线没有体现任何已掌握命题：${known.map((item) => item.statement).join("；")}`,
    );
  }
  return pass(id, `使用了已掌握命题：${used.map((item) => item.statement).join("；")}`);
}

/** 新路线返回的依赖边必须能落到本次 plan 或图谱命题上，且不丢已有边、不成环。 */
function checkGraphDependencyReturned(observation: TurnObservation): EvalCheckResult {
  const id = "graph_dependency_returned";
  const plan =
    observation.response.plan ??
    observation.response.learningState?.steps.map((step) => step.title) ??
    [];
  if (plan.length < 2) return fail(id, "本轮没有可核对的新路线（至少两步）");
  const graph = observation.response.knowledgeGraph;
  if (!graph) return fail(id, "响应没有返回 knowledgeGraph，路线依赖未回传");
  if (!graph.dependencies.length) return fail(id, "响应没有返回任何路线依赖边");
  const known = new Set([
    ...graph.propositions.map((proposition) => proposition.id),
    ...plan.map((title) => propositionId(title)),
  ]);
  const seen = new Set<string>();
  for (const dependency of graph.dependencies) {
    if (!known.has(dependency.fromId) || !known.has(dependency.toId)) {
      return fail(
        id,
        `依赖边 ${dependency.fromId}→${dependency.toId} 指向本次路线和图谱之外的节点`,
      );
    }
    if (dependency.fromId === dependency.toId) return fail(id, "依赖边不能是自环");
    const key = `${dependency.fromId}→${dependency.toId}`;
    if (seen.has(key)) return fail(id, `依赖边重复：${key}`);
    seen.add(key);
  }
  const returned = new Set(graph.dependencies.map((item) => `${item.fromId}→${item.toId}`));
  const lost = (observation.request.knowledgeGraph?.dependencies ?? []).filter(
    (dependency) => !returned.has(`${dependency.fromId}→${dependency.toId}`),
  );
  if (lost.length) {
    return fail(id, `返回图谱丢失了已有依赖：${lost.map((item) => `${item.fromId}→${item.toId}`).join("、")}`);
  }
  for (const dependency of graph.dependencies) {
    if (reachable(graph, dependency.toId, dependency.fromId)) {
      return fail(id, `依赖边 ${dependency.fromId}→${dependency.toId} 形成环`);
    }
  }
  return pass(id, `返回 ${graph.dependencies.length} 条可追溯依赖边`);
}

const REVIEW_CLOCK = 1_700_000_000_000;

/**
 * 从当前学习状态沉淀到的命题必须能生成主动回忆复习项。
 * 只生成 understood 命题；全部 applied 时没有复习必要，按缺数据失败。
 */
function checkGraphReviewGenerated(observation: TurnObservation): EvalCheckResult {
  const id = "graph_review_generated";
  const state = observation.response.learningState ?? observation.previousState;
  if (!state) return fail(id, "没有可沉淀的学习状态");
  let graph = observation.request.knowledgeGraph
    ? structuredClone(observation.request.knowledgeGraph)
    : emptyGraph();
  const add = (statement: string, evidence: LearningEvidence[], mastery: MasteryLevel) => {
    if (!evidence.length || (mastery !== "understood" && mastery !== "applied")) return;
    graph = upsertProposition(graph, {
      statement,
      topic: observation.request.topic,
      sourceSessionId: "eval-review",
      verifiedAt: REVIEW_CLOCK,
      strength: mastery === "applied" ? "applied" : "understood",
      evidence,
    });
  };
  for (const step of state.steps) add(step.title, step.evidence, step.mastery);
  for (const detour of state.detours) add(detour.topic, detour.evidence, detour.mastery);
  if (!graph.propositions.some((proposition) => proposition.strength === "understood")) {
    return fail(id, "没有已理解（understood）命题可生成复习项；已应用概念无需复习或缺少证据");
  }
  let serial = 0;
  let items: ReviewItem[];
  try {
    items = knowledgeGraphReviewItems(graph, {
      now: REVIEW_CLOCK,
      newId: () => `eval-review-${++serial}`,
    });
  } catch (error) {
    return fail(id, `复习生成失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!items.length) return fail(id, "知识图谱没有生成任何复习项");
  const invalid = items.find(
    (item) => !isKnowledgeGraphReviewItem(item) || typeof item.questionId !== "string",
  );
  if (invalid) return fail(id, `复习项 ${invalid.id} 不可追溯到图谱命题`);
  return pass(id, `生成 ${items.length} 条主动回忆复习项（${items.map((item) => item.questionId).join("、")}）`);
}

/** 书籍回合的每条公开引文必须逐字来自本轮同名原文，且位置由程序绑定。 */
function checkBookQuoteBound(observation: TurnObservation): EvalCheckResult {
  const id = "book_quote_bound";
  const references = (observation.request.references ?? []).filter(
    (reference) => reference.location,
  );
  if (!observation.request.bookContext || !references.length) {
    return fail(id, "用例没有提供 bookFixture（书籍原文）");
  }
  const sources = observation.response.teaching?.sources ?? [];
  if (!sources.length) return fail(id, "书籍回合没有给出任何原文引文");
  for (const source of sources) {
    const reference = references.find(
      (item) => item.name === source.name && item.text.includes(source.quote),
    );
    if (!reference) {
      return fail(
        id,
        `引文「${source.quote.slice(0, 40)}」不是同名原文的逐字片段（来源 ${source.name}）`,
      );
    }
    if (source.location && source.location.blockId !== reference.location?.blockId) {
      return fail(id, `引文位置 ${source.location.blockId} 与程序绑定的 ${reference.location?.blockId} 不一致`);
    }
  }
  return pass(id, `${sources.length} 条引文均逐字绑定本轮书籍原文`);
}

/** 网页结论的引文必须命中服务端核验文本；claim_matched 不能被降级或伪造。 */
function checkWebClaimMatched(observation: TurnObservation): EvalCheckResult {
  const id = "web_claim_matched";
  const references = observation.request.references ?? [];
  const webReferences = references.filter((reference) => reference.url);
  if (!webReferences.length) return fail(id, "用例没有提供网页来源（带 url 的 references）");
  const sources = observation.response.teaching?.sources ?? [];
  if (!sources.length) return fail(id, "网页资料回合没有任何来源引文");
  let citedWeb = 0;
  for (const source of sources) {
    const reference = references.find((item) => item.name === source.name);
    if (!reference) return fail(id, `引用了未提供的来源：${source.name}`);
    if (!reference.url) continue;
    citedWeb += 1;
    const verified = reference.verifiedQuote ?? "";
    if (!verified.includes(source.quote)) {
      return fail(id, `引文「${source.quote.slice(0, 40)}」没有逐字命中服务端核验文本`);
    }
    if (reference.verification === "claim_matched" && source.verification !== "claim_matched") {
      return fail(id, "claim_matched 来源的核验状态没有随引文回传");
    }
    if (reference.verification !== "claim_matched" && source.verification === "claim_matched") {
      return fail(id, "未完成 claim_matched 核验的来源被标成已按声明命中");
    }
  }
  if (!citedWeb) return fail(id, "没有任何网页来源被公开引用");
  return pass(id, `引用 ${citedWeb} 条网页来源，引文与核验状态一致`);
}

function runCheck(
  id: EvalCheckId,
  observation: TurnObservation,
  context: EvalCheckContext,
): EvalCheckResult {
  switch (id) {
    case "route":
      return checkRoute(observation);
    case "question_identity":
      return checkQuestionIdentity(observation);
    case "no_answer_leak":
      return checkAnswerLeak(observation, context);
    case "no_advance":
      return checkNoAdvance(observation);
    case "misconception_recorded":
      return checkMisconceptionRecorded(observation, context);
    case "evidence_verbatim":
      return checkEvidenceVerbatim(observation, context);
    case "numeric_gate":
      return checkNumericGate(observation, context);
    case "no_forged_transfer":
      return checkNoForgedTransfer(observation);
    case "choice_not_reasoning":
      return checkChoiceNotReasoning(observation);
    case "recap_separation":
      return checkRecapSeparation(observation);
    case "state_unchanged":
      return checkStateUnchanged(observation);
    case "detour_preserved":
      return checkDetourPreserved(observation);
    case "resume_returned":
      return checkResumeReturned(observation);
    case "known_proposition_used":
      return checkKnownPropositionUsed(observation);
    case "graph_dependency_returned":
      return checkGraphDependencyReturned(observation);
    case "graph_review_generated":
      return checkGraphReviewGenerated(observation);
    case "book_quote_bound":
      return checkBookQuoteBound(observation);
    case "web_claim_matched":
      return checkWebClaimMatched(observation);
  }
}

/** 独立断言入口：先校验结构化状态，再逐项执行用例要求的检查。 */
export function evaluateTurnChecks(
  ids: readonly EvalCheckId[],
  observation: TurnObservation,
  context: EvalCheckContext,
): EvalCheckResult[] {
  return [assertStructuredState(observation), ...ids.map((id) => runCheck(id, observation, context))];
}

// ── 用例执行 ────────────────────────────────────────────────────────────────

export interface RunOptions {
  invoke: ModelInvoker;
  timeoutMs: number;
  /** 独立评审模式可允许第二次针对性修订；默认只修订一次。 */
  maxWriterRevisions?: number;
  /** 需要从报告文本中抹去的密钥。 */
  secrets?: string[];
}

export type EvalErrorKind = "auth" | "provider" | "timeout" | "protocol" | "unknown";

export interface TurnReport {
  action: ChatRequest["action"];
  learner: string;
  status: "passed" | "failed" | "rejected" | "error";
  durationMs: number;
  checks: EvalCheckResult[];
  modelCalls?: number;
  rejected?: { status: number; code: string; issues: { code: string; detail: string }[] };
  error?: { kind: EvalErrorKind; message: string };
}

export interface CaseReport {
  id: string;
  title: string;
  covers: string[];
  status: "passed" | "failed" | "error";
  durationMs: number;
  turns: TurnReport[];
}

function classifyError(error: unknown, secrets: string[]): { kind: EvalErrorKind; message: string } {
  const clean = (text: string) => redactSecrets(text, ...secrets);
  if (error instanceof TeachingQualityError) {
    if (error.status === 504) return { kind: "timeout", message: clean(error.message) };
    return { kind: "protocol", message: clean(error.message) };
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return { kind: "auth", message: clean(error.message) };
    return { kind: "provider", message: clean(error.message) };
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || /abort|timeout|timed out/i.test(error.message)) {
      return { kind: "timeout", message: clean(error.message) };
    }
    return { kind: "unknown", message: clean(error.message) };
  }
  return { kind: "unknown", message: clean(String(error)) };
}

export async function runEvalCase(
  evalCase: EvalCase,
  defaults: CaseDefaults,
  options: RunOptions,
): Promise<CaseReport> {
  const startedAt = Date.now();
  const secrets = options.secrets ?? [];
  let state = evalCase.seed ? buildSeedState(evalCase.seed) : undefined;
  const conversation: Pick<ChatMessage, "role" | "content">[] = [...(evalCase.seed?.history ?? [])];
  const turns: TurnReport[] = [];
  let status: CaseReport["status"] = "passed";
  const bookMaterial = evalCase.bookFixture ? buildBookFixture(evalCase.bookFixture) : undefined;
  const references = bookMaterial?.references ?? evalCase.references;

  for (const turn of evalCase.turns) {
    const previousState = state ? structuredClone(state) : undefined;
    const learner = turn.learner;
    const messages: Pick<ChatMessage, "role" | "content">[] = [
      ...conversation,
      ...(learner ? [{ role: "user" as const, content: learner }] : []),
    ];
    const request: ChatRequest = {
      topic: evalCase.topic ?? defaults.topic,
      level: evalCase.level ?? defaults.level,
      goal: evalCase.goal ?? defaults.goal,
      action: turn.action,
      messages,
      ...(state ? { learningState: structuredClone(state) } : {}),
      ...(references?.length ? { references: structuredClone(references) } : {}),
      ...(bookMaterial ? { bookContext: structuredClone(bookMaterial.bookContext) } : {}),
      ...(evalCase.webSearch ? { webSearch: true } : {}),
      ...(evalCase.knowledgeGraph
        ? { knowledgeGraph: structuredClone(evalCase.knowledgeGraph) }
        : {}),
    };
    const turnStartedAt = Date.now();
    try {
      const response = await runTeachingTurn(request, options.invoke, { timeoutMs: options.timeoutMs, maxWriterRevisions: options.maxWriterRevisions });
      const checks = evaluateTurnChecks(
        turn.expect,
        { request, response, previousState },
        { learnerText: learner, groundTruthNumbers: evalCase.groundTruth?.numbers },
      );
      const failed = checks.filter((check) => !check.passed);
      turns.push({
        action: turn.action,
        learner,
        status: failed.length ? "failed" : "passed",
        durationMs: Date.now() - turnStartedAt,
        checks,
        ...(response.quality === undefined ? {} : { modelCalls: response.quality.modelCalls }),
      });
      if (failed.length) status = "failed";
      state = response.learningState ?? state;
      conversation.push(
        ...(learner ? [{ role: "user" as const, content: learner }] : []),
        { role: "assistant" as const, content: response.message },
      );
    } catch (error) {
      const durationMs = Date.now() - turnStartedAt;
      if (error instanceof TeachingQualityError && (error.code === "TURN_TIMEOUT" || error.status === 504)) {
        turns.push({
          action: turn.action,
          learner,
          status: "error",
          durationMs,
          checks: [],
          error: { kind: "timeout", message: redactSecrets(error.message, ...secrets) },
        });
        status = "error";
        break;
      }
      if (error instanceof TeachingQualityError) {
        const rejected = {
          status: error.status,
          code: error.code,
          issues: error.issues.map((issue) => ({
            code: issue.code,
            detail: redactSecrets(issue.detail, ...secrets),
          })),
        };
        const expectedCodes = turn.rejectionCodes ?? [];
        const gateHeld =
          turn.allowRejection === true &&
          (expectedCodes.length === 0 ||
            error.issues.some((issue) => expectedCodes.includes(issue.code)));
        if (gateHeld) {
          turns.push({
            action: turn.action,
            learner,
            status: "rejected",
            durationMs,
            checks: [
              {
                id: "pipeline_rejection",
                passed: true,
                detail: `程序拒绝并阻止提交：${error.status} ${error.code}（${rejected.issues.map((issue) => issue.code).join("、") || "无明细"}）`,
              },
            ],
            rejected,
          });
          if (learner) conversation.push({ role: "user" as const, content: learner });
          continue;
        }
        turns.push({
          action: turn.action,
          learner,
          status: "rejected",
          durationMs,
          checks: [],
          rejected,
        });
        status = "failed";
        continue;
      }
      turns.push({
        action: turn.action,
        learner,
        status: "error",
        durationMs,
        checks: [],
        error: classifyError(error, secrets),
      });
      status = "error";
      break;
    }
  }

  return {
    id: evalCase.id,
    title: evalCase.title,
    covers: evalCase.covers,
    status,
    durationMs: Date.now() - startedAt,
    turns,
  };
}

export interface RunSummary {
  status: "passed" | "failed" | "error" | "skipped";
  exitCode: 0 | 1 | 2 | 3;
  cases: number;
  passed: number;
  failed: number;
  errors: number;
}

/** 汇总用例结果；没有运行任何用例时视为跳过，绝不报告通过。 */
export function summarizeRun(reports: readonly CaseReport[]): RunSummary {
  const errors = reports.filter((report) => report.status === "error").length;
  const failed = reports.filter((report) => report.status === "failed").length;
  const passed = reports.filter((report) => report.status === "passed").length;
  const cases = reports.length;
  if (!cases) return { status: "skipped", exitCode: 2, cases, passed, failed, errors };
  if (errors) return { status: "error", exitCode: 3, cases, passed, failed, errors };
  if (failed) return { status: "failed", exitCode: 1, cases, passed, failed, errors };
  return { status: "passed", exitCode: 0, cases, passed, failed, errors };
}

/** 发布门禁必需覆盖缺失项；空数组代表满足。 */
export function missingCoverage(suite: EvalSuite): string[] {
  const covers = new Set(suite.cases.flatMap((item) => item.covers));
  return REQUIRED_COVERAGE.filter((required) => !covers.has(required));
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

/** Wilson 95% 区间；n=0 或计数不合法时返回 null，绝不编造区间。 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.959963984540054,
): ConfidenceInterval | null {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(total) ||
    total <= 0 ||
    successes < 0 ||
    successes > total
  ) {
    return null;
  }
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export interface CaseAttemptStats {
  id: string;
  title: string;
  attempts: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  confidenceInterval: ConfidenceInterval | null;
  flaky: boolean;
}

export interface AttemptsSummary {
  attempts: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number | null;
  confidenceInterval: ConfidenceInterval | null;
  flakyCases: string[];
  cases: CaseAttemptStats[];
}

/** 按用例汇总 --runs 的真实多次结果；只统计实际运行过的样本。 */
export function summarizeAttempts(reports: readonly CaseReport[]): AttemptsSummary {
  const cases: CaseAttemptStats[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    if (seen.has(report.id)) continue;
    seen.add(report.id);
    const attempts = reports.filter((item) => item.id === report.id);
    const passed = attempts.filter((item) => item.status === "passed").length;
    const failed = attempts.filter((item) => item.status === "failed").length;
    const errors = attempts.filter((item) => item.status === "error").length;
    cases.push({
      id: report.id,
      title: report.title,
      attempts: attempts.length,
      passed,
      failed,
      errors,
      passRate: attempts.length ? passed / attempts.length : 0,
      confidenceInterval: wilsonInterval(passed, attempts.length),
      flaky: passed > 0 && passed < attempts.length,
    });
  }
  const attempts = reports.length;
  const passed = reports.filter((item) => item.status === "passed").length;
  const failed = reports.filter((item) => item.status === "failed").length;
  const errors = reports.filter((item) => item.status === "error").length;
  return {
    attempts,
    passed,
    failed,
    errors,
    passRate: attempts ? passed / attempts : null,
    confidenceInterval: wilsonInterval(passed, attempts),
    flakyCases: cases.filter((item) => item.flaky).map((item) => item.id),
    cases,
  };
}

// ── 学习效果（outcome）执行 ─────────────────────────────────────────────────

export type OutcomeProvenance = OutcomeResponsesFile["source"] | "none";
export type OutcomeCaseStatus = "measured" | "simulated" | "skipped" | "error";

export interface OutcomeScore {
  correct: number;
  total: number;
  answered: number;
  missing: string[];
  score: number;
}

export interface OutcomeMetricResult {
  id: OutcomeMetricId;
  status: "measured" | "simulated" | "skipped";
  value: number | null;
  detail: string;
}

export interface OutcomeCaseReport {
  id: string;
  title: string;
  status: OutcomeCaseStatus;
  /** 真实学习效果只能由 recorded-human 的完整数据支撑；其余一律 pending。 */
  effect: "measured" | "pending" | "invalid";
  provenance: OutcomeProvenance;
  startedAt: string;
  scheduledAt: string;
  delayedCompletedAt: string | null;
  scores: {
    pre: number | null;
    post: number | null;
    delayed: number | null;
    transfer: number | null;
  };
  metrics: OutcomeMetricResult[];
  missing: string[];
  learning: { status: CaseReport["status"]; turns: number; durationMs: number } | null;
  detail: string;
}

export function scoreOutcomeTest(
  spec: OutcomeTestSpec,
  responses: Record<string, string> | undefined,
): OutcomeScore | undefined {
  if (!responses) return undefined;
  let correct = 0;
  let answered = 0;
  const missing: string[] = [];
  for (const item of spec.items) {
    const answer = responses[item.id];
    if (answer === undefined || !answer.trim()) {
      missing.push(item.id);
      continue;
    }
    answered += 1;
    if (outcomeAnswerMatches(item, answer)) correct += 1;
  }
  return { correct, total: spec.items.length, answered, missing, score: correct / spec.items.length };
}

function outcomeAnswerMatches(item: OutcomeTestItem, answer: string): boolean {
  if (item.kind === "numeric") {
    const given = numberKeys(answer);
    return item.expected.some((expected) => {
      const expectedKeys = numberKeys(expected);
      return expectedKeys.size > 0 && [...expectedKeys].every((key) => given.has(key));
    });
  }
  const normalized = normalizedText(answer);
  return item.expected.some((expected) => {
    const key = normalizedText(expected);
    return key.length > 0 && (normalized === key || normalized.includes(key));
  });
}

function metric(
  id: OutcomeMetricId,
  status: OutcomeMetricResult["status"],
  value: number | null,
  detail: string,
): OutcomeMetricResult {
  return { id, status, value, detail };
}

export interface OutcomeEvaluationOptions {
  responses?: OutcomeCaseResponses;
  source: OutcomeProvenance;
  now: number;
  learning?: OutcomeCaseReport["learning"];
}

/** 纯函数：从已记录的测试作答计算效果指标；模拟/缺数据永不标为 measured。 */
export function evaluateOutcomeCase(
  evalCase: OutcomeCase,
  options: OutcomeEvaluationOptions,
): OutcomeCaseReport {
  const startedAt = options.now;
  const scheduledAt = startedAt + evalCase.delayedTest.scheduleAfterMs;
  const responses = options.responses;
  const pre = scoreOutcomeTest(evalCase.preTest, responses?.preTest?.responses);
  const post = scoreOutcomeTest(evalCase.postTest, responses?.postTest?.responses);
  const delayed = scoreOutcomeTest(evalCase.delayedTest, responses?.delayedTest?.responses);
  const transfer = scoreOutcomeTest(evalCase.transferTest, responses?.transferTest?.responses);
  const provenance = responses ? options.source : "none";
  const metricStatus = provenance === "recorded-human" ? "measured" : "simulated";
  const metricLabel = metricStatus === "measured" ? "" : "（模拟数据，仅验证流程，不代表真实学习效果）";
  const missing: string[] = [];
  for (const [phase, score] of [
    ["preTest", pre],
    ["postTest", post],
    ["delayedTest", delayed],
    ["transferTest", transfer],
  ] as const) {
    if (!score) {
      missing.push(`${phase}:未提供作答`);
      continue;
    }
    for (const id of score.missing) missing.push(`${phase}:${id}`);
  }

  const metrics: OutcomeMetricResult[] = [];
  const complete = (score: OutcomeScore | undefined) => !!score && score.missing.length === 0;

  if (!complete(pre) || !complete(post)) {
    metrics.push(metric("normalized_gain", "skipped", null, "缺少完整前测或立即后测，无法计算归一化增益"));
  } else if (pre!.score >= 1) {
    metrics.push(metric("normalized_gain", "skipped", null, "前测满分，归一化增益无定义（天花板效应）"));
  } else {
    metrics.push(
      metric(
        "normalized_gain",
        metricStatus,
        (post!.score - pre!.score) / (1 - pre!.score),
        `g=(后测 ${post!.score.toFixed(2)}−前测 ${pre!.score.toFixed(2)})/(1−前测 ${pre!.score.toFixed(2)})${metricLabel}`,
      ),
    );
  }

  const completedOffset = responses?.delayedTest?.completedAtOffsetMs;
  if (!complete(post) || !complete(delayed)) {
    metrics.push(metric("retention_rate", "skipped", null, "缺少完整后测或延迟后测，无法计算保持率"));
  } else if (post!.score <= 0) {
    metrics.push(metric("retention_rate", "skipped", null, "后测为 0，保持率无定义"));
  } else if (completedOffset === undefined) {
    metrics.push(metric("retention_rate", "skipped", null, "缺少延迟后测完成时间，无法确认按计划完成"));
  } else if (completedOffset < evalCase.delayedTest.scheduleAfterMs) {
    metrics.push(
      metric(
        "retention_rate",
        "skipped",
        null,
        `延迟后测早于计划时间（完成于 ${completedOffset}ms，计划 ${evalCase.delayedTest.scheduleAfterMs}ms）`,
      ),
    );
  } else {
    metrics.push(
      metric(
        "retention_rate",
        metricStatus,
        delayed!.score / post!.score,
        `保持率=延迟后测 ${delayed!.score.toFixed(2)}/后测 ${post!.score.toFixed(2)}${metricLabel}`,
      ),
    );
  }

  if (!complete(transfer)) {
    metrics.push(metric("transfer_rate", "skipped", null, "缺少完整新情境迁移测试"));
  } else {
    metrics.push(
      metric(
        "transfer_rate",
        metricStatus,
        transfer!.score,
        `迁移测试 ${transfer!.correct}/${transfer!.total} 正确${metricLabel}`,
      ),
    );
  }

  let status: OutcomeCaseStatus;
  if (options.learning && options.learning.status !== "passed") {
    status = "error";
  } else if (!responses) {
    status = "skipped";
  } else if (provenance === "simulated") {
    status = "simulated";
  } else if (metrics.some((item) => item.status === "measured")) {
    status = "measured";
  } else {
    status = "skipped";
  }
  const measured = metrics.filter((item) => item.status === "measured").length;
  const detail =
    status === "error"
      ? `学习会话未通过（${options.learning?.status ?? "unknown"}），效果数据不作数`
      : status === "skipped"
        ? "没有真实测试作答或数据不完整，所有效果指标均跳过"
        : status === "simulated"
          ? "使用受控时钟/模拟作答走通流程；真实学习效果仍为 pending"
          : `完成 ${measured} 项真实效果指标；不等于通过教学认证`;

  return {
    id: evalCase.id,
    title: evalCase.title,
    status,
    effect: status === "measured" ? "measured" : status === "error" ? "invalid" : "pending",
    provenance,
    startedAt: new Date(startedAt).toISOString(),
    scheduledAt: new Date(scheduledAt).toISOString(),
    delayedCompletedAt:
      completedOffset === undefined ? null : new Date(startedAt + completedOffset).toISOString(),
    scores: {
      pre: pre?.score ?? null,
      post: post?.score ?? null,
      delayed: delayed?.score ?? null,
      transfer: transfer?.score ?? null,
    },
    metrics,
    missing,
    learning: options.learning ?? null,
    detail,
  };
}

export interface OutcomeRunOptions {
  invoke?: ModelInvoker;
  timeoutMs: number;
  secretKeys?: string[];
  responses?: OutcomeCaseResponses;
  source: OutcomeProvenance;
  now: number;
  maxWriterRevisions?: number;
  offline?: boolean;
}

export async function runOutcomeCase(
  evalCase: OutcomeCase,
  defaults: CaseDefaults,
  options: OutcomeRunOptions,
): Promise<OutcomeCaseReport> {
  let learning: OutcomeCaseReport["learning"] = null;
  if (!options.offline && options.invoke) {
    const report = await runEvalCase(
      { ...evalCase, covers: ["outcome"] },
      defaults,
      {
        invoke: options.invoke,
        timeoutMs: options.timeoutMs,
        ...(options.maxWriterRevisions === undefined
          ? {}
          : { maxWriterRevisions: options.maxWriterRevisions }),
        ...(options.secretKeys?.length ? { secrets: options.secretKeys } : {}),
      },
    );
    learning = { status: report.status, turns: report.turns.length, durationMs: report.durationMs };
  }
  return evaluateOutcomeCase(evalCase, {
    responses: options.responses,
    source: options.source,
    now: options.now,
    learning,
  });
}

export interface OutcomeSummary {
  status: "measured" | "simulated" | "skipped" | "error";
  effect: "measured" | "pending" | "invalid";
  exitCode: 0 | 2 | 3;
  cases: number;
  measured: number;
  simulated: number;
  skipped: number;
  errors: number;
}

/** 只要存在模拟或缺失数据就以非 0 退出，绝不把 pending 当通过。 */
export function summarizeOutcome(reports: readonly OutcomeCaseReport[]): OutcomeSummary {
  const cases = reports.length;
  const measured = reports.filter((report) => report.status === "measured").length;
  const simulated = reports.filter((report) => report.status === "simulated").length;
  const skipped = reports.filter((report) => report.status === "skipped").length;
  const errors = reports.filter((report) => report.status === "error").length;
  if (!cases)
    return {
      status: "skipped",
      effect: "pending",
      exitCode: 2,
      cases,
      measured,
      simulated,
      skipped,
      errors,
    };
  if (errors)
    return {
      status: "error",
      effect: "invalid",
      exitCode: 3,
      cases,
      measured,
      simulated,
      skipped,
      errors,
    };
  if (simulated)
    return {
      status: "simulated",
      effect: "pending",
      exitCode: 2,
      cases,
      measured,
      simulated,
      skipped,
      errors,
    };
  if (skipped)
    return {
      status: "skipped",
      effect: "pending",
      exitCode: 2,
      cases,
      measured,
      simulated,
      skipped,
      errors,
    };
  return {
    status: "measured",
    effect: "measured",
    exitCode: 0,
    cases,
    measured,
    simulated,
    skipped,
    errors,
  };
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

interface CliOptions {
  json: boolean;
  list: boolean;
  help: boolean;
  timeoutSeconds: number;
  caseIds: string[];
  suitePath: string;
  outcome: boolean;
  offline: boolean;
  runs: number;
  responsesPath?: string;
  nowMs?: number;
}

const USAGE = `知序教学评测门禁（真实模型）

用法：tsx scripts/eval-teaching.ts [选项]

  --case <id[,id]>      只运行指定用例，可重复
  --timeout <秒>        每个回合的整轮上限，默认 120
  --runs <N>            每个用例重复 N 次（1–20），报告 pass rate、95% CI 与 flaky
  --json                输出机器可读结果（stdout 仅 JSON）
  --list                列出用例后退出
  --suite <path>        指定套件文件，默认 eval/teaching-suite.json
  --outcome             运行学习效果（outcome）协议；默认套件 eval/outcome-suite.example.json
  --responses <path>    真实测试作答文件（recorded-human）；缺省时效果标 pending/skipped
  --offline             不调用模型，用受控时钟与模拟作答走通 outcome 流程（结果永远 pending）
  --now <ISO|毫秒>      受控时钟起点（仅 outcome/offline 分析用），默认当前时间
  --help                显示本帮助

环境变量：GEMINI_API_KEY / GEMINI_MODEL / GEMINI_BASE_URL
          OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL
          AI_STRUCTURED_OUTPUT / AI_THINKING_LEVEL

退出码：0 全部真实运行且通过；1 教学失败；2 环境未配置、必需覆盖缺失、套件/用法错误或效果数据缺失（未完成，不能视为通过）；3 供应商或网络错误、凭据被拒、回合超时（评测未完成）。
未运行真实模型或未获得真实测试作答（退出码 2/3）时不能视为评测通过。`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    list: false,
    help: false,
    timeoutSeconds: 120,
    caseIds: [],
    suitePath: DEFAULT_SUITE_PATH,
    outcome: false,
    offline: false,
    runs: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const separator = argument.indexOf("=");
    const flag = separator >= 0 ? argument.slice(0, separator) : argument;
    const inline = separator >= 0 ? argument.slice(separator + 1) : undefined;
    const next = (): string => {
      if (inline !== undefined) return inline;
      const value: string | undefined = argv[index + 1];
      if (value === undefined) throw new EvalSuiteError(`${flag} 缺少参数值\n\n${USAGE}`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--json":
        options.json = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--outcome":
        options.outcome = true;
        break;
      case "--offline":
        options.offline = true;
        break;
      case "--case": {
        const value = next();
        options.caseIds.push(
          ...value.split(",").map((item) => item.trim()).filter(Boolean),
        );
        break;
      }
      case "--timeout": {
        const value = Number(next());
        if (!Number.isFinite(value) || value < 5 || value > 1800) {
          throw new EvalSuiteError(`--timeout 必须是 5–1800 之间的秒数\n\n${USAGE}`);
        }
        options.timeoutSeconds = Math.floor(value);
        break;
      }
      case "--runs": {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 1 || value > 20) {
          throw new EvalSuiteError(`--runs 必须是 1–20 之间的整数\n\n${USAGE}`);
        }
        options.runs = value;
        break;
      }
      case "--responses": {
        options.responsesPath = path.resolve(process.cwd(), next());
        break;
      }
      case "--now": {
        const value = next();
        const numeric = Number(value);
        const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new EvalSuiteError(`--now 必须是毫秒时间戳或 ISO 日期\n\n${USAGE}`);
        }
        options.nowMs = parsed;
        break;
      }
      case "--suite": {
        options.suitePath = path.resolve(process.cwd(), next());
        break;
      }
      default:
        throw new EvalSuiteError(`未知选项：${flag}\n\n${USAGE}`);
    }
  }
  if (options.offline && !options.outcome) {
    throw new EvalSuiteError(`--offline 只适用于 --outcome 模式\n\n${USAGE}`);
  }
  if (options.outcome && options.runs !== 1) {
    throw new EvalSuiteError(`--runs 只适用于教学回合门禁；outcome 指标不做多次运行合并\n\n${USAGE}`);
  }
  if (options.outcome && options.suitePath === DEFAULT_SUITE_PATH) {
    options.suitePath = DEFAULT_OUTCOME_SUITE_PATH;
  }
  return options;
}

/** 参数解析与环境加载都返回带标签结果，避免半初始化配置进入真实调用。 */
function parseCliResult(argv: string[]): { ok: true; value: CliOptions } | { ok: false; message: string } {
  try {
    return { ok: true, value: parseArgs(argv) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function loadSelectedSuite(
  suitePath: string,
  caseIds: string[],
): { ok: true; suite: EvalSuite; selected: EvalCase[] } | { ok: false; message: string } {
  try {
    const suite = loadSuite(suitePath);
    const selected = selectCases(suite, caseIds);
    return { ok: true, suite, selected };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function validateTurnFixtures(selected: readonly EvalCase[]): string | undefined {
  for (const item of selected) {
    try {
      if (item.seed) buildSeedState(item.seed);
      if (item.bookFixture) buildBookFixture(item.bookFixture);
    } catch (error) {
      return `用例 ${item.id} 的夹具不合法：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

function loadSelectedOutcomeSuite(
  suitePath: string,
  caseIds: string[],
): { ok: true; suite: OutcomeSuite; selected: OutcomeCase[] } | { ok: false; message: string } {
  try {
    const suite = loadOutcomeSuite(suitePath);
    const unknown = caseIds.filter((id) => !suite.cases.some((item) => item.id === id));
    if (unknown.length) throw new EvalSuiteError(`套件中没有这些用例：${unknown.join("、")}`);
    const selected = caseIds.length
      ? suite.cases.filter((item) => caseIds.includes(item.id))
      : suite.cases;
    return { ok: true, suite, selected };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function validateOutcomeFixtures(selected: readonly OutcomeCase[]): string | undefined {
  for (const item of selected) {
    try {
      if (item.seed) buildSeedState(item.seed);
      if (item.bookFixture) buildBookFixture(item.bookFixture);
    } catch (error) {
      return `用例 ${item.id} 的夹具不合法：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

function loadLiveConfig(): { ok: true; config: ResolvedConfig } | { ok: false; message: string } {
  try {
    // 非法超时/输出上限/思考等级/网页配置必须在此明确失败，而不是静默回退默认值后继续真实评测。
    loadAiRuntimeConfig();
    loadWebConfig();
    return { ok: true, config: resolveConfig() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function selectCases(suite: EvalSuite, caseIds: string[]): EvalCase[] {
  if (!caseIds.length) return suite.cases;
  const unknown = caseIds.filter((id) => !suite.cases.some((item) => item.id === id));
  if (unknown.length) throw new EvalSuiteError(`套件中没有这些用例：${unknown.join("、")}`);
  return suite.cases.filter((item) => caseIds.includes(item.id));
}

function truncate(text: string, max = 240): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function printCaseReport(report: CaseReport, index: number, total: number): void {
  const label =
    report.status === "passed" ? "PASS" : report.status === "failed" ? "FAIL" : "ERROR";
  console.log(
    `[${index}/${total}] ${report.id}  ${label}  (${report.turns.length} 回合, ${(report.durationMs / 1000).toFixed(1)}s)`,
  );
  for (const [turnIndex, turn] of report.turns.entries()) {
    const turnLabel =
      turn.status === "passed"
        ? "PASS"
        : turn.status === "failed"
          ? "FAIL"
          : turn.status === "rejected"
            ? "REJECTED"
            : "ERROR";
    const extra =
      turn.status === "rejected" && turn.rejected
        ? `  ${turn.rejected.status} ${turn.rejected.code}`
        : turn.status === "error" && turn.error
          ? `  ${turn.error.kind}: ${truncate(turn.error.message)}`
          : "";
    console.log(
      `  turn ${turnIndex + 1} ${turn.action}  ${turnLabel}  ${(turn.durationMs / 1000).toFixed(1)}s${extra}`,
    );
    for (const check of turn.checks) {
      console.log(`    ${check.passed ? "ok  " : "FAIL"} ${check.id}: ${truncate(check.detail)}`);
    }
    if (turn.rejected) {
      for (const issue of turn.rejected.issues) {
        console.log(`    rejected ${issue.code}: ${truncate(issue.detail)}`);
      }
    }
  }
}

function coverageOf(suite: EvalSuite): string[] {
  return [...new Set(suite.cases.flatMap((item) => item.covers))].sort();
}

function printLimitations(): void {
  console.log("");
  console.log("说明与限制：");
  console.log("- 本门禁调用真实模型，剧本固定，不能代表全部教学场景；通过不等于所有主题都合格。");
  console.log("- 断言由本程序独立核算结构化状态、题号身份、逐字证据、题型门槛、答案泄露与数值预期，不采信模型自述 verdict。");
  console.log("- 退出码 2/3 表示未完成真实评测（环境或供应商问题），不得对外声称真实评测通过。");
  console.log("- 仅向配置的模型供应商端点（或本地兼容端点）发送请求，不访问其它公网服务。");
}

function endpointHost(config: ResolvedConfig): string {
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return "unknown";
  }
}

function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function emitSkipped(
  suitePath: string,
  reason: string,
  json: boolean,
  hint: string,
  mode = "live-model",
): void {
  if (json) {
    emitJson({
      suite: suitePath,
      mode,
      live: false,
      status: "skipped",
      exitCode: 2,
      reason,
      runs: 0,
      stats: null,
      cases: [],
    });
    return;
  }
  console.error(`SKIP 未运行真实模型：${reason}`);
  console.error(hint);
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatInterval(interval: ConfidenceInterval | null): string {
  if (!interval) return "n/a";
  return `${(interval.low * 100).toFixed(1)}%–${(interval.high * 100).toFixed(1)}%`;
}

function coverageOfOutcome(suite: OutcomeSuite): string[] {
  return [...new Set(suite.cases.flatMap((item) => item.covers))].sort();
}

function printOutcomeReport(report: OutcomeCaseReport, index: number, total: number): void {
  console.log(
    `[${index}/${total}] ${report.id}  ${report.status.toUpperCase()}  effect=${report.effect}  (${report.title})`,
  );
  const score = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  console.log(
    `  前测 ${score(report.scores.pre)} · 后测 ${score(report.scores.post)} · 延迟 ${score(report.scores.delayed)} · 迁移 ${score(report.scores.transfer)}`,
  );
  console.log(
    `  计划延迟后测 ${report.scheduledAt}${report.delayedCompletedAt ? ` · 实际完成 ${report.delayedCompletedAt}` : ""}`,
  );
  for (const item of report.metrics) {
    const value = item.value === null ? "" : ` = ${item.value.toFixed(4)}`;
    console.log(`  ${item.id}: ${item.status}${value} — ${item.detail}`);
  }
  if (report.missing.length) console.log(`  缺失：${report.missing.join("、")}`);
  if (report.learning) {
    console.log(
      `  学习会话：${report.learning.status} · ${report.learning.turns} 回合 · ${report.learning.durationMs}ms`,
    );
  }
  console.log(`  ${report.detail}`);
}

function loadResponsesFile(
  responsesPath: string,
): { ok: true; file: OutcomeResponsesFile } | { ok: false; message: string } {
  try {
    return { ok: true, file: loadOutcomeResponses(responsesPath) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function runTurnMode(cli: CliOptions): Promise<number> {
  const selection = loadSelectedSuite(cli.suitePath, cli.caseIds);
  if (!selection.ok) {
    emitSkipped(
      cli.suitePath,
      selection.message,
      cli.json,
      "未执行真实评测，不能视为通过。请修正套件或参数后重试。",
    );
    return 2;
  }
  const { suite, selected } = selection;

  if (cli.list) {
    if (cli.json) {
      emitJson({
        suite: cli.suitePath,
        name: suite.name,
        coverage: coverageOf(suite),
        cases: selected.map((item) => ({
          id: item.id,
          title: item.title,
          covers: item.covers,
          turns: item.turns.length,
          fixtures: {
            knowledgeGraph: item.knowledgeGraph?.propositions.length ?? 0,
            bookBlocks: item.bookFixture?.blocks.length ?? 0,
            references: item.references?.length ?? 0,
            webSearch: item.webSearch === true,
          },
        })),
      });
    } else {
      console.log(`${suite.name}  ·  ${cli.suitePath}`);
      for (const item of selected) {
        const fixtures = [
          item.knowledgeGraph ? `图谱 ${item.knowledgeGraph.propositions.length} 命题` : "",
          item.bookFixture ? `书籍 ${item.bookFixture.blocks.length} 段` : "",
          item.references ? `资料 ${item.references.length} 条` : "",
          item.webSearch ? "webSearch" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        console.log(
          `- ${item.id}  ${item.title}  [${item.covers.join(", ")}]${fixtures ? `  (${fixtures})` : ""}`,
        );
      }
      console.log(`\n覆盖：${coverageOf(suite).join("、")}`);
    }
    return 0;
  }

  const fixtureError = validateTurnFixtures(selected);
  if (fixtureError) {
    emitSkipped(
      cli.suitePath,
      fixtureError,
      cli.json,
      "未执行真实评测，不能视为通过。请修正用例夹具后重试。",
    );
    return 2;
  }

  if (suite.requiredCoverage !== false) {
    const missing = missingCoverage(suite);
    if (missing.length) {
      emitSkipped(
        cli.suitePath,
        `套件缺少发布门禁必需覆盖：${missing.join("、")}`,
        cli.json,
        "补齐用例后重试；未执行真实评测，不能视为通过。",
      );
      return 2;
    }
  }

  // 只从环境变量解析配置：使用服务端密钥，禁止请求内 BYOK。
  const configResult = loadLiveConfig();
  if (!configResult.ok) {
    emitSkipped(
      cli.suitePath,
      configResult.message,
      cli.json,
      "未执行真实评测，不能视为通过。请配置 GEMINI_API_KEY 或 OPENAI_API_KEY 后重试。",
    );
    return 2;
  }
  const config = configResult.config;
  const pipeline = createTeachingPipeline(config);
  const reviewerModel = pipeline.reviewerModel ?? config.model;

  const startedAt = Date.now();
  const runOptions: RunOptions = {
    invoke: pipeline.invoke,
    timeoutMs: cli.timeoutSeconds * 1000,
    maxWriterRevisions: pipeline.maxWriterRevisions,
    secrets: [config.apiKey],
  };
  const reports: CaseReport[] = [];
  if (!cli.json) {
    console.log(`知序教学评测（真实模型） · ${suite.name}`);
    console.log(
      `供应商 ${config.provider} · 模型 ${config.model} · 评审 ${reviewerModel} · 版本 ${packageVersion()} · harness ${HARNESS_VERSION} · 日期 ${new Date(startedAt).toISOString()}`,
    );
    console.log(
      `端点 ${endpointHost(config)} · 每回合上限 ${cli.timeoutSeconds}s · 每用例 ${cli.runs} 轮`,
    );
    console.log(`套件 ${cli.suitePath} · 用例 ${selected.length}`);
    console.log("");
  }
  for (let runIndex = 0; runIndex < cli.runs; runIndex += 1) {
    if (!cli.json && cli.runs > 1) console.log(`── 第 ${runIndex + 1}/${cli.runs} 轮 ──`);
    for (const [index, evalCase] of selected.entries()) {
      const report = await runEvalCase(evalCase, suite.defaults, runOptions);
      reports.push(report);
      if (!cli.json) printCaseReport(report, index + 1, selected.length);
    }
  }
  const summary = summarizeRun(reports);
  const attempts = summarizeAttempts(reports);
  const version = packageVersion();
  const date = new Date(startedAt).toISOString();

  if (cli.json) {
    emitJson({
      suite: cli.suitePath,
      name: suite.name,
      mode: "live-model",
      live: true,
      provider: config.provider,
      model: config.model,
      reviewerModel,
      version,
      harnessVersion: HARNESS_VERSION,
      date,
      endpoint: endpointHost(config),
      timeoutSeconds: cli.timeoutSeconds,
      runs: cli.runs,
      startedAt: date,
      durationMs: Date.now() - startedAt,
      status: summary.status,
      exitCode: summary.exitCode,
      completed: summary.status === "passed" || summary.status === "failed",
      summary: {
        cases: summary.cases,
        passed: summary.passed,
        failed: summary.failed,
        errors: summary.errors,
      },
      stats: attempts,
      coverage: coverageOf(suite),
      cases: reports,
      limitations: [
        "剧本固定，不覆盖全部教学场景；通过不代表所有主题都合格。",
        "断言独立于模型自述 verdict。",
        "退出码 2/3 表示未完成真实评测。",
        "pass rate 与 CI 只描述本套件本模型的重复抽样；CI 绿灯不等于学习效果。",
      ],
    });
    return summary.exitCode;
  }

  console.log("");
  console.log(
    `结果：通过 ${summary.passed} / ${summary.cases}，失败 ${summary.failed}，错误 ${summary.errors}（真实模型：已调用）`,
  );
  console.log(
    `pass rate ${formatRate(attempts.passRate)} · 95% CI ${formatInterval(attempts.confidenceInterval)} · flaky ${attempts.flakyCases.length ? attempts.flakyCases.join("、") : "无"}`,
  );
  if (summary.status === "error") {
    console.log("评测未完成：存在供应商/网络错误或超时，不得声称真实评测通过。");
  }
  console.log(`覆盖：${coverageOf(suite).join("、")}`);
  console.log(`退出码：${summary.exitCode}`);
  printLimitations();
  return summary.exitCode;
}

async function runOutcomeMode(cli: CliOptions): Promise<number> {
  const selection = loadSelectedOutcomeSuite(cli.suitePath, cli.caseIds);
  if (!selection.ok) {
    emitSkipped(
      cli.suitePath,
      selection.message,
      cli.json,
      "未执行效果评测，不能视为通过。请修正 outcome 套件或参数后重试。",
      "outcome",
    );
    return 2;
  }
  const { suite, selected } = selection;

  if (cli.list) {
    if (cli.json) {
      emitJson({
        suite: cli.suitePath,
        mode: "outcome",
        name: suite.name,
        coverage: coverageOfOutcome(suite),
        cases: selected.map((item) => ({
          id: item.id,
          title: item.title,
          covers: item.covers,
          turns: item.turns.length,
          preTest: item.preTest.items.length,
          postTest: item.postTest.items.length,
          delayedTest: item.delayedTest.items.length,
          delayedScheduleAfterMs: item.delayedTest.scheduleAfterMs,
          transferTest: item.transferTest.items.length,
        })),
      });
    } else {
      console.log(`${suite.name}  ·  ${cli.suitePath}`);
      for (const item of selected) {
        console.log(
          `- ${item.id}  ${item.title}  [${item.covers.join(", ")}]  前测 ${item.preTest.items.length} · 后测 ${item.postTest.items.length} · 延迟 ${item.delayedTest.items.length}（计划 +${Math.round(item.delayedTest.scheduleAfterMs / 3_600_000)}h）· 迁移 ${item.transferTest.items.length}`,
        );
      }
      console.log(`\n覆盖：${coverageOfOutcome(suite).join("、")}`);
    }
    return 0;
  }

  const fixtureError = validateOutcomeFixtures(selected);
  if (fixtureError) {
    emitSkipped(
      cli.suitePath,
      fixtureError,
      cli.json,
      "未执行效果评测，不能视为通过。请修正用例夹具后重试。",
      "outcome",
    );
    return 2;
  }

  let responsesFile: OutcomeResponsesFile | undefined;
  if (cli.responsesPath) {
    const loaded = loadResponsesFile(cli.responsesPath);
    if (!loaded.ok) {
      emitSkipped(
        cli.suitePath,
        loaded.message,
        cli.json,
        "未执行效果评测，不能视为通过。请修正 responses 文件后重试。",
        "outcome",
      );
      return 2;
    }
    responsesFile = loaded.file;
  } else if (cli.offline) {
    responsesFile = suite.simulatedResponses;
  }
  if (cli.offline && responsesFile?.source === "recorded-human") {
    emitSkipped(
      cli.suitePath,
      "--offline 只接受 simulated 作答；真实记录请使用 live 模式并配置模型",
      cli.json,
      "未执行效果评测，不能视为通过。",
      "outcome",
    );
    return 2;
  }
  if (!cli.offline && responsesFile?.source === "simulated") {
    emitSkipped(
      cli.suitePath,
      "live 模式拒绝 simulated 作答，避免把模拟数据当真实学习效果",
      cli.json,
      "未执行效果评测，不能视为通过。请提供 recorded-human 作答。",
      "outcome",
    );
    return 2;
  }

  let config: ResolvedConfig | undefined;
  let pipeline: TeachingPipeline | undefined;
  if (!cli.offline) {
    const configResult = loadLiveConfig();
    if (!configResult.ok) {
      emitSkipped(
        cli.suitePath,
        configResult.message,
        cli.json,
        "未执行效果评测，不能视为通过。请配置 GEMINI_API_KEY 或 OPENAI_API_KEY 后重试。",
        "outcome",
      );
      return 2;
    }
    config = configResult.config;
    pipeline = createTeachingPipeline(config);
  }

  const now = cli.nowMs ?? Date.now();
  const date = new Date(now).toISOString();
  const reports: OutcomeCaseReport[] = [];
  if (!cli.json) {
    console.log(`知序学习效果评测（outcome） · ${suite.name}`);
    console.log(
      cli.offline
        ? `模式 offline（受控时钟 + 模拟作答；真实效果 pending） · 版本 ${packageVersion()} · harness ${HARNESS_VERSION} · 日期 ${date}`
        : `供应商 ${config!.provider} · 模型 ${config!.model} · 版本 ${packageVersion()} · harness ${HARNESS_VERSION} · 日期 ${date}`,
    );
    console.log(
      `作答来源 ${responsesFile ? `${responsesFile.source}${responsesFile.cohort ? ` / ${responsesFile.cohort}` : ""}` : "无（效果将标 pending/skipped）"}`,
    );
    console.log(`套件 ${cli.suitePath} · 用例 ${selected.length}`);
    console.log("");
  }
  for (const [index, evalCase] of selected.entries()) {
    const caseResponses = responsesFile?.cases[evalCase.id];
    const report = await runOutcomeCase(evalCase, suite.defaults, {
      ...(pipeline ? { invoke: pipeline.invoke } : {}),
      timeoutMs: cli.timeoutSeconds * 1000,
      ...(config ? { secretKeys: [config.apiKey] } : {}),
      ...(pipeline ? { maxWriterRevisions: pipeline.maxWriterRevisions } : {}),
      responses: caseResponses,
      source: caseResponses ? (responsesFile?.source ?? "none") : "none",
      now,
      offline: cli.offline,
    });
    reports.push(report);
    if (!cli.json) printOutcomeReport(report, index + 1, selected.length);
  }
  const summary = summarizeOutcome(reports);

  if (cli.json) {
    emitJson({
      suite: cli.suitePath,
      name: suite.name,
      mode: "outcome",
      live: !cli.offline,
      offline: cli.offline,
      provider: config?.provider ?? null,
      model: config?.model ?? null,
      reviewerModel: pipeline?.reviewerModel ?? null,
      version: packageVersion(),
      harnessVersion: HARNESS_VERSION,
      date,
      startedAt: date,
      timeoutSeconds: cli.timeoutSeconds,
      responses: responsesFile
        ? {
            source: responsesFile.source,
            ...(responsesFile.cohort === undefined ? {} : { cohort: responsesFile.cohort }),
            ...(responsesFile.collectedAt === undefined
              ? {}
              : { collectedAt: responsesFile.collectedAt }),
          }
        : null,
      status: summary.status,
      exitCode: summary.exitCode,
      completed: summary.status === "measured",
      summary,
      coverage: coverageOfOutcome(suite),
      cases: reports,
      limitations: [
        "outcome 通过只表示数据完整且流程跑通，不表示学习效果得到因果证明。",
        "模拟作答或缺失数据一律 simulated/skipped，退出码 2，不能当通过。",
        "CI 绿灯不等于学习效果；真实对照需同一题库、随机顺序与盲评。",
        "归一化增益、保持率、迁移率只描述本样本，不是对所有学习者的承诺。",
      ],
    });
    return summary.exitCode;
  }

  console.log("");
  console.log(
    `结果：measured ${summary.measured} / ${summary.cases}，simulated ${summary.simulated}，skipped ${summary.skipped}，error ${summary.errors}`,
  );
  console.log(`退出码：${summary.exitCode}`);
  console.log("");
  console.log("说明与限制：");
  console.log("- outcome 通过只表示数据完整且流程跑通，不表示学习效果得到因果证明。");
  console.log("- 模拟作答或缺失数据一律 simulated/skipped，不能当通过。");
  console.log("- CI 绿灯不等于学习效果；真实对照需同一题库、随机顺序与盲评。");
  console.log("- 归一化增益、保持率、迁移率只描述本样本，不是对所有学习者的承诺。");
  return summary.exitCode;
}

async function main(): Promise<number> {
  // 只在真实入口加载项目根目录的 .env：测试导入 loadSuite/runEvalCase 等纯函数时不污染 process.env。
  loadDotenv({ path: path.resolve(SCRIPT_DIR, "..", ".env"), override: false });
  const cliResult = parseCliResult(process.argv.slice(2));
  if (!cliResult.ok) {
    console.error(cliResult.message);
    return 2;
  }
  const cli = cliResult.value;
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }
  return cli.outcome ? runOutcomeMode(cli) : runTurnMode(cli);
}

const invokedDirectly = isDirectExecution(import.meta.url);

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`评测脚本异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
