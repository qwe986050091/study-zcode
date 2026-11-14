// INV-01 默认根目录可由环境变量覆盖：守住位置 读取与兜底拼接；改错故障 部署到不可写目录。
// INV-02 布局路径全部由根目录派生：守住位置 单次解析；改错故障 各处拼接口径不一。
// INV-03 运行期文件集中在运行目录：守住位置 子目录拼接；改错故障 锁与状态文件散落。
// INV-04 控制端点按平台分流：守住位置 平台判断；改错故障 Windows 尝试创建套接字。
// INV-05 端点名需稳定且不泄露路径：守住位置 哈希派生；改错故障 管道名包含完整家目录。
// INV-06 根目录先做绝对化：守住位置 解析调用；改错故障 相对路径随工作目录漂移。
// INV-07 规范化容忍缺失祖先：守住位置 循环回退；改错故障 首次安装直接失败。
// INV-08 只对不存在错误回退：守住位置 错误码判断；改错故障 权限错误被吞掉。
// INV-09 到根即停止回退：守住位置 父目录比较；改错故障 无限循环。
// INV-10 缺失段逆序拼回：守住位置 反转；改错故障 路径层级颠倒。
// INV-11 规范化布局复用同一入口：守住位置 组合函数；改错故障 两套布局字段分叉。
// INV-12 数据根目录按标准结构识别：守住位置 双层名称判断；改错故障 数据写进安装目录。
// INV-13 非标准根保持隔离：守住位置 兜底返回；改错故障 向上扩散污染其他数据。
// INV-14 包含判断按相对路径：守住位置 差分计算；改错故障 前缀相同被误判为内部。
// INV-15 父级引用一律拒绝：守住位置 分段检查；改错故障 路径穿越通过校验。
// INV-16 卸载目标必须绝对：守住位置 绝对性判断；改错故障 相对路径删错目录。
// INV-17 家目录与其父目录受保护：守住位置 双比较；改错故障 误删用户主目录。
// INV-18 非法根目录直接抛错：守住位置 校验函数；改错故障 空根被当成当前盘符。
//
// 模块职责：推导本地服务端的目录布局、控制端点与卸载路径校验。
// 状态所有权：无状态；所有路径都由入参根目录确定性派生。
// 阅读顺序：先看默认根与布局，再看规范化回退，最后看包含判断与卸载校验。
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface ServerLayout {
  readonly dataBaseDir: string;
  readonly serverRoot: string;
  readonly releasesDir: string;
  readonly runDir: string;
  readonly currentFile: string;
  readonly pendingFile: string;
  readonly installFile: string;
  readonly componentsCacheDir: string;
  readonly stableBinDir: string;
  readonly statusFile: string;
  readonly ingressTokenFile: string;
  readonly lockFile: string;
  readonly controlEndpoint: string;
  readonly serviceDir: string;
  readonly uninstalledFile: string;
  readonly updateTransactionFile: string;
  readonly updateLockFile: string;
}

// ZCODE_DATA_BASE_DIR 未配置时回退到 ~/.zcode/server。
// process.env.ZCODE_DATA_BASE_DIR?.trim() 空串同样视为未配置。
// getDefaultServerDataRoot() 只算路径，不 mkdir。
// 布局推导只读 ZCODE_DATA_BASE_DIR 一个环境变量。
export function getDefaultServerDataRoot(): string {
  const configured = process.env.ZCODE_DATA_BASE_DIR?.trim();
  return join(configured || homedir(), ".zcode", "server");
}

// resolve(serverRoot) 先绝对化，之后所有路径都基于它拼接。
// runDir 承载 update.lock 与会话端点。
// pendingFile 与 updateTransactionFile 留在 serverRoot 便于排查。
// Windows 用命名管道，其他平台用套接字。
export function resolveServerLayout(serverRoot = getDefaultServerDataRoot()): ServerLayout {
  const root = resolve(serverRoot);
  const runDir = join(root, "run");
  return {
    dataBaseDir: inferDataBaseDir(root),
    serverRoot: root,
    releasesDir: join(root, "releases"),
    runDir,
    currentFile: join(root, "current.json"),
    pendingFile: join(root, "pending.json"),
    installFile: join(root, "install.json"),
    componentsCacheDir: join(root, "cache", "components"),
    stableBinDir: join(root, "bin"),
    statusFile: join(runDir, "status.json"),
    ingressTokenFile: join(runDir, "ingress-token"),
    lockFile: join(runDir, "server.lock"),
    controlEndpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\zcode-server-${stablePathId(root)}`
        : join(runDir, "control.sock"),
    serviceDir: join(root, "service"),
    uninstalledFile: join(root, "uninstalled.json"),
    updateTransactionFile: join(root, "update-transaction.json"),
    updateLockFile: join(runDir, "update.lock"),
  };
}

// resolveCanonicalServerRoot() 从目标根逐级向上找存在祖先。
// 只有 error.code === "ENOENT" 才继续回退。
// missingSegments 收集后 reverse() 再拼回。
export async function resolveCanonicalServerRoot(
  serverRoot = getDefaultServerDataRoot(),
): Promise<string> {
  // 安装前 server root 可能尚不存在；向上找到最近的存在祖先做 realpath，再拼回缺失段，
  // 这样既能收敛已有符号链接，也不会因为 ENOENT 让首次安装失效。
  let candidate = assertServerDataRoot(serverRoot);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(candidate);
      return resolve(canonical, ...missingSegments.reverse());
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

export async function resolveCanonicalServerLayout(
  serverRoot = getDefaultServerDataRoot(),
): Promise<ServerLayout> {
  return resolveServerLayout(await resolveCanonicalServerRoot(serverRoot));
}

function inferDataBaseDir(serverRoot: string): string {
  const parent = dirname(serverRoot);
  if (basename(serverRoot) === "server" && basename(parent) === ".zcode") {
    return dirname(parent);
  }
  // 非标准的显式 server root 仍保持隔离，不向其父目录扩散 Agent/SQLite 数据。
  return serverRoot;
}

export function stablePathId(pathValue: string): string {
  // Path is only used as a local endpoint name.  A short deterministic id avoids leaking
  // the full home path into a named pipe or service descriptor.
  let hash = 2166136261;
  for (const char of resolve(pathValue)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// isPathWithin() 对两边都先 normalize(resolve())。
// relative() 以 ".." 开头即判定越界。
// diff.split(sep).includes("..") 再查一次，防止拼接绕过。
export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const root = normalize(resolve(rootPath));
  const candidate = normalize(resolve(candidatePath));
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.split(sep).includes(".."));
}

export interface UninstallTargetValidation {
  ok: boolean;
  reason?: "outside-server-root" | "home-directory" | "non-absolute";
  canonicalPath?: string;
}

export function validateUninstallTarget(
  serverRoot: string,
  target: string,
): UninstallTargetValidation {
  if (!isAbsolute(target)) {
    return { ok: false, reason: "non-absolute" };
  }
  const root = resolve(serverRoot);
  const canonicalPath = resolve(target);
  if (canonicalPath === resolve(homedir()) || canonicalPath === dirname(resolve(homedir()))) {
    return { ok: false, reason: "home-directory" };
  }
  if (!isPathWithin(root, canonicalPath)) {
    return { ok: false, reason: "outside-server-root", canonicalPath };
  }
  return { ok: true, canonicalPath };
}

export async function canonicalExistingPath(pathValue: string): Promise<string> {
  return await realpath(pathValue);
}

export function assertServerDataRoot(serverRoot: string): string {
  const resolved = resolve(serverRoot);
  if (!isAbsolute(resolved) || resolved === dirname(resolved)) {
    throw new Error("Invalid server data root");
  }
  return resolved;
}

export function serverDataRootFromBase(baseDir: string): string {
  return join(resolve(baseDir), ".zcode", "server");
}
