// git/config 集中 Git 服务的超时与输出配额默认值、可执行文件候选、子进程 env 净化与仓库内路径归一化，调用方不能各自复制一套。
// 约束取值思路：超时用于兜住交互式提示或 hook 卡死，输出上限用于防止日志撑爆内存，二者都宁大勿小以免误判失败。
// 路径工具统一输出 POSIX 风格（以 / 分隔）的仓库相对路径，与 git 自身输出保持一致，避免 Windows 反斜杠混进匹配逻辑。
// 本模块只导出 git/config 的常量与纯函数，不持有状态、不发起 IO，所有调用方必须复用同一套口径。
import { join } from "node:path";

// 发现阶段（rev-parse / 判断是否在仓库内）只做轻量探测，超时较短可以快速失败并回退到「非仓库」分支。
// 普通命令超时覆盖 status/diff 等常规读取；调用方可在单次调用时覆盖，这里只是默认值。
// 时间单位为毫秒，全部以显式常量暴露，避免各服务各自硬编码导致行为不一致。
export const DEFAULT_GIT_DISCOVERY_TIMEOUT_MS = 3_000;
export const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 15_000;
// `git push` 可能会被仓库的 pre-push hook 阻塞较长时间（例如执行 `pnpm test`）。
// 继续沿用普通 Git 命令的 15s 超时会把显式 push 误判成失败，因此单独放宽 push 超时。
export const DEFAULT_GIT_PUSH_TIMEOUT_MS = 10 * 60_000;
// diff 要遍历两侧文件树并计算差异，耗时通常高于 status，因此 DEFAULT_GIT_DIFF_TIMEOUT_MS 必须单独放宽。
// 超时与输出上限是两个独立维度：这里只管「跑多久」，大 diff 的体积由 DEFAULT_GIT_DIFF_BYTES 兜底。
export const DEFAULT_GIT_DIFF_TIMEOUT_MS = 20_000;
export const DEFAULT_GIT_OUTPUT_BYTES = 512 * 1024;
// pre-push hook 可能会输出完整测试日志；继续沿用普通 Git 命令的 512KB 上限，
// 会在真正 push 完成前因为日志过多被截断终止。这里仅给 push 单独放宽输出配额。
export const DEFAULT_GIT_PUSH_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_GIT_DIFF_BYTES = 1024 * 1024;
// 未跟踪文件可能成千上万，逐文件 stat 会拖慢 status；这里限定总量与批次，超出上限即降级为「大小未知」而不是让请求超时。
// GIT_UNTRACKED_STAT_CHUNK_BYTES 与 GIT_UNTRACKED_STAT_CONCURRENCY 必须成对调整：64KB 分片配 4 路并发，只改一项会让吞吐或文件句柄占用失控。
export const GIT_UNTRACKED_STAT_MAX_BYTES = 1024 * 1024;
export const GIT_UNTRACKED_STAT_CHUNK_BYTES = 64 * 1024;
export const GIT_UNTRACKED_STAT_CONCURRENCY = 4;

// Windows 上进程可能没有继承完整 PATH（尤其是从 GUI 启动的桌面端），因此额外探测 Git for Windows 的常见安装目录。
// 顺序为 cmd 优先、bin 其次；环境变量优先取 ProgramW6432，保证 64 位进程不误用 32 位安装。
const WINDOWS_GIT_BINARY_CANDIDATES = [
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "cmd",
    "git.exe",
  ),
  join(
    process.env.ProgramW6432 ?? process.env.ProgramFiles ?? "C:\\Program Files",
    "Git",
    "bin",
    "git.exe",
  ),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "cmd", "git.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "git.exe"),
];
// Git 会把这些 local env 视为「当前仓库」的显式指定，优先级高于 cwd。
// 这里全部枚举而不是前缀匹配，是为了避免误删 GIT_* 中与仓库绑定无关的配置（例如凭据相关变量）。
const GIT_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

// 返回按优先级排列的可执行文件候选：显式配置 > PATH 中的 git > Windows 常见安装路径。
// 调用方应逐个尝试并在失败时继续下一个，而不是假定第一个一定存在。
export function getGitBinaryCandidates(): string[] {
  // 顺序即优先级：显式配置 > PATH > Windows 安装目录；调用方必须逐个尝试，不能只取第一个。
  // ZCODE_GIT_BINARY 排第一，允许在没有 PATH 的容器里钉死可执行文件；trim 防止配置尾部空格进入 spawn。
  const candidates = [process.env.ZCODE_GIT_BINARY?.trim(), "git"];
  // 只在 Windows 追加安装目录候选，POSIX 上 git 必然通过 PATH 暴露，多列路径反而掩盖配置错误。
  if (process.platform === "win32") {
    candidates.push(...WINDOWS_GIT_BINARY_CANDIDATES);
  }

  // 滤掉未设置 ZCODE_GIT_BINARY 产生的 undefined，下游按序逐个 spawn，遇到首个可用即停。
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

// 返回可直接传给 spawn 的环境：去除 local env 后附加确定性设置（禁用分页器、可选锁、非交互 locale），保证输出可解析且不会等待终端输入。
export function getGitCommandEnv(): NodeJS.ProcessEnv {
  // 前置条件：返回的是完整 env 快照；调用方不得再合并 process.env，否则被删掉的 local env 会被重新带回来。
  // 浅拷贝 process.env 后再删键，不直接改 process.env，否则同进程内其他 git 调用会被连带污染。
  const env = {
    ...process.env,
  };

  // pre-push hook 会向子进程注入当前仓库的 GIT_DIR/GIT_WORK_TREE 等 local env。
  // 如果这里原样透传，Git 服务命令会“串仓”到 hook 所在仓库，临时仓库/远端仓库操作都会被污染。
  // 统一先清理 local env，再叠加 ZCode 约束变量，保证命令只依赖显式 cwd。
  // 只删枚举出的变量名而不是按 GIT_ 前缀匹配，前缀匹配会误删 GIT_TERMINAL_PROMPT 与凭据配置。
  for (const variableName of GIT_LOCAL_ENV_VARS) {
    // 删除发生在合并确定性设置之前，顺序反了会被后写入的同名键复活。
    delete env[variableName];
  }

  return {
    ...env,
    // 禁用可选锁可避免 status 这类只读命令去写 index.lock，多进程并发时不会互相阻塞。
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    TERM: "dumb",
    LC_ALL: "C",
    LANG: "C",
  };
}

// git 的 --output 等参数要空设备路径：Windows 用 NUL、POSIX 用 /dev/null，必须由 getGitNullDevicePath 统一出口，调用方不能各写一份。
export function getGitNullDevicePath(): string {
  // 只用于 --output 这类参数；不要拿它做存在性判断，NUL 不是可 stat 的普通文件。
  // Windows 用 NUL 而不是 /dev/null，后者在 cmd 里会被当成普通文件名创建出来。
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

// 仅做分隔符归一化，不折叠 . 或 ..，避免掩盖上层传入的越界路径；越界判断由调用方负责。
export function normalizeGitPath(path: string): string {
  // 失败后果：折叠 .. 会掩盖越界路径，因此这里只换分隔符，越界必须由调用方在校验阶段拒绝。
  // 只替换反斜杠，不折叠 ./ 与 ../；越界判断留给调用方，静默归一化会掩盖它。
  return path.replace(/\\/g, "/");
}

// 把「仓库内工作区路径」规范为无首尾斜杠的形式；输入为空或只有 ./ 时返回 "." 表示仓库根。
// 去掉尾部斜杠是为了后续用 `${workspace}/` 前缀比较时不会出现双斜杠。
export function normalizeWorkspaceInRepoPath(path: string): string {
  // 失败后果：空串折成 "." 表示仓库根；返回空串会让下游前缀比较退化成 "/"，把所有路径都判进工作区。
  // 链式顺序固定：先统一分隔符再剥前后缀，否则 Windows 反斜杠会让 ^\.?/ 匹配不到。
  const normalized = normalizeGitPath(path)
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
  // 空串折成点号表示仓库根，调用方据此走全部命中分支；返回空串会让前缀比较退化成 /。
  return normalized.length > 0 ? normalized : ".";
}

// 判断 repoRelativePath 是否落在 workspaceInRepoPath 的子树内，供 UI 过滤与文件操作授权使用。
// workspaceInRepoPath 为 "." 时全部命中；其余情况要求 repoRelativePath 等于工作区或以「工作区/」开头，
// 不能直接用 startsWith(workspace)，否则 foo 会误匹配 foobar。
export function isPathInWorkspaceScope(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): boolean {
  // 前置条件：两侧都必须是仓库相对路径；传绝对路径不会报错，只会得到错误的归属判断。
  // 先剥掉开头的 ./ 再比较，否则 UI 传进来的相对路径会整体判为不在工作区。
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  // 工作区路径走同一个 normalizeWorkspaceInRepoPath，两边口径不一致时 startsWith 比较必然失配。
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  // 工作区是仓库根时全部命中，这里直接返回 true 而不拼空前缀。
  if (normalizedWorkspace === ".") {
    return true;
  }

  return (
    // 补一个斜杠再 startsWith，否则工作区 foo 会把 foobar 也判进来。
    normalizedPath === normalizedWorkspace || normalizedPath.startsWith(`${normalizedWorkspace}/`)
  );
}

// 把 repoRelativePath 裁剪成工作区内的相对路径，供 UI 展示；越界时原样返回，不能抛错中断整条文件列表。
// 工作区根时原样返回；等于工作区本身时返回 "."；不在工作区内（正常不应出现）则保留原路径而不是抛错，
// 因为该函数也用于展示兜底，抛错会让整条链路失败。
export function toWorkspaceRelativeGitPath(
  repoRelativePath: string,
  workspaceInRepoPath: string,
): string {
  // 前置条件：repoRelativePath 已由 git 输出或调用方归一为仓库相对路径；本函数不校验它是否真的在仓库内。
  const normalizedPath = normalizeGitPath(repoRelativePath).replace(/^\.?\//, "");
  const normalizedWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  if (normalizedWorkspace === ".") {
    return normalizedPath;
  }

  // 路径正好等于工作区时返回点号，直接切片会得到空串，UI 上显示成空白。
  if (normalizedPath === normalizedWorkspace) {
    return ".";
  }

  // 不在工作区内的路径原样返回，这个函数也用于展示兜底，抛错会让整条文件列表加载失败。
  return normalizedPath.startsWith(`${normalizedWorkspace}/`)
    // 加 1 是为了连斜杠一起去掉，只减前缀长度会留下前导 /。
    ? normalizedPath.slice(normalizedWorkspace.length + 1)
    : normalizedPath;
}
