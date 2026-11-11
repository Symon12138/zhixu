import assert from "node:assert/strict";
import test from "node:test";
import { ARTIFACT_MAX_BYTES, type LessonArtifact } from "../src/types";
import {
  buildHtmlSrcdoc,
  buildStandaloneExport,
  escapeHtml,
  IFRAME_CSP,
  IFRAME_SANDBOX,
  sanitizeSvg,
} from "../src/components/ArtifactView";
import { parseLessonArtifact } from "../server/learning";
import { checkTutorDraft } from "../server/learning";
import type { ChatRequest } from "../src/types";
import { draftFor, requestFor, stateWithQuestion } from "./fixtures";

/* ── C2 可视化讲解 artifact：安全清洗、沙箱、导出与协议校验 ─── */

test("SVG 清洗丢弃 script / on* 属性 / 外部 href，只保留白名单标签", () => {
  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
    <script>alert(1)</script>
    <a href="https://evil.example"><text onclick="alert(2)">点我</text></a>
    <rect width="10" height="10" fill="red" />
    <foreignObject><div>x</div></foreignObject>
  </svg>`;
  const clean = sanitizeSvg(dirty);
  assert.ok(clean);
  assert.ok(clean.startsWith("<svg"));
  assert.doesNotMatch(clean, /script/i);
  assert.doesNotMatch(clean, /点我/, "外链子树（含其文本）应被整体丢弃");
  assert.match(clean, /<rect/i);
  assert.doesNotMatch(clean, /foreignobject/i);
  assert.doesNotMatch(clean, /onload|onclick/i);
  assert.doesNotMatch(clean, /evil\.example/);
});

test("非 svg 根元素与超限内容返回 null（失败回退文本）", () => {
  assert.equal(sanitizeSvg("<div>hi</div>"), null);
  assert.equal(sanitizeSvg(""), null);
  assert.equal(sanitizeSvg("x".repeat(ARTIFACT_MAX_BYTES + 1)), null);
});

test("HTML 沙箱 iframe 无 allow-same-origin/allow-scripts，CSP 禁外部资源", () => {
  assert.equal(IFRAME_SANDBOX, "");
  assert.match(IFRAME_CSP, /default-src 'none'/);
  assert.match(IFRAME_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(buildHtmlSrcdoc("<p>图</p>"), /https?:\/\//);
  const srcdoc = buildHtmlSrcdoc("<p>演示</p>");
  assert.match(srcdoc, /Content-Security-Policy/);
  assert.match(srcdoc, /演示/);
});

test("导出独立 HTML 自包含、含文本替代与来源、转义注入", () => {
  const artifact: LessonArtifact = {
    kind: "svg",
    title: "导数示意 <script>",
    content: "<svg xmlns='http://www.w3.org/2000/svg'><circle r='10'/></svg>",
    sources: ["教材"],
    textAlternative: "割线逼近切线",
  };
  const html = buildStandaloneExport(artifact);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /割线逼近切线/);
  assert.match(html, /教材/);
  assert.match(html, /<circle/);
  assert.doesNotMatch(html, /<script>/, "标题里的标签必须转义");
  assert.doesNotMatch(html, /https?:\/\//, "导出不得引用外部资源");
  assert.equal(escapeHtml("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
});

test("parseLessonArtifact 拒绝缺 textAlternative、未知 kind、超限 content", () => {
  const valid = {
    kind: "svg",
    title: "图",
    content: "<svg></svg>",
    sources: [],
    textAlternative: "说明",
  };
  assert.equal(parseLessonArtifact(valid).kind, "svg");
  assert.throws(() => parseLessonArtifact({ ...valid, textAlternative: "" }));
  assert.throws(() => parseLessonArtifact({ ...valid, kind: "flash" }));
  assert.throws(() => parseLessonArtifact({ ...valid, content: "x".repeat(ARTIFACT_MAX_BYTES + 1) }));
});

test("checkTutorDraft 拒绝 artifact 声明非本轮材料的来源", () => {
  const state = stateWithQuestion();
  const request: ChatRequest = {
    ...requestFor(state, "继续"),
    references: [{ name: "教材", text: "导数定义" }],
  };
  const draft = draftFor(state);
  draft.artifact = {
    kind: "svg",
    title: "图",
    content: "<svg></svg>",
    sources: ["教材"],
    textAlternative: "说明",
  };
  assert.ok(!checkTutorDraft(request, draft).some((issue) => issue.code === "artifact_source_not_bound"));
  draft.artifact.sources = ["不存在的材料"];
  assert.ok(checkTutorDraft(request, draft).some((issue) => issue.code === "artifact_source_not_bound"));
});
