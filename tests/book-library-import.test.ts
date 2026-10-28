import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/BookLibrary.tsx", import.meta.url), "utf8");

test("导入在读取本机旧书之后、保存之前再次校验 owner epoch", () => {
  const readLocal = source.indexOf("await getLocalBook(imported.id)");
  const guard = source.indexOf("ownerEpoch !== getBookOwnerEpoch()", readLocal);
  const save = source.indexOf("await saveBook(imported", readLocal);

  assert.ok(readLocal >= 0, "导入流程必须先读取本机旧书判重");
  assert.ok(guard > readLocal, "getLocalBook 是异步的，返回后必须重新校验 owner epoch");
  assert.ok(save > guard, "重新校验必须发生在 saveBook 之前");
  assert.match(
    source.slice(save, save + 120),
    /expectedOwnerEpoch:\s*ownerEpoch/,
    "saveBook 应携带导入开始时捕获的 owner epoch，由存储层再次拒绝跨账户写入",
  );
});
