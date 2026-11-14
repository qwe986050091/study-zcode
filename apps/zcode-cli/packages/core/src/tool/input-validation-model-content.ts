// ============================================================================
// tool/input-validation-model-content.ts —— 入参校验错误的模型可见投影
// ============================================================================
//
// 【定位】把两套校验来源合并成一条 provider-visible 错误：
//   jsonIssues —— 本地 JSON Schema 校验器（json-schema.ts）产出的结构化 issue，决定
//     模型看到的 missing / unexpected / wrong-type 三类可纠正文案与字段遍历顺序；
//   runtimeIssues —— 工具 runtime schema 解析器（可能是旧版本 parser）产出的 issue，
//     用于判断"错误是否真实存在"，过滤掉 JSON Schema 的误报。
//   两者不是简单前后拼接：按 path + code 做一对一配对，避免破坏字段校验顺序。
//
// 【输出口径】createInitialInputValidationModelContent 返回
//   `<tool_use_error>InputValidationError: ...</tool_use_error>`，即模型看到的原始
//   工具结果片段；字段顺序一旦确定就不再重排，模型按该顺序逐项修正入参。
//
// 【失败与降级】runtime schema 只返回 success=false 而无 issue 时，回退到完整
//   jsonIssues，绝不把 provider-visible 错误退化成空数组；单条 runtime issue 无法
//   归一化时静默跳过（宁缺勿错），由其余 issue 承担解释。
//
// 【不变量】issue 的身份是 code + path + message 三元组；去重只能按该三元组，
//   不能按对象引用或数组位置，否则同一字段的多条不同原因会被误合并。
// ============================================================================

import type { RuntimeInputValidationIssue } from "./input-normalization.js";
import {
  createCustomIssue,
  createInvalidFormatIssue,
  createTooBigIssue,
  createTooSmallIssue,
  type ToolInputValidationIssue,
  type ToolInputValidationPath,
} from "./tool-input-validation-issues.js";
import type { ToolEntry } from "./types.js";

/**
 * 生成"初始入参校验失败"的模型可见内容。
 *
 * @param entry 命中的工具条目；读 inputSchema 用于定位 runtime-only issue 对应的
 *   schema 节点（判断 default、pattern 等），读 metadata.name 作为错误前缀；只读。
 * @param jsonIssues JSON Schema 校验结果，提供字段结构与 missing/unexpected 顺序。
 * @param runtimeIssues runtime schema 的 issue；undefined 或空数组表示 runtime 侧
 *   没有额外信息，直接采用 jsonIssues。
 * @returns 带 `<tool_use_error>` 包装的字符串，作为该 tool_call 的最终内容交给模型。
 * @sideEffect 无；纯投影，不写 session、不发事件、不决定调用是否中断。
 */
export function createInitialInputValidationModelContent(
  entry: ToolEntry,
  jsonIssues: readonly ToolInputValidationIssue[],
  runtimeIssues: readonly RuntimeInputValidationIssue[] | undefined,
): string {
  const issues = projectInitialModelValidationIssues(entry.inputSchema, jsonIssues, runtimeIssues);
  return `<tool_use_error>InputValidationError: ${formatToolInputValidationError(
    entry.metadata.name,
    issues,
  )}</tool_use_error>`;
}

/**
 * 把 issue 列表格式化成模型可读的错误正文（不含 `<tool_use_error>` 包装）。
 *
 * 三类文案各自独立收集，顺序固定为 missing → unexpected → wrongTypes：
 *   missing —— invalid_type 且 message 含 "received undefined"，即字段缺失；
 *   unexpected —— unrecognized_keys 的 keys 原样展开（additionalProperties:false）；
 *   wrongTypes —— 其余 invalid_type，从 message 中提取 received 类型名。
 *
 * @note 只要存在任一条参数级文案，就只输出这三类，忽略 too_small / invalid_union
 *   等值约束问题——参数形态没对之前，取值范围错误对模型没有纠错价值。
 *   三类全空时才回退到完整 issue 的 JSON（2 空格缩进，bigint 转字符串防序列化失败）。
 * @sideEffect 无；不修改入参 issues。
 */
export function formatToolInputValidationError(
  toolName: string,
  issues: readonly ToolInputValidationIssue[],
): string {
  const missingParameters = issues
    .filter(
      (issue) => issue.code === "invalid_type" && issue.message.includes("received undefined"),
    )
    .map((issue) => formatValidationPath(issue.path));
  const unexpectedParameters = issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys : [],
  );
  const wrongTypes = issues.flatMap((issue) => {
    if (issue.code !== "invalid_type" || issue.message.includes("received undefined")) {
      return [];
    }
    return [
      {
        expected: issue.expected,
        param: formatValidationPath(issue.path),
        received: issue.message.match(/received (\w+)/)?.[1] ?? "unknown",
      },
    ];
  });

  const lines: string[] = [
    ...missingParameters.map((parameter) => `The required parameter \`${parameter}\` is missing`),
    ...unexpectedParameters.map(
      (parameter) => `An unexpected parameter \`${parameter}\` was provided`,
    ),
    ...wrongTypes.map(
      ({ expected, param, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    ),
  ];
  // 参数级文案已能解释失败原因，不再追加 JSON 明细，避免同一问题出现两种口径。
  if (lines.length > 0) {
    return `${toolName} failed due to the following ${
      lines.length > 1 ? "issues" : "issue"
    }:\n${lines.join("\n")}`;
  }

  return (
    JSON.stringify(
      issues,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) ?? "[]"
  );
}

/**
 * 把 JSON issues 与 runtime issues 投影成一份有序、无重复的 issue 列表。
 *
 * 设计意图：JSON Schema 提供"应该是什么形状"，runtime parser 提供"实际哪里错了"。
 * 先为每条 jsonIssue 找一条尚未配对的 runtimeIssue（一对一，不复用），配对成功或
 * 该条属于 provider-only 结构问题才保留；随后把 runtime 侧独有的 issue 归一化成
 * 同一套 issue 形状追加。最终顺序以 JSON 投影为准，runtime-only 追加在后并按数组
 * 边界规则微调。runtime 侧没有任何可用 issue 时整体回退到 jsonIssues。
 *
 * @returns 新数组，不复用入参引用；调用方可以安全排序/追加。
 */
function projectInitialModelValidationIssues(
  inputSchema: ToolEntry["inputSchema"],
  jsonIssues: readonly ToolInputValidationIssue[],
  runtimeIssues: readonly RuntimeInputValidationIssue[] | undefined,
): ToolInputValidationIssue[] {
  if (!runtimeIssues || runtimeIssues.length === 0) return [...jsonIssues];

  const expandedRuntimeIssues = expandRuntimeIssues(runtimeIssues, jsonIssues);
  const matchedRuntimeIssues = new Set<number>();
  const matchedJsonIssues = new Map<number, ToolInputValidationIssue>();
  const jsonProjection: ToolInputValidationIssue[] = [];
  const jsonProjectionIdentities = new Set<string>();

  // runtime issues 判断错误是否真实存在，JSON issues 提供目标字段结构。
  // 先建立一对一映射，避免再把两套有序列表直接前后拼接而破坏字段校验顺序。
  for (const jsonIssue of jsonIssues) {
    const matchingRuntimeIndex = expandedRuntimeIssues.findIndex(
      (runtimeIssue, index) =>
        !matchedRuntimeIssues.has(index) && runtimeIssueMatchesJsonIssue(runtimeIssue, jsonIssue),
    );
    if (matchingRuntimeIndex < 0 && !isProviderOnlyStructuralIssue(jsonIssue, inputSchema)) {
      continue;
    }
    if (matchingRuntimeIndex >= 0) {
      matchedRuntimeIssues.add(matchingRuntimeIndex);
      matchedJsonIssues.set(matchingRuntimeIndex, jsonIssue);
    }
    const identity = toolInputIssueIdentity(jsonIssue);
    if (jsonProjectionIdentities.has(identity)) continue;
    jsonProjectionIdentities.add(identity);
    jsonProjection.push(jsonIssue);
  }

  // 参数类错误进入 formatter 后会省略所有其他 issue，因此直接使用 JSON projection
  // 保持 missing / unexpected / wrong type 的目标遍历顺序。
  if (jsonProjection.some(isParameterFormatterIssue)) {
    return jsonProjection;
  }

  const runtimeProjection: ToolInputValidationIssue[] = [];
  const runtimeProjectionIdentities = new Set<string>();
  for (const [index, runtimeIssue] of expandedRuntimeIssues.entries()) {
    const issue =
      matchedJsonIssues.get(index) ?? canonicalizeRuntimeOnlyIssue(runtimeIssue, inputSchema);
    if (!issue) continue;
    const identity = toolInputIssueIdentity(issue);
    if (runtimeProjectionIdentities.has(identity)) continue;
    runtimeProjectionIdentities.add(identity);
    runtimeProjection.push(issue);
  }

  // 非标准 runtime schema 可能只返回 success=false 而没有可读 issue；此时沿用
  // JSON Schema 的完整结果，不能把 provider-visible error 退化成空数组。
  return runtimeProjection.length > 0
    ? orderRuntimeFallbackIssues(runtimeProjection)
    : [...jsonIssues];
}

// 能被 formatToolInputValidationError 转成参数级文案的 issue 只有这两类；
// 一旦命中，formatter 会丢弃其余 issue，因此必须提前用 JSON projection 定序。
function isParameterFormatterIssue(issue: ToolInputValidationIssue): boolean {
  return issue.code === "invalid_type" || issue.code === "unrecognized_keys";
}

/**
 * 按目标 parser 的顺序修正 runtime fallback issue 列表。
 *
 * 已知只有一处版本差异：本地 parser 在解析数组子项之前记录数组 bounds，目标版本在
 * 子项之后记录。这里把数组 bound issue 移到它的最后一个后代 issue 之后；其余 issue
 * 保持 runtime parser 的原始相对顺序，不做全局排序（全局排序会改变同字段多原因的
 * 先后，破坏模型纠错顺序）。
 *
 * @returns 新数组；无数组 bound issue 时顺序与入参完全一致。
 */
function orderRuntimeFallbackIssues(
  issues: readonly ToolInputValidationIssue[],
): ToolInputValidationIssue[] {
  const ordered = [...issues];

  // 本地 parser 在数组子项解析前记录数组 bounds；目标版本在子项之后记录。
  // 除这一个已确认的版本差异外，保留 runtime parser 的原始 issue 顺序。
  for (let issueIndex = ordered.length - 1; issueIndex >= 0; issueIndex -= 1) {
    const issue = ordered[issueIndex];
    if (!issue || !isArrayBoundIssue(issue)) continue;

    let lastDescendantIndex = -1;
    for (
      let candidateIndex = ordered.length - 1;
      candidateIndex > issueIndex;
      candidateIndex -= 1
    ) {
      const candidate = ordered[candidateIndex];
      if (candidate && isStrictDescendantPath(candidate.path, issue.path)) {
        lastDescendantIndex = candidateIndex;
        break;
      }
    }
    if (lastDescendantIndex < 0) continue;

    ordered.splice(issueIndex, 1);
    ordered.splice(lastDescendantIndex, 0, issue);
  }

  return ordered;
}

// 只有 origin=array 的 too_big/too_small 存在上述记录时机差异；字符串/数字边界
// 没有子项，不需要重排。
function isArrayBoundIssue(
  issue: ToolInputValidationIssue,
): issue is Extract<ToolInputValidationIssue, { code: "too_big" | "too_small" }> {
  return (issue.code === "too_big" || issue.code === "too_small") && issue.origin === "array";
}

function isStrictDescendantPath(
  candidate: ToolInputValidationPath,
  parent: ToolInputValidationPath,
): boolean {
  return (
    candidate.length > parent.length &&
    parent.every((segment, index) => candidate[index] === segment)
  );
}

/**
 * 把 invalid_union 展开成各候选分支的具体 issue。
 *
 * runtime parser 可能把 union 失败包成一条 invalid_union，而目标口径要逐个分支的
 * 错误；这里递归展开 unionErrors[].issues。若该 union issue 本身已能与某条 JSON
 * issue 配对（说明 JSON 侧也表达了同一个 union 失败），则保留原样，避免重复解释。
 *
 * @returns 新的扁平 issue 数组；嵌套 union 会被递归展开到底。
 */
function expandRuntimeIssues(
  runtimeIssues: readonly RuntimeInputValidationIssue[],
  jsonIssues: readonly ToolInputValidationIssue[],
): RuntimeInputValidationIssue[] {
  const expanded: RuntimeInputValidationIssue[] = [];
  for (const issue of runtimeIssues) {
    const hasJsonUnion = jsonIssues.some((jsonIssue) =>
      runtimeIssueMatchesJsonIssue(issue, jsonIssue),
    );
    const unionIssues = hasJsonUnion ? [] : readRuntimeUnionIssues(issue);
    if (unionIssues.length > 0) {
      expanded.push(...expandRuntimeIssues(unionIssues, jsonIssues));
    } else {
      expanded.push(issue);
    }
  }
  return expanded;
}

// unionErrors 是 parser 的自由结构，仅接受 "issues 为数组" 的形态；结构不符时
// 返回空数组，让调用方保留原始 invalid_union，而不是猜内部字段。
function readRuntimeUnionIssues(issue: RuntimeInputValidationIssue): RuntimeInputValidationIssue[] {
  if (issue.code !== "invalid_union" || !Array.isArray(issue.unionErrors)) return [];

  return issue.unionErrors.flatMap((unionError) => {
    if (!isRecord(unionError) || !Array.isArray(unionError.issues)) return [];
    return unionError.issues.filter((nestedIssue): nestedIssue is RuntimeInputValidationIssue =>
      isRecord(nestedIssue),
    );
  });
}

/**
 * 判断一条 runtime issue 是否对应某条 JSON issue（配对依据）。
 *
 * 主判据：path 完全相同且归一化后的 code 相同。code 先做 legacy 归并
 * （invalid_enum_value / invalid_literal → invalid_value，invalid_string →
 * invalid_format），否则新旧 parser 的同义错误无法配对。
 *
 * @note 额外兼容旧 parser：缺失 enum/literal 值时它会报 invalid_type + received
 *   "undefined"，而目标口径是 invalid_value；这条特例只在此处放宽，不污染归一化函数。
 */
function runtimeIssueMatchesJsonIssue(
  runtimeIssue: RuntimeInputValidationIssue,
  jsonIssue: ToolInputValidationIssue,
): boolean {
  const runtimePath = readRuntimeIssuePath(runtimeIssue);
  if (!runtimePath || !sameValidationPath(runtimePath, jsonIssue.path)) return false;

  const runtimeCode = normalizeRuntimeIssueCode(runtimeIssue.code);
  if (runtimeCode === jsonIssue.code) return true;

  // 旧 parser 对缺失 enum/literal 使用 invalid_type；目标 issue 使用 invalid_value。
  return (
    runtimeIssue.code === "invalid_type" &&
    runtimeIssue.received === "undefined" &&
    jsonIssue.code === "invalid_value"
  );
}

/**
 * 把一条只有 runtime 侧才有的 issue 转成统一的 ToolInputValidationIssue。
 *
 * 只处理能无损映射的四类：custom（原样取 message）、invalid_string（转 invalid_format）、
 * too_big / too_small（取 type 作 origin、maximum/minimum 作边界）。
 *
 * @returns 无法归一化时返回 undefined——调用方会跳过该条，而不是伪造一个 issue。
 *   宁可少报一条 runtime 细节，也不能让模型看到语义不成立的结构化错误。
 */
function canonicalizeRuntimeOnlyIssue(
  issue: RuntimeInputValidationIssue,
  inputSchema: ToolEntry["inputSchema"],
): ToolInputValidationIssue | undefined {
  const path = readRuntimeIssuePath(issue);
  if (!path || typeof issue.code !== "string") return undefined;

  switch (issue.code) {
    case "custom":
      return createCustomIssue(readRuntimeIssueMessage(issue), path);
    case "invalid_string":
      return canonicalizeRuntimeStringIssue(issue, path, inputSchema);
    case "too_big": {
      const origin = readRuntimeIssueOrigin(issue);
      return origin && typeof issue.maximum === "number"
        ? createTooBigIssue(origin, issue.maximum, path, {
            exact: issue.exact === true,
            inclusive: issue.inclusive !== false,
          })
        : undefined;
    }
    case "too_small": {
      const origin = readRuntimeIssueOrigin(issue);
      return origin && typeof issue.minimum === "number"
        ? createTooSmallIssue(origin, issue.minimum, path, {
            exact: issue.exact === true,
            inclusive: issue.inclusive !== false,
          })
        : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * 归一化 runtime 的字符串格式错误到 invalid_format。
 *
 * url：旧 parser 文案是 "Invalid url"，目标口径是 "Invalid URL"，只改写这一种已知
 *   差异，其余 message 原样透传，避免吞掉 parser 新增的诊断信息。
 * regex：pattern 不在 runtime issue 里，需要按 path 回查 inputSchema 取得；schema
 *   缺失 pattern 时只保留原 message，不臆造模式。
 *
 * @returns 除 url/regex 外的 validation 类型返回 undefined（不支持的格式宁可不投影）。
 */
function canonicalizeRuntimeStringIssue(
  issue: RuntimeInputValidationIssue,
  path: ToolInputValidationPath,
  inputSchema: ToolEntry["inputSchema"],
): ToolInputValidationIssue | undefined {
  if (issue.validation === "url") {
    const message =
      issue.message === "Invalid url" ? "Invalid URL" : readRuntimeIssueMessage(issue);
    return createInvalidFormatIssue("url", message, path);
  }
  if (issue.validation !== "regex") return undefined;

  const schemaNode = readSchemaAtPath(inputSchema, path);
  const pattern = typeof schemaNode?.pattern === "string" ? `/${schemaNode.pattern}/` : undefined;
  const message =
    issue.message === "Invalid" && pattern
      ? `Invalid string: must match pattern ${pattern}`
      : readRuntimeIssueMessage(issue);
  return createInvalidFormatIssue("regex", message, path, {
    origin: "string",
    pattern,
  });
}

/**
 * 判断一条 JSON issue 是否属于"即使 runtime 侧没有配对也应当保留"的结构问题。
 *
 * unrecognized_keys 恒保留：runtime parser 通常不检查未知字段，缺配对不代表该错误
 * 不存在。缺失字段（invalid_type + received undefined）仅在 schema 节点没有 default
 * 时保留——有 default 说明字段本可由默认值补齐，前端报 missing 属于校验器差异。
 *
 * @note schema 节点查不到时按"无 default"处理，保持原有严格口径（宁报勿漏）。
 */
function isProviderOnlyStructuralIssue(
  issue: ToolInputValidationIssue,
  inputSchema: ToolEntry["inputSchema"],
): boolean {
  if (issue.code === "unrecognized_keys") return true;
  if (!isMissingTypeIssue(issue)) return false;
  const schemaNode = readSchemaAtPath(inputSchema, issue.path);
  return !schemaNode || !Object.prototype.hasOwnProperty.call(schemaNode, "default");
}

function isMissingTypeIssue(
  issue: ToolInputValidationIssue,
): issue is Extract<ToolInputValidationIssue, { code: "invalid_type" }> {
  return issue.code === "invalid_type" && issue.message.includes("received undefined");
}

// runtime issue 的 origin 字段叫 type；只接受三种合法单位来源，其余返回 undefined，
// 由 canonicalizeRuntimeOnlyIssue 决定丢弃该 issue。
function readRuntimeIssueOrigin(
  issue: RuntimeInputValidationIssue,
): "array" | "number" | "string" | undefined {
  return issue.type === "array" || issue.type === "number" || issue.type === "string"
    ? issue.type
    : undefined;
}

// runtime issue 的 message 不保证存在；缺省时给一条通用文案，避免 undefined 直接
// 进入 provider-visible 字符串。
function readRuntimeIssueMessage(issue: RuntimeInputValidationIssue): string {
  return typeof issue.message === "string" ? issue.message : "Invalid input";
}

// path 必须全部是 string | number 才算可用；返回浅拷贝，防止后续改写污染
// runtime issue 本体（配对阶段会多次读取同一对象）。
function readRuntimeIssuePath(
  issue: RuntimeInputValidationIssue,
): ToolInputValidationPath | undefined {
  if (
    !Array.isArray(issue.path) ||
    !issue.path.every((segment) => typeof segment === "string" || typeof segment === "number")
  ) {
    return undefined;
  }
  return [...issue.path];
}

// 旧 parser 的三组历史 code 先归并到目标 code，再参与配对：
//   invalid_enum_value / invalid_literal → invalid_value（enum/const 失败）
//   invalid_string → invalid_format（格式失败）
// 其余 code 原样返回，未知类型返回 undefined 表示不可用。
function normalizeRuntimeIssueCode(code: unknown): string | undefined {
  if (code === "invalid_enum_value" || code === "invalid_literal") return "invalid_value";
  if (code === "invalid_string") return "invalid_format";
  return typeof code === "string" ? code : undefined;
}

// path 严格逐段相等（长度 + 每个 segment），不做前缀匹配：父字段的错误不能
// 冒充子字段的配对结果，否则会吞掉子字段的真实原因。
function sameValidationPath(
  left: ToolInputValidationPath,
  right: ToolInputValidationPath,
): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

// issue 的去重键：code + path + message。path 用 JSON.stringify 保留数字下标与
// 字符串字段的区分（"0" 与 0 不会撞键）；message 参与键值，使同一字段的多条
// 不同原因都能保留。
function toolInputIssueIdentity(issue: ToolInputValidationIssue): string {
  return `${issue.code}:${JSON.stringify(issue.path)}:${issue.message}`;
}

/**
 * 按 issue path 在 inputSchema 中定位对应的 schema 节点。
 *
 * 数字段表示数组下标 → 走 items；字符串段表示对象字段 → 走 properties[segment]。
 * 任一层结构不符（不是 object、没有 properties）就返回 undefined；调用方据此
 * 按"无法确认该节点语义"降级，而不是抛出异常。
 */
function readSchemaAtPath(
  schema: ToolEntry["inputSchema"],
  path: ToolInputValidationPath,
): Record<string, unknown> | undefined {
  let current: unknown = schema;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    if (typeof segment === "number") {
      current = current.items;
      continue;
    }
    const properties = current.properties;
    if (!isRecord(properties)) return undefined;
    current = properties[segment];
  }
  return isRecord(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 根字段（path 为空）格式化为空串，让文案自然落成 "The required parameter ``" 之外
// 的形态；数字段统一 `[n]`，字符串段首段原样、后续 `.key`，与工具参数书写习惯一致。
function formatValidationPath(path: ToolInputValidationPath): string {
  if (path.length === 0) return "";
  return path.reduce<string>((formatted, segment, index) => {
    if (typeof segment === "number") return `${formatted}[${segment.toString()}]`;
    return index === 0 ? segment : `${formatted}.${segment}`;
  }, "");
}
