import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/AccountPanel.tsx", import.meta.url), "utf8");

test("登录后的账户面板也提供条款与隐私入口", () => {
  const start = source.indexOf("已登录：账户与云同步状态");
  const end = source.indexOf("未登录：登录 / 注册 / 恢复");
  assert.ok(start >= 0, "应能找到已登录面板");
  assert.ok(end > start, "已登录面板应位于未登录表单之前");

  const signedIn = source.slice(start, end);
  assert.match(
    signedIn,
    /<a href="\/terms\.html" target="_blank" rel="noopener noreferrer">/,
    "已登录面板必须提供《服务条款》链接",
  );
  assert.match(
    signedIn,
    /<a href="\/privacy\.html" target="_blank" rel="noopener noreferrer">/,
    "已登录面板必须提供《隐私说明》链接",
  );
  assert.match(signedIn, /《服务条款》/);
  assert.match(signedIn, /《隐私说明》/);
});

test("未登录表单底部的条款链接保持不变", () => {
  const start = source.indexOf("未登录：登录 / 注册 / 恢复");
  const footer = source.slice(start);
  assert.match(footer, /className="account-legal"/);
  assert.match(footer, /href="\/terms\.html"/);
  assert.match(footer, /href="\/privacy\.html"/);
});
