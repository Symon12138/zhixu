import type { ChatRequest, ChatResponse, DiagnosticProfile, ProviderSettings, QuizQuestion } from "../src/types";
import { ApiError, chatCompletion } from "./ai";

/** 学习前诊断固定 3 题；底层 quiz 工具允许 3–5 题，这里只取前 3 题。 */
export const DIAGNOSTIC_QUESTION_COUNT = 3;

/**
 * 严格按模型给出的顺序取前 3 题：不随机、不重排、不改写题面或 correctIndex，
 * 以免诊断的正确项与解析错位。
 */
export function selectDiagnosticQuestions(quiz: QuizQuestion[]): QuizQuestion[] {
  return quiz.slice(0, DIAGNOSTIC_QUESTION_COUNT);
}

export async function generateDiagnostic(
  topic: string,
  level: string,
  goal: string,
  settings?: ProviderSettings,
  signal?: AbortSignal,
): Promise<{ diagnostic: Omit<DiagnosticProfile, "id" | "answers" | "submitted" | "evaluatedAt" | "recommendedStepIndex" | "evidenceSummary" | "weakConcepts" | "skippedConcepts">; quality: ChatResponse["quality"] }> {
  if (!topic.trim()) throw new ApiError(400, "请先填写诊断主题。");
  const request: ChatRequest = {
    topic: `学习前诊断：${topic}`,
    level,
    goal,
    action: "quiz",
    messages: [{
      role: "user",
      content: `为零基础或已有基础学习者设计恰好3道学习前诊断选择题，用于安排起点，不用于认证已经掌握。覆盖：一个必要前置概念、一个核心机制、一个不同情境的初步应用。每题选项2-4个，提供正确答案、提示与解析；题面不得直接写出答案。不要假定学习者自评能力。主题：${topic}。期望能力：${goal || level}。`,
    }],
    settings,
  };
  const result = await chatCompletion(request, { signal });
  if (!result.quiz || result.quiz.length < DIAGNOSTIC_QUESTION_COUNT) {
    throw new ApiError(502, "诊断题未生成，请重试。");
  }
  return {
    diagnostic: { topic, level, questions: selectDiagnosticQuestions(result.quiz) },
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
