import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchWebSource,
  findVerbatimQuote,
  htmlToReadable,
  isPublicIp,
  validateWebUrl,
  WebFetchError,
} from "../server/web";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

function htmlResponse(html: string, contentType = "text/html; charset=utf-8"): Response {
  return new Response(html, { status: 200, headers: { "content-type": contentType } });
}

test("网页地址只接受公开 HTTPS，拒绝本机、内网、凭据和未知端口", () => {
  assert.throws(
    () => validateWebUrl("http://example.com/page"),
    (error: unknown) => error instanceof WebFetchError && error.code === "https_required",
  );
  for (const url of [
    "https://localhost/page",
    "https://127.0.0.1/page",
    "https://[::1]/page",
    "https://10.0.0.1/page",
    "https://192.168.1.1/page",
    "https://user:pass@example.com/page",
    "https://example.com:8443/page",
  ]) {
    assert.throws(
      () => validateWebUrl(url),
      (error: unknown) => error instanceof WebFetchError && error.status >= 400,
      url,
    );
  }
  assert.equal(validateWebUrl("https://docs.example.com/a", ["example.com"]).hostname, "docs.example.com");
  assert.throws(
    () => validateWebUrl("https://other.example.net/a", ["example.com"]),
    (error: unknown) => error instanceof WebFetchError && error.code === "host_not_allowed",
  );
});

test("公网 IP 判定覆盖回环、私网、链路本地、保留段和 IPv6", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "169.254.10.1",
    "100.64.0.1",
    "198.18.0.1",
    "203.0.113.2",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicIp(address), false, address);
  }
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("93.184.216.34"), true);
  assert.equal(isPublicIp("2001:4860:4860::8888"), true);
});

test("HTML 正文提取移除脚本和样式，并保留标题与段落", () => {
  const { title, text } = htmlToReadable(
    "<html><head><title>测试 &amp; 文档</title><style>.x{color:red}</style></head><body><script>alert(1)</script><h1>标题</h1><p>第一段</p><p>第二段&nbsp;内容</p></body></html>",
  );
  assert.equal(title, "测试 & 文档");
  assert.match(text, /标题/);
  assert.match(text, /第一段/);
  assert.match(text, /第二段 内容/);
  assert.doesNotMatch(text, /alert/);
  assert.doesNotMatch(text, /color:red/);
});

test("逐字引文允许空白差异，但不会返回页面中不存在的内容", () => {
  const page = "第一段内容\n\n第二段内容 和结论";
  assert.equal(findVerbatimQuote(page, "第一段内容"), "第一段内容");
  assert.equal(findVerbatimQuote(page, "第二段内容\n和结论"), "第二段内容 和结论");
  assert.equal(findVerbatimQuote(page, "页面中不存在的说法"), undefined);
});

test("抓取网页返回正文、来源地址、抓取时间和逐字命中引文", async () => {
  const html = "<html><head><title>官方说明</title></head><body><p>规则原文在这里。</p><p>第二段。</p></body></html>";
  const evidence = await fetchWebSource("https://example.com/docs", "规则原文在这里。", {
    allowedHosts: ["example.com"],
    fetchImpl: (async () => htmlResponse(html)) as typeof fetch,
    lookup: publicLookup,
    now: () => new Date("2026-10-25T10:00:00.000Z"),
  });
  assert.equal(evidence.finalUrl, "https://example.com/docs");
  assert.equal(evidence.title, "官方说明");
  assert.equal(evidence.publisher, "example.com");
  assert.equal(evidence.retrievedAt, "2026-10-25T10:00:00.000Z");
  assert.equal(evidence.claim?.matched, true);
  assert.equal(evidence.claim?.quote, "规则原文在这里。");
  assert.match(evidence.text, /规则原文在这里/);
});

test("网页标题也进入可核验正文，标题引文可逐字命中", async () => {
  const evidence = await fetchWebSource("https://example.com/docs", "官方说明", {
    allowedHosts: ["example.com"],
    fetchImpl: (async () => htmlResponse("<html><head><title>官方说明</title></head><body><p>正文。</p></body></html>")) as typeof fetch,
    lookup: publicLookup,
  });
  assert.equal(evidence.claim?.matched, true);
  assert.equal(evidence.claim?.quote, "官方说明");
  assert.match(evidence.text, /^官方说明/);
});

test("引文未命中仍返回网页，但明确标为未命中", async () => {
  const evidence = await fetchWebSource("https://example.com/docs", "页面没有这句话", {
    allowedHosts: ["example.com"],
    fetchImpl: (async () => htmlResponse("<html><body><p>其它内容</p></body></html>")) as typeof fetch,
    lookup: publicLookup,
  });
  assert.equal(evidence.claim?.matched, false);
  assert.equal(evidence.claim?.quote, undefined);
});

test("解析到私网地址时不发起抓取", async () => {
  let calls = 0;
  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      fetchImpl: (async () => {
        calls += 1;
        return htmlResponse("<html><body>不应抓取</body></html>");
      }) as typeof fetch,
      lookup: async () => [{ address: "10.0.0.2", family: 4 }],
    }),
    (error: unknown) => error instanceof WebFetchError && error.code === "private_host",
  );
  assert.equal(calls, 0);
});

test("跳转到本机地址、非网页内容或超限页面都会被拒绝", async () => {
  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      fetchImpl: (async () => new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      })) as typeof fetch,
      lookup: publicLookup,
    }),
    (error: unknown) => error instanceof WebFetchError && error.status === 403,
  );
  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      fetchImpl: (async () => new Response("%PDF", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch,
      lookup: publicLookup,
    }),
    (error: unknown) => error instanceof WebFetchError && error.code === "unsupported_content_type",
  );
  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      maxBytes: 10,
      fetchImpl: (async () => new Response("123456789012345", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch,
      lookup: publicLookup,
    }),
    (error: unknown) => error instanceof WebFetchError && error.code === "page_too_large",
  );
});
