import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../server/index";
import { ZhixuDatabase } from "../server/db";

/* ── /api/version：构建版本与发布说明链接（L2 更新提示基座） ───── */

const config = {
  production: false,
  port: 3001,
  host: "127.0.0.1",
  authRequired: false,
  allowByok: true,
  cookieSecure: false,
  publicOrigin: null,
  trustProxy: false,
  quotas: { chatPerDay: 40, diagnosticPerDay: 10, reviewPerDay: 30 },
  maxConcurrentAi: 2,
  auditRetentionDays: 90,
  usageRetentionDays: 90,
  byokAllowedOrigins: [] as string[],
  allowInsecureLocal: false,
  dataDir: "",
};

test("/api/version 返回 package.json 版本与发布链接，不含机密", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixu-version-"));
  const db = new ZhixuDatabase(path.join(dir, "zhixu.db"));
  const app = createApp({ config, db, serveStatic: false });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version: string;
      name: string;
      releaseNotes: string;
      time: number;
    };
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(body.version, pkg.version);
    assert.equal(body.name, "zhixu");
    assert.equal(body.releaseNotes, "https://github.com/Symon12138/zhixu/releases");
    assert.equal(typeof body.time, "number");
    // 响应不含任何密钥/机密字段。
    const raw = JSON.stringify(body);
    assert.ok(!/key|secret|token/i.test(raw.replace(/releaseNotes/, "")), "版本响应不应包含密钥字段");
  } finally {
    server.close();
    db.close?.();
  }
});
