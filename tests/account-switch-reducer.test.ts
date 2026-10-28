import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthUser } from "../src/types";
import {
  accountSwitchReducer,
  accountSwitchStateReducer,
  initialAccountSwitchState,
  type AccountSwitchEvent,
  type AccountSwitchPhase,
  type AccountSwitchState,
} from "../src/lib/accountSwitch";

const NEW_USER: AuthUser = {
  id: "new-user",
  email: "new@example.com",
  name: "新账户",
  createdAt: 2,
};

const START_WITH_ARCHIVE: AccountSwitchEvent = {
  type: "START_SWITCH",
  targetUser: NEW_USER,
  requiresArchive: true,
  reason: "account-switch",
  timestamp: 1_700_000_000_000,
};

const START_WITHOUT_ARCHIVE: AccountSwitchEvent = {
  type: "START_SWITCH",
  targetUser: NEW_USER,
  requiresArchive: false,
  reason: "account-switch",
  timestamp: 1_700_000_000_001,
};

function state(
  phase: AccountSwitchPhase,
  extra: Partial<AccountSwitchState> = {},
): AccountSwitchState {
  return {
    phase,
    targetUser: phase === "idle" ? null : NEW_USER,
    ...extra,
  };
}

test("初始状态是 idle，尚未确定目标账户", () => {
  assert.deepEqual(initialAccountSwitchState, {
    phase: "idle",
    targetUser: null,
  });
});

test("useReducer 适配器只返回状态，不把 effects 混入 React state", () => {
  const next = accountSwitchStateReducer(
    initialAccountSwitchState,
    START_WITH_ARCHIVE,
  );
  assert.deepEqual(next, { phase: "archiving", targetUser: NEW_USER });
  assert.equal("effects" in next, false);
});

test("START_SWITCH 需要归档时进入 archiving 且只声明归档副作用", () => {
  const before = { ...initialAccountSwitchState };
  const result = accountSwitchReducer(initialAccountSwitchState, START_WITH_ARCHIVE);

  assert.deepEqual(result.state, {
    phase: "archiving",
    targetUser: NEW_USER,
  });
  assert.deepEqual(result.effects, [
    {
      type: "archive",
      reason: "account-switch",
      requestedAt: 1_700_000_000_000,
    },
  ]);
  // reducer 不修改传入状态。
  assert.deepEqual(initialAccountSwitchState, before);
});

test("START_SWITCH 无需归档时直接进入 switching，声明身份切换与清理副作用", () => {
  const result = accountSwitchReducer(
    initialAccountSwitchState,
    START_WITHOUT_ARCHIVE,
  );

  assert.deepEqual(result.state, {
    phase: "switching",
    targetUser: NEW_USER,
  });
  assert.deepEqual(result.effects, [
    { type: "setAuthUser", user: NEW_USER },
    { type: "clearLocal" },
  ]);
});

test("START_SWITCH 可由 hasLocalRecords/discardLocalData 推导是否归档", () => {
  const noRecords = accountSwitchReducer(initialAccountSwitchState, {
    type: "START_SWITCH",
    targetUser: NEW_USER,
    hasLocalRecords: false,
    reason: "unowned",
  });
  assert.equal(noRecords.state.phase, "switching");
  assert.deepEqual(noRecords.effects, [
    { type: "setAuthUser", user: NEW_USER },
    { type: "clearLocal" },
  ]);

  const discard = accountSwitchReducer(initialAccountSwitchState, {
    type: "START_SWITCH",
    targetUser: NEW_USER,
    hasLocalRecords: true,
    discardLocalData: true,
    reason: "account-switch",
  });
  assert.equal(discard.state.phase, "switching");
  assert.equal(discard.effects.some((effect) => effect.type === "archive"), false);
});

test("ARCHIVE_OK 从 archiving 进入 done 并保留归档键", () => {
  const result = accountSwitchReducer(state("archiving"), {
    type: "ARCHIVE_OK",
    archiveKey: "zhixu.orphan.account-switch.123",
    timestamp: 1_700_000_000_002,
  });

  assert.deepEqual(result.state, {
    phase: "done",
    targetUser: NEW_USER,
    archiveKey: "zhixu.orphan.account-switch.123",
  });
  assert.deepEqual(result.effects, [
    { type: "setAuthUser", user: NEW_USER },
    { type: "clearLocal" },
  ]);
});

test("ARCHIVE_FAIL 从 archiving 进入 blocked，并保留错误信息", () => {
  const result = accountSwitchReducer(state("archiving"), {
    type: "ARCHIVE_FAIL",
    error: "quota exceeded",
  });

  assert.deepEqual(result.state, {
    phase: "blocked",
    targetUser: NEW_USER,
    error: "quota exceeded",
  });
  assert.deepEqual(result.effects, []);
});

test("RETRY 从 blocked 回到 archiving 并重新声明归档副作用", () => {
  const blocked = state("blocked", { error: "quota exceeded" });
  const result = accountSwitchReducer(blocked, {
    type: "RETRY",
    reason: "account-switch",
    timestamp: 1_700_000_000_003,
  });

  assert.deepEqual(result.state, {
    phase: "archiving",
    targetUser: NEW_USER,
  });
  assert.deepEqual(result.effects, [
    {
      type: "archive",
      reason: "account-switch",
      requestedAt: 1_700_000_000_003,
    },
  ]);
});

test("DISCARD_AND_CONTINUE 从 blocked 进入 done，且不再归档", () => {
  const blocked = state("blocked", { error: "quota exceeded" });
  const result = accountSwitchReducer(blocked, {
    type: "DISCARD_AND_CONTINUE",
    timestamp: 1_700_000_000_004,
  });

  assert.deepEqual(result.state, {
    phase: "done",
    targetUser: NEW_USER,
  });
  assert.deepEqual(result.effects, [
    { type: "setAuthUser", user: NEW_USER },
    { type: "clearLocal" },
  ]);
  assert.equal(result.effects.some((effect) => effect.type === "archive"), false);
});

test("SWITCH_COMPLETE 从 switching 进入 done，保留归档键且无副作用", () => {
  const result = accountSwitchReducer(
    state("switching", { archiveKey: "zhixu.orphan.account-switch.123" }),
    { type: "SWITCH_COMPLETE", timestamp: 1_700_000_000_005 },
  );

  assert.deepEqual(result.state, {
    phase: "done",
    targetUser: NEW_USER,
    archiveKey: "zhixu.orphan.account-switch.123",
  });
  assert.deepEqual(result.effects, []);
});

test("完整归档主路径：idle→archiving→blocked→retry→archiving→done", () => {
  let current = accountSwitchReducer(initialAccountSwitchState, START_WITH_ARCHIVE).state;
  assert.equal(current.phase, "archiving");

  current = accountSwitchReducer(current, {
    type: "ARCHIVE_FAIL",
    error: "blocked by quota",
  }).state;
  assert.equal(current.phase, "blocked");

  current = accountSwitchReducer(current, {
    type: "RETRY",
    reason: "account-switch",
  }).state;
  assert.equal(current.phase, "archiving");

  current = accountSwitchReducer(current, {
    type: "ARCHIVE_OK",
    archiveKey: "zhixu.orphan.account-switch.1700000000000",
  }).state;
  assert.equal(current.phase, "done");
  assert.equal(current.archiveKey, "zhixu.orphan.account-switch.1700000000000");
});

test("完整丢弃路径：idle→archiving→blocked→discard→done", () => {
  let current = accountSwitchReducer(initialAccountSwitchState, START_WITH_ARCHIVE).state;
  current = accountSwitchReducer(current, {
    type: "ARCHIVE_FAIL",
    error: "blocked by quota",
  }).state;
  assert.equal(current.phase, "blocked");

  current = accountSwitchReducer(current, { type: "DISCARD_AND_CONTINUE" }).state;
  assert.deepEqual(current, { phase: "done", targetUser: NEW_USER });
});

test("所有阶段的事件矩阵只放行合法转换，其余保持原状态且无副作用", () => {
  const phases: AccountSwitchPhase[] = [
    "idle",
    "archiving",
    "blocked",
    "switching",
    "done",
  ];
  const cases: {
    event: AccountSwitchEvent;
    expected: Record<AccountSwitchPhase, AccountSwitchPhase>;
  }[] = [
    {
      event: START_WITH_ARCHIVE,
      expected: {
        idle: "archiving",
        archiving: "archiving",
        blocked: "blocked",
        switching: "switching",
        done: "archiving",
      },
    },
    {
      event: START_WITHOUT_ARCHIVE,
      expected: {
        idle: "switching",
        archiving: "archiving",
        blocked: "blocked",
        switching: "switching",
        done: "switching",
      },
    },
    {
      event: { type: "ARCHIVE_OK", archiveKey: "k" },
      expected: {
        idle: "idle",
        archiving: "done",
        blocked: "blocked",
        switching: "switching",
        done: "done",
      },
    },
    {
      event: { type: "ARCHIVE_FAIL", error: "x" },
      expected: {
        idle: "idle",
        archiving: "blocked",
        blocked: "blocked",
        switching: "switching",
        done: "done",
      },
    },
    {
      event: { type: "RETRY", reason: "account-switch" },
      expected: {
        idle: "idle",
        archiving: "archiving",
        blocked: "archiving",
        switching: "switching",
        done: "done",
      },
    },
    {
      event: { type: "DISCARD_AND_CONTINUE" },
      expected: {
        idle: "idle",
        archiving: "archiving",
        blocked: "done",
        switching: "switching",
        done: "done",
      },
    },
    {
      event: { type: "CANCEL" },
      expected: {
        idle: "idle",
        archiving: "archiving",
        blocked: "idle",
        switching: "switching",
        done: "idle",
      },
    },
    {
      event: { type: "SWITCH_COMPLETE" },
      expected: {
        idle: "idle",
        archiving: "archiving",
        blocked: "blocked",
        switching: "done",
        done: "done",
      },
    },
  ];

  for (const phase of phases) {
    for (const entry of cases) {
      const before = state(phase);
      const result = accountSwitchReducer(before, entry.event);
      assert.equal(
        result.state.phase,
        entry.expected[phase],
        `${phase} + ${entry.event.type} 应得到 ${entry.expected[phase]}，实际 ${result.state.phase}`,
      );
      if (entry.expected[phase] === phase) {
        // 非法/无操作转换必须原样返回同一个状态对象，不能偷偷清理错误或目标用户。
        assert.strictEqual(result.state, before);
        assert.deepEqual(result.effects, []);
      }
    }
  }
});

test("非法事件不会污染状态：归档完成前不能切换身份", () => {
  const archiving = state("archiving");
  for (const event of [
    { type: "DISCARD_AND_CONTINUE" },
    { type: "RETRY" },
    { type: "SWITCH_COMPLETE" },
  ] satisfies AccountSwitchEvent[]) {
    const result = accountSwitchReducer(archiving, event);
    assert.strictEqual(result.state, archiving);
    assert.deepEqual(result.effects, []);
  }

  const idle = initialAccountSwitchState;
  for (const event of [
    { type: "ARCHIVE_OK", archiveKey: "unexpected" },
    { type: "ARCHIVE_FAIL", error: "unexpected" },
    { type: "RETRY" },
    { type: "DISCARD_AND_CONTINUE" },
  ] satisfies AccountSwitchEvent[]) {
    const result = accountSwitchReducer(idle, event);
    assert.strictEqual(result.state, idle);
    assert.deepEqual(result.effects, []);
  }
});

test("CANCEL 在 blocked 时回到 idle，在归档/切换中不会被误取消", () => {
  const blocked = state("blocked", { error: "x" });
  assert.deepEqual(accountSwitchReducer(blocked, { type: "CANCEL" }).state, {
    phase: "idle",
    targetUser: null,
  });

  const archiving = state("archiving");
  assert.strictEqual(
    accountSwitchReducer(archiving, { type: "CANCEL" }).state,
    archiving,
  );
  const switching = state("switching");
  assert.strictEqual(
    accountSwitchReducer(switching, { type: "CANCEL" }).state,
    switching,
  );
});

test("reducer 源码不包含 localStorage/网络/Date.now 等非纯调用", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/lib/accountSwitch.ts", import.meta.url)),
    "utf8",
  );
  // 只检查可执行代码，注释里提到这些名字不算违规。
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/\blocalStorage\s*\./.test(code), false);
  assert.equal(/\bfetch\s*\(/.test(code), false);
  assert.equal(/\bDate\.now\s*\(/.test(code), false);
  assert.equal(/\bcrypto\s*\./.test(code), false);
});
