import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { classifySourceTier } from "./sourceTier";
import type { WebSourceTier } from "../src/types";

/**
 * 指定网页来源核验。只抓取公开 HTTPS 页面，返回正文与可选逐字命中的引文。
 * 这里不判断“事实是否正确”，只建立“这段文字确实出现在抓取页面中”的证据。
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT = 60_000;
const MAX_REDIRECTS = 3;
const MAX_CLAIM_CHARS = 1_000;

const WEB_FETCH_HEADERS: Record<string, string> = {
  Accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8",
  "User-Agent": "ZhixuWebVerify/1.0 (source verification; no login, no cookies)",
};

export interface WebAddress {
  address: string;
  family: number;
}

export interface WebFetchRequestInit {
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  signal: AbortSignal;
}

export type PinnedLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/**
 * 传输层：只接收预先解析并校验过的地址，连接时不得再次查询 DNS；
 * 也不得自动跟随跳转（上层会逐跳重新校验目标）。
 * `addresses` 与 HTTP 请求分开传入，避免“校验用一次解析、连接又用下一次解析”的借道。
 */
export type WebFetchTransport = (
  url: URL,
  addresses: WebAddress[],
  init: WebFetchRequestInit,
) => Promise<Response>;

export class WebFetchError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}

export interface WebSourceEvidence {
  url: string;
  finalUrl: string;
  title: string;
  publisher: string;
  text: string;
  truncated: boolean;
  retrievedAt: string;
  sourceTier: WebSourceTier;
  claim?: { text: string; matched: boolean; quote?: string };
}

export interface WebFetchOptions {
  /**
   * 仅用于测试/工具注入的 fetch 实现。该路径无法固定连接地址，
   * 生产抓取默认走下面的 `transport`，由它使用已校验的地址建立 HTTPS 连接。
   */
  fetchImpl?: typeof fetch;
  /** 连接已固定地址的传输层；默认实现不会再查询 DNS。 */
  transport?: WebFetchTransport;
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
  allowedHosts?: string[];
  maxBytes?: number;
  maxTextChars?: number;
  /** 单次抓取（DNS 解析、连接与正文读取）的总时限；默认读环境变量。 */
  timeoutMs?: number;
  now?: () => Date;
}

export function webFetchEnabled(): boolean {
  return process.env.ZHIXU_WEB_FETCH?.trim().toLowerCase() === "true";
}

export function webAllowedHosts(): string[] {
  return (process.env.ZHIXU_WEB_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function webFetchLimits(): { maxBytes: number; maxTextChars: number } {
  return {
    maxBytes: envInt("ZHIXU_WEB_MAX_BYTES", DEFAULT_MAX_BYTES, 64_000, 5_000_000),
    maxTextChars: envInt("ZHIXU_WEB_MAX_TEXT", DEFAULT_MAX_TEXT, 5_000, 200_000),
  };
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function hostIsAllowed(hostname: string, allowedHosts: string[]): boolean {
  if (!allowedHosts.length) return true;
  return allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function ipv4IsPublic(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  return true;
}

export function isPublicIp(address: string): boolean {
  const bare = address.split("%")[0];
  const family = isIP(bare);
  if (family === 4) return ipv4IsPublic(bare);
  if (family !== 6) return false;
  const lower = bare.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    return isIP(mapped) === 4 && ipv4IsPublic(mapped);
  }
  const first = lower.split(":")[0];
  if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return false;
  if (/^fe[89ab][0-9a-f]?$/.test(first)) return false;
  if (/^ff[0-9a-f]{0,2}$/.test(first)) return false;
  if (lower.startsWith("2001:db8:")) return false;
  if (lower.startsWith("2001:10:") || lower.startsWith("2001:20:")) return false;
  return true;
}

/** Reject non-HTTPS, private hosts, credentials and disallowed hostnames before any network call. */
export function validateWebUrl(raw: string, allowedHosts = webAllowedHosts()): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebFetchError(400, "invalid_url", "网页地址不是合法 URL。");
  }
  if (url.protocol !== "https:") {
    throw new WebFetchError(400, "https_required", "联网核验只允许公开 HTTPS 网页。");
  }
  if (url.username || url.password) {
    throw new WebFetchError(400, "credentials_not_allowed", "网页地址不能包含用户名或密码。");
  }
  if (url.port && url.port !== "443") {
    throw new WebFetchError(403, "port_not_allowed", "联网核验只允许 HTTPS 默认端口。");
  }
  const hostname = normalizeHost(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new WebFetchError(403, "private_host", "不能抓取本机、内网或私有地址。");
  }
  if (isIP(hostname) && !isPublicIp(hostname)) {
    throw new WebFetchError(403, "private_host", "不能抓取本机、内网或私有地址。");
  }
  if (!hostIsAllowed(hostname, allowedHosts)) {
    throw new WebFetchError(403, "host_not_allowed", "该网页域名不在服务端允许列表内。");
  }
  return url;
}

function resolveRedirectUrl(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch {
    throw new WebFetchError(502, "bad_redirect", "网页返回了无法解析的跳转地址。");
  }
}

async function resolvePublicHost(
  hostname: string,
  lookup: NonNullable<WebFetchOptions["lookup"]>,
): Promise<WebAddress[]> {
  const host = normalizeHost(hostname);
  if (isIP(host)) {
    if (!isPublicIp(host)) throw new WebFetchError(403, "private_host", "不能抓取本机、内网或私有地址。");
    return [{ address: host, family: isIP(host) }];
  }
  let records: WebAddress[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new WebFetchError(502, "dns_failed", "无法解析网页域名。");
  }
  if (!Array.isArray(records) || !records.length) throw new WebFetchError(502, "dns_failed", "网页域名没有可用地址。");
  if (records.some((record) => !record || typeof record.address !== "string" || !isPublicIp(record.address))) {
    throw new WebFetchError(403, "private_host", "网页域名解析到本机或内网地址，已拒绝抓取。");
  }
  return records.map((record) => ({ address: record.address, family: isIP(record.address) }));
}

/**
 * 连接阶段的 lookup：只返回上面已经解析并校验过的地址，绝不再查询 DNS。
 * 因此恶意域名即使第二次解析到内网，也无法改变实际连接目标，消除了校验与连接之间的 TOCTOU。
 * 注意：只有默认 HTTPS 传输层会使用它；`fetchImpl` 是测试注入口，不具备这个保证。
 */
export function createPinnedLookup(addresses: WebAddress[]): PinnedLookup {
  if (!addresses.length) throw new Error("createPinnedLookup 需要至少一个已校验地址。");
  const pinned = addresses.map((item) => {
    // 防御性复核：真正用于连接的目标必须仍是公网地址，绝不因上游传参错误而连内网。
    if (!isPublicIp(item.address)) {
      throw new WebFetchError(403, "private_host", "网页域名解析到本机或内网地址，已拒绝抓取。");
    }
    return { address: item.address, family: item.family };
  });
  return (_hostname, options, callback) => {
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const usable = family === 4 || family === 6 ? pinned.filter((item) => item.family === family) : pinned;
    const chosen = usable.length ? usable : pinned;
    if (options.all) {
      callback(null, chosen.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    callback(null, chosen[0].address, chosen[0].family);
  };
}

function decodeBodyStream(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
  if (!decoder) return response;
  const decoded = response.pipe(decoder);
  // pipe 不会转发源错误；不补这一下，超时中止可能让解码流“静默结束”。
  response.once("error", (error) => decoded.destroy(error));
  // 取消解码流（跳转、超限、超时）时同步销毁源响应，避免底层连接悬挂。
  decoded.once("close", () => {
    if (!response.destroyed) response.destroy();
  });
  return decoded;
}

function toWebResponse(incoming: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
      continue;
    }
    headers.set(name, value);
  }
  const status = incoming.statusCode ?? 502;
  const body =
    status === 204 || status === 304
      ? null
      : (Readable.toWeb(decodeBodyStream(incoming)) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, {
    status,
    statusText: incoming.statusMessage ?? "",
    headers,
  });
}

/**
 * 默认传输层：TLS 证书校验与 SNI 保持 Node 默认（绝不放宽），
 * 但 TCP 连接只使用 `addresses` 中已校验的地址。
 */
function requestPinned(url: URL, addresses: WebAddress[], init: WebFetchRequestInit): Promise<Response> {
  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  const request = httpsRequest(
    {
      protocol: "https:",
      hostname: normalizeHost(url.hostname),
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: {
        ...init.headers,
        Host: url.host,
        "Accept-Encoding": "gzip, deflate, br",
      },
      // 不启用连接池：每次请求都通过固定的 lookup 新建连接。
      agent: false,
      lookup: createPinnedLookup(addresses),
      // 明确保持证书校验开启，绝不因为自建传输层而放宽 HTTPS 规则。
      rejectUnauthorized: true,
      signal: init.signal,
    },
    (incoming) => {
      try {
        resolve(toWebResponse(incoming));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    },
  );
  request.once("error", reject);
  request.end();
  return promise;
}

function isAbortFailure(error: unknown, depth = 0): boolean {
  if (depth > 3 || !error || typeof error !== "object") return false;
  const { name, cause } = error as { name?: unknown; cause?: unknown };
  if (name === "AbortError" || name === "TimeoutError") return true;
  return isAbortFailure(cause, depth + 1);
}

/** 让解析阶段也受总时限约束；解析本身无法取消，但超时后绝不再发起连接。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  }
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => {
    aborted.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

/** 网络层失败统一映射：超时是可重试的 504，正文中断是 502，绝不落到通用 500。 */
function networkFailure(error: unknown, phase: "request" | "body", signal?: AbortSignal): WebFetchError {
  if (error instanceof WebFetchError) return error;
  if (signal?.aborted || isAbortFailure(error)) {
    return new WebFetchError(504, "fetch_timeout", "网页抓取超时，请稍后重试。");
  }
  return phase === "body"
    ? new WebFetchError(502, "body_read_failed", "网页正文读取中断，请稍后重试。")
    : new WebFetchError(502, "fetch_failed", "无法连接网页，请检查地址或稍后重试。");
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", copy: "©", reg: "®",
    hellip: "…", mdash: "—", ndash: "–", middot: "·", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, token: string) => {
    if (token.startsWith("#")) {
      const hex = token[1]?.toLowerCase() === "x";
      const code = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return named[token.toLowerCase()] ?? whole;
  });
}

export function htmlToReadable(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt)>/gi, "\n");
  const text = decodeEntities(withoutHidden.replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal match with whitespace tolerance; the returned quote is copied from the page, not invented. */
export function findVerbatimQuote(text: string, claim: string): string | undefined {
  const cleaned = claim.trim();
  if (!cleaned) return undefined;
  const exact = text.indexOf(cleaned);
  if (exact >= 0) return text.slice(exact, exact + cleaned.length);
  const pattern = cleaned.split(/\s+/).map(escapeRegExp).join("\\s+");
  const match = text.match(new RegExp(pattern));
  return match?.[0];
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebFetchError(413, "page_too_large", `网页内容超过 ${maxBytes} 字节上限。`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new WebFetchError(413, "page_too_large", `网页内容超过 ${maxBytes} 字节上限。`);
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function decodeContent(bytes: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchWebSource(
  rawUrl: string,
  rawClaim?: string,
  options: WebFetchOptions = {},
): Promise<WebSourceEvidence> {
  const claim = rawClaim?.trim() ?? "";
  if (claim.length > MAX_CLAIM_CHARS) {
    throw new WebFetchError(400, "claim_too_long", `要核验的原文不能超过 ${MAX_CLAIM_CHARS} 字符。`);
  }
  const allowedHosts = options.allowedHosts ?? webAllowedHosts();
  const lookup = options.lookup ?? dnsLookup;
  const maxBytes = options.maxBytes ?? webFetchLimits().maxBytes;
  const maxTextChars = options.maxTextChars ?? webFetchLimits().maxTextChars;
  const now = options.now ?? (() => new Date());
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? envInt("ZHIXU_WEB_TIMEOUT_MS", 15_000, 3_000, 30_000)));

  let current = validateWebUrl(rawUrl, allowedHosts);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    // 超时覆盖本次跳转的解析、连接与正文读取全过程（与原来 fetch 的 signal 语义一致）。
    const signal = AbortSignal.timeout(timeoutMs);
    // 每次跳转都重新解析并校验；随后连接只能使用这批已校验地址。
    let addresses: WebAddress[];
    try {
      addresses = await abortable(resolvePublicHost(current.hostname, lookup), signal);
    } catch (error) {
      throw networkFailure(error, "request", signal);
    }
    const init: WebFetchRequestInit = { method: "GET", headers: WEB_FETCH_HEADERS, signal };
    let response: Response;
    try {
      response = options.transport
        ? await options.transport(current, addresses, init)
        : options.fetchImpl
          ? await options.fetchImpl(current.toString(), { ...init, redirect: "manual" })
          : await requestPinned(current, addresses, init);
    } catch (error) {
      throw networkFailure(error, "request", signal);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new WebFetchError(502, "bad_redirect", "网页返回了缺少目标地址的跳转。");
      if (redirect === MAX_REDIRECTS) throw new WebFetchError(502, "too_many_redirects", "网页跳转次数过多。");
      current = validateWebUrl(resolveRedirectUrl(location, current).toString(), allowedHosts);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebFetchError(502, "http_error", `网页返回 HTTP ${response.status}，无法建立来源。`);
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!/^(?:text\/html|text\/plain|application\/xhtml\+xml)\b/.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new WebFetchError(415, "unsupported_content_type", "只支持 HTML 或纯文本网页。");
    }
    // 正文读取阶段同样受 timeoutMs 约束：超时/中断必须映射为可重试的明确错误。
    let bytes: Uint8Array;
    try {
      bytes = await readLimited(response, maxBytes);
    } catch (error) {
      throw networkFailure(error, "body", signal);
    }
    // 某些连接被中止时流会“正常结束”并留下截断正文；此时按超时处理，绝不提交残缺证据。
    if (signal.aborted) throw new WebFetchError(504, "fetch_timeout", "网页抓取超时，请稍后重试。");
    const body = decodeContent(bytes, contentType);
    const readable = contentType.startsWith("text/plain")
      ? { title: "", text: body.trim() }
      : htmlToReadable(body);
    if (!readable.text) throw new WebFetchError(422, "empty_page", "网页没有可读取的正文。");
    const fullText = readable.title ? `${readable.title}\n\n${readable.text}` : readable.text;
    const quote = claim ? findVerbatimQuote(fullText, claim) : undefined;
    let text = fullText.slice(0, maxTextChars);
    const truncated = fullText.length > text.length;
    if (quote && !text.includes(quote)) {
      const marker = `\n\n[核验引文]\n${quote}`;
      text = `${text.slice(0, Math.max(0, maxTextChars - marker.length))}${marker}`;
    }
    return {
      url: validateWebUrl(rawUrl, allowedHosts).toString(),
      finalUrl: current.toString(),
      title: readable.title || current.hostname,
      publisher: current.hostname,
      text,
      truncated,
      retrievedAt: now().toISOString(),
      sourceTier: classifySourceTier(current.toString()),
      ...(claim ? { claim: { text: claim, matched: Boolean(quote), ...(quote ? { quote } : {}) } } : {}),
    };
  }
  throw new WebFetchError(502, "too_many_redirects", "网页跳转次数过多。");
}
