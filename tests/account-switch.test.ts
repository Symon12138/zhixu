import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import type { applyAccountSwitchGate } from "../src/App";
import type { AuthUser } from "../src/types";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let server: ViteDevServer;
let app: { applyAccountSwitchGate: typeof applyAccountSwitchGate };

test.before(async () => {
  server = await createServer({
    root: ROOT,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  app = (await server.ssrLoadModule("/src/App.tsx")) as {
    applyAccountSwitchGate: typeof applyAccountSwitchGate;
  };
});

test.after(async () => {
  await server.close();
});

const OLD_USER: AuthUser = {
  id: "old-user",
  email: "old@example.com",
  name: "旧账户",
  createdAt: 1,
};
const NEW_USER: AuthUser = {
  id: "new-user",
  email: "new@example.com",
  name: "新账户",
  createdAt: 2,
};

test("归档失败时保持旧身份并阻塞切换", () => {
  let authUser: AuthUser | null = OLD_USER;
  let archiveCalls = 0;
  const result = app.applyAccountSwitchGate({
    switching: true,
    hasLocalRecords: true,
    reason: "account-switch",
    archive: () => {
      archiveCalls += 1;
      return null;
    },
    user: NEW_USER,
    setAuthUser: (user) => {
      authUser = user;
    },
  });

  assert.deepEqual(result, { status: "blocked" });
  assert.equal(archiveCalls, 1);
  assert.equal(authUser, OLD_USER);
});

test("归档失败后用户选择丢弃本机数据继续切换，authUser 更新到新账户", () => {
  let authUser: AuthUser | null = OLD_USER;
  let archiveCalls = 0;
  const archive = () => {
    archiveCalls += 1;
    return null;
  };

  const blocked = app.applyAccountSwitchGate({
    switching: true,
    hasLocalRecords: true,
    reason: "account-switch",
    archive,
    user: NEW_USER,
    setAuthUser: (user) => {
      authUser = user;
    },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(authUser, OLD_USER);

  const continued = app.applyAccountSwitchGate({
    switching: true,
    hasLocalRecords: true,
    discardLocalData: true,
    reason: "account-switch",
    archive,
    user: NEW_USER,
    setAuthUser: (user) => {
      authUser = user;
    },
  });

  assert.deepEqual(continued, { status: "proceed", archivedKey: null });
  assert.equal(authUser, NEW_USER);
  // 明确丢弃时跳过归档，不再尝试写入备份键。
  assert.equal(archiveCalls, 1);
});

test("重试成功后继续切换并保留归档键", () => {
  let authUser: AuthUser | null = OLD_USER;
  const archiveResults: (string | null)[] = [null, "zhixu.orphan.account-switch.1"];
  let archiveCalls = 0;
  const archive = () => archiveResults[archiveCalls++];

  const first = app.applyAccountSwitchGate({
    switching: true,
    hasLocalRecords: true,
    reason: "account-switch",
    archive,
    user: NEW_USER,
    setAuthUser: (user) => {
      authUser = user;
    },
  });
  assert.equal(first.status, "blocked");
  assert.equal(authUser, OLD_USER);

  const retried = app.applyAccountSwitchGate({
    switching: true,
    hasLocalRecords: true,
    reason: "account-switch",
    archive,
    user: NEW_USER,
    setAuthUser: (user) => {
      authUser = user;
    },
  });
  assert.deepEqual(retried, {
    status: "proceed",
    archivedKey: "zhixu.orphan.account-switch.1",
  });
  assert.equal(authUser, NEW_USER);
  assert.equal(archiveCalls, 2);
});

test("归档失败提示提供重试与丢弃两个明确出口", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /applyAccountSwitchGate\(\{/);
  assert.match(source, /discardLocalData: true/);
  assert.match(source, /旧本机学习记录无法建立安全备份/);
  assert.match(source, /重试/);
  assert.match(source, /丢弃本机数据并继续切换/);
});
