/**
 * 语音转写（Web Speech API 封装）。
 *
 * 设计要点：
 * - 纯状态机 speechReducer + 纯拼接 appendTranscript，可脱离浏览器测试；
 * - createSpeechTranscriber 只把识别结果写进「草稿」，绝不发送、绝不调用任何
 *   AI 接口：最终转写以 onFinal(delta) 交给调用方拼进输入框；
 * - 浏览器不支持时明确给出原因，不做任何伪实现（不假装能识别）；
 * - 权限/无语音/网络/设备等错误都映射为明确文案，绝不吞错。
 *
 * lang 固定 zh-CN；interimResults 开启，临时结果只用于展示，不进入草稿。
 */

/** 识别状态机：idle 空闲、listening 正在聆听、transcribing 停止后等待最终结果、error 出错。 */
export type SpeechStatus = "idle" | "listening" | "transcribing" | "error";

export type SpeechErrorKind =
  | "permission-denied"
  | "no-speech"
  | "network"
  | "audio-capture"
  | "recognition-failed";

export interface SpeechState {
  status: SpeechStatus;
  /** 临时（未确认）转写，仅用于「正在聆听」时的预览，不写入草稿。 */
  interim: string;
  /** 本次聆听累积的最终转写；调用方据此同步输入框草稿。 */
  finalText: string;
  error: SpeechErrorKind | null;
  /** 浏览器不支持语音识别的原因；null 表示支持。 */
  unsupportedReason: string | null;
}

export type SpeechEvent =
  | { type: "start" }
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "stop" }
  | { type: "end" }
  | { type: "abort" }
  | { type: "error"; kind: SpeechErrorKind }
  | { type: "unsupported"; reason: string };

export const initialSpeechState: SpeechState = {
  status: "idle",
  interim: "",
  finalText: "",
  error: null,
  unsupportedReason: null,
};

/** Web Speech error.code -> 内部错误种类；aborted 由主动 abort 产生，不视为错误。 */
export function mapSpeechError(code: string | undefined): SpeechErrorKind {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission-denied";
    case "no-speech":
      return "no-speech";
    case "network":
      return "network";
    case "audio-capture":
      return "audio-capture";
    default:
      return "recognition-failed";
  }
}

export function speechErrorMessage(kind: SpeechErrorKind | null): string {
  switch (kind) {
    case "permission-denied":
      return "无权限：麦克风或语音识别被拒绝，请在浏览器设置中允许后重试。";
    case "no-speech":
      return "没有检测到语音，请靠近麦克风后重试。";
    case "network":
      return "识别失败：网络中断，请检查网络后重试。";
    case "audio-capture":
      return "识别失败：找不到可用的麦克风设备。";
    default:
      return "识别失败，请重试。";
  }
}

/** 当前状态对应的用户可见文案。idle 返回空串（由调用方决定是否显示）。 */
export function describeSpeechState(state: SpeechState): string {
  switch (state.status) {
    case "listening":
      return "正在聆听…";
    case "transcribing":
      return "转写中…";
    case "error":
      return speechErrorMessage(state.error);
    case "idle":
      return "";
  }
}

/** 把一条最终转写片段拼进已有草稿。纯函数：只产出草稿文本，不发送任何内容。 */
export function appendTranscript(draft: string, delta: string): string {
  if (!delta) return draft;
  const addition = delta.trim();
  if (!addition) return draft;
  if (!draft) return addition;
  const tail = draft[draft.length - 1];
  const head = addition[0];
  // zh-CN 直接拼接；仅当两侧都是 ASCII 词字符时补一个空格，避免英文单词粘连。
  const needSpace = /[A-Za-z0-9]/.test(tail) && /[A-Za-z0-9]/.test(head);
  return needSpace ? `${draft} ${addition}` : `${draft}${addition}`;
}

/**
 * 纯状态机：负责状态流转与最终转写累积。
 * 注意它没有任何「发送」概念——输出仅是草稿文本与状态，供调用方写入输入框。
 */
export function speechReducer(state: SpeechState, event: SpeechEvent): SpeechState {
  switch (event.type) {
    case "start":
      return {
        status: "listening",
        interim: "",
        finalText: "",
        error: null,
        unsupportedReason: state.unsupportedReason,
      };
    case "interim":
      if (state.status !== "listening" && state.status !== "transcribing") return state;
      return { ...state, interim: event.text };
    case "final":
      if (state.status !== "listening" && state.status !== "transcribing") return state;
      return {
        ...state,
        finalText: appendTranscript(state.finalText, event.text),
        interim: "",
      };
    case "stop":
      if (state.status !== "listening") return state;
      return { ...state, status: "transcribing", interim: "" };
    case "end":
      // 出错后识别会结束；保留 error 状态直到下一次 start，避免提示被 onend 冲掉。
      if (state.error) return state;
      return { ...state, status: "idle", interim: "" };
    case "abort":
      return { status: "idle", interim: "", finalText: "", error: null, unsupportedReason: state.unsupportedReason };
    case "error":
      return { ...state, status: "error", error: event.kind, interim: "" };
    case "unsupported":
      return { ...state, status: "idle", unsupportedReason: event.reason };
  }
}

/* ── 浏览器 API 的最小结构类型（不依赖 lib.dom 是否声明 SpeechRecognition） ── */

export interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  0: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}
export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
export interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
export interface SpeechGlobal {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

export interface SpeechSupport {
  supported: boolean;
  ctor?: SpeechRecognitionCtor;
  reason: string | null;
}

/** 检测是否支持语音识别；不支持时返回明确原因（绝不伪实现）。 */
export function resolveSpeechSupport(
  globalObject: SpeechGlobal = globalThis as unknown as SpeechGlobal,
): SpeechSupport {
  const ctor = globalObject.SpeechRecognition ?? globalObject.webkitSpeechRecognition;
  if (typeof ctor === "function") {
    return { supported: true, ctor, reason: null };
  }
  return {
    supported: false,
    reason:
      "当前浏览器不支持语音识别（缺少 SpeechRecognition / webkitSpeechRecognition），请改用 Chrome / Edge 等浏览器。",
  };
}

export interface SpeechTranscriberOptions {
  /** 状态变化回调；调用方据此更新按钮与提示。 */
  onState?: (state: SpeechState) => void;
  /** 每条最终结果的新增文本；调用方只把它拼进输入框草稿，绝不发送。 */
  onFinal?: (delta: string) => void;
  /** 注入识别实例（测试用）；默认按支持检测结果创建。 */
  recognition?: SpeechRecognitionLike;
  /** 注入全局对象（测试用），用于不支持检测。 */
  globalObject?: SpeechGlobal;
}

export interface SpeechTranscriber {
  readonly supported: boolean;
  /** 不支持时的原因；支持时为 null。 */
  readonly reason: string | null;
  start(): void;
  stop(): void;
  abort(): void;
  getState(): SpeechState;
}

export function createSpeechTranscriber(
  options: SpeechTranscriberOptions = {},
): SpeechTranscriber {
  const globalObject = options.globalObject ?? (globalThis as unknown as SpeechGlobal);
  const support = resolveSpeechSupport(globalObject);
  const supported = support.supported || !!options.recognition;
  const reason = supported ? null : support.reason;

  let state: SpeechState = { ...initialSpeechState, unsupportedReason: reason };
  let recognition: SpeechRecognitionLike | null = options.recognition ?? null;

  function dispatch(event: SpeechEvent): void {
    const next = speechReducer(state, event);
    if (next !== state) {
      state = next;
      options.onState?.(state);
    }
  }

  function attachHandlers(instance: SpeechRecognitionLike): void {
    instance.onresult = handleResult;
    instance.onerror = (event) => {
      // abort() 会触发 'aborted'；这是主动收尾，不当作识别失败，交给 onend 归位 idle。
      if (event.error === "aborted") return;
      dispatch({ type: "error", kind: mapSpeechError(event.error) });
    };
    instance.onend = () => dispatch({ type: "end" });
    instance.onstart = () => {};
  }

  function ensureRecognition(): SpeechRecognitionLike | null {
    if (recognition) return recognition;
    if (!support.ctor) return null;
    const created = new support.ctor();
    created.lang = "zh-CN";
    created.continuous = true;
    created.interimResults = true;
    created.maxAlternatives = 1;
    attachHandlers(created);
    recognition = created;
    return created;
  }

  // 注入的识别实例同样要接线，否则注入缝是死的，注入场景无法收到任何识别事件。
  if (options.recognition) attachHandlers(options.recognition);

  function handleResult(event: SpeechRecognitionEventLike): void {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) {
        dispatch({ type: "final", text });
        // 转写结果只进入草稿；这里没有任何发送动作。
        options.onFinal?.(text);
      } else {
        interim += text;
      }
    }
    if (interim) dispatch({ type: "interim", text: interim });
  }

  function isActive(): boolean {
    return state.status === "listening" || state.status === "transcribing";
  }

  return {
    supported,
    reason,
    getState: () => state,
    start() {
      if (!supported) {
        // 不支持时绝不伪实现；调用方应据此禁用按钮，这里保持 idle 并可读取 reason。
        return;
      }
      if (isActive()) return;
      const instance = ensureRecognition();
      if (!instance) return;
      dispatch({ type: "start" });
      try {
        instance.start();
      } catch {
        dispatch({ type: "error", kind: "recognition-failed" });
      }
    },
    stop() {
      if (state.status !== "listening") return;
      dispatch({ type: "stop" });
      try {
        recognition?.stop();
      } catch {
        dispatch({ type: "end" });
      }
    },
    abort() {
      // 主动中断：立即归位 idle，并断开底层识别，避免卸载/切换会话后继续占用麦克风。
      dispatch({ type: "abort" });
      try {
        recognition?.abort();
      } catch {
        /* abort 失败也已把状态归位，无需再处理。 */
      }
    },
  };
}
