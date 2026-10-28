/**
 * 测试用最小 IndexedDB：只实现 bookStorage 用到的单键 store、游标与版本升级。
 * 不是完整规范实现，但请求/事务回调保持异步顺序，足以验证读取了哪些 store。
 */

export type FakeIdbOperation =
  | "get"
  | "getKey"
  | "getAll"
  | "getAllKeys"
  | "add"
  | "put"
  | "delete"
  | "clear"
  | "openCursor";

export interface FakeIdbLogEntry {
  db: string;
  store: string;
  op: FakeIdbOperation;
}

type Key = IDBValidKey;

class FakeRequest<T> {
  result: T | undefined;
  error: Error | null = null;
  transaction: FakeTransaction | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;
  private finished = false;

  constructor(
    readonly factory: FakeIndexedDBFactory,
    readonly db: FakeDatabase,
    readonly mode: IDBTransactionMode,
  ) {
    queueMicrotask(() => this.settleIfIdle());
  }

  objectStore(name: string): FakeObjectStore {
    const data = this.db.stores.get(name);
    if (!data) throw new Error(`NotFoundError: ${name}`);
    return new FakeObjectStore(this, name, data, this.db.keyPaths.get(name) ?? "id");
  }

  begin(): void {
    this.pending += 1;
  }

  end(): void {
    this.pending -= 1;
    this.settleIfIdle();
  }

  settleIfIdle(): void {
    if (this.pending !== 0 || this.finished) return;
    queueMicrotask(() => {
      if (this.pending !== 0 || this.finished) return;
      this.finished = true;
      this.oncomplete?.();
    });
  }

  fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.error = error instanceof Error ? error : new Error(String(error));
    queueMicrotask(() => {
      this.onerror?.();
      this.onabort?.();
    });
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    queueMicrotask(() => this.onabort?.());
  }

  request<T>(run: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.begin();
    queueMicrotask(() => {
      if (this.finished) return;
      let value: T;
      try {
        value = structuredClone(run());
      } catch (error) {
        this.end();
        request.error = error instanceof Error ? error : new Error(String(error));
        request.onerror?.();
        this.fail(error);
        return;
      }
      request.result = value;
      this.end();
      request.onsuccess?.();
    });
    return request;
  }
}

class FakeObjectStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly storeName: string,
    private readonly data: Map<Key, unknown>,
    private readonly keyPath: string,
  ) {}

  private log(op: FakeIdbOperation): void {
    this.tx.factory.log.push({ db: this.tx.db.name, store: this.storeName, op });
  }

  private keyOf(value: unknown): Key {
    if (typeof value !== "object" || value === null) throw new Error("DataError: value is not an object");
    const record = value as Record<string, unknown>;
    const key = record[this.keyPath];
    if (typeof key !== "string" && typeof key !== "number") throw new Error("DataError: missing key");
    return key;
  }

  get(key: Key): FakeRequest<unknown> {
    this.log("get");
    return this.tx.request(() => this.data.get(key));
  }

  getKey(key: Key): FakeRequest<Key | undefined> {
    this.log("getKey");
    return this.tx.request(() => this.data.has(key) ? key : undefined);
  }

  getAll(): FakeRequest<unknown[]> {
    this.log("getAll");
    return this.tx.request(() => [...this.data.values()]);
  }

  getAllKeys(): FakeRequest<Key[]> {
    this.log("getAllKeys");
    return this.tx.request(() => [...this.data.keys()]);
  }

  add(value: unknown): FakeRequest<Key> {
    this.log("add");
    return this.tx.request(() => {
      const key = this.keyOf(value);
      if (this.data.has(key)) throw new Error("ConstraintError");
      this.data.set(key, value);
      return key;
    });
  }

  put(value: unknown): FakeRequest<Key> {
    this.log("put");
    return this.tx.request(() => {
      const key = this.keyOf(value);
      this.data.set(key, value);
      return key;
    });
  }

  delete(key: Key): FakeRequest<undefined> {
    this.log("delete");
    return this.tx.request(() => {
      this.data.delete(key);
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    this.log("clear");
    return this.tx.request(() => {
      this.data.clear();
      return undefined;
    });
  }

  openCursor(): FakeRequest<FakeCursor | undefined> {
    this.log("openCursor");
    const request = new FakeRequest<FakeCursor | undefined>();
    const entries = [...this.data.entries()];
    let index = 0;
    this.tx.begin();
    const step = (): void => {
      queueMicrotask(() => {
        if (index >= entries.length) {
          request.result = undefined;
          this.tx.end();
          request.onsuccess?.();
          return;
        }
        const entry = entries[index];
        let continued = false;
        const cursor: FakeCursor = {
          key: entry[0],
          value: structuredClone(entry[1]),
          continue: () => {
            if (continued) throw new Error("InvalidStateError");
            continued = true;
            index += 1;
            step();
          },
        };
        request.result = cursor;
        request.onsuccess?.();
        if (!continued) this.tx.end();
      });
    };
    step();
    return request;
  }
}

interface FakeCursor {
  key: Key;
  value: unknown;
  continue: () => void;
}

export class FakeDatabase {
  readonly stores = new Map<string, Map<Key, unknown>>();
  readonly keyPaths = new Map<string, string>();
  version = 0;
  upgradeTransaction: FakeTransaction | null = null;
  onversionchange: (() => void) | null = null;

  constructor(readonly factory: FakeIndexedDBFactory, readonly name: string) {}

  get objectStoreNames(): { contains: (name: string) => boolean; length: number } {
    const stores = this.stores;
    return {
      contains: (name: string) => stores.has(name),
      get length() { return stores.size; },
    };
  }

  createObjectStore(name: string, options: { keyPath?: string | string[] } = {}): FakeObjectStore {
    if (this.stores.has(name)) throw new Error(`ConstraintError: ${name}`);
    const tx = this.upgradeTransaction;
    if (!tx) throw new Error("InvalidStateError");
    const keyPath = typeof options.keyPath === "string" ? options.keyPath : "id";
    this.stores.set(name, new Map());
    this.keyPaths.set(name, keyPath);
    return new FakeObjectStore(tx, name, this.stores.get(name)!, keyPath);
  }

  transaction(storeNames: string | string[], mode: IDBTransactionMode = "readonly"): FakeTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const name of names) {
      if (!this.stores.has(name)) throw new Error(`NotFoundError: ${name}`);
    }
    return new FakeTransaction(this.factory, this, mode);
  }

  close(): void {
    /* 内存实现无需关闭。 */
  }
}

export class FakeIndexedDBFactory {
  readonly databases = new Map<string, FakeDatabase>();
  readonly log: FakeIdbLogEntry[] = [];

  open(name: string, version = 1): IDBOpenDBRequest {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      let db = this.databases.get(name);
      if (!db) {
        db = new FakeDatabase(this, name);
        this.databases.set(name, db);
      }
      request.result = db;
      if (version <= db.version) {
        request.onsuccess?.();
        return;
      }
      const upgrade = new FakeTransaction(this, db, "versionchange");
      db.upgradeTransaction = upgrade;
      db.version = version;
      upgrade.oncomplete = () => {
        db.upgradeTransaction = null;
        request.onsuccess?.();
      };
      upgrade.onerror = () => {
        db.upgradeTransaction = null;
        request.error = upgrade.error ?? new Error("升级失败");
        request.onerror?.();
      };
      upgrade.onabort = () => {
        db.upgradeTransaction = null;
        request.error = upgrade.error ?? new Error("升级被中止");
        request.onerror?.();
      };
      request.transaction = upgrade;
      try {
        request.onupgradeneeded?.();
      } catch (error) {
        upgrade.abort();
        return;
      }
      upgrade.settleIfIdle();
    });
    return request as unknown as IDBOpenDBRequest;
  }

  clearData(): void {
    for (const db of this.databases.values()) {
      for (const store of db.stores.values()) store.clear();
    }
    this.log.length = 0;
  }

  getStore(dbName: string, storeName: string): Map<Key, unknown> | undefined {
    return this.databases.get(dbName)?.stores.get(storeName);
  }

  /** 预置旧版本数据库（用于验证升级时 summaries 回填）。 */
  seedDatabase(
    name: string,
    version: number,
    stores: Record<string, { keyPath?: string; values: unknown[] }>,
  ): FakeDatabase {
    const db = new FakeDatabase(this, name);
    db.version = version;
    for (const [storeName, definition] of Object.entries(stores)) {
      const keyPath = definition.keyPath ?? "id";
      const data = new Map<Key, unknown>();
      for (const value of definition.values) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        const key = record[keyPath];
        data.set(key as Key, structuredClone(value));
      }
      db.stores.set(storeName, data);
      db.keyPaths.set(storeName, keyPath);
    }
    this.databases.set(name, db);
    return db;
  }
}

/** 安装为全局 indexedDB；测试文件结束时可用 restore 恢复。 */
export function installFakeIndexedDB(): { factory: FakeIndexedDBFactory; restore: () => void } {
  const factory = new FakeIndexedDBFactory();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    value: factory as unknown as IDBFactory,
    configurable: true,
  });
  return {
    factory,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
      else Reflect.deleteProperty(globalThis, "indexedDB");
    },
  };
}
