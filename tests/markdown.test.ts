import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// MarkdownContent 只为了浏览器样式引入 KaTeX 的 CSS，Node 无法加载。
// 这里把 CSS 换成空模块，同时确认升级后的 katex 仍然发布 dist/katex.min.css。
// 必须用动态 import：静态 import 会在 registerHooks 生效前加载组件，导致 CSS 解析失败。
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".css")) return nextLoad(url, context);
    const path = fileURLToPath(url);
    assert.ok(existsSync(path), `Markdown 依赖的样式文件缺失: ${path}`);
    return { format: "module", source: "export default {};", shortCircuit: true };
  },
});

const { default: MarkdownContent } = await import("../src/components/MarkdownContent");

function render(markdown: string, inline = false): string {
  return renderToStaticMarkup(createElement(MarkdownContent, { children: markdown, inline }));
}

/** 只匹配真正的 a 标签，避免把 <annotation ...> 误判成链接。 */
function hasAnchor(html: string): boolean {
  return /<a[\s>]/.test(html);
}

test("普通 Markdown 与 GFM 表格、删除线、任务列表仍然渲染", () => {
  const html = render(
    [
      "## 净值与分红",
      "",
      "**加粗**、~~删除~~ 与 `code`",
      "",
      "> 引用段落",
      "",
      "| 名称 | 数值 |",
      "| --- | --- |",
      "| 资产 | 100 |",
      "",
      "- [x] 已完成",
      "- [ ] 待办",
    ].join("\n"),
  );

  assert.match(html, /<h2>净值与分红<\/h2>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<del>删除<\/del>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>名称<\/th>/);
  assert.match(html, /<td>资产<\/td>/);
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /type="checkbox"(?![^>]*checked)/);
});

test("行内公式与块级公式渲染为 KaTeX 且保留 TeX 原文", () => {
  const inline = render("质能方程 $E = mc^2$ 成立。");
  assert.match(inline, /<span class="katex">/);
  assert.match(inline, /<span class="katex-mathml">/);
  assert.match(inline, /<span class="katex-html"/);
  assert.match(inline, /<annotation encoding="application\/x-tex">E = mc\^2<\/annotation>/);
  assert.doesNotMatch(inline, /katex-error/);

  const block = render("$$\n\\int_0^1 x\\,dx\n$$");
  assert.match(block, /<span class="katex-display">/);
  assert.match(block, /<math[^>]*display="block"/);
  assert.match(block, /<annotation encoding="application\/x-tex">\\int_0\^1 x\\,dx<\/annotation>/);
});

test("无法解析的公式降级为错误文本而不抛异常", () => {
  const html = render("$\\notacommand{x}$");

  assert.match(html, /<span class="katex">/);
  assert.match(html, /mathcolor="#cc0000"/);
  assert.doesNotMatch(html, /katex-error"/);
  assert.equal(hasAnchor(html), false);
});

test("不可信 HTML 被转义为文本，不产生脚本或图片标签", () => {
  const html = render('你好 <img src=x onerror="alert(1)"> <script>alert(2)</script> 结束');

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
});

test("Markdown 链接过滤危险协议并保留安全外链属性", () => {
  const html = render("[点我](javascript:alert(1)) 和 [文档](https://example.com/a)");

  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /<a\s+href="https:\/\/example\.com\/a"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
});

test("KaTeX 默认不信任 \\href 等 HTML 命令", () => {
  const html = render("$\\href{javascript:alert(1)}{x}$");

  assert.equal(hasAnchor(html), false);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /mathcolor="#cc0000"/);
});

test("原型链上的 trust 无法放开 KaTeX 的 HTML 命令（GHSA-238p-pmpm-9mq7）", () => {
  // 修复前：原型链上的 trust 会启用 \href 等命令，把不可信公式变成链接。
  Object.defineProperty(Object.prototype, "trust", {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  try {
    const html = render("$\\href{javascript:alert(1)}{x}$");

    assert.equal(hasAnchor(html), false);
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.match(html, /mathcolor="#cc0000"/);
  } finally {
    delete (Object.prototype as Record<string, unknown>).trust;
  }
});

test("inline 模式不再包裹段落标签", () => {
  const html = render("**重点** 说明", true);

  assert.equal(html, '<span class="rich-text rich-text-inline"><strong>重点</strong> 说明</span>');
});
