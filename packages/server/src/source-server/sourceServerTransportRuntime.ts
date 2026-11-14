// INV-01 单引号包裹参数：守住位置 quoteShellArg；改错故障 含空格命令被拆分。
// INV-02 单引号转义序列固定：守住位置 replaceAll；改错故障 参数可逃逸注入。
// INV-03 只在中止时抛错：守住位置 aborted 判断；改错故障 正常路径也抛错。
// INV-04 错误名固定 AbortError：守住位置 name 赋值；改错故障 调用方无法识别取消。
// INV-05 JSON 从后往前找：守住位置 倒序遍历；改错故障 警告行遮住结果。
// INV-06 只认以花括号开头的行：守住位置 startsWith；改错故障 混合日志被解析。
// INV-07 解析失败继续向前：守住位置 try/catch；改错故障 单行噪音中断搜索。
// INV-08 找不到 JSON 立即报错：守住位置 末尾 throw；改错故障 返回空对象。
// INV-09 结构化错误只取字符串：守住位置 typeof；改错故障 对象被当消息。
// INV-10 错误读取失败返回空：守住位置 外层 catch；改错故障 二次抛错掩盖主因。
// INV-11 版本号先试整行精确匹配：守住位置 exact；改错故障 带前缀输出的版本丢失。
// INV-12 带标签的版本同样收集：守住位置 labelled 正则；改错故障 安装脚本输出无法识别。
// INV-13 多版本视为不确定：守住位置 size 判断；改错故障 随机取一个版本。
// INV-14 关闭事件只结算一次：守住位置 subscription.dispose；改错故障 重复 resolve。
// INV-15 文本三路并发收集：守住位置 Promise.all；改错故障 串行导致管道互锁。
// INV-16 行回调按换行切分：守住位置 indexOf；改错故障 进度行粘连。
// INV-17 尾部残行补发：守住位置 decoder.end；改错故障 最后一行丢失。
// INV-18 duplex 先暂停输出：守住位置 output.pause；改错故障 背压失效内存暴涨。
//
// 模块职责：Source Server 传输层的 shell 引号、JSON 结果解析与 stdio 双工桥。
// 状态所有权：无跨调用状态；每条命令的流由调用方持有。
// 阅读顺序：先看引号与中止，再看结果解析，最后看 stdio 桥。
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { StdioStream } from "@zcode/server/remote/backend.js";

export interface RemoteExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// quoteShellArg 用一对单引号包住整个 value，不做 shell 级转义。
// 内部单引号替换成 '"'"' 这段五字符序列，由 replaceAll 一次完成。
// 纯函数只依赖入参，无模块状态，远端与本地调用共用。
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// signal 为空或未 aborted 时直接 return，不抛错。
// 只有 signal.aborted 为真才构造 Error 并抛出。
// error.name 写成 "AbortError"，调用方按名识别取消而不是比对文案。
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Source Server transport operation was canceled");
  error.name = "AbortError";
  throw error;
}

// readLastJsonLine 从 lines.length - 1 倒序遍历到 0。
// 跳过不以 "{" 开头的行，警告与进度行不进 JSON.parse。
// JSON.parse 抛错时 catch 空转，继续看前一行。
export function readLastJsonLine(value: string): Record<string, unknown> {
  // Bug 原因：部分 SSH 堡垒机把远端 stderr 合并进 stdout，并在 stdout 结束后才投递。
  // Server CLI 每次启动都会输出 Node SQLite ExperimentalWarning，旧逻辑只解析最后一个非空行，
  // 远端安装和 daemon 启动已成功时仍报 JSON 解析错误。CLI --json 结果固定是单行 JSON 对象，
  // 所以从后往前取最后一个 JSON 对象行，跳过纯文本行。
  const lines = value.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // 以 { 开头但不是 JSON 的纯文本行同样是噪音。
    }
  }
  throw new Error("Remote command returned no JSON result");
}

export function readStructuredCommandError(value: string): string | null {
  try {
    const response = readLastJsonLine(value);
    return typeof response.error === "string" && response.error.trim()
      ? response.error.trim()
      : null;
  } catch {
    return null;
  }
}

// readUniqueVersion 先拿 trim 后的整串做 ^v?semver$ 精确匹配。
// 精确匹配落空再扫 labelled 正则，接受 zcode/source server 带 version 标签的行。
// versions.size 不等于 1 时返回 undefined，不随机挑一个。
export function readUniqueVersion(value: string): string | undefined {
  const semver = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)";
  const trimmed = value.trim();
  const exact = new RegExp(`^v?${semver}$`, "u").exec(trimmed)?.[1];
  if (exact) return exact;
  const versions = new Set<string>();
  const exactLine = new RegExp(`^v?${semver}$`, "u");
  for (const line of value.split(/\r?\n/u)) {
    const version = exactLine.exec(line.trim())?.[1];
    if (version) versions.add(version);
  }
  const labelled = new RegExp(
    `\\b(?:zcode|source[ -]server)\\b[^\\n]*?\\bversion\\s*[:=]?\\s*v?${semver}\\b`,
    "giu",
  );
  for (const match of value.matchAll(labelled)) {
    const version = match[1];
    if (version) versions.add(version);
  }
  return versions.size === 1 ? versions.values().next().value : undefined;
}

function waitForClose(stream: StdioStream): Promise<number> {
  return new Promise((resolve) => {
    const subscription = stream.onClose((code) => {
      subscription.dispose();
      resolve(code);
    });
  });
}

async function readText(stream: NodeJS.ReadableStream, onLine?: (line: string) => void): Promise<string> {
  const chunks: Buffer[] = [];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
    if (onLine) {
      pending += decoder.write(buffer);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        onLine(pending.slice(0, newline).replace(/\r$/u, ""));
        pending = pending.slice(newline + 1);
      }
    }
  }
  if (onLine && (pending += decoder.end())) onLine(pending);
  return Buffer.concat(chunks).toString("utf8");
}

export async function collectCommand(stream: StdioStream, onStdoutLine?: (line: string) => void): Promise<RemoteExecResult> {
  const [stdout, stderr, exitCode] = await Promise.all([
    readText(stream.stdout, onStdoutLine),
    readText(stream.stderr),
    waitForClose(stream),
  ]);
  return { exitCode, stdout, stderr };
}

// duplexFromStdio 先 output.pause()，data 到达后由 read() 恢复。
// duplex.push 返回 false 时立刻 pause，等下游 read() 再 resume。
// onClose 收到非 0 退出码就 destroy，0 则 push(null) 正常收尾。
export function duplexFromStdio(stream: StdioStream): Duplex {
  const input = stream.stdin;
  const output = stream.stdout;
  const duplex = new Duplex({
    read() {
      output.resume();
    },
    write(chunk, encoding, callback) {
      if (input.write(chunk, encoding)) callback();
      else input.once("drain", callback);
    },
    final(callback) {
      input.end(callback);
    },
    destroy(error, callback) {
      const destroyableInput = input as NodeJS.WritableStream & {
        destroy?: (error?: Error | null) => void;
      };
      const destroyableOutput = output as NodeJS.ReadableStream & {
        destroy?: (error?: Error | null) => void;
      };
      destroyableInput.destroy?.(error);
      destroyableOutput.destroy?.(error);
      callback(error);
    },
  });
  output.pause();
  output.on("data", (chunk) => {
    if (!duplex.push(chunk)) output.pause();
  });
  output.once("end", () => duplex.push(null));
  output.once("error", (error) => duplex.destroy(error));
  input.once("error", (error) => duplex.destroy(error));
  stream.onClose((code) => {
    if (code !== 0) duplex.destroy(new Error(`proxy-stdio exited with code ${code}`));
    else duplex.push(null);
  });
  return duplex;
}
