import type {
  AssessmentVerdict,
  ChatRequest,
  ChatResponse,
  EvidenceKind,
  Flashcard,
  LearnerIntent,
  LearningAssessment,
  LearningDetour,
  LearningEvidence,
  LearningMisconception,
  LearningQuestion,
  LearningState,
  LearningStep,
  MasteryLevel,
  QuestionKind,
  QuizQuestion,
  TeachingMove,
  TeachingNavigation,
  TeachingReceipt,
  TeachingSource,
} from "../src/types";
import { exposesProtectedAnswer, explicitlyRequestsSolution, matchesProtectedNumbers } from "./answers";
import { bindBookSources } from "./books";

export {
  LearningProtocolError,
  parseLearningState,
  parseQuestionContent,
  questionDraft,
  assessment,
  hasPriorReasoning,
  moves,
} from "../src/lib/learningState";
import {
  LearningProtocolError,
  parseLearningState,
  parseQuestionContent,
  questionDraft,
  assessment,
  hasPriorReasoning,
  moves,
} from "../src/lib/learningState";
export type { QuestionContent, QuestionDraft } from "../src/lib/learningState";
import type { QuestionContent, QuestionDraft } from "../src/lib/learningState";

export interface TeachingIssue {
  code: string;
  detail: string;
}

export interface TeachingDirective {
  intent: LearnerIntent;
  move: TeachingMove;
  focusStepId: string;
  assessment: LearningAssessment;
  navigation: TeachingNavigation;
  question: QuestionDraft | null;
  assumptions: string[];
  retractedAssumptions?: string[];
  misconception?: string;
  resolvedMisconceptionIds: string[];
}

export interface TutorDraft {
  message: string;
  title?: string;
  plan?: string[];
  quiz?: QuizQuestion[];
  flashcards?: Flashcard[];
  sources: TeachingSource[];
  teaching?: TeachingDirective;
}

const intents: LearnerIntent[] = [
  "answer",
  "uncertain",
  "challenge",
  "side_question",
  "topic_switch",
  "request_explanation",
  "continue",
];





const navigationKinds: TeachingNavigation["kind"][] = [
  "stay",
  "focus",
  "advance",
  "detour",
  "resume",
  "switch",
];
const coreActions: ChatRequest["action"][] = [
  "start",
  "message",
  "continue",
  "hint",
  "example",
  "resume",
];

function invalid(detail: string, code = "invalid_protocol"): never {
  throw new LearningProtocolError([{ code, detail }]);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 2000, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    invalid(`${name} 必须是${empty ? "" : "非空"}字符串，且不超过 ${max} 字符`);
  return value.trim();
}

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    invalid(`${name} 不在允许的范围内`);
  return value as T;
}

function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    invalid(`${name} 必须是数组，最多 ${max} 项`);
  return value;
}

function strings(
  value: unknown,
  name: string,
  max = 8,
  min = 0,
  itemMax = 1000,
): string[] {
  const result = list(value, name, max).map((item, index) =>
    text(item, `${name}[${index}]`, itemMax),
  );
  if (result.length < min) invalid(`${name} 至少需要 ${min} 项`);
  return result;
}

function parseQuiz(value: unknown): QuizQuestion[] {
  const items = list(value, "quiz", 5);
  if (items.length < 3) invalid("随堂练习需要 3–5 题");
  return items.map((item, index) => {
    const data = object(item, `quiz[${index}]`);
    const options = strings(data.options, "quiz.options", 8, 2, 1500);
    if (
      !Number.isInteger(data.correctIndex) ||
      (data.correctIndex as number) < 0 ||
      (data.correctIndex as number) >= options.length
    )
      invalid("练习答案下标越界");
    return {
      id: crypto.randomUUID(),
      question: text(data.question, "quiz.question", 2500),
      options,
      correctIndex: data.correctIndex as number,
      explanation: text(data.explanation, "quiz.explanation", 3000),
      hint: text(data.hint, "quiz.hint", 1500),
    };
  });
}

function parseCards(value: unknown): Flashcard[] {
  const items = list(value, "flashcards", 6);
  if (items.length < 3) invalid("记忆卡需要 3–6 张");
  return items.map((item) => {
    const data = object(item, "flashcard");
    return {
      id: crypto.randomUUID(),
      front: text(data.front, "flashcard.front", 2000),
      back: text(data.back, "flashcard.back", 3000),
    };
  });
}

export function parseTutorDraft(
  value: unknown,
  action: ChatRequest["action"],
): TutorDraft {
  const data = object(value, "AI 回答");
  if (
    data.suggestedReplies !== undefined &&
    (!Array.isArray(data.suggestedReplies) || data.suggestedReplies.length > 0)
  )
    invalid(
      "不要为学习者生成建议答案；原理与迁移必须由学习者自己作答，不能靠点击模型答案获得证据",
      "answer_in_suggestions",
    );
  const draft: TutorDraft = {
    message:
      data.message === undefined && action === "quiz"
        ? "做完这组练习，再看看哪些概念还需要巩固。"
        : data.message === undefined && action === "flashcards"
          ? "先尝试回忆，再翻面检查。"
          : text(data.message, "message", 24000),
    sources: list(data.sources ?? [], "sources", 8).map((item) => {
      const source = object(item, "source");
      return {
        name: text(source.name, "source.name", 300),
        quote: text(source.quote, "source.quote", 2400),
      };
    }),
  };
  if (data.title !== undefined) draft.title = text(data.title, "title", 200);
  if (data.plan !== undefined)
    draft.plan = strings(data.plan, "plan", 6, 3, 300);
  if (action === "quiz") draft.quiz = parseQuiz(data.quiz);
  if (action === "flashcards") draft.flashcards = parseCards(data.flashcards);
  if (data.teaching !== undefined) {
    const directive = object(data.teaching, "teaching");
    const navigation = object(directive.navigation, "navigation");
    draft.teaching = {
      intent: choice(directive.intent, intents, "teaching.intent"),
      move: choice(directive.move, moves, "teaching.move"),
      focusStepId: text(directive.focusStepId, "teaching.focusStepId", 150),
      assessment: assessment(directive.assessment),
      navigation: {
        kind: choice(navigation.kind, navigationKinds, "navigation.kind"),
        ...(navigation.targetStepId === undefined
          ? {}
          : {
              targetStepId: text(
                navigation.targetStepId,
                "navigation.targetStepId",
                150,
              ),
            }),
        ...(navigation.topic === undefined
          ? {}
          : { topic: text(navigation.topic, "navigation.topic", 500) }),
      },
      question:
        directive.question === null ? null : questionDraft(directive.question),
      assumptions: strings(
        directive.assumptions ?? [],
        "teaching.assumptions",
        15,
        0,
        1000,
      ),
      retractedAssumptions: strings(
        directive.retractedAssumptions ?? [],
        "teaching.retractedAssumptions",
        15,
        0,
        1000,
      ),
      resolvedMisconceptionIds: strings(
        directive.resolvedMisconceptionIds ?? [],
        "resolvedMisconceptionIds",
        20,
        0,
        150,
      ),
      ...(directive.misconception === undefined
        ? {}
        : {
            misconception: text(directive.misconception, "misconception", 1500),
          }),
    };
  }
  return draft;
}

/** A short "2" is grounded in the actual outstanding choices, never guessed from chat prose. */
export function resolveLearnerTurn(request: ChatRequest) {
  const state = request.learningState;
  const lastMessage = request.messages.at(-1);
  const latest = (request.action === "message" || request.action === "start") && lastMessage?.role === "user" ? lastMessage.content.trim() : "";
  const pending = state?.pendingQuestion ?? null;
  const normalized = latest.normalize("NFKC").trim();
  const token = normalized.match(/^(?:我(?:选择|选)?|选择|选|从)?\s*([1-9]|[A-Fa-f])(?:[.、)·\s，,]|吧|呢|[。！!？?]|$)/);
  const tokenIndex = token ? (/\d/.test(token[1]) ? Number(token[1]) - 1 : token[1].toUpperCase().charCodeAt(0) - 65) : -1;
  const optionText = pending?.options.map(option => option.normalize("NFKC").trim().replace(/[。.!！]+$/, "")) ?? [];
  const exactIndex = optionText.indexOf(normalized.replace(/[。.!！]+$/, ""));
  const index = tokenIndex >= 0 && tokenIndex < optionText.length ? tokenIndex : exactIndex;
  const choiceIndex = pending && index >= 0 && index < pending.options.length ? index : undefined;
  const justToken = /^(?:我(?:选择|选)?|选择|选|从)?\s*([1-9]|[A-Fa-f])\s*(?:吧|呢|这项|这个)?[。.!！\s]*$/.test(normalized);
  const justOption = choiceIndex !== undefined && (exactIndex === choiceIndex || (token !== null && optionText[choiceIndex] === normalized.slice(token[0].length).trim().replace(/[。.!！]+$/, "")));
  return { text: latest, pendingQuestion: pending, ...(choiceIndex === undefined ? {} : { choiceIndex, choiceText: pending!.options[choiceIndex] }), bareChoice: choiceIndex !== undefined && (justToken || justOption) };
}

function provenAfterAnswer(
  previous: MasteryLevel,
  previousEvidence: LearningEvidence[],
  question: LearningQuestion,
  result: LearningAssessment,
): MasteryLevel {
  if (result.verdict === "incorrect" || result.verdict === "partial")
    return "learning";
  if (result.verdict !== "correct") return previous;
  if (
    result.demonstrated === "transfer" &&
    question.kind === "transfer" &&
    hasPriorReasoning(previousEvidence, question.id, question.prompt)
  )
    return "applied";
  if (
    result.demonstrated === "reasoning" &&
    question.kind !== "orientation" &&
    question.kind !== "diagnostic"
  )
    return previous === "applied" ? "applied" : "understood";
  return previous === "new" ? "learning" : previous;
}

function hasRecordedEvidence(state: LearningState | undefined): boolean {
  return !!state && (
    state.steps.some((step) => step.evidence.length > 0) ||
    state.detours.some((detour) => detour.evidence.length > 0)
  );
}

function summaryClauseHasPositiveClaim(clause: string): boolean {
  const negativeClaim = /(?:未|尚未|还未|没有|无|无法|不能|不曾|不代表|不算|未能|并未|仍未)[^。\n！？!?]{0,80}(?:核验|验证|掌握|学会|完成|作答|解题|解出|证实)/;
  const futureClaim = /(?:将|要|会|打算|计划|争取|下一步|接着|继续|目标是?)[^。\n！？!?]{0,12}(?:核验|验证|掌握|学会|完成|作答|解题|解出|证实)/;
  const positiveClaim = /(?:已|已经|确实|独立|完成了|解出了|作答了|证实|已由)[^。\n！？!?]{0,12}(?:核验|验证|掌握|学会|完成|作答|解题|解出|证实)/;
  const heading = clause.replace(/[\s*#_`]/g, "");
  const emptyHeading = /^(?:学习者)?(?:已|已经)?(?:独立)?(?:核验|验证|掌握|学会)(?:的(?:部分|内容|项目))?$/;
  return !emptyHeading.test(heading) && !negativeClaim.test(clause) && !futureClaim.test(clause) && positiveClaim.test(clause);
}

function summaryHasPositiveEvidenceClaim(message: string): boolean {
  const subject = /(?:你|学习者|本轮作答|这道题|该回答|独立表现)/;
  return message
    .normalize("NFKC")
    .split(/[。\n！？!?；;]/)
    .some((clause) => subject.test(clause) && summaryClauseHasPositiveClaim(clause));
}

function summaryHasUnverifiedStepClaim(message: string, state: LearningState | undefined): string | undefined {
  if (!state) return undefined;
  const targets = [
    ...state.steps.map((step) => ({ title: step.title, verified: ["understood", "applied"].includes(step.mastery) })),
    ...state.detours.map((detour) => ({ title: detour.topic, verified: ["understood", "applied"].includes(detour.mastery) })),
  ];
  const clauses = message.normalize("NFKC").split(/[。\n！？!?；;]/);
  for (const clause of clauses) {
    const normalizedClause = clause.replace(/\s+/g, "");
    if (!summaryClauseHasPositiveClaim(clause)) continue;
    const target = targets.find((item) => !item.verified && normalizedClause.includes(item.title.normalize("NFKC").replace(/\s+/g, "")));
    if (target) return target.title;
  }
  return undefined;
}

/** Deterministic floor. Semantic responsiveness and factual calibration are reviewed separately. */
export function checkTutorDraft(
  request: ChatRequest,
  draft: TutorDraft,
): TeachingIssue[] {
  const state = parseLearningState(request.learningState);
  const issues: TeachingIssue[] = [];
  const issue = (code: string, detail: string) => issues.push({ code, detail });
  if (request.webSearch && request.references?.some((reference) => reference.url) && !draft.sources.length) {
    issue("web_source_required", "本轮使用了自动联网搜索证据，讲解至少需要引用一条抓取网页的逐字原文；没有引文就不能把网页搜索当成依据");
  }
  if (request.bookContext && !draft.sources.length) issue("book_source_required", "书籍陪读需要至少一条本轮原文的逐字引文，不能以模型常识冒充书中内容");
  for (const source of draft.sources) {
    if (
      !request.references?.some(
        (reference) =>
          reference.name === source.name &&
          reference.text.includes(source.quote),
      )
    )
      issue(
        "fabricated_source",
        "引文必须逐字来自本次提供的同名材料，不能伪造来源或把材料当成已核验法规",
      );
  }
  if (!coreActions.includes(request.action)) {
    if (
      draft.teaching &&
      (draft.teaching.navigation.kind !== "stay" ||
        draft.teaching.assessment.verdict !== "not_assessed" ||
        draft.teaching.question !== null ||
        draft.teaching.resolvedMisconceptionIds.length > 0 ||
        (draft.teaching.retractedAssumptions?.length ?? 0) > 0 ||
        draft.teaching.misconception)
    )
      issue(
        "tool_changed_progress",
        "生成练习、卡片和复盘不能代替学习者作答、清除误区或擅自改变主线",
      );
    if (request.action === "summary") {
      const unverifiedStep = summaryHasUnverifiedStepClaim(draft.message, state);
      if (unverifiedStep || (!hasRecordedEvidence(state) && summaryHasPositiveEvidenceClaim(draft.message)))
        issue(
          "unverified_summary_claim",
          unverifiedStep
            ? `步骤《${unverifiedStep}》没有独立理解证据，复盘不能声称已经核验或掌握；请明确标记为未核验`
            : "当前学习状态没有独立理解证据，复盘不能声称学习者已经核验或掌握；请明确标记为未核验",
        );
    }
    return issues;
  }
  const directive = draft.teaching;
  if (!directive)
    return [
      ...issues,
      {
        code: "missing_teaching",
        detail: "缺少教学决策、学习者理解判断和下一步问题",
      },
    ];
  const initial = !state;
  const switching = directive.navigation.kind === "switch";
  const restoredTrack = switching
    ? state?.savedTracks.find(
        (track) => track.goal === directive.navigation.topic,
      )
    : undefined;
  if ((initial || switching) && !restoredTrack && !draft.plan)
    issue(
      "missing_roadmap",
      "首次建立主线或明确换主题时必须给出 3–6 步的真实学习路线",
    );
  const stepIds = new Set(
    restoredTrack
      ? restoredTrack.steps.map((step) => step.id)
      : ((initial || switching
          ? draft.plan?.map((_, index) => `step-${index + 1}`)
          : state.steps.map((step) => step.id)) ?? []),
  );
  if (
    restoredTrack &&
    (directive.focusStepId !== restoredTrack.currentStepId ||
      (directive.question &&
        restoredTrack.pendingQuestion &&
        directive.question.prompt !== restoredTrack.pendingQuestion.prompt) ||
      (draft.plan &&
        JSON.stringify(draft.plan) !==
          JSON.stringify(restoredTrack.steps.map((step) => step.title))))
  )
    issue(
      "lost_saved_track",
      "回到之前的主题时必须恢复已保存路线、理解证据和待答问题",
    );
  if (!stepIds.has(directive.focusStepId))
    issue("unknown_focus", "讲解引用了路线中不存在的步骤");
  if (
    state &&
    !switching &&
    draft.plan &&
    JSON.stringify(draft.plan) !==
      JSON.stringify(state.steps.map((step) => step.title))
  )
    issue(
      "unrequested_roadmap_change",
      "不能在普通答题或补课时偷偷替换原学习路线",
    );
  if (
    directive.question &&
    (!stepIds.has(directive.question.stepId) ||
      directive.question.stepId !== directive.focusStepId)
  )
    issue("wrong_question_focus", "追问必须针对当前讲解的概念");
  if (directive.question && draft.message.includes(directive.question.prompt))
    issue(
      "duplicated_question",
      "讲解正文与结构化追问重复；正文只讲解，追问单独提供",
    );
  if (
    directive.question &&
    /^(?:你|现在|你现在)?(?:明白了吗|懂了吗|理解了吗|还有问题吗|怎么看|觉得呢)$/.test(
      directive.question.prompt.replace(/[\s？?。.!！]/g, ""),
    )
  )
    issue(
      "generic_probe",
      "理解检查需要具体可作答的问题，不能只问是否明白或泛泛感想",
    );
  if (
    ["orient", "probe", "transfer"].includes(directive.move) &&
    !directive.question &&
    !restoredTrack?.pendingQuestion
  )
    issue(
      "missing_probe",
      "引导、理解检查或迁移训练必须有一个具体、可作答的问题",
    );
  const learner = resolveLearnerTurn(request);
  const result = directive.assessment;
  const explicitSideQuestion =
    !!state?.pendingQuestion &&
    /(?:顺便(?:问|说|提)|另外(?:问|想|提)|插一句|多问一句|题外话)/.test(learner.text);
  if (
    explicitSideQuestion &&
    (directive.intent !== "side_question" || directive.navigation.kind !== "detour")
  )
    issue(
      "side_question_required",
      "明确提出的题外问题必须按 side_question 处理并保存主线返回点；不能当成普通主线回答或直接覆盖原题",
    );
  const publicFields = [draft.message, ...directive.assumptions, ...draft.sources.map(source => source.quote), ...(directive.question ? [directive.question.prompt, ...directive.question.options] : [])];
  const reviewFields = [result.feedback, directive.misconception ?? ""];
  // resume 时当前 pending 可能是插问，原返回题仍在 detour 中；两者都要保护。
  const protectedPendings = [
    ...(state?.pendingQuestion ? [state.pendingQuestion] : []),
    ...(directive.navigation.kind === "resume" && state?.detours.at(-1)?.returnQuestion
      ? [state.detours.at(-1)!.returnQuestion!]
      : []),
  ].filter((pending, index, all) => all.findIndex((item) => item.id === pending.id) === index);
  for (const protectedPending of protectedPendings) {
    const answeredCurrent = state?.pendingQuestion?.id === protectedPending.id && result.verdict === "correct";
    if (answeredCurrent || explicitlyRequestsSolution(learner.text)) continue;
    if (exposesProtectedAnswer(protectedPending, learner.text, publicFields)) issue("answer_revealed", "公开讲解提前出现了学习者尚未解出的最终结果；请只提示缺失机制或中间步骤，不要公布答案");
    if (exposesProtectedAnswer(protectedPending, learner.text, reviewFields)) issue("review_answer_revealed", "评审反馈或误区说明提前给出了未解出的结果；只修正判定说明，不改写已经合格的讲解");
  }
  if (directive.question) {
    if (exposesProtectedAnswer(directive.question, learner.text, publicFields)) issue("new_answer_revealed", "新问题的结果已经出现在讲解中，不能把照抄结果当成迁移训练；请换一个未被解出的情境");
    if (exposesProtectedAnswer(directive.question, learner.text, reviewFields)) issue("review_new_answer_revealed", "评审反馈提前给出了新问题的结果，不能把照抄当成独立核验");
  }
  const graded = ["correct", "partial", "incorrect"].includes(result.verdict);
  const numericMatch = state?.pendingQuestion ? matchesProtectedNumbers(state.pendingQuestion, learner.text) : undefined;
  if (
    graded &&
    numericMatch === false &&
    (result.verdict === "correct" || ["reasoning", "transfer"].includes(result.demonstrated))
  )
    issue(
      "numeric_mismatch",
      "计算题的最终数值与私有答案不一致，不能判为正确，也不能记为推理或迁移证据；只可保留为需重算的辨认或错误",
    );
  if (
    request.action === "continue" &&
    (directive.intent !== "continue" ||
      result.verdict !== "not_assessed" ||
      result.demonstrated !== "none" ||
      result.evidenceQuote !== "" ||
      result.questionId !== null ||
      directive.resolvedMisconceptionIds.length > 0 ||
      !["stay", "advance"].includes(directive.navigation.kind))
  )
    issue(
      "tool_is_not_evidence",
      "请导师安排下一步不是新作答：只能继续当前点或相邻授课，不认证旧回答、不清误区或擅自换主线",
    );
  if (graded && explicitlyRequestsSolution(learner.text)) issue("requested_solution_not_evidence", "明确索要完整答案的回合不认证为独立掌握；可完整讲解，但不能将请求本身记作作答证据");
  if (
    result.evidenceQuote &&
    (!learner.text || !learner.text.includes(result.evidenceQuote))
  )
    issue(
      "fabricated_evidence",
      "理解判断必须引用学习者本轮真实回答，不能引用模型自己的话或前轮回答",
    );
  if (
    graded &&
    (!state?.pendingQuestion ||
      result.questionId !== state.pendingQuestion.id ||
      !result.evidenceQuote ||
      directive.intent !== "answer" ||
      request.action !== "message")
  )
    issue(
      "ungrounded_assessment",
      "只有针对待答问题的本轮真实作答，才可以判对错并积累理解证据",
    );
  if (
    directive.intent === "uncertain" &&
    (graded ||
      result.demonstrated !== "none" ||
      !["explain", "hint", "repair", "clarify"].includes(directive.move) ||
      directive.navigation.kind !== "stay")
  )
    issue(
      "uncertainty_misgraded",
      "明确不会或缺基础时应停留补课，不得夸答对或继续推进",
    );
  if (
    directive.intent === "challenge" &&
    (graded ||
      !["clarify", "repair", "explain", "answer"].includes(directive.move) ||
      directive.navigation.kind !== "stay")
  )
    issue(
      "challenge_ignored",
      "质疑需要停下来检查前提并回应，不可按普通答题夸赞后跳过",
    );
  if (!graded && result.demonstrated !== "none")
    issue(
      "unproven_understanding",
      "没有通过真实作答核验，不能标记已解释或已迁移",
    );
  if (state?.pendingQuestion?.kind === "orientation" && graded)
    issue(
      "preference_is_not_knowledge",
      "选择学习方向不是知识题，不能据此宣告掌握",
    );
  if (
    learner.bareChoice &&
    graded &&
    ["reasoning", "transfer"].includes(result.demonstrated)
  )
    issue(
      "choice_is_not_reasoning",
      "只选中一个选项不能当成解释原理或迁移应用",
    );
  const pendingForTransfer = state?.pendingQuestion;
  const pendingText = pendingForTransfer?.prompt
    .normalize("NFKC")
    .replace(/\s+/g, "");
  const repeatedMistake =
    !!pendingForTransfer &&
    state?.misconceptions.some(
      (entry) =>
        entry.stepId === pendingForTransfer.stepId &&
        entry.scope === pendingForTransfer.scope &&
        entry.question !== undefined &&
        entry.question.normalize("NFKC").replace(/\s+/g, "") === pendingText,
    );
  if (
    result.demonstrated === "transfer" &&
    (pendingForTransfer?.kind !== "transfer" || repeatedMistake)
  )
    issue(
      "not_a_transfer_probe",
      "普通复述、原题重答或选择题不构成独立迁移核验",
    );
  if (
    (result.verdict === "incorrect" || result.verdict === "partial") &&
    (!["repair", "hint", "explain", "clarify"].includes(directive.move) ||
      directive.navigation.kind === "advance" ||
      !directive.question)
  )
    issue(
      "mistake_not_repaired",
      "答错或部分正确应定位误区、换解释并继续检查，而不是直接推进",
    );
  if (
    (result.verdict === "incorrect" || result.verdict === "partial") &&
    !directive.misconception
  )
    issue(
      "missing_misconception",
      "错误或部分正确必须记录本轮具体误区，以便后续针对性核验",
    );
  if (
    (request.action === "hint" || request.action === "example") &&
    (graded || directive.navigation.kind !== "stay")
  )
    issue(
      "tool_is_not_evidence",
      "点击提示或例子不是学习者作答，不能增加掌握证据或切换主线",
    );
  if (
    directive.misconception &&
    (!graded || !["incorrect", "partial"].includes(result.verdict))
  )
    issue(
      "invented_misconception",
      "误区记录必须有本轮错误或部分正确回答作为依据",
    );
  const navigation = directive.navigation;
  if (
    navigation.kind === "advance" &&
    (!state ||
      (!learner.text && request.action !== "continue") ||
      !["answer", "continue"].includes(directive.intent))
  )
    issue(
      "premature_advance",
      "没有本轮真实作答或明确继续的意图时不能跳去下一概念",
    );
  if (
    directive.intent === "side_question" &&
    !["stay", "detour"].includes(navigation.kind)
  )
    issue(
      "side_question_ignored",
      "临时插问必须先回应，不能借机推进或丢掉主线",
    );
  if (
    directive.intent === "side_question" &&
    state &&
    directive.question &&
    navigation.kind !== "detour"
  )
    issue(
      "missing_return_point",
      "插问引入新的理解检查前必须保存当前主线返回点",
    );
  if (
    directive.intent === "topic_switch" &&
    state &&
    !["switch", "focus"].includes(navigation.kind)
  )
    issue(
      "topic_switch_not_applied",
      "学习者明确换目标时，应真正切换并保存原轨迹，不能只改讲解文字",
    );
  const retracted = directive.retractedAssumptions ?? [];
  if (
    retracted.some(
      (item) =>
        !state?.assumptions.includes(item) ||
        directive.assumptions.includes(item),
    )
  )
    issue(
      "invalid_assumption_retraction",
      "只能明确撤回已记录的前提，不能同时撤回并重新采用同一个前提",
    );
  if (retracted.length && navigation.kind === "advance")
    issue(
      "premature_advance",
      "教学前提被修正后需重新核验当前概念，不能沿用旧证据直接推进",
    );
  if (retracted.length && directive.resolvedMisconceptionIds.length)
    issue(
      "unverified_repair",
      "教学前提刚被修正时，不能同时用旧问题清除误区；需要新的独立核验",
    );
  if (navigation.kind === "focus" && state?.detours.length)
    issue(
      "focus_during_detour",
      "补课中的明确换方向应保存整条原轨迹，不能让补课返回点与新章节错位",
    );
  if (
    (navigation.kind === "focus" || navigation.kind === "advance") &&
    (!navigation.targetStepId || !stepIds.has(navigation.targetStepId))
  )
    issue("unknown_destination", "导航目标必须是学习路线中的有效步骤");
  if (
    (navigation.kind === "focus" || navigation.kind === "advance") &&
    navigation.targetStepId !== directive.focusStepId
  )
    issue(
      "navigation_focus_mismatch",
      "导航后的讲解和追问必须对应实际目标步骤",
    );
  if (
    state &&
    ["stay", "detour", "resume"].includes(navigation.kind) &&
    directive.focusStepId !== state.currentStepId
  )
    issue("silent_topic_jump", "保持主线或插问时不能偷换正在学习的步骤");
  if (navigation.kind === "advance" && state) {
    const currentIndex = state.steps.findIndex(step => step.id === state.currentStepId);
    const current = state.steps[currentIndex];
    const pending = state.pendingQuestion;
    const level = pending && pending.scope === "main" && graded ? provenAfterAnswer(current.mastery, current.evidence, pending, result) : current.mastery;
    const correctRecognition = pending?.scope === "main" && pending.kind !== "orientation" && result.verdict === "correct" && result.demonstrated === "recognition";
    const askedToContinue = directive.intent === "continue" && (request.action === "continue" || /^(?:好的?|行|可以|那|请)?[，,\s]*(?:继续|接着讲|接着说|往下讲)[吧。!！\s]*$/.test(learner.text) || /下一(?:步|节|题|个概念|部分)|继续往后|先跳过|往后讲|\b(?:continue|next)\b/i.test(learner.text));
    if (state.detours.length || (!["understood", "applied"].includes(level) && !correctRecognition && !askedToContinue)) issue("premature_advance", "尚未回应当前困难，不能把它当作已学会后推进；用户可明确选择先继续，但不会获得掌握认证");
    if (request.action === "continue" && (["uncertain", "incorrect", "partial"].includes(state.lastAssessment?.verdict ?? "") || state.misconceptions.some(entry => entry.stepId === state.currentStepId && entry.scope === "main" && entry.status !== "resolved")))
      issue("premature_advance", "导师安排下一步时应先处理当前困难或未修复误区，不能擅自把继续听课当成主动跳过");
    if (state.steps[currentIndex + 1]?.id !== navigation.targetStepId) issue("advance_skipped_step", "一次只推进相邻的一个概念；明确跳到其它主题应使用用户选择的focus或switch");
  }
  if (
    navigation.kind === "focus" &&
    state &&
    directive.intent !== "topic_switch" &&
    !(
      learner.pendingQuestion?.kind === "orientation" &&
      directive.intent === "answer"
    )
  )
    issue(
      "unrequested_focus",
      "跳到其它章节需要学习者明确选择，不能绕开当前疑问",
    );
  if (
    navigation.kind === "switch" &&
    (directive.intent !== "topic_switch" || !navigation.topic)
  )
    issue(
      "unrequested_topic_switch",
      "只有学习者明确改变学习目标时才能重排路线，旧主题要保留待学",
    );
  if (
    navigation.kind === "detour" &&
    (!state ||
      !navigation.topic ||
      state.detours.length >= 5 ||
      directive.intent !== "side_question")
  )
    issue(
      "invalid_detour",
      "临时插问需要保存主线返回点，不能把整次换题或普通错误伪装成插问",
    );
  if (navigation.kind === "resume") {
    const detour = state?.detours.at(-1);
    if (!detour)
      issue(
        "missing_return_point",
        "没有已保存的主线返回点，不能声称回到原问题",
      );
    else {
      const pending = state?.pendingQuestion;
      const level =
        pending?.scope === "detour" && graded
          ? provenAfterAnswer(detour.mastery, detour.evidence, pending, result)
          : detour.mastery;
      if (
        request.action !== "resume" &&
        directive.intent !== "continue" &&
        !["understood", "applied"].includes(level)
      )
        issue(
          "detour_unresolved",
          "补课还未理解时不能擅自拉回原问题；学习者主动要求返回除外",
        );
      if (
        directive.question &&
        detour.returnQuestion &&
        directive.question.prompt !== detour.returnQuestion.prompt
      )
        issue(
          "lost_return_question",
          "返回主线必须恢复之前保存的问题，而非悄悄改问另一个问题",
        );
    }
  }
  if (request.action === "resume" && navigation.kind !== "resume")
    issue("resume_not_honored", "学习者请求回主线时应恢复保存的返回点");
  for (const id of directive.resolvedMisconceptionIds) {
    const entry = state?.misconceptions.find((item) => item.id === id);
    const pending = state?.pendingQuestion;
    const topic =
      pending?.scope === "detour"
        ? state?.detours.at(-1)?.topic
        : state?.steps.find((step) => step.id === pending?.stepId)?.title;
    const priorEvidence =
      pending?.scope === "detour"
        ? state?.detours.at(-1)?.evidence
        : state?.steps.find((step) => step.id === pending?.stepId)?.evidence;
    if (
      !entry ||
      !pending ||
      result.verdict !== "correct" ||
      result.demonstrated !== "transfer" ||
      pending.kind !== "transfer" ||
      pending.id === entry.questionId ||
      (entry.question !== undefined &&
        pending.prompt.normalize("NFKC").replace(/\s+/g, "") ===
          entry.question.normalize("NFKC").replace(/\s+/g, "")) ||
      pending.stepId !== entry.stepId ||
      pending.scope !== entry.scope ||
      topic !== entry.topic ||
      !hasPriorReasoning(priorEvidence ?? [], pending.id, pending.prompt)
    )
      issue(
        "unverified_repair",
        "误区只有在同一概念的另一个迁移问题中核验且已有解释证据后才能消除，听过解释不算已纠正",
      );
  }
  return issues;
}

function newState(request: ChatRequest, draft: TutorDraft): LearningState {
  if (!draft.plan) invalid("缺少学习路线", "missing_roadmap");
  return {
    version: 1,
    revision: 0,
    goal:
      draft.teaching?.navigation.kind === "switch"
        ? draft.teaching.navigation.topic!
        : request.goal || request.topic,
    steps: draft.plan.map((title, index) => ({
      id: `step-${index + 1}`,
      title,
      mastery: "new",
      evidence: [],
    })),
    currentStepId: draft.teaching?.focusStepId ?? "step-1",
    pendingQuestion: null,
    detours: [],
    misconceptions: [],
    deferredTopics: [],
    savedTracks: [],
    assumptions: [],
    lastAssessment: null,
    lastMove: null,
  };
}

function recordAnswer(
  target: { mastery: MasteryLevel; evidence: LearningEvidence[] },
  pending: LearningQuestion,
  result: LearningAssessment,
  turn: number,
) {
  const previousEvidence = target.evidence;
  target.mastery = provenAfterAnswer(
    target.mastery,
    previousEvidence,
    pending,
    result,
  );
  if (result.verdict === "correct" && result.demonstrated !== "none") {
    const previousIndex = previousEvidence.findIndex(
      (item) => item.questionId === pending.id && item.kind === result.demonstrated,
    );
    const evidence: LearningEvidence = {
      quote: result.evidenceQuote,
      questionId: pending.id,
      question: pending.prompt,
      kind: result.demonstrated,
      turn,
    };
    if (previousIndex === -1 && previousEvidence.length >= 200)
      invalid("单个主题证据已达容量上限，请导出并开启新学习", "state_capacity");
    // 同题同类型只保留一条：同级的新真实作答可更新，但弱证据不能覆盖强证据。
    // 推理与迁移是不同证据，二者都保留；升级后 applied 校验仍能查到已有推理。
    const strength: Record<EvidenceKind, number> = { recognition: 0, reasoning: 1, transfer: 2 };
    const weaker = result.demonstrated === "recognition"
      ? previousEvidence.some(item => item.questionId === pending.id && strength[item.kind] > 0)
      : result.demonstrated === "reasoning" &&
        previousEvidence.some(item => item.questionId === pending.id && item.kind === "transfer");
    target.evidence = weaker
      ? previousEvidence
      : previousIndex === -1
        ? [...previousEvidence, evidence]
        : previousEvidence.map((item, index) =>
            index === previousIndex ? evidence : item,
          );
  }
}

/** Called only after the semantic reviewer passes; progress remains server-computed. */
export function applyTutorDraft(
  request: ChatRequest,
  draft: TutorDraft,
  review: { repaired: boolean; modelCalls: number; formatRepairs?: string[]; reviewAttempts?: number },
): ChatResponse {
  const existing = parseLearningState(request.learningState);
  const returnQuestion = draft.teaching?.navigation.kind === "resume"
    ? existing?.detours.at(-1)?.returnQuestion
    : null;
  if (returnQuestion && draft.teaching) {
    // 返回点是服务端保存的结构化事实，不能由模型在 resume 时悄悄换题。
    draft = {
      ...draft,
      teaching: {
        ...draft.teaching,
        question: {
          stepId: existing!.currentStepId,
          prompt: returnQuestion.prompt,
          kind: returnQuestion.kind,
          options: returnQuestion.options,
          successCriteria: returnQuestion.successCriteria,
          ...(returnQuestion.protectedAnswers ? { protectedAnswers: returnQuestion.protectedAnswers } : {}),
        },
      },
    };
  }
  const issues = checkTutorDraft(request, draft);
  if (issues.length) throw new LearningProtocolError(issues);
  draft = { ...draft, sources: bindBookSources(draft.sources, request.references) };
  let state = existing ? structuredClone(existing) : undefined;
  let receipt: TeachingReceipt | undefined;
  let visibleQuestion: LearningQuestion | null = null;
  const directive = draft.teaching;
  if (coreActions.includes(request.action) && directive) {
    if (!state) state = newState(request, draft);
    state.revision += 1;
    const previousPending = state.pendingQuestion;
    const result = directive.assessment;
    const graded = ["correct", "partial", "incorrect"].includes(result.verdict);
    if (previousPending && graded) {
      const target =
        previousPending.scope === "detour"
          ? state.detours.at(-1)
          : state.steps.find((step) => step.id === previousPending.stepId);
      if (target) recordAnswer(target, previousPending, result, state.revision);
      if (directive.misconception) {
        const topic =
          previousPending.scope === "detour"
            ? state.detours.at(-1)!.topic
            : state.steps.find((step) => step.id === previousPending.stepId)!
                .title;
        const match = state.misconceptions.find(
          (item) =>
            item.stepId === previousPending.stepId &&
            item.scope === previousPending.scope &&
            item.topic === topic &&
            item.description === directive.misconception &&
            item.status !== "resolved",
        );
        if (match) {
          match.status = "repairing";
          match.evidenceQuote = result.evidenceQuote;
        } else {
          if (state.misconceptions.length >= 100)
            invalid(
              "待巩固记录已达容量上限，请导出并开启新学习",
              "state_capacity",
            );
          state.misconceptions.push({
            id: crypto.randomUUID(),
            stepId: previousPending.stepId,
            questionId: previousPending.id,
            question: previousPending.prompt,
            scope: previousPending.scope,
            topic,
            description: directive.misconception,
            evidenceQuote: result.evidenceQuote,
            status: "repairing",
          });
        }
      }
    }
    if (directive.intent === "uncertain" && previousPending) {
      const target =
        previousPending.scope === "detour"
          ? state.detours.at(-1)
          : state.steps.find((step) => step.id === previousPending.stepId);
      if (target) target.mastery = "learning";
    }
    const retracted = directive.retractedAssumptions ?? [];
    if (retracted.length) {
      state.assumptions = state.assumptions.filter(
        (item) => !retracted.includes(item),
      );
      const currentStepId = state.currentStepId;
      const target =
        state.detours.at(-1) ??
        state.steps.find((step) => step.id === currentStepId);
      if (target) {
        target.mastery = "learning";
        target.evidence = [];
      }
    }
    for (const id of directive.resolvedMisconceptionIds) {
      const entry = state.misconceptions.find((item) => item.id === id);
      if (entry) entry.status = "resolved";
    }
    const navigation = directive.navigation;
    let restoredSavedTrack = false;
    if (navigation.kind === "switch") {
      const deferred = [
        ...state.deferredTopics,
        state.goal,
        ...state.steps
          .filter((step) => step.mastery !== "applied")
          .map((step) => step.title),
      ];
      const revision = state.revision;
      const saved = state.savedTracks.find(
        (track) => track.goal === navigation.topic,
      );
      const leaving = {
        goal: state.goal,
        steps: state.steps,
        currentStepId: state.currentStepId,
        pendingQuestion: state.pendingQuestion,
        detours: state.detours,
        misconceptions: state.misconceptions,
        assumptions: state.assumptions,
      };
      const tracks = [
        ...state.savedTracks.filter(
          (track) =>
            track.goal !== navigation.topic && track.goal !== leaving.goal,
        ),
        ...(state.goal !== navigation.topic ? [leaving] : []),
      ];
      if (tracks.length > 8)
        invalid("已保存主线过多，请导出并按专题开启新会话", "state_capacity");
      state = saved ? { ...state, ...saved } : newState(request, draft);
      state.revision = revision;
      state.savedTracks = tracks;
      const activeTitles = new Set([
        state.goal,
        ...state.steps.map((step) => step.title),
      ]);
      state.deferredTopics = [...new Set(deferred)].filter(
        (topic) => !activeTitles.has(topic),
      );
      if (state.deferredTopics.length > 50)
        invalid("待学主题过多，请拆分为新的学习会话", "state_capacity");
      restoredSavedTrack = !!saved;
      if (saved) {
        if (!state.pendingQuestion && directive.question)
          state.pendingQuestion = {
            ...directive.question,
            id: crypto.randomUUID(),
            scope: state.detours.length ? "detour" : "main",
          };
        visibleQuestion = state.pendingQuestion;
      }
    } else if (navigation.kind === "detour") {
      state.detours.push({
        topic: navigation.topic!,
        returnStepId: state.currentStepId,
        returnQuestion: previousPending,
        mastery: "learning",
        evidence: [],
      });
    } else if (navigation.kind === "resume") {
      const frame = state.detours.pop()!;
      state.currentStepId = frame.returnStepId;
      state.pendingQuestion =
        frame.returnQuestion ??
        (directive.question
          ? {
              ...directive.question,
              id: crypto.randomUUID(),
              scope: state.detours.length ? "detour" : "main",
            }
          : null);
      visibleQuestion = state.pendingQuestion;
    } else if (navigation.kind === "focus" || navigation.kind === "advance") {
      state.currentStepId = navigation.targetStepId!;
    }
    if (navigation.kind !== "resume" && !restoredSavedTrack) {
      if (directive.question) {
        state.pendingQuestion = {
          ...directive.question,
          id: crypto.randomUUID(),
          scope: state.detours.length ? "detour" : "main",
        };
        visibleQuestion = state.pendingQuestion;
      } else if (graded || navigation.kind !== "stay")
        state.pendingQuestion = null;
    }
    const current = state.steps.find(
      (step) => step.id === state!.currentStepId,
    )!;
    if (current.mastery === "new" && !state.detours.length)
      current.mastery = "learning";
    state.assumptions = [
      ...new Set([...state.assumptions, ...directive.assumptions]),
    ];
    if (state.assumptions.length > 30)
      invalid("业务前提记录过多，请整理资料后开启新主题", "state_capacity");
    state.lastAssessment = result;
    state.lastMove = directive.move;
    receipt = {
      intent: directive.intent,
      move: directive.move,
      focusTitle: state.detours.at(-1)?.topic ?? current.title,
      assessment: result,
      navigation,
      assumptions: directive.assumptions,
      retractedAssumptions: directive.retractedAssumptions ?? [],
      sources: draft.sources,
    };
    // Re-validate computed state as an invariant boundary, not a model's self-report.
    parseLearningState(state);
  }
  if (!receipt && request.bookContext) {
    receipt = {
      intent: "continue", move: "recap", focusTitle: request.bookContext.chapterTitle ?? request.bookContext.title,
      assessment: { verdict: "not_assessed", evidenceQuote: "", questionId: null, demonstrated: "none", feedback: "本轮工具产物只整理所供原文，不增加独立作答证据。" },
      navigation: { kind: "stay" }, assumptions: [], sources: draft.sources,
    };
  }
  let message = draft.message;
  if (visibleQuestion) {
    message += `\n\n**想一想**\n\n${visibleQuestion.prompt}`;
    if (visibleQuestion.options.length)
      message +=
        "\n\n" +
        visibleQuestion.options
          .map((option, index) => `${index + 1}. ${option}`)
          .join("\n");
  }
  return {
    message,
    ...(draft.title ? { title: draft.title } : {}),
    ...(state
      ? { learningState: state, plan: state.steps.map((step) => step.title) }
      : {}),
    ...(draft.quiz ? { quiz: draft.quiz } : {}),
    ...(draft.flashcards ? { flashcards: draft.flashcards } : {}),
    ...(receipt ? { teaching: receipt } : {}),
    quality: {
      checked: true,
      repaired: review.repaired,
      modelCalls: review.modelCalls,
      ...(review.formatRepairs?.length ? { formatRepairs: review.formatRepairs } : {}),
      ...(review.reviewAttempts === undefined ? {} : { reviewAttempts: review.reviewAttempts }),
      grounding: draft.sources.length ? "provided_material" : "model_knowledge",
      limitations: [
        "教学流程检查不等于事实认证；材料引文也不等于权威或最新结论。",
        "涉及产品条款、监管时效或其它高风险事实，请核对可靠来源。",
      ],
    },
  };
}
