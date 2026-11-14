// ============================================================================
// 终端服务（Host 侧）：把 node-pty 的 PTY 会话包装成 RPC 可用的 ITerminalService，
// 并负责 shell/cwd/env 三处「GUI 启动时必然拿不到」的可用性回退。
//
// INV-01：terminals 是 id → 实例的唯一所有者；create 登记后，pty 退出与 dispose 都必须
//         双向删除，否则 disposeAll 会 kill 已死 PTY，内存诊断的 open 计数只增不减。
// INV-02：无监听者期间的输出由 createBufferedTerminalOutputEmitter 有界缓存，订阅后
//         先回放再直通；改回普通 Emitter 会让远端链路丢掉 spawn 后的首个提示符。
// INV-03：node-pty 只在真正建终端时加载；顶层 import 会让缺 pty.node 的平台在服务注册
//         阶段就崩，整条远程连接失败。
// INV-04：任何交给 node-pty 的 shell/cwd 必须先验证可用，坏路径会直接变成 posix_spawnp
//         失败；候选链最终必须给出一个确定值，不允许「先传进去再看」。
// INV-05：resolveTerminalEnv 只改传给子进程的副本，绝不写回 process.env；污染全局会让
//         同进程内其他子进程继承错误的 TERM/locale。
// INV-06：spawn 抛错时不得留下已登记实例；exit 回调与显式 dispose 可能先后触发同一 id
//         的清理，两条路径都必须幂等。
// ============================================================================
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import type { IPty } from "node-pty";
import type { ISettingService } from "../setting/setting.js";
import type { ITerminalService, TerminalWindowsPtyInfo } from "./terminal.js";
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import("node-pty");
type PtySpawnOptions = Parameters<NodePtyModule["spawn"]>[2];

// 一个终端实例的三件套：PTY 本体 + 两条事件出口。
// 订阅方按 id 拿到的是这里的 emitter.event，必须保持同一引用：每次 new 一个 Event，
// 旧订阅就永久收不到数据，而 RPC 层无法感知这种「静默失联」。
interface TerminalInstance {
  pty: IPty;
  dataEmitter: Emitter<string>;
  exitEmitter: Emitter<number>;
}

// [并发] helper 修复只做一次、node-pty 只加载一次；单线程下赋值原子，无需加锁，
// 但 Promise 必须先赋值再 await，否则并发 create 会各触发一次 import。
let hasEnsuredNodePtyHelper = false;
let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

async function loadNodePtyModule(): Promise<NodePtyModule> {
  // [并发] 同步建立 pending Promise 再返回，后续调用复用同一次 import；
  // [失败路径] 失败时清空缓存，允许下一次 create 重试而不是永久缓存拒绝态。
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      const message = error instanceof Error ? error.message : String(error);
      // remote server 启动时会先创建所有服务，之前这里顶层 import node-pty，
      // 只要当前平台缺少 pty.node，就会在服务注册阶段直接崩掉，整条远程连接链路都失败。
      // 改成延迟加载后，server 可以先完成握手，仅在真正创建终端时再暴露“terminal 不可用”的错误。
      throw new Error(`node-pty is unavailable in this runtime: ${message}`);
    }) as Promise<NodePtyModule>;
  }

  return nodePtyModulePromise;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// [失败路径] release 文本不一定是 "10.0.22631" 形式，解析失败返回 undefined 而非 NaN，
// 让 ConPTY 能力判断自行降级，避免把 NaN 传进下游做数值比较。
export function parseWindowsBuildNumber(releaseText: string): number | undefined {
  const buildText = releaseText.split(".")[2];
  if (!buildText) return undefined;
  const buildNumber = Number.parseInt(buildText, 10);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

// 只有 win32 才返回 ConPTY 描述；平台与 release 做成参数，单测无需改 process 即可覆盖。
// [权衡] backend 固定写 conpty 而不去探测原生模块：该字段只用于 renderer 选渲染策略。
export function resolveTerminalWindowsPtyInfo(
  platform: NodeJS.Platform = process.platform,
  releaseText: string = release(),
): TerminalWindowsPtyInfo | undefined {
  if (platform !== "win32") return undefined;

  return {
    backend: "conpty",
    buildNumber: parseWindowsBuildNumber(releaseText),
  };
}

// 判断命令是否可执行：带分隔符的直接查，裸命令名遍历 PATH。
// [失败路径] accessSync 对「不存在」与「无 X 位」同样抛错，统一视作不可用，候选链因此可直接 try。
function isExecutable(command: string): boolean {
  try {
    if (/[\\/]/.test(command)) {
      accessSync(command, constants.X_OK);
      return true;
    }

    const pathEnv = process.env.PATH;
    if (!pathEnv) return false;

    return pathEnv.split(delimiter).some((dir) => {
      if (!dir) return false;
      try {
        accessSync(join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// cwd 可用性；[失败路径] 目录被删/无权限时 statSync 抛错即视为不可用，
// 让 resolveTerminalCwd 继续沿候选链回退，而不是把注定失败的路径交给 spawn。
function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// macOS 的 spawn-helper 是独立可执行文件，路径要从已加载的原生模块目录推导。
// [资源] asar 打包把二进制留在 *.asar.unpacked，这里必须替换两处 asar 段，否则 chmod 必失败。
function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform !== "darwin") return null;

  try {
    const utils = require("node-pty/lib/utils") as {
      loadNativeModule(name: string): { dir: string };
    };
    const native = utils.loadNativeModule("pty");
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

    let helperPath = resolve(dirname(unixTerminalPath), `${native.dir}/spawn-helper`);
    helperPath = helperPath.replace("app.asar", "app.asar.unpacked");
    helperPath = helperPath.replace("node_modules.asar", "node_modules.asar.unpacked");
    return helperPath;
  } catch {
    return null;
  }
}

// [并发] hasEnsuredNodePtyHelper 保证同进程只修一次；即使修复失败也置位，避免反复 throw 拖慢 create。
// [资源] 仅 macOS 生效：其他平台的 helper 由包管理器安装，改权限反而可能破坏签名。
function ensureNodePtySpawnHelperExecutable(): void {
  if (hasEnsuredNodePtyHelper || process.platform !== "darwin") return;
  hasEnsuredNodePtyHelper = true;

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath || !existsSync(helperPath)) return;

  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // 当前环境里的 node-pty spawn-helper 丢了执行权限，
    // child_process.spawn 还能工作，但 node-pty 在 macOS 上启动伪终端时会先调用这个 helper，
    // helper 不可执行就会直接报 posix_spawnp failed。
    // 这里在真正 spawn 前把 helper 修正为 0755，避免终端因为安装产物权限漂移而无法打开。
  }

  try {
    chmodSync(helperPath, 0o755);
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`node-pty spawn-helper is not executable: ${helperPath}. ${message}`);
  }
}

// 只把「原生模块 / conpty.dll 定位失败」识别为可回退错误。
// [权衡] 用白名单正则而非 catch-all：普通启动失败重试仍是失败，却会掩盖真实原因。
function shouldFallbackFromConptyDll(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(
    message,
  );
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

// macOS GUI 进程常见的缺失 PATH；顺序即优先级，Homebrew 在 /usr/bin 之前，避免同名旧版本遮蔽。
const DARWIN_GUI_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

// 合并多段 PATH，按出现顺序去重、先到先得。
// [权衡] 保留用户原有顺序而非把兜底前置，否则本地新版本会被系统目录里的同名命令抢先命中。
function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of entries) {
    for (const entry of value?.split(delimiter) ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }

  return merged.join(delimiter);
}

function resolveDarwinTerminalPath(env: NodeJS.ProcessEnv): string {
  return mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS]);
}

// 优先沿用用户已配置的 UTF-8 locale，缺失时才按平台补默认值。
// [权衡] 不无条件覆盖成 en_US.UTF-8：中日文用户依赖各自 locale 做排序与宽度计算。
function resolveFallbackUtf8Locale(env: NodeJS.ProcessEnv): string {
  const inheritedUtf8Locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;

  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

// 构造传给 PTY 的环境副本；INV-05 要求全程不触碰入参 env 与 process.env。
// 下面每一项都是「GUI 启动会缺失、交互 shell 必须正确」的变量，直接影响命令查找与中文路径显示。
export function resolveTerminalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const fallbackLocale = resolveFallbackUtf8Locale(env);

  // macOS 从 Dock/Finder/登录项启动 Electron 时，父进程通常只带 /usr/bin:/bin:/usr/sbin:/sbin，
  // 甚至缺失 PATH；内置终端虽然打开了登录 shell，但 zsh/bash 仍会先继承这个过窄 PATH，
  // 导致 ls 以外的 npm/node/pnpm 等常用命令找不到，部分用户的 profile 又不会重新补齐。
  // 这里仅在传给 terminal 的环境里补常见 Homebrew 与系统路径，不改全局 process.env，并保留用户已有顺序。
  if (process.platform === "darwin") {
    nextEnv.PATH = resolveDarwinTerminalPath(env);
  }

  // runtime 登录 shell 环境采集会用 TERM=dumb / CI=1 来避免 profile 脚本进入交互分支，
  // 但真实 terminal panel 必须作为交互终端启动，否则 starship、p10k、颜色能力检测等会降级成无样式输出。
  nextEnv.TERM = "xterm-256color";
  nextEnv.COLORTERM = nextEnv.COLORTERM?.trim() || "truecolor";
  if (nextEnv.CI === "1" && env.TERM === "dumb") {
    delete nextEnv.CI;
  }

  // Electron 从 GUI 启动时 host process 可能继承不到登录 shell 的 UTF-8 locale，
  // 子 shell 会落到 C/POSIX locale，中文路径会被 zsh/bash 显示成 \M-^ 这类转义乱码。
  // 这里只在 locale 缺失或明确为 C/POSIX 时补 UTF-8，保留用户已经配置好的 UTF-8 locale。
  if (isMissingOrCLocale(nextEnv.LANG)) {
    nextEnv.LANG = fallbackLocale;
  }
  if (isMissingOrCLocale(nextEnv.LC_CTYPE)) {
    nextEnv.LC_CTYPE = fallbackLocale;
  }
  if (nextEnv.LC_ALL !== undefined && isMissingOrCLocale(nextEnv.LC_ALL)) {
    nextEnv.LC_ALL = fallbackLocale;
  }

  return nextEnv;
}

// 真正调用 node-pty.spawn 的唯一位置；非 win32 走默认后端。
// [权衡] Windows 优先 ConPTY DLL（版本更新、与 Electron 捆绑一致），只在识别出原生模块
// 定位失败时回退系统 ConPTY，避免把真正的启动错误也吞掉重试。
function spawnTerminalProcess(params: {
  nodePty: NodePtyModule;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): IPty {
  const { nodePty, shell, cols, rows, cwd, env } = params;

  if (process.platform !== "win32") {
    return nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      encoding: "utf8",
    });
  }

  // 两条 Windows 路径共用基础选项，只有 useConptyDll 不同；分开构造保证回退后
  // cols/rows/env 完全一致，不会出现「回退一次尺寸就变了」的隐性差异。
  const windowsBaseOptions = {
    useConpty: true,
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } satisfies PtySpawnOptions;

  try {
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: true,
    });
  } catch (error) {
    if (!shouldFallbackFromConptyDll(error)) {
      throw error;
    }

    // Windows 下开启 node-pty 的实验性 useConptyDll 时，某些 Electron/安装包环境会在 shell 真正启动前
    // 就因为 conpty.node / conpty.dll 的原生模块定位失败直接报错，导致终端整个打不开。
    // 这里仅在命中这类 DLL 加载错误时回退到系统内置 ConPTY，既保留新版路径的优先级，也避免把普通启动失败误判成可重试。
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: false,
    });
  }
}

// 选出实际启动的 shell。
// [权衡] Windows 优先 pwsh：PSReadLine 5.1 在 ConPTY 下会把输入行空白重绘成 ANSI 黑底。
// [失败路径] 全部候选都不可执行时抛错，而不是把坏路径交给 spawn 到启动阶段才暴露。
export function resolveTerminalShell(): string {
  if (process.platform === "win32") {
    // Windows PowerShell 5.1 的 PSReadLine 在 ConPTY 下更容易把输入行空白重绘成 ANSI black 背景。
    // PowerShell 7+ 的终端兼容性更接近桌面端，优先使用已安装的 pwsh，找不到再回退到系统自带 shell。
    const candidates = ["pwsh.exe", "powershell.exe", process.env.ComSpec, "cmd.exe"];

    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) return candidate;
    }

    throw new Error("No usable Windows shell found for terminal startup");
  }

  // 之前直接信任 SHELL 环境变量，外部环境如果残留了一个不存在的 shell 路径，
  // node-pty 底层会把这个坏路径直接交给 posix_spawnp，终端创建时就会报错。
  // 这里先校验 SHELL 是否真的可执行，不可用时再按常见 shell 顺序回退，避免启动直接失败。
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];

  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  throw new Error("No usable shell found for terminal startup");
}

// cwd 候选链：指定目录 → HOME → 系统 home → 根目录。
// [失败路径] 前三者都可能因工作区被删而失效，用 "/" 兜底保证终端一定起得来。
export function resolveTerminalCwd(cwd?: string): string {
  // 修复原因：工作区目录可能已经被删除、移动，或者启动时传进来的是一个失效路径。
  // 之前把这个 cwd 原样传给 node-pty，同样会在 spawn 阶段失败。
  // 这里优先使用传入目录，不可用时回退到 HOME / 系统 home / 根目录，保证终端还能拉起。
  const candidates = [cwd, process.env.HOME, homedir(), "/"];

  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }

  throw new Error("No usable working directory found for terminal startup");
}

/** 无监听者期间最多保留的 PTY 输出字符数；超出后丢弃最旧的块，保留屏幕上最可能仍可见的尾部。 */
const TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS = 1_048_576;

/**
 * Bug 原因（R3 远端终端 xterm 恒空，2026-09-14）：PTY 的首批输出（bash 提示符在 spawn 后约 10ms 就到达）
 * 在 renderer 通过 create() 拿到 id 并订阅 onDynamicData 之前就已 fire，而普通 Emitter 在没有监听者时
 * 直接丢弃事件，ProxyChannel 对 onDynamicXxx 也不做缓冲。本地链路往返只有毫秒级，多数时候能抢在提示符
 * 之前订阅；远端目标经 SSH 往返 40~200ms，首个提示符必丢，之后 shell 空闲再无输出，用户看到空白终端。
 * 修法：输出的唯一来源在这里，于是在没有监听者时把输出有界缓存，监听者到来后按序回放再转直通。
 * 订阅断开（例如远端连接换代）期间同样缓存，避免重连后丢失中间输出；不依赖任何超时。
 */
function createBufferedTerminalOutputEmitter(): {
  emitter: Emitter<string>;
  push: (data: string) => void;
} {
  // [并发] pending/pendingChars/hasListener 只在回调与 push 内读写，单线程无需加锁；
  // onWillAddFirstListener 必须先翻 hasListener 再 splice 回放，否则回放期间新数据会重复入队。
  const pending: string[] = [];
  let pendingChars = 0;
  let hasListener = false;

  const emitter: Emitter<string> = new Emitter<string>({
    // Emitter 会先登记监听者再触发该钩子，因此这里 fire 能直接送达刚订阅的监听者。
    onWillAddFirstListener: () => {
      hasListener = true;
      const buffered = pending.splice(0);
      pendingChars = 0;
      for (const chunk of buffered) {
        emitter.fire(chunk);
      }
    },
    onDidRemoveLastListener: () => {
      hasListener = false;
    },
  });

  return {
    emitter,
    push: (data) => {
      if (hasListener) {
        emitter.fire(data);
        return;
      }
      pending.push(data);
      pendingChars += data.length;
      // [资源] 有界丢弃：按块 FIFO 淘汰最旧输出，只保留尾部。
      // [权衡] 按字符数而非块数设限，避免长短行混排时内存估算失真；length > 1 保证至少留一块。
      while (pendingChars > TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS && pending.length > 1) {
        pendingChars -= pending.shift()?.length ?? 0;
      }
    },
  };
}

// 服务工厂：闭包持有 terminals 与 nextId，等价于进程级注册表。
// [权衡] 不另建锁：公开方法都落到同步 Map 操作或 node-pty 调用，并发安全依赖单线程事件循环。
export function createTerminalService(dependencies: {
  settingService: ISettingService;
}): ITerminalService {
  // [并发] id 单调递增且不复用，避免旧订阅在新终端上「复活」；
  // dispose 与 onExit 都会删同一个 key，Map.delete 幂等使两条路径可安全重入。
  const terminals = new Map<string, TerminalInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 pty 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("terminal", () => ({
    open: terminals.size,
  }));

  // [失败路径] 未知 id 直接抛错由 RPC 层转成协议错误：静默忽略会让用户以为写入成功。
  function getTerminal(id: string): TerminalInstance {
    const t = terminals.get(id);
    if (!t) throw new Error(`Terminal not found: ${id}`);
    return t;
  }

  // [资源] 关闭顺序：kill PTY → dispose 两条 emitter → 摘除注册表。
  // 先 kill 后 dispose 是刻意的：kill 触发的 onExit 可能同步 fire 最后一次退出码，此时 emitter 仍需存活。
  function cleanupTerminal(id: string): void {
    const terminal = terminals.get(id);
    if (!terminal) {
      return;
    }

    terminal.pty.kill();
    terminal.dataEmitter.dispose();
    terminal.exitEmitter.dispose();
    terminals.delete(id);
  }

  const service: ITerminalService & { disposeAll(): void } = {
    async create(params: {
      cols: number;
      rows: number;
      cwd?: string;
    }): Promise<{
      id: string;
      shell: string;
      fontFamily: string;
      fontSize?: number;
      theme?: TerminalThemeProfile;
      fontFamilySource: TerminalFontFamilySource;
      windowsPty?: TerminalWindowsPtyInfo;
    }> {
      // [并发] 同步取号：nextId 的读写在 await 之前完成，并发 create 不会拿到同一 id。
      // 之后 await 期间该 id 尚未登记，此窗口内的 write/resize 会走「未找到」分支——半初始化实例不该可见。
      const id = String(nextId++);
      const shell = resolveTerminalShell();
      const cwd = resolveTerminalCwd(params.cwd);
      const env = resolveTerminalEnv();
      const terminalProfileSettings = await dependencies.settingService
        .get()
        .catch(() => ({
          terminalFontFamily: undefined,
          terminalInheritSystemProfile: true,
        }));
      const fontProfile = resolveTerminalFontProfile({
        settings: terminalProfileSettings,
        env: process.env,
      });
      const nodePty = await loadNodePtyModule();
      ensureNodePtySpawnHelperExecutable();
      const terminalOutput = createBufferedTerminalOutputEmitter();
      const dataEmitter = terminalOutput.emitter;
      const exitEmitter = new Emitter<number>();

      // [失败路径] spawn 是唯一可能同步抛错的位置（shell/cwd/原生模块），此处尚无已登记状态需回滚；
      // 但必须把 shell 与 cwd 写进错误文案，否则远端只能看到 posix_spawnp failed，无从判断哪一侧坏了。
      let p: IPty;
      try {
        p = spawnTerminalProcess({
          nodePty,
          shell,
          cols: params.cols,
          rows: params.rows,
          cwd,
          env,
        });
      } catch (error) {
        throw new Error(`Failed to start terminal with shell '${shell}' in '${cwd}': ${getErrorMessage(error)}`);
      }

      // [并发] 数据入口只做 push，不做解析或背压判断，保证 renderer 断开时 PTY 写端也不会被卡死。
      // INV-02：这是输出的唯一来源，任何绕行都会让「回放 + 直通」的切换失效。
      p.onData((data) => terminalOutput.push(data));
      // [资源] 退出后主动释放 emitter 并摘除注册表项，不等待调用方 dispose：用户关掉 shell 时
      // RPC 侧通常不再发 dispose，不在这里清理就会泄漏 map 条目，disposeAll 还会 kill 已死 PID。
      p.onExit(({ exitCode }) => {
        exitEmitter.fire(exitCode);
        dataEmitter.dispose();
        exitEmitter.dispose();
        terminals.delete(id);
      });

      // [并发] 登记放在订阅之后，保证能收到数据的实例都已有出口；代价是极短命的 shell 若在 set 前退出，
      // onExit 的 delete 会先执行、随后的 set 又写回一个已死实例，只能靠 kill 对死 PID 无副作用兜住。
      terminals.set(id, { pty: p, dataEmitter, exitEmitter });
      return {
        id,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
    },

    // [背压] 直接转发 pty.write，不叠队列：node-pty 写端自带缓冲，再加一层会改变「按键 → 回显」的时序。
    // [失败路径] id 不存在时抛错，由 RPC 层转成错误响应，避免用户以为输入已送达。
    async write(params: { id: string; data: string }): Promise<void> {
      getTerminal(params.id).pty.write(params.data);
    },

    // [并发] resize 必须落到真实 PTY：窗口尺寸由内核经 SIGWINCH 通知前台进程组，缓存值无法让 vim/top 重排。
    async resize(params: { id: string; cols: number; rows: number }): Promise<void> {
      getTerminal(params.id).pty.resize(params.cols, params.rows);
    },

    // [资源] 幂等入口：id 已回收时 cleanupTerminal 直接返回，允许关闭面板与 shell 自然退出重复调用。
    async dispose(params: { id: string }): Promise<void> {
      cleanupTerminal(params.id);
    },

    // [失败路径] 未知 id 抛错而不是返回空 Event：空 Event 会让订阅方永远等不到数据，
    // 表现为「终端空白却没有任何错误」，正是 INV-02 要排除的故障形态。
    onDynamicData(id: string): Event<string> {
      return getTerminal(id).dataEmitter.event;
    },

    onDynamicExit(id: string): Event<number> {
      return getTerminal(id).exitEmitter.event;
    },

    // [资源] 先摘诊断 provider 再逐个清理：它的闭包会读 terminals.size，提前释放避免退出期间被再次上报。
    // [并发] 用 keys 快照遍历，cleanupTerminal 内部 delete 当前项不会破坏迭代。
    disposeAll(): void {
      memoryDiagnostics.dispose();
      // app 关闭时 host process 以前只会结束自身，terminal 里的子 shell 没有逐个显式 kill。
      // 这里补一个本地清理入口，让 host 在退出链路里能同步回收所有仍存活的终端进程。
      for (const id of Array.from(terminals.keys())) {
        cleanupTerminal(id);
      }
    },
  };

  return service;
}
