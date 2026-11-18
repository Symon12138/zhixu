import type { ChatResponse, PhaseEvent } from "../types";

/**
 * /api/chat 的 SSE 阶段流客户端。教学正文只在通过独立评审后一次性发布，
 * 因此这里流式读取的是服务端真实阶段（search/draft/review/repair/publish），
 * 不是逐字讲解，也不在客户端伪造进度。旧后端/前置校验错误仍返回单一 JSON，
 * 由 isEventStream 按响应 Content-Type 区分，而不是按请求意图猜测。
 */

/** SSE 帧：event 缺省为 message，data 多行按规范用 \n 连接，注释行（心跳）忽略。 */
export interface SseFrame {
  event: string;
  data: string;
}

export function parseSseFrame(frame: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

/** 把累积文本切成完整帧（空行分隔），末尾不完整的部分留给下一次读取。 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts, rest };
}

/** 静态阶段白名单：只接受服务端约定的五类真实阶段，忽略未知事件。 */
const TEACHING_PHASES: Record<string, true> = {
  search: true,
  draft: true,
  review: true,
  repair: true,
  publish: true,
};

function isPhaseEvent(value: unknown): value is PhaseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.phase === "string" &&
    TEACHING_PHASES[record.phase] === true &&
    typeof record.label === "string"
  );
}

/** 前置校验/配额失败仍返回 JSON；只有真正的阶段流响应才带 text/event-stream。 */
export function isEventStream(response: Pick<Response, "headers">): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
}

export type ChatStreamOutcome =
  | { kind: "result"; response: ChatResponse }
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "truncated" };

/**
 * 逐帧读取 SSE：phase 实时回调，result 携带完整响应，error 携带公开错误 payload
 * （含 status，供调用方复用既有 422/504/401/429 映射）。流在发布结果前结束返回
 * truncated，调用方必须当作未提交进度，不能误显示成功。
 */
export async function readChatStream(
  response: Response,
  onPhase?: (event: PhaseEvent) => void,
): Promise<ChatStreamOutcome> {
  if (!response.body) return { kind: "truncated" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (frame: string): ChatStreamOutcome | undefined => {
    const parsed = parseSseFrame(frame);
    if (!parsed) return undefined;
    let data: unknown;
    try {
      data = JSON.parse(parsed.data);
    } catch {
      return undefined;
    }
    if (parsed.event === "phase") {
      if (isPhaseEvent(data)) onPhase?.(data);
      return undefined;
    }
    if (parsed.event === "result") {
      return { kind: "result", response: data as ChatResponse };
    }
    if (parsed.event === "error") {
      const record =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : {};
      return {
        kind: "error",
        status: typeof record.status === "number" ? record.status : 500,
        body: record,
      };
    }
    return undefined;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const outcome = consume(frame);
        if (outcome) return outcome;
      }
    }
    const tail = consume(buffer);
    return tail ?? { kind: "truncated" };
  } finally {
    reader.releaseLock();
  }
}
