// 警告拦截器句柄：既暴露统计量，也提供恢复入口。
interface RuntimeWarningInterceptor {
  // 自安装以来被压制的行数（只增不减），仅供测试/诊断，不进入用户输出。
  readonly suppressedCount: number;
  // 恢复原始 write；幂等，重复调用无副作用。
  restore(): void;
}

// stderr.write 的回调签名（Node 允许 err 为 null）。
type WriteCallback = (err?: Error | null) => void;

// 需要静默的已知噪声：都是 Node 运行时或 AI SDK 在开发态固定浇出的文案。
// 全部采用整行精确匹配（含行首进程号与行尾锚点），避免误伤用户自己的同类文本。
const SQLITE_EXPERIMENTAL_WARNING =
  /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?$/;
const MODULE_REGISTER_DEPRECATION_WARNING =
  /^\(node:\d+\) \[DEP0205\] DeprecationWarning: `module\.register\(\)` is deprecated\. Use `module\.registerHooks\(\)` instead\.\r?$/;
const NODE_TLS_REJECT_UNAUTHORIZED_WARNING =
  /^\(node:\d+\) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification\.\r?$/;
// Node 紧跟在被压制警告后追加的"如何显示调用栈"提示；与主警告成对出现，必须跟着一起丢掉。
const TRACE_WARNINGS_HINT =
  /^\(Use `[^`]+ --trace-(?:warnings|deprecation) \.\.\.` to show where the warning was created\)\r?$/;
const AI_SDK_WARNING_SYSTEM =
  /^AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false\.\r?$/;
const AI_SDK_ANTHROPIC_THINKING_BUDGET_WARNING =
  /^AI SDK Warning \(anthropic\.messages \/ [^)]+\): The feature "extended thinking" is used in a compatibility mode\. thinking budget is required when thinking is enabled\. using default budget of \d+ tokens\.\r?$/;

// 在 stderr 上安装一次性警告过滤器。
// 输入：stderr 为 CLI 实际使用的错误流；必须是同一对象，否则恢复会写回错误的流。
// 输出：拦截器句柄；suppressedCount 记录压制行数，restore 幂等地恢复原 write。
// 副作用：替换 stderr.write，并逐 chunk 按行过滤；安装期间所有警告都经过白名单判断。
// 降级语义：未知警告与真实错误一律原样透传；空 write 视为 flush 屏障，直接交给底层。
// 维护的不变量：过滤只能删除整行，不能改写保留行的内容与换行。
export function interceptKnownRuntimeWarnings(
  stderr: NodeJS.WriteStream,
): RuntimeWarningInterceptor {
  const originalWrite = stderr.write;
  let restored = false;
  let suppressedCount = 0;
  let dropNextTraceHint = false;

  const writeOriginal = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    if (typeof encodingOrCallback === "function") {
      return originalWrite.call(stderr, chunk, undefined, encodingOrCallback);
    }

    if (typeof encodingOrCallback === "string") {
      return originalWrite.call(stderr, chunk, encodingOrCallback, callback);
    }

    return originalWrite.call(stderr, chunk, undefined, callback);
  };

  // Node/AI SDK dependency warnings can be emitted during headless
  // provider setup before ZCode can format them as actionable diagnostics. Keep
  // these known notices out of user-facing CLI stderr while preserving normal
  // errors and unknown warnings.
  stderr.write = ((chunk, encodingOrCallback, callback) => {
    const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
    const text = stringifyChunk(chunk, encoding);
    // 空 write 是退出前的 flush barrier，必须等底层队列完成，不能当成被过滤的警告。
    if (text.length === 0) return writeOriginal(chunk, encodingOrCallback, callback);
    const filtered = filterKnownRuntimeWarningChunk(text, {
      onSuppressed: () => {
        suppressedCount += 1;
      },
      get dropNextTraceHint() {
        return dropNextTraceHint;
      },
      set dropNextTraceHint(value: boolean) {
        dropNextTraceHint = value;
      },
    });

    const writeCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (filtered.length === 0) {
      // 整块都被过滤时仍要异步回调，模拟一次完成的 write，避免调用方等待永不触发的回调。
      if (writeCallback) queueMicrotask(() => writeCallback());
      return true;
    }

    return writeOriginal(filtered, encoding, writeCallback);
  }) as NodeJS.WriteStream["write"];

  return {
    get suppressedCount() {
      return suppressedCount;
    },
    restore() {
      if (restored) return;
      restored = true;
      stderr.write = originalWrite;
    },
  };
}

function filterKnownRuntimeWarningChunk(
  text: string,
  state: {
    dropNextTraceHint: boolean;
    onSuppressed(): void;
  },
): string {
  // 按行切分并保留原换行符：未命中白名单的 segment 原样拼回，保证输出字节不变。
  const segments = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let output = "";

  for (const segment of segments) {
    const line = segment.endsWith("\n") ? segment.slice(0, -1) : segment;

    if (
      SQLITE_EXPERIMENTAL_WARNING.test(line) ||
      MODULE_REGISTER_DEPRECATION_WARNING.test(line) ||
      NODE_TLS_REJECT_UNAUTHORIZED_WARNING.test(line)
    ) {
      // 这三类警告后面通常紧跟一条 trace 提示，先置位以便消费下一行。
      state.dropNextTraceHint = true;
      state.onSuppressed();
      continue;
    }

    if (AI_SDK_WARNING_SYSTEM.test(line) || AI_SDK_ANTHROPIC_THINKING_BUDGET_WARNING.test(line)) {
      state.onSuppressed();
      continue;
    }

    if (state.dropNextTraceHint && TRACE_WARNINGS_HINT.test(line)) {
      state.dropNextTraceHint = false;
      state.onSuppressed();
      continue;
    }

    // 看到任何有效内容行就清除等待态：trace 提示只允许紧邻主警告出现，否则可能误吞后续输出。
    if (line.trim().length > 0) {
      state.dropNextTraceHint = false;
    }
    output += segment;
  }

  return output;
}

// 把 write 的入参统一成字符串用于匹配；Buffer 按调用方给的 encoding 解码。
function stringifyChunk(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(encoding);
}
