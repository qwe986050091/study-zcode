// TUI stderr 接管：判断本次是否进入 TUI，并在启动阶段把裸 stderr 输出暂存后丢弃，避免破坏全屏界面。
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";

// 暂存缓冲上限（字符）：只保留最近一段用于崩溃诊断，避免长时间运行无限增长。
const MAX_BUFFERED_CHARACTERS = 64 * 1024;

// 拦截器句柄：暴露缓冲内容、可写回原流的 passthrough，以及恢复入口。
interface TuiStderrInterceptor {
  // 被拦截的最近 MAX_BUFFERED_CHARACTERS 个字符（尾部截断，最旧的内容会先丢）。
  readonly bufferedOutput: string;
  // 直接写回原 stderr 的流对象，供崩溃报告等必须在 TUI 之外输出的场景使用。
  readonly passthrough: NodeJS.WriteStream;
  // 恢复原 write；flush 为 true 时把缓冲内容补写到原流。
  restore(options?: { flush?: boolean }): void;
}

// 判断命令是否应进入 TUI 模式。
// 输入：完整 argv（可含 node/脚本前缀，由 parseGlobalArgs 自行处理）。
// 输出：true 仅当解析成功、没有 help/version/prompt/target 等单次执行标志，且子命令缺省或为 tui。
// 降级语义：参数解析失败返回 false（按非 TUI 处理），让上游走 run 流程输出真实错误。
export function isTuiInvocation(argv: readonly string[]): boolean {
  let parsed: ReturnType<typeof parseGlobalArgs>;

  try {
    // 与 run 共享参数定义，包括 locale/browser/force-mcs 和多值工具限制。
    parsed = parseGlobalArgs(extractDisallowedToolsArgs(argv).args);
  } catch {
    return false;
  }

  // 这些标志指向一次性执行（打印帮助/版本、单次 prompt 或指定 target），不应被 TUI 接管终端。
  if (
    parsed.values.help === true ||
    parsed.values.version === true ||
    typeof parsed.values.prompt === "string" ||
    typeof parsed.values.target === "string"
  ) {
    return false;
  }

  return (parsed.positionals[0] ?? "tui") === "tui";
}

// 接管 stderr，把启动期输出暂存到内存。
// 输入：stderr 为目标流（必须是 TUI 实际使用的同一个流）。
// 输出：拦截器句柄；restore 幂等并在 flush=true 时补写缓冲内容。
// 副作用：替换 stderr.write，期间所有写入既不落屏也不进日志，只保留最后 64K 字符。
// 不变量：write 恒返回 true 且异步回调一次，保证调用方不因背压/回调缺失而挂起。
export function interceptTuiStderr(stderr: NodeJS.WriteStream): TuiStderrInterceptor {
  const originalWrite = stderr.write;
  let bufferedOutput = "";
  let restored = false;
  const passthrough = Object.create(stderr) as NodeJS.WriteStream;
  type WriteCallback = (err?: Error | null) => void;

  const writeOriginal = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    // write 有三种重载形态，passthrough 必须逐一对齐，否则编码或回调会错位。
    if (typeof encodingOrCallback === "function") {
      return originalWrite.call(stderr, chunk, undefined, encodingOrCallback);
    }

    if (typeof encodingOrCallback === "string") {
      return originalWrite.call(stderr, chunk, encodingOrCallback, callback);
    }

    return originalWrite.call(stderr, chunk);
  };

  passthrough.write = writeOriginal as NodeJS.WriteStream["write"];

  // TUI owns the full terminal. Raw stderr emitted during startup, including
  // Node runtime warnings from static imports, corrupts the screen.
  stderr.write = ((chunk, encodingOrCallback, callback) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    bufferedOutput = (bufferedOutput + stringifyChunk(chunk, encoding)).slice(
      -MAX_BUFFERED_CHARACTERS,
    );

    // 内容被丢弃但仍要回调一次，模拟写完成；否则依赖回调的库会一直等待。
    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (writeCallback) queueMicrotask(() => writeCallback());

    return true;
  }) as NodeJS.WriteStream["write"];

  return {
    get bufferedOutput() {
      return bufferedOutput;
    },
    passthrough,
    restore(options = {}) {
      if (restored) return;
      restored = true;
      stderr.write = originalWrite;

      // 默认不 flush：TUI 正常运行结束时缓冲内容属于噪声；只有崩溃/退出诊断才需要补写。
      if (options.flush === true && bufferedOutput.length > 0) {
        originalWrite.call(stderr, bufferedOutput);
      }
    },
  };
}

// 把 write 入参统一成字符串；Buffer 按调用方给的 encoding 解码，缺省用 UTF-8。
function stringifyChunk(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
}
