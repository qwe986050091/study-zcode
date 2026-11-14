// 通用取值与格式化工具模块：提供 payload 安全读取、字段校验与展示层格式化。
// 边界：只处理传入值，不读全局状态、不做 IO；字段缺失一律降级为 undefined 而非抛错。
// 口径：string 空串等同缺失、number 仅接受有限值、boolean 不接受字符串"true"/"false"。
// 失败语义：所有导出对畸形输入都有确定性回退（如 asRecord 返回空对象、formatDuration 返回 "-"）。
import type { SessionEvent } from "@zcode/contracts";
import type { TuiPromptInput } from "./types.js";

// 统一 prompt 输入的两种形态（纯文本 / 带附件对象），输出文本与附件数量。
// 字符串输入视作 0 个附件；对象输入 attachments 缺失时按 0 计，不读取附件内容。
// 纯函数，不做校验或截断，调用方自行处理空文本。
export const normalizePromptInput = (
  input: TuiPromptInput,
): { text: string; attachmentCount: number } => {
  if (typeof input === "string") {
    return {
      attachmentCount: 0,
      text: input,
    };
  }

  return {
    attachmentCount: input.attachments?.length ?? 0,
    text: input.text,
  };
};

// 把 SessionEvent 的事件类型转成状态栏可读文案：下划线替换为空格。
// 非对象/缺 type 时返回 "session event"，保证状态栏始终有可展示文本。
// 仅用于展示，不解析 payload；事件语义判断仍应基于 type 分支而非该文案。
export const describeSessionEvent = (event: SessionEvent): string => {
  if (typeof event !== "object" || event === null) return "session event";
  const type = "type" in event && typeof event.type === "string" ? event.type : "session event";
  return type.replaceAll("_", " ");
};

// 安全地把 unknown 转成 Record；null、数组等非普通对象统一降级为空对象。
// 返回原对象引用而非拷贝，调用方只应读取字段，不要就地修改事件 payload。
// 数组也会被接受（typeof 为 object），因此仅当确认上游为键值对象时使用。
export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

// 读取非空字符串字段；类型不符或空串返回 undefined，保持"缺省"与"空值"同一语义。
// 不做 trim，保留上游原值（含前后空白），是否清理由具体展示层决定。
// 不做类型转换，数字/布尔字段需使用对应函数读取，避免隐式字符串化。
export const stringField = (
  value: Record<string, unknown>,
  key: string,
): string | undefined => {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

// 只接受有限数值；NaN/Infinity 视为字段缺失，防止格式化输出 "NaN"。
// 不校验业务值域（正负、上下限）——是否合法由调用方按字段语义判断。
// 0 是合法值，不会被当作缺失，调用方需用 `=== undefined` 而不是真值判断。
export const numberField = (
  value: Record<string, unknown>,
  key: string,
): number | undefined => {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

// 严格布尔判定：只有 true/false 返回值，其余类型返回 undefined。
// 不接受字符串 "true"/"false"，避免上游 JSON 序列化差异改变 UI 控制流。
// false 是合法值，调用方应显式判断 undefined 而非真值，否则会把"明确关闭"当作缺失。
export const booleanField = (
  value: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
};

// 数字千分位格式化固定使用 en-US，避免随宿主 locale 变化影响快照测试。
// 仅用于展示；小数与超大值交给 Intl 处理，不做额外舍入。
// 输出即最终字符串，调用方不要再拼接自己的分隔符。
export const formatNumber = (value: number): string => value.toLocaleString("en-US");

// 将毫秒时长格式化为紧凑文案：<1s 用 ms，<10s 保留一位小数，其余取整秒。
// undefined/非有限值/负数统一返回 "-"，不抛错，便于直接用于状态栏。
export const formatDuration = (durationMs: number | undefined): string => {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "-";
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1_000)}s`;
};

// 按字符数截断并追加 "..."；maxLength<=3 时省略省略号，避免结果反而变长或为空。
// 按 UTF-16 码元计数，"..." 占 3 个码元，因此返回值长度不会超过 maxLength。
// 与按显示列宽的 truncateDisplay 不同，这里不处理宽字符，只适合窄字符场景（如纯数字/键名）。
export const truncatePlain = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, Math.max(0, maxLength));
  return `${value.slice(0, maxLength - 3)}...`;
};

// 大小写不敏感的子串匹配；空 query 视为匹配任意项（展示全部候选）。
// values 中的 undefined 项直接跳过，便于直接传入候选对象里的可选字段。
// 只做包含匹配，不做模糊/拼音匹配；多字段任一命中即返回 true。
export const matchesText = (query: string, values: Array<string | undefined>): boolean => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => value?.toLowerCase().includes(normalized));
};
