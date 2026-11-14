// INV-01 双来源二选一：必须有合法远端 URL 或 ArrayBuffer 数据；守住位置：registerDesktopSaveFileIpcHandler 中 sourceUrl 为空且 hasData 为假的判定；改错故障：两者都缺仍弹出对话框，用户选完路径后写入空内容或撞上未捕获异常。
// INV-02 业务失败一律用返回值表达，禁止把异常抛给 renderer；守住位置：处理器最外层 try/catch 包裹的两个写入分支与统一 catch；改错故障：异常穿透 ipcMain.handle，renderer 拿到 rejected promise 而非结构化错误码。
// INV-03 取消或无路径必须短路为 canceled，不产生任何写盘副作用；守住位置：showSaveDialog 返回后的 result.canceled 与 result.filePath 空值判断；改错故障：继续用空路径写入，抛 ENOENT 或被当作写入失败提示用户。
// INV-04 建议文件名必须经 basename、trim 与 120 字符截断；守住位置：suggestedName 的赋值表达式；改错故障：带路径分隔符的名字可跳出用户选定目录，形成任意路径写入。
// INV-05 [资源] 大小上限必须在入口与流式累计两处执行；守住位置：MAX_SAVE_FILE_BYTES 在 payload 校验与读取循环中的两次比较；改错故障：只在入口校验，远端无 content-length 时超大文件撑爆磁盘。
// INV-06 content-length 只做快速拒绝，不构成安全边界；守住位置：Number.isFinite 判断之后的提前抛错；改错故障：信任可伪造或缺失的响应头，上限被服务端轻易绕过。
// INV-07 [资源] 下载超时必须由 AbortController 驱动并在 finally 清除定时器；守住位置：setTimeout 与 REMOTE_DOWNLOAD_TIMEOUT_MS 及 clearTimeout；改错故障：定时器泄漏，或超时后请求仍挂起让 IPC 永不返回。
// INV-08 [安全] 校验过的地址必须钉进连接阶段的域名解析；守住位置：pinnedLookup 与 Agent 的 connect 配置；改错故障：预检公网、实际连接重新解析，DNS rebinding 可命中内网。
// INV-09 每一跳重定向都要重新做公网校验；守住位置：重定向循环内每轮调用的 resolvePublicRemoteUrl；改错故障：只校验首跳，302 指向环回地址即可访问本机服务。
// INV-10 [失败路径] 重定向次数上限与缺失 location 同归 download_failed；守住位置：location 为空与 redirectCount 等于 MAX_REMOTE_REDIRECTS 的合并判断；改错故障：重定向环无限循环，IPC 被远端长期占用。
// INV-11 重定向目标同样只允许 http 与 https；守住位置：parseRemoteImageUrl 对 location 的过滤与空值判断；改错故障：放行 file 或 data 协议，本地文件被读取并回传。
// INV-12 私网与保留网段黑名单必须同时覆盖 IPv4 与 IPv6；守住位置：blockedRemoteAddresses 的两轮 addSubnet 循环与 check 的族别映射；改错故障：只封 IPv4，AAAA 记录直连环回或内网。
// INV-13 localhost 与 .localhost 必须在解析之前直接拒绝；守住位置：resolvePublicRemoteUrl 开头的 hostname 比对；改错故障：依赖解析结果，某些环境把 localhost 映射到非环回地址从而绕过。
// INV-14 [资源] 每个 dispatcher 必须在全部出口关闭；守住位置：请求异常 catch、3xx 分支与 downloadRemoteFile 的 finally；改错故障：连接池与 socket 泄漏，长跑后句柄耗尽。
// INV-15 [资源] 3xx 响应体必须先取消再关闭 dispatcher；守住位置：response 的 body 取消语句与紧随其后的关闭顺序；改错故障：响应体未消费，关闭连接时挂起并拖慢重定向链。
// INV-16 [事务] 临时文件必须独占创建，交付前再复制到目标；守住位置：wx 打开方式与随后的 copyFile；改错故障：非独占打开会复用残留内容，直接写目标则失败后留下半截文件。
// INV-17 [资源] 临时目录必须在 finally 递归删除，清理动作全部 best-effort；守住位置：finally 中对 temporaryDirectory 的 rm 与各句柄的 catch 兜底；改错故障：失败路径遗留 zcode-save-file- 前缀目录，磁盘持续增长。
// INV-18 [失败路径] 错误码只从 SaveFileError 透出，其余统一为 write_failed；守住位置：catch 中的 instanceof 判断与 logger.warn 记录；改错故障：把内部异常文本回传 renderer，或把文件过大误报成写入失败导致前端提示错误。
//
// 模块职责：为 renderer 提供保存文件的 IPC 入口，必须弹出系统保存对话框，把内存字节或远端图片落盘，并把失败收敛成结构化结果。
// 状态所有权：没有跨请求状态；每次调用必须独占自己的 AbortController、临时目录与句柄，net 黑名单是模块加载期的只读常量。
// 阅读顺序：先看黑名单与 URL 过滤，再看公网解析与重定向钉住，然后看下载的资源收尾，最后看 IPC 校验、对话框与错误映射。
import { copyFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList } from "node:net";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SaveFileRequest, SaveFileResult } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { Agent, fetch as undiciFetch } from "undici";

export const MAX_SAVE_FILE_BYTES = 50 * 1024 * 1024;
export const REMOTE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REMOTE_REDIRECTS = 5;

// [安全] 黑名单覆盖 RFC1918、CGNAT、环回、链路本地、组播、文档与基准测试网段，任何新增网段都要同时评估 IPv4 与 IPv6。
// [边界] IPv4 用 addSubnet 的位长度表达，IPv6 单独一轮循环，两套前缀长度不能混用。
// [权衡] 采用拒绝列表而非允许列表，新增公网段无需改代码；代价是遗漏的保留段必须显式补入。
// [失败路径] 名单在模块加载期一次性构建，运行期只读；若在此处出错，整个 main 启动即失败。
// [契约] check 的第三参数必须按 family 映射为 ipv4 或 ipv6，传错族别会让地址永远判为未命中。
// [安全] 该名单必须只服务远端图片下载，不承担其他网络请求的出口管控，不要据此假设全局网络已隔离。
const blockedRemoteAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedRemoteAddresses.addSubnet(network, prefix, "ipv6");
}

class SaveFileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// [契约] 入参声明为 unknown：payload 来自 renderer，不能假定已通过类型检查。
// [契约] 只有 http 与 https 两种协议放行，其余一律返回 null，由调用方决定报错还是走本地数据分支。
// [失败路径] 构造 URL 的异常在这里吞掉并返回 null，不向上抛，保证非法字符串与非法协议走同一条归一路径。
// [权衡] 返回 null 而不抛错，让 sourceUrl 为空与格式非法在调用点合并判断，减少分支。
// [边界] 该函数只做 scheme 协议过滤，不做主机公网校验；地址安全检查在解析阶段与连接阶段各有一道。
function parseRemoteImageUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// [安全] hostname 先去掉 IPv6 方括号并转小写，再比对 localhost 与 .localhost 后缀，避免大小写或括号绕过。
// [并发] DNS 查询用 all 加 verbatim，拿到全部地址而不是单条，避免轮询到未校验的备用记录。
// [失败路径] 解析失败统一映射为 download_failed，不把底层 DNS 错误文本透给 renderer。
// [安全] 只要任一地址落在黑名单就整体拒绝，不做挑一个干净地址的降级，防止双栈场景绕过。
// [契约] 空地址列表同样视为非法，返回的数组后续会被钉进连接阶段的 lookup。
async function resolvePublicRemoteUrl(
  url: URL,
): Promise<LookupAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new SaveFileError("remote_address_not_allowed");
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SaveFileError("download_failed");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      blockedRemoteAddresses.check(address, family === 6 ? "ipv6" : "ipv4"),
    )
  ) {
    throw new SaveFileError("remote_address_not_allowed");
  }
  return addresses;
}

// [安全] 循环每轮都重新解析并校验当前地址，初始 URL 与每次重定向地位相同，不能只校验首跳。
// [安全] pinnedLookup 把已校验地址直接交给连接层；不传 all 时取首条，取不到就回错误而不是回环回地址。
// [安全] dispatcher 绑定该 lookup 后，底层不再做第二次域名解析，DNS rebinding 的时间窗被关闭。
// [失败路径] 请求异常时先关闭 dispatcher 再上抛，避免调用方拿不到句柄导致连接池泄漏。
// [事务] redirect 固定为 manual，重定向由本函数逐跳处理；交给底层自动跟随会绕过逐跳校验。
// [资源] 3xx 分支先取消响应体再关闭 dispatcher，最后才读 location，顺序颠倒会让连接无法及时释放。
// [失败路径] 缺 location 或已达重定向上限都抛 download_failed，循环不存在自然结束的成功出口。
// [失败路径] 重定向目标必须重新过协议过滤，非 http 与 https 直接失败，不允许降级到本地协议。
async function fetchPublicRemoteUrl(
  initialUrl: URL,
  signal: AbortSignal,
): Promise<{ dispatcher: Agent; response: Awaited<ReturnType<typeof undiciFetch>> }> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REMOTE_REDIRECTS; redirectCount += 1) {
    const addresses = await resolvePublicRemoteUrl(currentUrl);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const address = addresses[0];
      if (!address) {
        callback(new Error("download_failed"), "");
        return;
      }
      callback(null, address.address, address.family);
    };
    // DNS 校验结果必须绑定到连接阶段；dispatcher 禁止底层再次解析域名，
    // 从而关闭“预检查公网、实际连接私网”的 DNS rebinding 窗口。
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup } });
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(currentUrl, {
        dispatcher,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
    if (response.status < 300 || response.status >= 400) {
      return { dispatcher, response };
    }

    await response.body?.cancel().catch(() => undefined);
    await dispatcher.close();
    const location = response.headers.get("location");
    if (!location || redirectCount === MAX_REMOTE_REDIRECTS) {
      throw new SaveFileError("download_failed");
    }
    const redirectedUrl = parseRemoteImageUrl(new URL(location, currentUrl).toString());
    if (!redirectedUrl) throw new SaveFileError("download_failed");
    currentUrl = redirectedUrl;
  }
  throw new SaveFileError("download_failed");
}

// [资源] 临时目录由 mkdtemp 生成 zcode-save-file- 前缀，下载先落盘再由 copyFile 交付目标路径。
// [资源] reader、file、dispatcher 三个句柄必须在 try 外声明，finally 才能对失败中途的状态统一收尾。
// [失败路径] 超时由 AbortController 统一触发，同一信号同时约束 DNS 后的请求与读取循环。
// [资源] content-length 缺失或非数字时跳过快速拒绝，真正的上限由累计字节数兜底。
// [资源] 累计读取一旦越过上限立即 abort 并抛 file_too_large，避免完整缓冲后再判断。
// [事务] 临时文件必须用 wx 独占创建，写完显式 close 并置空，随后才复制到用户选定路径。
// [失败路径] 读到零字节视为 payload 非法，空文件不会被当作成功结果交付。
// [资源] finally 中必须逐项清理定时器、信号、reader、dispatcher、file、临时目录，每步都吞掉二次异常。
// [权衡] 复制而非直接写目标（copyFile），是为了让目标路径只在完整落地时出现；代价是峰值多占用一份磁盘。
async function downloadRemoteFile(
  sourceUrl: URL,
  destinationPath: string,
): Promise<void> {
  const controller = new AbortController();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-save-file-"));
  const temporaryPath = join(temporaryDirectory, "download");
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let file: Awaited<ReturnType<typeof open>> | null = null;
  let dispatcher: Agent | null = null;
  const timeout = setTimeout(() => controller.abort(), REMOTE_DOWNLOAD_TIMEOUT_MS);
  try {
    // renderer 的 CORS 边界不能放大成 main 可访问内网；初始地址和每次重定向都先解析并拒绝非公网地址。
    const remoteResponse = await fetchPublicRemoteUrl(sourceUrl, controller.signal);
    dispatcher = remoteResponse.dispatcher;
    const { response } = remoteResponse;
    if (!response.ok || !response.body) {
      throw new SaveFileError("download_failed");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_SAVE_FILE_BYTES) {
      throw new SaveFileError("file_too_large");
    }

    reader = response.body.getReader();
    file = await open(temporaryPath, "wx");
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_SAVE_FILE_BYTES) {
        // 容量限制必须在读取过程中执行；完整缓冲后再校验无法保护 renderer/main 内存。
        controller.abort();
        throw new SaveFileError("file_too_large");
      }
      await file.write(value);
    }
    if (receivedBytes === 0) throw new SaveFileError("invalid_file_payload");
    await file.close();
    file = null;
    await copyFile(temporaryPath, destinationPath);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await dispatcher?.close().catch(() => undefined);
    await file?.close().catch(() => undefined);
    await rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

// [契约] 该处理器是 main 对 renderer 的唯一保存入口，返回值必须是 SaveFileResult，不以异常表达业务失败。
// [失败路径] payload 缺失或 suggestedName 非字符串时直接回 invalid_file_payload，不进入对话框。
// [安全] suggestedName 经 basename、trim 与 120 字符截断，防止路径分隔符把写入引到目标目录之外。
// [契约] 来源必须二选一：合法的远端 URL 或 ArrayBuffer 数据，两者皆无才判非法。
// [资源] 入口的字节上限拒绝只覆盖内存数据，远端流仍依赖下载器内的累计校验。
// [失败路径] data 长度为 0 与超过上限分别回 invalid_file_payload 与 file_too_large，错误码不可混用。
// [事务] 对话框在写文件之前弹出，取消或无路径时立即返回 canceled，磁盘不产生任何副作用。
// [并发] 有发送窗口时把对话框挂到该窗口，保证模态归属正确；无窗口时退回无父窗口调用。
// [事务] 写入分支互斥：远端走下载器，内存数据走 writeFile，成功后才回报真实路径。
// [失败路径] 仅 SaveFileError 的错误码可以透出，其余异常必须归为 write_failed，并只把细节写进 warn 日志。
export function registerDesktopSaveFileIpcHandler(logger: { warn: (...args: unknown[]) => void }) {
  ipcMain.handle(
    PlatformChannels.SaveFile,
    async (event, payload: SaveFileRequest): Promise<SaveFileResult> => {
      if (!payload || typeof payload.suggestedName !== "string") {
        return { success: false, error: "invalid_file_payload" };
      }
      const suggestedName = basename(payload.suggestedName.trim()).slice(0, 120);
      const sourceUrl = parseRemoteImageUrl(payload.sourceUrl);
      const hasData = payload.data instanceof ArrayBuffer;
      const data = hasData ? payload.data : undefined;
      if (!suggestedName || (sourceUrl === null && !hasData)) {
        return { success: false, error: "invalid_file_payload" };
      }
      if (data && data.byteLength === 0) {
        return { success: false, error: "invalid_file_payload" };
      }
      if (data && data.byteLength > MAX_SAVE_FILE_BYTES) {
        return { success: false, error: "file_too_large" };
      }

      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = { defaultPath: suggestedName };
      const result = senderWindow
        ? await dialog.showSaveDialog(senderWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      try {
        if (sourceUrl) {
          await downloadRemoteFile(sourceUrl, result.filePath);
        } else if (data) {
          await writeFile(result.filePath, new Uint8Array(data));
        }
        return { success: true, path: result.filePath };
      } catch (error) {
        const errorCode = error instanceof SaveFileError ? error.code : "write_failed";
        logger.warn(
          `[save-file] 写入失败 path=${result.filePath} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return { success: false, error: errorCode };
      }
    },
  );
}
