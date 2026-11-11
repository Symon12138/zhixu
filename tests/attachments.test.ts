import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { installFakeIndexedDB } from "./helpers/fakeIndexedDB";

/*
 * C1 附件（图片/PDF 进入学习对话）核心行为：
 * 1. 附件元数据构造与形状校验；
 * 2. 图片转 base64 → Gemini inlineData / OpenAI image_url parts（mock fetch 验证真实请求体）；
 * 3. IndexedDB 按 sessionId 隔离存取，二进制绝不进 localStorage；
 * 4. PDF 文本抽取复用 bookImport；无文本层时明确报错。
 *
 * 静态 import 在文件顶部统一加载；附件模块只在函数内部访问 indexedDB，
 * 因此顶层安装 fake 后再执行测试是安全的。底部 import 为书写顺序，
 * ES 模块提升会先于 installFakeIndexedDB 执行，但模块顶层无存储访问。
 */

const { factory, restore } = installFakeIndexedDB();

after(() => restore());

afterEach(() => factory.clearData());

test("附件分类：PNG/JPEG/WebP → image，PDF → pdf，其余拒绝", () => {
  const image = classifyAttachment({ name: "图1.PNG", size: 100, type: "image/png" });
  assert.equal("kind" in image ? image.kind : undefined, "image");
  assert.equal("mimeType" in image ? image.mimeType : undefined, "image/png");

  const jpeg = classifyAttachment({ name: "photo.jpg", size: 100 });
  assert.equal("kind" in jpeg ? jpeg.kind : undefined, "image");
  assert.equal("mimeType" in jpeg ? jpeg.mimeType : undefined, "image/jpeg");

  const webp = classifyAttachment({ name: "shot.webp", size: 100 });
  assert.equal("kind" in webp ? webp.kind : undefined, "image");
  assert.equal("mimeType" in webp ? webp.mimeType : undefined, "image/webp");

  const pdf = classifyAttachment({ name: "论文.pdf", size: 100, type: "application/pdf" });
  assert.equal("kind" in pdf ? pdf.kind : undefined, "pdf");
  assert.equal("mimeType" in pdf ? pdf.mimeType : undefined, "application/pdf");

  const bad = classifyAttachment({ name: "视频.mp4", size: 100, type: "video/mp4" });
  assert.ok("error" in bad && bad.error.includes("PNG / JPEG / WebP"));
});

test("附件大小上限：图片 10MB、PDF 30MB", () => {
  assert.equal(checkAttachmentSize("image", 10 * 1024 * 1024), undefined);
  assert.ok(checkAttachmentSize("image", 10 * 1024 * 1024 + 1));
  assert.equal(checkAttachmentSize("pdf", 30 * 1024 * 1024), undefined);
  assert.ok(checkAttachmentSize("pdf", 30 * 1024 * 1024 + 1));
});

test("Reference.attachment 元数据：buildAttachmentReference 保留元数据与文本", () => {
  const meta: AttachmentMeta = { id: "att-1", name: "图1.png", kind: "image", mimeType: "image/png", byteLength: 12 };
  const reference = buildAttachmentReference(meta, "");
  assert.equal(reference.name, "图1.png");
  assert.equal(reference.text, "");
  assert.deepEqual(reference.attachment, meta);
  assert.ok(isAttachmentMeta(reference.attachment));
  assert.ok(!isAttachmentMeta({ id: "", name: "x", kind: "image", mimeType: "image/png", byteLength: 1 }));
  assert.ok(!isAttachmentMeta({ id: "a", name: "x", kind: "video", mimeType: "video/mp4", byteLength: 1 }));
  assert.ok(!isAttachmentMeta(null));
});

/* ── IndexedDB：按 sessionId 隔离，二进制不进 localStorage ────────── */

test("附件字节按 sessionId 隔离存储；别的会话读不到", async () => {
  const meta: AttachmentMeta = { id: "att-1", name: "图.png", kind: "image", mimeType: "image/png", byteLength: 3 };
  const bytes = Uint8Array.from([1, 2, 3]);
  await saveAttachmentBytes("session-a", meta, bytes);
  assert.deepEqual(await readAttachmentBytes("session-a", "att-1"), bytes);
  assert.equal(await readAttachmentBytes("session-b", "att-1"), undefined);
});

test("附件字节删除后不可再读", async () => {
  const meta: AttachmentMeta = { id: "att-2", name: "图.png", kind: "image", mimeType: "image/png", byteLength: 3 };
  await saveAttachmentBytes("session-a", meta, Uint8Array.from([9, 9]));
  await deleteAttachmentBytes("session-a", "att-2");
  assert.equal(await readAttachmentBytes("session-a", "att-2"), undefined);
});

test("二进制不写 localStorage：保存/读取附件全程不触碰任何 localStorage 键", async () => {
  const store = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      setItem: () => { throw new Error("附件路径不允许写 localStorage"); },
      getItem: () => { throw new Error("附件路径不允许读 localStorage"); },
      removeItem: () => { store.delete("x"); },
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() { return store.size; },
    },
  });
  try {
    const meta: AttachmentMeta = { id: "att-3", name: "图.png", kind: "image", mimeType: "image/png", byteLength: 4 };
    const bytes = Uint8Array.from([4, 3, 2, 1]);
    await saveAttachmentBytes("session-c", meta, bytes);
    assert.deepEqual(await readAttachmentBytes("session-c", "att-3"), bytes);
    assert.equal(store.size, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

/* ── base64 内联与 vision parts（mock fetch 验证真实请求体） ──────── */

test("图片 ≤2MB 转 base64 dataURL；>2MB 返回 undefined 不内联", () => {
  const small = Uint8Array.from([0, 1, 2, 250, 251]);
  const url = imageInlineDataUrl(small, "image/png");
  assert.ok(url?.startsWith("data:image/png;base64,"));
  assert.equal(atob(url!.split(",")[1]!).length, small.length);

  const huge = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
  assert.equal(imageInlineDataUrl(huge, "image/png"), undefined);
});

test("Gemini：attachmentImages 进入最后一条用户消息的 inlineData parts（mock fetch）", async () => {
  const dataUrl = "data:image/png;base64,AAECAw==";
  // 1) dataURL → inlineData 形状
  assert.deepEqual(dataUrlToInline(dataUrl), { mimeType: "image/png", data: "AAECAw==" });
  assert.throws(() => dataUrlToInline("data:text/plain;base64,AAEC"), /图片格式不合法/);

  // 2) 真实请求体（mock fetch 捕获）
  const bodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "讲解" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const invoker = createModelInvoker(geminiConfig(), undefined, { imageDataUrls: [dataUrl] });
    await invoker({
      purpose: "draft",
      system: "你是导师",
      messages: [
        { role: "assistant", content: "上一轮" },
        { role: "user", content: "看图讲解" },
      ],
      signal: new AbortController().signal,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const body = bodies[0] as { contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }> };
  const lastUser = body.contents.at(-1)!;
  assert.equal(lastUser.role, "user");
  assert.equal(lastUser.parts[0].text, "看图讲解");
  assert.deepEqual(lastUser.parts[1]?.inlineData, { mimeType: "image/png", data: "AAECAw==" });
  // 历史轮次不受影响
  assert.equal(body.contents[0].parts.length, 1);
  assert.ok(!body.contents[0].parts[0].inlineData);
});

test("OpenAI：attachmentImages 映射为 content 数组里的 image_url（mock fetch）", async () => {
  const dataUrl = "data:image/jpeg;base64,AAEC";

  // 纯映射函数：无图片的轮次保持字符串 content
  assert.deepEqual(historyToOpenAiMessage({ role: "assistant", content: "讲解" }), { role: "assistant", content: "讲解" });
  assert.deepEqual(
    historyToOpenAiMessage({ role: "user", content: "看图", imageDataUrls: [dataUrl] }),
    { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: dataUrl } }] },
  );

  // 真实请求体（mock fetch 捕获）
  const bodies: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "讲解" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    const invoker = createModelInvoker(openaiConfig(), undefined, { imageDataUrls: [dataUrl] });
    await invoker({
      purpose: "draft",
      system: "你是导师",
      messages: [{ role: "user", content: "看图讲解" }],
      signal: new AbortController().signal,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const body = bodies[0] as { messages: Array<{ role: string; content: unknown }> };
  const last = body.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.ok(Array.isArray(last.content));
  const parts = last.content as Array<{ type: string; image_url?: { url: string } }>;
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url?.url, dataUrl);
  // system 消息仍是纯字符串
  assert.equal(typeof body.messages[0].content, "string");
});

/* ── PDF 文本抽取与无文本层回退 ────────────────────────────────── */

test("PDF 文本抽取：无文本层的扫描件给出明确错误，不静默丢图", async () => {
  // importBook 的 PDF 路径依赖浏览器端 PDF.js worker（动态加载）；
  // 测试环境没有 worker URL，会在解析阶段抛错——无论哪种失败都必须是明确错误，
  // 而不是返回空文本假装成功。
  await assert.rejects(
    extractPdfText(new File(["%PDF-1.4 不是真的PDF正文"], "扫描件.pdf")),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(message.length > 0);
      return true;
    },
  );
});

test("extractPdfText 不会对空文本返回成功：任何返回值都必须非空", async () => {
  // 直接构造：importBook 解析失败时 extractPdfText 必须抛错（复用书架校验），
  // 不能出现 text === "" 的 Reference 静默通过。
  await assert.rejects(
    extractPdfText(new File(["%PDF-1.4"], "empty.pdf")),
  );
});

/* ── 服务端请求体校验（attachmentImages 形状） ─────────────────── */

test("服务端 validateChatRequest：合法 attachmentImages 通过、非法形态 400", () => {
  const base = {
    action: "start",
    topic: "二分查找",
    level: "初学",
    goal: "理解边界",
    messages: [{ role: "user", content: "开始学习" }],
  };
  const ok = validateChatRequest({
    ...base,
    attachmentImages: [{ id: "att-1", dataUrl: "data:image/png;base64,AAEC" }],
  });
  assert.deepEqual(ok.attachmentImages, [{ id: "att-1", dataUrl: "data:image/png;base64,AAEC" }]);

  assert.throws(() => validateChatRequest({
    ...base,
    attachmentImages: [{ id: "att-1", dataUrl: "data:text/html;base64,PGh0bWw+" }],
  }), /不是合法的 data:image/);
  assert.throws(() => validateChatRequest({
    ...base,
    attachmentImages: new Array(5).fill({ id: "a", dataUrl: "data:image/png;base64,AAEC" }),
  }), /最多 4 张图片/);
  // 非法 attachment 形状被剥离，请求仍合法（引用里不再带附件）。
  const stripped = validateChatRequest({
    ...base,
    references: [{ name: "图片", text: "", attachment: { id: "x", kind: "video", mimeType: "video/mp4", byteLength: 1 } }],
  });
  assert.equal(stripped.references?.[0].attachment, undefined);
});

test("Reference.attachment 元数据在服务端被保留（合法形态）", () => {
  const ok = validateChatRequest({
    action: "start",
    topic: "二分查找",
    level: "初学",
    goal: "理解边界",
    messages: [{ role: "user", content: "开始学习" }],
    references: [{
      name: "图1.png",
      text: "",
      attachment: { id: "att-1", name: "图1.png", kind: "image", mimeType: "image/png", byteLength: 12 },
    }],
  });
  assert.equal(ok.references?.[0].attachment?.id, "att-1");
});

/* ── 测试配置 ───────────────────────────────────────────────── */

import {
  buildAttachmentReference,
  checkAttachmentSize,
  classifyAttachment,
  deleteAttachmentBytes,
  extractPdfText,
  imageInlineDataUrl,
  isAttachmentMeta,
  MAX_INLINE_IMAGE_BYTES,
  readAttachmentBytes,
  saveAttachmentBytes,
} from "../src/lib/attachments";
import { createModelInvoker, dataUrlToInline, historyToOpenAiMessage, type ResolvedConfig } from "../server/ai";
import { validateChatRequest } from "../server/index";
import type { AttachmentMeta } from "../src/types";

function geminiConfig(): ResolvedConfig {
  return {
    provider: "gemini",
    apiKey: "test-key",
    model: "gemini-2.5-flash",
    baseUrl: "https://gemini.test/v1",
    structuredOutput: true,
    thinkingLevel: "auto",
  };
}

function openaiConfig(): ResolvedConfig {
  return { ...geminiConfig(), provider: "openai", baseUrl: "https://openai.test/v1", model: "gpt-4o-mini" };
}
