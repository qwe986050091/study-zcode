/* eslint-disable max-lines -- Chrome helper、CDP 传输和 Electron 目标写入必须共享同一套敏感数据边界。 */
// 做：把 Chrome 用户目录中的 Cookie 与 LocalStorage 通过一次性 Profile + CDP 导入 Electron Session。
// 不做：不解析、不解密、不能记录 Cookie 值与 LocalStorage 值，不修改源 Chrome Profile。
// 依赖：本机 Chrome/Chromium 可执行文件、ws CDP 客户端、Electron Session/WebContents。
// 边界：临时 Profile 必须在 finally 清理；失败只上报稳定错误码，不把站点细节带出本模块。
//
// 不变量（INV）：
// INV-01 断言：Cookie 数据库路径必须相对且解析后仍在 profilePath 内 —— 守住它的位置：readChromeCookiesWithHelper 的 isAbsolute 与 .. 校验 —— 改错故障：任意绝对路径可被复制进临时 Profile 并读出内容。
// INV-02 断言：LocalStorage 的 origin 只从复制后的快照扫描 —— 守住它的位置：importChromeLocalStorage 的 cp 先于 discover —— 改错故障：Chrome 正在写 LevelDB 时扫描撞锁，被误判为没有 LocalStorage。
// INV-03 断言：候选 origin 必须是 URL.origin 与原文完全相等的 http/https —— 守住它的位置：discoverChromeLocalStorageOrigins 的二次校验 —— 改错故障：二进制邻接字节被当成 origin，导航到垃圾 URL 并计入失败。
// INV-04 断言：日志只能出现稳定分类码，不能出现 Cookie 值、URL 或域名 —— 守住它的位置：toLocalStorageFailureReason 与各处 logger —— 改错故障：用户浏览器数据进入日志文件被外泄。
// INV-05 断言：临时目录清理失败不得覆盖已成功的导入结果 —— 守住它的位置：cleanupChromeHelperTempRoot 的 try/catch —— 改错故障：Linux crashpad 的 ENOTEMPTY 让一次成功导入被报成失败。
// INV-06 断言：CDP 建连与每条命令都受 CDP_TIMEOUT_MS 约束 —— 守住它的位置：WebSocketCdpTransport.connect 与 send 的 withTimeout —— 改错故障：Chrome 挂起时 IPC 永久 pending，窗口一直转圈。
// INV-07 断言：socket 关闭必须 reject 全部在途请求 —— 守住它的位置：构造函数里的 close 监听 —— 改错故障：helper 崩溃后调用方永远等不到结果。
// INV-08 断言：request id 单调递增且在结算前从 pending 删除 —— 守住它的位置：send 与 handleMessage —— 改错故障：重复 id 命中旧 promise，结果串包到别的命令。
// INV-09 断言：导航完成后必须校验 location.origin 与目标 origin 相等 —— 守住它的位置：navigateToStorageOrigin 末尾 —— 改错故障：重定向到登录页时把别的站点数据写进目标 Session。
// INV-10 断言：Fetch 拦截必须只放行 Document 请求，其余资源一律 Aborted —— 守住它的位置：initializeLocalStoragePage 的消息处理 —— 改错故障：真实网络请求被发出，导入过程访问用户站点。
// INV-11 断言：Chrome helper 无论成功失败都必须被终止 —— 守住它的位置：runChromeHelper 的 finally —— 改错故障：每次导入泄漏一个 headless Chrome，累积占满内存。
// INV-12 断言：helper 使用一次性 --user-data-dir 与 --remote-debugging-port=0 —— 守住它的位置：runChromeHelper 的参数表 —— 改错故障：打开用户真实 Profile，与运行中的 Chrome 抢锁。
// INV-13 断言：不得把源 Profile 目录直接当 helper 的 user-data-dir —— 守住它的位置：两个导入入口统一先 mkdtemp 再复制 —— 改错故障：helper 退出时写坏用户真实配置。
// INV-14 断言：LocalStorage 总字节与 origin 数超限只能计 skipped —— 守住它的位置：readChromeLocalStorage 的两处上限判断 —— 改错故障：大 Profile 让整次导入失败，用户一个站点也拿不到。
// INV-15 断言：单个 origin 的失败不能中断其余 origin —— 守住它的位置：逐 origin 的 try/catch —— 改错故障：一个坏站点导致后续全部站点被丢弃。
// INV-16 断言：Electron 侧必须先 loadURL(about:blank) 再 attach debugger —— 守住它的位置：writeElectronLocalStorage —— 改错故障：没有 renderer 时 CDP 命令永不返回。
// INV-17 断言：写入条数必须与源 entries 长度一致，否则按 origin 失败 —— 守住它的位置：writeElectronLocalStorage 的写回校验 —— 改错故障：quota 截断被当成成功，用户看到缺数据的登录态。
// INV-18 断言：destroy 窗口之前必须 flushStorageData —— 守住它的位置：writeElectronLocalStorage 的 try/finally —— 改错故障：LevelDB 未落盘窗口即销毁，重启后数据消失。
// INV-19 断言：源目录不存在时直接返回空统计，不启动任何子进程 —— 守住它的位置：importChromeLocalStorage 入口 —— 改错故障：每次没有 Chrome 数据的启动都白拉起一次 headless Chrome。
//
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep as pathSeparator } from "node:path";
import { BrowserWindow } from "electron";
import type { Session, WebContents } from "electron";
import type { ChromeBrowserDataImportError } from "@zcode/shared";
import { WebSocket, type RawData } from "ws";
import { resolveChromeExecutablePath } from "./chromeProfileDiscovery.js";
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";

// [契约] 三个上限必须共同定义一次导入的资源边界：origin 数、总字节、单次 CDP 等待。
// [权衡] 128MB 覆盖常见源 Chrome LocalStorage 量级；超过后按跳过计数，而不是让整次导入失败。
// [失败路径] 超限的 origin 计入 originsSkipped，调用方据此提示部分站点未导入，而不是静默丢数据。
// [资源] 常量只在模块级求值一次，禁止在函数内按需放大，否则同一进程内不同调用会得到不同上限。
const MAX_LOCAL_STORAGE_ORIGINS = 1_000;
const MAX_LOCAL_STORAGE_BYTES = 128 * 1024 * 1024;
const CDP_TIMEOUT_MS = 15_000;
const CHROME_HELPER_TEMP_CLEANUP_MAX_RETRIES = 5;
const CHROME_HELPER_TEMP_CLEANUP_RETRY_DELAY_MS = 100;
const BLANK_DOCUMENT_BODY = Buffer.from("<!doctype html><meta charset=utf-8>").toString("base64");

// [契约] 统计是尽力导入的账本：imported + skipped + failed 才等于发现到的 origin 总数。
// [契约] error 只在整体失败时出现；部分 origin 失败靠 failed 计数表达，不把整次导入标红。
// [权衡] 不提供逐 origin 明细，避免把站点域名带进 renderer 与日志。
// [失败路径] 调用方必须以 originsFailed 非零提示部分失败，不能只看 error 字段。
export interface ChromeLocalStorageImportStats {
  originsImported: number;
  entriesImported: number;
  originsSkipped: number;
  originsFailed: number;
  error?: ChromeBrowserDataImportError;
}

// [契约] 这是 Chrome CDP 返回 Cookie 的最小投影，字段名与 Storage.getCookies 保持一致。
// [契约] sameSite 在部分版本缺失，因此可选；不要补默认值，否则会改写源站点语义。
// [资源] value 只在内存中传递，落库与加密由 Electron Session 负责。
export interface ChromeHelperCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite?: "Strict" | "Lax" | "None";
  secure: boolean;
  session: boolean;
  value: string;
}

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

type RecursiveDirectoryRemover = (
  path: string,
  options: {
    force: true;
    maxRetries: number;
    recursive: true;
    retryDelay: number;
  },
) => Promise<void>;

interface LocalStorageRecord {
  origin: string;
  entries: Array<[string, string]>;
}

interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onMessage(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  close(): void;
}

// [失败路径] 只放行两类稳定原因：origin 不匹配与 *_timeout，其余一律折叠为 cdp_command_failed。
// [契约] 折叠是为了不让 CDP 原始报错里的 URL 与站点细节进入日志和统计。
// [权衡] 丢失细节换来可聚合的 failureReasons，便于判断是超时还是命令失败。
// [契约] 新增错误码必须先在这里登记，否则调用方只能看到 cdp_command_failed。
function toLocalStorageFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message === "local_storage_origin_mismatch" || message.endsWith("_timeout")) {
    return message;
  }
  // CDP 原始错误可能包含 URL 或站点细节，日志中只保留稳定分类。
  return "cdp_command_failed";
}

// [失败路径] 只有文件系统层面的占用与权限错误才映射为 chrome_profile_locked。
// [契约] 其余错误统一 chrome_local_storage_import_failed，避免把未知异常说成 Chrome 被占用。
// [权衡] 错误码是 renderer 文案的输入，新增分类必须同步 UI，不能只在本文件加分支。
function toLocalStorageImportError(error: unknown): ChromeBrowserDataImportError {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "EBUSY" || code === "EACCES" || code === "EPERM") {
    return "chrome_profile_locked";
  }
  return "chrome_local_storage_import_failed";
}

// [失败路径] 日志只保留 name 与 code，丢弃 message 与 path，避免暴露用户目录结构。
// [契约] 非 Error 输入统一归为 UnknownError，保证日志字段形状稳定。
// [权衡] 调试信息变少，但换来临时目录路径不进 debug 日志。
function toSafeFileSystemError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

// [资源] 临时 Profile 是一次性资产，必须在 finally 调用本函数，不能依赖进程退出回收。
// [失败路径] 清理失败只 warn：Linux Chrome 的 crashpad 子进程可能仍在写目录。
// [权衡] 重试 5 次、间隔 100ms 是经验值；调大只会拖慢关闭流程，不能根治 ENOTEMPTY。
// [契约] 该函数永不抛出，调用方无需再包 try/catch。
export async function cleanupChromeHelperTempRoot(options: {
  logger: BrowserDataLogger;
  remover?: RecursiveDirectoryRemover;
  tempRoot: string;
}): Promise<void> {
  try {
    await (options.remover ?? rm)(options.tempRoot, {
      recursive: true,
      force: true,
      maxRetries: CHROME_HELPER_TEMP_CLEANUP_MAX_RETRIES,
      retryDelay: CHROME_HELPER_TEMP_CLEANUP_RETRY_DELAY_MS,
    });
  } catch (error) {
    // Linux Chrome 的 crashpad/子进程可能在主 helper 退出后短暂继续写临时 Profile，
    // 使 rm 返回 ENOTEMPTY。清理失败不能覆盖已经通过 CDP 读取成功的 Cookie/LocalStorage 结果。
    options.logger.warn(
      "[browser-data] Chrome helper 临时目录清理失败",
      toSafeFileSystemError(error),
    );
  }
}

// [契约] 所有没有可导入数据的路径都必须返回同一形状的空账本，不能返回 undefined。
// [权衡] 每次必须新建对象而非共享常量，防止调用方意外改写后污染后续结果。
// [失败路径] 这里刻意不带 error：目录不存在属于正常情况，不是失败。
export function emptyChromeLocalStorageImportStats(): ChromeLocalStorageImportStats {
  return {
    originsImported: 0,
    entriesImported: 0,
    originsSkipped: 0,
    originsFailed: 0,
  };
}

// [契约] 只回答能不能 stat 到，不区分不存在与权限拒绝。
// [失败路径] 用 then 的第二个回调吞掉原始错误，避免 ENOENT 被当成异常冒泡。
// [资源] 调用点都在 IO 之前做快速判断，不能把它当互斥锁使用。
function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// [并发] 超时只 reject 自己这层包装，被包裹的 promise 仍在跑；需要真正取消必须另传 signal。
// [资源] 两条路径都必须 clearTimeout，否则未清理的定时器会拖住 Node 事件循环。
// [失败路径] 超时错误码采用 label 加 _timeout，上层据此折叠为可上报分类。
// [契约] label 由调用方给定并参与错误码，改名会影响 failureReasons 的聚合口径。
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

// [契约] 只返回 origin 字符串并排序，不读取、不返回任何 entry value。
// [权衡] 解析 LevelDB 文件用 latin1 全量读取，靠总字节与 origin 数上限兜底。
// [失败路径] 单个文件 readFile 失败会让整次发现抛错，上层按导入失败处理。
// [并发] 纯内存解析、无写入，可与其它 source 的读取并行。
export async function discoverChromeLocalStorageOrigins(
  localStoragePath: string,
): Promise<string[]> {
  // [契约] 路径固定为 Local Storage/leveldb；拼接交给 path.join，避免跨平台分隔符错误。
  // [失败路径] 目录不存在返回空数组而不是抛错：有些 Profile 只有 IndexedDB 没有 LocalStorage。
  // [依赖] 假定调用方传入的已经是快照副本，本函数不再做二次复制。
  const levelDbPath = join(localStoragePath, "leveldb");
  if (!(await pathExists(levelDbPath))) return [];

  const origins = new Set<string>();
  const files = await readdir(levelDbPath, { withFileTypes: true });
  // Chrome LocalStorage LevelDB 的 metadata key 使用 `META:<origin>`。这里只提取 origin，
  // 不解析或输出任何 entry value；真实值由隔离 Chrome helper 通过同源 API 读取。
  const originPattern = /META:(https?:\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?)/g;
  for (const file of files) {
    // [契约] 只扫普通文件，跳过子目录与符号链接，避免读到 profile 之外的内容。
    // [权衡] LevelDB 的 .log、.ldb、MANIFEST 都要扫，不能只认 .ldb 后缀。
    // [失败路径] 跳过是静默的；统计上不区分目录项与读取失败。
    if (!file.isFile()) continue;
    const content = (await readFile(join(levelDbPath, file.name))).toString("latin1");
    for (const match of content.matchAll(originPattern)) {
      const candidate = match[1];
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        if (url.origin === candidate && (url.protocol === "https:" || url.protocol === "http:")) {
          origins.add(candidate);
        }
      } catch {
        // LevelDB 历史记录或二进制邻接字节可能形成无效候选，直接忽略。
      }
    }
  }
  return [...origins].sort();
}

// [并发] 自增 id 加 pending Map 让同一 socket 上的多条命令复用一条连接，调用方无需派发序号。
// [契约] 实现 CdpTransport 的三个方法，调用方不感知底层是 ws 还是 Electron debugger。
// [失败路径] socket 关闭时所有 pending 一起 reject，避免半开连接无限悬挂。
// [资源] close 只关闭 socket，pending 的清理交给 close 事件统一处理。
class WebSocketCdpTransport implements CdpTransport {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  // [资源] 构造函数只挂监听、不做 IO；建连由静态 connect 负责，便于统一超时。
  // [失败路径] 先 reject 再 clear，防止 reject 回调里再查表时读到脏数据。
  // [契约] 构造函数私有，外部必须走 connect，避免拿到未连上的实例。
  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: RawData) => this.handleMessage(data));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("cdp_socket_closed"));
      }
      this.pending.clear();
    });
  }

  // [并发] open 与 error 谁先到谁结算，另一路在超时包装里不会重复触发。
  // [失败路径] 连接失败抛原始错误，由 withTimeout 统一改写成 cdp_connect_timeout。
  // [资源] 建连成功后 socket 所有权移交给新实例，失败路径不留下未关闭的连接。
  // [契约] url 必须是 ws 协议形式，http 的 /json/list 结果由调用方先解析。
  static async connect(url: string): Promise<WebSocketCdpTransport> {
    const socket = new WebSocket(url);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      }),
      CDP_TIMEOUT_MS,
      "cdp_connect",
    );
    return new WebSocketCdpTransport(socket);
  }

  // [并发] 先登记 pending 再 send，防止 Chrome 在同一次事件循环内回包时丢结果。
  // [失败路径] send 同步抛错不会自动清理 pending，调用方必须保证 socket 状态可控。
  // [契约] 返回类型由调用方断言；本层不做结果 schema 校验，校验在具体命令处做。
  // [资源] 每条命令各自计时，长命令不会被上一条的剩余时间挤占。
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return withTimeout(
      new Promise<T>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        this.socket.send(JSON.stringify({ id, method, params }));
      }),
      CDP_TIMEOUT_MS,
      `cdp_${method}`,
    );
  }

  onMessage(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }

  // [并发] 有 id 的是命令回包，无 id 的是事件；两条路径互斥，不能把事件当回包 resolve。
  // [失败路径] 收到未知 id 直接丢弃：可能是超时后被晚到的回包，不能复活已 reject 的 promise。
  // [契约] 先删除 pending 再结算，保证同一 id 永远不会被结算两次。
  // [失败路径] JSON.parse 失败会抛到 socket 的 message 监听，属于连接级故障。
  private handleMessage(data: RawData): void {
    const message = JSON.parse(data.toString()) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "cdp_command_failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners) {
      listener(message.method, message.params ?? {});
    }
  }
}

// [契约] 与 WebSocket 版共用 CdpTransport 接口，让上层导航与存储逻辑不区分宿主。
// [资源] attach 之后必须保证 close 时 detach，否则 webContents 销毁时 debugger 仍持有目标。
// [并发] 事件监听用 Set 转发，允许同时存在多个订阅者：页面初始化与逐 origin 导航各一个。
// [失败路径] sendCommand 的错误原样抛出，由具体命令的调用方决定是否可恢复。
function createElectronCdpTransport(webContents: WebContents): CdpTransport {
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  // [资源] 必须在 loadURL(about:blank) 之后调用：没有 renderer 时 attach 得到的 target 无法执行命令。
  // [失败路径] 已 attach 时再次 attach 会抛错，调用方需保证一个 WebContents 只建一次传输。
  // [契约] 协议 1.3 与 Page、Runtime、Fetch 三个域的用法一致，改动前先确认 Chrome 版本支持。
  webContents.debugger.attach("1.3");
  const handleMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => {
    for (const listener of listeners) listener(method, params);
  };
  webContents.debugger.on("message", handleMessage);
  return {
    send: (method, params = {}) => webContents.debugger.sendCommand(method, params),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      webContents.debugger.off("message", handleMessage);
      if (webContents.debugger.isAttached()) webContents.debugger.detach();
    },
  };
}

// [契约] 返回 unsubscribe，调用方必须在 finally 调用，避免监听泄漏到下一次导航。
// [失败路径] Fetch 接管后若不同时放行 Document，导航会一直挂起直到超时。
// [权衡] 用空 HTML 响应替代真实站点，既建立 origin 又不发起用户站点的网络请求。
// [并发] 拦截到的命令立即 catch，因为导航失败会由 load 超时统一上报，不在这里重复抛错。
// [契约] 先 enable Page 与 Runtime 再 enable Fetch，避免在监听就绪前出现未处理请求。
async function initializeLocalStoragePage(transport: CdpTransport): Promise<() => void> {
  const unsubscribe = transport.onMessage((method, params) => {
    if (method !== "Fetch.requestPaused") return;
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const command =
      params.resourceType === "Document"
        ? transport.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "text/html; charset=utf-8" },
              { name: "Cache-Control", value: "no-store" },
            ],
            body: BLANK_DOCUMENT_BODY,
          })
        : transport.send("Fetch.failRequest", { requestId, errorReason: "Aborted" });
    void command.catch(() => undefined);
  });
  await transport.send("Page.enable");
  await transport.send("Runtime.enable");
  // [契约] urlPattern 必须固定 http*，不含自定义 scheme，避免拦截 devtools 自身的请求。
  // [权衡] requestStage 必须用 Request：只挡请求头阶段、不下载 body，节省流量。
  // [失败路径] 若 Chrome 版本不支持该 pattern，命令会 reject，整次导入按失败处理。
  await transport.send("Fetch.enable", {
    patterns: [{ urlPattern: "http*", requestStage: "Request" }],
  });
  return unsubscribe;
}

// [契约] 必须等到 Page.loadEventFired 才算导航完成，否则 localStorage 可能还是上一个 origin 的。
// [失败路径] 5 秒导航超时后仍走 finally 退订，随后由调用方的 try/catch 记为单 origin 失败。
// [契约] 导航结束后再读一次 location.origin，防止重定向把数据写到别的站点。
// [权衡] 用 load 事件而非 networkIdle：空 HTML 没有子资源，networkIdle 只会额外增加等待。
// [并发] 同一 transport 上不允许并发导航，调用方按 origin 串行循环。
async function navigateToStorageOrigin(transport: CdpTransport, origin: string): Promise<void> {
  let unsubscribe = () => {};
  const loaded = new Promise<void>((resolve) => {
    unsubscribe = transport.onMessage((method) => {
      if (method !== "Page.loadEventFired") return;
      resolve();
    });
  });
  try {
    await transport.send("Page.navigate", { url: `${origin}/` });
    await withTimeout(loaded, 5_000, "local_storage_navigation");
  } finally {
    unsubscribe();
  }
  const evaluated = await transport.send<{
    result?: { value?: string };
  }>("Runtime.evaluate", {
    expression: "location.origin",
    returnByValue: true,
  });
  // [失败路径] 抛稳定错误码 local_storage_origin_mismatch，由上层原样保留，便于区分站点拒绝与超时。
  // [契约] 只有完全相等才放行，禁止用 startsWith 比较，否则 evil.example 会匹配 example。
  // [权衡] 这条校验让需要登录跳转的站点无法导入，但这比写错 origin 安全。
  if (evaluated.result?.value !== origin) {
    throw new Error("local_storage_origin_mismatch");
  }
}

type ChromeHelperProcess = ChildProcessByStdio<null, Readable, Readable>;

// [契约] DevTools 地址只从 stderr 的固定前缀提取，stdout 可能被页面输出污染。
// [资源] stderr 只保留末尾 16KB：Chrome 启动日志可能很长，但不能无限增长。
// [失败路径] error、exit 与超时三路都会 cleanup，确保监听不会悬挂在已死的子进程上。
// [并发] 谁先结算谁负责摘监听；其余回调在 cleanup 之后不会再触发 resolve。
async function waitForChromeDebuggerUrl(child: ChromeHelperProcess): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      let stderr = "";
      const handleData = (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match?.[1]) {
          cleanup();
          resolve(match[1]);
        }
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const handleExit = () => {
        cleanup();
        reject(new Error("chrome_helper_exited"));
      };
      const cleanup = () => {
        child.stderr.off("data", handleData);
        child.off("error", handleError);
        child.off("exit", handleExit);
      };
      child.stderr.on("data", handleData);
      child.once("error", handleError);
      child.once("exit", handleExit);
    }),
    CDP_TIMEOUT_MS,
    "chrome_helper_start",
  );
}

// [契约] 只有 type 为 page 且有 webSocketDebuggerUrl 的 target 可用，browser target 不能执行 Runtime。
// [并发] 最多轮询 30 次、间隔 100ms：Chrome 刚起时 /json/list 可能短暂为空。
// [失败路径] 轮询耗尽抛 chrome_helper_page_missing，不能退化成 browser target 继续执行。
// [资源] fetch 无显式超时，依赖 runChromeHelper 的整体超时兜底。
async function findChromePageTarget(browserDebuggerUrl: string): Promise<string> {
  const browserUrl = new URL(browserDebuggerUrl);
  const listUrl = `http://${browserUrl.host}/json/list`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = (await fetch(listUrl).then((response) => response.json())) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find(
      (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
    );
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("chrome_helper_page_missing");
}

// [资源] 已经退出（exitCode 非 null）时直接返回，避免向死进程发信号并误判。
// [失败路径] 3 秒内不退出就 SIGKILL：headless Chrome 可能因 LevelDB 锁无法优雅退出。
// [契约] 本函数不抛出，runChromeHelper 的 finally 依赖它保证进程一定结束。
// [并发] 先挂 exit 监听再 kill，避免进程在监听挂上之前退出导致永久等待。
async function stopChromeHelper(child: ChromeHelperProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  try {
    await withTimeout(exited, 3_000, "chrome_helper_exit");
  } catch {
    child.kill("SIGKILL");
  }
}

// [契约] headless 参数是隔离的一部分：必须禁扩展、禁同步、禁后台网络，避免污染用户账号状态。
// [契约] --remote-debugging-port=0 让系统分配端口，不能用固定端口与用户已开的 Chrome 冲突。
// [资源] finally 顺序固定为先关传输再停进程，顺序反了会向已死 socket 发命令。
// [失败路径] 启动、连接、run 任一阶段失败都向上抛，由调用方归类为导入失败。
// [权衡] 每次导入新起一个 Chrome，成本高但换来确定性；不要为复用引入进程池。
async function runChromeHelper<T>(options: {
  executablePath: string;
  passwordStore?: LinuxChromePasswordStore;
  userDataPath: string;
  run: (transport: CdpTransport) => Promise<T>;
}): Promise<T> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${options.userDataPath}`,
    "--profile-directory=Default",
    "--remote-debugging-port=0",
    ...(options.passwordStore ? [`--password-store=${options.passwordStore}`] : []),
    "about:blank",
  ];
  // [资源] windowsHide 避免 Windows 闪现控制台窗口；stderr 必须 pipe，否则拿不到 DevTools 地址。
  // [失败路径] stdin 用 ignore，helper 不读输入，留 pipe 会占住句柄。
  // [契约] 启动失败通过 error 事件而非同步抛错到达，waitForChromeDebuggerUrl 已监听。
  const child = spawn(options.executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let transport: WebSocketCdpTransport | null = null;
  try {
    const debuggerUrl = await waitForChromeDebuggerUrl(child);
    transport = await WebSocketCdpTransport.connect(await findChromePageTarget(debuggerUrl));
    return await options.run(transport);
  } finally {
    transport?.close();
    await stopChromeHelper(child);
  }
}

// [契约] 输入是已复制到临时 Profile 的 origins，读取过程不再触碰源目录。
// [失败路径] 逐 origin 的失败只累加 failed 与 failureReasons，不中断后续 origin。
// [契约] 空 entries 计 skipped 而非 imported：空 origin 没有可写内容，不应计入导入数。
// [资源] unsubscribe 在 finally 释放，保证 helper 退出前不残留 Fetch 拦截。
// [权衡] 返回 failureReasons 聚合而不是明细，避免把站点信息带出本模块。
async function readChromeLocalStorage(options: {
  userDataPath: string;
  origins: string[];
  executablePath: string;
}): Promise<{
  records: LocalStorageRecord[];
  skipped: number;
  failed: number;
  failureReasons: Record<string, number>;
}> {
  return runChromeHelper({
    executablePath: options.executablePath,
    userDataPath: options.userDataPath,
    run: async (transport) => {
      const unsubscribe = await initializeLocalStoragePage(transport);
      const records: LocalStorageRecord[] = [];
      let skipped = 0;
      let failed = 0;
      const failureReasons: Record<string, number> = {};
      let totalBytes = 0;
      try {
        // [契约] 截断发生在这里而不是发现阶段，保证统计能区分超上限与读取失败。
        // [失败路径] 被截断的 origin 在循环后统一计入 skipped，不能悄悄消失。
        // [权衡] 1000 是 maxOrigins 的防御性上限，正常用户远低于此；调大需要同时评估单次耗时。
        // [并发] 串行导航是刻意的：同一 target 并发 Page.navigate 会让 location 互相覆盖。
        for (const origin of options.origins.slice(0, MAX_LOCAL_STORAGE_ORIGINS)) {
          try {
            await navigateToStorageOrigin(transport, origin);
            const evaluated = await transport.send<{
              result?: { value?: unknown };
            }>("Runtime.evaluate", {
              expression: "Object.entries(localStorage)",
              returnByValue: true,
            });
            const rawEntries = evaluated.result?.value;
            const entries = Array.isArray(rawEntries)
              ? rawEntries.filter(
                  (entry): entry is [string, string] =>
                    Array.isArray(entry) &&
                    entry.length === 2 &&
                    typeof entry[0] === "string" &&
                    typeof entry[1] === "string",
                )
              : [];
            if (entries.length === 0) {
              skipped += 1;
              continue;
            }
            const bytes = entries.reduce(
              (sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value),
              0,
            );
            // [资源] 字节数按 key 与 value 的 UTF-8 长度累计，与 Electron 侧 quota 量级一致。
            // [失败路径] 超限只跳过当前 origin，不影响已经累计的 records。
            // [权衡] 不做逐条截断：部分写入会让站点处于半登录状态，比整体跳过更糟。
            if (totalBytes + bytes > MAX_LOCAL_STORAGE_BYTES) {
              skipped += 1;
              continue;
            }
            totalBytes += bytes;
            records.push({ origin, entries });
          } catch (error) {
            failed += 1;
            const reason = toLocalStorageFailureReason(error);
            failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
          }
        }
        skipped += Math.max(0, options.origins.length - MAX_LOCAL_STORAGE_ORIGINS);
        return { records, skipped, failed, failureReasons };
      } finally {
        unsubscribe();
      }
    },
  });
}

// [契约] 源文件不存在是正常情况（如没有 -wal），必须静默跳过。
// [资源] 目标父目录由本函数创建，调用方无需预先 mkdir。
// [失败路径] copyFile 的权限与占用错误向上抛，由导入入口统一映射成错误码。
// [权衡] 不在本层做重试：重试会掩盖 Chrome 正在写库的事实，冲突应显式暴露给入口。
async function copyFileIfPresent(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

// [契约] 只复制 Preferences 与 Local State，它们是 Chrome 解密 Cookie 所需的元数据。
// [失败路径] 缺这两个文件时 Chrome 仍能启动，但可能无法解密 App-Bound Cookie；不在此处报错。
// [资源] Local State 必须落在 userDataPath 根，不是 Default 目录下，否则密钥查找失败。
// [权衡] 不复制整个 Profile，避免把浏览历史等无关数据带进临时目录。
async function copyChromeProfileMetadata(
  profilePath: string,
  targetProfilePath: string,
  userDataPath: string,
): Promise<void> {
  await copyFileIfPresent(join(profilePath, "Preferences"), join(targetProfilePath, "Preferences"));
  await copyFileIfPresent(
    join(dirname(profilePath), "Local State"),
    join(userDataPath, "Local State"),
  );
}

/**
 * Windows App-Bound Cookie 与 Linux 系统密钥环 Cookie 只能由匹配的 Chrome/Chromium
 * 安全解密。这里把数据库复制到一次性 Profile，再由已安装浏览器通过 CDP 读取；
 * Cookie 值和密钥环材料不会进入 renderer 或日志。
 */
// [契约] Cookie 值必须只在 helper 与调用方之间传递，不进入 renderer、不写日志。
// [契约] 临时 Profile 的目录结构必须复刻源路径，Chrome 靠相对路径定位数据库。
// [失败路径] 相对路径校验先于一切 IO，非法输入不创建临时目录。
// [资源] finally 清理与 importChromeLocalStorage 共用同一函数，重试语义一致。
// [权衡] Network.enable 之后才 getCookies，否则部分版本返回空集合。
export async function readChromeCookiesWithHelper(options: {
  cookieDatabasePath: string;
  cookieDatabaseRelativePath?: string;
  executablePath: string;
  logger: BrowserDataLogger;
  passwordStore?: LinuxChromePasswordStore;
  profilePath: string;
}): Promise<ChromeHelperCookie[]> {
  const relativeDatabasePath =
    options.cookieDatabaseRelativePath ?? relative(options.profilePath, options.cookieDatabasePath);
  if (
    !relativeDatabasePath ||
    isAbsolute(relativeDatabasePath) ||
    relativeDatabasePath === ".." ||
    relativeDatabasePath.startsWith(`..${pathSeparator}`)
  ) {
    throw new Error("chrome_cookie_database_outside_profile");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-chrome-cookie-helper-"));
  const userDataPath = join(tempRoot, "User Data");
  const targetProfilePath = join(userDataPath, "Default");
  const targetDatabasePath = join(targetProfilePath, relativeDatabasePath);
  try {
    await mkdir(dirname(targetDatabasePath), { recursive: true });
    // [资源] 必须先建父目录再复制，Network 子目录在目标端尚不存在。
    // [失败路径] EBUSY 说明源 Chrome 正在写库，最终映射为 chrome_profile_locked。
    // [契约] 复制的是快照，后续 helper 的写入只影响临时目录。
    await copyFile(options.cookieDatabasePath, targetDatabasePath);
    // [契约] -wal 与 -shm 必须与主库一起复制，否则 SQLite 会丢掉最近未 checkpoint 的 Cookie。
    // [失败路径] 缺失是常态（Chrome 已正常关闭），copyFileIfPresent 静默跳过。
    // [权衡] 不复制 -journal：Chrome 不用回滚日志模式，复制反而可能让 SQLite 回滚。
    // [契约] 后缀顺序无关，但必须与主库同目录同名，否则 SQLite 找不到配套文件。
    for (const suffix of ["-wal", "-shm"]) {
      await copyFileIfPresent(
        `${options.cookieDatabasePath}${suffix}`,
        `${targetDatabasePath}${suffix}`,
      );
    }
    await copyChromeProfileMetadata(options.profilePath, targetProfilePath, userDataPath);
    return await runChromeHelper({
      executablePath: options.executablePath,
      passwordStore: options.passwordStore,
      userDataPath,
      run: async (transport) => {
        await transport.send("Network.enable");
        const response = await transport.send<{ cookies?: ChromeHelperCookie[] }>(
          "Storage.getCookies",
        );
        return (response.cookies ?? []).filter(
          (cookie) =>
            typeof cookie.name === "string" &&
            typeof cookie.value === "string" &&
            typeof cookie.domain === "string" &&
            typeof cookie.path === "string",
        );
      },
    });
  } finally {
    await cleanupChromeHelperTempRoot({ tempRoot, logger: options.logger });
  }
}

// [契约] 目标 Session 由调用方指定，本函数不创建、不销毁 Session，只写数据。
// [失败路径] 单 origin 写入失败只增加 failedOrigins，其余 origin 继续写。
// [契约] 返回的 importedEntries 是实际写入条数，不是源条数，调用方据此判断是否完整。
// [资源] 窗口必须在 finally 销毁，否则隐藏窗口会一直占用 renderer 进程。
// [并发] 同一 Session 不应并发调用本函数，写入顺序会影响 localStorage 的最终值。
async function writeElectronLocalStorage(
  targetSession: Session,
  records: LocalStorageRecord[],
): Promise<{ importedOrigins: number; importedEntries: number; failedOrigins: number }> {
  if (records.length === 0) {
    return { importedOrigins: 0, importedEntries: 0, failedOrigins: 0 };
  }
  // [资源] 1×1 且 show 为 false：窗口只为获得一个可附加 debugger 的 WebContents。
  // [契约] sandbox、contextIsolation、nodeIntegration 保持与生产 renderer 一致，避免执行环境差异。
  // [权衡] backgroundThrottling 为 false 让隐藏窗口不被降频，否则 CDP 命令可能被延迟。
  // [契约] 必须注入目标 Session，否则写进默认 Session，用户重启后看不到登录态。
  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      session: targetSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // 未加载任何文档的 WebContents 尚未创建可用 renderer，直接发送 CDP
  // 导航/存储命令会一直不返回。先初始化 about:blank，再附加 debugger。
  await window.loadURL("about:blank");
  const transport = createElectronCdpTransport(window.webContents);
  const unsubscribe = await initializeLocalStoragePage(transport);
  let importedOrigins = 0;
  let importedEntries = 0;
  let failedOrigins = 0;
  try {
    for (const record of records) {
      try {
        await navigateToStorageOrigin(transport, record.origin);
        const serializedEntries = JSON.stringify(JSON.stringify(record.entries));
        const evaluated = await transport.send<{
          result?: { value?: number };
        }>("Runtime.evaluate", {
          expression: `(() => { const entries = JSON.parse(${serializedEntries}); for (const [key, value] of entries) localStorage.setItem(key, value); return entries.length; })()`,
          returnByValue: true,
        });
        const written = evaluated.result?.value;
        if (typeof written !== "number" || written !== record.entries.length) {
          throw new Error("local_storage_write_incomplete");
        }
        importedOrigins += 1;
        importedEntries += written;
      } catch {
        failedOrigins += 1;
      }
    }
    // [资源] 在销毁窗口前 flush，确保 LevelDB 落盘；这是导入结果能被下次启动读到的前提。
    // [失败路径] flush 是同步调用，失败不会抛出，但数据可能丢失，因此不能省略。
    // [权衡] 不等待 flush 完成事件：Electron 未暴露该信号，只能以 destroy 作为边界。
    targetSession.flushStorageData();
    return { importedOrigins, importedEntries, failedOrigins };
  } finally {
    unsubscribe();
    transport.close();
    if (!window.isDestroyed()) window.destroy();
  }
}

// [契约] 入口只做编排：定位源目录、快照、发现 origin、helper 读取、Electron 写入。
// [失败路径] 任何阶段异常都折叠成 stats.error，不向 IPC 抛原始错误对象。
// [资源] finally 清理临时根目录，与 Cookie 导入共用同一实现。
// [契约] 源目录不存在直接返回空账本，属于没有可导入数据而非失败。
// [权衡] 先复制再扫描是 Windows 上的必需步骤，不能为省一次 IO 直接读源目录。
export async function importChromeLocalStorage(options: {
  profilePath: string;
  targetSession: Session;
  logger: BrowserDataLogger;
  platform?: NodeJS.Platform;
  chromeExecutablePath?: string;
}): Promise<ChromeLocalStorageImportStats> {
  const sourceLocalStoragePath = join(options.profilePath, "Local Storage");
  if (!(await pathExists(sourceLocalStoragePath))) {
    return emptyChromeLocalStorageImportStats();
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-chrome-local-storage-"));
  const userDataPath = join(tempRoot, "User Data");
  const targetProfilePath = join(userDataPath, "Default");
  let originCount = 0;
  try {
    await mkdir(targetProfilePath, { recursive: true });
    // Windows 上 Chrome 可能持续写入 LevelDB。必须先复制快照，再扫描 metadata；
    // 直接扫描源目录会把锁冲突和写入竞态误报为“没有 LocalStorage”。
    // [资源] recursive 与 force 覆盖目标；目标在刚 mkdtemp 的空目录下，不会误删用户文件。
    // [失败路径] 复制期间源 Chrome 仍在写，可能拿到不一致快照，但不会阻塞或损坏源库。
    // [契约] 快照路径固定在 Default/Local Storage，与后续 Chrome 的 profile-directory 对应。
    await cp(sourceLocalStoragePath, join(targetProfilePath, "Local Storage"), {
      recursive: true,
      force: true,
    });
    const origins = await discoverChromeLocalStorageOrigins(
      join(targetProfilePath, "Local Storage"),
    );
    originCount = origins.length;
    if (origins.length === 0) return emptyChromeLocalStorageImportStats();

    const executablePath =
      options.chromeExecutablePath ??
      (await resolveChromeExecutablePath({ platform: options.platform ?? process.platform }));
    if (!executablePath) {
      options.logger.warn("[browser-data] Chrome LocalStorage helper 不可用");
      return {
        ...emptyChromeLocalStorageImportStats(),
        originsFailed: origins.length,
        error: "chrome_executable_not_found",
      };
    }
    await copyChromeProfileMetadata(options.profilePath, targetProfilePath, userDataPath);

    // [失败路径] 读取失败只 warn，继续用已成功的 records 写目标，避免整体归零。
    // [契约] failureReasons 只用于日志聚合，不进入 renderer。
    // [并发] 读取在 helper 内串行完成，返回时进程已终止，后续写入不与其争抢文件。
    const source = await readChromeLocalStorage({ userDataPath, origins, executablePath });
    if (source.failed > 0) {
      options.logger.warn("[browser-data] Chrome LocalStorage 源读取存在失败", {
        failureReasons: source.failureReasons,
      });
    }
    // [契约] 失败数要合并源读取失败与目标写入失败，用户看到的是一个总数。
    // [失败路径] 写入抛错会落到外层 catch，整次导入标记失败；目标 Session 可能已有部分数据。
    // [权衡] 不做回滚：LocalStorage 无事务，回滚成本高于让用户重试一次导入。
    // [契约] 只有导入成功的条数才计入 entriesImported，不能用源条数代替。
    const target = await writeElectronLocalStorage(options.targetSession, source.records);
    const result: ChromeLocalStorageImportStats = {
      originsImported: target.importedOrigins,
      entriesImported: target.importedEntries,
      originsSkipped: source.skipped,
      originsFailed: source.failed + target.failedOrigins,
    };
    options.logger.info("[browser-data] Chrome LocalStorage 导入完成", result);
    return result;
  } catch (error) {
    const importError = toLocalStorageImportError(error);
    options.logger.warn("[browser-data] Chrome LocalStorage 导入失败", {
      originCount,
      reason: importError,
    });
    return {
      ...emptyChromeLocalStorageImportStats(),
      originsFailed: originCount,
      error: importError,
    };
  } finally {
    await cleanupChromeHelperTempRoot({ tempRoot, logger: options.logger });
  }
}
