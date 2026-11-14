// INV-01 位置：GENERIC_ZCODE_UI_ERROR_MESSAGES 集合；守住泛化文案清单只含 5 条包装文案；改错故障：把业务提示词误列为泛化，主提示被降级为 Internal error，用户看不到根因。
// INV-02 位置：normalizeString 是唯一字符串净化口；守住去空白后空串一律视为缺失；改错故障：返回未清洗原串会让全空白消息进入界面，气泡只剩空白。
// INV-03 位置：tryParseJsonString 只接受以 { 或 [ 开头的文本；守住普通文案不进解析路径；改错故障：裸标量被当结构解析，候选收集读到空结果。
// INV-04 位置：readValueByPath 每段下钻前的 isObjectRecord 判定；守住 null、数组与原始值视为路径中断；改错故障：对 null 取属性抛异常，渲染期归一化崩溃。
// INV-05 位置：collectMessageCandidatesFromRecord 内的去重 push；守住同一文案只保留首次出现顺序；改错故障：候选重复让主提示与 detail 取到同一条，副标题重复。
// INV-06 位置：messagePaths 中 data.details 与 data.zcode.error 两组分支；守住两条路径不可删；改错故障：Agent 与 CLI 的根因被外层包装文案覆盖，可执行提示丢失。
// INV-07 位置：collectMessageCandidates 对字符串先解析 JSON 再回退原文；守住两条路径有先后且解析成功即提前返回；改错故障：task_error 的整段 JSON 原文会铺满界面。
// INV-08 位置：isObjectRecord(error) 分支内对候选的二次解析；守住候选本身是 JSON 串时继续展开一层；改错故障：二次序列化的 task_error 只显示外层壳，内层 message 丢失。
// INV-09 位置：readFirstStringFromPaths 的全路径未命中返回值；守住明确返回 undefined；改错故障：返回空串会绕过调用处的空值合并，产生空 code 或空 traceId。
// INV-10 位置：readFirstAttributionFromPaths 的 schema 校验；守住 attribution 必须校验通过才透传；改错故障：脏字段进入归因展示，标签渲染出未定义值。
// INV-11 位置：primaryMessage 的四级回退顺序；守住非泛化候选优先、其次首个候选、再 fallbackMessage、最后常量；改错故障：顺序颠倒会让兜底文案盖住真实根因。
// INV-12 位置：primaryMessage 末尾的 Internal error 常量；守住全流程无可用文案时的唯一下限；改错故障：删掉后 message 可能为空，气泡高度与朗读都退化。
// INV-13 位置：detailMessage 排除 primaryMessage 自身；守住主副文案永不重复；改错故障：详情行与标题同文，用户以为界面重复渲染。
// INV-14 位置：codeFromError 中 context.providerCode 的两条路径；守住旧链路只落 context 时仍能取到业务码；改错故障：配额类错误降级成 UNKNOWN，ChatView 横幅无法命中。
// INV-15 位置：detail 中 provider_code= 的正则提取；守住只匹配纯数字段；改错故障：宽松匹配把非业务码文本当码值，错误分类整体错位。
// INV-16 位置：返回对象中 verificationRejectedCode 的最高优先级；守住统一分类层先看到校验业务码；改错故障：外层 PROVIDER_BUSINESS_ERROR 覆盖真实码，横幅与重试引导失效。
// INV-17 位置：traceId 与 taskId 的 options 覆盖顺序；守住显式传入值优先于错误体内值；改错故障：恢复链路传错追踪号，问题无法按 trace 定位。
// INV-18 位置：normalizeRestoredTaskFailureError 对 lastError 的空判断；守住缺失时返回 null 不编造；改错故障：断连恢复后凭空出现无根因错误，误导用户重试。
//
// 模块职责：把任意形态的错误收敛成一份 UI 可直接渲染的 ZCodeUiError，包括文案、业务码、追踪号与归因。
// 状态所有权：纯函数、无内部状态、不缓存不发请求；输入输出都是值，副作用全部留在调用方。
// 阅读顺序：先看 18 条不变量，再依次读形状判定、候选收集、归一化出口、恢复入口。
import type { ZCodeError, ZCodeTaskMeta, TraceId } from "@zcode/shared";
import { errorAttributionSchema, type ErrorAttribution } from "@zcode/shared/zcode-protocol-v4";
import { resolveRequestVerificationBusinessCode } from "@/lib/providerBusinessError.js";

// `ZCodeUiError` 只做错误形状收敛，输出可直接交给错误分类与渲染层。
// attribution、detail 与底层报文均为可选；缺失时保持 undefined，不补空串，以区分「没有」和「空值」。
// 入参类型是 unknown：task_error 可能来自 JSON 串、RPC 结果或字符串化的历史快照，不能假定是 Error。
// `ZCodeUiError` 不弹提示也不写日志：副作用一律留在调用方。
export interface ZCodeUiError extends ZCodeError {
  attribution?: ErrorAttribution;
  detail?: string;
  underlyingErrorMessage?: string;
  underlyingErrorDetail?: string;
}

interface NormalizeZCodeUiErrorOptions {
  fallbackCode?: string;
  fallbackMessage?: string;
  traceId?: TraceId;
  taskId?: string;
}

// 这 5 条是包装文案而非真实根因，命中即视为上游没有给出可用原因。
// 新增业务错误码不要加进这里，否则该错误的主提示会被判成泛化，真根因被藏起来。
// 判定按整串精确匹配，不做包含或大小写折叠，避免误伤内容相近的真实提示。
const GENERIC_ZCODE_UI_ERROR_MESSAGES = new Set([
  "Internal error",
  "Turn execution failed",
  "Compact failed",
  "Rewind failed",
  "ZCode session failed",
]);

// 所有路径读取都先过这个判定，null、数组与原始值一律视为不可下钻。
// 返回类型谓词让分支内可直接索引，全程不引入 any。
// 允许数组通过会读到 length 等下标键，路径匹配出现假阳性。
// 不要与 normalizeString 合并：一个判形状、一个判文本，混用会让空对象被当成缺失。
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// 只对以 { 或 [ 开头的文本尝试解析，普通文案不进解析路径。
// 解析失败返回 null 而不抛错：错误归一化自身绝不能再抛出。
// 解析成功也只给 unknown，形状由调用方再用 isObjectRecord 确认。
function tryParseJsonString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readValueByPath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isObjectRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function collectMessageCandidatesFromRecord(record: Record<string, unknown>): string[] {
  const result: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeString(value);
    if (!normalized || result.includes(normalized)) {
      return;
    }
    result.push(normalized);
  };

  // 候选路径按离根因由近到远排列，顺序影响 detail 的选取，不要随意重排。
  // data.details 与 data.zcode.error 是历史缺口的修复点：Agent 与 CLI 分别把根因放在这里。
  // 删掉任一分支，外层包装文案就会顶上来，界面只剩 Internal error。
  // 这里只声明路径，取值统一走 readValueByPath，保证下钻行为一致。
  const messagePaths: Array<readonly string[]> = [
    ["message"],
    ["detail"],
    ["data", "message"],
    ["data", "detail"],
    // ZCode Agent 常把可读原因放在 data.details（复数）里；之前只识别 detail，
    // 会导致 UI 只能看到 “Internal error” 而丢掉关键可执行提示。
    ["data", "details"],
    ["data", "reason"],
    ["data", "error", "message"],
    ["data", "error", "detail"],
    ["data", "error", "details"],
    // zcode-cli 会把模型/网络错误摘要放在 data.zcode.error 下。
    // 之前 UI 只读 data.error，导致已经结构化好的 provider 根因仍被 “Internal error” 盖住。
    ["data", "zcode", "error", "message"],
    ["data", "zcode", "error", "detail"],
    ["data", "zcode", "error", "details"],
  ];
  for (const path of messagePaths) {
    push(readValueByPath(record, path));
  }

  return result;
}

// 早返回边界只有三处：JSON 串解析出结构化候选、记录型入参收集完、其余落到 String 兜底。
// 字符串入参先解析再回退整段原文，保证 task_error 的 JSON 不会被整块铺到界面。
// 记录型入参会对每个候选再解析一次，兼容字段本身又是一段 JSON 的二次序列化。
// 结果保持首次出现顺序并去重，去重只在 push 内完成，调用点不再各自判重。
// 调换解析与回退顺序，会把原始 JSON 当主提示，用户看到一屏花括号。
function collectMessageCandidates(error: unknown): string[] {
  const result: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeString(value);
    if (!normalized || result.includes(normalized)) {
      return;
    }
    result.push(normalized);
  };

  if (error instanceof Error) {
    push(error.message);
  }

  if (typeof error === "string") {
    const parsed = tryParseJsonString(error);
    if (isObjectRecord(parsed)) {
      for (const candidate of collectMessageCandidatesFromRecord(parsed)) {
        push(candidate);
      }
      if (result.length > 0) {
        return result;
      }
    }
    // task_error 常见为 JSON 字符串，优先展示其中的 message/detail，
    // 只有解析不到结构化字段时才回退到整段原始字符串。
    push(error);
    return result;
  }

  if (isObjectRecord(error)) {
    for (const candidate of collectMessageCandidatesFromRecord(error)) {
      push(candidate);
      const parsed = tryParseJsonString(candidate);
      if (isObjectRecord(parsed)) {
        for (const nestedCandidate of collectMessageCandidatesFromRecord(parsed)) {
          push(nestedCandidate);
        }
      }
    }
    return result;
  }

  push(String(error));
  return result;
}

function readFirstStringFromPaths(
  error: unknown,
  paths: Array<readonly string[]>,
): string | undefined {
  const record = isObjectRecord(error)
    ? error
    : typeof error === "string"
      ? tryParseJsonString(error)
      : null;
  if (!isObjectRecord(record)) {
    return undefined;
  }

  for (const path of paths) {
    const value = normalizeString(readValueByPath(record, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readFirstAttributionFromPaths(error: unknown): ErrorAttribution | undefined {
  const record = isObjectRecord(error)
    ? error
    : typeof error === "string"
      ? tryParseJsonString(error)
      : null;
  if (!isObjectRecord(record)) {
    return undefined;
  }

  const paths: Array<readonly string[]> = [
    ["attribution"],
    ["data", "attribution"],
    ["data", "error", "attribution"],
    ["data", "zcode", "error", "attribution"],
  ];
  for (const path of paths) {
    const parsed = errorAttributionSchema.safeParse(readValueByPath(record, path));
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

// 入口只做一次抽取，所有分支最终汇聚到同一个返回对象，不产生中间可变状态。
// options 的 traceId 与 taskId 是调用方显式事实，优先级高于错误体内自带的同名字段。
// provider_code 的解析放在 message 之后，因为它依赖 primaryMessage 参与校验码判定。
// attribution 必须通过 schema 校验才透传，脏数据宁可丢弃也不进入归因展示。
// 失败路径：字段全缺失时仍要返回结构完整的对象，只允许 code 落 UNKNOWN、message 落下限文案。
// 在任一步抛错都会让错误处理本身失败，界面失去可渲染的错误对象。
export function normalizeZCodeUiError(
  error: unknown,
  options: NormalizeZCodeUiErrorOptions = {},
): ZCodeUiError {
  const candidates = collectMessageCandidates(error);
  // zcode-cli 已经把 provider/network 根因放进 detail 或 data.zcode.error，
  // 外层仍可能保留 "Internal error" 这类包装文案。主提示优先选非泛化候选，避免根因被盖住。
  // 主提示的选择顺序：首个非泛化候选、首个候选、fallbackMessage、Internal error。
  // 非泛化优先是为了让 provider 根因越过外层包装，这是本模块最容易被改坏的一处。
  // detail 只取与主提示不同且非泛化的候选，保证标题与详情不重复。
  // 把 fallbackMessage 提到候选之前，所有真实根因都会被兜底文案顶掉。
  // 去掉最终常量后 message 可能为空，气泡高度与朗读都会退化。
  const primaryMessage =
    candidates.find((candidate) => !GENERIC_ZCODE_UI_ERROR_MESSAGES.has(candidate)) ??
    candidates[0] ??
    options.fallbackMessage ??
    "Internal error";
  const detailMessage = candidates.find(
    (candidate) => candidate !== primaryMessage && !GENERIC_ZCODE_UI_ERROR_MESSAGES.has(candidate),
  );
  const codeFromError = readFirstStringFromPaths(error, [
    ["code"],
    ["providerCode"],
    ["data", "code"],
    ["data", "error", "code"],
    ["data", "zcode", "error", "code"],
    // turn-errors 会把 provider 业务码写入 summary.code；部分链路仍只落在 context.providerCode。
    ["data", "zcode", "error", "context", "providerCode"],
    ["data", "error", "context", "providerCode"],
    ["context", "providerCode"],
  ]);
  const detailFromError = readFirstStringFromPaths(error, [
    ["detail"],
    ["data", "detail"],
    ["data", "error", "detail"],
    ["data", "zcode", "error", "detail"],
  ]);
  const underlyingErrorMessage = readFirstStringFromPaths(error, [
    ["underlyingErrorMessage"],
    ["data", "underlyingErrorMessage"],
    ["data", "error", "underlyingErrorMessage"],
    ["data", "zcode", "error", "underlyingErrorMessage"],
  ]);
  const underlyingErrorDetail = readFirstStringFromPaths(error, [
    ["underlyingErrorDetail"],
    ["data", "underlyingErrorDetail"],
    ["data", "error", "underlyingErrorDetail"],
    ["data", "zcode", "error", "underlyingErrorDetail"],
  ]);
  const providerCodeFromDetail = detailFromError?.match(/provider_code=([0-9]+)/)?.[1];
  const verificationRejectedCode = resolveRequestVerificationBusinessCode(
    codeFromError ?? providerCodeFromDetail,
    primaryMessage,
  );
  const traceIdFromError = readFirstStringFromPaths(error, [
    ["traceId"],
    ["data", "traceId"],
    ["data", "error", "traceId"],
    ["data", "zcode", "error", "traceId"],
  ]) as TraceId | undefined;
  const taskIdFromError = readFirstStringFromPaths(error, [
    ["taskId"],
    ["data", "taskId"],
    ["data", "error", "taskId"],
    ["data", "zcode", "error", "taskId"],
  ]);
  const attribution = readFirstAttributionFromPaths(error);

  return {
    // 部分上游错误外层 code 只是 PROVIDER_BUSINESS_ERROR，
    // 真实 GLM / zcode-plan 业务码只保存在 detail 的 provider_code=xxxx。
    // 业务码需要进入统一错误分类层，否则 ChatView quota 横幅无法命中。
    // code 的优先级：校验业务码、detail 中的 provider_code、错误体 code、fallbackCode、UNKNOWN。
    // 外层常常只给 PROVIDER_BUSINESS_ERROR，真实 GLM 与 zcode-plan 业务码只存在于 detail 文本里。
    // 业务码必须进入统一分类层，否则 ChatView 的配额横幅与重试引导都命中不了。
    // provider_code 只从 detail 的 provider_code= 数字段提取，不做模糊匹配。
    // 把 codeFromError 提前，真实业务码会被外层包装码覆盖，错误分类整体降级。
    code:
      verificationRejectedCode ??
      providerCodeFromDetail ??
      codeFromError ??
      options.fallbackCode ??
      "UNKNOWN",
    message: primaryMessage,
    detail: detailMessage,
    ...(underlyingErrorMessage ? { underlyingErrorMessage } : {}),
    ...(underlyingErrorDetail ? { underlyingErrorDetail } : {}),
    traceId: options.traceId ?? traceIdFromError,
    taskId: options.taskId ?? taskIdFromError,
    ...(attribution ? { attribution } : {}),
  };
}

// 恢复入口只读服务端持久化的 lastError，缺失时返回 null，不编造兜底错误。
// traceId 与 taskId 以 lastError 内的值为先，缺失才回落到任务元数据。
// 在无 lastError 时返回一个空错误，断连恢复后用户会看到没有根因的失败提示。
export function normalizeRestoredTaskFailureError(meta: ZCodeTaskMeta): ZCodeUiError | null {
  if (!meta.lastError) {
    return null;
  }

  // Bugfix: 手机 Web 断连恢复时可能只拿到 error snapshot，看不到断连期间的 task_error。
  // 没有服务端持久化的 lastError 时不再编造兜底文案，避免展示没有实际根因的错误。
  return normalizeZCodeUiError(meta.lastError, {
    fallbackCode: meta.lastError.code,
    traceId: meta.lastError.traceId ?? meta.traceId,
    taskId: meta.lastError.taskId ?? meta.taskId,
  });
}
