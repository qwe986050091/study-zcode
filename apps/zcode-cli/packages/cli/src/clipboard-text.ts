import { spawn } from "node:child_process";
import type { TuiWriteClipboardText } from "@zcode/tui";

// 文本剪贴板默认上限 1 MiB（按 UTF-8 字节计）；超限直接抛错，
// 避免超大 OSC52 序列刷屏或卡住终端。
const DEFAULT_MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;
// OSC 52 终端转义协议参数：目标 "c" 表示系统剪贴板，序列为 \x1b]52;<目标>;<base64>\x07。
// 用于无原生剪贴板工具或远程/无头会话时的兜底写入。
const OSC_52_CLIPBOARD_TARGET = "c";
const OSC_52_PREFIX = "\x1b]52;";
const OSC_52_SUFFIX = "\x07";
// Windows 命令通过 stdin 读取文本，避免命令行参数长度与转义问题。
const POWERSHELL_SET_CLIPBOARD = "Set-Clipboard -Value ([Console]::In.ReadToEnd())";

// 原生剪贴板命令结果：只关心退出码；exitCode=null 表示被信号终止，按失败处理。
type CommandResult = {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
};

// 文本命令执行器注入点：经 stdin 传文本，返回退出码供调用方逐个候选尝试。
type TextCommandRunner = (
  file: string,
  args: string[],
  options: {
    input: string;
  },
) => Promise<CommandResult>;

// stdout 最小写接口：只要求 write 返回是否被接受，便于单测注入，不假设完整 Writable。
type ClipboardTextOutput = {
  write: (chunk: string) => boolean;
};

// 写入器可注入项：maxBytes 字节上限；platform 默认当前系统；runCommand 默认真实 spawn；
// stdout 缺省时不发 OSC52（只走原生工具）。
type NodeClipboardTextWriterOptions = {
  maxBytes?: number;
  platform?: NodeJS.Platform;
  runCommand?: TextCommandRunner;
  stdout?: ClipboardTextOutput;
};

// 创建跨平台文本剪贴板写入器：stdout 存在时发 OSC52，同时尝试原生剪贴板工具。
// 空文本直接返回；两条通道全部失败时抛错（错误文本供上层直接展示），成功无返回值。
// 副作用：写终端 stdout、启动系统命令；不读写文件、不持久化状态。
export function createNodeClipboardTextWriter(
  options: NodeClipboardTextWriterOptions = {},
): TuiWriteClipboardText {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CLIPBOARD_TEXT_BYTES;
  const platform = options.platform ?? process.platform;
  const runCommand = options.runCommand ?? runCommandText;

  return async (text) => {
    const buffer = assertClipboardTextSize(text, maxBytes);
    if (buffer.byteLength === 0) return;

    // 双通道同时尝试：终端可能不支持 OSC52，桌面环境也可能缺原生工具，任一成功即可。
    const wroteOsc52 = writeOsc52(options.stdout, buffer);
    const copiedNative = await writeNativeClipboardText({
      input: text,
      platform,
      runCommand,
    });

    // 只有全部通道都失败才报错，避免在远程/无头环境误判为复制失败。
    if (!wroteOsc52 && !copiedNative) {
      throw new Error("No text clipboard target accepted the selected text.");
    }
  };
}

// 向 stdout 写 OSC52 序列；无 stdout 或 write 抛错时返回 false，
// 由调用方与原生通道结果合并后再决定是否整体失败。
function writeOsc52(stdout: ClipboardTextOutput | undefined, buffer: Buffer): boolean {
  if (!stdout) return false;
  try {
    stdout.write(
      `${OSC_52_PREFIX}${OSC_52_CLIPBOARD_TARGET};${buffer.toString("base64")}${OSC_52_SUFFIX}`,
    );
    return true;
  } catch {
    return false;
  }
}

// 依次尝试平台候选命令，首个退出码 0 即成功；全部失败返回 false，不吞掉单条命令的异常细节。
async function writeNativeClipboardText(options: {
  input: string;
  platform: NodeJS.Platform;
  runCommand: TextCommandRunner;
}): Promise<boolean> {
  for (const command of nativeClipboardCommands(options.platform)) {
    const result = await options.runCommand(command.file, command.args, {
      input: options.input,
    });
    if (result.exitCode === 0) return true;
  }
  return false;
}

// 平台命令矩阵：macOS 用 pbcopy；Linux 依次 wl-copy/xclip/xsel；Windows 用 PowerShell Set-Clipboard。
// 未知平台返回空数组，交由 OSC52 或最终失败处理。
function nativeClipboardCommands(platform: NodeJS.Platform): Array<{
  args: string[];
  file: string;
}> {
  if (platform === "darwin") {
    return [{ args: [], file: "pbcopy" }];
  }
  if (platform === "linux") {
    return [
      { args: [], file: "wl-copy" },
      { args: ["-selection", "clipboard"], file: "xclip" },
      { args: ["--clipboard", "--input"], file: "xsel" },
    ];
  }
  if (platform === "win32") {
    return [
      {
        args: ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SET_CLIPBOARD],
        file: "powershell.exe",
      },
    ];
  }
  return [];
}

// 校验 UTF-8 字节数，超限抛错；返回编码后的 Buffer 供 OSC52 复用，避免二次编码。
function assertClipboardTextSize(text: string, maxBytes: number): Buffer {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Clipboard text exceeds ${maxBytes} bytes.`);
  }
  return buffer;
}

// 默认文本命令执行器：文本写入 stdin，忽略 stdout/stderr；
// spawn 同步失败或进程错误归一为 exitCode=-1；close 后只 resolve 一次。
async function runCommandText(
  file: string,
  args: string[],
  options: {
    input: string;
  },
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ exitCode: -1 });
      return;
    }

    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // 命令可能不读取输入而提前关闭 stdin，这种竞争按正常处理，忽略错误防 unhandled rejection。
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
    child.on("error", () => finish({ exitCode: -1 }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}
