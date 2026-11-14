// INV-01 超限即视为无图：守住位置 字节上限；改错故障 巨型图片进入模型上下文。
// INV-02 失败一律返回空：守住位置 各实现兜底；改错故障 剪贴板异常打断提交。
// INV-03 平台分发只做能力选择：守住位置 分支判断；改错故障 启动时探测拖慢启动。
// INV-04 未知平台返回空：守住位置 末尾兜底；改错故障 调用方需要额外分支。
// INV-05 macOS 走临时文件：守住位置 脚本写盘；改错故障 二进制走标准输出被截断。
// INV-06 临时目录必清理：守住位置 收尾删除；改错故障 截图残留在用户磁盘。
// INV-07 Linux 多候选依次尝试：守住位置 候选数组；改错故障 只有单一工具的环境取不到图。
// INV-08 首个成功即返回：守住位置 退出码与内容双判断；改错故障 空输出被当作图片。
// INV-09 无图退出码单独约定：守住位置 脚本分支；改错故障 期待图片却拿到空文件。
// INV-10 字节为空不可用：守住位置 长度判断；改错故障 生成空数据地址。
// INV-11 尺寸按原始字节：守住位置 长度字段；改错故障 展示体积偏大四成。
// INV-12 媒体类型随候选给定：守住位置 候选声明；改错故障 图片类型与实际不符。
// INV-13 子进程用参数数组：守住位置 启动方式；改错故障 路径含空格被拆断。
// INV-14 输出超限即终止：守住位置 累计判断；改错故障 内存被超大输出撑爆。
// INV-15 只收集标准输出：守住位置 管道配置；改错故障 错误输出混入图片数据。
// INV-16 启动失败归一为负一：守住位置 捕获分支；改错故障 异常逃逸成未捕获拒绝。
// INV-17 结果只结算一次：守住位置 已结算标志；改错故障 关闭与错误事件重复结算。
// INV-18 脚本字面量转义：守住位置 专用转义函数；改错故障 路径内容注入脚本。
//
// 模块职责：跨平台读取剪贴板图片并归一为 TUI 可用结构。
// 状态所有权：无状态，配置与命令执行器由调用方注入。
// 阅读顺序：先看创建器与分发，再看三平台实现，最后看字节归一与执行器。
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TuiClipboardImage, TuiImageMediaType, TuiReadClipboardImage } from "@zcode/tui";

// 单张剪贴板图片的默认上限（20 MiB，按原始字节计）。
// 超限时整次读取按「无可用图片」返回 null，避免超大 base64 dataUrl 进入 TUI 与模型上下文。
const DEFAULT_MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

// 子进程结果的归一化口径：exitCode 为 null 表示被信号终止或未正常退出；
// signal 仅在异常终止时存在；stdout 恒为 Buffer（可能为空，不为 undefined）。
type CommandResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: Buffer;
};

// 命令执行器注入点：单测可替换真实 spawn；实现必须在 maxBytes 内截断输出，
// 并在 AbortSignal 取消时尽快结束（不得挂起）。
type CommandRunner = (
  file: string,
  args: string[],
  options: {
    maxBytes: number;
    signal?: AbortSignal;
  },
) => Promise<CommandResult>;

// 读取器可注入项：maxBytes 为字节上限（默认 20MiB）；platform 默认当前系统；
// processEnv 仅用于解析存储目录；runCommand 默认真实 spawn；tempDirectory 为 macOS/Windows 中转目录。
type NodeClipboardImageReaderOptions = {
  maxBytes?: number;
  platform?: NodeJS.Platform;
  processEnv?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  tempDirectory?: string;
};

// 解析剪贴板临时目录：ZCODE_STORAGE_DIR 去空白后非空才生效，否则回退 ~/.zcode。
// 只拼接路径、不创建目录；目录创建由各平台实现按需执行，避免无图片时也落盘。
function resolveDefaultClipboardDirectory(processEnv: NodeJS.ProcessEnv = process.env): string {
  const storageRoot = processEnv.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode");
  return join(storageRoot, "clipboard");
}

// 创建跨平台剪贴板图片读取器：按 platform 分发到 macOS/Linux/Windows 实现。
// 返回函数在无图片、命令缺失、非 0 退出、空内容或超限时一律解析为 null（不抛错）；
// readOptions.abortSignal 透传给子进程。副作用：调用系统命令、读写临时目录。
// 默认值 maxBytes 与 platform 都在闭包里定死。
// platform 取 options.platform 或 process.platform。
// 返回的 async 函数只做平台分发。
// 信号透传到 spawn 的 options.signal，不在此重建 AbortController。
// 每次 readClipboardImage 都重新执行，不缓存上一次结果。
export function createNodeClipboardImageReader(
  options: NodeClipboardImageReaderOptions = {},
): TuiReadClipboardImage {
  const platform = options.platform ?? process.platform;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CLIPBOARD_IMAGE_BYTES;
  const runCommand = options.runCommand ?? runCommandBuffer;
  const tempDirectory =
    options.tempDirectory ?? resolveDefaultClipboardDirectory(options.processEnv);

  return async (readOptions = {}) => {
    // 平台分发只做能力选择，不做能力探测：某平台缺工具时由该实现自行降级为 null。
    if (platform === "darwin") {
      return await readMacClipboardImage({
        maxBytes,
        runCommand,
        signal: readOptions.abortSignal,
        tempDirectory,
      });
    }
    if (platform === "linux") {
      return await readLinuxClipboardImage({
        maxBytes,
        runCommand,
        signal: readOptions.abortSignal,
      });
    }
    if (platform === "win32") {
      return await readWindowsClipboardImage({
        maxBytes,
        runCommand,
        signal: readOptions.abortSignal,
        tempDirectory,
      });
    }
    // 未知平台视为不支持图片剪贴板，保持与「无图片」同一口径，避免调用方分支判断。
    return null;
  };
}

// macOS：用 osascript 将剪贴板 PNG 写入临时文件后读回，避免二进制数据走 stdout。
// 非 0 退出（无 PNG 内容/无辅助功能权限）返回 null；临时目录在 finally 中递归删除。
// 先 mkdir 确保 tempDirectory 存在。
// mkdtemp 每次生成独立临时目录。
// osascript 把 png_data 写入 imagePath。
// result.exitCode 非 0 时返回 null，不读 tempImagePath。
// finally 里 rm(tempDirectory, { recursive: true }) 清理。
async function readMacClipboardImage(options: {
  maxBytes: number;
  runCommand: CommandRunner;
  signal?: AbortSignal;
  tempDirectory: string;
}): Promise<TuiClipboardImage | null> {
  await mkdir(options.tempDirectory, { recursive: true });
  const directory = await mkdtemp(join(options.tempDirectory, "zcode-clipboard-"));
  const imagePath = join(directory, "clipboard.png");

  try {
    const result = await options.runCommand(
      "osascript",
      [
        "-e",
        "set png_data to (the clipboard as «class PNGf»)",
        "-e",
        `set fp to open for access POSIX file ${appleScriptString(imagePath)} with write permission`,
        "-e",
        "write png_data to fp",
        "-e",
        "close access fp",
      ],
      { maxBytes: options.maxBytes, signal: options.signal },
    );
    if (result.exitCode !== 0) return null;
    return await readImageFile(imagePath, "image/png", options.maxBytes);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// Linux：按 png/jpeg/gif/webp 依次尝试 wl-paste（Wayland）与 xclip（X11）。
// 首个退出码 0 且字节合法的结果胜出；命令缺失或均失败时返回 null。
// 先试 Wayland 再试 X11。
// commands 每个格式一条候选，共 8 条。
// result.exitCode 为 0 才接受该候选。
// bufferToClipboardImage 为 null 时继续下一条。
// 循环走完仍无结果则返回 null。
async function readLinuxClipboardImage(options: {
  maxBytes: number;
  runCommand: CommandRunner;
  signal?: AbortSignal;
}): Promise<TuiClipboardImage | null> {
  const commands: Array<{ args: string[]; file: string; mediaType: TuiImageMediaType }> = [
    { args: ["--type", "image/png"], file: "wl-paste", mediaType: "image/png" },
    { args: ["--type", "image/jpeg"], file: "wl-paste", mediaType: "image/jpeg" },
    { args: ["--type", "image/gif"], file: "wl-paste", mediaType: "image/gif" },
    { args: ["--type", "image/webp"], file: "wl-paste", mediaType: "image/webp" },
    {
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
      file: "xclip",
      mediaType: "image/png",
    },
    {
      args: ["-selection", "clipboard", "-t", "image/jpeg", "-o"],
      file: "xclip",
      mediaType: "image/jpeg",
    },
    {
      args: ["-selection", "clipboard", "-t", "image/gif", "-o"],
      file: "xclip",
      mediaType: "image/gif",
    },
    {
      args: ["-selection", "clipboard", "-t", "image/webp", "-o"],
      file: "xclip",
      mediaType: "image/webp",
    },
  ];

  for (const command of commands) {
    const result = await options.runCommand(command.file, command.args, {
      maxBytes: options.maxBytes,
      signal: options.signal,
    });
    // 缺命令/非 0 退出/空输出都会落到下一次候选，保证只有单一工具可用时仍能取图。
    const image = bufferToClipboardImage(result.stdout, command.mediaType, options.maxBytes);
    if (result.exitCode === 0 && image) return image;
  }

  return null;
}

// Windows：PowerShell 读取剪贴板图像并存为临时 PNG；退出码 2 表示剪贴板无图像。
// 任何非 0 退出返回 null；临时目录在 finally 中清理，避免残留截图。
async function readWindowsClipboardImage(options: {
  maxBytes: number;
  runCommand: CommandRunner;
  signal?: AbortSignal;
  tempDirectory: string;
}): Promise<TuiClipboardImage | null> {
  await mkdir(options.tempDirectory, { recursive: true });
  const directory = await mkdtemp(join(options.tempDirectory, "zcode-clipboard-"));
  const imagePath = join(directory, "clipboard.png");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$img = Get-Clipboard -Format Image;",
    "if ($null -eq $img) { exit 2 }",
    `$img.Save(${powershellString(imagePath)}, [System.Drawing.Imaging.ImageFormat]::Png);`,
  ].join(" ");

  try {
    const result = await options.runCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { maxBytes: options.maxBytes, signal: options.signal },
    );
    if (result.exitCode !== 0) return null;
    return await readImageFile(imagePath, "image/png", options.maxBytes);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// 读取临时文件并转为剪贴板图片；空文件或超过 maxBytes 时返回 null，不向上抛错。
async function readImageFile(
  path: string,
  mediaType: TuiImageMediaType,
  maxBytes: number,
): Promise<TuiClipboardImage | null> {
  const buffer = await readFile(path);
  return bufferToClipboardImage(buffer, mediaType, maxBytes);
}

// 字节归一为 TuiClipboardImage：空 Buffer 与超过 maxBytes 均视为不可用返回 null。
// 成功时生成 data:<mime>;base64,<...>；sizeBytes 为原始字节数，不是 base64 长度。
function bufferToClipboardImage(
  buffer: Buffer,
  mediaType: TuiImageMediaType,
  maxBytes: number,
): TuiClipboardImage | null {
  if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null;
  return {
    dataUrl: `data:${mediaType};base64,${buffer.toString("base64")}`,
    mediaType,
    sizeBytes: buffer.byteLength,
  };
}

// 默认命令执行器：spawn 参数数组形式避免 shell 转义，windowsHide 防止弹窗。
// 输出累计超过 maxBytes 时 kill 子进程并保留已收集字节；spawn 同步失败/进程错误统一
// 归一为 exitCode=-1、空 stdout，调用方据此按「无图片」处理。
// spawn 用参数数组调用且不经 shell，空格与引号原样传入。
// windowsHide 为 true，子进程不创建可见控制台。
// stdio 取 ignore 与 pipe，只收 stdout，stderr 丢弃。
// bytes 超过 maxBytes 时 child.kill() 并放弃本次结果。
// child 的 error 与 close 都走 finish 结算。
// settled 标志保证 resolve 只执行一次。
async function runCommandBuffer(
  file: string,
  args: string[],
  options: {
    maxBytes: number;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        signal: options.signal,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ exitCode: -1, stdout: Buffer.alloc(0) });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        // 截断的图片不可用，继续读取只会浪费内存，因此立即结束子进程。
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish({ exitCode: -1, stdout: Buffer.alloc(0) }));
    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout: Buffer.concat(chunks),
      });
    });
  });
}

// AppleScript 字符串字面量转义：先转义反斜杠再转义双引号，防止路径内容注入脚本。
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// PowerShell 单引号字面量转义：内部单引号翻倍；单引号内不做变量展开，路径更安全。
function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
