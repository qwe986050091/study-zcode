// ============================================================
// 确认窗里调整的两项 run 设置（CreateWorkflow / AmendWorkflow 共用）
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// 三件事，一处实现：
//   1. `resolveInput` 回填的 `adjustable_settings` 块（告诉确认窗这个 agent 会应用窗里改的值）；
//   2. 批准之后把应答里的改动落进入参（executor 经 `ToolEntry.applyInputAdjustments` 调这里）；
//   3. 结果文案里那句「批准之前，用户在确认窗里调整了设置」。
//
// 落进入参之后的形状与 `resolveInput` 的产物完全相同——「一个规范形或没有」「一个数或没有」——所以
// handler、run 端口与 journal 都不需要知道调整发生过；只有模型面的那句话需要。

import {
  parseWorkflowSettingsAdjustment,
  type WorkflowAdjustableSettings,
  type WorkflowSettingsAdjustment,
} from "@zcode/contracts";
import type {
  ToolHandlerFailure,
  ToolInputAdjustmentResult,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { resolveModelReference } from "./model-reference.js";

/** safeParse 即可的运行时 schema（两个工具的 strict 入参 schema）。 */
interface WorkflowInputSchemaLike {
  safeParse(value: unknown): { success: boolean };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 回填块：端口在场才写——没有 run 端口就不会有 run，窗里调什么都无处生效。模型那一格看目录端口：
 * 宿主解不了模型名，窗里就只让调上界（批准之后才因「这里选不了模型」失败，是把接线缺口记到用户头上）。
 */
export function workflowAdjustableSettings(
  context: ToolInputResolutionContext,
): WorkflowAdjustableSettings | undefined {
  const port = context.dynamicWorkflowRunPort;
  // 没有 run 端口 = 本次调用无论怎么调都不会产生 run；回填一个「可调」块只会让确认窗
  // 给用户一个假选项，因此整个块缺席。
  if (port === undefined) return undefined;
  // 线上键名 `concurrency_ceiling` 早于「默认并发」这个概念，为兼容旧端保留；它现在装的是默认
  // 并发 D——步进器的提示与「等于默认 = 不设自己的界」的判据，不是上限。
  const defaultConcurrency = port.defaultConcurrency?.();
  return {
    // 只看目录端口是否存在（不探测具体模型是否可用）：窗里能不能选模型是能力问题，
    // 具体名字解析失败在批准后按业务失败处理，两者不能混。
    subagent_model: context.modelCatalogPort !== undefined,
    // 端口不给默认并发就省略该键：窗里显示「默认是 undefined」比不显示更糟。
    ...(defaultConcurrency === undefined ? {} : { concurrency_ceiling: defaultConcurrency }),
  };
}

/**
 * 给一次成功的归一化结果补上回填块（无条件覆盖模型给的值：伪造它是无效的）。`includeWhen` 让调用方
 * 排除不会开窗的形状——AmendWorkflow 就地调并发的归一化结果没有脚本，也就没有确认窗。
 */
export function withWorkflowAdjustableSettings(
  resolution: ToolInputResolutionResult,
  context: ToolInputResolutionContext,
  includeWhen: (input: Record<string, unknown>) => boolean = () => true,
): ToolInputResolutionResult {
  if (!resolution.result || !isPlainRecord(resolution.input)) return resolution;
  // 无条件剥掉调用方传入的块再以宿主事实覆盖：可调范围是能力声明，伪造它会让确认窗
  // 展示一个根本不存在的选项。`void` 只为满足未使用变量规则。
  const { adjustable_settings: _forged, ...rest } = resolution.input;
  void _forged;
  const block = includeWhen(rest) ? workflowAdjustableSettings(context) : undefined;
  return {
    result: true,
    input: block === undefined ? rest : { ...rest, adjustable_settings: block },
  };
}

/** 窗里选的模型此刻解不出来（被删、被停用，或宿主没有目录）：整次调用失败，什么都不启动。 */
function adjustedModelFailure(errorCode: number, detail: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode,
    message: `workflow_subagent_model_unresolved: the subagent model the user chose in the confirmation window cannot be used now. ${detail} Nothing was started; ask the user which model to use.`,
  };
}

/** 窗里选模型却没有目录：回填块在这种宿主上本来就说了 `subagent_model: false`，只防绕过它的客户端。 */
const ADJUSTED_MODEL_WITHOUT_CATALOG = "This host cannot choose a subagent model.";

/**
 * 把应答里的改动落进一份已归一化的入参。三态与 `AmendWorkflow` 模型面同规：字符串 → 经目录解析成
 * 规范形（窗里送来的就是规范形，命中第一层）；`null` → 删键（会话模型 / 默认并发）；数 → 向下
 * 取整到至少 1，没有上限。与入参原值相同的改动不算生效（`applied` 里没有它），好让结果文案不说一句空话。
 */
export function applyWorkflowSettingsAdjustments(
  input: unknown,
  adjustments: Readonly<Record<string, unknown>>,
  context: ToolInputResolutionContext,
  options: { errorCode: number; schema: WorkflowInputSchemaLike },
): ToolInputAdjustmentResult {
  const adjustment = parseWorkflowSettingsAdjustment(adjustments);
  // 应答形状不认识（老客户端/恶意载荷）时按「没有调整」原样放行：调整是增益能力，
  // 不能反过来让一次本来合法的调用失败。
  if (adjustment === undefined || !isPlainRecord(input)) return { result: true, input };
  const next: Record<string, unknown> = { ...input };
  const applied: WorkflowSettingsAdjustment = {};

  if (adjustment.subagent_model === null) {
    // null 的语义是「恢复会话模型」：删键而不是写一个空值，让下游的缺席/覆盖两态保持清晰。
    // 只有原值确实存在才记进 applied，否则结果文案不会说一句「已改回」的空话。
    if (next.subagent_model !== undefined) applied.subagent_model = null;
    delete next.subagent_model;
  } else if (adjustment.subagent_model !== undefined) {
    const catalog = context.modelCatalogPort;
    // 窗里选了模型却拿不到目录：这是宿主能力缺口，必须让整次调用失败，不能静默退回会话模型。
    if (catalog === undefined) {
      return adjustedModelFailure(options.errorCode, ADJUSTED_MODEL_WITHOUT_CATALOG);
    }
    const resolution = resolveModelReference(adjustment.subagent_model, catalog.listModels());
    if (!resolution.ok) return adjustedModelFailure(options.errorCode, resolution.message);
    // 写入的是解析后的规范串（不是窗里传来的原文）：handler/端口只认规范形。
    // 与入参原值相同则不计入 applied，保持「只说真正变化的东西」。
    if (next.subagent_model !== resolution.canonical) applied.subagent_model = resolution.canonical;
    next.subagent_model = resolution.canonical;
  }

  if (adjustment.max_concurrency === null) {
    // 与模型同规：null = 回到默认并发，删除键让「未设自己的界」这条判据重新成立。
    if (next.max_concurrency !== undefined) applied.max_concurrency = null;
    delete next.max_concurrency;
  } else if (adjustment.max_concurrency !== undefined) {
    // 归一到「向下取整、至少 1、无上限」：窗里给 0 或小数不能让 run 进入一个非法并发状态。
    const bound = normalizeWorkflowMaxConcurrency(adjustment.max_concurrency);
    if (next.max_concurrency !== bound) applied.max_concurrency = bound;
    next.max_concurrency = bound;
  }

  // 落定后的入参必须仍过工具的运行时 schema：handler 只认那一种形状，不为调整另开一条路。
  if (!options.schema.safeParse(next).success) {
    return {
      result: false,
      errorCode: options.errorCode,
      message:
        "workflow_settings_adjustment_invalid: the settings adjusted in the confirmation window did not produce a valid call. Nothing was started.",
    };
  }
  // 没有实际变化时不带 `applied`：handler 结果文案据此判断「用户是否调整过」，
  // 带一个空对象会让它多渲染一句没有信息量的前缀。
  return Object.keys(applied).length === 0
    ? { result: true, input: next }
    : { result: true, input: next, applied };
}

/** handler 读 `context.inputAdjustments`：executor 交来的就是上面的 `applied`，这里只再收一次形状。 */
// 不合法的形状降级成 `{}`（相当于「没调整」）——文案层宁可少说，不能因展示细节让成功调用失败。
export function readAppliedWorkflowSettings(
  inputAdjustments: Readonly<Record<string, unknown>> | undefined,
): WorkflowSettingsAdjustment {
  return parseWorkflowSettingsAdjustment(inputAdjustments) ?? {};
}

/**
 * 结果文案里的那句话（docs/dynamic-workflow/launch.md「Adjusting the settings in the window」）。模型的
 * `tool_use` 块留着它自己传的参数，不说的话它会以为自己要的值在生效，甚至去「纠正」一个正按用户
 * 意思在跑的 run。只说改了的那一半；两个 `null` 各有一句话。以空格开头，直接接在前一句后面。
 */
export function describeWorkflowSettingsAdjustment(
  applied: WorkflowSettingsAdjustment,
  defaultConcurrency: number | undefined,
): string {
  const halves: string[] = [];
  if (applied.subagent_model === null) {
    halves.push("subagents are back on the session model");
  } else if (applied.subagent_model !== undefined) {
    halves.push(
      `subagents run on ${applied.subagent_model} (the main agent stays on the session model)`,
    );
  }
  if (applied.max_concurrency === null) {
    halves.push("the limit on subagents at once is back to the default");
  } else if (applied.max_concurrency !== undefined) {
    const subject =
      applied.max_concurrency === 1
        ? "1 subagent runs"
        : `${applied.max_concurrency} subagents run`;
    halves.push(
      `at most ${subject} at once${defaultConcurrency === undefined ? "" : ` (the default is ${defaultConcurrency})`}`,
    );
  }
  if (halves.length === 0) return "";
  return ` Before approving, the user adjusted the settings in the confirmation window: ${halves.join("; ")}.`;
}

/**
 * 结果文案里的三句设置话：调整句在前，没被调整的那一项照旧用它自己的句子（调整句已经替它说过了的
 * 那一项不再重复）。两个工具共用，好让同一件事在两种结果里是同一句话。
 */
export function describeWorkflowRunSettings(options: {
  applied: WorkflowSettingsAdjustment;
  defaultConcurrency: number | undefined;
  describeLimit: () => string;
  describeModel: () => string;
  /**
   * 脚本点名的模型那一句（列出全部绑定）：窗里改不了它们，所以它总是出现，好让模型下一次调用能
   * 原样贴回每一个规范串。
   */
  describeScriptModels?: () => string;
}): string {
  const { applied, defaultConcurrency } = options;
  return [
    describeWorkflowSettingsAdjustment(applied, defaultConcurrency),
    applied.max_concurrency === undefined ? options.describeLimit() : "",
    applied.subagent_model === undefined ? options.describeModel() : "",
    options.describeScriptModels?.() ?? "",
  ].join("");
}
