import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 可靠判断“当前模块是否被直接执行”。
 *
 * 不能用 `import.meta.url.replace("file://", "")`：Windows 盘符、URL 百分号编码
 * （空格/中文路径）和符号链接都会误判。这里统一用 fileURLToPath，并在可用时
 * 比较 realpath，保证 Linux/macOS/Windows 的 npm、tsx、直接入口行为一致。
 */
export function isDirectExecution(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!argv1) return false;
  const modulePath = path.resolve(fileURLToPath(metaUrl));
  const entryPath = path.resolve(argv1);
  let resolvedModule = modulePath;
  let resolvedEntry = entryPath;
  try {
    resolvedModule = fs.realpathSync(modulePath);
    resolvedEntry = fs.realpathSync(entryPath);
  } catch {
    // 测试或部署包中入口可能尚不存在：退回原始绝对路径比较。
  }
  return platform === "win32"
    ? resolvedModule.toLowerCase() === resolvedEntry.toLowerCase()
    : resolvedModule === resolvedEntry;
}
