/* oxlint-disable eslint(max-lines) -- WSL backend 同时承载探测、路径解析、兼容 UNC 与可取消流式上传。 */
// ============ 职责边界 ============
// 做：WSL 作为 IRemoteBackend 的一种实现，承担可用性探测、distro/user/HOME 身份解析、
// 　　远端路径展开、命令执行（流式与缓冲两种）、文件存在性判断/读取/上传、代理网关探测。
// 不做：不管理 distro 生命周期，不 terminate 任何 distro，不持有远端会话或任务状态，
// 　　　不解释退出码的业务含义，也不实现重连与重试策略。
// 依赖：wsl.exe 加 bash -lc 登录环境；WSLConnectOptions；wslProxy 与 wsl-detect 的纯函数；
// 　　　closeEvent 控制器；Windows 上 wsl.localhost 或 wsl$ 的 UNC 映射。
// 边界：只在 win32 上有意义，非 Windows 必须显式失败；所有子进程必须登记，dispose 只收口自己的 child。
//
// ============ INV 不变量表 ============
// INV-01 断言：所有 wsl.exe 子进程都必须经 trackOwnedChild 登记 —— 守住它的位置：spawn 与 execFile 之后立刻调用 —— 改错故障：dispose 无法收口，遗留孤儿进程与锁。
// INV-02 断言：buildWslArgs 的参数顺序恒为 -d、-u、--exec、argv —— 守住它的位置：args.push 的先后 —— 改错故障：distro 名被当成待执行命令，身份解析全错。
// INV-03 断言：--exec 不得删除 —— 守住它的位置：args.push 的第二个参数 —— 改错故障：局部变量被外层 shell 提前展开成空串，退出码仍为 0，误判远端能力。
// INV-04 断言：identity 探测只跑一次 bash -lc —— 守住它的位置：resolvedInfoPromise 的 IIFE 赋值 —— 改错故障：distro/user/HOME 来自不同进程，出现跨进程不一致。
// INV-05 断言：resolvedInfoPromise 必须在任何 await 之前赋值 —— 守住它的位置：resolveInfo 的缓存写入 —— 改错故障：并发调用各自探测，重复起进程且结果可能不同。
// INV-06 断言：HOME 解析为空必须抛错 —— 守住它的位置：resolveInfo 的 homeDir 校验 —— 改错故障：远端路径展开成相对路径，文件写到不可预期的位置。
// INV-07 断言：distro 显式指定且匹配失败时必须抛错 —— 守住它的位置：pickDistro 的 matched 分支 —— 改错故障：静默回退默认 distro，部署落到错误发行版。
// INV-08 断言：UTF-16 判定必须先于 UTF-8 解码 —— 守住它的位置：decodeWslOutput 的分支顺序 —— 改错故障：中文输出变乱码且不抛错，后续比较全部失败。
// INV-09 断言：规范化必须去掉所有 CR —— 守住它的位置：normalizeWslOutput 的 replace 链 —— 改错故障：按行拆分后残留 CR，路径与 distro 名永不相等。
// INV-10 断言：远端 argv 一律经 quotePosixShellArg 单引号包裹 —— 守住它的位置：所有拼接 shell 文本的调用点 —— 改错故障：含空格路径被拆参数，含引号路径产生注入面。
// INV-11 断言：UNC 候选顺序恒为 wsl.localhost 在前、wsl$ 在后 —— 守住它的位置：toWslUncCandidates 的返回数组 —— 改错故障：WSL1 或旧版 Windows 上回退链断裂。
// INV-12 断言：UNC 回退失败不得直接抛错 —— 守住它的位置：upload 的 copied 分支 —— 改错故障：remote deploy 在 WSL1 上整体失效。
// INV-13 断言：命令执行前必须两次 assertNotDisposed —— 守住它的位置：exec 入口与 await 之后 —— 改错故障：dispose 窗口内仍 spawn，产生未登记的 child。
// INV-14 断言：disposed 标志必须同步置位 —— 守住它的位置：disposeAndWait 开头 —— 改错故障：并发调用各自执行收口，child 被重复 kill。
// INV-15 断言：disposeInFlight 一旦存在即复用 —— 守住它的位置：disposeAndWait 的首个分支 —— 改错故障：幂等被破坏，重复等待拖长退出路径。
// INV-16 断言：宽限期结束后只 kill Map 中仍存在的 child —— 守住它的位置：ownedChildren.has 判断 —— 改错故障：误杀其他会话或整个 distro 的进程。
// INV-17 断言：trackOwnedChild 的删除必须先于 resolveClosed —— 守住它的位置：finish 的函数体 —— 改错故障：等待方被唤醒时 Map 仍有残留，判断出错。
// INV-18 断言：onClose 只能触发一次且 exit 与 close 都接入 —— 守住它的位置：fired 标志与 fireOnce —— 改错故障：重复 resolve 或永远拿不到关闭事件。
// INV-19 断言：有 onProgress 或 signal 时必须走 uploadViaExec —— 守住它的位置：upload 的通道分支 —— 改错故障：进度与取消被静默忽略，上传无法中止。
// INV-20 断言：上传成功必须以 onClose 的退出码为准 —— 守住它的位置：两条上传路径的落点 —— 改错故障：命令失败但 Promise 先 resolve，上层以为文件已就位。
//
// 阅读：先读 INV 再读正文；UNC 回退与 dispose 归属是历史包袱，改动前成对阅读。
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, posix } from "node:path";
import type { WSLConnectOptions } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import { createCloseEventController } from "@zcode/server/remote/closeEvent.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import { isWSLAvailable, listWSLDistros, type WSLDistro } from "@zcode/server/remote/wsl-detect.js";
import {
  buildWslHostGatewayCommand,
  buildWslProxyPortProbeCommand,
  isLoopbackProxyHostname,
  normalizeWslProxyUrl,
  parseWslHostGatewayOutput,
  parseWslProxyPortProbeOutput,
  replaceProxyHostname,
} from "@zcode/server/remote/wslProxy.js";

// [契约] 这是 resolveInfo 的缓存载体，distroName 与 userName 允许为 null，homeDir 必须非空。
// [契约] homeDir 是远端展开 ~ 的唯一事实来源，调用方不得自行拼 HOME 或读环境变量。
// [失败路径] 三者来自同一次 bash -lc 输出，拆成多次探测会让 home 与 user 来自不同进程。
// [权衡] version 只用于诊断与 distro 选择提示，不参与路径解析，不要据此切换实现分支。
// [契约] 该结构只在本文件流通，不要导出；导出会把缓存字段变成跨模块契约。
interface ResolvedWSLInfo {
  distroName: string | null;
  userName: string | null;
  version: 1 | 2 | null;
  homeDir: string;
}

export interface ResolvedWSLIdentity {
  distro: string;
  user: string;
}

const WSL_COMMAND = "wsl.exe";
const WSL_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

// [契约] 单引号包裹并用双引号拼接内部单引号，是唯一允许的远端参数引用方式。
// [失败路径] 少一层转义会让文件名中的引号提前闭合，命令注入或路径截断都会静默发生。
// [权衡] 不能改用 JSON.stringify 或双引号，bash -lc 会展开其中的美元符与反引号。
// [契约] 只处理作为单个 argv 传递的字符串；含换行的值仍会被拆行，调用方需自证。
// [边界] 该函数不负责创建父目录，也不校验路径是否落在允许根内。
function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// [契约] 含 NUL 字节即判为 UTF-16LE，否则按 UTF-8 解码；分支顺序不能颠倒。
// [失败路径] 先试 UTF-8 会把 UTF-16 的中文变成乱码，且不会抛错，后续解析全部错位。
// [权衡] 用 includes(0) 而非 BOM 嗅探，是因为 wsl.exe 的 UTF-16 输出常不带 BOM。
// [契约] 空缓冲返回空串，调用方不得把空输出与「命令未执行」混为一谈。
// [边界] 该函数只解码，不裁剪换行与 CR，规范化统一在 normalizeWslOutput。
function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  if (buffer.includes(0)) {
    return buffer.toString("utf16le");
  }

  return buffer.toString("utf8");
}

// [契约] 去掉 NUL、首个 BOM、所有 CR；三步都必须保留，顺序不可交换。
// [失败路径] 漏掉 CR 会让按行拆分后残留回车，路径与 distro 名比较永远不相等。
// [失败路径] 去掉所有 NUL 而非只去首尾，是因为 UTF-16 解码后可能夹带填充字符。
// [权衡] 只去首个 BOM，避免把正文中合法的 U+FEFF 一并吞掉。
// [边界] 本函数不 trim；需要 trim 的调用点自行 trim，以免误删有意义的尾部空格。
function normalizeWslOutput(raw: string): string {
  return raw
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "");
}

// [契约] 参数顺序固定为 -d、-u、--exec、argv；顺序变化会被 wsl.exe 解释成不同命令。
// [契约] 没有 distroName 时不传 -d，交给默认 distro，不要传空串占位。
// [失败路径] 把 --exec 提到 -d 之前，distro 参数会被当成要执行的命令。
// [权衡] 用户名仅在显式提供时传 -u，避免覆盖用户在 .bashrc 里假定的身份。
// [边界] 本函数不做任何引用，argv 的引号规则由 Node spawn 与 CommandLineToArgvW 决定。
export function buildWslArgs(
  commandArgs: string[],
  distroName?: string | null,
  userName?: string | null,
): string[] {
  const args: string[] = [];
  if (distroName) {
    args.push("-d", distroName);
  }
  if (userName) {
    args.push("-u", userName);
  }

  // Bug 原因：wsl.exe 不带 --exec 时会把 `--` 之后的原始命令行整段交给用户默认 shell 以 `-c` 执行，
  // 而 Node 为含空格/引号的参数加的是双引号，外层 shell 会先展开 `"$var"`、`$(...)`，
  // 再把剩余内容交给内层 `bash -lc`。局部变量（如 Source Server tar preflight 的 `$tar_tool`）
  // 因此被提前展开成空串，远端输出 `tar=` 且退出码 0，被误判为「远端缺少 tar」。
  // --exec 让 wsl.exe 按 CommandLineToArgvW 解析 argv 后直接 exec，argv 与 Node 的引号规则互逆，
  // 命令字节原样到达 bash；登录环境仍由这里显式的 `bash -lc` 提供。
  // [契约] 必须保留 --exec，它让 wsl.exe 直接 exec argv，而不是把整段交给默认 shell 展开。
  // [失败路径] 去掉后 tar_tool 这类局部变量会在外层先展开成空串，远端输出 tar= 且退出码 0，
  // [失败路径] 上层会把它误判成「远端缺少 tar」并做出错误降级，日志里也看不到真实原因。
  // [契约] bash -lc 仍由调用方显式给出，不要指望 --exec 自己提供登录环境。
  // [权衡] 不能在命令串里再套一层引号规避展开，两套引号规则叠加会引入新的注入面。
  args.push("--exec", ...commandArgs);
  return args;
}

function toWslUncCandidates(linuxPath: string, distroName: string): string[] {
  const normalizedPath = linuxPath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  const suffix = pathSegments.length > 0 ? `\\${pathSegments.join("\\")}` : "";
  return [`\\\\wsl.localhost\\${distroName}${suffix}`, `\\\\wsl$\\${distroName}${suffix}`];
}

// [契约] 依次尝试，第一个成功即返回，全部失败返回 null；不要并发探测以免多余 IO。
// [失败路径] 捕获所有异常并继续是刻意的：此处 EACCES 与 ENOENT 都等价于候选不可用。
// [契约] 返回命中的路径而非 boolean，调用方复用该路径做后续读写，避免二次解析。
// [权衡] 失败不记日志，因为这是常规回退路径，逐次告警会淹没真正的错误。
// [边界] 不区分「文件不存在」与「前缀不支持」；需要区分时改用 execSimple 探测。
async function accessAnyPath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }

  return null;
}

async function copyFileToAnyPath(sourcePath: string, targetPaths: string[]): Promise<boolean> {
  for (const targetPath of targetPaths) {
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      return true;
    } catch {
      // WSL 1 / 某些 Windows 版本可能不支持当前 UNC 前缀，继续回退。
    }
  }

  return false;
}

// [契约] 实现 IRemoteBackend，所有对外方法都必须先过 ensureAvailable，不允许绕过。
// [契约] kind 固定为 wsl，是上层选择后端分支的唯一标识，不要改成运行时可变量。
// [资源] 实例会被多个调用方并发使用，内部状态只能是 promise 缓存或 Map，不得用裸标志位。
// [失败路径] 方法内抛出的错误直接上抛到 remote 层，不要在这里吞掉并返回假成功。
// [边界] 本类不注册 OS 服务、不管理 distro、不做重试；这些属于上层编排。
export class WSLBackend implements IRemoteBackend {
  readonly kind = "wsl" as const;

  private readonly options: WSLConnectOptions;
  private resolvedInfoPromise: Promise<ResolvedWSLInfo> | null = null;
  // [契约] 所有 spawn 与 execFile 产生的 child 都必须登记，dispose 只处理 Map 中的 child。
  // [并发] closed 由 trackOwnedChild 的 finish 解析，删除与 resolve 的顺序不能交换。
  // [失败路径] 漏登记一个 child，dispose 时就会把它遗留成孤儿进程，锁与管道都不释放。
  // [权衡] 同时监听 error/exit/close，是为了覆盖「spawn 失败」与「已退出」两种终态。
  // [边界] 绝不按进程名 kill wsl.exe，只能 kill 自己登记过的 child。
  private readonly ownedChildren = new Map<
    ChildProcess,
    { closed: Promise<void>; resolveClosed: () => void }
  >();
  private disposed = false;
  private disposeInFlight: Promise<void> | null = null;

  constructor(options: WSLConnectOptions) {
    this.options = options;
  }

  // [契约] 先 ensureAvailable 再 resolveInfo；顺序反了会在非 Windows 上抛出难懂的解析错误。
  // [失败路径] distro 或 user 任一为空即抛错，禁止用默认值补齐后返回。
  // [契约] 返回值用于生成 workspace identity，必须与后端口径完全一致。
  // [权衡] 不在这里暴露 homeDir，避免把路径事实混进身份对外契约。
  // [边界] 多次调用共享 resolveInfo 缓存，不会重复起 bash 进程。
  async resolveIdentity(): Promise<ResolvedWSLIdentity> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    if (!resolvedInfo.distroName || !resolvedInfo.userName) {
      throw new Error("无法解析 WSL 实际 distro/user 身份");
    }
    return {
      distro: resolvedInfo.distroName,
      user: resolvedInfo.userName,
    };
  }

  // [契约] uname -s 与 uname -m 分两次探测，不要合并成一条命令，否则解析依赖分隔符格式。
  // [失败路径] 平台最终由 resolveRemotePlatform 结合 /proc 判定，不能只用 uname 字符串。
  // [契约] kernelOstype 读取失败返回空串，属于预期降级，不得因此抛错。
  // [权衡] 串行探测牺牲一点延迟换取解析确定性；并发会让错误来源难以归因。
  // [边界] 只返回 platform 与 arch，不返回 distro 与版本，那些属于 resolveInfo。
  async detect(): Promise<RemoteEnvironment> {
    await this.ensureAvailable();
    const reportedPlatform = normalizeRemotePlatform(
      normalizeWslOutput(await this.execSimple("uname -s")),
    );
    const arch = normalizeRemoteArch(normalizeWslOutput(await this.execSimple("uname -m")));
    const kernelOstype = await this.readKernelOstype();
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    return {
      platform,
      arch,
    };
  }

  // [契约] 非 loopback 代理原样返回，不做 URL 规范化，以免改变用户已有的合法写法。
  // [失败路径] 规范化结果为空时回退原值，不能抛错阻断会话建立。
  // [契约] loopback 且本地探测为 true 时直接返回规范化值，不再尝试网关替换。
  // [权衡] 网关探测包在 try/catch 中，代理增强失败不应让整个 remote 连接失败。
  // [边界] 本方法只做地址改写，不验证代理协议是否被远端支持。
  async resolveRuntimeProxy(proxyUrl: string): Promise<string> {
    const normalizedProxyUrl = normalizeWslProxyUrl(proxyUrl);
    if (!normalizedProxyUrl) {
      return proxyUrl;
    }
    const parsedProxyUrl = new URL(normalizedProxyUrl);
    if (!isLoopbackProxyHostname(parsedProxyUrl.hostname)) {
      // 非 loopback 代理本来就是远端可解析地址；保留用户输入，避免无意义的 URL 规范化。
      return proxyUrl;
    }

    await this.ensureAvailable();
    const localProbe = await this.probeProxyPort(normalizedProxyUrl);
    if (localProbe === true) {
      // mirrored networking 或代理已监听 WSL loopback，不能替换成另一个地址。
      return normalizedProxyUrl;
    }

    try {
      const gateway = parseWslHostGatewayOutput(
        await this.execSimple(buildWslHostGatewayCommand()),
      );
      if (!gateway) {
        return normalizedProxyUrl;
      }
      const gatewayProxyUrl = replaceProxyHostname(normalizedProxyUrl, gateway);
      const gatewayProbe = await this.probeProxyPort(gatewayProxyUrl);
      return gatewayProbe === true ? gatewayProxyUrl : normalizedProxyUrl;
    } catch {
      // 代理解析只是运行时增强；失败时保留用户原值，让 Agent 自己返回可诊断的网络错误。
      return normalizedProxyUrl;
    }
  }

  // [契约] 先 resolveLinuxPath 再选通道，UNC 与 exec 两条路径必须使用同一个已展开路径。
  // [契约] 有 onProgress 或 signal 时必须走 uploadViaExec，UNC 分支无法提供进度与取消。
  // [失败路径] UNC 复制失败不能直接抛错，必须回退到 cat 写入，否则 remote deploy 整体失效。
  // [资源] 回退分支结束后必须等待 onClose 判定退出码，仅拿到 stream 不算上传成功。
  // [边界] 本方法不校验远端磁盘空间，也不做断点续传。
  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    // [契约] 该判断是通道选择的唯一分叉点，不能把 signal 与 onProgress 拆到两个条件里。
    // [失败路径] 漏掉 signal 会让取消请求被忽略，上传继续写满远端直到进程结束。
    // [权衡] UNC 路径更快但不支持进度，有可观测需求时优先牺牲速度换可控性。
    // [契约] 两个条件缺一不可，且要在任何 IO 之前判断，避免先复制再发现需要进度。
    // [边界] 这里不检查 signal 是否已 abort，那由 uploadViaExec 入口负责。
    if (options?.onProgress || options?.signal) {
      await this.uploadViaExec(localPath, resolvedRemotePath, options);
      return;
    }

    if (resolvedInfo.distroName) {
      const copied = await copyFileToAnyPath(
        localPath,
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (copied) {
        return;
      }
    }

    // WSL 1 或默认 distro 名称解析失败时，UNC 路径可能不可用。
    // 如果这里直接报错，remote deploy 会彻底失效；回退到 `cat > file` 的流式写入，
    // 至少能保证 server/node/pty 仍可上传，只是速度慢一些。
    // [契约] 回退写入必须在同一条 bash -lc 内完成 mkdir 与 cat，两步不可拆。
    // [失败路径] 分成两次 exec 时，中间若被取消会留下空目录或半截文件。
    // [契约] 路径必须经 quotePosixShellArg，否则含空格的远端路径会被拆成多个参数。
    // [并发] 每次上传各自持有一条流，不能共享流或复用一个 shell 会话。
    // [边界] 该分支不报告进度，调用方不应在此期待 onProgress 回调。
    const parentDir = posix.dirname(resolvedRemotePath);
    const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
    const stream = await this.exec(command);

    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let settled = false;

      const finishWithError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        readStream.destroy();
        const destroyableStdin = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        if (typeof destroyableStdin.destroy === "function") {
          destroyableStdin.destroy(error);
        } else {
          stdin.end();
        }
        reject(error);
      };

      readStream.on("error", (error) => finishWithError(error));
      stdin.on("error", (error: Error) => finishWithError(error));
      readStream.pipe(stdin);
      stream.onClose((code) => {
        if (settled) {
          return;
        }
        settled = true;
        if (code !== 0) {
          reject(new Error(`WSL upload failed with exit code ${code}`));
          return;
        }
        resolve();
      });
    });
  }

  // [契约] 入口先 stat 拿到 totalBytes，再检查 abort；顺序反了会先发起无意义的文件读取。
  // [失败路径] 已 abort 时必须抛 name 为 AbortError 的错误，上层据此区分取消与真实失败。
  // [资源] abort 监听必须在拿到 stream 后注册，并在 finishError 与 onClose 两处都移除。
  // [权衡] 用 readStream 的 data 事件计进度而不是另算字节数，避免与背压源不一致。
  // [边界] 本方法不处理重试，失败即上抛，由 remote deploy 决定是否重来。
  private async uploadViaExec(
    localPath: string,
    resolvedRemotePath: string,
    options: RemoteUploadOptions,
  ): Promise<void> {
    const totalBytes = await stat(localPath).then((value) => value.size);
    if (options.signal?.aborted) {
      const error = new Error("Remote upload canceled");
      error.name = "AbortError";
      throw error;
    }
    const parentDir = posix.dirname(resolvedRemotePath);
    const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
    const stream = await this.exec(command);
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const stdin = stream.stdin;
      let uploadedBytes = 0;
      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        readStream.destroy();
        const destroyable = stdin as NodeJS.WritableStream & {
          destroy?: (reason?: Error) => void;
        };
        destroyable.destroy?.(error);
        reject(error);
      };
      const abort = () => {
        const error = new Error("Remote upload canceled");
        error.name = "AbortError";
        finishError(error);
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      readStream.on("data", (chunk: Buffer) => {
        uploadedBytes += chunk.length;
        options.onProgress?.({ uploadedBytes, totalBytes });
      });
      readStream.on("error", finishError);
      stdin.on("error", finishError);
      stream.onClose((code) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        if (code !== 0) {
          reject(new Error(`WSL upload failed with exit code ${code}`));
          return;
        }
        options.onProgress?.({ uploadedBytes: totalBytes, totalBytes });
        resolve();
      });
      readStream.pipe(stdin);
    });
  }

  // [契约] 入口 assertNotDisposed，discovery 与 identity 的 await 之后必须再断言一次。
  // [并发] 第二次断言堵住 dispose barrier 在 await 期间插入的窗口，删掉即产生已释放仍 spawn。
  // [失败路径] spawn 的 error 只 reject 一次，spawn 回调内 stdio 缺失也必须 reject 而非抛同步异常。
  // [契约] resolve 出去的对象只暴露 stdio 与 onClose，不暴露 child，防止调用方绕过登记。
  // [边界] 本方法不等待命令结束，也不解释退出码；生命周期由 onClose 表达。
  async exec(command: string): Promise<StdioStream> {
    this.assertNotDisposed();
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    // 入口门禁之后的 discovery/identity await 允许 dispose barrier 插入并完成；
    // resolved info 命中缓存时，旧 continuation 会在 barrier 后继续 spawn。最终创建 child 前必须再校验。
    this.assertNotDisposed();

    return new Promise((resolve, reject) => {
      const child = spawn(
        WSL_COMMAND,
        buildWslArgs(["bash", "-lc", command], resolvedInfo.distroName, resolvedInfo.userName),
        {
          stdio: "pipe",
          windowsHide: true,
        },
      );
      this.trackOwnedChild(child);

      child.once("error", reject);
      child.once("spawn", () => {
        const stdin = child.stdin;
        const stdout = child.stdout;
        const stderr = child.stderr;
        if (!stdin || !stdout || !stderr) {
          reject(new Error("WSL process stdio is not available"));
          return;
        }

        const onClose = createCloseEventController();
        let fired = false;
        const fireOnce = (code: number) => {
          if (fired) {
            return;
          }
          fired = true;
          onClose.fire(code);
        };

        child.on("exit", (code) => {
          fireOnce(code ?? 0);
        });
        child.on("close", (code) => {
          fireOnce(code ?? 0);
        });

        resolve({
          stdin,
          stdout,
          stderr,
          onClose: onClose.event,
        });
      });
    });
  }

  // [契约] 先走 UNC 快速判定，再回退 execSimple 的 test -f；顺序不能反。
  // [失败路径] execSimple 抛错即视为不存在，但只应对 test 的失败成立，其他错误同样被吞。
  // [契约] 只判断文件，不判断目录；目录存在性由调用方用其他接口确认。
  // [权衡] UNC 命中时不做 stat，节省一次往返，代价是符号链接语义由 Windows 侧决定。
  // [边界] 本方法不区分权限不足与不存在，两者都返回 false。
  async exists(remotePath: string): Promise<boolean> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (resolvedInfo.distroName) {
      const accessiblePath = await accessAnyPath(
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (accessiblePath) {
        return true;
      }
    }

    try {
      await this.execSimple(`test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`);
      return true;
    } catch {
      return false;
    }
  }

  // [契约] UNC 可读时直接 UTF-8 读取，失败才回退 cat；两条路径的返回值都必须经 normalize。
  // [失败路径] UNC readFile 抛错不会自动回退，因此只应在 accessAnyPath 命中后调用。
  // [契约] 回退分支必须用 quotePosixShellArg，且只读文件不写任何临时文件。
  // [权衡] 不做大小上限检查，超大文件由调用方负责，避免这里引入第二套阈值。
  // [边界] 不返回 Buffer，编码转换集中在此完成，调用方拿到的永远是已规范化字符串。
  async readFile(remotePath: string): Promise<string> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (resolvedInfo.distroName) {
      const accessiblePath = await accessAnyPath(
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (accessiblePath) {
        return readFile(accessiblePath, "utf8");
      }
    }

    return normalizeWslOutput(
      await this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`),
    );
  }

  // [契约] 同步接口只做 fire-and-forget，真正的收口在 disposeAndWait，二者不能互相等待。
  // [失败路径] 在 dispose 里 await 会拖住事件循环，Host 退出路径可能超时。
  // [资源] dispose 之后新命令必须失败，因此 disposed 标志在 disposeAndWait 开头同步置位。
  // [权衡] 保留同步版本是为了兼容接口契约，不代表可以不调用 disposeAndWait。
  // [边界] dispose 不 terminate distro，只结束本 backend 自己启动的 child。
  dispose(): void {
    void this.disposeAndWait();
  }

  // [契约] disposeInFlight 一旦存在即复用，重复调用返回同一个 promise，保证幂等。
  // [并发] disposed 必须在创建 promise 之前同步置位，否则并发调用会各自执行收口。
  // [契约] 先同步 end 所有 child 的 stdin，再进入宽限期，顺序不能反。
  // [失败路径] 宽限期后只 kill 仍留在 Map 里的 child，绝不按名字或 distro 批量 kill。
  // [资源] 两段等待分别使用 graceTimeoutMs 与 killWaitTimeoutMs，不能合并成一个超时。
  disposeAndWait(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void> {
    if (this.disposeInFlight) {
      return this.disposeInFlight;
    }
    this.disposed = true;

    const graceTimeoutMs = Math.max(options?.graceTimeoutMs ?? 300, 0);
    const killWaitTimeoutMs = Math.max(options?.killWaitTimeoutMs ?? 250, 0);
    const children = Array.from(this.ownedChildren.entries());
    // WSL 过去不记录自己 spawn 的 wsl.exe，Host 被强杀时只能寄希望于管道 EOF。
    // 先同步关闭本 backend 子进程 stdin；宽限期后也只 kill 这些已证明归属的 child，绝不 terminate distro。
    for (const [child] of children) {
      this.endOwnedChildInput(child);
    }
    this.disposeInFlight = Promise.all(
      children.map(async ([child, state]) => {
        if (await this.waitForOwnedChildClose(state.closed, graceTimeoutMs)) {
          return;
        }
        if (this.ownedChildren.has(child)) {
          child.kill();
        }
        await this.waitForOwnedChildClose(state.closed, killWaitTimeoutMs);
      }),
    ).then(() => undefined);
    return this.disposeInFlight;
  }

  // [契约] 先建 closed promise 再 set 进 Map，最后才挂事件；顺序反了会丢事件。
  // [并发] finish 里先 get 再 delete 再 resolve，删除必须先于 resolve，避免等待方看到残留。
  // [失败路径] 重复 finish 通过 state 缺失短路，保证 resolveClosed 不会被调用两次。
  // [资源] error/exit/close 三个事件都挂同一 finish，覆盖 spawn 失败与正常退出。
  // [边界] 本方法不负责 end stdin 或 kill，只做登记与关闭信号。
  private trackOwnedChild(child: ChildProcess): void {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const finish = () => {
      const state = this.ownedChildren.get(child);
      if (!state) {
        return;
      }
      this.ownedChildren.delete(child);
      state.resolveClosed();
    };
    this.ownedChildren.set(child, { closed, resolveClosed });
    child.once("error", finish);
    child.once("exit", finish);
    child.once("close", finish);
  }

  // [契约] 唯一允许抛「已释放」错误的地方，新增入口必须复用而不是自行判断。
  // [失败路径] 抛错必须在 spawn 之前，否则会留下一个无人登记的 child。
  // [权衡] 用抛错而非返回 boolean，是为了让调用方无法忘记处理。
  // [契约] 错误文案会被上层直接展示，改动会影响用户可见提示。
  // [边界] 只检查 disposed，不检查平台与可用性，那些属于 ensureAvailable。
  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("WSL backend 已释放，无法启动新命令");
    }
  }

  private endOwnedChildInput(child: ChildProcess): void {
    if (!child.stdin || child.stdin.writableEnded) {
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // stdin 已异常关闭时继续进入本 child 的 kill fallback。
    }
  }

  private async waitForOwnedChildClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    return result;
  }

  private async ensureAvailable(): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("WSL 连接仅支持在 Windows 上使用");
    }

    const available = await isWSLAvailable((args) => this.execWslForBuffer(args));
    if (!available) {
      throw new Error("当前系统未检测到可用的 WSL 环境");
    }
  }

  // [契约] promise 缓存必须在首次 await 之前赋值，保证并发调用只解析一次。
  // [并发] 缓存的是 promise 而非结果，第二个调用方会等待同一次解析而不是看到空值。
  // [失败路径] 解析失败时缓存不清除，后续调用持续拿到同一个 rejection，这是刻意 fail-closed。
  // [契约] 返回值中的 homeDir 必须非空，为空即抛错，不允许降级成根目录。
  // [边界] 本方法不校验 distro 是否存在，选择逻辑在 pickDistro。
  private async resolveInfo(): Promise<ResolvedWSLInfo> {
    if (this.resolvedInfoPromise) {
      return this.resolvedInfoPromise;
    }

    // [契约] 用 IIFE 包住异步体，确保赋值发生在任何 await 之前，这是缓存正确性的关键。
    // [并发] 身份探测只跑一次 bash -lc，同时拿 distro、user、HOME，避免三者跨进程不一致。
    // [失败路径] 输出按行拆分，前两行固定为 distro 与 user，其余拼回 HOME，顺序不可改动。
    // [契约] distro 与 user 为空可用入参兜底，但 HOME 为空必须抛错，两个空值策略不同。
    // [边界] 这里只读不写远端文件，不创建任何目录。
    this.resolvedInfoPromise = (async () => {
      const distros = await this.safeListDistros();
      const selected = this.pickDistro(distros);
      const launchDistroName = selected?.name ?? this.options.distro?.trim() ?? null;
      const requestedUserName = this.options.user?.trim() || null;
      const identityOutput = normalizeWslOutput(
        await this.execDirect(
          ["bash", "-lc", `printf '%s\\n' "$WSL_DISTRO_NAME"; id -un; printf %s "$HOME"`],
          launchDistroName,
          requestedUserName,
        ),
      );
      const [reportedDistroName = "", actualUserName = "", ...homeLines] =
        identityOutput.split("\n");
      const distroName = reportedDistroName.trim() || launchDistroName;
      const userName = actualUserName.trim() || requestedUserName;
      const homeDir = homeLines.join("\n").trim();
      if (!homeDir) {
        throw new Error("无法解析 WSL 用户 HOME");
      }

      return {
        distroName,
        userName,
        version: selected?.version ?? null,
        homeDir,
      };
    })();

    return this.resolvedInfoPromise;
  }

  private async safeListDistros(): Promise<WSLDistro[]> {
    try {
      return await listWSLDistros((args) => this.execWslForBuffer(args));
    } catch {
      return [];
    }
  }

  // [契约] 显式指定 distro 时做大小写不敏感匹配，找不到就抛错，绝不静默回退默认 distro。
  // [失败路径] 用户写错名字却回退默认 distro，会把文件部署到错误的发行版且难以察觉。
  // [契约] 未指定时优先默认 distro，其次第一个；列表为空返回 null 交给上层兜底。
  // [权衡] 大小写不敏感是 Windows 习惯，但返回的是 distro 的真实名字。
  // [边界] 本方法不验证 distro 是否正在运行。
  private pickDistro(distros: WSLDistro[]): WSLDistro | null {
    const requestedDistro = this.options.distro?.trim();
    if (requestedDistro) {
      if (distros.length === 0) {
        return null;
      }

      const matched = distros.find(
        (distro) =>
          distro.name.localeCompare(requestedDistro, undefined, { sensitivity: "base" }) === 0,
      );
      if (!matched) {
        throw new Error(`未找到名为 ${this.options.distro} 的 WSL distro`);
      }

      return matched;
    }

    return distros.find((distro) => distro.isDefault) ?? distros[0] ?? null;
  }

  private async resolveLinuxPath(
    remotePath: string,
    resolvedInfo: ResolvedWSLInfo,
  ): Promise<string> {
    if (remotePath === "~") {
      return resolvedInfo.homeDir;
    }

    if (remotePath.startsWith("~/")) {
      return posix.join(resolvedInfo.homeDir, remotePath.slice(2));
    }

    return remotePath;
  }

  private async execSimple(command: string): Promise<string> {
    const resolvedInfo = await this.resolveInfo();
    return this.execDirect(
      ["bash", "-lc", command],
      resolvedInfo.distroName,
      resolvedInfo.userName,
    );
  }

  private async probeProxyPort(proxyUrl: string): Promise<boolean | undefined> {
    const command = buildWslProxyPortProbeCommand(proxyUrl);
    if (!command) {
      return undefined;
    }
    try {
      return parseWslProxyPortProbeOutput(await this.execSimple(command));
    } catch {
      return undefined;
    }
  }

  private async readKernelOstype(): Promise<string> {
    try {
      return normalizeWslOutput(
        await this.execSimple(
          "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi",
        ),
      ).trim();
    } catch {
      return "";
    }
  }

  private async execDirect(
    commandArgs: string[],
    distroName?: string | null,
    userName?: string | null,
  ): Promise<string> {
    const stdout = await this.execWslForBuffer(buildWslArgs(commandArgs, distroName, userName));
    return normalizeWslOutput(decodeWslOutput(stdout));
  }

  private async execWslForBuffer(args: string[]): Promise<Buffer> {
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      const child = execFile(
        WSL_COMMAND,
        args,
        {
          encoding: "buffer",
          maxBuffer: WSL_EXEC_MAX_BUFFER,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
          const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
          const stderrText = normalizeWslOutput(decodeWslOutput(stderrBuffer)).trim();

          if (error) {
            reject(new Error(stderrText || error.message));
            return;
          }

          resolve(stdoutBuffer);
        },
      );
      this.trackOwnedChild(child);
    });
  }
}
