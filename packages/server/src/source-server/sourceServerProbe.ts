// INV-01 探测收敛为单次远端往返：守住位置 调用组织；改错故障 冷启动超出启动预算。
// INV-02 各段以唯一标记分隔：守住位置 命令拼接；改错故障 输出错位解析出空字段。
// INV-03 探测命令不因单项失败中止：守住位置 首行设置；改错故障 缺少命令时整体失败。
// INV-04 读取版本身份按开关决定：守住位置 条件展开；改错故障 不需要身份时多读文件。
// INV-05 状态只在进程存活时复用：守住位置 存活判断；改错故障 陈旧状态被当成运行中。
// INV-06 退出码非零即环境错误：守住位置 判断分支；改错故障 传输失败被当成安装缺失。
// INV-07 平台与架构都做归一：守住位置 解析入口；改错故障 大小写差异导致不匹配。
// INV-08 内核类型参与平台判定：守住位置 合并调用；改错故障 容器内平台识别错误。
// INV-09 远端安装根随结果返回：守住位置 条件展开；改错故障 安装位置无法定位。
// INV-10 平台支持检查失败归预检：守住位置 捕获转换；改错故障 用户看到原始堆栈。
// INV-11 仅在 Linux 校验动态链接库：守住位置 平台早退；改错故障 其它平台被误判过低。
// INV-12 读不到版本时保持原安装链：守住位置 正则未命中；改错故障 凭猜测拒绝安装。
// INV-13 版本比较按主次两段：守住位置 比较表达式；改错故障 边界版本被误拒。
// INV-14 未安装直接返回早退结果：守住位置 安装标记判断；改错故障 继续读不存在的文件。
// INV-15 归档摘要只接受完整十六进制：守住位置 正则校验；改错故障 非法摘要参与内容寻址。
// INV-16 摘要统一转小写：守住位置 归一赋值；改错故障 大小写不同触发重复下载。
// INV-17 旧安装缺身份只记日志：守住位置 捕获分支；改错故障 旧元数据阻断探测。
// INV-18 版本与状态解析互相独立：守住位置 两个捕获块；改错故障 一项坏数据吞掉另一项。
//
// 模块职责：远端 Source Server 环境、安装与版本状态的只读探测。
// 状态所有权：无状态；每次探测各自建立一次命令往返。
// 阅读顺序：先看探测命令构造，再看解析主流程，最后看环境与版本校验。
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@zcode/server/remote/detectEnv.js";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import {
  collectCommand,
  readLastJsonLine,
  readUniqueVersion,
  throwIfAborted,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";
import type {
  SourceServerProbeOptions,
  SourceServerProbeResult,
  TransportContext,
} from "@zcode/server/source-server/transportAdapter.js";

const SERVER_ROOT_SHELL = '"$HOME/.zcode/server"';
const SERVER_BIN_SHELL = '"$HOME/.zcode/server/bin/zcode"';
const SERVER_CURRENT_SHELL = `${SERVER_ROOT_SHELL}/current.json`;
const SERVER_STATUS_SHELL = `${SERVER_ROOT_SHELL}/run/status.json`;
const SOURCE_SERVER_PROBE_MARKER_PREFIX = "__ZCODE_PROBE_";

// 首行 set +e 关闭立即退出。
// 各段以 SOURCE_SERVER_PROBE_MARKER_PREFIX 唯一标记开头。
// 可选段按 includeReleaseIdentity 开关展开。
// 整条命令以分号 join 串联。
function buildSourceServerProbeCommand(includeReleaseIdentity: boolean): string {
  return [
    "set +e",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}PLATFORM__\\n'`,
    "uname -s",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ARCH__\\n'`,
    "uname -m",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}ROOT__\\n'`,
    `printf '%s\\n' ${SERVER_ROOT_SHELL}`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}KERNEL__\\n'`,
    "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; else printf '\\n'; fi",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}LIBC__\\n'`,
    // musl、macOS 或缺 getconf 时只留空段；set +e 下不影响 probe 退出码。
    "getconf GNU_LIBC_VERSION 2>/dev/null",
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}INSTALLED__\\n'`,
    `if [ -f ${SERVER_BIN_SHELL} ]; then printf '1\\n'; else printf '0\\n'; fi`,
    ...(includeReleaseIdentity
      ? [
          `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}RELEASE__\\n'`,
          `if [ -r ${SERVER_CURRENT_SHELL} ]; then cat ${SERVER_CURRENT_SHELL}; fi`,
        ]
      : []),
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}VERSION__\\n'`,
    `if [ -r ${SERVER_CURRENT_SHELL} ]; then sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ${SERVER_CURRENT_SHELL} | head -n 1; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}STATUS__\\n'`,
    // Bug 原因：每次 probe 启动两次完整 Server CLI，冷缓存时仅版本/状态读取就会耗尽
    // 10 秒启动预算。current/status 是 CLI 自身的权威持久化文件；status 仅在 PID 仍存活时复用。
    `if [ -r ${SERVER_STATUS_SHELL} ]; then status_pid=$(sed -n 's/^[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${SERVER_STATUS_SHELL} | head -n 1); if [ -n "$status_pid" ] && kill -0 "$status_pid" 2>/dev/null; then tr -d '\\r\\n' < ${SERVER_STATUS_SHELL}; printf '\\n'; fi; fi`,
    `printf '${SOURCE_SERVER_PROBE_MARKER_PREFIX}END__\\n'`,
  ].join("; ");
}

function readSourceServerProbeSections(output: string): Map<string, string> {
  const parts = output.split(/__ZCODE_PROBE_([A-Z]+)__\r?\n/gu);
  const sections = new Map<string, string>();
  for (let index = 1; index + 1 < parts.length; index += 2) {
    sections.set(parts[index]!, parts[index + 1]!.trim());
  }
  return sections;
}

/** 远端环境检查本身的失败；只有它归入预检失败，建立连接或执行命令的传输失败不借探测阶段兜底。 */
export class SourceServerProbeEnvironmentError extends Error {
  public override readonly name = "SourceServerProbeEnvironmentError";
}

// archive 内置官方 Node（SERVER_RUNTIME_NODE_VERSION）Linux 构建的动态链接下限，随 Node 大版本同步。
const SOURCE_SERVER_MIN_GLIBC_VERSION = [2, 28] as const;

// 只在 Linux 上校验。
// 读不到版本时不拒绝。
// 低于 SOURCE_SERVER_MIN_GLIBC_VERSION 时抛 SourceServerProbeEnvironmentError。
function assertSupportedGlibc(platform: string, libcText: string): void {
  if (platform !== "linux") return;
  // Bug 原因（ZCT-2112008575366098944）：probe 过去只看平台/架构，CentOS 7 等 glibc 2.17
  // 的远端要先上传约 87MB archive，解压后执行 bin/zcode 才由 ld.so 报一串 `not found`，
  // 并被归为安装失败。glibc 下限是 release 的平台事实，归入远端环境检查，在确认安装前拒绝。
  // 读不到版本（musl、缺 getconf、输出无法识别）时无法判定，保持原安装链，不凭猜测拒绝。
  const match = /^glibc\s+(\d+)\.(\d+)/iu.exec(libcText);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const [minMajor, minMinor] = SOURCE_SERVER_MIN_GLIBC_VERSION;
  if (major > minMajor || (major === minMajor && minor >= minMinor)) return;
  const required = SOURCE_SERVER_MIN_GLIBC_VERSION.join(".");
  throw new SourceServerProbeEnvironmentError(
    `Remote glibc ${major}.${minor} is older than glibc ${required} required by ZCode Source Server. ` +
      `Use a Linux system with glibc ${required} or later, such as RHEL 8+, Ubuntu 20.04+ or Debian 10+.`,
  );
}

// 先检查 signal.aborted 是否已取消。
// buildSourceServerProbeCommand 生成的命令只读不修改远端。
// 非零 exitCode 归 SourceServerProbeEnvironmentError。
// 未安装时让 installed 为假并提前返回。
export async function probeSourceServer(
  backend: IRemoteBackend,
  context: TransportContext,
  options: SourceServerProbeOptions,
): Promise<SourceServerProbeResult> {
  throwIfAborted(context.signal);
  // Bug 原因：冷启动曾串行/并发创建多个 SSH channel 读取环境、安装、release、version、status；
  // 串行会超出 10 秒预算，并发又会在首次握手期触发 Bad packet length。一个只读 POSIX channel
  // 同时给三种 Backend 使用，既保留 Adapter 合同，也把 probe 收敛为单次远端 round-trip。
  const result = await collectCommand(
    await backend.exec(buildSourceServerProbeCommand(options.includeReleaseIdentity === true)),
  );
  if (result.exitCode !== 0) {
    throw new SourceServerProbeEnvironmentError(
      result.stderr.trim() || "Source Server environment probe failed",
    );
  }
  const sections = readSourceServerProbeSections(result.stdout);
  const reportedPlatform = sections.get("PLATFORM") ?? "";
  const kernelOstype = sections.get("KERNEL") ?? "";
  const environment = {
    platform: resolveRemotePlatform(normalizeRemotePlatform(reportedPlatform), kernelOstype),
    arch: normalizeRemoteArch(sections.get("ARCH") ?? ""),
    ...(sections.get("ROOT") ? { installPath: sections.get("ROOT") } : {}),
  };
  try {
    assertSupportedRemoteEnvironment(environment);
  } catch (error) {
    throw new SourceServerProbeEnvironmentError(
      error instanceof Error ? error.message : String(error),
    );
  }
  assertSupportedGlibc(environment.platform, sections.get("LIBC") ?? "");
  const installed = sections.get("INSTALLED") === "1";
  if (!installed) return { ...environment, installed: false };

  let installedArchiveSha256: string | undefined;
  const releaseText = sections.get("RELEASE");
  if (releaseText) {
    try {
      const current = JSON.parse(releaseText) as { archiveSha256?: unknown };
      if (
        typeof current.archiveSha256 === "string" &&
        /^[a-f0-9]{64}$/iu.test(current.archiveSha256)
      ) {
        installedArchiveSha256 = current.archiveSha256.toLowerCase();
      }
    } catch (error) {
      // Bug 原因：同 version 的旧开发安装可能没有 archive 身份；缺失必须投影为未知，
      // 由开发态内容寻址策略触发刷新，不能让旧 Server 的元数据格式阻断 probe。
      context.onLog?.({
        phase: "probe",
        message: `Source Server release identity is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const versionText = sections.get("VERSION") ?? "";
  const statusText = sections.get("STATUS") ?? "";
  let installedVersion: string | undefined;
  let daemonStatus: SourceServerProbeResult["daemonStatus"];
  try {
    if (versionText) installedVersion = readUniqueVersion(versionText);
  } catch {
    installedVersion = undefined;
  }
  try {
    if (statusText) daemonStatus = readLastJsonLine(statusText) as typeof daemonStatus;
  } catch {
    daemonStatus = undefined;
  }
  return {
    ...environment,
    installed: true,
    ...(installedArchiveSha256 ? { installedArchiveSha256 } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    ...(daemonStatus ? { daemonStatus } : {}),
  };
}
