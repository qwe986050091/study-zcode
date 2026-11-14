// openInEditor.ts —— 桌面主进程把「编辑器 id + 路径 + 可选远端目标」翻译成本机进程调用的唯一出口，
// 覆盖本机文件应用、VS Code Remote-SSH、VS Code Remote-WSL 与 Windows 资源管理器四类目标。
// 不负责 workspace 归属判定、远端可达性探测与会话生命周期，也不负责渲染层提示。
//
// INV-01 断言：编辑器 id 未命中当前平台定义时直接返回 unknown editor，不再尝试系统默认程序 —— 守住它的位置：openInEditor 开头的 def 查找 —— 改错故障：任意伪造 id 都会走 fallback 并弹出系统级「找不到应用」对话框。
// INV-02 断言：文件应用分支必须先于编辑器分支执行 —— 守住它的位置：openInEditor 中的 fileApp 判断 —— 改错故障：PDF、图片类 id 会按代码 CLI 打开，用户看到的是空白编辑器而不是阅读器。
// INV-03 断言：远端目标、目录、非绝对路径、扩展名不匹配四者任一成立就拒绝文件应用 —— 守住它的位置：fileApp 的组合条件 —— 改错故障：远端路径被当成本机路径，阅读器弹出「文件不存在」。
// INV-04 断言：启动文件应用前必须用异步 stat 二次确认目标是文件 —— 守住它的位置：fileApp 分支的 stat 判断 —— 改错故障：renderer 传入已删除路径时会残留阅读器进程或错误弹窗。
// INV-05 断言：远端 VS Code 只能通过 vscode-remote URI 打开，不能把远端路径交给本机 CLI —— 守住它的位置：两处 isVSCodeEditor 分支 —— 改错故障：在本机建出一个不存在的空窗口，远端目录始终打不开。
// INV-06 断言：SSH authority 必须整段编码后拼进 URI —— 守住它的位置：buildVSCodeSshFolderUri —— 改错故障：user@host:22 被解析成 userinfo、host、port，VS Code 连到错误主机。
// INV-07 断言：文件用 --file-uri、目录用 --folder-uri，两者不可合并或互换 —— 守住它的位置：两个远程打开函数的 args —— 改错故障：打开单个文件时 VS Code 把该文件当成空工作区目录。
// INV-08 断言：WSL distro 解析失败必须 fail closed —— 守住它的位置：resolveWslDistroName 与两个 WSL 调用方 —— 改错故障：静默打开 Windows 侧同名路径，用户以为看到的是 WSL 内容。
// INV-09 断言：UNC 候选按 wsl.localhost 优先、wsl$ 兜底的固定顺序遍历 —— 守住它的位置：buildWslUncPathCandidates —— 改错故障：旧版 Windows 或未启用 9P 的机器上资源管理器一律打不开。
// INV-10 断言：explorer 非零退出不等于失败，必须由 isDelegatedWindowsExplorerExit 判定 —— 守住它的位置：openWslPathInExplorer 的 catch —— 改错故障：窗口已经弹出却继续尝试下一候选，重复打开两个资源管理器窗口。
// INV-11 断言：委托成功时立即返回成功，不覆盖 lastError —— 守住它的位置：openWslPathInExplorer 循环内部 —— 改错故障：真实错误被后续候选的失败信息掩盖，日志指向错误原因。
// INV-12 断言：本机文件用 showItemInFolder 定位且只发一次请求 —— 守住它的位置：finder 与 explorer 分支 —— 改错故障：文件被打开两次，或目录窗口叠加两层。
// INV-13 断言：长驻阅读器必须 detached、stdio ignore、unref 三件齐全 —— 守住它的位置：fileApp 的 spawn 调用 —— 改错故障：主进程被子进程拖住，退出应用后仍有残留进程。
// INV-14 断言：spawn 成功必须以 spawn 事件为准，不以 exit 或 close 为准 —— 守住它的位置：fileApp 的 Promise 包装 —— 改错故障：阅读器常驻不退出，打开操作永久 pending。
// INV-15 断言：CLI 失败后 Windows 必须回退到 appPath 直启，macOS 与 Linux 只能回退到 open -a —— 守住它的位置：三处 catch 分支 —— 改错故障：CLI 装坏时整条打开链路失败，用户无法用已安装应用打开。
// INV-16 断言：所有失败路径都返回 success false 加 error 并记 warn，不向上抛异常 —— 守住它的位置：全文件 catch 块 —— 改错故障：IPC 层收到未捕获 rejection，renderer 显示未知错误。
import { stat } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { shell } from "electron";
import type { OpenInEditorOptions, OpenInEditorRemoteTarget } from "@zcode/shared";
import { listWSLDistros } from "@zcode/server/remote/wsl-detect.js";
import { getEditorDefsForCurrentPlatform, resolveEditorDefAppPath } from "./editors.js";
import { logger } from "./logger.js";
import {
  getFileApplicationDefs,
  matchesFileApplication,
  resolveFileApplicationPath,
} from "@desktop/main/fileApplications.js";
import { isDelegatedWindowsExplorerExit } from "./windowsExplorerDelegation.js";

type PathKind = "file" | "directory" | "unknown";

interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

// [契约] 只有这两个 id 会走 vscode-remote URI 分支；codium、cursor 等即使支持远端也仍按本机 CLI 处理。
// 扩充集合时必须同步 openInEditor 的两处 isVSCodeEditor 判断，否则会拼出编辑器不认识的 URI scheme。
// 不要用前缀或模糊匹配，editor id 是精确契约，误判会把本机路径塞进远端 URI。
const VSCODE_EDITOR_IDS = new Set(["vscode", "vscode-insiders"]);

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// [失败路径] 这里只关心进程能否启动，stdout 与 stderr 被丢弃，判断打开是否成功不能依赖输出内容。
// 不经过 shell 拼接，路径里的空格、引号、美元符号不会被二次解释，这是看不到引号包裹的原因。
// 回调里的 error 同时覆盖启动失败与非零退出，调用方只能靠 isDelegatedWindowsExplorerExit 区分委托场景。
const execFileAsync = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
  });

async function openPathViaShell(path: string): Promise<OpenInEditorResult> {
  const error = await shell.openPath(path);
  return error ? { success: false, error } : { success: true };
}

// [权衡] 主进程使用同步 stat，目的是让后续分支判断保持同步；路径来自本地磁盘，耗时通常在毫秒级。
// 改成异步会让 finder 与 explorer 分支全部需要 await，分支顺序与返回时机也随之改变。
// [失败路径] 任何 stat 异常（不存在、无权限、UNC 未连接）都归一为 unknown，由分支自行决定后续动作。
// 不要把 catch 改成抛错：远端目标已在上游分流，残留的非本地路径要靠 unknown 走系统 shell 打开。
function detectPathKind(path: string): PathKind {
  try {
    const stats = statSync(path);
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
  } catch {
    // 非本地路径或路径不存在时保留 unknown，交给后续 fallback 处理。
  }
  return "unknown";
}

function isVSCodeEditor(editorId: string): boolean {
  return VSCODE_EDITOR_IDS.has(editorId);
}

function normalizeRemotePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

// [契约] 首段保留空串，因此结果一定以单个斜杠开头，VS Code 的 URI 解析依赖这个绝对路径形态。
// 逐段编码，路径里的空格、井号、问号、中文不会被当成 URI 分隔符。
// 斜杠本身不编码，否则 vscode-remote 会把整条路径视为单段文件名。
// 不要顺手去掉末尾斜杠或合并连续斜杠，那会改变远端目录语义与 workspace 去重结果。
function encodeRemotePath(path: string): string {
  return normalizeRemotePath(path)
    .split("/")
    .map((segment, index) => (index === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
}

// [契约] 显式 distro 优先且只做 trim，不做存在性校验；用户填错由后续 CLI 报错，这里不预判。
// 未显式指定时取 isDefault 的发行版，其次取列表第一个，全部失败返回 null。
// [失败路径] 返回 null 的调用方必须 fail closed，不能退回本机路径，否则会打开同名的 Windows 目录。
// 发行版列表读取失败只记 warn，不抛出：WSL 未安装时打开操作应得到可读错误而不是 rejection。
async function resolveWslDistroName(
  target: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
): Promise<string | null> {
  const explicitDistro = target.distro?.trim();
  if (explicitDistro) {
    return explicitDistro;
  }

  try {
    const distros = await listWSLDistros();
    return distros.find((distro) => distro.isDefault)?.name ?? distros[0]?.name ?? null;
  } catch (error) {
    logger.warn("[editors] 解析默认 WSL distro 失败", {
      error: stringifyError(error),
    });
    return null;
  }
}

// [契约] 返回两个候选且顺序固定：先用 wsl.localhost（9P），再退到旧式 wsl$ 共享。
// 顺序颠倒会让老系统每次都先失败一次，多一次无谓的进程启动与延迟。
// 路径分隔符统一转成反斜杠后再拼接，UNC 不接受正斜杠，混用会让部分 Windows 版本解析失败。
function buildWslUncPathCandidates(path: string, distroName: string): string[] {
  const normalizedPath = normalizeRemotePath(path);
  const suffix = normalizedPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("\\");
  const pathSuffix = suffix ? `\\${suffix}` : "";

  return [`\\\\wsl.localhost\\${distroName}${pathSuffix}`, `\\\\wsl$\\${distroName}${pathSuffix}`];
}

// [契约] sshConfigAlias 存在时直接返回，忽略用户名、主机与端口，因为 alias 已包含完整连接信息。
// 没有 alias 时按用户名加主机组装，用户名为空则省略 @，避免出现非法的 @host 形式。
// 端口只在非 22 时拼接，22 是 SSH 默认值，写进 authority 会让部分版本的 Remote-SSH 匹配不到 Host 配置。
// 不要在此处做 URI 编码，编码是 buildVSCodeSshFolderUri 的职责，重复编码会得到二次转义。
function resolveVSCodeSshRemoteAuthority(
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
): string {
  const sshConfigAlias = target.sshConfigAlias?.trim();
  if (sshConfigAlias) {
    return sshConfigAlias;
  }

  const username = target.username.trim();
  const host = target.host.trim();
  const userHost = username ? `${username}@${host}` : host;
  return target.port && target.port !== 22 ? `${userHost}:${target.port}` : userHost;
}

function buildVSCodeSshFolderUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
) {
  // 手填 SSH 目标没有 alias 时，authority 里可能包含 `@` 和 `:`。
  // 直接拼进 URI 会被解析成 userinfo/host/port，必须按 Remote-SSH authority 组件整体编码。
  const encodedAuthority = encodeURIComponent(resolveVSCodeSshRemoteAuthority(target));
  return `vscode-remote://ssh-remote+${encodedAuthority}${encodeRemotePath(path)}`;
}

// [契约] distro 名必须单独编码后拼在 wsl+ 之后，路径部分交给 encodeRemotePath，两段编码互不重叠。
// distro 解析失败返回 error 而不是抛异常，调用方以统一结果结构回传 renderer。
// 不要把 distro 与路径合并编码，否则 wsl+ 后面的发行版名会被当成路径前缀。
async function buildVSCodeWslFolderUri(
  path: string,
  target: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
): Promise<{ uri?: string; error?: string }> {
  const distroName = await resolveWslDistroName(target);
  if (!distroName) {
    return { error: "missing WSL distro for VS Code Remote-WSL" };
  }

  return {
    uri: `vscode-remote://wsl+${encodeURIComponent(distroName)}${encodeRemotePath(path)}`,
  };
}

// [契约] args 第一项必须是 --file-uri 或 --folder-uri，由 pathKind 决定，不能两个都传。
// command 存在时先走编辑器自带 CLI，失败后 Windows 用 appPath 直启，macOS 与 Linux 用 open -a。
// [失败路径] 两条路径都失败才返回错误，对外用 fallbackError，原始 error 只进日志供对照。
async function openVSCodeRemoteSshFolder(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "ssh" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  // 远程文件和目录以前共用 folder URI，导致文件路径被 VS Code 当成目录；
  // pathKind 只决定 CLI URI 参数，远端路径与 workspace identity 保持原样。
  const args = [
    pathKind === "file" ? "--file-uri" : "--folder-uri",
    buildVSCodeSshFolderUri(path, remoteTarget),
  ];

  if (command) {
    try {
      await execFileAsync(command, args);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, args, error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, "--args", ...args]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] 打开 VS Code 远程工作区失败", {
          editorId,
          path,
          args,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, args);
    } else {
      await execFileAsync("open", ["-a", appPath, "--args", ...args]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开 VS Code 远程工作区失败", {
      editorId,
      path,
      args,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

// 与 SSH 分支结构对称，差别只在 URI 需要先异步解析 distro，因此失败要提前返回。
// [契约] folderUri 缺失时返回 invalid WSL folder URI，绝不退化成用 Linux 路径调本机 code。
// 后续 CLI 与 appPath 回退逻辑必须与 SSH 分支保持一致，改一处就要同步另一处。
async function openVSCodeRemoteWslFolder(
  editorId: string,
  appPath: string,
  command: string | null,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  const folderUri = await buildVSCodeWslFolderUri(path, remoteTarget);
  if (!folderUri.uri) {
    return { success: false, error: folderUri.error ?? "invalid WSL folder URI" };
  }

  const args = [pathKind === "file" ? "--file-uri" : "--folder-uri", folderUri.uri];

  if (command) {
    try {
      await execFileAsync(command, args);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        return openWindowsEditor(editorId, appPath, args, error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, "--args", ...args]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] 打开 VS Code WSL 工作区失败", {
          editorId,
          path,
          args,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, args);
    } else {
      await execFileAsync("open", ["-a", appPath, "--args", ...args]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开 VS Code WSL 工作区失败", {
      editorId,
      path,
      args,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}

// [资源] explorer.exe 每次调用都会拉起或唤醒进程，候选循环最多两轮，不要在此叠加额外重试。
// distro 解析失败立即返回，避免用空发行版名拼出无效的 UNC 前缀。
// [失败路径] lastError 只记录最后一个候选的错误，循环结束后统一上报，不参与分支判断。
// 任一路径成功即 return，不继续尝试后续候选，否则同一路径会被打开两次。
async function openWslPathInExplorer(
  appPath: string,
  path: string,
  remoteTarget: Extract<OpenInEditorRemoteTarget, { kind: "wsl" }>,
  pathKind: OpenInEditorOptions["pathKind"],
): Promise<OpenInEditorResult> {
  const distroName = await resolveWslDistroName(remoteTarget);
  if (!distroName) {
    return { success: false, error: "missing WSL distro for Windows Explorer" };
  }

  // [契约] 候选顺序就是 9P 到 wsl$ 的降级顺序，循环里的成功与委托判断都按这个顺序生效。
  // 文件追加新的定位参数让资源管理器选中目标，目录直接传路径打开，两者不能互换。
  // [权衡] 候选不做去重，两个前缀本身不同；若将来加入第三个前缀，必须保持一次成功即退出。
  const candidates = buildWslUncPathCandidates(path, distroName);
  let lastError = "";
  for (const candidate of candidates) {
    const args = pathKind === "file" ? ["/select,", candidate] : [candidate];
    try {
      await execFileAsync(appPath, args);
      return { success: true };
    } catch (error) {
      // explorer.exe 会把请求委托给已运行的资源管理器进程，窗口已经打开时
      // 子进程仍可能以 code=1 退出。不能只按数字退出码吞错；必须同时核对 Windows
      // 平台、进程状态、stderr 和本次完整命令，避免路径/权限/UNC 错误跳过候选 fallback。
      if (await isDelegatedWindowsExplorerExit(error, appPath, args, candidate)) {
        return { success: true };
      }
      lastError = stringifyError(error);
    }
  }

  logger.warn("[editors] 打开 WSL 工作区资源管理器失败", {
    path,
    candidates,
    error: lastError,
  });
  return { success: false, error: lastError || "failed to open WSL path in Explorer" };
}

// [契约] 这是 CLI 失败后的统一兜底：直接用已解析的 appPath 启动，不再经过 command。
// cliError 只用于日志对照，对外仍返回 appPath 这次的真实错误，避免把首次失败原因误报给用户。
// [失败路径] 失败时记录 warn 并返回 error 字段，不抛异常，由 IPC 层展示可读提示。
// 不要在这里再加一层 shell 打开兜底，那会绕过编辑器选择并丢掉参数语义。
async function openWindowsEditor(
  editorId: string,
  appPath: string,
  args: string[],
  cliError?: unknown,
): Promise<OpenInEditorResult> {
  try {
    await execFileAsync(appPath, args);
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开 Windows 编辑器失败", {
      editorId,
      args,
      appPath,
      error: stringifyError(error),
      cliError: cliError === undefined ? undefined : stringifyError(cliError),
    });
    return { success: false, error: stringifyError(error) };
  }
}

/**
 * 用指定编辑器打开路径。
 */
// 本函数是路由表本身，顺序即优先级：文件应用、SSH 远端、WSL 远端、WSL 资源管理器、本机分支。
// 任何前置分支都必须在 detectPathKind 之前 return，否则会对远端路径做本机 stat。
// [契约] 所有分支返回同构结果，调用方不需要区分错误来源。
// editorId 同时属于编辑器与文件应用两个注册表，查找顺序决定谁优先生效。
// 改动此顺序会直接改变用户可见行为，例如把文件应用后移会让阅读器被当成代码编辑器。
export async function openInEditor(
  editorId: string,
  path: string,
  options?: OpenInEditorOptions,
): Promise<OpenInEditorResult> {
  // [契约] 定义必须来自当前平台列表，跨平台 id 在这里已经不可见，因此未命中不一定是拼写错误。
  // 未命中直接返回 unknown editor，不再尝试系统默认程序，避免打开到用户没有选择的软件。
  // 不能改成大小写不敏感匹配，id 是稳定枚举值，模糊匹配可能命中近似的自定义编辑器。
  const def = getEditorDefsForCurrentPlatform().find((editor) => editor.id === editorId);
  if (!def) {
    return { success: false, error: `unknown editor: ${editorId}` };
  }

  // [契约] 文件应用与编辑器必须共用一个 id 命名空间，两个注册表都可能命中同一个 id。
  // 文件应用分支必须先执行，它支持的目标类型（远端、目录）比编辑器更窄。
  // 不能把两个列表合并查找，合并后无法区分该走阅读器还是代码编辑器路径。
  const fileApp = getFileApplicationDefs().find((app) => app.id === editorId);
  if (fileApp) {
    // 文档应用只能消费本机匹配类型的文件，不能把远端路径当成本机路径打开。
    if (
      options?.remoteTarget ||
      options?.pathKind === "directory" ||
      !(process.platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path)) ||
      !matchesFileApplication(fileApp, path)
    ) {
      return { success: false, error: "unsupported file application target" };
    }
    // renderer 的 pathKind 不能证明文件存在；异步 stat 避免阻塞主进程。
    if (!(await stat(path).catch(() => null))?.isFile())
      return { success: false, error: "unsupported file application target" };
    // [契约] 这里做的是异步安装路径解析，可能触发注册表或文件系统探测，不能改成同步。
    // 解析为空表示应用未安装，属于可预期的正常失败，直接返回 application is not installed。
    // 不要回退到定义里的默认路径继续尝试，未安装时启动只会得到系统级错误对话框。
    const applicationPath = await resolveFileApplicationPath(fileApp);
    if (!applicationPath) return { success: false, error: "application is not installed" };
    try {
      // [契约] macOS 必须经 open -a 启动，保证阅读器获得前台焦点与正确的应用身份。
      // 启动参数只在非空时追加，且必须放在 --args 之后，否则会被 open 当成自身参数。
      // [权衡] 非 macOS 走 detached spawn，因为阅读器常驻且会持续输出日志。
      // 两条分支传参顺序不同：open 是应用在前路径在后，spawn 是参数在前路径在最后。
      if (process.platform === "darwin") {
        await execFileAsync("open", [
          "-a",
          applicationPath,
          path,
          ...(fileApp.launchArgs?.length ? ["--args", ...fileApp.launchArgs] : []),
        ]);
      } else {
        // 阅读器可能长时间运行并输出日志；不能用 execFile 缓冲输出或等待其退出。
        const child = spawn(applicationPath, [...(fileApp.launchArgs ?? []), path], {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        // [资源] unref 后子进程不再阻止主进程退出，这是阅读器可以被安全遗留的前提。
        // [并发] Promise 只在 spawn 或 error 事件上结算，不等退出，因此启动成功即返回。
        // 不要改成等待 close 或轮询进程状态，阅读器不退出时会把打开操作永久挂起。
        child.unref();
      }
      return { success: true };
    } catch (error) {
      logger.warn("[editors] 打开文件应用失败", { editorId, path, error: stringifyError(error) });
      return { success: false, error: stringifyError(error) };
    }
  }

  // [契约] 优先用解析后的真实应用路径，失败才退回定义里的默认 appPath。
  // 远端分支与 Windows 兜底都复用这个结果，改这里会同时影响 SSH、WSL 与本机回退。
  // 不要在远端分支里直接用 def.command 启动，命令与路径的语义在远端并不等价。
  const appPath = resolveEditorDefAppPath(def) ?? def.appPath;
  if (options?.remoteTarget?.kind === "ssh" && isVSCodeEditor(editorId)) {
    // SSH 工作区的 workspacePath 是远端文件系统路径，不能按本机路径执行 `code /root/...`。
    // VS Code Remote-SSH 需要 folder URI 才会连接对应 SSH Host 并打开远端目录。
    return openVSCodeRemoteSshFolder(
      editorId,
      appPath,
      def.command,
      path,
      options.remoteTarget,
      options.pathKind,
    );
  }

  if (options?.remoteTarget?.kind === "wsl" && isVSCodeEditor(editorId)) {
    // WSL 工作区的 workspacePath 是 Linux 路径，不能直接传给 Windows 侧 `code`。
    // VS Code Remote-WSL 需要 folder URI，才能在指定 distro 内打开同一个 Linux 目录。
    return openVSCodeRemoteWslFolder(
      editorId,
      appPath,
      def.command,
      path,
      options.remoteTarget,
      options.pathKind,
    );
  }

  if (options?.remoteTarget?.kind === "wsl" && editorId === "explorer") {
    // Windows 资源管理器无法理解 `/home/...` 这类 WSL 内部路径。
    // 仅在打开宿主应用的边界把路径转成 UNC，远端 host / agent 仍保留 Linux 路径语义。
    return openWslPathInExplorer(appPath, path, options.remoteTarget, options.pathKind);
  }

  // [契约] 执行到这里说明所有远端目标已在上面分流，pathKind 只代表本机路径。
  // 该判断必须只影响 finder、explorer 与后续打开方式，不参与远端 URI 构造。
  // [权衡] 同步 stat 的代价换来了分支的同步可读性，若改成异步需重新检查所有 return 位置。
  const pathKind = detectPathKind(path);

  // [契约] finder 必须指 macOS 访达，文件用 showItemInFolder 定位，其余交给 shell.openPath。
  // showItemInFolder 不返回错误，因此命中文件时直接按成功返回。
  // 不要对文件调用 openPath，那会用默认应用打开文件而不是在目录中选中它。
  if (editorId === "finder") {
    if (pathKind === "file") {
      shell.showItemInFolder(path);
      return { success: true };
    }
    return openPathViaShell(path);
  }

  if (editorId === "explorer") {
    if (pathKind !== "file") {
      return openPathViaShell(path);
    }

    // Explorer 已委托打开请求后仍可能非零退出，按退出码回退会重复打开窗口。
    // 本地文件直接使用系统定位 API，只发出一次打开所在目录并选中文件的请求。
    shell.showItemInFolder(path);
    return { success: true };
  }

  // [契约] 有 CLI 命令时优先用命令加单个路径参数，兼容大多数编辑器的命令行打开语义。
  // 失败后 Windows 走 openWindowsEditor，macOS 与 Linux 走 open -a，原始 error 必须保留供日志对照。
  // [失败路径] 不要把路径拼进 shell 字符串重试，空格与特殊字符会被二次解释。
  // 远端分支不会走到这里，本分支只处理本机路径。
  if (def.command) {
    try {
      await execFileAsync(def.command, [path]);
      return { success: true };
    } catch (error) {
      if (process.platform === "win32") {
        // [契约] 这里传入的是只含路径的数组而不是 args，CLI 失败回退不携带 URI 参数。
        // 把 cliError 一起透传，日志里能同时看到命令失败与应用启动失败两层原因。
        // 回退失败时对外返回应用启动错误，而不是原始命令错误，便于用户判断该安装什么。
        return openWindowsEditor(editorId, appPath, [path], error);
      }

      try {
        await execFileAsync("open", ["-a", appPath, path]);
        return { success: true };
      } catch (fallbackError) {
        logger.warn("[editors] 打开编辑器失败", {
          editorId,
          path,
          error: stringifyError(error),
          fallbackError: stringifyError(fallbackError),
        });
        return { success: false, error: stringifyError(fallbackError) };
      }
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync(appPath, [path]);
    } else {
      await execFileAsync("open", ["-a", appPath, path]);
    }
    return { success: true };
  } catch (error) {
    logger.warn("[editors] 打开编辑器失败", {
      editorId,
      path,
      error: stringifyError(error),
    });
    return { success: false, error: stringifyError(error) };
  }
}
