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
  LearningEvidence,
  LearningQuestion,
  LearningState,
  MasteryLevel,
  QuestionKind,
} from "../src/types";
import { parseLearningState } from "../src/lib/learningState";
import { protectedAnswersFor } from "../server/answers";
import { loadAiRuntimeConfig, loadWebConfig } from "../server/config";
import { isDirectExecution } from "./cli";
import {
  ApiError,
  createTeachingPipeline,
  redactSecrets,
  resolveConfig,
  type ResolvedConfig,
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
  turns: EvalTurn[];
}

export interface EvalSuite {
  version: 1;
  name: string;
  description?: string;
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

export function parseSuite(value: unknown): EvalSuite {
  const raw = asRecord(value, "套件");
  if (raw.version !== 1) throw new EvalSuiteError("套件 version 必须为 1");
  const defaults = asRecord(raw.defaults, "套件.defaults");
  const cases: EvalCase[] = asArray(raw.cases, "套件.cases").map((item, index) => {
    const where = `套件.cases[${index}]`;
    const entry = asRecord(item, where);
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
      turns,
    };
  });
  if (!cases.length) throw new EvalSuiteError("套件至少需要一个用例");
  const duplicate = cases.find((item, index) => cases.findIndex((other) => other.id === item.id) !== index);
  if (duplicate) throw new EvalSuiteError(`用例 id 重复：${duplicate.id}`);
  return {
    version: 1,
    name: asString(raw.name, "套件.name"),
    ...(raw.description === undefined
      ? {}
      : { description: asString(raw.description, "套件.description") }),
    defaults: {
      topic: asString(defaults.topic, "套件.defaults.topic"),
      level: asString(defaults.level, "套件.defaults.level"),
      goal: asString(defaults.goal, "套件.defaults.goal"),
    },
    cases,
  };
}

export function loadSuite(filePath: string = DEFAULT_SUITE_PATH): EvalSuite {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new EvalSuiteError(
      `无法读取评测套件 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new EvalSuiteError(`评测套件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSuite(parsed);
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

// ── 命令行 ──────────────────────────────────────────────────────────────────

interface CliOptions {
  json: boolean;
  list: boolean;
  help: boolean;
  timeoutSeconds: number;
  caseIds: string[];
  suitePath: string;
}

const USAGE = `知序教学评测门禁（真实模型）

用法：tsx scripts/eval-teaching.ts [选项]

  --case <id[,id]>   只运行指定用例，可重复
  --timeout <秒>     每个回合的整轮上限，默认 120
  --json             输出机器可读结果（stdout 仅 JSON）
  --list             列出用例后退出
  --suite <path>     指定套件文件，默认 eval/teaching-suite.json
  --help             显示本帮助

环境变量：GEMINI_API_KEY / GEMINI_MODEL / GEMINI_BASE_URL
          OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL
          AI_STRUCTURED_OUTPUT / AI_THINKING_LEVEL

退出码：0 全部通过；1 教学失败；2 环境未配置或套件/用法错误；3 供应商或网络错误、凭据被拒、回合超时（评测未完成）。
未运行真实模型（退出码 2/3）时不能视为评测通过。`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    list: false,
    help: false,
    timeoutSeconds: 120,
    caseIds: [],
    suitePath: DEFAULT_SUITE_PATH,
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
      case "--suite": {
        options.suitePath = path.resolve(process.cwd(), next());
        break;
      }
      default:
        throw new EvalSuiteError(`未知选项：${flag}\n\n${USAGE}`);
    }
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
    // 运行前先构建所有种子状态，避免调用真实模型后才发现用例数据损坏。
    for (const item of selected) {
      if (!item.seed) continue;
      try {
        buildSeedState(item.seed);
      } catch (error) {
        throw new EvalSuiteError(
          `用例 ${item.id} 的种子状态不合法：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { ok: true, suite, selected };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
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

function emitSkipped(suitePath: string, reason: string, json: boolean, hint: string): void {
  if (json) {
    emitJson({
      suite: suitePath,
      mode: "live-model",
      live: false,
      status: "skipped",
      exitCode: 2,
      reason,
      cases: [],
    });
    return;
  }
  console.error(`SKIP 未运行真实模型：${reason}`);
  console.error(hint);
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
        })),
      });
    } else {
      console.log(`${suite.name}  ·  ${cli.suitePath}`);
      for (const item of selected) {
        console.log(`- ${item.id}  ${item.title}  [${item.covers.join(", ")}]`);
      }
      console.log(`\n覆盖：${coverageOf(suite).join("、")}`);
    }
    return 0;
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
  const options: RunOptions = {
    invoke: pipeline.invoke,
    timeoutMs: cli.timeoutSeconds * 1000,
    maxWriterRevisions: pipeline.maxWriterRevisions,
    secrets: [config.apiKey],
  };
  const reports: CaseReport[] = [];
  if (!cli.json) {
    console.log(`知序教学评测（真实模型） · ${suite.name}`);
    console.log(
      `供应商 ${config.provider} · 模型 ${config.model} · 评审 ${reviewerModel} · 端点 ${endpointHost(config)} · 每回合上限 ${cli.timeoutSeconds}s`,
    );
    console.log(`套件 ${cli.suitePath} · 用例 ${selected.length}`);
    console.log("");
  }
  for (const [index, evalCase] of selected.entries()) {
    const report = await runEvalCase(evalCase, suite.defaults, options);
    reports.push(report);
    if (!cli.json) printCaseReport(report, index + 1, selected.length);
  }
  const summary = summarizeRun(reports);

  if (cli.json) {
    emitJson({
      suite: cli.suitePath,
      name: suite.name,
      mode: "live-model",
      live: true,
      provider: config.provider,
      model: config.model,
      reviewerModel,
      endpoint: endpointHost(config),
      timeoutSeconds: cli.timeoutSeconds,
      startedAt: new Date(startedAt).toISOString(),
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
      coverage: coverageOf(suite),
      cases: reports,
      limitations: [
        "剧本固定，不覆盖全部教学场景；通过不代表所有主题都合格。",
        "断言独立于模型自述 verdict。",
        "退出码 2/3 表示未完成真实评测。",
      ],
    });
    return summary.exitCode;
  }

  console.log("");
  console.log(
    `结果：通过 ${summary.passed} / ${summary.cases}，失败 ${summary.failed}，错误 ${summary.errors}（真实模型：已调用）`,
  );
  if (summary.status === "error") {
    console.log("评测未完成：存在供应商/网络错误或超时，不得声称真实评测通过。");
  }
  console.log(`覆盖：${coverageOf(suite).join("、")}`);
  console.log(`退出码：${summary.exitCode}`);
  printLimitations();
  return summary.exitCode;
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
