export async function withTabRequestLock<T>(
  locks: LockManager | undefined,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!locks) return operation();
  return locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error("另一个标签页正在生成回答，请等待完成后再重试。");
    return operation();
  });
}
