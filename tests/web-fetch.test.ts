import assert from "node:assert/strict";
import type { LookupAddress, LookupOptions } from "node:dns";
import test from "node:test";
import {
  createPinnedLookup,
  fetchWebSource,
  WebFetchError,
  type PinnedLookup,
  type WebAddress,
  type WebFetchTransport,
} from "../server/web";

const PUBLIC: WebAddress = { address: "93.184.216.34", family: 4 };
const publicLookup = async () => [PUBLIC];

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function isWebFetchError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof WebFetchError &&
    error.status === status &&
    error.code === code &&
    error.message.length > 0;
}

function callPinnedLookup(
  pinned: PinnedLookup,
  options: LookupOptions,
): Promise<string | LookupAddress[]> {
  const { promise, resolve, reject } = Promise.withResolvers<string | LookupAddress[]>();
  pinned("rebind.example", options, (error, address) => {
    if (error) reject(error);
    else resolve(address);
  });
  return promise;
}

/* ── 超时映射：请求阶段与正文读取阶段都不能落成通用 500 ───────────────── */

test("响应头阶段超时（HEAD/GET 共用的请求阶段）返回 504 可重试错误", async () => {
  const failures: unknown[] = [
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    new DOMException("This operation was aborted", "AbortError"),
    // undici 常把底层超时包在 cause 里，同样必须识别。
    new Error("fetch failed", { cause: new DOMException("timeout", "TimeoutError") }),
  ];
  for (const failure of failures) {
    await assert.rejects(
      fetchWebSource("https://example.com/docs", undefined, {
        allowedHosts: ["example.com"],
        lookup: publicLookup,
        timeoutMs: 50,
        fetchImpl: (async () => {
          throw failure;
        }) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof WebFetchError);
        assert.equal(error.status, 504);
        assert.equal(error.code, "fetch_timeout");
        assert.match(error.message, /超时/);
        assert.match(error.message, /重试/);
        return true;
      },
    );
  }
});

test("DNS 解析超过总时限时返回 504，且不会继续连接", async () => {
  let transports = 0;
  const transport: WebFetchTransport = async () => {
    transports += 1;
    return htmlResponse("<html><body>不应抓取</body></html>");
  };

  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      lookup: () => new Promise<WebAddress[]>(() => undefined),
      transport,
      timeoutMs: 20,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebFetchError);
      assert.equal(error.status, 504);
      assert.equal(error.code, "fetch_timeout");
      return true;
    },
  );
  assert.equal(transports, 0);
});

test("正文读取阶段超时返回 504 可重试错误，而不是通用 500", async () => {
  let abortedReads = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = () => {
          abortedReads += 1;
          controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }) as typeof fetch;

  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      lookup: publicLookup,
      timeoutMs: 30,
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof WebFetchError);
      assert.equal(error.status, 504);
      assert.equal(error.code, "fetch_timeout");
      assert.match(error.message, /重试/);
      return true;
    },
  );
  assert.equal(abortedReads, 1);
});

test("正文读取被连接中断（非超时）返回 502，而不是通用 500", async () => {
  const fetchImpl = (async (): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;

  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      lookup: publicLookup,
      fetchImpl,
    }),
    isWebFetchError(502, "body_read_failed"),
  );
});

/* ── DNS 校验与连接之间的 TOCTOU ─────────────────────────────────────── */

/*
 * 防护边界：生产默认传输层把预校验地址交给 https.request 的 lookup，连接阶段不会再次解析 DNS，
 * 因此“第一次公网、第二次内网”的重绑定没有生效窗口。
 * 测试无法在离线环境搭建带可信证书的 HTTPS 站点，所以这里验证两件事：
 *   1) 抓取只解析一次 DNS，且传给连接层的只有第一次校验通过的地址；
 *   2) 连接 lookup 本身只返回预校验地址，并拒绝任何内网地址。
 * 仅测试注入的 transport/fetchImpl 路径不经过固定 lookup，不具备该保证（生产不会走该路径）。
 */

test("连接 lookup 只返回已校验地址，不会再次查询 DNS", async () => {
  const addresses: WebAddress[] = [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ];
  const pinned = createPinnedLookup(addresses);
  assert.deepEqual(await callPinnedLookup(pinned, { all: true }), addresses);
  assert.deepEqual(await callPinnedLookup(pinned, { all: false }), "93.184.216.34");
  assert.throws(() => createPinnedLookup([]), /至少一个已校验地址/);
  assert.throws(
    () => createPinnedLookup([{ address: "10.0.0.2", family: 4 }]),
    (error: unknown) =>
      error instanceof WebFetchError && error.status === 403 && error.code === "private_host",
  );
});

test("恶意域名首次解析公网、二次解析内网时，抓取只使用首次校验的地址", async () => {
  let lookups = 0;
  const rebindingLookup = async (): Promise<WebAddress[]> => {
    lookups += 1;
    return lookups === 1
      ? [PUBLIC]
      : [{ address: "10.0.0.2", family: 4 }];
  };
  let transports = 0;
  const transport: WebFetchTransport = async (_url, addresses) => {
    transports += 1;
    // 连接阶段拿到的必须是第一次解析并校验过的公网地址；
    // 默认传输层会用 createPinnedLookup 把它固定成 socket 的目标，不会触发第二次解析。
    assert.deepEqual(addresses, [PUBLIC]);
    return htmlResponse("<html><body><p>公开页面正文</p></body></html>");
  };

  const evidence = await fetchWebSource("https://example.com/docs", undefined, {
    allowedHosts: ["example.com"],
    lookup: rebindingLookup,
    transport,
  });

  assert.equal(lookups, 1, "解析只能发生在校验阶段");
  assert.equal(transports, 1);
  assert.match(evidence.text, /公开页面正文/);
});

test("跳转后的第二次解析变成内网时同样拒绝抓取", async () => {
  let lookups = 0;
  const rebindingLookup = async (): Promise<WebAddress[]> => {
    lookups += 1;
    return lookups === 1 ? [PUBLIC] : [{ address: "10.0.0.2", family: 4 }];
  };
  let transportCalls = 0;
  const transport: WebFetchTransport = async () => {
    transportCalls += 1;
    return new Response(null, { status: 302, headers: { location: "/next" } });
  };

  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      lookup: rebindingLookup,
      transport,
    }),
    isWebFetchError(403, "private_host"),
  );
  assert.equal(transportCalls, 1);
  assert.equal(lookups, 2);
});

test("首次解析就是内网时不会调用传输层（连接前拦截）", async () => {
  let transports = 0;
  const transport: WebFetchTransport = async () => {
    transports += 1;
    return htmlResponse("<html><body>不应抓取</body></html>");
  };
  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      lookup: async () => [{ address: "192.168.1.10", family: 4 }],
      transport,
    }),
    isWebFetchError(403, "private_host"),
  );
  assert.equal(transports, 0);
});

test("同一域名解析结果混有公网与内网地址时整体拒绝", async () => {
  let transports = 0;
  const transport: WebFetchTransport = async () => {
    transports += 1;
    return htmlResponse("<html><body>不应抓取</body></html>");
  };
  await assert.rejects(
    fetchWebSource("https://example.com/docs", undefined, {
      allowedHosts: ["example.com"],
      lookup: async () => [
        PUBLIC,
        { address: "::1", family: 6 },
      ],
      transport,
    }),
    isWebFetchError(403, "private_host"),
  );
  assert.equal(transports, 0);
});
