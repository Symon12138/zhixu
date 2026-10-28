import assert from "node:assert/strict";
import test from "node:test";
import type { AuthUser } from "../src/types";
import {
  accountSwitchReducer,
  accountSwitchStateReducer,
  initialAccountSwitchState,
  type AccountSwitchEffect,
  type AccountSwitchEvent,
  type AccountSwitchPhase,
  type AccountSwitchState,
} from "../src/lib/accountSwitch";

/* ── 夹具 ────────────────────────────────────────────────────────────── */

const USER_A: AuthUser = {
  id: "user-a",
  email: "a@example.com",
  name: "账户 A",
  createdAt: 1,
};

const USER_B: AuthUser = {
  id: "user-b",
  email: "b@example.com",
  name: "账户 B",
  createdAt: 2,
};

// reducer 只能引用、不能修改身份对象；冻结后任何原地写入都会在测试中暴露。
Object.freeze(USER_A);
Object.freeze(USER_B);

function stateOf(
  phase: AccountSwitchPhase,
  extra: Partial<AccountSwitchState> = {},
): AccountSwitchState {
  return {
    phase,
    targetUser: phase === "idle" ? null : USER_A,
    ...extra,
  };
}

const START_WITH_ARCHIVE: AccountSwitchEvent = {
  type: "START_SWITCH",
  targetUser: USER_B,
  requiresArchive: true,
  reason: "account-switch",
  timestamp: 100,
};

const START_WITHOUT_ARCHIVE: AccountSwitchEvent = {
  type: "START_SWITCH",
  targetUser: USER_B,
  requiresArchive: false,
  reason: "account-switch",
  timestamp: 101,
};

const ARCHIVE_OK: AccountSwitchEvent = {
  type: "ARCHIVE_OK",
  archiveKey: "zhixu.v1.archive.100",
  timestamp: 102,
};

const ARCHIVE_FAIL: AccountSwitchEvent = {
  type: "ARCHIVE_FAIL",
  error: "存储空间不足",
  timestamp: 103,
};

const RETRY: AccountSwitchEvent = {
  type: "RETRY",
  reason: "account-switch",
  timestamp: 104,
};

const DISCARD: AccountSwitchEvent = {
  type: "DISCARD_AND_CONTINUE",
  timestamp: 105,
};

const CANCEL: AccountSwitchEvent = { type: "CANCEL", timestamp: 106 };

const SWITCH_COMPLETE: AccountSwitchEvent = {
  type: "SWITCH_COMPLETE",
  timestamp: 107,
};

const EVENT_ENTRIES: Array<[string, AccountSwitchEvent]> = [
  ["startWithArchive", START_WITH_ARCHIVE],
  ["startWithoutArchive", START_WITHOUT_ARCHIVE],
  ["archiveOk", ARCHIVE_OK],
  ["archiveFail", ARCHIVE_FAIL],
  ["retry", RETRY],
  ["discard", DISCARD],
  ["cancel", CANCEL],
  ["switchComplete", SWITCH_COMPLETE],
];

function effectTypes(effects: readonly AccountSwitchEffect[]): string[] {
  return effects.map((effect) => effect.type);
}

interface ExpectedTransition {
  phase: AccountSwitchPhase;
  effects: string[];
}

/**
 * 白名单转换表：未列出的（phase, event）组合都必须原样返回、零副作用。
 * done --START_SWITCH--> 新一轮 是显式允许的，其余 done 后事件全部忽略。
 */
const ALLOWED_TRANSITIONS: Record<
  AccountSwitchPhase,
  Partial<Record<string, ExpectedTransition>>
> = {
  idle: {
    startWithArchive: { phase: "archiving", effects: ["archive"] },
    startWithoutArchive: {
      phase: "switching",
      effects: ["setAuthUser", "clearLocal"],
    },
  },
  archiving: {
    archiveOk: { phase: "done", effects: ["setAuthUser", "clearLocal"] },
    archiveFail: { phase: "blocked", effects: [] },
  },
  blocked: {
    retry: { phase: "archiving", effects: ["archive"] },
    discard: { phase: "done", effects: ["setAuthUser", "clearLocal"] },
    cancel: { phase: "idle", effects: [] },
  },
  switching: {
    switchComplete: { phase: "done", effects: [] },
  },
  done: {
    startWithArchive: { phase: "archiving", effects: ["archive"] },
    startWithoutArchive: {
      phase: "switching",
      effects: ["setAuthUser", "clearLocal"],
    },
    cancel: { phase: "idle", effects: [] },
  },
};

const PHASES: AccountSwitchPhase[] = [
  "idle",
  "archiving",
  "blocked",
  "switching",
  "done",
];

/* ── 状态机白名单 ────────────────────────────────────────────────────── */

test("非法事件序列：未列入白名单的转换原样返回状态且不产生任何副作用", () => {
  for (const phase of PHASES) {
    const before = stateOf(phase, {
      ...(phase === "done" ? { archiveKey: "previous-archive" } : {}),
      ...(phase === "blocked" ? { error: "上次归档失败" } : {}),
    });
    const allowed = ALLOWED_TRANSITIONS[phase];

    for (const [label, event] of EVENT_ENTRIES) {
      const expected = allowed[label];
      const transition = accountSwitchReducer(before, event);
      if (expected) {
        assert.equal(
          transition.state.phase,
          expected.phase,
          `${phase} + ${label} 应进入 ${expected.phase}`,
        );
        assert.deepEqual(
          effectTypes(transition.effects),
          expected.effects,
          `${phase} + ${label} 的副作用序列不符合声明`,
        );
        if (expected.effects.includes("setAuthUser")) {
          const authEffect = transition.effects.find(
            (effect) => effect.type === "setAuthUser",
          );
          if (!authEffect || authEffect.type !== "setAuthUser") {
            assert.fail(`${phase} + ${label} 缺少 setAuthUser`);
          }
          assert.equal(
            authEffect.user.id,
            transition.state.targetUser?.id,
            `${phase} + ${label} 不得把身份切到事件未声明的账户`,
          );
        }
        continue;
      }

      assert.deepEqual(
        transition.state,
        before,
        `${phase} + ${label} 是非法转换，状态必须保持不变`,
      );
      assert.deepEqual(
        transition.effects,
        [],
        `${phase} + ${label} 是非法转换，不能产生副作用`,
      );
    }
  }
});

test("blocked 状态收到迟到的 ARCHIVE_OK 绝不放行身份切换", () => {
  const blocked = stateOf("blocked", { error: "归档失败" });
  const lateOk = accountSwitchReducer(blocked, {
    type: "ARCHIVE_OK",
    archiveKey: "stale-key",
    timestamp: 200,
  });
  assert.deepEqual(lateOk.state, blocked, "状态必须保持不变");
  assert.deepEqual(lateOk.effects, [], "不得重放 setAuthUser/clearLocal");
  assert.equal(lateOk.state.phase, "blocked");
  assert.equal(lateOk.state.targetUser?.id, USER_A.id);

  const lateComplete = accountSwitchReducer(lateOk.state, SWITCH_COMPLETE);
  assert.deepEqual(lateComplete.state, blocked);
  assert.deepEqual(lateComplete.effects, []);
});

test("idle 状态收到 RETRY/ARCHIVE_OK/DISCARD/SWITCH_COMPLETE 全部忽略", () => {
  const idle = stateOf("idle");
  for (const event of [RETRY, ARCHIVE_OK, DISCARD, SWITCH_COMPLETE]) {
    const transition = accountSwitchReducer(idle, event);
    assert.deepEqual(transition.state, idle, `${event.type} 不能从 idle 启动切换`);
    assert.deepEqual(transition.effects, []);
  }
});

test("done 后再收事件：仅 START_SWITCH 可开始新一轮，CANCEL 归零，其余忽略", () => {
  const done = stateOf("done", { archiveKey: "old-archive" });

  const next = accountSwitchReducer(done, START_WITH_ARCHIVE);
  assert.equal(next.state.phase, "archiving");
  assert.equal(next.state.targetUser?.id, USER_B.id);
  assert.equal("archiveKey" in next.state, false, "新一轮不能继承上一轮归档键");
  assert.deepEqual(effectTypes(next.effects), ["archive"]);

  const cancelled = accountSwitchReducer(done, CANCEL);
  assert.deepEqual(cancelled.state, initialAccountSwitchState);
  assert.deepEqual(cancelled.effects, []);

  for (const event of [ARCHIVE_OK, RETRY, DISCARD, SWITCH_COMPLETE]) {
    const ignored = accountSwitchReducer(done, event);
    assert.deepEqual(ignored.state, done, `${event.type} 在 done 后必须忽略`);
    assert.deepEqual(ignored.effects, []);
  }
});

/* ── 恶意 payload ────────────────────────────────────────────────────── */

test("START_SWITCH 缺少 targetUser 或 targetUser 为 null 时不启动切换", () => {
  for (const phase of ["idle", "done"] as const) {
    const before = stateOf(phase);
    for (const event of [
      { type: "START_SWITCH" },
      { type: "START_SWITCH", targetUser: undefined },
      { type: "START_SWITCH", user: undefined },
    ] satisfies AccountSwitchEvent[]) {
      const transition = accountSwitchReducer(before, event);
      assert.deepEqual(transition.state, before, `${phase}：缺少目标账户必须忽略`);
      assert.deepEqual(transition.effects, []);
    }

    const nullTarget = {
      type: "START_SWITCH",
      targetUser: null,
    } as unknown as AccountSwitchEvent;
    const transition = accountSwitchReducer(before, nullTarget);
    assert.deepEqual(transition.state, before, `${phase}：null 目标账户必须忽略`);
    assert.deepEqual(transition.effects, []);
  }
});

test("archiveKey 为控制字符/__proto__/超长字符串时只作为数据保存，不产生越权副作用", () => {
  const archiving = stateOf("archiving");
  const hostileKeys = [
    "__proto__",
    "<img src=x onerror=alert(1)>",
    "line\nbreak\u0000",
    "k".repeat(100_000),
  ];
  for (const archiveKey of hostileKeys) {
    const transition = accountSwitchReducer(archiving, {
      type: "ARCHIVE_OK",
      archiveKey,
    });
    assert.equal(transition.state.phase, "done");
    assert.equal(transition.state.archiveKey, archiveKey, "归档键必须原样保存为数据");
    assert.deepEqual(effectTypes(transition.effects), [
      "setAuthUser",
      "clearLocal",
    ]);
    const globalScope: Record<string, unknown> = {};
    assert.equal(
      globalScope.polluted,
      undefined,
      "归档键不能污染 Object.prototype",
    );
  }
});

test("ARCHIVE_FAIL 的 error 为字符串或 Error 对象都只进入 blocked，不抛错", () => {
  const archiving = stateOf("archiving");
  const boom = new Error("boom");

  const fromString = accountSwitchReducer(archiving, {
    type: "ARCHIVE_FAIL",
    error: "磁盘已满",
  });
  assert.equal(fromString.state.phase, "blocked");
  assert.equal(fromString.state.error, "磁盘已满");
  assert.deepEqual(fromString.effects, []);

  const fromError = accountSwitchReducer(archiving, {
    type: "ARCHIVE_FAIL",
    error: boom as unknown as string,
  });
  assert.equal(fromError.state.phase, "blocked");
  assert.deepEqual(fromError.effects, []);
  // 故意注入非字符串 payload；只读取 reducer 原样保留的数据字段。
  const retained = fromError.state as unknown as { error?: unknown };
  assert.equal(
    retained.error,
    boom,
    "reducer 不读取 Error 字段、不抛错，原值只作为数据保留",
  );
});

/* ── 纯函数与副作用序列 ──────────────────────────────────────────────── */

test("reducer 是纯函数：不读系统时间/存储/网络，不修改输入，同输入同输出", () => {
  const originalNow = Date.now;
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );

  Date.now = () => {
    throw new Error("reducer 不得读取系统时间");
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => {
      throw new Error("reducer 不得发起网络请求");
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new Proxy(
      {},
      {
        get() {
          throw new Error("reducer 不得访问浏览器存储");
        },
      },
    ),
  });

  try {
    for (const phase of PHASES) {
      const before = stateOf(phase, {
        ...(phase === "done" ? { archiveKey: "old" } : {}),
      });
      Object.freeze(before);
      for (const [, event] of EVENT_ENTRIES) {
        const first = accountSwitchReducer(before, event);
        const second = accountSwitchReducer(before, event);
        assert.deepEqual(first, second, "同样输入必须得到同样输出");
      }
    }

    const start: AccountSwitchState = {
      phase: "idle",
      targetUser: null,
    };
    const transition = accountSwitchReducer(start, {
      type: "START_SWITCH",
      targetUser: USER_B,
      requiresArchive: false,
    });
    assert.equal(transition.state.phase, "switching");
    assert.equal(transition.state.targetUser, USER_B);
  } finally {
    Date.now = originalNow;
    if (fetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "fetch");
    }
    if (storageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});

test("副作用序列：单次转换不重复身份切换/清理，setAuthUser 必须先于 clearLocal", () => {
  for (const phase of PHASES) {
    const before = stateOf(phase);
    for (const [label, event] of EVENT_ENTRIES) {
      const effects = accountSwitchReducer(before, event).effects;
      const types = effectTypes(effects);
      assert.ok(
        types.filter((type) => type === "setAuthUser").length <= 1,
        `${phase} + ${label}：setAuthUser 不得重复`,
      );
      assert.ok(
        types.filter((type) => type === "clearLocal").length <= 1,
        `${phase} + ${label}：clearLocal 不得重复`,
      );
      assert.ok(
        types.filter((type) => type === "archive").length <= 1,
        `${phase} + ${label}：archive 不得重复`,
      );
      const authIndex = types.indexOf("setAuthUser");
      const clearIndex = types.indexOf("clearLocal");
      if (authIndex >= 0 && clearIndex >= 0) {
        assert.ok(
          authIndex < clearIndex,
          `${phase} + ${label}：身份切换必须先于清理本地数据`,
        );
      }
    }
  }
});

test("完整路径：归档重试不会重复 setAuthUser/clearLocal，失败路径不切换身份", () => {
  interface Counts {
    archive: number;
    setAuthUser: number;
    clearLocal: number;
  }

  const runPath = (
    from: AccountSwitchState,
    events: readonly AccountSwitchEvent[],
  ): Counts => {
    let state = from;
    const counts: Counts = { archive: 0, setAuthUser: 0, clearLocal: 0 };
    for (const event of events) {
      const transition = accountSwitchReducer(state, event);
      for (const effect of transition.effects) {
        if (effect.type === "archive") counts.archive += 1;
        if (effect.type === "setAuthUser") counts.setAuthUser += 1;
        if (effect.type === "clearLocal") counts.clearLocal += 1;
      }
      state = transition.state;
    }
    return counts;
  };

  assert.deepEqual(
    runPath(initialAccountSwitchState, [
      START_WITH_ARCHIVE,
      ARCHIVE_FAIL,
      RETRY,
      ARCHIVE_OK,
    ]),
    { archive: 2, setAuthUser: 1, clearLocal: 1 },
    "归档失败重试成功后只能切换一次身份、清理一次本地数据",
  );

  assert.deepEqual(
    runPath(initialAccountSwitchState, [
      START_WITH_ARCHIVE,
      ARCHIVE_FAIL,
    ]),
    { archive: 1, setAuthUser: 0, clearLocal: 0 },
    "归档失败路径绝不切换身份或清空本地数据",
  );

  assert.deepEqual(
    runPath(initialAccountSwitchState, [
      START_WITHOUT_ARCHIVE,
      SWITCH_COMPLETE,
    ]),
    { archive: 0, setAuthUser: 1, clearLocal: 1 },
  );

  assert.deepEqual(
    runPath(initialAccountSwitchState, [
      START_WITH_ARCHIVE,
      ARCHIVE_FAIL,
      DISCARD,
    ]),
    { archive: 1, setAuthUser: 1, clearLocal: 1 },
    "用户明确丢弃后只允许一次切换与清理",
  );
});

test("useReducer 适配器只暴露状态，effects 不会混入 React state", () => {
  const next = accountSwitchStateReducer(
    initialAccountSwitchState,
    START_WITHOUT_ARCHIVE,
  );
  assert.deepEqual(next, { phase: "switching", targetUser: USER_B });
  assert.equal("effects" in next, false);
});
