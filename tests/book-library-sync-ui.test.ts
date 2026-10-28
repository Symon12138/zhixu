import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/BookLibrary.tsx", import.meta.url), "utf8");

test("书架订阅同步状态并在卡片上展示徽标", () => {
  assert.match(source, /onBookSyncChange\(/, "书架必须订阅上传状态变化");
  assert.match(source, /listBookSyncStates\(\)/, "书架加载时必须读取每本书的同步状态");
  assert.match(
    source,
    /\{showSyncBadges && <BookSyncBadge state=\{syncStates\[item\.id\] \?\? "ready"\}/,
    "每张书架卡片都应在云端模式下展示同步徽标",
  );
});

test("同步失败或未同步时提供重试入口", () => {
  assert.match(source, /await retryBookSync\(id\)/, "重试按钮必须调用存储层的单本重试");
  assert.match(source, /failed: \{ label: "同步失败"/);
  assert.match(source, /local: \{ label: "未同步"/);
  assert.match(source, /重试同步/);
  assert.match(source, /syncStates\[item\.id\]/, "徽标文案必须来自实时状态表");
});
