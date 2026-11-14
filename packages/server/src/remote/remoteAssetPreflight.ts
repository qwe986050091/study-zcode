// INV-01 逐个探测远端工具：守住位置 单条 shell 脚本；改错故障 缺工具要到下载时才报。
// INV-02 缺 tar 立即失败：守住位置 抛错分支；改错故障 解压阶段才暴露。
// INV-03 下载器二选一：守住位置 parseDownloadTool；改错故障 未知命令被当成 curl。
// INV-04 校验器三选一：守住位置 parseSha256Tool；改错故障 校验步骤被跳过。
// INV-05 进度能力可选：守住位置 progress 判断；改错故障 无 awk 环境报错。
// INV-06 探测结果结构固定：守住位置 RemoteAssetTools；改错故障 调用方处理缺失字段。
// INV-07 探测命令单一往返：守住位置 命令拼接；改错故障 多次 ssh 往返变慢。
// INV-08 解析按首个等号切分：守住位置 separatorIndex；改错故障 空行被当成键值。
// INV-09 先收 stdout 再等关闭：守住位置 collectStdout；改错故障 输出被截断。
// INV-10 关闭事件可能早于数据：守住位置 排空窗口；改错故障 探测结果丢失。
// INV-11 排空窗口兜底：守住位置 定时器；改错故障 后端不触发 end 时卡死。
// INV-12 只结算一次：守住位置 settled 标记；改错故障 重复 resolve。
// INV-13 错误与关闭同样结算：守住位置 error 监听；改错故障 探测永久挂起。
// INV-14 日志保留选型结果：守住位置 结束日志；改错故障 现场无法判断用了哪个工具。
// INV-15 tar 探测独立入口：守住位置 detectRemoteTarTool；改错故障 只需 tar 时跑全量探测。
// INV-16 非零退出不算成功：守住位置 waitForClose；改错故障 失败被当成功。
// INV-17 缺失提示指向补救：守住位置 错误文案；改错故障 用户不知道装什么。
// INV-18 仅依赖远端 sh：守住位置 命令语法；改错故障 探针在精简镜像上失败。
//
// 模块职责：远端部署前探测 tar、下载器、校验器与进度能力。
// 状态所有权：无状态；每次调用都重新探测。
// 阅读顺序：先看两个探测入口，再看命令构造，最后看输出收集。
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import { waitForClose } from "@zcode/server/remote/deployShared.js";

export type RemoteDownloadTool = "curl" | "wget";
export type RemoteSha256Tool = "sha256sum" | "shasum" | "openssl";

export interface RemoteAssetTools {
  download: RemoteDownloadTool;
  tar: "tar";
  sha256: RemoteSha256Tool;
  supportsProgress?: boolean;
}

interface RemoteAssetPreflightLoggers {
  log: (...args: unknown[]) => void;
}

const REMOTE_TAR_MISSING_ERROR =
  "远端服务器缺少 tar，无法解压 ZCode Source Server。请安装 tar 后重试。";

// 单独探测 tar 一项。
// 先收集 stdout 再等 close。
// parseToolLines 解析成键值表。
// 缺失时抛 tar 安装提示的错误。
export async function detectRemoteTarTool(
  backend: IRemoteBackend,
  loggers: RemoteAssetPreflightLoggers,
): Promise<"tar"> {
  loggers.log("[remote-assets] preflight: checking remote archive tools");
  const stream = await backend.exec(
    "tar_tool=; if command -v tar >/dev/null 2>&1; then tar_tool=tar; fi; printf 'tar=%s\\n' \"$tar_tool\"",
  );
  const stdoutPromise = collectStdout(stream);
  await waitForClose(stream);
  const values = parseToolLines(await stdoutPromise);
  if (values.tar !== "tar") throw new Error(REMOTE_TAR_MISSING_ERROR);
  return "tar";
}

// detectRemoteAssetTools 单次往返探测全部工具。
// 逐项解析 download 与 tar 选型。
// 缺任一必需工具即 reject。
// 结束时用 logger 记录最终选型。
export async function detectRemoteAssetTools(
  backend: IRemoteBackend,
  loggers: RemoteAssetPreflightLoggers,
): Promise<RemoteAssetTools> {
  loggers.log("[remote-assets] preflight: checking remote download tools");

  const stream = await backend.exec(buildPreflightCommand());
  const stdoutPromise = collectStdout(stream);
  await waitForClose(stream);
  const stdout = await stdoutPromise;

  const values = parseToolLines(stdout);
  const download = parseDownloadTool(values.download);
  const tar = values.tar === "tar" ? "tar" : null;
  const sha256 = parseSha256Tool(values.sha256);
  const supportsProgress = values.progress === "full";

  if (!download) {
    throw new Error(
      "远端服务器缺少 curl 或 wget，无法直接下载 ZCode 远程资源。请安装 curl/wget，或切回“本地下载后上传”。",
    );
  }
  if (!tar) {
    throw new Error(REMOTE_TAR_MISSING_ERROR);
  }
  if (!sha256) {
    throw new Error(
      "远端服务器缺少 sha256sum、shasum 或 openssl，无法校验 ZCode 远程资源。请安装其中一个校验工具，或切回“本地下载后上传”。",
    );
  }

  loggers.log(
    `[remote-assets] preflight: selected tools download=${download} tar=${tar} sha256=${sha256} progress=${supportsProgress ? "full" : "basic"}`,
  );

  return { download, tar, sha256, supportsProgress };
}

// buildPreflightCommand 逐项探测可用命令。
// 各段用 && 串联成 buildPreflightCommand 的返回值。
// 末尾统一输出 key=value。
function buildPreflightCommand(): string {
  return [
    "download=",
    "if command -v curl >/dev/null 2>&1; then download=curl; elif command -v wget >/dev/null 2>&1; then download=wget; fi",
    "tar_tool=",
    "if command -v tar >/dev/null 2>&1; then tar_tool=tar; fi",
    "sha_tool=",
    "if command -v sha256sum >/dev/null 2>&1; then sha_tool=sha256sum; elif command -v shasum >/dev/null 2>&1; then sha_tool=shasum; elif command -v openssl >/dev/null 2>&1; then sha_tool=openssl; fi",
    "progress=basic",
    "if command -v awk >/dev/null 2>&1 && command -v wc >/dev/null 2>&1 && command -v date >/dev/null 2>&1 && command -v sleep >/dev/null 2>&1; then progress=full; fi",
    'printf \'download=%s\ntar=%s\nsha256=%s\nprogress=%s\n\' "$download" "$tar_tool" "$sha_tool" "$progress"',
  ].join("; ");
}

// indexOf 按首个等号切分。
// separatorIndex 为 -1 的行直接跳过。
// 值做 trim 去首尾空白。
function parseToolLines(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    values[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1).trim();
  }
  return values;
}

function parseDownloadTool(value?: string): RemoteDownloadTool | null {
  return value === "curl" || value === "wget" ? value : null;
}

function parseSha256Tool(value?: string): RemoteSha256Tool | null {
  return value === "sha256sum" || value === "shasum" || value === "openssl" ? value : null;
}

// settled 保证只结算一次。
// 数据到达后重排 drain 窗口。
// close 事件给剩余数据留出排空时间。
async function collectStdout(stream: StdioStream): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let closeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const clearCloseFallback = () => {
      if (!closeFallbackTimer) {
        return;
      }
      clearTimeout(closeFallbackTimer);
      closeFallbackTimer = null;
    };
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearCloseFallback();
      resolve(stdout);
    };
    const scheduleCloseFallback = () => {
      if (settled) {
        return;
      }
      clearCloseFallback();
      closeFallbackTimer = setTimeout(settle, 50);
    };

    stream.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (closeFallbackTimer) {
        scheduleCloseFallback();
      }
    });
    stream.stdout.on("end", settle);
    stream.stdout.on("close", settle);
    stream.stdout.on("error", settle);
    // ssh2 的 exit/onClose 可能早于 stdout data；不能在 onClose 立刻结束收集。
    // 这里给 stdout 一个短暂排空窗口，同时仍兜底处理 stdout 不触发 end/close 的后端实现，避免 preflight 卡住。
    stream.onClose(scheduleCloseFallback);
  });
}
