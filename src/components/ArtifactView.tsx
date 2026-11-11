import { useMemo, useState } from "react";
import { ARTIFACT_MAX_BYTES, type LessonArtifact } from "../types";

/**
 * 安全边界：模型生成的可视化内容一律视为不可信输入。
 * SVG 走白名单清洗后以 dangerouslySetInnerHTML 内联；
 * HTML 放进无 allow-same-origin、无网络权限的 sandbox iframe 的 srcdoc。
 *
 * 清洗器是纯字符串实现（无 DOM / 无第三方依赖），因此浏览器与 Node 测试结果一致：
 * 解析 -> 丢弃危险子树 -> 按白名单重建标签/属性 -> 转义文本。
 * 输出全部由本模块重新构造，绝不回显原始标签字符串。
 */

/** 允许保留的 SVG 元素白名单（教学图形常用子集），键为小写标签名。 */
const ALLOWED_SVG_ELEMENTS: Record<string, true> = {
  svg: true, g: true, defs: true, title: true, desc: true, symbol: true, use: true,
  path: true, rect: true, circle: true, ellipse: true, line: true, polyline: true, polygon: true,
  text: true, tspan: true, textpath: true, marker: true, clippath: true, mask: true, pattern: true,
  lineargradient: true, radialgradient: true, stop: true, image: true,
};

/** 明确禁止的元素：脚本、外嵌 HTML、动画、外部资源、样式表。命中即连同子树删除。 */
const FORBIDDEN_SVG_ELEMENTS: Record<string, true> = {
  script: true, foreignobject: true, iframe: true, object: true, embed: true,
  link: true, meta: true, style: true, set: true, animate: true, animatemotion: true,
  animatetransform: true, handler: true, audio: true, video: true, canvas: true,
};

/** 允许保留的属性白名单，键为小写属性名；on*、style、外部 href/src 均不在此列。 */
const ALLOWED_SVG_ATTRIBUTES: Record<string, true> = {
  id: true, class: true, transform: true, viewbox: true, version: true,
  width: true, height: true, x: true, y: true, x1: true, y1: true, x2: true, y2: true,
  cx: true, cy: true, r: true, rx: true, ry: true, d: true, points: true,
  fill: true, "fill-opacity": true, "fill-rule": true, stroke: true, "stroke-width": true,
  "stroke-linecap": true, "stroke-linejoin": true, "stroke-dasharray": true,
  "stroke-dashoffset": true, "stroke-opacity": true, opacity: true,
  "font-family": true, "font-size": true, "font-weight": true, "font-style": true,
  "text-anchor": true, "dominant-baseline": true, "letter-spacing": true,
  "marker-start": true, "marker-mid": true, "marker-end": true,
  markerwidth: true, markerheight: true, orient: true, refx: true, refy: true,
  "clip-path": true, "clip-rule": true, mask: true, filter: true,
  offset: true, "stop-color": true, "stop-opacity": true,
  gradientunits: true, gradienttransform: true, spreadmethod: true,
  preserveaspectratio: true, patternunits: true, patterncontentunits: true,
  patterntransform: true, startoffset: true, textlength: true, lengthadjust: true,
  "alignment-baseline": true, "baseline-shift": true,
  display: true, visibility: true, overflow: true, color: true, "aria-label": true, role: true,
};

interface Attr { name: string; value: string }
type Token =
  | { t: "open"; name: string; attrs: Attr[]; self: boolean }
  | { t: "close"; name: string }
  | { t: "text"; text: string }
  | { t: "drop" };

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
    (_match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex) return String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff));
      if (dec) return String.fromCodePoint(Math.min(parseInt(dec, 10), 0x10ffff));
      return named === "amp" ? "&" : named === "lt" ? "<" : named === "gt" ? ">" : named === "quot" ? '"' : "'";
    },
  );
}

function parseAttrs(source: string): Attr[] {
  const attrs: Attr[] = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1];
    if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name)) continue;
    attrs.push({ name, value: match[2] ?? match[3] ?? match[4] ?? "" });
  }
  return attrs;
}

/** href/xlink:href/src 只允许本地片段引用（#id），阻断一切外部/可执行 URL。 */
function safeLocalRef(value: string): boolean {
  const v = value.trim();
  if (v.startsWith("#")) return true;
  if (/^url\(\s*['"]?#/i.test(v)) return true; // fill="url(#grad)"
  return false;
}

function cleanAttrs(attrs: Attr[]): string {
  const kept: string[] = [];
  for (const { name, value } of attrs) {
    const lower = name.toLowerCase();
    if (/^on/i.test(name)) continue;          // onload / onclick / on* 事件
    if (lower === "style") continue;           // CSS 里可能夹带外链/expression
    if (lower === "src") continue;             // 外部图片
    if (lower === "xmlns" || lower.startsWith("xmlns:")) continue; // 命名空间声明统一丢弃
    if (lower === "href" || lower.endsWith(":href")) {
      if (!safeLocalRef(value)) continue;      // 只允许 #fragment
    } else if (!ALLOWED_SVG_ATTRIBUTES[lower]) {
      continue;
    }
    // 属性值兜底：任何可执行协议、CSS 表达式、外部 url() 整条丢弃。
    if (/(?:javascript|data|vbscript)\s*:/i.test(value)
      || /expression\s*\(/i.test(value)
      || /@import/i.test(value)
      || /url\s*\(\s*['"]?\s*(?:https?:|\/\/)/i.test(value)) continue;
    kept.push(`${name}="${escapeHtml(value)}"`);
  }
  return kept.length ? ` ${kept.join(" ")}` : "";
}

/** 把 SVG 字符串切成标签/文本流；危险元素（含 script）整棵子树在读串阶段就跳过。 */
function tokenizeSvg(input: string): Token[] {
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    if (input[i] !== "<") {
      const next = input.indexOf("<", i);
      const end = next === -1 ? n : next;
      tokens.push({ t: "text", text: input.slice(i, end) });
      i = end;
      continue;
    }
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      tokens.push({ t: "drop" });
      continue;
    }
    if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i + 9);
      i = end === -1 ? n : end + 3;
      tokens.push({ t: "drop" });
      continue;
    }
    if (input.startsWith("<!", i) || input.startsWith("<?", i)) {
      const end = input.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      tokens.push({ t: "drop" });
      continue;
    }
    if (input.startsWith("</", i)) {
      const end = input.indexOf(">", i);
      if (end === -1) break;
      const raw = input.slice(i + 2, end).trim().split(/\s/)[0].toLowerCase();
      if (raw) tokens.push({ t: "close", name: raw });
      i = end + 1;
      continue;
    }
    // 开标签：找 '>' 但忽略引号内的 '>'。
    let j = i + 1;
    let quote = "";
    while (j < n) {
      const c = input[j];
      if (quote) { if (c === quote) quote = ""; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j += 1;
    }
    if (j >= n) { tokens.push({ t: "text", text: input.slice(i) }); break; }
    const inner = input.slice(i + 1, j);
    const self = /\/\s*$/.test(inner);
    const body = inner.replace(/\/\s*$/, "").trim();
    const nameMatch = body.match(/^([^\s/>]+)/);
    const rawName = nameMatch ? nameMatch[1] : "";
    const name = rawName.toLowerCase();
    i = j + 1;
    if (!name) continue;
    if (!ALLOWED_SVG_ELEMENTS[name] || FORBIDDEN_SVG_ELEMENTS[name]) {
      // 危险/未知元素：自闭合直接丢，否则读到其闭合标签为止（内容整体视为不透明）。
      if (!self) {
        const close = new RegExp(`</\\s*${name}\\s*>`, "i").exec(input.slice(i));
        i = close ? i + close.index + close[0].length : n;
      }
      tokens.push({ t: "drop" });
      continue;
    }
    tokens.push({ t: "open", name, attrs: parseAttrs(body.slice(rawName.length)), self });
  }
  return tokens;
}

/** 按白名单重建 SVG：只输出本模块构造的标签，文本内容统一转义。 */
function rebuildSvg(tokens: Token[]): string {
  let out = "";
  const openStack: string[] = [];
  for (const token of tokens) {
    if (token.t === "drop") continue;
    if (token.t === "text") { out += escapeHtml(decodeEntities(token.text)); continue; }
    if (token.t === "close") {
      const index = openStack.lastIndexOf(token.name);
      if (index >= 0) {
        for (let k = openStack.length - 1; k >= index; k -= 1) out += `</${openStack[k]}>`;
        openStack.length = index;
      }
      continue;
    }
    if (token.self) {
      out += `<${token.name}${cleanAttrs(token.attrs)}/>`;
    } else {
      out += `<${token.name}${cleanAttrs(token.attrs)}>`;
      openStack.push(token.name);
    }
  }
  for (let k = openStack.length - 1; k >= 0; k -= 1) out += `</${openStack[k]}>`;
  return out;
}

/** 清洗 SVG（纯函数，浏览器与 Node 通用）；结构非法或超限时返回 null 触发文本回退。 */
export function sanitizeSvg(input: string): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  if (new TextEncoder().encode(input).length > ARTIFACT_MAX_BYTES) return null;
  const tokens = tokenizeSvg(input);
  const first = tokens.find((token) => token.t === "open" || token.t === "close");
  if (!first || first.t !== "open" || first.name !== "svg") return null;
  const cleaned = rebuildSvg(tokens);
  return cleaned.startsWith("<svg") ? cleaned : null;
}

/**
 * HTML 离线沙箱文档：模型内容包进带 CSP 的独立文档。
 * iframe 使用 sandbox=""（无 allow-same-origin / 无 allow-scripts），叠加 CSP 做纵深防御。
 */
export const IFRAME_SANDBOX = "";
export const IFRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none';";

export function buildHtmlSrcdoc(content: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "</head><body>",
    content,
    "</body></html>",
  ].join("");
}

/** 导出用独立 HTML：自包含、离线可打开，带同样 CSP，不含任何外部依赖。 */
export function buildStandaloneExport(artifact: LessonArtifact): string {
  const body = artifact.kind === "svg"
    ? (sanitizeSvg(artifact.content) ?? `<p>${escapeHtml(artifact.textAlternative)}</p>`)
    : artifact.content;
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">`,
    `<title>${escapeHtml(artifact.title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;margin:1.5rem;line-height:1.6;max-width:900px}</style>",
    "</head><body>",
    `<h1>${escapeHtml(artifact.title)}</h1>`,
    artifact.kind === "html" ? body : `<figure>${body}</figure>`,
    `<section><h2>文本替代</h2><p>${escapeHtml(artifact.textAlternative)}</p>`,
    ...(artifact.sources.length
      ? [`<h2>来源</h2><ul>${artifact.sources.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`]
      : []),
    "</section></body></html>",
  ].join("");
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function ArtifactView({ artifact }: { artifact: LessonArtifact }) {
  const [failed, setFailed] = useState(false);
  const svg = useMemo(
    () => (artifact.kind === "svg" ? sanitizeSvg(artifact.content) : null),
    [artifact.kind, artifact.content],
  );
  const srcdoc = useMemo(
    () => (artifact.kind === "html" ? buildHtmlSrcdoc(artifact.content) : ""),
    [artifact.kind, artifact.content],
  );
  const overLimit = new TextEncoder().encode(artifact.content).length > ARTIFACT_MAX_BYTES;
  // SVG 清洗失败或 HTML iframe 报错：回退到文本替代（纯文字，不再尝试渲染）。
  const fallback = failed || overLimit || (artifact.kind === "svg" && !svg);

  return (
    <section className="artifact-view" aria-label={`可视化：${artifact.title}`}>
      <header className="artifact-head">
        <strong>{artifact.title}</strong>
        <button
          type="button"
          className="text-button"
          onClick={() => download(`zhixu-artifact-${Date.now()}.html`, buildStandaloneExport(artifact))}
        >
          导出离线 HTML
        </button>
      </header>

      {fallback ? (
        <div className="artifact-fallback" role="status">
          <p>此可视化无法安全渲染，已回退为文字讲解：</p>
          <p>{artifact.textAlternative}</p>
        </div>
      ) : artifact.kind === "svg" ? (
        <div
          className="artifact-svg"
          // 内容已按白名单重建，不含 script / 事件属性 / 外部引用。
          dangerouslySetInnerHTML={{ __html: svg! }}
        />
      ) : (
        <iframe
          className="artifact-frame"
          title={artifact.title}
          sandbox={IFRAME_SANDBOX}
          srcDoc={srcdoc}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}

      <div className="artifact-alt">
        <h4>文本替代</h4>
        <p>{artifact.textAlternative}</p>
      </div>
      {artifact.sources.length > 0 && (
        <div className="artifact-sources">
          <h4>来源</h4>
          <ul>{artifact.sources.map((source, index) => <li key={index}>{source}</li>)}</ul>
        </div>
      )}
    </section>
  );
}
