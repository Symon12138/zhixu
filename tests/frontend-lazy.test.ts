import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginOption } from "vite";
import viteConfig from "../vite.config";
import { BookLibraryFallback } from "../src/components/LazyBookLibrary";
import { DerivativeLabFallback } from "../src/components/LazyDerivativeLab";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("书架和导数实验只在各自视图里动态加载，首屏不静态引入", () => {
  const bookLoader = source("../src/components/LazyBookLibrary.tsx");
  assert.match(bookLoader, /import\("\.\/BookLibrary"\)/);
  assert.doesNotMatch(bookLoader, /^import(?!\s+type)[^\n]*from "\.\/BookLibrary"/m);
  assert.doesNotMatch(bookLoader, /^import[^\n]*from "lucide-react"/m);

  const labLoader = source("../src/components/LazyDerivativeLab.tsx");
  assert.match(labLoader, /import\("\.\/DerivativeLab"\)/);
  assert.doesNotMatch(labLoader, /^import[^\n]*from "\.\/DerivativeLab"/m);
  assert.doesNotMatch(labLoader, /^import[^\n]*from "lucide-react"/m);

  const richText = source("../src/components/RichText.tsx");
  assert.match(richText, /lazy\(\(\) => import\("\.\/MarkdownContent"\)\)/);
  assert.doesNotMatch(richText, /^import[^\n]*from "\.\/MarkdownContent"/m);
});

test("书架 fallback 占住标题区与加载区，加载完成后不跳动", () => {
  const html = renderToStaticMarkup(createElement(BookLibraryFallback));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
  assert.match(html, /正在打开书架/);
  assert.match(html, /max-width:1460px/);
  assert.match(html, /padding:60px 20px/);
});

test("导数实验 fallback 与真实卡片同结构、同比例", () => {
  const html = renderToStaticMarkup(createElement(DerivativeLabFallback));
  assert.match(html, /aria-label="导数交互实验"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /padding:24px 26px 22px/);
  assert.match(html, /aspect-ratio:520 \/ 290/);
  assert.match(html, /正在加载导数交互实验/);
});

test("manualChunks 只拆 React 运行时，公式/PDF/图标保持自然动态分包", () => {
  const outputOption = viteConfig.build?.rollupOptions?.output;
  const output = Array.isArray(outputOption) ? outputOption[0] : outputOption;
  const manualChunks = output?.manualChunks;
  assert.equal(typeof manualChunks, "function");
  if (typeof manualChunks !== "function") return;
  const meta = {
    getModuleIds: () => new Set<string>().values(),
    getModuleInfo: () => null,
  };
  const classify = (id: string) => manualChunks(id, meta);

  assert.equal(classify("E:/app/node_modules/react/index.js"), "react-vendor");
  assert.equal(classify("E:/app/node_modules/react-dom/client.js"), "react-vendor");
  assert.equal(classify("E:/app/node_modules/scheduler/index.js"), "react-vendor");
  assert.equal(classify("E:/app/node_modules/react/jsx-runtime.js"), "react-vendor");

  assert.equal(classify("E:/app/node_modules/react-markdown/index.js"), undefined);
  assert.equal(classify("E:/app/node_modules/katex/dist/katex.mjs"), undefined);
  assert.equal(classify("E:/app/node_modules/pdfjs-dist/build/pdf.mjs"), undefined);
  assert.equal(classify("E:/app/node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), undefined);
  assert.equal(classify("E:/app/node_modules/lucide-react/dist/esm/icons/library.js"), undefined);
  assert.equal(classify("E:/app/src/components/BookLibrary.tsx"), undefined);
});

test("PDF 资源插件保留本地 cmaps、标准字体与开发服务器中间件", () => {
  const names: string[] = [];
  const collect = (plugin: PluginOption) => {
    if (Array.isArray(plugin)) {
      plugin.forEach(collect);
      return;
    }
    if (plugin && typeof plugin === "object" && "name" in plugin && typeof plugin.name === "string") names.push(plugin.name);
  };
  for (const plugin of viteConfig.plugins ?? []) collect(plugin);
  assert.ok(names.includes("local-pdf-text-resources"));
});
