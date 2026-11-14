/* eslint-disable max-lines -- Source Server transport 在同一适配器内汇合安装、daemon、channel 与 target 生命周期，继续拆分会割裂取消边界。 */
// Source Server 传输适配器：把 ssh / wsl / docker 三类远端目标收敛到同一套 probe、
// installOrUpdate、ensureDaemon、openChannel、exec 契约，供 Source 装配、重连与手机远控复用。
// 不负责：远端 CLI 自身语义、daemon 内部状态机、上层重试预算与界面展示，这些由各自模块持有。
//
// 边界：本文件只做命令拼装、逐行输出解析与错误归一，远端事实一律以 CLI 的 --json 输出为准。
// 每个 target 只拥有一条 backend，由 backends 与 backendPromises 两个容器共同持有，增删必须成对。
// 所有远端写入都落在 Server root 的私有 staging 内，清理由 EXIT trap 与陈旧回收双保险覆盖。
//
// INV-01 断言：每个目标只存在一条 backend —— 守住它的位置：getBackend 的 backends 缓存 —— 改错故障：并发 probe 与安装各自建连，握手翻倍并触发远端限流
// INV-02 断言：缓存的 Promise 必须在 await 之前写入 —— 守住它的位置：getBackend 的写入顺序 —— 改错故障：并发调用重复建连，daemon 端口被重复绑定
// INV-03 断言：失败的 Promise 不会被自动剔除 —— 守住它的位置：getBackend 缓存 —— 改错故障：同一目标后续全部立即拒错，只能靠 cancel 摘除后重试
// INV-04 断言：取消只作用于本协议的目标 —— 守住它的位置：cancel 的 target.kind 判断 —— 改错故障：误删其它协议的 transport，正常会话突然断流
// INV-05 断言：释放后集合必须清空 —— 守住它的位置：dispose —— 改错故障：已释放的 backend 仍被强引用，长驻进程内存缓慢上涨
// INV-06 断言：staging 目录名带进程号与毫秒时间戳 —— 守住它的位置：installRelease 的 operationId —— 改错故障：并发安装互相删除对方的半包，解压莫名失败
// INV-07 断言：陈旧回收只处理纯数字后缀且超三十分钟的目录 —— 守住它的位置：cleanupStaleBootstrapRootsCommand —— 改错故障：误删活跃安装的 staging，解压中途文件消失
// INV-08 断言：archive 与解压目录同处 Server root —— 守住它的位置：command 里的 remoteArchiveShell 与 bootstrapDirShell —— 改错故障：/tmp 为 noexec 或容量过小，上传到九成时报 EPIPE
// INV-09 断言：清理必须由 EXIT trap 兜底 —— 守住它的位置：command 的 trap 行 —— 改错故障：guard 非零退出时 && rm 永不执行，staging 永久残留
// INV-10 断言：上传与下载失败先清理再抛原错 —— 守住它的位置：两处 catch 与 exitCode 分支 —— 改错故障：残留数十 MiB 半包，且清理异常掩盖真实根因
// INV-11 断言：错误归一必须携带最远 phase —— 守住它的位置：installOrUpdate 的 phase 变量 —— 改错故障：上传中断被展示成预检阶段的设备环境不满足
// INV-12 断言：只有环境检查异常才归为 preflight —— 守住它的位置：probe 的 catch —— 改错故障：握手超时被报成安装条件不足，用户按错误提示排查
// INV-13 断言：CLI 结构化错误在 stdout 而非 stderr —— 守住它的位置：ensureDaemon 与 installRelease 的错误解析 —— 改错故障：SQLite warning 覆盖真实失败原因
// INV-14 断言：成功判定要求 applied 为 true —— 守住它的位置：installRelease 末尾校验 —— 改错故障：只校验退出码会把未落盘的版本当成安装成功
// INV-15 断言：ready 状态只复用端口，token 每次重读 —— 守住它的位置：ensureDaemon —— 改错故障：缓存 token 在 daemon 重启后鉴权失败，通道建不起来
// INV-16 断言：返回的 Duplex 所有权交给调用方 —— 守住它的位置：openChannel —— 改错故障：适配器不关闭流，重复调用泄漏远端 channel 与进程
import { Duplex } from "node:stream";
import {
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  normalizeRemoteAssetInstallMode,
  sourceServerInstallProgressSchema,
  type SourceServerInstallProgress,
  type PublicZCodeErrorCode,
  type RemoteTarget,
} from "@zcode/shared";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { createRemoteBackend } from "@zcode/server/remote/create-backend.js";
import { detectRemoteTarTool } from "@zcode/server/remote/remoteAssetPreflight.js";
import {
  probeSourceServer,
  SourceServerProbeEnvironmentError,
} from "@zcode/server/source-server/sourceServerProbe.js";
import { buildSourceServerReleaseDownloadCommand } from "@zcode/server/source-server/sourceServerReleaseDownload.js";
import {
  collectCommand,
  duplexFromStdio,
  quoteShellArg,
  readLastJsonLine,
  readStructuredCommandError,
  throwIfAborted,
  type RemoteExecResult,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export type { RemoteExecResult } from "@zcode/server/source-server/sourceServerTransportRuntime.js";

export interface SourceServerProbeResult {
  platform: string;
  arch: string;
  installed: boolean;
  installPath?: string;
  installedVersion?: string;
  installedArchiveSha256?: string;
  daemonStatus?: Record<string, unknown> & { state: string; port?: number };
}

export interface SourceServerProbeOptions {
  includeReleaseIdentity?: boolean;
}

export interface SourceServerIngressInfo {
  port: number;
  ingressToken: string;
}

export interface ServerReleaseAsset {
  localArchivePath?: string;
  target: string;
  version: string;
  sha256: string;
  sizeBytes: number;
  urls: string[];
}

export interface TransportContext {
  signal?: AbortSignal;
  onLog?: (event: {
    phase: string;
    message: string;
    progress?: number;
    level?: "info" | "warn" | "error";
  }) => void;
}

export interface SourceServerInstallOrUpdateOptions {
  force?: boolean;
}

export interface SourceServerEnsureDaemonOptions {
  observedStatus?: SourceServerProbeResult["daemonStatus"];
}

export class SourceServerTransportOperationError extends Error {
  public constructor(
    message: string,
    public readonly code: PublicZCodeErrorCode,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "SourceServerTransportOperationError";
  }
}

export type SourceServerFileTransfer = Pick<IRemoteBackend, "exec" | "upload">;

export interface SourceServerTransportAdapter {
  readonly kind: "ssh" | "wsl" | "docker";
  /** Host 附件暂存复用当前 target 的 transport，不创建另一条远程连接。 */
  // [契约] 附件暂存必须复用当前 target 的 transport，不得另建一条远程连接
  // 否则手机远控传附件会多一次握手，并在弱网下与主链路争抢同一账号的并发额度
  // 返回的 exec 与 upload 是惰性闭包，backend 的失败要留到首次调用时才暴露
  createFileTransfer(target: RemoteTarget): SourceServerFileTransfer;
  /** 取消单个连接目标的底层 transport，防止超时 flight 迟到注册为在线 Source。 */
  cancel?(target: RemoteTarget): void;
  probe(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerProbeOptions,
  ): Promise<SourceServerProbeResult>;
  installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options?: SourceServerInstallOrUpdateOptions,
  ): Promise<void>;
  ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options?: SourceServerEnsureDaemonOptions,
  ): Promise<SourceServerIngressInfo>;
  openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex>;
  exec(target: RemoteTarget, argv: string[], context: TransportContext): Promise<RemoteExecResult>;
  dispose?(): void;
}

export interface CreateSourceServerTransportAdapterOptions {
  createBackend?: (target: RemoteTarget) => Promise<IRemoteBackend>;
}

// 两种写法分工固定：READ_PATH 交给 readFile 使用，不带引号也不做 shell 展开
// SHELL 常量专用于命令拼接，必须保留双引号，否则家目录含空格时整条命令会被拆词
// 只改其一而不同步另一处，症状是安装成功但读取 ingress token 时失败
const SERVER_ROOT_READ_PATH = "~/.zcode/server";
const SERVER_ROOT_SHELL = '"$HOME/.zcode/server"';
const SERVER_BIN_SHELL = '"$HOME/.zcode/server/bin/zcode"';
const STALE_BOOTSTRAP_AGE_MS = 30 * 60 * 1_000;
const INSTALL_PROGRESS_MESSAGES: Record<SourceServerInstallProgress["phase"], string> = {
  "verify-archive": "Verifying Source Server archive",
  extract: "Extracting Source Server files",
  verify: "Verifying Source Server files",
  restart: "Restarting Source Server",
};

type DirectChannelBackend = IRemoteBackend & {
  openDirectTcpChannel?: (port: number) => Promise<Duplex>;
};

class BackendSourceServerTransportAdapter implements SourceServerTransportAdapter {
  // [并发] WeakMap 以 target 对象身份作键，同一目标的 probe、安装与 ensureDaemon 共用同一条连接
  // 缓存里存 Promise 而非实例：在 await 之前写入，第二个调用者才能拿到同一个在建连接
  // [资源] backendPromises 只为 dispose 提供可枚举集合，WeakMap 无法遍历
  // 两处增删必须成对，漏删一处会让 dispose 漏释放或重复释放
  private readonly backends = new WeakMap<object, Promise<IRemoteBackend>>();
  private readonly backendPromises = new Set<Promise<IRemoteBackend>>();

  public constructor(
    public readonly kind: "ssh" | "wsl" | "docker",
    private readonly createBackend: (target: RemoteTarget) => Promise<IRemoteBackend>,
  ) {}

  // [契约] 这里只暴露 exec 与 upload 两个原语，不代理 channel 与 daemon 生命周期
  // 闭包在调用时才 await backend，断开后的错误落在具体上传动作上而非装配阶段
  // 若改成提前 await，接口会变成可能阻塞的异步装配，破坏上层既有调用顺序
  public createFileTransfer(target: RemoteTarget): SourceServerFileTransfer {
    // R3 全转发遗漏了 desktop localPath 的跨机边界；只复用已有 backend 的文件原语。
    const backend = this.getBackend(target);
    return {
      exec: async (command) => (await backend).exec(command),
      upload: async (localPath, remotePath, options) =>
        (await backend).upload(localPath, remotePath, options),
    };
  }

  public async probe(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerProbeOptions = {},
  ): Promise<SourceServerProbeResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    try {
      // [失败路径] 预检失败与传输失败必须分开归类，只有远端环境检查异常才允许标 preflight
      // 握手中断、握手超时这类识别不出的失败保持 undefined，交给归一化函数归入未知
      // 否则断线恢复耗尽预算时，横幅会把网络问题报成设备环境不满足安装要求
      return await probeSourceServer(backend, context, options);
    } catch (error) {
      // Bug 原因：catch 对所有失败都套 preflight 阶段兜底，握手超时、握手前断开等未识别的
      // 传输失败被报成“设备环境不满足安装要求”；断线恢复耗尽预算时横幅也沿用该误报。
      // 只有远端环境检查本身失败才是预检失败，传输失败识别不了就归入未知。
      const failure = normalizeRemoteConnectionError(
        error,
        error instanceof SourceServerProbeEnvironmentError ? "preflight" : undefined,
      );
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  // phase 记录的是已上报的最远阶段，onLog 包一层只为截获这个值
  // [失败路径] 归一化必须带最远 phase，否则上传中途断线会被报成预检阶段的设备环境问题
  // 抛错时保留原 Error 实例并挂上归一化字段，堆栈与取消语义不能被替换掉
  public async installOrUpdate(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions = {},
  ): Promise<void> {
    let phase = "preflight";
    try {
      await this.installRelease(
        target,
        release,
        {
          ...context,
          onLog: (event) => {
            phase = event.phase;
            context.onLog?.(event);
          },
        },
        options,
      );
    } catch (error) {
      const failure = normalizeRemoteConnectionError(error, phase);
      throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
    }
  }

  private async installRelease(
    target: RemoteTarget,
    release: ServerReleaseAsset,
    context: TransportContext,
    options: SourceServerInstallOrUpdateOptions,
  ): Promise<void> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    // [并发] operationId 由进程号与毫秒时间戳拼成，同一进程内的并发安装不会共用 staging
    // 目录名后缀还兼作陈旧判定依据，必须是纯数字，回收脚本靠它计算年龄
    // 改成随机串会同时破坏并发隔离与三十分钟回收这两条逻辑
    const operationId = `${process.pid}-${Date.now()}`;
    const bootstrapRootShell = `${SERVER_ROOT_SHELL}/.bootstrap-${operationId}`;
    const bootstrapDirShell = `${bootstrapRootShell}/extract`;
    const remoteArchive = `~/.zcode/server/.bootstrap-${operationId}/zcode-server.tar.gz`;
    const remoteArchiveShell = `${bootstrapRootShell}/zcode-server.tar.gz`;
    const cleanupCommand = `rm -rf ${bootstrapRootShell}`;
    // [资源] 陈旧回收只能由这段纯 shell 完成，JS 侧在 Controller 被强杀时没有执行机会
    // 只删带纯数字后缀且超过三十分钟的私有 staging，非数字后缀与新目录一律跳过
    // 放宽条件会误删其它 Controller 正在写入的目录，表现为解压中途文件凭空消失
    const cleanupStaleBootstrapRootsCommand =
      "now_ms=$(($(date +%s) * 1000)); " +
      `for candidate in ${SERVER_ROOT_SHELL}/.bootstrap-*; do ` +
      '[ -d "$candidate" ] || continue; ' +
      "name=${candidate##*/}; " +
      "created_ms=${name##*-}; " +
      'case "$created_ms" in ""|*[!0-9]*) continue ;; esac; ' +
      "age_ms=$((now_ms - created_ms)); " +
      `[ "$age_ms" -le ${STALE_BOOTSTRAP_AGE_MS} ] || rm -rf -- "$candidate"; ` +
      "done";
    // [失败路径] 回收、删除、创建串在一条命令里，任一步失败都按整体失败处理
    // 退出码非零时优先回显 stderr，为空才用兜底文案，避免把空错误抛给用户
    // 这一步必须先于任何写入动作，否则后续上传会落进刚被清掉的目录
    const prepareBootstrapRoot = async (): Promise<void> => {
      const result = await collectCommand(
        await backend.exec(
          // Bug 原因：Controller 在 SFTP/upload 中被强制退出时，JS catch 和远端 EXIT trap
          // 都没有机会运行，Server root 会永久积累数十 MiB 的半包。下次安装只回收带合法
          // epoch 后缀且超过 30 分钟的私有 staging；新鲜并发操作和未知目录一律保留。
          `${cleanupStaleBootstrapRootsCommand} && rm -rf ${bootstrapRootShell} && mkdir -p ${bootstrapRootShell}`,
        ),
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Source Server bootstrap staging failed");
      }
    };
    // Bug 原因：R3 切换完整 archive 后曾无条件走 Desktop upload，SSH 表单保存的
    // remote-download 变成无效选项。这里只分流 archive 获取位置，后续仍汇合到同一 installer。
    // [权衡] 仅当目标为 ssh、安装模式为 remote-download 且无本地制品时才走远端直下
    // 显式本地路径的优先级高于 Profile 偏好，开发态产物不能被 CDN 同版本 release 顶替
    // 两条分支只分流 archive 的获取位置，之后的解压与 installer 命令完全一致
    const remoteDownload =
      target.kind === "ssh" &&
      normalizeRemoteAssetInstallMode(target.assetInstallMode) === "remote-download" &&
      // Bug 原因：开发态 resolver 已固定本轮本地 archive；若仍按 Profile 偏好直下，
      // bootstrap 产物会被 CDN 同版本 release 替换。显式本地路径拥有更高的制品来源优先级。
      !release.localArchivePath;
    // 下载命令依赖 staging 已存在，prepareBootstrapRoot 必须排在远端下载之前
    // 进度只按 download progress 前缀过滤上报，其余输出丢弃以免刷屏
    // [资源] 下载失败要先删 staging 再抛错，否则半包会留在 Server root 里
    if (remoteDownload) {
      context.onLog?.({
        phase: "download",
        message: `Downloading Source Server ${release.version} on remote host`,
      });
      const downloadCommand = await buildSourceServerReleaseDownloadCommand({
        backend,
        release,
        remoteArchive,
        onLog: (message) => context.onLog?.({ phase: "download", message }),
      });
      await prepareBootstrapRoot();
      const downloadResult = await collectCommand(await backend.exec(downloadCommand), (line) => {
        if (/^download progress:/iu.test(line.trim()))
          context.onLog?.({ phase: "download", message: line.trim() });
      });
      // [失败路径] 清理走 best-effort，catch 吞掉清理自身抛出的异常
      // 清理失败不能覆盖真正的下载失败原因，否则用户只看到 rm 的报错
      // 抛错内容优先取 stderr，为空才退回固定文案
      if (downloadResult.exitCode !== 0) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw new Error(
          downloadResult.stderr.trim() || "Remote Source Server archive download failed",
        );
      }
    } else {
      // 上传前先做 tar 预检，避免整包传完才在解压阶段失败
      // [权衡] 预检多一次远端往返，换来上传前就能判定环境不支持
      // 预检失败提示不能再建议切回同样依赖 tar 的路径，否则形成自相矛盾的建议
      if (!release.localArchivePath) {
        throw new Error("Source Server local archive is unavailable for upload");
      }
      // Bug 原因：本地下载上传路径过去不做 tar preflight，会先传完整 archive，
      // 最后才在远端解压阶段失败；且旧提示错误地建议用户切回同样需要 tar 的本地上传。
      context.onLog?.({
        phase: "preflight",
        message: "Checking remote installation prerequisites",
      });
      await detectRemoteTarTool(backend, {
        log: (message) => context.onLog?.({ phase: "preflight", message: String(message) }),
      });
      await prepareBootstrapRoot();
      context.onLog?.({
        phase: "upload",
        message: `Uploading Source Server ${release.version}`,
      });
      const uploadStartedAt = Date.now();
      try {
        await backend.upload(release.localArchivePath, remoteArchive, {
          signal: context.signal,
          onProgress: ({ uploadedBytes, totalBytes }) =>
            context.onLog?.({
              phase: "upload",
              message: `upload progress: ${(totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0).toFixed(1)}% (${(uploadedBytes / 1048576).toFixed(1)}/${(totalBytes / 1048576).toFixed(1)} MB, ${(uploadedBytes / 1048576 / Math.max(0.001, (Date.now() - uploadStartedAt) / 1000)).toFixed(2)} MB/s)`,
              progress: totalBytes > 0 ? uploadedBytes / totalBytes : 0,
            }),
        });
      // [资源] 上传被取消或被强制中断时同样清理 staging，避免半包长期占据远端磁盘
      // [失败路径] 清理后原样抛出同一个错误对象，保留取消语义与可重试标记
      // 若在这里重包装成新错误，上层就分不清用户取消和真正的上传失败
      } catch (error) {
        await collectCommand(await backend.exec(cleanupCommand)).catch(() => undefined);
        throw error;
      }
    }
    context.onLog?.({ phase: "extract", message: INSTALL_PROGRESS_MESSAGES.extract });
    // [事务] 整条安装是一条 set -eu 的 shell，&& 串联保证任一步失败立即中止
    // EXIT trap 覆盖成功、guard 非零退出、解压失败与信号中断，清理不依赖退出码
    // archive 与解压目录都位于 Server root 的私有 staging，不能回退到 /tmp
    // 非 ssh 目标必须带跳过服务注册的环境变量，否则 bootstrap 会尝试注册不可用的 systemd user service
    const command = [
      "set -eu",
      // Bug 原因：running-task guard 让 update 非零退出后，`&& rm` 永远不会执行，远端
      // archive 与 bootstrap staging 会持续残留。EXIT trap 覆盖成功、guard、解压失败和中断。
      `trap ${quoteShellArg(cleanupCommand)} EXIT`,
      // Bug 原因：安全加固/最小服务器常把 /tmp 设为 noexec 或很小的 tmpfs。过去虽把
      // 解压目录移到 Server root，75MB archive 仍先写 /tmp，容量不足时上传到 90% 才
      // EPIPE。archive 与可执行 bootstrap 必须一起位于同一私有 Server staging root。
      `rm -rf ${bootstrapDirShell}`,
      `mkdir -p ${bootstrapDirShell}`,
      `tar -xzf ${remoteArchiveShell} -C ${bootstrapDirShell} --strip-components=1`,
      // Bug 原因：update 现在会重启完整 daemon；若不把既有 transport 能力边界传给目标
      // bootstrap CLI，WSL/Docker 会在 handoff 时误尝试注册不可用的 systemd user service。
      `${this.kind === "ssh" ? "" : "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "}${bootstrapDirShell}/bin/zcode update --from-archive ${remoteArchiveShell}${options.force ? " --force" : ""} --server-root ${SERVER_ROOT_SHELL} --json --progress`,
    ].join(" && ");
    // 上传完成后命令仍需解压、整树校验和 daemon 换代；必须实时消费阶段，不能等退出才显示。
    // 逐行消费远端输出，非 JSON 行直接忽略，避免日志噪音打断安装流程
    // 只有通过 progress schema 校验的 phase 才允许查表取文案，未知阶段不臆造提示
    // 阶段必须实时上报，等进程退出再显示会让长解压在界面上表现为卡死
    const result = await collectCommand(await backend.exec(command), (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const event = sourceServerInstallProgressSchema.safeParse(value);
      if (event.success) {
        context.onLog?.({ phase: event.data.phase, message: INSTALL_PROGRESS_MESSAGES[event.data.phase] });
      }
    });
    // [失败路径] 结构化错误优先取 stdout 的最后一行 JSON，stderr 仅作兜底
    // 只有公开错误码才转成带码异常，其余继续按普通失败处理
    // 嵌套 try 只为把已转换的异常原样抛回，不能被外层兜底再次覆盖成 stderr 文案
    if (result.exitCode !== 0) {
      try {
        const response = readLastJsonLine(result.stdout);
        if (isPublicZCodeErrorCode(response.code)) {
          throw new SourceServerTransportOperationError(
            typeof response.error === "string" && response.error.trim()
              ? response.error
              : "Source Server archive installation failed",
            response.code,
            typeof response.retryable === "boolean" ? response.retryable : undefined,
          );
        }
      } catch (error) {
        if (error instanceof SourceServerTransportOperationError) throw error;
      }
      // Bug 原因：CLI 的 --json 错误写在 stdout，stderr 可能只有 SQLite warning；
      // 安装路径与 daemon 启动复用同一错误解析，避免 warning 覆盖真正的失败原因。
      throw new Error(
        (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
          "Source Server archive installation failed",
      );
    }
    // [契约] 退出码为零不等于安装生效，必须同时满足 ok 非 false 与 applied 为 true
    // 缺少 applied 字段按失败处理，避免旧版 CLI 的输出被误判成安装成功
    // 这条校验发生在阶段上报之后，因此界面可能先显示已安装再收到失败
    const response = readLastJsonLine(result.stdout);
    if (response.ok === false || response.applied !== true) {
      throw new Error("Source Server archive installation did not apply the release");
    }
    context.onLog?.({
      phase: "install",
      message: `Source Server ${release.version} installed`,
    });
  }

  public async ensureDaemon(
    target: RemoteTarget,
    context: TransportContext,
    options: SourceServerEnsureDaemonOptions = {},
  ): Promise<SourceServerIngressInfo> {
    throwIfAborted(context.signal);
    let status = options.observedStatus;
    // [权衡] probe 已确认 ready 时复用端口，省掉一次 serve --daemon 往返
    // 冷启动预算只有十秒，多一次往返就可能卡在预算边缘失败
    // 但 ingress token 每次都要重读，daemon 重启后旧 token 会立即失效
    const observedReady =
      status?.state === "ready" && Number.isInteger(status.port) && (status.port as number) > 0;
    if (!observedReady) {
      context.onLog?.({ phase: "daemon", message: "Starting Source Server" });
      const result = await this.exec(target, ["serve", "--daemon", "--json"], context);
      if (result.exitCode !== 0) {
        // Bug 原因：Server CLI 的 --json 错误写在 stdout，Node 运行时 warning 写在 stderr。
        // 旧逻辑只取 stderr，最终把 SQLite warning 当成连接根因展示给用户。
        throw new Error(
          (readStructuredCommandError(result.stdout) ?? result.stderr.trim()) ||
            "Source Server daemon failed to start",
        );
      }
      status = readLastJsonLine(result.stdout) as SourceServerProbeResult["daemonStatus"];
    }
    // Bug 原因：probe 刚确认 ready 后仍重复执行 serve --daemon，会多占一个远端 round-trip，
    // 让冷启动在 10 秒预算边缘失败。ready status 只复用端口；ingress token 仍每次重新读取。
    // [失败路径] 既未观测到 ready 也未拿到 serve 输出时立即失败，不得回退到猜测端口继续装配
    if (!status) throw new Error("Source Server daemon status is unavailable");
    const port = status.port;
    // 端口非法时直接失败，不再去读 token，避免在错误状态下返回半成品 ingress
    if (!Number.isInteger(port) || (port as number) <= 0) {
      throw new Error("Source Server daemon did not report a valid ingress port");
    }
    // [契约] serviceRegistered 为 false 是 wsl 与 docker 的预期路径，属于信息不是错误
    // 为 true 说明走的是远端用户级服务管理器，仅用于日志区分两种形态
    // 界面若把 fallback 当失败展示，会误导用户去重装
    if (status.serviceRegistered === false) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server started in detached fallback mode for this remote environment",
      });
    } else if (status.serviceRegistered === true) {
      context.onLog?.({
        phase: "daemon",
        message: "Source Server registered with the remote OS user service manager",
      });
    }
    const backend = await this.getBackend(target);
    const ingressToken = (
      await backend.readFile(`${SERVER_ROOT_READ_PATH}/run/ingress-token`)
    ).trim();
    if (!ingressToken) throw new Error("Source Server ingress token is missing");
    return { port: port as number, ingressToken };
  }

  public async openChannel(
    target: RemoteTarget,
    ingress: SourceServerIngressInfo,
    context: TransportContext,
  ): Promise<Duplex> {
    throwIfAborted(context.signal);
    const backend = (await this.getBackend(target)) as DirectChannelBackend;
    // [权衡] 优先走 direct-tcpip，省掉一次远端进程与逐跳拷贝
    // [失败路径] 打开失败只降级不中断，日志保留失败原因便于诊断
    // 降级后的 proxy-stdio 走独立 exec 通道，延迟特性不同，不能按直连的时延假设调参
    if (this.kind === "ssh" && backend.openDirectTcpChannel) {
      try {
        return await backend.openDirectTcpChannel(ingress.port);
      } catch (error) {
        context.onLog?.({
          phase: "channel",
          message: `SSH direct-tcpip unavailable; using proxy-stdio (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }
    // [资源] 返回的 Duplex 所有权交给调用方，本适配器不登记也不关闭
    return duplexFromStdio(
      await backend.exec(
        `${SERVER_BIN_SHELL} server proxy-stdio --server-root ${SERVER_ROOT_SHELL}`,
      ),
    );
  }

  public async exec(
    target: RemoteTarget,
    argv: string[],
    context: TransportContext,
  ): Promise<RemoteExecResult> {
    throwIfAborted(context.signal);
    const backend = await this.getBackend(target);
    // [契约] 调用方已带 --server-root 时不再追加，重复参数会让 CLI 取到错误根目录
    // argv 逐项 quoteShellArg，含空格或引号的参数不会被拆成多个 token
    // 跳过服务注册的环境变量只对非 ssh 的 serve --daemon 生效，其它命令不得污染环境
    const hasServerRoot = argv.includes("--server-root");
    const daemonEnvironment =
      this.kind !== "ssh" && argv[0] === "serve" && argv.includes("--daemon")
        ? "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "
        : "";
    const command = [
      // Bug 原因：WSL/Docker 没有稳定的用户级服务管理器；若沿用 SSH 命令会尝试
      // 注册 systemd user service 并在常见环境中失败。两者必须显式进入 detached fallback。
      `${daemonEnvironment}${SERVER_BIN_SHELL}`,
      ...argv.map(quoteShellArg),
      ...(hasServerRoot ? [] : ["--server-root", SERVER_ROOT_SHELL]),
    ].join(" ");
    // [契约] 这里不消费流式输出，整段 stdout 与 stderr 会被一次性缓冲后返回
    // 长输出命令若改走此路径，内存占用随行数线性增长
    return await collectCommand(await backend.exec(command));
  }

  // [资源] 释放所有尚未 settle 的 backend，成功与失败两种结果都要走到 dispose
  // 失败分支返回 undefined 只为吞掉 rejection，避免产生 unhandled rejection
  // 清空集合是必要的，否则已释放对象仍被集合强引用
  public dispose(): void {
    for (const backend of this.backendPromises) {
      void backend.then(
        (resolved) => resolved.dispose(),
        () => undefined,
      );
    }
    this.backendPromises.clear();
  }

  // [并发] 先按 target.kind 过滤，跨协议取消是空操作，不能误伤其它 transport
  // [资源] 先删两个容器的登记再 dispose，防止迟到 resolve 后又被重新注册
  // 不摘除的话，超时后的握手仍在后台继续，迟到的 Source 会被注册成 online
  public cancel(target: RemoteTarget): void {
    if (target.kind !== this.kind) return;
    const key = target as object;
    const backend = this.backends.get(key);
    if (!backend) return;
    // Bug 原因：启动 10 秒超时过去只 reject 外层 Promise，SSH 握手仍在后台继续，
    // 迟到后会把 Source 注册 online。精确摘除本 target backend，后续手动重试可新建 transport。
    this.backends.delete(key);
    this.backendPromises.delete(backend);
    void backend.then(
      (resolved) => resolved.dispose(),
      () => undefined,
    );
  }

  // [并发] kind 与 target.kind 不一致时立即失败，不能退化成新建另一种协议的连接
  // 查缓存在创建之前，创建后立即写回两个容器，避免并发时重复建连
  // 失败产生的 rejected Promise 会留在缓存里，必须靠 cancel 摘除后才能重试
  private async getBackend(target: RemoteTarget): Promise<IRemoteBackend> {
    if (target.kind !== this.kind) {
      throw new Error(`Transport ${this.kind} cannot handle target ${target.kind}`);
    }
    const key = target as object;
    let backend = this.backends.get(key);
    if (!backend) {
      backend = this.createBackend(target);
      this.backends.set(key, backend);
      this.backendPromises.add(backend);
    }
    // [并发] 所有调用者 await 同一个 Promise，因此建连只发生一次
    return await backend;
  }
}

export function createSourceServerTransportAdapter(
  kind: "ssh" | "wsl" | "docker",
  options: CreateSourceServerTransportAdapterOptions = {},
): SourceServerTransportAdapter {
  return new BackendSourceServerTransportAdapter(
    kind,
    options.createBackend ?? createRemoteBackend,
  );
}
