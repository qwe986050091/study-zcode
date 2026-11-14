// Linux 深链注册：把 zcode:// 绑定到用户级 XDG 桌面项，并在系统级条目的遮蔽关系下保持幂等。
// 数据单向流动：环境与启动参数先归一成命令，再渲染成 desktop 文本，最后交给 xdg 工具落盘与设默认。
// INV-01 桌面项只在 Linux 路径上写入，其他平台不得复用该注册入口；守住位置：registerLinuxDeepLinkProtocol 的调用侧与 resolveLinuxUserDataDir 的路径拼装；改错故障：macOS 或 Windows 被写入 XDG 目录，deep link 全部失效。
// INV-02 AppImage 环境存在时回调可执行文件改用 APPIMAGE 路径，否则退回传入的 executablePath；守住位置：resolveLinuxDeepLinkCommand 的分支；改错故障：桌面项指向临时挂载点，重启后 zcode:// 全部打不开。
// INV-03 Exec 行只持久化启动必需的 allowlist 参数，不写入 deep link URL、调试端口或工作区路径；守住位置：resolveAppImageDeepLinkArgs 的过滤；改错故障：某次登录把 URL 永久固化进桌面项，后续链接仍跳旧地址。
// INV-04 allowlist 参数按出现顺序去重，重复项只保留第一次；守住位置：resolveAppImageDeepLinkArgs 的 seen 集合；改错故障：同一参数重复写入，Exec 行超长并触发部分启动器截断。
// INV-05 Exec 中每个路径词必须都用双引号包裹并转义反斜杠、双引号、反引号与美元符号；守住位置：quoteDesktopExecPath 的替换；改错故障：含空格或美元符号的安装路径被 shell 拆词，协议处理器启动即崩。
// INV-06 Exec 行末尾固定追加 %U，作为唯一 URL 占位符；守住位置：formatDesktopExec 的 concat；改错故障：xdg-open 传入的 zcode:// 地址被丢弃，应用只能空启动。
// INV-07 desktop 文件必须包含 MimeType 与 x-scheme-handler/zcode 声明，缺一即无法成为协议候选；守住位置：createLinuxDeepLinkDesktopEntry 的模板；改错故障：xdg-mime 找不到处理程序，登录回调停在浏览器。
// INV-08 归属标记行是所有版本共有的 Comment 字段，清理逻辑只认这一行；守住位置：LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER；改错故障：新版改字面量后旧条目不再被识别，遗留文件永久遮蔽系统安装。
// INV-09 系统级同名 desktop 条目存在时，用户级条目不得写入；守住位置：registerLinuxDeepLinkProtocol 的 systemDesktopEntryPath 分支；改错故障：用户级条目遮蔽 rpm/deb 条目，快捷方式仍指向旧 AppImage。
// INV-10 系统级条目存在时必须只清理带归属标记的本应用条目，用户手写条目原样保留；守住位置：removeOwnedUserDesktopEntry 的 isOwnedDesktopEntry 判断；改错故障：用户自定义启动项被删，桌面快捷方式消失。
// INV-11 归属判断必须按行去回车并 trim 后比较，容忍 CRLF 与行首尾空白；守住位置：isOwnedDesktopEntry 的逐行比较；改错故障：手工编辑过的遗留条目被判为用户条目，旧遮蔽无法清除。
// INV-12 内容未变化时不重写文件，保持 mtime 稳定；守住位置：writeFileIfChanged 的早退；改错故障：每次启动都刷新桌面项，文件管理器与索引反复重扫。
// INV-13 注册流程整体包在 try 内，任何异常只记 warn 而不抛给调用方；守住位置：registerLinuxDeepLinkProtocol 的 catch；改错故障：深链注册失败直接阻断进程启动，应用打不开。
// INV-14 xdg-mime 返回 0 才算注册成功，其余状态、超时与错误一律只记录不重试；守住位置：defaultResult.status 判断；改错故障：失败被当成成功，日志无告警且登录回调无提示地失效。
// INV-15 update-desktop-database 是可选增强，失败、超时或缺失都不能影响协议注册结论；守住位置：updateResult 的三段告警分支；改错故障：缺该命令的发行版被判注册失败，用户被误导去重装。
// INV-16 协议注册成功与否只由 xdg-mime 结果决定，图标安装结果不得反向修改该结论；守住位置：protocolRegistered 的赋值点；改错故障：图标失败把日志打成注册失败，排障方向被带偏。
// INV-17 图标安装只在没有系统级条目时执行，且不抛出异常；守住位置：iconInstallResult 的条件调用；改错故障：系统安装形态重复写用户级图标，与系统图标冲突。
// INV-18 命令执行超时必须统一折算为 XDG_COMMAND_TIMEOUT_MS 上报，仅在 SIGTERM 时附带；守住位置：注册失败与数据库超时的日志字段；改错故障：超时与普通失败无法区分，用户看不到真实卡点。
//
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installLinuxAppImageDesktopIconBestEffort } from "./desktopLinuxAppImageIcon.js";
import {
  runXdgCommand,
  XDG_COMMAND_TIMEOUT_MS,
  type LinuxDesktopCommandRunner,
  type LinuxDeepLinkRegistrationLogger,
} from "./desktopLinuxXdg.js";

// [事务] 桌面项文件名是协议归属的唯一键，注册、清理与 xdg-mime 默认值三处必须共用同一常量。
// [权衡] 用固定文件名而非产品名派生，换取跨版本可识别，代价是改名即等于换协议所有者。
const LINUX_DEEP_LINK_DESKTOP_FILE = "zcode.desktop";
const LINUX_DEEP_LINK_MIME_TYPE = "x-scheme-handler/zcode";
// 归属标记：用于识别用户级 zcode.desktop 是否由本应用写入（历史所有版本都带这行 Comment）。
// [事务] 归属标记是清理动作的唯一凭据，写入与识别必须逐字节一致。
// [失败路径] 标记缺失时宁可保留文件也不删除，避免误删用户自建条目。
// [权衡] 归属标记必须放在 Comment 字段，既不影响启动又能被检索到，代价是用户占用同名字段即被认作本应用。
const LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER = "Comment=ZCode Desktop App";

type LinuxDesktopEnv = {
  APPIMAGE?: string;
  XDG_DATA_HOME?: string;
  XDG_DATA_DIRS?: string;
};

interface RegisterLinuxDeepLinkProtocolOptions {
  executablePath: string;
  homeDir: string;
  productName?: string;
  iconSourcePath?: string;
  env?: LinuxDesktopEnv;
  argv?: string[];
  logger: LinuxDeepLinkRegistrationLogger;
  runCommand?: LinuxDesktopCommandRunner;
  systemApplicationDirs?: string[];
}

interface LinuxDeepLinkCommand {
  executablePath: string;
  args: string[];
}

// [并发] 参数名单必须在模块加载时冻结，注册期间只读，不随启动参数变化。
// [资源] 必须只收无值开关，带值的参数一律走前缀表，避免误把参数值写进 Exec。
// [失败路径] 名单外的参数被丢弃后仍需保证应用能启动，遗漏的开关会退化为二次启动崩溃。
const APPIMAGE_DEEP_LINK_ARG_NAMES = new Set([
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
]);

// [权衡] 前缀表覆盖 GPU 与特性开关，允许整类取值透传，代价是新前缀必须显式登记。
// [失败路径] 前缀不匹配即静默跳过，不告警，避免日志被启动参数刷屏。
const APPIMAGE_DEEP_LINK_ARG_PREFIXES = [
  "--use-gl=",
  "--use-angle=",
  "--disable-features=",
  "--enable-features=",
];

// [事务] 决策只依赖环境里的 APPIMAGE 与实际 argv，函数内不读其他全局状态。
// [权衡] 非 AppImage 环境返回空参数，由上层安装包决定 Exec，不在 main 里猜测发行版。
// [失败路径] APPIMAGE 为空串或纯空白时按非 AppImage 处理，不生成指向空路径的桌面项。
export function resolveLinuxDeepLinkCommand(params: {
  env?: { APPIMAGE?: string };
  executablePath: string;
  argv?: string[];
}): LinuxDeepLinkCommand {
  const appImagePath = params.env?.APPIMAGE?.trim();
  if (!appImagePath) {
    return { executablePath: params.executablePath, args: [] };
  }

  return {
    executablePath: appImagePath,
    // AppImage 的 zcode:// 回调会由 xdg-open 按 .desktop Exec 二次启动。
    // 用户手动启动时附加的 sandbox/GPU 参数不会自动继承，二次启动可能在 Electron 初始化前崩溃。
    // 这里只持久化影响启动成败的 allowlist 参数，避免把 deep link URL、调试端口或工作区路径写死。
    args: resolveAppImageDeepLinkArgs(params.argv ?? []),
  };
}

// [资源] 转义只针对反斜杠、双引号、反引号与美元符号四类字符，desktop 的引号规则与 shell 不同。
// [失败路径] 漏转义任一字符都会让 Exec 被拆词或触发变量展开，路径含空格时尤其致命。
// [事务] 整串必须始终加双引号，百分号占位符不在 quoteDesktopExecPath 处理，留待拼接 Exec 时追加。
function quoteDesktopExecPath(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (match) => `\\${match}`)}"`;
}

function isAllowedAppImageDeepLinkArg(arg: string): boolean {
  return (
    APPIMAGE_DEEP_LINK_ARG_NAMES.has(arg) ||
    APPIMAGE_DEEP_LINK_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

// [并发] 去重集合只在本次调用内生效，注册可重入而互不影响。
// [事务] 输出顺序与输入一致，不排序，保证 Exec 行为可复现。
// [权衡] 重复参数只保留首次出现，宁可少传也不让 Exec 膨胀。
function resolveAppImageDeepLinkArgs(argv: string[]): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!isAllowedAppImageDeepLinkArg(arg) || seen.has(arg)) {
      continue;
    }
    seen.add(arg);
    args.push(arg);
  }
  return args;
}

function quoteDesktopExecToken(value: string): string {
  return quoteDesktopExecPath(value);
}

// [事务] 路径与参数逐词引用后再拼接，最后追加 %U，顺序即启动顺序。
// [失败路径] 缺少 %U 时 URL 无处落位，桌面项只能空启动，这是协议失效最常见的形态。
function formatDesktopExec(command: LinuxDeepLinkCommand): string {
  return [command.executablePath, ...command.args]
    .map(quoteDesktopExecToken)
    .concat("%U")
    .join(" ");
}

// [事务] 模板字段固定且顺序稳定，便于写入前按内容比较判断是否需要落盘。
// [权衡] 不写 TryExec 与 Path，减少对外部环境的假设，代价是启动失败时不会有二次校验。
export function createLinuxDeepLinkDesktopEntry(params: {
  executablePath: string;
  args?: string[];
  productName?: string;
  iconName?: string;
}): string {
  const productName = params.productName ?? "ZCode";
  const iconName = params.iconName ?? "zcode";
  const command = {
    executablePath: params.executablePath,
    args: params.args ?? [],
  };
  return [
    "[Desktop Entry]",
    `Name=${productName}`,
    LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER,
    `Exec=${formatDesktopExec(command)}`,
    "Terminal=false",
    "Type=Application",
    `Icon=${iconName}`,
    "Categories=Development;",
    `MimeType=${LINUX_DEEP_LINK_MIME_TYPE};`,
    `StartupWMClass=${productName}`,
    "",
  ].join("\n");
}

export function resolveLinuxUserDataDir(params: {
  env?: { XDG_DATA_HOME?: string };
  homeDir: string;
}): string {
  const xdgDataHome = params.env?.XDG_DATA_HOME?.trim();
  return xdgDataHome || join(params.homeDir, ".local", "share");
}

export function resolveLinuxSystemApplicationDirs(env?: { XDG_DATA_DIRS?: string }): string[] {
  const raw = env?.XDG_DATA_DIRS?.trim();
  const entries = raw
    ? raw
        .split(":")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  // XDG 规范默认值为 /usr/local/share:/usr/share；全部为空的 XDG_DATA_DIRS 也回落默认值。
  const dataDirs = entries.length > 0 ? entries : ["/usr/local/share", "/usr/share"];
  return dataDirs.map((dir) => join(dir, "applications"));
}

// [资源] 只做同步 stat 探测，候选目录数量有限，所以不引入额外进程。
// [失败路径] 命中即返回首个系统级条目，不再继续扫描，避免多次误判。
function findSystemLevelDesktopEntryPath(systemApplicationDirs: string[]): string | undefined {
  for (const dir of systemApplicationDirs) {
    const candidate = join(dir, LINUX_DEEP_LINK_DESKTOP_FILE);
    // 边界：目录或损坏的路径不应被当成有效系统级条目，否则纯 AppImage 用户
    // 的用户级注册会被病态路径误抑制。只有普通文件才参与遮蔽判断。
    try {
      // [失败路径] 只有普通文件才算遮蔽，目录与损坏路径一律跳过。
      // [权衡] 用 try 吞掉权限错误，宁可漏判也不让注册流程中断。
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // 路径不存在或不可 stat（权限），跳过该候选目录。
    }
  }
  return undefined;
}

// [事务] 逐行比较前去掉回车与首尾空白，兼容 CRLF 与手工编辑产生的空白。
// [失败路径] 读取失败按非本应用处理，宁可留下也不误删。
function isOwnedDesktopEntry(path: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    // 去掉 \r 与行首尾空白，兼容 CRLF 行尾或手工编辑器引入的额外空白，
    // 避免可清理的遗留条目被误判为用户自定义条目而永久残留。
    return content
      .split("\n")
      .some((line) => line.replaceAll("\r", "").trim() === LINUX_DESKTOP_ENTRY_OWNERSHIP_MARKER);
  } catch {
    return false;
  }
}

// [失败路径] 删除失败只告警不抛出，遗留条目留待下次注册再处理。
// [事务] removeOwnedUserDesktopEntry 必须先判存在再判归属，两步都通过才执行删除。
function removeOwnedUserDesktopEntry(
  desktopFilePath: string,
  logger: LinuxDeepLinkRegistrationLogger,
): void {
  if (!existsSync(desktopFilePath)) {
    return;
  }
  if (!isOwnedDesktopEntry(desktopFilePath)) {
    logger.warn("[deep-link] Linux 用户级 zcode.desktop 非本应用写入，保留不清理", {
      desktopFilePath,
    });
    return;
  }
  try {
    rmSync(desktopFilePath);
    logger.info("[deep-link] 已清理遗留的用户级 zcode.desktop，恢复系统级条目", {
      desktopFilePath,
    });
  } catch (error) {
    logger.warn("[deep-link] 清理遗留用户级 zcode.desktop 失败", { desktopFilePath, error });
  }
}

function resolveLinuxDeepLinkDesktopFilePath(dataDir: string): string {
  return join(dataDir, "applications", LINUX_DEEP_LINK_DESKTOP_FILE);
}

// [事务] 内容相同即返回未变更，避免无意义写入。
// [资源] 写入前递归创建 applications 目录，首次安装时该目录常不存在。
// [并发] 不持有锁，多个实例同时注册以最后一次 rename 写入为准，内容相同所以结果收敛。
function writeFileIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    return false;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

// [事务] 整个函数必须按「解析命令、决定条目、写盘、刷新数据库、设默认」单向推进，无回滚。
// [失败路径] 任一外部命令失败都只降级为日志，调用方不会被异常打断。
// [并发] 幂等来自内容比较与归属标记，重复调用不产生重复副作用。
export function registerLinuxDeepLinkProtocol(options: RegisterLinuxDeepLinkProtocolOptions): void {
  const command = resolveLinuxDeepLinkCommand({
    env: options.env,
    executablePath: options.executablePath,
    argv: options.argv,
  });
  const dataDir = resolveLinuxUserDataDir({ env: options.env, homeDir: options.homeDir });
  const desktopFilePath = resolveLinuxDeepLinkDesktopFilePath(dataDir);
  const applicationsDir = dirname(desktopFilePath);
  const desktopEntry = createLinuxDeepLinkDesktopEntry({
    ...command,
    productName: options.productName,
  });
  let protocolRegistered = false;
  const runCommand = options.runCommand ?? runXdgCommand;

  // 用户级 zcode.desktop 在 XDG
  // 解析中永远优先于系统级同名条目。rpm/deb 安装后，旧 AppImage 写入的用户级条目会把
  // /usr/share/applications/zcode.desktop 持续遮蔽，快捷方式和 zcode:// deep link 一直
  // 指向旧 AppImage（文件还在时）或直接失效（文件被删后），只有手动跑一次新版才会被覆盖。
  // 现在只要检测到系统级同 ID 条目：
  // - 系统安装形态（rpm/deb）运行时：清掉本应用写入的遗留用户级条目，且不再写用户级；
  // - AppImage 运行时：不再写用户级条目和用户级图标，避免旧 AppImage 再度遮蔽系统安装。
  // 用户手写的自定义 zcode.desktop（无归属标记）不受影响，保留不清理。
  // [事务] 系统级探测先于写盘，决定本次是清理、覆盖还是跳过。
  // [权衡] 默认目录来自 XDG_DATA_DIRS 回落值，测试可注入 systemApplicationDirs 绕开真实文件系统。
  // [失败路径] 探测本身容错，任何异常都折算为未发现系统级条目。
  const systemDesktopEntryPath = findSystemLevelDesktopEntryPath(
    options.systemApplicationDirs ?? resolveLinuxSystemApplicationDirs(options.env),
  );

  try {
    let changed = false;
    if (systemDesktopEntryPath) {
      options.logger.info("[deep-link] Linux 系统级 desktop entry 已存在", {
        systemDesktopEntryPath,
        desktopFilePath,
      });
      removeOwnedUserDesktopEntry(desktopFilePath, options.logger);
    } else {
      changed = writeFileIfChanged(desktopFilePath, desktopEntry);
    }
    // AppImage 直跑不会像 deb 安装包一样稳定写入系统 desktop entry。
    // deep link 是 OAuth/支付/工作区打开的核心链路，必须先完成用户级协议处理器刷新；
    // 图标安装是可选增强，放到核心注册成功后独立降级，避免扩大登录回调失败域。
    // [资源] 数据库刷新在任何结果下都先执行，为后续 xdg-mime 建立索引。
    // [失败路径] 该命令缺失或超时只影响桌面缓存，不影响协议归属判定。
    const updateResult = runCommand("update-desktop-database", [applicationsDir]);
    const defaultResult = runCommand("xdg-mime", [
      "default",
      LINUX_DEEP_LINK_DESKTOP_FILE,
      LINUX_DEEP_LINK_MIME_TYPE,
    ]);

    // [事务] 状态为 0 是注册成功的唯一定义，成功日志与标志位在同分支写入。
    // [并发] protocolRegistered 标志位仅用于末尾图标日志，不参与控制流。
    if (defaultResult.status === 0) {
      protocolRegistered = true;
      options.logger.info("[deep-link] Linux 用户级协议注册成功", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        changed,
        systemDesktopEntryPath,
      });
    } else {
      options.logger.warn("[deep-link] Linux 用户级协议注册失败", {
        desktopFilePath,
        executablePath: command.executablePath,
        args: command.args,
        status: defaultResult.status,
        signal: defaultResult.signal,
        timeoutMs: defaultResult.signal === "SIGTERM" ? XDG_COMMAND_TIMEOUT_MS : undefined,
        error: defaultResult.error?.message,
        stderr: defaultResult.stderr?.trim(),
      });
    }

    if (updateResult.error) {
      options.logger.warn("[deep-link] update-desktop-database 不可用，已跳过", {
        desktopFilePath,
        message: updateResult.error.message,
      });
    } else if (updateResult.signal === "SIGTERM") {
      options.logger.warn("[deep-link] update-desktop-database 超时，已跳过", {
        desktopFilePath,
        timeoutMs: XDG_COMMAND_TIMEOUT_MS,
      });
    } else if (updateResult.status !== 0) {
      options.logger.warn("[deep-link] update-desktop-database 失败，已跳过", {
        desktopFilePath,
        status: updateResult.status,
        signal: updateResult.signal,
        stderr: updateResult.stderr?.trim(),
      });
    }
  // [失败路径] 异常必须只记 warn，包含 desktopFilePath 与命令，便于定位是写盘还是执行失败。
  // [权衡] 不向上抛出，换取启动可用，代价是注册失败需靠日志发现。
  } catch (error) {
    options.logger.warn("[deep-link] Linux 用户级协议注册异常", {
      desktopFilePath,
      executablePath: command.executablePath,
      args: command.args,
      error,
    });
  }

  // [权衡] 有系统级 desktop 条目时整段跳过用户级图标，避免与系统图标重复。
  // [失败路径] 图标安装失败不改变协议注册结论，只体现在日志的 installed 字段。
  const iconInstallResult = systemDesktopEntryPath
    ? null
    : installLinuxAppImageDesktopIconBestEffort({
        dataDir,
        env: options.env,
        iconSourcePath: options.iconSourcePath,
        logger: options.logger,
        runCommand,
      });
  if (iconInstallResult) {
    options.logger.info("[deep-link] Linux AppImage 用户级图标安装完成", {
      protocolRegistered,
      iconFilePath: iconInstallResult.iconFilePath,
      iconInstalled: iconInstallResult.installed,
      iconChanged: iconInstallResult.changed,
    });
  }
}
