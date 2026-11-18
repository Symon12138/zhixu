import type { ChatRequest, ChatResponse, DiagnosticProfile, ProviderSettings, QuizQuestion } from "../src/types";
import { ApiError, chatCompletion } from "./ai";

/** 学习前诊断固定 3 题；底层 quiz 工具允许 3–5 题，这里只取前 3 题。 */
export const DIAGNOSTIC_QUESTION_COUNT = 3;

/**
 * 严格按模型给出的顺序取前 count 题：不随机、不重排、不改写题面或 correctIndex，
 * 以免诊断的正确项与解析错位。count 缺省为固定 3 题；带先验探测目标时按目标数收缩。
 */
export function selectDiagnosticQuestions(quiz: QuizQuestion[], count = DIAGNOSTIC_QUESTION_COUNT): QuizQuestion[] {
  return quiz.slice(0, count);
}

/**
 * 生成学习前诊断。
 * - 无先验目标：固定 3 题，覆盖必要前置、核心机制、情境应用；
 * - 带先验目标（来自知识图谱里“已理解为前置、尚未应用”的命题）：
 *   生成 min(3, 目标数) 题，逐题对应一条目标，并回传 questionId → 命题映射。
 * 答对只表示“可跳过该前置”，仍需独立推理核验，不能据此认证掌握。
 */
export async function generateDiagnostic(
  topic: string,
  level: string,
  goal: string,
  settings?: ProviderSettings,
  signal?: AbortSignal,
  probeTargets?: string[],
): Promise<{
  diagnostic: Omit<DiagnosticProfile, "id" | "answers" | "submitted" | "evaluatedAt" | "recommendedStepIndex" | "evidenceSummary" | "weakConcepts" | "skippedConcepts" | "confidence" | "highConfidenceErrors" | "confidenceRecorded">;
  quality: ChatResponse["quality"];
}> {
  if (!topic.trim()) throw new ApiError(400, "请先填写诊断主题。");
  const targets = (probeTargets ?? []).map((item) => item.trim()).filter(Boolean).slice(0, DIAGNOSTIC_QUESTION_COUNT);
  const count = targets.length > 0 ? targets.length : DIAGNOSTIC_QUESTION_COUNT;
  const instruction = targets.length > 0
    ? `为零基础或已有基础学习者设计恰好${count}道学习前探测选择题，只用于判断是否已具备下列前置概念，不用于认证已经掌握。\n需要逐个探测的前置命题（顺序对应题目顺序，一题只测一条）：\n${targets.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
    : `为零基础或已有基础学习者设计恰好${count}道学习前诊断选择题，用于安排起点，不用于认证已经掌握。覆盖：一个必要前置概念、一个核心机制、一个不同情境的初步应用。`;
  const request: ChatRequest = {
    topic: `学习前诊断：${topic}`,
    level,
    goal,
    action: "quiz",
    messages: [{
      role: "user",
      content: `${instruction}\n每题选项2-4个，提供正确答案、提示与解析；题面不得直接写出答案，也不要暗示结论。不要假定学习者自评能力。主题：${topic}。期望能力：${goal || level}。`,
    }],
    settings,
  };
  const result = await chatCompletion(request, { signal });
  if (!result.quiz || result.quiz.length < count) {
    throw new ApiError(502, "诊断题未生成，请重试。");
  }
  const questions = selectDiagnosticQuestions(result.quiz, count);
  return {
    diagnostic: {
      topic,
      level,
      questions,
      ...(targets.length
        ? { probeTargets: targets.map((statement, index) => ({ questionId: questions[index].id, statement })) }
        : {}),
    },
    quality: result.quality,
  };
}

/**
 * 复习补讲：只针对遗忘卡点复盘机制，不建立新的学习主线、不新增题目、不要求作答。
 * 使用 summary 工具动作，因此不会生成或写入 learningState（不伪造学习进度），
 * 且仍经过同一套独立教学质量评审。
 */
export async function explainReviewItem(
  topic: string,
  prompt: string,
  explanation: string,
  learnerQuote: string | undefined,
  level: string,
  settings?: ChatRequest["settings"],
  signal?: AbortSignal,
): Promise<ChatResponse> {
  if (!topic.trim() || !prompt.trim() || !explanation.trim()) throw new ApiError(400, "复习项缺少主题、题面或原解析，不能补讲。");
  const request: ChatRequest = {
    topic: `复习补讲：${topic}`,
    level,
    goal: "针对复习时遗忘的具体卡点复盘机制，用更简单的例子说明，不追问、不出题、不认证掌握",
    action: "summary",
    messages: [{ role: "user", content: `我在复习时忘了如何解释这道题。请做一次聚焦的复习复盘：原解析在讲什么机制、我卡在哪一步、换一个更简单的例子说明这一步、下次复习从哪个具体点开始。我没有新的作答或理解证据，请明确说明仍未核验，不要把讲解当作已掌握。\n只复盘这道题，不需要继续追问，不要求我作答，不出练习题，不评价为已掌握，也不要安排新的学习路线或新主题。\n题面：${prompt}\n原解析：${explanation}${learnerQuote ? `\n我当时的回答：${learnerQuote}` : ""}` }],
    settings,
  };
  const result = await chatCompletion(request, { signal });
  // 补讲只是解释：响应边界再兜底一次，绝不把标题、路线、题目或 learningState
  // 带回前端（工具动作本身也不会生成状态，这里是防御性收口）。
  return {
    message: result.message,
    ...(result.quality ? { quality: result.quality } : {}),
  };
}
