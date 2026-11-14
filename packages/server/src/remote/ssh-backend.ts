/* eslint-disable max-lines -- SSH backend 集中维护连接、exec、SFTP 上传和 fallback 进度链路；集中维护以避免拆分引入远端连接回归。 */
// SSH 远程后端把一条 ssh2 连接包装成 IRemoteBackend：连接、exec、上传与 TCP 直连都由它转译，而部署语义不在本层。
// 职责边界：只管传输层与会话生命周期，不解析部署语义、不决定重试节奏、不做上传限流与进度呈现。
// 不负责：连接池、多主机复用与凭据轮换；更换凭据或主机必须新建 backend，而不是改配置重连。
// 生命周期分三段且顺序固定：构造期先建 Client 与监听，ensureConnected 再完成握手与就绪标记，最后由 dispose 单向退役。
// 对外方法可被并发调用，但彼此必须只经 connected、disposed、homeDirPromise 三字段协调状态，不能各自缓存。
// 事件面：onDidDisconnect 是唯一向外的生命周期事件出口，由客户端 error/close/end 三路归一化而来。
//
// 不变量：
// INV-01 断言：disposed 一旦置位，任何方法都不得再创建连接或 channel —— 守住它的位置：assertNotDisposed 与 ensureConnected 的二次校验 —— 改错故障：被取消的部署用旧凭据重新连上远端，出现两份并行的部署进程
// INV-02 断言：connected 只在 ready 事件之后置位 —— 守住它的位置：ensureConnected 的 handleReady —— 改错故障：握手未完成就允许 exec，channel 打开报未连接，错误文案指向错误层级
// INV-03 断言：一次连接周期最多上报一次断连 —— 守住它的位置：reportDisconnect 的 disconnectReported 闸门 —— 改错故障：error/close/end 连着触发三次，UI 弹出多份断连提示并重复退出 host
// INV-04 断言：从未成功连接的握手失败不产生断连事件 —— 守住它的位置：reportDisconnect 的 hasEverConnected 判断 —— 改错故障：首次连接失败同时走 reject 与断连两条路，错误被上报两次
// INV-05 断言：onClientError 在 dispose 之后仍保持挂载 —— 守住它的位置：dispose 只移除 close/end 监听 —— 改错故障：socket 关闭后迟到的 error 变成未捕获异常，连带其它 workspace 的 host 退出
// INV-06 断言：握手用的 ready 与 error 一次性监听必须互相摘除 —— 守住它的位置：handleReady 与 handleConnectError —— 改错故障：监听随重连次数累积，迟到 ready 把已 reject 的 promise 再次 settle
// INV-07 断言：disposed 与 ready 交错时必须 end 客户端并 reject —— 守住它的位置：handleReady 的 disposed 分支 —— 改错故障：连接建立成功但无人持有，形成永不释放的悬挂 socket
// INV-08 断言：每次重连后 homeDirPromise 必须失效 —— 守住它的位置：reportDisconnect 中置空 —— 改错故障：换机或换会话后仍用旧 HOME 解析相对路径，文件写到上一台机器的目录
// INV-09 断言：所有 exec 命令都经 POSIX shell 包装 —— 守住它的位置：exec 与 execSimple 的 buildPosixShellExecCommand —— 改错故障：默认 shell 为 fish 时 detect 与 deploy 直接语法报错
// INV-10 断言：execSimple 只在 close 收尾并使用 exit 记录的退出码 —— 守住它的位置：channel 的 exit/close 监听 —— 改错故障：exit 先到导致尾部 data 丢失，platform/arch 偶发识别为空
// INV-11 断言：上传前必须先 mkdir -p 目标目录 —— 守住它的位置：upload 中的 execSimple 调用 —— 改错故障：新 workspace 首次上传因父目录不存在失败
// INV-12 断言：只有 sftp-session 与 sftp-write 允许降级到 exec 上传 —— 守住它的位置：shouldFallbackToExecUpload —— 改错故障：本地读失败或用户取消被当成能力问题，白白重传整份文件
// INV-13 断言：aborted 失败不得触发降级 —— 守住它的位置：rejectOnce 的 kind 归类 —— 改错故障：用户取消后仍起一个 exec 上传，取消按钮看起来无效果
// INV-14 断言：execUploadOnly 在单个 backend 内单向置位 —— 守住它的位置：upload 的 catch 分支 —— 改错故障：每次上传都先失败一次 SFTP 再回退，上传耗时与日志量翻倍
// INV-15 断言：负缓存命中时仍要透传 signal 与 onProgress —— 守住它的位置：upload 的 exec-only 分支 —— 改错故障：取消按钮会失效、进度条会停更，用户以为部署卡死
// INV-16 断言：上传的每个出口都必须停止本地读流与远端会话 —— 守住它的位置：resolveOnce 与 rejectOnce —— 改错故障：失败后读流继续读到 100%，刷出一串虚假进度并延迟进程退出
// INV-17 断言：上传失败后不得把原始 error 再喂给 destroy —— 守住它的位置：rejectOnce 的 destroy 调用 —— 改错故障：清理路径自身再抛一次 error，一条失败打出多条重复日志
// INV-18 断言：exec 上传以 channel 退出码判定成败 —— 守住它的位置：uploadViaExec 的 onClose 回调 —— 改错故障：远端 cat 写盘失败但 stdin 写完，上传被误报为成功
// INV-19 断言：backend 不持有已打开的 exec 与 SFTP channel —— 守住它的位置：exec 与 openDirectTcpChannel 的返回 —— 改错故障：dispose 后 channel 仍占用连接，进程退出前一直等待远端
// INV-20 断言：openDirectTcpChannel 只接受 1 到 65535 的整数端口 —— 守住它的位置：方法入口的端口校验 —— 改错故障：脏端口进入 forwardOut，报错文案变成难定位的底层失败
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { createReadStream } from "node:fs";
import type { Duplex } from "node:stream";
import { posix } from "node:path";
import { Emitter } from "@zcode/rpc";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteDisconnectEvent,
  RemoteDisconnectReason,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@zcode/server/remote/backend.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import { createCloseEventController } from "@zcode/server/remote/closeEvent.js";
import {
  buildPosixShellExecCommand,
  quotePosixShellArg,
  resolvePosixHomePath,
} from "@zcode/server/remote/posixShell.js";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
} from "@zcode/server/remote/sshAuth.js";
import {
  createSSHUploadProgressReporter,
  formatSSHUploadError,
  formatSSHUploadLabel,
  readLocalFileSize,
} from "@zcode/server/remote/sshUploadProgress.js";

// SSHBackendOptions 是构造期快照的输入：本类不会回读该对象，传入后再改字段对已建 config 无效。
export interface SSHBackendOptions {
  // host 与 port 共同定位对端：port 省略时由 buildSSHConnectConfig 落 22，这里不设默认值以免两处默认分叉。
  host: string;
  // port 允许省略，但一旦给出必须是 1-65535：ssh2 不会替你校验，脏端口会在握手阶段变成难定位的底层错误。
  port?: number;
  // username 参与认证且不含域：Windows OpenSSH 需要 domain\user 形式时由调用方拼好，本类不做猜测。
  username: string;
  // privateKeyPath 只是给装配方的注解：本类从不读文件，真正参与握手的是 privateKey（两者不一致时只认后者）。
  privateKeyPath?: string;
  // privateKey 支持 string 与 Buffer 两种形态：Buffer 可避免 PEM 文本在内存里多存一份，ssh2 两者都接受。
  privateKey?: string | Buffer;
  // privateKeyPassphrase 只在私钥加密时需要：缺失会被 normalizeSSHConnectError 归一成「私钥需要口令」，而不是底层解密报错。
  privateKeyPassphrase?: string;
  // password 非空才启用密码认证：空串等同于未提供，buildSSHConnectConfig 会据此决定是否带 tryKeyboard。
  password?: string;
  // agent 显式给出才启用：密码模式下不传 agent 可避免 MaxAuthTries 被公钥尝试提前耗尽。
  agent?: string;
}

// [契约] 四种失败分类直接决定 upload 是否降级：只有 sftp-session 与 sftp-write 视为传输能力缺失。
// local-read 是本地磁盘问题，aborted 是用户取消；把它们算进能力缺失会触发无意义的重传。
// 新增分类必须同步 shouldFallbackToExecUpload，否则新失败会被静默吞进降级分支。
type SSHUploadFailureKind = "sftp-session" | "sftp-write" | "local-read" | "aborted";

// SSHUploadFailure 只在本模块内流通：uploadFailureKind 是 upload 决定是否降级的唯一输入，不跨模块序列化。
type SSHUploadFailure = Error & {
  // uploadFailureKind 可选：普通 Error 经 normalizeUnknownError 直接返回时没有这个字段，读取方必须容忍 undefined。
  uploadFailureKind?: SSHUploadFailureKind;
};

// normalizeUnknownError 只保证拿到 Error 实例，不负责分类：分类由 markSSHUploadFailure 单独打标。
function normalizeUnknownError(error: unknown, fallbackMessage: string): Error {
  // 已是 Error 就原样返回：包装会丢掉 cause 与堆栈，反而不利于定位第一次失败的位置。
  if (error instanceof Error) {
    // 直接返回同一对象而非复制：调用方随后写入 uploadFailureKind 时，原始错误的引用也会带上标记，这是有意的。
    return error;
  }

  // 字符串错误只在非空时转换：空串按「未知错误」处理，避免出现 message 为空且无法检索的 Error。
  if (typeof error === "string" && error.length > 0) {
    // 字符串转 Error 保留原文：远端 cat 或 shell 的 stderr 往往只有一行文本，这是唯一可读线索。
    return new Error(error);
  }

  // 其余类型一律落到 fallbackMessage：undefined/null/对象都走这里，保证 reject 出去的一定是 Error。
  return new Error(fallbackMessage);
}

// markSSHUploadFailure 是唯一的打标入口：调用点集中在 SFTP 的三个失败出口，便于核对是否有遗漏。
function markSSHUploadFailure(
  // error 保持 unknown：调用点拿到的是 ssh2 回调或 stream 的 error，形态不可控，先归一再加标记。
  error: unknown,
  // kind 由调用点按失败阶段决定，而不是从错误文本推断：文本匹配会在不同 ssh2 版本间漂移。
  kind: SSHUploadFailureKind,
  // fallbackMessage 只在 error 无法转成 Error 时生效：给了它，reject 的文案就不会是空字符串。
  fallbackMessage: string,
): SSHUploadFailure {
  // 先归一再加字段：直接给 unknown 挂属性在严格模式下会抛错，也会污染非对象值。
  const normalizedError = normalizeUnknownError(error, fallbackMessage) as SSHUploadFailure;
  // 标记写在返回对象上：upload 的 catch 只读 uploadFailureKind，不再检查 ssh2 的 error.code。
  normalizedError.uploadFailureKind = kind;
  // 返回同一个 Error 实例：保留堆栈，同时让调用方拿到带 kind 的引用。
  return normalizedError;
}

// 只过滤 CHANNEL_DATA 系列：它们承载命令 stdout/stderr，上传时按 chunk 高频刷屏。
// 不要顺手过滤 CHANNEL_OPEN 之类，否则握手卡住时又失去排查协商阶段的线索。
function shouldLogSSHDebugMessage(message: string): boolean {
  // 只过滤三类 CHANNEL_DATA 消息：握手与协商阶段的 debug 行必须保留，否则 ready 超时无从判断卡在哪一步。
  return !/\bCHANNEL_(?:DATA|EXTENDED_DATA|WINDOW_ADJUST)\b/u.test(message);
}

// createUploadAbortError 统一取消错误的身份：name=AbortError 让上层能按名称判断，而不必比对中英文文案。
function createUploadAbortError(): Error {
  // message 固定英文：它可能被日志采集与外部脚本匹配，改文案会破坏按字符串判定取消的逻辑。
  const error = new Error("Remote upload canceled");
  // name 必须显式改为 AbortError：Node 与浏览器生态按 name 识别取消，instanceof 无法跨包判断。
  error.name = "AbortError";
  // 返回同一个实例：调用点只 throw 一次，无需工厂缓存。
  return error;
}

// throwIfUploadAborted 是前置闸门：在建立任何 stream 之前先看一眼 signal，避免为已取消的上传分配资源。
function throwIfUploadAborted(signal?: AbortSignal): void {
  // 这里抛出的错误不带 uploadFailureKind=aborted：说明取消发生在进入 SFTP/exec 之前，upload 的 catch 不会误降级。
  if (signal?.aborted) throw createUploadAbortError();
}

// [并发] 一个实例代表一次连接使用周期，不能跨 workspace 共享：disposed 不可逆。
// 新连接必须新建实例，否则 execUploadOnly 这类能力缓存会被错误继承到另一台主机。
// 实例同时是 IRemoteBackend 实现与断连事件源，两件事共享同一条连接的生命周期。
export class SSHBackend implements IRemoteBackend {
  // client 在构造期创建且全生命周期复用：ssh2 的 Client 支持 end 后重连，替换实例会丢掉已挂的常驻监听。
  private client: SSHClient;
  // connected 只表示 ready 之后的可用性：它不追踪 socket 是否半开，半开由 keepalive 与 error 事件收敛（INV-02）。
  private connected = false;
  // config 只读：握手参数在构造期固化，重连必须复用同一份，否则会在同一 backend 内换掉凭据语义。
  private readonly config: ConnectConfig;
  // homeDirPromise 是 per-connection 缓存：断连时置空，保证换会话后 ~ 展开指向新机器的 HOME（INV-08）。
  private homeDirPromise: Promise<string> | null = null;
  // [权衡] 这是本连接上「SFTP 不可用」的负缓存，置位后本 backend 生命周期内不再尝试 SFTP。
  // 不做定期重探：网关能力在单次部署内基本稳定，反复探测只会让每次上传多付一次失败超时。
  // 若将来改成可复位，复位点必须与新连接创建时机一致，否则会出现 SFTP 与 exec 交替失败的抖动。
  // 字段是实例级而非全局：换主机必然换 backend，能力结论不会被带到另一台机器。
  private execUploadOnly = false;
  // disposed 单向：一旦置位，所有对外方法都在入口拒绝，禁止旧凭据复活（INV-01）。
  private disposed = false;
  // hasEverConnected 区分「握手失败」与「连接断开」：前者不产生断连事件，避免同一错误被上报两次（INV-04）。
  private hasEverConnected = false;
  // disconnectReported 保证一次连接周期只上报一次断连：error/close/end 常连续到达，缺它就会弹三次提示（INV-03）。
  private disconnectReported = false;
  // 断连 emitter 与连接同寿命：dispose 时才释放，断连后重新连接仍复用同一个事件源。
  private readonly disconnectEmitter = new Emitter<RemoteDisconnectEvent>();
  // onDidDisconnect 直接引用 emitter.event：不额外包一层，保证 dispose 后旧订阅随 emitter 一起失效。
  readonly onDidDisconnect = this.disconnectEmitter.event;

  // [契约] 该监听必须常驻，包括 disposed 之后：ssh2 在 socket 关闭后仍可能补发 error。
  // disposed 时静默返回而不是移除监听：移除会让迟到 error 变成未捕获异常并带走共享 host。
  // 非 disposed 时先打印原始错误再上报断连，因为上层收到断连后可能直接退出 host，丢掉的文案无法追回。
  private readonly onClientError = (error: unknown): void => {
    // disposed 分支静默返回而不移除监听：移除会让迟到的 error 变成 uncaughtException（INV-05）。
    if (this.disposed) {
      // ssh2 在 ready timeout 后销毁 socket 时，close/end 阶段可能再次发出 error。
      // dispose 期间保留监听器只为吸收这类迟到事件，不能再向上层重复报告或触发未捕获异常。
      return;
    }
    // 错误先归一化再上报：上层拿到断连后可能立刻退出 host，此时再想解释原始 ssh2 文案已经来不及。
    const normalizedError = normalizeSSHConnectError(error);
    // ready 之后如果底层连接抖动，ssh2 仍会发出 "error" 事件。
    // 若没有常驻监听，Node 会把它当成未捕获异常直接抛出，可能导致 host 进程崩溃。
    // 这里先记录错误详情再上报断连；上层收到断连后会退出 host，反过来会丢掉真实 error 文案。
    console.error("[ssh] client error:", normalizedError);
    // reason 用 error 而不是 close：两者都进来时，error 携带的细节更多，先到者也由 disconnectReported 定。
    this.reportDisconnect("error", normalizedError);
  };

  // close 与 end 各挂一个常量监听：用属性保存引用，dispose 时才能精确 off 掉这两个而不误删 error 监听。
  private readonly onClientClose = (): void => {
    // close 可能先于 error 到达：这里仍走 reportDisconnect，是否上报只由闸门决定，而不是靠事件顺序推断。
    this.reportDisconnect("close");
  };

  // end 表示对端半关闭：它同样算断连，缺这一路会让远端正常下线时 UI 一直显示已连接。
  private readonly onClientEnd = (): void => {
    // end 与 close 语义合并：两者只差谁先到，对上层暴露的 reason 必须可区分以便日志归因。
    this.reportDisconnect("end");
  };

  // 构造函数只做装配，不发起网络：ensureConnected 之前调用任何方法都不会产生流量。
  constructor(options: SSHBackendOptions) {
    // [契约] close 与 end 监听在 connect 之前就位，否则瞬时断开时没有接收方。
    // error 也在这里挂常驻监听，而不是只靠 ensureConnected 的一次性监听，保证 ready 之后的抖动同样被接住。
    // ready 反而交给 ensureConnected 临时挂一次性监听：每轮握手独立，避免重复 connect 时监听叠加。
    this.client = new SSHClient();
    // error 监听必须在 connect 之前挂上：ssh2 可能在 connect 返回前同步派发配置错误。
    this.client.on("error", this.onClientError);
    // close 同样提前挂载：瞬时断开时若没有接收方，这次断连就永远不会被上报。
    this.client.on("close", this.onClientClose);
    // end 提前挂载与 close 同理：三者顺序不影响结果，缺一个就会漏掉一种远端退出方式。
    this.client.on("end", this.onClientEnd);
    // [契约] ConnectConfig 只在构造期构建一次，凭据与算法选项不随重连变化。
    // 更换密码、私钥或跳板配置必须新建 backend，改这个对象不会影响已建立的连接语义。
    this.config = buildSSHConnectConfig({
      // host 原样传入：这里不做 trim 或协议前缀剥离，脏输入应在装配方归一，否则错误会藏在握手超时里。
      host: options.host,
      // port 透传 undefined 而不是先补 22：默认端口只由 buildSSHConnectConfig 决定，避免两处默认值分叉。
      port: options.port,
      // username 不做编码转换：非 ASCII 用户名由 ssh2 按 UTF-8 处理，本类额外转码反而会改变认证主体。
      username: options.username,
      // privateKey 与 privateKeyPassphrase 成对透传：私钥加密时缺口令会走 normalizeSSHConnectError 的专门文案。
      privateKey: options.privateKey,
      // passphrase 只在有 privateKey 时有意义：仅密码认证的主机上它会被 ssh2 忽略，不会触发额外提示。
      passphrase: options.privateKeyPassphrase,
      // password 透传后由 buildSSHConnectConfig 判空：空串在这里不清理，判空只发生在一个地方。
      password: options.password,
      // agent 只在显式给出时透传：省略时是否回落 SSH_AUTH_SOCK 由 buildSSHConnectConfig 按认证方式决定。
      agent: options.agent,
    });
    // debug 通道只在 development 开启：生产环境输出 ssh2 协商细节会拖慢连接并泄露主机指纹。
    if (resolveZCodeRuntimeEnv(process.env) === "development") {
      // debug 回调按需过滤而不是整体关闭：握手阶段的输出是排查 ready 超时的主要证据。
      this.config.debug = (message: string) => {
        // SSH ready 超时只暴露 client-timeout 时无法判断卡在 TCP、协商还是认证。
        // 仅开发环境输出 ssh2 握手细节；CHANNEL_DATA / EXTENDED_DATA 是命令 stdout/stderr 数据包，
        // 下载阶段会按 chunk 高频刷屏，过滤掉它们，避免连接窗口和 electron 日志被底层传输事件淹没。
        if (!shouldLogSSHDebugMessage(message)) {
          // 被过滤的消息直接返回：CHANNEL_DATA 系列按 chunk 高频到达，一行不拦就会淹掉整段连接日志。
          return;
        }
        // 前缀固定 [ssh2]：便于在混合日志里按模块 grep，也避免与 [ssh] 业务日志混淆。
        console.debug(`[ssh2] ${message}`);
      };
    }
    // 只有非空 password 才注册 keyboard-interactive：没有密码时注册会让认证阶段多走一次注定失败的尝试。
    if (typeof options.password === "string" && options.password.length > 0) {
      // `ssh2` 类型定义遗漏了 keyboard-interactive 事件，但运行时确实支持。
      // 这里局部转成 EventEmitter 接口，避免为了一个事件把整段代码降级到 any。
      (
        this.client as unknown as {
          // 只声明用到的 on 重载：ssh2 类型缺这个事件，收窄到最小接口比把整段代码降级成 any 更安全。
          on(event: string, listener: (...args: unknown[]) => void): void;
        }
      ).on(
        "keyboard-interactive",
        createKeyboardInteractiveResponder(options.password) as unknown as (
          ...args: unknown[]
        ) => void,
      );
    }
  }

  // 抛错而非静默返回：调用方需要拿到显式失败，不能得到一个指向已释放 backend 的假句柄。
  // 它是所有对外方法的最后一道闸门，尤其要覆盖 ensureConnected 的 await 之后。
  private assertNotDisposed(): void {
    // assertNotDisposed 抛错而不是静默返回：调用方需要显式失败，否则会拿到指向已释放后端的假句柄。
    if (this.disposed) {
      // 错误文案固定：上层按这段文本判定「后端已释放」，改字会让取消路径的判定失效。
      throw new Error("SSH backend 已释放，无法重新建立连接");
    }
  }

  // [并发] connected 在 ready 之后才置位，建连窗口内的重复调用会再次进入 connect，没有共享的进行中握手 promise。
  // 当前依赖上层串行调用；新增并发入口时必须在此补一次性握手 promise，否则会撞上重复连接错误。
  // 每轮握手各自挂 ready 与 error 的一次性监听，成功后必须先互相摘除，否则监听数量会随重连次数累积。
  // 这里不设超时与重试：握手超时归 ssh2 的 readyTimeout，重试预算归上层部署流程，避免两层超时互相掩盖。
  private async ensureConnected(): Promise<void> {
    // 连接取消会先释放 backend，但迟到的 deploy/cleanup continuation 仍可能
    // 调用 ensureConnected。ssh2 Client 支持 end 后再次 connect，必须在 backend 边界阻止旧凭据复活。
    this.assertNotDisposed();
    // connected 为真直接返回：这是唯一的快速路径，也是并发调用不会重复 connect 的前提（INV-02）。
    if (this.connected) return;
    // Promise 包住一次性握手：resolve 只能被 ready 或 error 之一 settle，重复 settle 已被监听摘除挡住（INV-06）。
    return new Promise((resolve, reject) => {
      // [并发] ready 与 dispose 可以交错：先摘掉连接期 error 监听，再校验 disposed，顺序反了会把握手失败吞掉。
      // disposed 分支必须 end 客户端并 reject：只 return 会留下一个已建立却无人持有的 socket。
      // 成功路径清空 disconnectReported，让新连接的断连事件重新具备上报资格。
      // hasEverConnected 只在真正 ready 时置位，它决定了后续断连是否对用户可见。
      const handleReady = () => {
        // 先摘连接期 error 监听再判 disposed：顺序反了会把 ready 之后紧跟的握手错误留成无人接收的 error。
        this.client.off("error", handleConnectError);
        // disposed 与 ready 的交错窗口在这里收口：只看 connected 会漏掉「已释放但握手成功」的悬挂 socket（INV-07）。
        if (this.disposed) {
          // dispose 与 ssh2 ready 可能交错；迟到的 ready 若重新标记 connected，
          // 后续 detect 会继续使用已取消连接的旧凭据。再次关闭 socket，并让原调用失败。
          this.client.end();
          // 用普通 Error 而不是 AbortError：这条是生命周期失败，上层应按部署失败处理，而不是按用户取消。
          reject(new Error("SSH backend 已释放，无法重新建立连接"));
          // 提前返回避免落到 connected=true：这一行是 INV-07 的第二道保险，删掉会让刚 end 的 client 又被标记可用。
          return;
        }
        // connected 只在 ready 之后置位：exec/detect 的入口判断全依赖它，提前置位会让 channel 在握手完成前打开（INV-02）。
        this.connected = true;
        // 置位后本次连接周期的断连才允许上报：握手失败的上报走 reject，不重复走断连（INV-04）。
        this.hasEverConnected = true;
        // 新连接重置上报闸门：不重置的话，第二次连接的断连会被当成「已上报过」而静默丢弃（INV-03）。
        this.disconnectReported = false;
        // 到这里才算握手完成：调用方拿到 resolve 即可安全创建 channel，无需再查 connected。
        resolve();
      };
      // [失败路径] 握手失败只做归一化后 reject，不自动重试：重试节奏由上层掌握，这里重试会造成次数不可控。
      // 摘掉 ready 监听，防止同一轮失败后迟到的 ready 把已 reject 的 promise 二次 settle。
      // 认证失败与网络失败都走这条路径，区分文案交给 normalizeSSHConnectError。
      const handleConnectError = (error: unknown) => {
        // 失败路径先摘 ready：迟到 ready 会把已 reject 的 promise 二次 settle，Node 静默忽略但状态已错（INV-06）。
        this.client.off("ready", handleReady);
        // 统一用 normalizeSSHConnectError 的文案：认证失败与网络失败对用户是不同处置建议，不能都显示原始 errno。
        reject(normalizeSSHConnectError(error));
      };
      // once 而非 on：每轮握手只应消费一次 ready，常驻监听会随重连次数累积。
      this.client.once("ready", handleReady);
      // 连接期 error 与常驻 onClientError 并存：前者只负责 settle 本次握手，后者负责连接建立后的断连上报。
      this.client.once("error", handleConnectError);
      // [失败路径] 失败后 client 仍可再次 connect，可重试性由上层决定；backend 不缓存失败态。
      // 但重试前必须确认没有残留的握手监听，否则多轮尝试会叠加 ready 回调。
      // 握手失败后 connected 保持 false，下一次 ensureConnected 会重新走完整流程。
      this.client.connect(this.config);
    });
  }

  // [契约] 幂等闸门由 disconnectReported 与 hasEverConnected 共同把关，一次连接周期最多上报一次。
  // 从未成功连接的失败不当作断连：那是握手错误，已由 ensureConnected 的 reject 表达，重复上报会造成双份错误 UI。
  // 无论是否上报都要清 connected 与 homeDirPromise，后者是 per-connection 缓存，连接换掉必须失效。
  // emitter 只在 dispose 时释放，断连后仍可再次连接并复用同一个事件源。
  private reportDisconnect(reason: RemoteDisconnectReason, error?: Error): void {
    // 三个条件必须同时成立：未释放、未上报过、且这次连接曾经 ready 过；缺一个就会产生重复提示或误报（INV-03/INV-04）。
    const shouldReport =
      !this.disposed && !this.disconnectReported && (this.connected || this.hasEverConnected);

    // 无论是否上报都先清 connected：它是可用性事实，不能因为「不通知用户」就保留为真。
    this.connected = false;
    // 同时失效 HOME 缓存：换连接后 ~ 的展开目标可能已经变了一台机器（INV-08）。
    this.homeDirPromise = null;

    // 闸门放在状态清理之后：不通知也要让内部状态回到未连接，否则下一次 ensureConnected 会走快速路径。
    if (!shouldReport) {
      // 直接返回而不是 throw：断连是异步事件，抛错只会变成 emitter 调用栈上的未捕获异常。
      return;
    }

    // 先置位再 fire：fire 触发的监听可能同步调用 dispose 或再次收到 close，闸门必须先就位（INV-03）。
    this.disconnectReported = true;
    // error 只在有时才挂上：断连载荷的 shape 影响上层序列化，凭空塞 undefined 会让 IPC 侧多一个字段。
    this.disconnectEmitter.fire(error ? { reason, error } : { reason });
  }

  // [权衡] 三条探测合并成一个 exec，是为了把恢复预算内的 channel 数压到最低。
  // 拆成多个 channel 会让冷启动多付往返开销，并引入各字段来自不同连接的竞态。
  // 解析失败时字段退化为空串并交给 normalize 兜底，不在这里抛错。
  async detect(): Promise<RemoteEnvironment> {
    // detect 不自行建连：调用方可能已经连上，这里只做幂等确保（INV-02）。
    await this.ensureConnected();
    // Bug 原因：冷启动曾为 platform、arch、kernel ostype 串行创建三个 SSH exec channel，
    // 仅环境探测就占掉大部分 10 秒恢复预算。保持一个 POSIX channel 可同时避免首次多 channel 竞态。
    const output = await this.execSimple(
      "printf 'platform='; uname -s; printf 'arch='; uname -m; printf 'kernel='; " +
        "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\\n'; fi",
    );
    // readField 只做文本切片而不校验取值：platform/arch 的合法性必须交给 normalizeRemotePlatform，避免两处口径分叉。
    const readField = (name: string): string =>
      // 从同一个 output 里取三个字段：合并执行就是为了让它们来自同一次 uname，避免跨连接竞态。
      output
        .split(/\r?\n/u)
        .find((line) => line.startsWith(`${name}=`))
        // 找不到字段时返回 undefined 再由 ?? 兜成空串：直接抛错会让一个不认识的 uname 变体整体探测失败。
        ?.slice(name.length + 1)
        .trim() ?? "";
    // 先归一显式平台：uname -s 在 Git Bash、BusyBox 上有多种写法，白名单之外一律 unknown。
    const reportedPlatform = normalizeRemotePlatform(readField("platform"));
    // arch 单独归一：aarch64 与 arm64 必须折叠成同一种取值，否则下游按架构选包会漏。
    const arch = normalizeRemoteArch(readField("arch"));
    // kernel 保留原始串：它是平台的旁证而不是展示字段，归一化交给 resolveRemotePlatform 决定优先级。
    const kernelOstype = readField("kernel");
    // 最终平台由 resolveRemotePlatform 裁定：uname 在容器里可能报宿主内核，必须允许 kernel ostype 覆盖。
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    // 只在两者不一致时告警：正常路径每台机器都打一条会把日志淹没。
    if (platform !== reportedPlatform) {
      // 告警带上 resolveRemotePlatform 两个来源的原文：排查容器里识别成宿主平台时需要知道是谁覆盖了谁。
      console.warn(
        `[ssh] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
      );
    }

    // 只返回归一后的两个字段：原始串留在日志里，不往上层泄漏会漂移的文本。
    return { platform, arch };
  }

  // upload 是唯一上传入口：执行顺序（取消检查→连接→路径解析→mkdir→传输）不可重排。
  async upload(
    // localPath 由本进程读取：远端读不到它，SFTP 与 exec 两种实现都在本地开流。
    localPath: string,
    // remotePath 允许 ~ 与相对路径：真正的绝对化在 resolveRemotePath，调用方不必先拼 HOME。
    remotePath: string,
    // options 携带 signal 与 onProgress：两条上传路径都必须透传，否则取消与进度会单边失效（INV-15）。
    options?: RemoteUploadOptions,
  ): Promise<void> {
    // 进入即查取消：此时还没有任何资源，提前返回是成本最低的取消出口。
    throwIfUploadAborted(options?.signal);
    // 先连再解析路径：resolveRemotePath 依赖 exec，未连接时调用会让错误落在错误层级。
    await this.ensureConnected();
    // 连接等待期间 backend 可能被释放：await 之后必须再断言一次（INV-01）。
    this.assertNotDisposed();
    // 只解析一次并全程复用：两次解析之间 HOME 缓存可能被断连清空，导致同一文件写到两个目录。
    const resolved = await this.resolveRemotePath(remotePath);
    // 路径解析也是一次 exec：它同样可能被取消，落地前必须复查 signal。
    throwIfUploadAborted(options?.signal);
    // 第二次断言覆盖 resolveRemotePath 的 await 窗口：dispose 可能刚好发生在这一次 exec 里。
    this.assertNotDisposed();
    // 日志用脱敏后的 label：路径可能包含用户名或 workspace 标识，原样打印会进错误上报。
    const uploadLabel = formatSSHUploadLabel(resolved);
    // console.log 打完整路径：它只进本地文件，而脱敏只作用于用户可见文案，排障时必须看到实际落点。
    console.log(`[ssh] upload: resolved ${uploadLabel} to ${resolved}`);
    // [事务] mkdir -p 在传输之前单独执行，复用 shell 通道而不走 SFTP。
    // 它同时充当「shell 视图可写」的探针：目录建得出来，说明后面的 exec 上传通道可用。
    // 目录建立成功但文件写入失败时不做回滚：残留空目录无害，删除反而可能误伤并发上传的产物。
    const dir = posix.dirname(resolved);
    // mkdir 用 execSimple 而非 SFTP：它同时验证 shell 视图可用，为后面的 exec 上传兜底（INV-11）。
    await this.execSimple(`mkdir -p ${quotePosixShellArg(dir)}`);

    // [契约] 负缓存命中时仍要透传本次的 signal 与 onProgress。
    // 漏传 signal 会让本次上传的取消按钮失效，漏传 onProgress 会让 UI 进度停更。
    // execUploadOnly 缓存的是传输方式，不是这次上传的状态；每次上传都是独立事务。
    if (this.execUploadOnly) {
      // exec-only 只缓存传输能力，不能丢掉每次上传独立的取消信号与进度回调；
      // 否则首次 SFTP 降级后的后续资源会脱离连接取消流程，并让 UI 停止更新进度。
      await this.uploadViaExec(localPath, resolved, options);
      // exec-only 分支直接返回：不再尝试 SFTP，否则每次上传都先失败一次再降级（INV-14）。
      return;
    }

    try {
      // 默认先走 SFTP：它支持进度与流式写入，exec 只作为能力兜底。
      await this.uploadViaSftp(localPath, resolved, options);
    } catch (error) {
      // 只有 sftp-session 与 sftp-write 可降级：本地读失败和用户取消重试也没用（INV-12/INV-13）。
      if (!this.shouldFallbackToExecUpload(error)) {
        // 原样抛出而不是重新包装：uploadFailureKind 已由内部打标，再包一层会丢掉失败分类。
        throw error;
      }

      // 某些网关 / 跳板 SSH 会把 exec 与 SFTP 落到不同的文件系统视图。
      // 这类场景下，前面的 `mkdir -p` 已经证明 shell 视图可写，但 SFTP 往同一路径写文件仍会报 NO_SUCH_FILE。
      // 这里回退到 `cat > file`，强制复用已验证可用的 shell 通道，避免把“网关不支持 SFTP 直写”误判成连接失败。
      // 同一个 backend 后续继续试 SFTP 只会重复失败并刷日志，因此在首次能力失败后记住 exec-only 状态；
      // 新连接会创建新的 backend，自然会重新探测 SFTP 能力。
      // [失败路径] 置位发生在首次 SFTP 能力失败之后，且只影响当前 backend。
      // 同一 backend 只服务一台主机，所以不需要按主机维度分桶。
      // 若改为按主机加时间窗缓存，必须同时定义恢复时机，否则一次失败就永久降速。
      this.execUploadOnly = true;
      // 降级只记 warn 不记 error：这是可恢复的能力切换，记 error 会让监控把正常兜底算成部署失败。
      console.warn(
        `[ssh] upload: switching ${uploadLabel} from sftp to exec pipe after ${this.describeUploadFailure(error)}`,
      );
      // 降级复用同一次 resolved 与 options：重新解析路径会换 HOME，重新拿 signal 会丢掉本次取消。
      await this.uploadViaExec(localPath, resolved, options);
    }
  }

  // [并发] ensureConnected 的 await 是取消屏障：等待期间 backend 可能被释放，落地前必须再校验一次。
  // 返回的 StdioStream 由调用方负责消费与结束，backend 不登记已打开的 channel。
  // 因此 dispose 不会主动关闭这些 channel，它们靠自身 close 或连接关闭收敛。
  async exec(command: string): Promise<StdioStream> {
    // exec 每次调用都先确保连接：它不缓存 channel，断连后重连由 ensureConnected 兜住（INV-19）。
    await this.ensureConnected();
    // ensureConnected 的 await 与真正创建 channel 之间允许取消屏障插入，必须再次校验。
    this.assertNotDisposed();
    // Promise 只包 channel 创建：它 resolve 得很早，生命周期由返回的 StdioStream 自己承担（INV-19）。
    return new Promise((resolve, reject) => {
      // SSH exec 会先交给远端用户的默认 shell；fish 会把部署脚本里的 `download=` 等 POSIX 语法当成错误。
      // 在 SSH 边界统一进入 /bin/sh，保证 remote deploy、preflight 和 server 启动脚本都按项目声明的 POSIX shell 语义执行。
      this.client.exec(buildPosixShellExecCommand(command), (err, channel) => {
        // 打开 channel 失败直接 reject 原始 err：这里还没进入业务阶段，上层需要看到 ssh2 的原文。
        if (err) return reject(err);

        // onClose 控制器负责「只 fire 一次」：exit 与 close 都可能先到，甚至只来一个。
        const onClose = createCloseEventController();
        // [契约] exit 与 close 都可能先到，甚至只来一个，fireOnce 是 onClose 的唯一出口。
        // close 不携带退出码，close 先到时会按 0 上报；调用方若在上传管道上依赖这个码，需要知道该偏差。
        // fired 只保证退出只上报一次，不改变 channel 本身的生命周期，channel 仍由 ssh2 关闭。
        let fired = false;
        // fireOnce 是 onClose 的唯一出口：直接 onClose.fire 会在两个事件都到达时重复收尾。
        const fireOnce = (code: number) => {
          // fired 闸门只认第一个退出码：exit 通常带真实码，close 先到只能按 0 处理。
          if (fired) return;
          // 先置位再 fire：fire 的监听可能同步再读 onClose，闸门必须先就位。
          fired = true;
          // remote deploy 会执行大量短命令，成功退出的 code=0 日志没有排查价值且会刷屏。
          // 这里只保留失败退出码，正常流程由上层的阶段日志和进度日志表达。
          if (code !== 0) {
            // 成功退出不记日志：remote deploy 的短命令量大，记成功会刷屏且没有排查价值。
            console.warn(`[ssh] exec channel failed: code=${code}`);
          }
          // null 退出码按 0 上报：ssh2 在 close 先到时给不出码，调用方需要知道这个偏差。
          onClose.fire(code ?? 0);
        };

        // ssh2 channels may fire 'exit' before 'close', or sometimes
        // only one of them. Listen to both to be safe.
        channel.on("exit", (code: number | null) => {
          // exit 携带真实退出码：它能区分「脚本返回 1」与「channel 被关闭」。
          fireOnce(code ?? 0);
        });
        // close 兜底：部分网关只发 close 不发 exit，缺这一路会让 onClose 永不触发。
        channel.on("close", () => {
          // close 先到按成功上报：此时拿不到真实码，宁可让上层按 0 处理，也不要把文件误判为失败。
          fireOnce(0);
        });

        // resolve 的是 stdio 句柄而不是完成信号：调用方拿到即可开始写 stdin。
        resolve({
          // stdin 直接暴露 channel 的写端：本类不缓存它，dispose 也不会代为关闭（INV-19）。
          stdin: channel.stdin,
          // stdout 用 channel 本身：ssh2 把可读端直接挂在 channel 上，另包一层会丢掉背压。
          stdout: channel,
          // stderr 单独暴露：调用方需要把远端报错与正常输出分开收集。
          stderr: channel.stderr,
          // onClose 只暴露事件不暴露 fire：收尾权必须留在本类，否则调用方能让控制器进入已 settle 状态。
          onClose: onClose.event,
        });
      });
    });
  }

  // [契约] 只接受 1 到 65535 的整数端口，非法值在本地拒绝，不把脏参数送进 forwardOut。
  // [资源] 返回的 channel 不登记到 backend，dispose 不会关闭它，调用方必须自行 end，否则 socket 泄漏到进程退出。
  // forwardOut 的本地端绑定 0 端口由内核分配，避免多个并发隧道抢同一个本地端口。
  async openDirectTcpChannel(port: number): Promise<Duplex> {
    // 端口在本地先校验：脏值进 forwardOut 会变成底层 socket 错误，文案指不到调用方（INV-20）。
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      // 错误带原始端口值：上层日志需要知道是哪个配置项写错了，而不是只看到 invalid。
      throw new Error(`Invalid remote TCP port: ${port}`);
    }
    // forwardOut 依赖已就绪连接：未 ready 时调用会报 channel 打开失败，错误层级会误导。
    await this.ensureConnected();
    // 这里 await 而不是直接 return promise：保证异常以 reject 形式回到调用方，而不是同步抛出。
    return await new Promise<Duplex>((resolve, reject) => {
      // 本地绑 0 端口让内核分配：固定本地端口会在并发隧道时互相抢占。
      this.client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, channel) => {
        // forwardOut 的 error 原样 reject：它可能来自远端拒绝或本地端口耗尽，需要保留原文。
        if (error) reject(error);
        // channel 由调用方持有：本类不登记，dispose 不会替你关闭（INV-19）。
        else resolve(channel);
      });
    });
  }

  // [失败路径] 所有错误折叠成 false：连接瞬断或权限不足与「文件不存在」在这里不可区分。
  // 调用方不能把这个布尔当作连接健康信号，做删除或覆盖决策时需要额外的可重试判断。
  async exists(remotePath: string): Promise<boolean> {
    try {
      // exists 也走 HOME 解析：~ 与相对路径必须与 upload/readFile 指向同一个文件。
      const resolvedRemotePath = await this.resolveRemotePath(remotePath);
      // 用 test -f 而不是 SFTP stat：exec 通道在 SFTP 不可用的网关上仍然可用。
      const result = await this.execSimple(
        `test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`,
      );
      // 只认精确 OK：命令被截断或混入提示符时不能算存在，宁可返回 false。
      return result.trim() === "OK";
    } catch {
      // 任何异常都折叠成 false：连接瞬断与权限不足在这里无法区分，调用方不能据此判断连接健康。
      return false;
    }
  }

  // readFile 是 upload 之外的唯一读路径：只走 execSimple 的 cat，不建 SFTP 会话，SFTP 不可用的网关也能读。
  // 返回值不做编码转换：远端文件按字节直出，二进制内容会被 chunk.toString 破坏，调用方须自行确认是文本。
  async readFile(remotePath: string): Promise<string> {
    // readFile 也先过 resolveRemotePath：~ 与相对路径必须与 upload 落到同一个 HOME，否则读到的是另一台机器的目录。
    const resolvedRemotePath = await this.resolveRemotePath(remotePath);
    // 用 cat 加 quotePosixShellArg 而不是 SFTP 读：quote 保证含空格或引号的路径不会被 shell 拆成多个参数。
    return this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`);
  }

  /** Execute a simple command and return stdout as string */
  // [契约] 与 exec 共用 POSIX 包装，保证 detect/exists/readFile 在非 POSIX 默认 shell 下也能执行。
  // 断言 disposed 放在 Promise 之前，保证释放后不再创建 channel。
  // 输出按 chunk 拼字符串，适合短命令；长输出会整段驻留内存。
  private execSimple(command: string): Promise<string> {
    // 断言放在 Promise 构造之前：disposed 后同步抛出，不必等 exec 回调再走一次 reject。
    this.assertNotDisposed();
    // 不直接返回 client.exec：ssh2 只在回调里同时给出 err 与 channel，Promise 是唯一能接住两路的形态。
    return new Promise((resolve, reject) => {
      // execSimple 同样会执行 POSIX 片段（例如 `[ -r ... ]`、变量展开）。
      // 这里和 exec 保持同一层 shell 策略，避免 detect/exists/readFile 在 fish 默认 shell 下先于部署失败。
      this.client.exec(buildPosixShellExecCommand(command), (err, channel) => {
        // 打开 channel 失败直接 reject 原始 err：此处不再经 normalizeSSHConnectError，错误来自 exec 而非握手。
        if (err) return reject(err);
        // stdout 用字符串拼接而非 Buffer 数组：短命令输出小，省一次最终 concat，代价是长输出会整段驻留内存。
        let stdout = "";
        // stderr 单独累积：失败时与 stdout 拼成同一条 message，远端把原因写 stderr 才不会只剩退出码。
        let stderr = "";
        // done 是单次 settle 闸门：exit 与 close 都会触发 finish，缺它会对同一条命令 reject 两次。
        let done = false;
        // exitCode 记录 exit 事件的真实码：close 事件在部分 ssh2 版本上不携带 code，先存下来才能回填。
        let exitCode: number | null = null;

        // 监听挂在 data 而不是 stdout 字段上：stdout 是命令唯一的结果通道，detect 依赖它读取 key=value 行。
        channel.on("data", (chunk: Buffer) => {
          // 逐 chunk 追加而非按行切分：channel 不保证一次给出完整行，行边界交给调用方的 readField 处理。
          stdout += chunk.toString();
        });
        // stderr 用独立流监听：channel.stderr 与 channel 是两个 Duplex，漏掉它会让失败命令只剩退出码。
        channel.stderr.on("data", (chunk: Buffer) => {
          // stderr 只累积不解析：调用方仅在非零退出时使用，避免正常命令的 warning 污染 stdout 结果。
          stderr += chunk.toString();
        });

        // finish 是唯一收尾函数：resolve 与 reject 都从这里出，两条路径才能共用同一套退出码语义。
        const finish = (code: number) => {
          // 重复 finish 静默丢弃：close 可能因 socket 错误触发两次，第二次必须无副作用。
          if (done) return;
          // 先置 done 再分支：置位与 resolve 之间不能插入 await，否则并发 close 会穿插进半收尾状态。
          done = true;
          // 非零退出统一按失败处理：ssh2 不区分命令失败与传输失败，退出码是唯一可判定的信号（INV-10）。
          if (code !== 0) {
            // message 优先取 stderr：远端命令把原因写 stderr 且 stdout 为空，反序会让报错退化成空串。
            reject(new Error(`Command failed (code ${code}): ${stderr || stdout}`));
          } else {
            // 成功分支返回未 trim 的 stdout：是否 trim 由调用方决定，detect 需要保留行边界做 readField。
            resolve(stdout);
          }
        };

        // ssh2 在短命令场景下可能先发 exit，再异步派发 stdout data。
        // 不能在 exit 事件直接 finish：会把后续 data 丢掉，导致 platform/arch 偶发识别为空。
        // 这里改为只在 close 统一收尾，并优先使用 exit 记录的真实退出码，避免误判成功。
        channel.on("exit", (code: number | null) => {
          // exit 只记录不收尾：ssh2 可能先发 exit 再派发尾部 data，提前 finish 会丢掉最后的输出（INV-10）。
          exitCode = code ?? 0;
        });
        // close 是唯一收尾触发点：Windows OpenSSH 只在 close 时才保证 data 已全部派发。
        channel.on("close", (code: number | null) => {
          // exitCode 优先于 close 参数：部分 ssh2 版本 close 给 null，回填能让失败命令不被当成成功。
          const resolvedCode = exitCode ?? code ?? 0;
          // 收尾交给 finish 统一判定：这里不再自行 resolve，避免与 exit 分支给出两个出口。
          finish(resolvedCode);
        });
      });
    });
  }

  // [契约] 缓存的是 promise 而非值：并发调用只会发起一次 exec，避免重复探测 HOME。
  // [失败路径] 失败时 rejected promise 会留在字段上，直到 reportDisconnect 清空；期间所有路径解析立即失败。
  // 这是刻意的：HOME 都解析不出来通常意味着连接已坏，继续重试只会放大错误日志。
  private async resolveHomeDir(): Promise<string> {
    // 缓存命中直接返回同一个 promise：并发调用共用一次 exec，不会在不同调用间给出两个不同 HOME。
    if (this.homeDirPromise) {
      // 返回字段本身而非 await 后的值：失败态 promise 也被复用，让后续路径解析快速失败而不是重复探测。
      return this.homeDirPromise;
    }

    // 用 printf %s 而不是 echo：echo 在部分 shell 会解释反斜杠，printf 保证原样输出且不带换行差异。
    this.homeDirPromise = this.execSimple('printf %s "$HOME"').then((homeDir) => homeDir.trim());
    // 赋值后立刻返回同一引用：调用方 await 的 promise 与字段必须是同一对象，否则 reportDisconnect 置空会留下孤儿。
    return this.homeDirPromise;
  }

  // 降级判据只看 uploadFailureKind：不嗅探 error.message，文本匹配会在 ssh2 版本升级后漂移（INV-12）。
  private shouldFallbackToExecUpload(error: unknown): boolean {
    // 转成 SSHUploadFailure 是为读出可选字段：非对象错误在严格模式下直接取属性会抛 TypeError。
    const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
    // 只有 sftp-session 与 sftp-write 返回 true：local-read 与 aborted 属于本地问题与用户意图，降级只会白传整份文件（INV-13）。
    return uploadFailureKind === "sftp-session" || uploadFailureKind === "sftp-write";
  }

  // describeUploadFailure 只构造文案不做判定：是否降级由 shouldFallbackToExecUpload 单独决定，两者不能合并。
  private describeUploadFailure(error: unknown): string {
    // 与降级判据读同一字段：日志里的分类必须与决策依据同源，否则会出现「记了 sftp-write 却没降级」的错觉。
    const uploadFailureKind = (error as SSHUploadFailure | undefined)?.uploadFailureKind;
    // formatSSHUploadError 负责把 unknown 压成一行：分类前缀由本函数拼，避免 format 函数承担业务语义。
    const errorLabel = formatSSHUploadError(error);
    // 有 kind 才加前缀：undefined 表示错误未经 markSSHUploadFailure，拼出「undefined failure」反而误导排查。
    return uploadFailureKind ? `${uploadFailureKind} failure (${errorLabel})` : errorLabel;
  }

  // uploadViaSftp 的失败必须带 kind：upload 的 catch 只按 kind 决定降级，漏标会被当成致命错误直接抛给用户。
  private async uploadViaSftp(
    // localPath 保持调用方原样：本方法不做路径规范化，~ 展开与相对路径解析已在 upload 入口完成。
    localPath: string,
    // 参数名带 resolved 前缀：进来时已是绝对 POSIX 路径，这里不能再走 resolveRemotePath，否则会二次展开 HOME。
    resolvedRemotePath: string,
    // options 透传 signal 与 onProgress：本方法不复制也不缓存，取消与进度都必须直连调用方。
    options?: RemoteUploadOptions,
  ): Promise<void> {
    // 进入 SFTP 前先查取消：已取消的上传不该打开 sftp 会话，否则还要额外走一次会话关闭。
    throwIfUploadAborted(options?.signal);
    // 二次断言 disposed：upload 校验后可能被并发 dispose，建会话前必须再确认一次（INV-01）。
    this.assertNotDisposed();
    // uploadLabel 是日志与进度的统一标签：SFTP 与 exec 两条路径同格式，便于按标签聚合一次上传的两段。
    const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
    // 先读本地文件大小：拿不到时 totalBytes 为 null，进度只能报已传字节，UI 会退化成不确定进度条。
    const totalBytes = await readLocalFileSize(localPath);
    // reporter 绑定 sftp 通道名：同一文件降级到 exec 时会另建 reporter，两段进度不会互相覆盖。
    const progressReporter = createSSHUploadProgressReporter("sftp", uploadLabel, totalBytes);
    // reportProgress 同时喂 reporter 与 onProgress：两条消费链路共享同一计数，避免 UI 与日志进度不一致。
    const reportProgress = (uploadedBytes: number, force: boolean) => {
      // reporter 自带节流：每 chunk 都调用也只在阈值或时间窗到期时打印，这里不做二次限流。
      progressReporter(uploadedBytes, force);
      // onProgress 的 totalBytes 兜底 0：null 会让 UI 算出 NaN 百分比，0 至少能显示为未知总量。
      options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
    };

    // 包一层 Promise 而不是 await client.sftp：sftp 只有回调形态，且回调里还要挂多个流事件。
    return new Promise((resolve, reject) => {
      // 每次上传新建 sftp 会话而不复用：会话级失败要能独立降级，复用会把一次失败污染后续上传。
      this.client.sftp((err, sftp) => {
        // 打开会话失败归为 sftp-session：这是能触发 exec 降级的入口之一，分类错了整条回退链就断了。
        if (err) {
          // session/write 失败会由 upload() 统一降级并记录一次 warn；这里若先记 error，
          // 同一个可恢复事件会同时出现 error + warn，误导为部署失败。
          reject(markSSHUploadFailure(err, "sftp-session", "Failed to open SFTP session"));
          // reject 后立即返回：sftp 为 undefined 时继续走 createWriteStream 会抛出第二次异常。
          return;
        }
        // 起传日志放在会话打开之后：只有拿到 sftp 才说明通道可用，提前打印会在降级场景留下误导性的 started 行。
        console.log(
          `[ssh] upload: started via sftp for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
        );

        // 本地读流按需创建：文件不存在时错误在 readStream 的 error 事件里出现，归为 local-read 而不是 sftp-write。
        const readStream = createReadStream(localPath);
        // 远端写流用 createWriteStream 覆盖写：目标已存在时直接截断，符合整份替换的上传语义。
        const writeStream = sftp.createWriteStream(resolvedRemotePath);
        // 计数从 0 起算且以本方法为作用域：降级到 exec 后重新计数，不复用 SFTP 已传字节。
        let transferredBytes = 0;
        // settled 覆盖三条出口：成功、失败与取消先到者生效，后到的流事件一律静默（INV-16）。
        let settled = false;
        // 该标记只在失败出口置位：destroy 会连带触发 error，不压住就会一条失败打出多条日志（INV-17）。
        let suppressFollowupStreamErrors = false;

        // [资源] 成功出口先摘掉 abort 监听再 end 会话，顺序反了会在 end 期间触发取消回调造成二次 settle。
        // 强制 flush 一次进度，保证 UI 收到 100%，不依赖最后一次 data 事件是否被节流。
        // sftp.end 放在这里而不是 writeStream close 回调外部，确保任何出口只关一次会话。
        const resolveOnce = () => {
          // 成功出口也查 settled：取消先到时 writeStream 仍可能 close，重复 resolve 会掩盖真实失败原因。
          if (settled) {
            // 直接返回不重复清理 sftp：会话的 end 归首个到位的出口，重复调用会二次关闭同一句柄。
            return;
          }
          // 置位发生在摘监听之前：后续 error 回调看到的是已完成态，而不是半清理状态。
          settled = true;
          // 成功也要摘 abort 监听：signal 生命周期可能长于一次上传，残留回调会在下次取消时误触发。
          options?.signal?.removeEventListener("abort", abortOnce);
          // force 刷新一次进度：最后一次 data 可能被节流吞掉，不收尾刷新会让进度条停在 99%。
          reportProgress(transferredBytes, true);
          // 完成日志带 uploadLabel：与 started 行按标签配对，能看出这次上传走的是 SFTP 而非降级。
          console.log(`[ssh] upload: completed via sftp for ${uploadLabel}`);
          // end 会话放在 resolve 之前：先 resolve 会让调用方在会话尚未释放时就开始下一次上传。
          sftp.end();
          // resolve 不带值：成功只表达整份写入完成，字节数由 onProgress 侧记录。
          resolve();
        };

        // [资源] 失败时必须 unpipe 并 destroy 两端流：否则本地读流会继续读到 100%，刷出虚假进度。
        // suppressFollowupStreamErrors 用于吞掉 destroy 引发的二次 error，避免一次失败打出多条日志。
        // 不要给 destroy 传原始 error，错误对象会再次触发 error 事件，形成重复上报。
        // settled 闸门同时覆盖取消、本地读失败与远端写失败，先到者决定失败分类。
        const rejectOnce = (error: unknown, kind: SSHUploadFailureKind, message: string) => {
          // 失败出口同样以 settled 去重：取消与写失败可能同时到达，先到者的分类决定最终 uploadFailureKind。
          if (settled) {
            // 静默返回不重复清理：首个失败出口已 destroy 两端流并 end 会话，再来一次会触发二次 error。
            return;
          }
          // 先置位再清理：清理过程本身可能同步抛出，置位保证后续事件不会再进入本函数。
          settled = true;
          // 失败出口必须摘 abort 监听：否则 destroy 引发的后续 abort 回调会再 reject 一次。
          options?.signal?.removeEventListener("abort", abortOnce);
          // 在 destroy 之前置位：destroy 会同步派发 error，晚一步设置就压不住这次回调（INV-17）。
          suppressFollowupStreamErrors = true;
          // SFTP 失败后如果不立刻停掉本地 read stream，它仍会继续把文件读到 100%，
          // UI 就会在已经切到 exec pipe 之后还刷出一串虚假的 `[sftp] upload progress`。
          // 这里在失败瞬间主动停掉两端 stream，保证第一种上传方式的进度日志立即停止。
          // 注意不要把原始 error 再次喂给 destroy，否则清理路径本身会再冒出一轮重复 error 日志。
          readStream.unpipe(writeStream);
          // 先停本地读流：它是虚假进度的来源，不 destroy 会继续读到 100% 并刷出 sftp progress 行。
          readStream.destroy();
          // 断言写流可选 destroy：ssh2 的 WriteStream 类型声明里没有 destroy，运行时却有，必须运行时判断。
          const destroyableWriteStream = writeStream as NodeJS.WritableStream & {
            // destroy 签名允许无参：传入原始 error 会再触发一次 error 事件，所以本模块只调无参版本（INV-17）。
            destroy?: (error?: Error) => void;
          };
          // 能力检测而不是直接调用：旧版 ssh2 的写流没有 destroy，直接调会抛 TypeError 并掩盖原始失败。
          if (typeof destroyableWriteStream.destroy === "function") {
            // 不传 error：清理路径只需要关闭流，失败原因已由 markSSHUploadFailure 带出。
            destroyableWriteStream.destroy();
          }
          // 失败也要 end 会话：残留的 sftp 会话会占住连接，后续上传再开会话时可能被对端拒绝。
          sftp.end();
          // markSSHUploadFailure 在这里统一打标：kind 由调用点按失败阶段给出，而不是从错误文本推断。
          reject(markSSHUploadFailure(error, kind, message));
        };

        // [失败路径] 取消归类为 aborted 而不会进入 exec 降级：用户取消不是传输能力问题，重传只会白花带宽。
        // abortOnce 以一次性方式注册并在所有出口摘除，避免同一次上传残留多个回调。
        const abortOnce = () => {
          // 取消归为 aborted 而非 sftp-session：用户取消不具备可恢复性，进入降级等于无视取消按钮（INV-13）。
          rejectOnce(createUploadAbortError(), "aborted", "Remote upload canceled");
        };
        // 注册监听前先查一次已取消态：signal 可能在建会话期间就已 abort，只挂监听会永远收不到事件。
        if (options?.signal?.aborted) {
          // 直接走统一失败出口：取消与写失败共用清理路径，避免两套资源释放代码分叉。
          abortOnce();
          // 返回前不再注册监听：已取消的上传不必留下 abort 回调，否则 signal 复用时会重复触发。
          return;
        }
        // once=true 与手动摘除双保险：once 防止重复触发，手动摘除保证成功出口不残留引用。
        options?.signal?.addEventListener("abort", abortOnce, { once: true });

        // 进度以本地读出的字节为准：SFTP 的写确认粒度太粗，用读侧计数才能让进度条连续变化。
        readStream.on("data", (chunk: Buffer) => {
          // data 回调也要查 settled：destroy 之后的尾部 chunk 仍会派发，不查会把已结束的上传算成新进度。
          if (settled) {
            // 丢弃而非累加：失败后继续累加会让最终 force 进度报出超过实际写入量的数字。
            return;
          }
          // 累加 Buffer 长度而非字符串长度：二进制内容按字节计，按字符会在多字节内容上少算。
          transferredBytes += chunk.length;
          // 非强制刷新：节流交给 reporter，每个 chunk 都强制会打爆日志。
          reportProgress(transferredBytes, false);
        });
        // 以写流 close 作为成功信号：它表示远端已确认写完，比本地 pipe 完成更可靠。
        writeStream.on("close", resolveOnce);
        // 写流错误归为 sftp-write：它代表远端拒写，也是触发 exec 降级的第二个依据。
        writeStream.on("error", (error: Error) => {
          // 两个闸门都要查：settled 覆盖已收尾，suppress 覆盖清理过程中被 destroy 激发的连带错误。
          if (settled || suppressFollowupStreamErrors) {
            // 静默吞掉：清理路径的 error 已在首个失败出口上报，再报一次会让用户看到重复失败。
            return;
          }
          // message 带 resolvedRemotePath：远端拒写时路径是唯一能定位问题的信息，不能只留底层报错。
          rejectOnce(error, "sftp-write", `Failed to write ${resolvedRemotePath} over SFTP`);
        });
        // 本地读错误单独监听：它属于 local-read，不触发降级，因为换传输方式也读不到本地文件。
        readStream.on("error", (error: Error) => {
          // 与写流同款闸门：两端流可能因同一次 destroy 各报一次，先到者已决定分类。
          if (settled || suppressFollowupStreamErrors) {
            // 返回不 reject：错误归类已由首个出口完成，这里只负责吸收重复事件。
            return;
          }
          // 本地读失败用 error 级别：它不可恢复且与网络无关，warn 会让人误以为重试能好。
          console.error(
            `[ssh] upload: local read failed for ${uploadLabel}: ${formatSSHUploadError(error)}`,
          );
          // 归类为 local-read：shouldFallbackToExecUpload 对它返回 false，避免为本地问题重传整份文件（INV-12）。
          rejectOnce(error, "local-read", `Failed to read local file ${localPath}`);
        });
        // pipe 放在所有监听注册之后：先 pipe 会让首个 data 在 settled 闸门就绪前就被消费。
        readStream.pipe(writeStream);
      });
    });
  }

  // uploadViaExec 是降级通道：只在 SFTP 能力缺失时进入，因此失败不再打 kind 而直接 reject 给调用方。
  private async uploadViaExec(
    // 与 SFTP 路径同参数名：两条上传路径必须可互换，upload 的 catch 才能不改代码就完成切换。
    localPath: string,
    // 同样要求已是绝对路径：远端 mkdir 与 cat 都基于它定位，二次展开 HOME 会把文件写到错误目录。
    resolvedRemotePath: string,
    // options 只用于取消与进度：exec 通道没有会话级降级，signal 在这里是唯一的提前退出手段。
    options?: RemoteUploadOptions,
  ): Promise<void> {
    // 标签格式与 SFTP 一致：同一文件的两段上传在日志里能用同一个 label 串起来（INV-14）。
    const uploadLabel = formatSSHUploadLabel(resolvedRemotePath);
    // 这里重新读一次本地大小：降级发生在 SFTP 失败之后，文件可能已被并发修改。
    const totalBytes = await readLocalFileSize(localPath);
    // 通道名改成 exec：与 SFTP 段的进度分开打印，避免两段日志混成一条时间线。
    const progressReporter = createSSHUploadProgressReporter("exec", uploadLabel, totalBytes);
    // 两个消费链路共享计数：exec 段同样要驱动 onProgress，否则降级后 UI 进度条会停住（INV-15）。
    const reportProgress = (uploadedBytes: number, force: boolean) => {
      // reporter 内部按字节阈值节流：管道写入频率远高于 UI 刷新率，不节流会拖慢传输。
      progressReporter(uploadedBytes, force);
      // totalBytes 兜底 0：与 SFTP 段保持一致，避免同一文件在两段里显示不同的总量。
      options?.onProgress?.({ uploadedBytes, totalBytes: totalBytes ?? 0 });
    };
    // 进入 exec 前再查一次取消：降级决策可能耗时，期间用户可能已经取消。
    throwIfUploadAborted(options?.signal);
    // 用 posix.dirname 而非 node:path：远端是 POSIX 路径，Windows 本地的 path 逻辑会给出反斜杠。
    const parentDir = posix.dirname(resolvedRemotePath);
    // mkdir -p 与 cat 用 && 串联：目录创建失败必须让整条命令失败，否则 cat 会写到不存在的路径（INV-11）。
    const command = `mkdir -p ${quotePosixShellArg(parentDir)} && cat > ${quotePosixShellArg(resolvedRemotePath)}`;
    // started 日志在 exec 之前打印：命令一旦发出，就无法再区分没连上还是连上但没执行。
    console.log(
      `[ssh] upload: started via exec pipe for ${uploadLabel} (${localPath} -> ${resolvedRemotePath})`,
    );
    // exec 返回 channel 三件套：stdin 承接本地内容，onClose 给出远端退出码（INV-18）。
    const stream = await this.exec(command);

    // 单独包一层 Promise：exec 只负责开通道，写入是否成功要看 onClose 的退出码。
    await new Promise<void>((resolve, reject) => {
      // 本地读流在这里创建：与 SFTP 段一致，读错误归为本地问题而不是传输能力缺失。
      const readStream = createReadStream(localPath);
      // 直接用 channel.stdin：不使用 stream.stdout，因为上传只需要把字节送进远端 cat。
      const stdin = stream.stdin;
      // 计数只统计本地读出的字节：远端 cat 的落盘量无法从 channel 侧观测。
      let transferredBytes = 0;
      // settled 同时覆盖失败与 onClose：先到者决定结果，避免成功与失败各 settle 一次。
      let settled = false;

      // [资源] 失败时同时销毁本地读流与远端 stdin，否则管道一端还在写会拖住 close 事件。
      // 没有 destroy 能力时退化为 stdin.end()，让远端 cat 收到 EOF 而不是一直挂住。
      // 摘除 abort 监听放在最前，保证后续 destroy 触发的 error 不会再走取消分支。
      const finishWithError = (error: Error) => {
        // 失败出口查 settled：取消之后 onClose 迟到时会带非零码，不拦会把取消误报成退出码失败。
        if (settled) {
          // 直接返回不清理：资源已由首个失败出口释放，重复 destroy 会再触发一轮流错误。
          return;
        }
        // 置位在任何清理动作之前：清理中的 destroy 会同步派发 error，必须先关闸。
        settled = true;
        // 失败出口摘 abort 监听：否则 stdin.destroy 激发的 error 会让取消分支再走一次。
        options?.signal?.removeEventListener("abort", abortOnce);
        // 停本地读流防止继续 pipe：不停的话 chunk 会持续写进已 destroy 的 stdin。
        readStream.destroy();
        // stdin 断言可选 destroy：ssh2 的 Channel 类型声明没有该成员，运行时行为也随版本不同。
        const destroyableStdin = stdin as NodeJS.WritableStream & {
          // destroy 允许带 reason：这里传 error 是有意的，远端 stdin 需要知道因何中断。
          destroy?: (reason?: Error) => void;
        };
        // 能力检测优先：有 destroy 就立即中断，没有则退化为 end 让远端 cat 收到 EOF。
        if (typeof destroyableStdin.destroy === "function") {
          // 传 error 而不是无参：exec 段不经过 markSSHUploadFailure，失败原因只能靠这条路径传下去。
          destroyableStdin.destroy(error);
        } else {
          // 退化路径用 end：至少让远端 cat 读到 EOF 并退出，避免 channel 一直挂到超时。
          stdin.end();
        }
        // reject 原始 error：exec 段的失败不参与降级判定，保持原始身份便于上层识别取消。
        reject(error);
      };

      // abortOnce 只做转调：取消与其他失败共用 finishWithError，资源释放逻辑不能拆成两份。
      const abortOnce = () => finishWithError(createUploadAbortError());
      // 注册前查已取消态：signal 可能在 exec 建通道期间 abort，只靠监听会漏掉这次取消。
      if (options?.signal?.aborted) {
        // 直接走失败出口：此时 readStream 尚未创建，finishWithError 的 destroy 需容忍空操作。
        abortOnce();
        // 返回不再注册 abort 监听：已取消的上传不该留下任何回调，否则同一 signal 会重复触发。
        return;
      }
      // once 加手动摘除：once 防止重复触发，摘除保证成功出口不留下对 signal 的引用。
      options?.signal?.addEventListener("abort", abortOnce, { once: true });

      // 读流错误直接进失败出口：本地读失败与远端管道失败在这里共用同一条 reject 路径。
      readStream.on("error", (error) => finishWithError(error));
      // data 监听只为进度：真正的数据传输由 pipe 完成，这里不干预流向。
      readStream.on("data", (chunk: Buffer) => {
        // 累加本地读出字节：与 SFTP 段同口径，两段进度能在 UI 上衔接。
        transferredBytes += chunk.length;
        // 非强制刷新：节流在 reporter 内，逐 chunk 强制会淹没日志（INV-15）。
        reportProgress(transferredBytes, false);
      });
      // stdin 错误必须单独监听：远端 cat 提前退出时写端会报 EPIPE，漏掉就是未捕获异常。
      stdin.on("error", (error: Error) => finishWithError(error));
      // pipe 在所有监听之后：先 pipe 会让首个 chunk 在 settled 闸门就绪前写出。
      readStream.pipe(stdin);
      // [契约] 以 channel 退出码作为上传成败的唯一依据：stdin 写完不代表远端 cat 已经落盘。
      // settled 分支吸收取消或本地错误之后的迟到 close，避免覆盖真实失败原因。
      // 成功前再 flush 一次进度，与 SFTP 路径保持同一套收尾语义。
      stream.onClose((code) => {
        // onClose 也要查 settled：取消后远端可能仍正常退出，不拦会把取消判成成功。
        if (settled) {
          // 静默返回：结果已由失败出口给出，重复 settle 会掩盖真实原因。
          return;
        }
        // 在判定退出码前关闸：后面的 reportProgress 与两条日志都只执行一次。
        settled = true;
        // 成功出口摘 abort 监听：signal 生命周期长于上传，残留回调会在下次取消时误触发。
        options?.signal?.removeEventListener("abort", abortOnce);
        // 强制刷新到 100%：管道写完到 onClose 之间可能没有新的 data，不刷会停在中间值。
        reportProgress(transferredBytes, true);
        // 以退出码判成败：stdin 写完只代表字节送出，远端 cat 写盘失败时退出码非零（INV-18）。
        if (code !== 0) {
          // 失败日志带 uploadLabel 与 code：这两个字段是区分本地取消与远端写失败的唯一线索。
          console.error(`[ssh] upload: exec pipe failed for ${uploadLabel}: exit code ${code}`);
          // 文案带 exit code 而不带 stderr：exec 通道的 stderr 归 channel，本层拿不到已拼好的文本。
          reject(new Error(`SSH exec upload failed with exit code ${code}`));
          // reject 后立即返回：不再执行下面的完成日志，避免同一次上传同时出现失败与完成两行。
          return;
        }
        // 完成日志在 resolve 之前：日志顺序与调用方观察到的顺序一致，便于对齐时间线。
        console.log(`[ssh] upload: completed via exec pipe for ${uploadLabel}`);
        // resolve 不带值：字节数已通过 onProgress 交付，返回值没有额外语义。
        resolve();
      });
    });
  }

  // resolveRemotePath 是唯一入口：upload、readFile 与 exists 都必须经它，路径语义才不会分叉。
  private async resolveRemotePath(remotePath: string): Promise<string> {
    // HOME 只在此处取一次：缓存由 resolveHomeDir 负责，本函数不订阅断连事件。
    const homeDir = await this.resolveHomeDir();
    // 展开交给 resolvePosixHomePath：~ 与相对路径的规则集中在一处，避免各调用点各写一套。
    return resolvePosixHomePath(remotePath, homeDir);
  }

  // [资源] dispose 单向且幂等：重复调用直接返回，避免二次 end 触发额外事件。
  // 只显式移除 close/end 监听，而 error 监听留给 onClientError 按 disposed 自行判断，作为迟到事件的吸收点。
  // 断开事件源在这里释放，dispose 之后不应再有消费者期待断连通知。
  dispose(): void {
    // 幂等返回：dispose 可能被 upload 失败与宿主退出两处同时调用，第二次不得再 end 一次。
    if (this.disposed) {
      // 静默返回：重复 dispose 不是错误，抛错会让宿主的清理流程中断。
      return;
    }
    // 置位在移除监听之前：中途有并发方法进入时，assertNotDisposed 会立即拒绝（INV-01）。
    this.disposed = true;
    // 首次握手失败后，ssh2 可能在 socket end/close 之后继续发出 error。
    // dispose 后保留 onClientError 作为 no-op sink，不能按 end/close 事件时序提前移除，
    // 否则迟到事件会逃逸为 uncaughtException，让共享 Window Host 连带退出其它 workspace。
    // client 只由当前 backend 持有，监听器会随 client 一起回收；此处优先保证退役阶段不崩溃。
    this.client.off("close", this.onClientClose);
    // 只摘 close 与 end：onClientError 必须常驻，它是 disposed 之后迟到 error 的唯一吸收点（INV-05）。
    this.client.off("end", this.onClientEnd);
    // [资源] end 是优雅关闭：等待已打开 channel 收尾，不主动 destroy 正在执行的 exec 或 SFTP 会话。
    // 因此长命令可能在 dispose 后继续跑完；需要立即中断的场景必须由调用方关闭自己的 channel。
    this.client.end();
    // 连接态在 end 之后清空：即使 socket 仍在收尾，也不能再让新调用认为可以发命令（INV-01）。
    this.connected = false;
    // 最后释放事件源：先 dispose 会让 end 触发的 close 走空订阅，断连通知直接丢失。
    this.disconnectEmitter.dispose();
  }
}
