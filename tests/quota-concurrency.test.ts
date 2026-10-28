import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireAiConcurrency,
  activeAiRequestCount,
} from "../server/quota";

test("同一用户并发闸门只放行上限数量，释放幂等且不串到其他用户", () => {
  const before = activeAiRequestCount();
  const first = acquireAiConcurrency("user-a", 2);
  const second = acquireAiConcurrency("user-a", 2);
  assert.ok(first);
  assert.ok(second);
  assert.equal(activeAiRequestCount(), before + 2);
  assert.equal(acquireAiConcurrency("user-a", 2), undefined, "第三人必须被拒绝");
  const releaseB = acquireAiConcurrency("user-b", 2);
  assert.ok(releaseB, "其他用户不应被影响");

  first();
  first();
  assert.equal(activeAiRequestCount(), before + 2, "重复释放不能多减");
  const third = acquireAiConcurrency("user-a", 2);
  assert.ok(third);
  second();
  third();
  assert.equal(activeAiRequestCount(), before + 1, "user-b 仍占用自己的槽位");

  releaseB();
  assert.equal(activeAiRequestCount(), before);
});

test("不同用户的并发计数彼此独立", () => {
  const before = activeAiRequestCount();
  const a = acquireAiConcurrency("isolation-a", 1);
  const b = acquireAiConcurrency("isolation-b", 1);
  assert.ok(a);
  assert.ok(b);
  assert.equal(activeAiRequestCount(), before + 2);
  assert.equal(acquireAiConcurrency("isolation-a", 1), undefined);
  a();
  b();
  assert.equal(activeAiRequestCount(), before);
});
