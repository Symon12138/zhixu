import type { ChatRequest } from "../src/types";
import {
  checkTutorDraft, LearningProtocolError, parseQuestionContent, parseTutorDraft,
  resolveLearnerTurn, type QuestionContent, type TeachingIssue, type TutorDraft,
} from "./learning";
import { protectedAnswersFor, hasNumericProtectedAnswer } from "./answers";

export interface LessonContent {
  message: string;
  question: QuestionContent | null;
  title?: string;
  plan?: string[];
  quiz?: TutorDraft["quiz"];
  flashcards?: TutorDraft["flashcards"];
  sources: TutorDraft["sources"];
  assumptions: string[];
  formatRepairs: string[];
}

export interface ReviewOutcome {
  pass: boolean;
  protocolFailure: boolean;
  issues: TeachingIssue[];
  draft?: TutorDraft;
  formatRepairs: string[];
}

export const reviewCheckNames = ["responsive", "assessment", "scaffolding", "continuity", "calibration"] as const;
const coreActions: ChatRequest["action"][] = ["start", "message", "continue", "hint", "example", "resume"];
const decisionIssueCodes: Record<string, true> = {
  fabricated_evidence: true, ungrounded_assessment: true, unproven_understanding: true, preference_is_not_knowledge: true, choice_is_not_reasoning: true,
  tool_is_not_evidence: true, unknown_focus: true, unknown_destination: true, navigation_focus_mismatch: true, silent_topic_jump: true,
  invalid_assumption_retraction: true, invented_misconception: true, tool_changed_progress: true,
  missing_misconception: true, numeric_mismatch: true, side_question_required: true, review_answer_revealed: true, review_new_answer_revealed: true,
  requested_solution_not_evidence: true,
};

function fail(code: string, detail: string): never {
  throw new LearningProtocolError([{ code, detail }]);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_protocol", `${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function stringList(value: unknown, name: string, max: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > itemMax)) fail("invalid_protocol", `${name} 必须为长度有效的非空字符串数组，最多${max}项`);
  return value.map(item => (item as string).trim());
}

function normalizeAssumptions(value: unknown, repairs: string[]): string[] {
  if (!Array.isArray(value) || value.length > 15) fail("invalid_protocol", "assumptions 必须为最多15项的前提数组");
  return stringList(value.map(item => {
    if (typeof item === "string") return item;
    const data = record(item, "assumption");
    if (Object.keys(data).some(key => key !== "role" && key !== "content") || typeof data.content !== "string" || !data.content.trim() || (data.role !== undefined && (typeof data.role !== "string" || !data.role.trim()))) fail("invalid_protocol", "前提对象只能含明确的 content 文字与可选 role 标签，不能丢弃其它内容或推测前提");
    repairs.push("将前提对象的角色标签与原文展开为文字声明");
    return data.role ? `${data.role}：${data.content}` : data.content;
  }), "assumptions", 15, 1000);
}

function alignedField(data: Record<string, unknown>, nested: Record<string, unknown> | undefined, key: string, repairs: string[]): unknown {
  const optional = key === "title" || key === "plan";
  const direct = optional && data[key] === null ? undefined : data[key];
  const embedded = optional && nested?.[key] === null ? undefined : nested?.[key];
  if (direct !== undefined && embedded !== undefined && JSON.stringify(direct) !== JSON.stringify(embedded)) fail("conflicting_fields", `${key} 在两处给出了不同内容，不能自动决定采用哪一处`);
  if (direct === undefined && embedded !== undefined) {
    repairs.push(`将误嵌套的 ${key} 移到公开内容层`);
    return embedded;
  }
  return direct;
}

function removeStandaloneQuestion(message: string, prompt: string): string {
  const lines = message.split("\n");
  const target = prompt.trim();
  const marker = /^(?:\*\*想一想\*\*|#{1,6}\s*想一想)\s*[:：]?$/;
  const label = /^(?:.*(?:题目|问题|练习|回答|作答)(?:是|为|如下)?)\s*[:：]?$/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === target) {
      let previous = index - 1;
      while (previous >= 0 && !lines[previous].trim()) previous -= 1;
      const start = previous >= 0 && (marker.test(lines[previous].trim()) || label.test(lines[previous].trim())) ? previous : index;
      lines.splice(start, index - start + 1);
      return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    const suffix = line.endsWith(target) ? line.slice(0, -target.length).trim() : "";
    if (suffix && (marker.test(suffix) || label.test(suffix)) && lines.slice(index + 1).every((rest) => !rest.trim())) {
      lines.splice(index, 1);
      return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }
  }
  return message;
}

function removeTerminalQuestionBlock(message: string): string {
  const lines = message.split("\n");
  const marker = /^(?:\*\*想一想\*\*|#{1,6}\s*想一想)\s*[:：]?$/;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!marker.test(lines[index].trim())) continue;
    const trailing = lines.slice(index + 1).join("\n").trim();
    if (!trailing || trailing.includes("\n\n") || !/[？?]$/.test(trailing)) continue;
    const prefix = lines.slice(0, index).join("\n").trim();
    if (prefix) return prefix;
  }
  return message;
}

/** Parse a small writer response. Model-authored state changes are never trusted here. */
export function parseLessonContent(value: unknown, action: ChatRequest["action"]): LessonContent {
  const data = record(value, "公开讲解");
  const embedded = data.teaching && typeof data.teaching === "object" && !Array.isArray(data.teaching) ? data.teaching as Record<string, unknown> : undefined;
  for (const suggestions of [data.suggestedReplies, embedded?.suggestedReplies]) {
    if (suggestions !== undefined && (!Array.isArray(suggestions) || suggestions.length)) fail("answer_in_suggestions", "不要替学习者生成可点击的建议答案；理解证据必须来自其真实作答");
  }
  const repairs: string[] = [];
  const flat: Record<string, unknown> = {};
  for (const key of ["message", "title", "plan", "sources", "quiz", "flashcards", "question", "assumptions"]) flat[key] = alignedField(data, embedded, key, repairs);
  const parsed = parseTutorDraft({ message: flat.message, title: flat.title, plan: flat.plan, sources: flat.sources, quiz: flat.quiz, flashcards: flat.flashcards }, action);
  const assumptions = normalizeAssumptions(flat.assumptions ?? [], repairs);
  let question: QuestionContent | null = null;
  if (coreActions.includes(action)) {
    if (flat.question === undefined) fail("missing_question_field", "公开讲解需要明确提供 question 对象或 null，不要求复制教学状态");
    if (flat.question !== null) {
      question = parseQuestionContent(flat.question);
      const protectedAnswers = protectedAnswersFor(question);
      if (question.kind === "calculation" && !hasNumericProtectedAnswer(question)) fail("missing_answer_key", "计算题需要至少一个可核算的私有数值答案，不能在公开讲解中抢答，也不能用非数值说明冒充答案");
      if (!question.protectedAnswers?.length && protectedAnswers.length) {
        question = { ...question, protectedAnswers };
        repairs.push("从已有判定标准提取私有结果标记");
      }
    }
  } else if (flat.question !== undefined && flat.question !== null) fail("tool_question", "生成练习、卡片或复盘不能另外替换主线问题");
  let message = parsed.message;
  if (question && message.endsWith(question.prompt)) {
    const prefix = message.slice(0, -question.prompt.length).trim();
    if (!prefix) fail("missing_explanation", "只有题面，没有讲解或回应");
    // Only identical terminal text is removed; references inside prose are not rewritten.
    message = prefix.replace(/(?:\*\*想一想\*\*|#{1,6}\s*想一想|题目|问题|练习|请(?:你)?(?:回答|作答))\s*[:：]?\s*$/, "").trim();
    if (!message) fail("missing_explanation", "只有题面，没有讲解或回应");
    repairs.push("去除正文末尾完全重复的题面");
  }
  if (question) {
    const cleaned = removeStandaloneQuestion(message, question.prompt);
    if (cleaned !== message) {
      message = cleaned;
      if (!message) fail("missing_explanation", "只有题面，没有讲解或回应");
      repairs.push("去除正文中独立重复的结构化题面");
    }
  }
  if (question) {
    const cleaned = removeTerminalQuestionBlock(message);
    if (cleaned !== message) {
      message = cleaned;
      repairs.push("去除正文末尾重复提问段");
    }
  }
  // The response assembler owns this heading. A paraphrased second question needs revision, not guessed deletion.
  if (question && /(?:^|\n)\s*(?:\*\*想一想\*\*|#{1,6}\s+想一想)\s*[:：]?\s*(?:\n|$)/.test(message)) fail("duplicated_question", "正文包含单独的想一想提问段；所有追问只保留在question，不在正文同义复述。保留解释，不要机械删除含有解释的段落");
  return { ...parsed, message, question, assumptions, formatRepairs: repairs };
}

function issueOutcome(code: string, detail: string, protocolFailure = true, repairs: string[] = []): ReviewOutcome {
  return { pass: false, protocolFailure, issues: [{ code, detail }], formatRepairs: repairs };
}

function normalizeMisconception(value: unknown, repairs: string[]): unknown {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const data = value as Record<string, unknown>;
  const description = data.description;
  const statement = data.statement;
  if (description !== undefined && statement !== undefined && description !== statement) fail("conflicting_misconception", "误区对象的 description 与 statement 冲突，不能自动选择");
  const result = description ?? statement;
  if (typeof result !== "string" || !result.trim()) fail("invalid_misconception", "误区需要唯一、具体的 description 或 statement 字符串");
  repairs.push("从误区对象提取唯一的说明字符串");
  return result;
}

function baseDecision(request: ChatRequest, content: LessonContent): Record<string, unknown> | undefined {
  if (!request.learningState) return { intent: "continue", move: content.question ? "orient" : "explain", navigation: { kind: "stay" } };
  if (request.action === "hint") return { intent: "continue", move: "hint", navigation: { kind: "stay" } };
  if (request.action === "example") return { intent: "request_explanation", move: "explain", navigation: { kind: "stay" } };
  if (request.action === "resume") return { intent: "continue", move: "return", navigation: { kind: "resume" } };
  if (request.action === "continue") return { intent: "continue", move: "explain", navigation: { kind: "stay" } };
  return undefined;
}

function composeDecision(request: ChatRequest, content: LessonContent, raw: unknown, repairs: string[]): TutorDraft {
  const isCore = coreActions.includes(request.action);
  if (!isCore) {
    if (raw !== undefined && raw !== null) fail("tool_decision", "工具动作的评审不能添加知识判定或导航决定");
    return { message: content.message, sources: content.sources, ...(content.title ? { title: content.title } : {}), ...(content.plan ? { plan: content.plan } : {}), ...(content.quiz ? { quiz: content.quiz } : {}), ...(content.flashcards ? { flashcards: content.flashcards } : {}) };
  }
  const defaults = baseDecision(request, content);
  if ((raw === undefined || raw === null) && !defaults) fail("missing_decision", "已有学习状态的普通回合需要评审给出意图与理解判定，不必复述题面或状态编号");
  const decision = raw === undefined || raw === null ? defaults! : record(raw, "decision");
  for (const key of ["message", "title", "plan", "sources", "quiz", "flashcards", "question"]) {
    if (decision[key] !== undefined && decision[key] !== null) fail("review_edited_content", "评审不能在声称通过的同时替换公开讲解或问题；需要改文时应要求修订");
  }
  if (decision.assumptions !== undefined && JSON.stringify(decision.assumptions) !== JSON.stringify(content.assumptions) && JSON.stringify(decision.assumptions) !== "[]") fail("review_edited_content", "业务前提属于公开讲解；评审不能悄悄补上原稿没有的前提");
  const navigation = record(decision.navigation ?? defaults?.navigation ?? { kind: "stay" }, "navigation");
  const state = request.learningState;
  let focusStepId: unknown = state?.currentStepId ?? "step-1";
  if (navigation.kind === "focus" || navigation.kind === "advance") focusStepId = navigation.targetStepId;
  else if (navigation.kind === "switch") focusStepId = state?.savedTracks.find(track => track.goal === navigation.topic)?.currentStepId ?? "step-1";
  else if (navigation.kind === "resume") focusStepId = state?.detours.at(-1)?.returnStepId ?? focusStepId;
  if (decision.focusStepId !== undefined && decision.focusStepId !== focusStepId) fail("conflicting_focus", "评审给出的步骤编号与当前状态/导航目标冲突，不能自动改成另一步");
  const learner = resolveLearnerTurn(request);
  const intent = decision.intent ?? defaults?.intent;
  const move = decision.move ?? defaults?.move;
  const rawAssessment = decision.assessment == null ? undefined : record(decision.assessment, "assessment");
  if (!rawAssessment && state && request.action === "message" && intent === "answer" && state.pendingQuestion?.kind !== "orientation") fail("missing_assessment", "真实知识作答需要明确判定，不能因为省略评审字段就算理解");
  const verdict = rawAssessment?.verdict ?? (intent === "uncertain" && request.action === "message" ? "uncertain" : "not_assessed");
  const graded = ["correct", "partial", "incorrect"].includes(String(verdict));
  let quote: unknown = rawAssessment?.evidenceQuote;
  if (quote === undefined || (graded && typeof quote === "string" && !quote.trim())) {
    if (learner.text.length > 1000 && graded) fail("missing_evidence_excerpt", "长回答需要评审选择本轮真实片段，不自动截断作答作为证据");
    quote = graded || verdict === "uncertain" ? learner.text : "";
    if (rawAssessment?.evidenceQuote === "") repairs.push("将空证据片段绑定为本轮真实回答");
  }
  const questionId = graded || verdict === "uncertain" ? state?.pendingQuestion?.id ?? null : null;
  if (rawAssessment?.questionId !== undefined && rawAssessment.questionId !== questionId) fail("conflicting_question", "评审绑定了另一道问题，不能将其当作本轮问题的证据");
  const feedback = rawAssessment?.feedback ?? (graded ? undefined : verdict === "uncertain" ? "先补基础，本轮不计为已理解。" : "本轮没有新增独立作答证据。");
  const assessment: Record<string, unknown> = { verdict, evidenceQuote: quote, questionId, demonstrated: rawAssessment?.demonstrated ?? "none", feedback };
  const misconception = normalizeMisconception(decision.misconception, repairs);
  const canonical = {
    message: content.message, title: content.title, plan: content.plan, sources: content.sources, quiz: content.quiz, flashcards: content.flashcards,
    teaching: {
      intent, move, focusStepId, assessment, navigation,
      question: content.question ? { ...content.question, stepId: focusStepId } : null,
      assumptions: content.assumptions,
      retractedAssumptions: decision.retractedAssumptions ?? [],
      resolvedMisconceptionIds: decision.resolvedMisconceptionIds ?? [],
      ...(misconception === undefined ? {} : { misconception }),
    },
  };
  return parseTutorDraft(canonical, request.action);
}

/** The reviewer judges content and student intent; the server binds identities and commits state. */
export function compileLessonReview(request: ChatRequest, content: LessonContent, value: unknown): ReviewOutcome {
  const repairs: string[] = [];
  try {
    const data = record(value, "评审");
    const checks = record(data.checks, "checks");
    if (!reviewCheckNames.every(key => typeof checks[key] === "boolean")) return issueOutcome("review_invalid", "独立评审必须完整提供五项布尔检查");
    if (!Array.isArray(data.issues) || data.issues.length > 20) return issueOutcome("review_invalid", "评审需要完整、长度有效的 issues 数组，不能省略或截断");
    const issues: TeachingIssue[] = data.issues.map(item => {
      const issue = record(item, "issue");
      if (typeof issue.code !== "string" || !issue.code.trim() || issue.code.length > 100 || typeof issue.detail !== "string" || !issue.detail.trim() || issue.detail.length > 2000) fail("review_invalid", "评审问题缺少有效 code 或 detail");
      return { code: issue.code, detail: issue.detail.trim() };
    });
    if (data.verdict === "revise" || data.verdict === "insufficient") return { pass: false, protocolFailure: false, issues: issues.length ? issues : [{ code: "review_incomplete", detail: "独立评审尚未同意发布，需给出具体原因" }], formatRepairs: repairs };
    if (data.verdict !== "pass") return issueOutcome("review_invalid", "评审 verdict 只能为 pass、revise 或 insufficient");
    if (!reviewCheckNames.every(key => checks[key] === true) || issues.length) return { pass: false, protocolFailure: true, issues: [...issues, { code: "review_inconsistent", detail: "评审声称通过，但检查项或问题清单没有通过" }], formatRepairs: repairs };
    for (const key of ["message", "question", "plan", "title", "sources", "quiz", "flashcards"]) if (data[key] !== undefined) return issueOutcome("review_edited_content", "评审不能用修改后的讲解替换实际受审原稿");
    if (data.decision !== undefined && data.teaching !== undefined && JSON.stringify(data.decision) !== JSON.stringify(data.teaching)) return issueOutcome("conflicting_decisions", "评审给出了冲突的两套教学判定");
    const decision = data.decision ?? data.teaching;
    if (data.decision === undefined && data.teaching !== undefined) repairs.push("将误命名的评审判定字段整理为 decision");
    const draft = composeDecision(request, content, decision, repairs);
    const policyIssues = checkTutorDraft(request, draft);
    return policyIssues.length ? { pass: false, protocolFailure: policyIssues.every(issue => Object.hasOwn(decisionIssueCodes, issue.code)), issues: policyIssues, formatRepairs: repairs } : { pass: true, protocolFailure: false, issues: [], draft, formatRepairs: repairs };
  } catch (error) {
    if (error instanceof LearningProtocolError) return { pass: false, protocolFailure: true, issues: error.issues, formatRepairs: repairs };
    throw error;
  }
}

/** Never leak private answer keys or an unapproved draft through HTTP error explanations. */
export function publicTeachingIssues(issues: TeachingIssue[]): TeachingIssue[] {
  return issues.map(issue => ({ code: issue.code, detail: issue.code.endsWith("answer_revealed") ? "本轮讲解或判定过早给出了未解出的结果，已拦截且未推进学习。" : issue.code.startsWith("review_") || issue.code.startsWith("conflicting_") ? "独立评审的结果或格式未通过检查，本轮草稿未发布。" : "本轮教学内容或理解证据尚未满足发布条件，未提交学习进度。" }));
}
