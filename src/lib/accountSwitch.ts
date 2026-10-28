import type { AuthUser } from "../types";

/** 触发归档门禁的原因；决定归档备份键的前缀。 */
export type AccountSwitchReason = "account-switch" | "unowned";

export type AccountSwitchPhase =
  | "idle"
  | "archiving"
  | "blocked"
  | "switching"
  | "done";

export type AccountSwitchState = {
  phase: AccountSwitchPhase;
  targetUser: AuthUser | null;
  archiveKey?: string;
  error?: string;
};

/**
 * reducer 只声明副作用，由 App 执行：
 * - archive：调用归档写入，并把结果通过 ARCHIVE_OK / ARCHIVE_FAIL 派发回来；
 * - clearLocal：清空本机旧账户数据；
 * - setAuthUser：真正切换身份（含书架归属）。
 */
export type AccountSwitchEffect =
  | { type: "archive"; reason?: AccountSwitchReason; requestedAt?: number }
  | { type: "clearLocal" }
  | { type: "setAuthUser"; user: AuthUser };

export type AccountSwitchEvent =
  | {
      type: "START_SWITCH";
      targetUser?: AuthUser;
      /** `user` 是 `targetUser` 的兼容别名，便于旧调用方逐步迁移。 */
      user?: AuthUser;
      /** 显式指定是否归档；缺省时由 hasLocalRecords/discardLocalData 推导。 */
      requiresArchive?: boolean;
      /** `requiresArchive` 的兼容别名。 */
      needsArchive?: boolean;
      hasLocalRecords?: boolean;
      /** `hasLocalRecords` 的兼容别名。 */
      localRecords?: boolean;
      discardLocalData?: boolean;
      reason?: AccountSwitchReason;
      /** 时间戳只通过事件传入，reducer 内绝不读取系统时间。 */
      timestamp?: number;
    }
  | {
      type: "ARCHIVE_OK";
      archiveKey?: string | null;
      key?: string | null;
      timestamp?: number;
    }
  | {
      type: "ARCHIVE_FAIL";
      error?: string;
      message?: string;
      timestamp?: number;
    }
  | { type: "RETRY"; reason?: AccountSwitchReason; timestamp?: number }
  | { type: "DISCARD_AND_CONTINUE"; timestamp?: number }
  | { type: "CANCEL"; timestamp?: number }
  /** 身份与本地数据切换执行完毕；由 App 在成功路径末尾派发，进入 done。 */
  | { type: "SWITCH_COMPLETE"; timestamp?: number };

export const initialAccountSwitchState: AccountSwitchState = {
  phase: "idle",
  targetUser: null,
};

type Transition = {
  state: AccountSwitchState;
  effects: AccountSwitchEffect[];
};

const unchanged = (state: AccountSwitchState): Transition => ({
  state,
  effects: [],
});

function archiveEffect(
  reason: AccountSwitchReason | undefined,
  requestedAt: number | undefined,
): AccountSwitchEffect {
  return {
    type: "archive",
    ...(reason ? { reason } : {}),
    ...(requestedAt === undefined ? {} : { requestedAt }),
  };
}

/**
 * 账户切换归档门禁的显式状态机。
 *
 * 允许的主路径：
 *   idle --START_SWITCH--> archiving --ARCHIVE_OK--> done
 *   idle --START_SWITCH(无需归档)--> switching --SWITCH_COMPLETE--> done
 *   archiving --ARCHIVE_FAIL--> blocked --RETRY--> archiving
 *   blocked --DISCARD_AND_CONTINUE--> done
 *   blocked --CANCEL--> idle
 *
 * 其余转换一律忽略（返回原状态、无副作用），从而保证归档未成功时
 * 不会误切换身份。函数不读取浏览器存储、网络或系统时间，可直接穷举测试。
 */
export function accountSwitchReducer(
  state: AccountSwitchState,
  event: AccountSwitchEvent,
): Transition {
  switch (event.type) {
    case "START_SWITCH": {
      // 新的切换只能从空闲或上一轮完成态发起；归档中/切换中/阻塞中都必须
      // 走各自显式出口，避免并发归档或绕过失败弹窗。
      if (state.phase !== "idle" && state.phase !== "done") {
        return unchanged(state);
      }
      const targetUser = event.targetUser ?? event.user ?? null;
      if (!targetUser) return unchanged(state);

      const hasLocalRecords =
        event.hasLocalRecords ?? event.localRecords ?? true;
      const requiresArchive =
        event.requiresArchive ??
        event.needsArchive ??
        (hasLocalRecords && !event.discardLocalData);

      if (requiresArchive) {
        return {
          state: { phase: "archiving", targetUser },
          effects: [archiveEffect(event.reason, event.timestamp)],
        };
      }
      return {
        state: { phase: "switching", targetUser },
        effects: [
          { type: "setAuthUser", user: targetUser },
          { type: "clearLocal" },
        ],
      };
    }

    case "ARCHIVE_OK": {
      if (state.phase !== "archiving" || !state.targetUser) {
        return unchanged(state);
      }
      const archiveKey = event.archiveKey ?? event.key ?? undefined;
      return {
        state: {
          phase: "done",
          targetUser: state.targetUser,
          ...(archiveKey ? { archiveKey } : {}),
        },
        effects: [
          { type: "setAuthUser", user: state.targetUser },
          { type: "clearLocal" },
        ],
      };
    }

    case "ARCHIVE_FAIL": {
      if (state.phase !== "archiving" || !state.targetUser) {
        return unchanged(state);
      }
      const error = event.error ?? event.message;
      return {
        state: {
          phase: "blocked",
          targetUser: state.targetUser,
          ...(error ? { error } : {}),
        },
        effects: [],
      };
    }

    case "RETRY": {
      if (state.phase !== "blocked" || !state.targetUser) {
        return unchanged(state);
      }
      return {
        state: { phase: "archiving", targetUser: state.targetUser },
        effects: [archiveEffect(event.reason, event.timestamp)],
      };
    }

    case "DISCARD_AND_CONTINUE": {
      if (state.phase !== "blocked" || !state.targetUser) {
        return unchanged(state);
      }
      return {
        state: { phase: "done", targetUser: state.targetUser },
        effects: [
          { type: "setAuthUser", user: state.targetUser },
          { type: "clearLocal" },
        ],
      };
    }

    case "SWITCH_COMPLETE": {
      if (state.phase !== "switching" || !state.targetUser) {
        return unchanged(state);
      }
      return {
        state: { ...state, phase: "done" },
        effects: [],
      };
    }

    case "CANCEL": {
      // 归档/切换已经发起时不能假装取消（副作用可能已落盘/身份已更新）；
      // 阻塞态、完成态与空闲态可以安全回到 idle。
      if (state.phase === "archiving" || state.phase === "switching") {
        return unchanged(state);
      }
      if (state.phase === "idle") return unchanged(state);
      return { state: { ...initialAccountSwitchState }, effects: [] };
    }

    default:
      return unchanged(state);
  }
}

/**
 * useReducer 适配器：只暴露纯状态；effects 由 App 在同一事件里通过
 * accountSwitchReducer 取得并执行，避免 React reducer 产生副作用。
 */
export function accountSwitchStateReducer(
  state: AccountSwitchState,
  event: AccountSwitchEvent,
): AccountSwitchState {
  return accountSwitchReducer(state, event).state;
}

/**
 * 兼容旧调用方的同步门禁适配器（现有 tests/account-switch.test.ts 使用）。
 * 真实组件路径已改为 accountSwitchReducer + effects；这里只把 reducer 的
 * 归档分支同步执行一次，保留原来的 proceed/blocked 返回约定。
 */
export function applyAccountSwitchGate(options: {
  switching: boolean;
  hasLocalRecords: boolean;
  discardLocalData?: boolean;
  reason: AccountSwitchReason;
  archive: (reason: AccountSwitchReason) => string | null;
  user: AuthUser;
  setAuthUser: (user: AuthUser) => void;
}): { status: "proceed"; archivedKey: string | null } | { status: "blocked" } {
  const requiresArchive =
    options.switching && options.hasLocalRecords && !options.discardLocalData;
  let state = accountSwitchReducer(initialAccountSwitchState, {
    type: "START_SWITCH",
    targetUser: options.user,
    requiresArchive,
    reason: options.reason,
  }).state;

  let archivedKey: string | null = null;
  if (state.phase === "archiving") {
    archivedKey = options.archive(options.reason);
    if (!archivedKey) return { status: "blocked" };
    state = accountSwitchReducer(state, {
      type: "ARCHIVE_OK",
      archiveKey: archivedKey,
    }).state;
  }
  if (state.phase !== "switching" && state.phase !== "done") {
    return { status: "blocked" };
  }
  options.setAuthUser(options.user);
  return { status: "proceed", archivedKey };
}
