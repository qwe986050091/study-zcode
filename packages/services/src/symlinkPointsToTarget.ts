// 判定 linkPath 是否为指向 targetPath 的目录链接（符号链接或 Windows 目录交接点）。
// 职责：比较两侧 realpath，消除相对路径、大小写与中间跳转带来的差异。
// 边界：只做只读检查，不创建也不修复链接；任何 stat/readlink 失败都归为「不是目标」。
// INV：必须用 realpath 而非字符串比较，否则相对链接与规范化路径会被误判。
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** 判断 linkPath 是否为指向 targetPath（同 realpath）的目录软链/交接点。 */
// 返回 boolean 而不抛错：调用方把它当作清理条件，探测失败与「不匹配」的处理方式相同。
export async function symlinkPointsToTarget(
  linkPath: string,
  targetPath: string,
): Promise<boolean> {
// target 不可解析（不存在或权限不足）时直接否定：没有可比对的真实路径，任何比较都无意义。
  const targetReal = await realpath(targetPath).catch(() => null);
  if (!targetReal) {
    return false;
  }
  try {
    const stat = await lstat(linkPath);
    let rawLinked: string;
// 分支顺序不能反：先按标准符号链接处理，只有平台为 win32 时才回退到交接点探测。
    if (stat.isSymbolicLink()) {
      rawLinked = await readlink(linkPath);
    } else if (process.platform === "win32") {
      // 目录交接点（junction）在部分 Node 版本上 isSymbolicLink() 为 false，但仍可读 link 目标。
      try {
        rawLinked = await readlink(linkPath);
      } catch {
        return false;
      }
    } else {
      return false;
    }
// readlink 可能返回相对路径，必须按链接所在目录解析再 realpath；按 cwd 解析会指向错误位置。
    const linkedPath = isAbsolute(rawLinked) ? rawLinked : join(dirname(linkPath), rawLinked);
    const linkedReal = await realpath(linkedPath).catch(() => null);
    return linkedReal !== null && linkedReal === targetReal;
  } catch {
    return false;
  }
}
