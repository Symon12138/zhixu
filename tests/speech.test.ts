import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTranscript,
  createSpeechTranscriber,
  describeSpeechState,
  initialSpeechState,
  mapSpeechError,
  resolveSpeechSupport,
  speechErrorMessage,
  speechReducer,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionEventLike,
  type SpeechRecognitionLike,
  type SpeechState,
} from "../src/lib/speech";

/** 可注入的假识别器：手动触发 onresult/onerror/onend，记录 start/stop/abort 调用。 */
class FakeRecognition implements SpeechRecognitionLike {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  starts = 0;
  stops = 0;
  aborts = 0;

  start(): void { this.starts += 1; this.onstart?.(); }
  stop(): void { this.stops += 1; }
  abort(): void {
    this.aborts += 1;
    this.onerror?.({ error: "aborted" });
    this.onend?.();
  }

  emitResult(results: { text: string; isFinal: boolean }[], resultIndex = 0): void {
    const list: SpeechRecognitionEventLike = {
      resultIndex,
      results: {
        length: results.length,
        ...Object.fromEntries(
          results.map((r, i) => [i, { isFinal: r.isFinal, length: 1, 0: { transcript: r.text } }]),
        ),
      } as SpeechRecognitionEventLike["results"],
    };
    this.onresult?.(list);
  }
  error(code: string): void { this.onerror?.({ error: code }); }
  end(): void { this.onend?.(); }
}

const started = (): SpeechState => speechReducer(initialSpeechState, { type: "start" });

test("appendTranscript：中文直拼、英文词边界补空格、空片段不改草稿", () => {
  assert.equal(appendTranscript("", ""), "");
  assert.equal(appendTranscript("草稿", "  "), "草稿");
  assert.equal(appendTranscript("", "导数"), "导数");
  assert.equal(appendTranscript("先讲", "链式法则"), "先讲链式法则");
  assert.equal(appendTranscript("word", "next"), "word next");
  assert.equal(appendTranscript("讲清", "word"), "讲清word");
  assert.equal(appendTranscript("word", "中文"), "word中文");
  assert.equal(appendTranscript("已有。", "补充"), "已有。补充");
});

test("mapSpeechError 覆盖已知 code 并兜底", () => {
  assert.equal(mapSpeechError("not-allowed"), "permission-denied");
  assert.equal(mapSpeechError("service-not-allowed"), "permission-denied");
  assert.equal(mapSpeechError("no-speech"), "no-speech");
  assert.equal(mapSpeechError("network"), "network");
  assert.equal(mapSpeechError("audio-capture"), "audio-capture");
  assert.equal(mapSpeechError("aborted"), "recognition-failed");
  assert.equal(mapSpeechError(undefined), "recognition-failed");
});

test("speechErrorMessage 每种错误都有可读中文提示", () => {
  for (const kind of ["permission-denied", "no-speech", "network", "audio-capture", "recognition-failed", null] as const) {
    const message = speechErrorMessage(kind);
    assert.ok(message.length > 0, `错误种类 ${kind} 必须有提示`);
  }
  assert.match(speechErrorMessage("permission-denied"), /权限|允许/);
  assert.match(speechErrorMessage("no-speech"), /语音|麦克风/);
});

test("describeSpeechState：idle 空串，其余状态有文案，error 展开为具体错误", () => {
  assert.equal(describeSpeechState(initialSpeechState), "");
  assert.equal(describeSpeechState(started()), "正在聆听…");
  assert.equal(describeSpeechState({ ...started(), status: "transcribing" }), "转写中…");
  const errored: SpeechState = { ...started(), status: "error", error: "network" };
  assert.match(describeSpeechState(errored), /网络/);
});

test("speechReducer：start 清空 error/finalText，保留不支持原因", () => {
  const prior: SpeechState = { status: "error", interim: "x", finalText: "旧稿", error: "no-speech", unsupportedReason: "浏览器不支持" };
  const next = speechReducer(prior, { type: "start" });
  assert.deepEqual(next, {
    status: "listening", interim: "", finalText: "", error: null, unsupportedReason: "浏览器不支持",
  });
});

test("speechReducer：interim/final 仅聆听或转写中生效，final 累积清空临时", () => {
  let s = started();
  s = speechReducer(s, { type: "interim", text: "临" });
  assert.equal(s.interim, "临");
  s = speechReducer(s, { type: "final", text: "第一段" });
  assert.equal(s.finalText, "第一段");
  assert.equal(s.interim, "");
  s = speechReducer(s, { type: "final", text: "第二段" });
  assert.equal(s.finalText, "第一段第二段");
  const idle = { ...initialSpeechState };
  assert.equal(speechReducer(idle, { type: "interim", text: "x" }), idle);
  assert.equal(speechReducer(idle, { type: "final", text: "x" }), idle);
});

test("speechReducer：stop 转 transcribing；end 在出错时保留错误、否则归位 idle", () => {
  let s = started();
  s = speechReducer(s, { type: "stop" });
  assert.equal(s.status, "transcribing");
  s = speechReducer(s, { type: "end" });
  assert.equal(s.status, "idle");
  const errored: SpeechState = { ...started(), status: "error", error: "network" };
  assert.equal(speechReducer(errored, { type: "end" }), errored);
  // stop 只在 listening 生效
  assert.equal(speechReducer(errored, { type: "stop" }), errored);
});

test("speechReducer：abort 全清并归位 idle，unsupported 只记录原因", () => {
  const s: SpeechState = { status: "error", interim: "x", finalText: "稿", error: "network", unsupportedReason: null };
  assert.deepEqual(speechReducer(s, { type: "abort" }), initialSpeechState);
  const unsupported = speechReducer(initialSpeechState, { type: "unsupported", reason: "缺少 API" });
  assert.equal(unsupported.status, "idle");
  assert.equal(unsupported.unsupportedReason, "缺少 API");
});

test("resolveSpeechSupport：标准/前缀 API 均支持，全缺时给出明确原因", () => {
  const Ctor = FakeRecognition as unknown as new () => SpeechRecognitionLike;
  assert.equal(resolveSpeechSupport({ SpeechRecognition: Ctor }).supported, true);
  assert.equal(resolveSpeechSupport({ webkitSpeechRecognition: Ctor }).supported, true);
  const missing = resolveSpeechSupport({});
  assert.equal(missing.supported, false);
  assert.match(missing.reason ?? "", /不支持|SpeechRecognition/);
});

test("createSpeechTranscriber：不支持时 start 是 no-op，可读取 reason", () => {
  const t = createSpeechTranscriber({ globalObject: {} });
  assert.equal(t.supported, false);
  assert.ok(t.reason && t.reason.length > 0);
  t.start();
  assert.equal(t.getState().status, "idle");
  assert.equal(t.getState().unsupportedReason, t.reason);
});

test("createSpeechTranscriber：start→onFinal 只把增量送进回调，绝不自动发送", () => {
  const recognition = new FakeRecognition();
  const finals: string[] = [];
  const states: SpeechState[] = [];
  const t = createSpeechTranscriber({
    recognition,
    onFinal: (delta) => finals.push(delta),
    onState: (s) => states.push(s),
  });
  assert.equal(t.supported, true);
  t.start();
  assert.equal(recognition.starts, 1);
  assert.equal(t.getState().status, "listening");
  recognition.emitResult([{ text: "导数", isFinal: true }]);
  recognition.emitResult([{ text: "是变化率", isFinal: false }, { text: "的极限", isFinal: true }], 1);
  assert.deepEqual(finals, ["导数", "的极限"]);
  assert.equal(t.getState().finalText, "导数的极限");
  assert.equal(t.getState().interim, "");
  // 状态回调确实被触发（start + final 等），且没有任何"发送"概念。
  assert.ok(states.length >= 2);
});

test("createSpeechTranscriber：stop 转写中，abort 归位 idle 且断开底层", () => {
  const recognition = new FakeRecognition();
  const t = createSpeechTranscriber({ recognition });
  t.start();
  t.stop();
  assert.equal(recognition.stops, 1);
  assert.equal(t.getState().status, "transcribing");
  t.abort();
  assert.equal(recognition.aborts, 1);
  assert.deepEqual(t.getState(), initialSpeechState);
});

test("createSpeechTranscriber：'aborted' 错误被忽略，其他错误映射为可见提示", () => {
  const recognition = new FakeRecognition();
  const t = createSpeechTranscriber({ recognition });
  t.start();
  recognition.error("aborted");
  assert.equal(t.getState().status, "listening", "aborted 不是识别失败");
  recognition.error("not-allowed");
  assert.equal(t.getState().status, "error");
  assert.equal(t.getState().error, "permission-denied");
  recognition.end();
  assert.equal(t.getState().status, "error", "end 不应冲掉错误提示");
});

test("createSpeechTranscriber：重复 start 只启动一次，stop 在转写中不再触发", () => {
  const recognition = new FakeRecognition();
  const t = createSpeechTranscriber({ recognition });
  t.start();
  t.start();
  assert.equal(recognition.starts, 1);
  t.stop();
  t.stop();
  assert.equal(recognition.stops, 1);
});
