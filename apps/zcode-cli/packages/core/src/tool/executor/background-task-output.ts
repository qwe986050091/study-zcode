/**
 * 后台任务的输出元数据投影（不是持久化记录，也不是模型 content）。
 *
 * 字段口径：所有 `*Bytes` 都是**已落盘输出的 UTF-8 字节数**，不是字符数；所有 `*File`
 * 都是 artifact 落盘路径；所有 `*Tail` 是给 UI/通知看的**尾部预览文本**（字符口径），
 * 不参与模型预算。`outputTruncated` 缺席表示"无法判断"，不等于"未截断"。
 *
 * 消费者：BackgroundTask* SessionEvent payload、V4 Running 行详情、TaskOutput 投影；
 * 本文件只做只读投影，不写盘、不改 runtime-task registry。
 */
export interface BackgroundTaskOutputMetadata {
  childSessionId?: string;
  outputBytes?: number;
  outputFile?: string;
  outputTail?: string;
  outputTruncated?: boolean;
  stderrBytes?: number;
  stderrFile?: string;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutFile?: string;
  stdoutTail?: string;
}

/**
 * 从后台任务快照 / 启动输出中提取一份展示用输出元数据。
 *
 * 输入：`snapshot` 是工具 handler 产出的结果快照（可含 `result.stdout/stderr`、`output`）；
 * `launchOutput` 是启动阶段回填的原始输出，只在快照尚未成型时补齐缺失字段。
 * 取值来源只有这三处，具体优先级按字段而定：显式的快照字段 / 快照内嵌 result 优先，
 * `launchOutput` 仅作早期兜底（快照尚未成型时）。
 *
 * 输出：`outputBytes` 仅在 stdout/stderr 至少一方有字节时给出总和；两方都缺席时为
 * undefined，避免把"未知"报成 0。`outputTail` 按 stdout → stderr → workflow.response
 * 的顺序取第一个非空文本。
 *
 * 无副作用、不抛错：所有属性读取都走类型守卫，坏形状只会令对应字段缺席。
 */
export function backgroundTaskOutputMetadata(
  snapshot: object | undefined,
  launchOutput?: Record<string, unknown>,
): BackgroundTaskOutputMetadata {
  // 为什么：Bash/Agent handler 的 stdout/stderr 字节与截断标记挂在 result 下；
  // 顶层的同名字节字段是老快照的兼容来路，所以下面读字节时 result 优先、顶层兜底。
  const result = recordProperty(snapshot, "result");
  // 后台 Agent 的 child session 身份若只留在 Agent output / runtime
  // snapshot，BackgroundTask* 事件就不会带出，V4 Running 行因此无法打开右侧详情。
  const childSessionId =
    stringProperty(snapshot, "childSessionId") ?? stringProperty(launchOutput, "childSessionId");
  const stdout = recordProperty(result, "stdout");
  const stderr = recordProperty(result, "stderr");
  const stdoutFile =
    stringProperty(snapshot, "stdoutPersistedOutputPath") ??
    stringProperty(stdout, "artifactPath") ??
    stringProperty(launchOutput, "stdoutPersistedOutputPath");
  const stderrFile =
    stringProperty(snapshot, "stderrPersistedOutputPath") ??
    stringProperty(stderr, "artifactPath") ??
    stringProperty(launchOutput, "stderrPersistedOutputPath");
  // 兜底顺序从"更权威的显式路径"到"从流推出来的路径"：快照顶层可能是早期占位，
  // stdout/stderr 的 artifactPath 才是真正的落盘事实。
  const outputFile =
    stringProperty(snapshot, "outputPath") ??
    stringProperty(snapshot, "outputFile") ??
    stringProperty(snapshot, "persistedOutputPath") ??
    stringProperty(snapshot, "rawOutputPath") ??
    stringProperty(launchOutput, "persistedOutputPath") ??
    stringProperty(launchOutput, "rawOutputPath") ??
    stringProperty(launchOutput, "outputFile") ??
    stdoutFile ??
    stderrFile;
  const stdoutBytes =
    numberProperty(stdout, "bytes") ??
    numberProperty(snapshot, "stdoutBytes");
  const stderrBytes =
    numberProperty(stderr, "bytes") ??
    numberProperty(snapshot, "stderrBytes");
  const stdoutTail =
    stringProperty(stdout, "text") ||
    stringProperty(snapshot, "stdoutTail");
  const stderrTail =
    stringProperty(stderr, "text") ||
    stringProperty(snapshot, "stderrTail");
  const workflowOutput = recordProperty(snapshot, "output");
  const workflowTail = stringProperty(workflowOutput, "response");
  // 注意：一方字节已知、另一方缺席时按 0 计总和；只有两方都缺席才报 undefined。
  // "只有 stdout" 与 "完全不知道" 是两个不同事实，不能都压成 0。
  const outputBytes =
    stdoutBytes === undefined && stderrBytes === undefined
      ? undefined
      : (stdoutBytes ?? 0) + (stderrBytes ?? 0);
  // 反直觉：result 缺席时给 undefined 而不是 false——没有 result 就无从判断是否截断，
  // 下游会把 undefined 渲染成"未标记"，不能据此断言内容完整。
  const outputTruncated =
    result === undefined
      ? undefined
      : booleanProperty(stdout, "truncated") === true ||
        booleanProperty(stderr, "truncated") === true ||
        booleanProperty(stdout, "artifactTruncated") === true ||
        booleanProperty(stderr, "artifactTruncated") === true;

  return {
    childSessionId,
    outputBytes,
    outputFile,
    // stdout 优先于 stderr：正常输出才是主体，stderr 只在 stdout 缺席时兜底；
    // workflow run 没有流，产物摘要走 output.response。
    outputTail: stdoutTail ?? stderrTail ?? workflowTail,
    outputTruncated,
    stderrBytes,
    stderrFile,
    stderrTail,
    stdoutBytes,
    stdoutFile,
    stdoutTail,
  };
}

/** 属性存在且值为对象时返回；数组也会通过（这里只用于读 stdout/stderr 等结构化块）。 */
function recordProperty(
  record: object | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return isRecord(value) ? value : undefined;
}

/** 只接受 `typeof string`；空串也原样返回，是否可用由调用方判断。 */
function stringProperty(record: object | undefined, key: string): string | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** 只接受 `typeof number`；字节数口径由上游保证，这里不额外过滤 NaN/Infinity。 */
function numberProperty(record: object | undefined, key: string): number | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

/** 只接受真正的 boolean；`undefined` 与 `false` 的区别对 truncated 语义是关键的，不能强转。 */
function booleanProperty(record: object | undefined, key: string): boolean | undefined {
  if (!record || !(key in record)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * 本文件私有的对象判定：只认 `typeof object && !== null`，**包含数组**。
 * 与 utils.ts 的 `isRecord`（排除数组）不同，这里只用来读命名属性，数组不会被误用。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
