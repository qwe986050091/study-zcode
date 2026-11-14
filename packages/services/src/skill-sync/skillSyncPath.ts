// 技能同步的路径安全层：与 pluginSyncPath 结构一致、规则独立的平行实现。
// 有意不共享实现：插件与技能的安全策略会各自演进，共享会让一次改动同时影响两条同步链路。
// INV-1 拒绝绝对路径与盘符前缀；INV-2 拒绝任何上级目录段；INV-3 拼接后必须仍在根目录内。
// skillSyncPath 只做字符串归一与包含性判断，不访问文件系统；归一结果必须再经 resolve 校验，否则相对段可能逃出技能根。
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

// unsafePathLabel 只用于报错文案，不参与路径判断；传错最多让日志指向错误来源，不会放宽安全校验。
interface SkillSyncPathOptions {
  unsafePathLabel?: string;
}

// 统一分隔符并去掉首尾斜杠后再判断；判断依据仍是原始 path，防止反斜杠写法绕过。
// 合法的相对路径必须每一段都非空、且不是当前目录或上级目录标记。
export function normalizeSkillSyncRelativePath(
  path: string,
  options: SkillSyncPathOptions = {},
): string {
  // 前置条件：path 来自外部同步包，必须当成不可信输入；本函数只拒绝、不修正，修正会掩盖越界尝试。
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (
    !normalized ||
    isAbsolute(path) ||
    // 两个绝对路径判定都要查：Windows 上 /foo 不算绝对路径，但按 POSIX 语义它就是绝对路径，漏判会让拼接逃到盘符根。
    posix.isAbsolute(path) ||
    path.includes("\\") ||
    // 盘符前缀单独判：C:foo 在 Windows 上是相对盘符路径，isAbsolute 返回 false，不拦就会解析到驱动器当前目录。
    /^[a-zA-Z]:/u.test(path) ||
    // 逐段拒绝空段与 . / ..：空段会被 resolve 静默吞掉，.. 会逃出根；归一化之后再判是为了让反斜杠写法也落到同一检查上。
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    // 抛错而不是自动修正：修正后的路径会让调用方误以为输入合法，错误必须在同步入口就暴露。
    throw new Error(`${options.unsafePathLabel ?? "unsafe skill sync path"}: ${path}`);
  }
// 返回以正斜杠分隔的形式，保证跨平台拼接一致。
  return normalized;
}

// 先规范化根与相对路径，再逐段 resolve，确保结果不受当前工作目录影响。
// 最后用 relative 反查：只要结果逃出根目录（或以父级前缀开头）就拒绝。
export function resolveSkillSyncPathWithin(
  targetRoot: string,
  path: string,
  options: SkillSyncPathOptions = {},
): string {
  // 前置条件：targetRoot 必须是调用方已确认的可信同步根；本函数只保证不逃出它，不校验根本身是否合法。
// 根目录自身也做 resolve，避免调用方传入带上级段的根造成误判。
  const normalizedRoot = resolve(targetRoot);
  // 复用归一化函数的拒绝规则，保证「只拼路径」与「拼完校验」两个入口对非法输入的判定完全一致。
  const normalizedPath = normalizeSkillSyncRelativePath(path, options);
  // 展开成绝对路径后再反查：此时 . 与 .. 已被 resolve 消化，relative 拿到的才是真实落点，而不是未展开的字符串。
  const targetPath = resolve(normalizedRoot, ...normalizedPath.split("/"));
// 反查结果为空串说明目标就是根目录本身，同样视为越界（不能把文件写到根上）。
  const relativePath = relative(normalizedRoot, targetPath);
  if (
    relativePath === "" ||
    // 前缀必须带 sep：只比 '..' 会把 '..foo' 这种合法目录名误判为越界，也会漏掉跨平台分隔符差异。
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    // 跨盘符时 relative 返回的是绝对路径而非 .. 前缀，这里必须单独拦，否则技能文件会被写到根目录之外。
    isAbsolute(relativePath)
  ) {
    throw new Error(`${options.unsafePathLabel ?? "unsafe skill sync path"}: ${path}`);
  }
// 返回绝对路径；此时已确认位于根目录之内。
  return targetPath;
}
