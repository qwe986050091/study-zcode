// INV-01 表单形状由声明决定：守住位置 buildSavedWorkflowArgFields；改错故障 旧实参凭空长出字段。
// INV-02 initialArgs 优先于 default：守住位置 三元选择；改错故障 「再次运行」丢失上次实参。
// INV-03 空文本对非 boolean 等于不传：守住位置 trim 长度判断；改错故障 空串被当成合法实参下发。
// INV-04 必填且无默认值才是 required 错误：守住位置 双条件；改错故障 有默认值的字段也报必填。
// INV-05 boolean 永远有值：守住位置 提前返回；改错故障 布尔字段被当成缺席。
// INV-06 number 必须有限：守住位置 Number.isFinite；改错故障 NaN 进入 JSON 请求。
// INV-07 错误一次收齐：守住位置 collectSavedWorkflowArgs；改错故障 用户逐个提交逐个报错。
// INV-08 声明空表回 undefined：守住位置 rowsToArgsDeclaration 收尾；改错故障 frontmatter 出现空 args 键。
// INV-09 名字只要求非空且唯一：守住位置 seen 集合；改错故障 合法但非标识符的名字被拒。
// INV-10 行身份用下标加名字：守住位置 key 生成；改错故障 重命名导致行重建、输入框失焦。
// INV-11 默认值文本按类型解析：守住位置 parseDefaultText；改错故障 布尔默认值以字符串落库。
// INV-12 描述与 required 只在有值时写入：守住位置 条件展开；改错故障 声明里出现空描述键。
// INV-13 格式化与解析必须互为逆运算：守住位置 formatSavedWorkflowArgValue；改错故障 往返后值变形。
//
// 模块职责：已保存工作流实参表单与元数据实参表的纯函数转换层。
// 阅读顺序：先看声明到字段，再看字段到实参袋，最后看实参表到声明。
// 已保存工作流的实参表单与元数据实参表。
// 纯函数：把 frontmatter 的 args 声明铺成可编辑字段，再把字段收回成实参袋 / 声明；
// 校验规则与 CLI 的 validateWorkflowArgs 同源（required、按类型解析、default 回填由服务端做）。
import type { ZCodeSavedWorkflowArgType, ZCodeSavedWorkflowArgsDeclaration } from "@zcode/shared";

export interface SavedWorkflowArgField {
  name: string;
  type: ZCodeSavedWorkflowArgType;
  description?: string;
  required: boolean;
  hasDefault: boolean;
  /** 编辑器里的文本；boolean 用 "true" / "false"。 */
  value: string;
}

export type SavedWorkflowArgFieldError = "required" | "invalid_number" | "invalid_json";

/** 把一个默认值 / 已有值按类型转成编辑器文本。 */
// undefined 时按类型给初值：布尔给 false，其余给空串。
// 字符串原样返回，非字符串退回 JSON 序列化。
// json 默认缩进两格，便于在单行输入框里也能看清结构。
export function formatSavedWorkflowArgValue(
  type: ZCodeSavedWorkflowArgType,
  value: unknown,
): string {
  if (value === undefined) return type === "boolean" ? "false" : "";
  switch (type) {
    case "string":
      return typeof value === "string" ? value : JSON.stringify(value);
    case "number":
      return typeof value === "number" ? String(value) : String(value);
    case "boolean":
      return value === true ? "true" : "false";
    case "json":
      return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  }
}

/**
 * 声明 → 可编辑字段。`initialArgs` 在场时逐个字段**优先**用它的值（完成卡「再次运行」把这次
 * run 跑过的那一份实参预填进来，docs/dynamic-workflow/transcript-and-notifications.md「Run again」）：
 * 上一次跑成了什么，下一次多半还要跑什么。声明里没有的键不进表单——表单的形状由声明决定，
 * 一份旧实参不该凭空长出字段。
 */
// `fields` 遍历声明而不是实参：表单形状只由 `parseArgsSchema` 决定。
// initialArgs 命中字段就优先，未命中才回落到 default。
// description 为 undefined 时不写键，保持对象干净。
export function buildSavedWorkflowArgFields(
  declaration: ZCodeSavedWorkflowArgsDeclaration | undefined,
  initialArgs?: Record<string, unknown>,
): SavedWorkflowArgField[] {
  if (!declaration) return [];
  return Object.entries(declaration).map(([name, spec]) => {
    const initial = initialArgs?.[name];
    return {
      name,
      type: spec.type,
      ...(spec.description === undefined ? {} : { description: spec.description }),
      required: spec.required === true,
      hasDefault: spec.default !== undefined,
      value: formatSavedWorkflowArgValue(spec.type, initial === undefined ? spec.default : initial),
    };
  });
}

type SavedWorkflowArgParse =
  | { ok: true; omitted: true }
  | { ok: true; omitted: false; value: unknown }
  | { ok: false; error: SavedWorkflowArgFieldError };

/**
 * 单个字段 → 实参值。空文本对 string / number / json 意味着「不传」：有默认值的由服务端回填，
 * 无默认值又非必填的就是缺席；必填而空是唯一的 required 错误。boolean 永远有值。
 */
// 布尔字段永远返回有值，空文本按 false 处理。
// 空文本对其它类型表示不传，是否报错由必填与默认值共同决定。
// number 与 json 的失败要分开报，提示文案不同。
// json 解析失败只记错误码，不把异常抛给调用方。
export function parseSavedWorkflowArgField(field: SavedWorkflowArgField): SavedWorkflowArgParse {
  const raw = field.value;
  if (field.type === "boolean") {
    return { ok: true, omitted: false, value: raw === "true" };
  }
  if (raw.trim().length === 0) {
    if (field.required && !field.hasDefault) return { ok: false, error: "required" };
    return { ok: true, omitted: true };
  }
  switch (field.type) {
    case "string":
      return { ok: true, omitted: false, value: raw };
    case "number": {
      const parsed = Number(raw.trim());
      // NaN / Infinity 过不了 JSON，也过不了 CLI 的 number 校验；在这里就拦下来。
      if (!Number.isFinite(parsed)) return { ok: false, error: "invalid_number" };
      return { ok: true, omitted: false, value: parsed };
    }
    case "json": {
      try {
        return { ok: true, omitted: false, value: JSON.parse(raw) as unknown };
      } catch {
        return { ok: false, error: "invalid_json" };
      }
    }
  }
}

type SavedWorkflowArgsCollect =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: Record<string, SavedWorkflowArgFieldError> };

/** 整张表单 → 实参袋；一次收齐全部错误（照 validateWorkflowArgs 的「不逐个报」）。 */
// 有任一错误就整表失败，错误按字段名归集。
// 省略的字段不进结果，服务端据此回填默认值。
export function collectSavedWorkflowArgs(
  fields: readonly SavedWorkflowArgField[],
): SavedWorkflowArgsCollect {
  const args: Record<string, unknown> = {};
  const errors: Record<string, SavedWorkflowArgFieldError> = {};
  for (const field of fields) {
    const parsed = parseSavedWorkflowArgField(field);
    if (!parsed.ok) {
      errors[field.name] = parsed.error;
      continue;
    }
    if (!parsed.omitted) args[field.name] = parsed.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, args };
}

// ── 元数据编辑：实参声明表 ──

export interface SavedWorkflowArgRow {
  /** 行的稳定身份（新增行也要有，名字可空）。 */
  key: string;
  name: string;
  type: ZCodeSavedWorkflowArgType;
  required: boolean;
  /** 默认值的编辑文本；空即无默认值（boolean 用 "" / "true" / "false"）。 */
  defaultText: string;
  description: string;
}

export type SavedWorkflowArgRowError = "empty_name" | "duplicate_name" | "invalid_default";

// key 用下标加名字，重命名会让这一行重建，这是刻意的取舍。
// 布尔默认值单独走 true 与 false 文本，其余复用格式化函数。
export function argsDeclarationToRows(
  declaration: ZCodeSavedWorkflowArgsDeclaration | undefined,
): SavedWorkflowArgRow[] {
  if (!declaration) return [];
  return Object.entries(declaration).map(([name, spec], index) => ({
    key: `${index}:${name}`,
    name,
    type: spec.type,
    required: spec.required === true,
    defaultText:
      spec.default === undefined
        ? ""
        : spec.type === "boolean"
          ? spec.default === true
            ? "true"
            : "false"
          : formatSavedWorkflowArgValue(spec.type, spec.default),
    description: spec.description ?? "",
  }));
}

function parseDefaultText(
  type: ZCodeSavedWorkflowArgType,
  text: string,
): { ok: true; value?: unknown } | { ok: false } {
  if (text.trim().length === 0) return { ok: true };
  switch (type) {
    case "string":
      return { ok: true, value: text };
    case "number": {
      const parsed = Number(text.trim());
      return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false };
    case "json":
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false };
      }
  }
}

type SavedWorkflowArgRowsCollect =
  | { ok: true; args: ZCodeSavedWorkflowArgsDeclaration | undefined }
  | { ok: false; errors: Record<string, SavedWorkflowArgRowError> };

/**
 * 实参表 → 声明。名字只要求非空且唯一（声明本就是 record，`args.x` 的读法不限定标识符）；
 * 空表回 undefined（frontmatter 里就没有 args 键，而不是 `args: {}`）。
 */
// 空名与重名分别报错，重名判定基于 trim 后的结果。
// 默认值解析失败不落库，避免半合法声明进入 frontmatter。
// 空表返回 undefined，语义是「没有 args 键」而不是空对象。
export function rowsToArgsDeclaration(
  rows: readonly SavedWorkflowArgRow[],
): SavedWorkflowArgRowsCollect {
  const errors: Record<string, SavedWorkflowArgRowError> = {};
  const seen = new Set<string>();
  const args: ZCodeSavedWorkflowArgsDeclaration = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name.length === 0) {
      errors[row.key] = "empty_name";
      continue;
    }
    if (seen.has(name)) {
      errors[row.key] = "duplicate_name";
      continue;
    }
    seen.add(name);
    const parsedDefault = parseDefaultText(row.type, row.defaultText);
    if (!parsedDefault.ok) {
      errors[row.key] = "invalid_default";
      continue;
    }
    const description = row.description.trim();
    args[name] = {
      type: row.type,
      ...(description.length === 0 ? {} : { description }),
      ...(row.required ? { required: true } : {}),
      ...(parsedDefault.value === undefined ? {} : { default: parsedDefault.value }),
    };
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, args: Object.keys(args).length === 0 ? undefined : args };
}
