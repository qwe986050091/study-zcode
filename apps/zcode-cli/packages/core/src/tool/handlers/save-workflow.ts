// ============================================================
// SaveWorkflow Tool Handler
// ============================================================
// 把一段 dwf 脚本连同元数据存成项目里的可复用定义。
//
// 形状刻意与 CreateWorkflow 同构，因为对模型来说这是同一件事的两个动词：
//   1. 先用**同一个**检查器编译脚本。编不过 → 直接回诊断，不弹窗、不落盘。让用户去批准
//      一段编不过的代码，只会用一个不产生任何效果的决策打断 agent 自己的改错重试回路
//      （create-workflow.ts 的同一条注释）。
//   2. 干净 → 确认窗。写文件进用户的仓库是一次不可撤销的外向动作，永远要问。
//   3. Allow → 落盘。
//
// 与 CreateWorkflow 的关键差别在**确认窗要问的问题**：那边问"要不要花这笔钱跑这段代码"，
// 这边问"要不要把这段代码留在仓库里、以后可能被别人再跑"。回答它所需的事实——落点、
// 元数据、以及**这次是新建还是覆盖**——由 `resolveInput` 算进归一化入参，本工具因此
// 刻意**不带任何 display**：入参通道对每个客户端版本都是无 schema 的透传，而 display 上
// 的新字段旧客户端读不到、甚至会让整块载荷校验不过（见 tool-result-metadata.ts 的
// 字段集合注释）。新桌面按 toolName 读入参渲染富确认块，覆盖与否由 `overwrite` 字段区分；
// 旧桌面与 legacy v3 得到通用权限提示 + 完整入参 JSON——降级但内容完整。

import {
  SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
  SAVE_WORKFLOW_SOURCE_ERROR,
  SAVE_WORKFLOW_TOOL_NAME,
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SaveWorkflowInputJsonSchema,
  SaveWorkflowInputSchema,
  SaveWorkflowOutputJsonSchema,
  SaveWorkflowOutputSchema,
  isValidSavedWorkflowName,
  type ModelMessageContent,
  type SaveWorkflowInput,
  type SaveWorkflowOutput,
  type SavedWorkflowMeta,
} from "@zcode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolHandler,
  ToolInputResolutionResult,
  ToolInputValidationResult,
} from "../types.js";
import { SAVE_WORKFLOW_TOOL_DESCRIPTION } from "./save-workflow-description.js";
import {
  SAVED_WORKFLOW_SENTINEL,
  findSavedWorkflowShadowing,
  savedWorkflowExists,
  savedWorkflowPath,
  savedWorkflowRoot,
  saveSavedWorkflow,
} from "./saved-workflows/index.js";
import { readWorkflowScriptFile } from "./workflow-path-source.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { requireDynamicWorkflowSkill } from "./workflow-skill-gate.js";

// 单位与口径：
// - TIMEOUT_MS：毫秒。编译与落盘都在本地同步完成，15s 只是防挂死的上界，不允许调用方覆盖。
// - MODEL_BYTES：模型可见结果的 UTF-8 字节上限（inline/model/preview 三处同值）；诊断通常
//   只有几行，24KB 足够回显一份长脚本的出错片段。
// - FAILURE_CODE：业务失败码（400 = 入参不可用），与「技能未加载」的 428 分开，调用方与模型
//   都能不靠文本区分"改参数"与"先读技能"。
const SAVE_WORKFLOW_TIMEOUT_MS = 15_000;
const SAVE_WORKFLOW_MODEL_BYTES = 24_000;
const SAVE_WORKFLOW_FAILURE_CODE = 400;

// 诊断失败时追加给模型的一句话：必须明确"什么都没写"，否则模型容易在下一轮向用户
// 汇报"已保存"，而磁盘上其实没有文件。
const DIAGNOSTICS_NOT_SAVED_NOTE =
  "NOTE: Nothing was saved — fix the errors above and call the tool again.";

/** 元数据视图：输入的三个字段拢成 frontmatter 要写的那个对象。 */
function toMeta(parsed: SaveWorkflowInput): SavedWorkflowMeta {
  return {
    description: parsed.description,
    ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
    ...(parsed.args === undefined ? {} : { args: parsed.args }),
  };
}

/**
 * 模型入参上的语义校验，在 hook 之前收口。
 *
 * 自带 frontmatter 的脚本按业务失败拒绝，而**不做**「检测到就替换」的聪明合并：合并之后
 * 模型无从分辨自己传的 description 和文件里那个哪一个生效，而 encode 的幂等性（文件里
 * 永远只有一个 frontmatter 块）也就没了守卫。
 */
function validateSaveWorkflowInput(input: unknown): ToolInputValidationResult {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true };

  if (!isValidSavedWorkflowName(parsed.data.name)) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: `'${parsed.data.name}' is not a usable workflow name: names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters.`,
    };
  }

  const hasScript = parsed.data.script !== undefined;
  const hasScriptPath = parsed.data.script_path !== undefined;
  if (hasScript === hasScriptPath) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: SAVE_WORKFLOW_SOURCE_ERROR,
    };
  }

  // 自带 frontmatter 的检查只对**内联**正文成立：`script_path` 指的常常是一份从保存定义抄来的
  // 草稿，它本来就带着块，而 `resolveInput` 会把块丢掉。对它报错等于禁掉这条路径的主要用法。
  if (parsed.data.script?.trimStart().startsWith(SAVED_WORKFLOW_SENTINEL) === true) {
    return {
      result: false,
      errorCode: SAVE_WORKFLOW_FAILURE_CODE,
      message: SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR,
    };
  }

  return { result: true };
}

/**
 * 归一化：把落点、覆盖判定与遮蔽事实算出来填进入参。
 *
 * 这些事实是确认窗的决策关键内容（批准一次覆盖 = 同意丢掉磁盘上那一份；遮蔽提示 = 告诉用户
 * 这份定义在本项目里会不会被同名的另一档挡住），走**入参**而不是 display，因为入参通道对每个
 * 客户端版本都是无 schema 的透传——旧桌面与 legacy v3 因此也拿得到完整内容，而 display 上的
 * 新字段它们读不到，甚至会让整块载荷校验不过。
 *
 * 作用域不再回填：它是模型必填字段，这里只按它选根算 `path` / `overwrite` / `shadowing`。
 */
async function resolveSaveWorkflowInput(
  input: unknown,
  cwd: string,
): Promise<ToolInputResolutionResult> {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  if (!parsed.success) return { result: true, input };

  // `script_path` 先读成正文：确认窗要展示将要落盘的那串字节，而窗在 handler 之前。
  // 块被丢掉（只留正文）——元数据由本次调用的字段说了算，那才是用户批准的东西。
  let script = parsed.data.script;
  if (parsed.data.script_path !== undefined) {
    const read = await readWorkflowScriptFile({ cwd, inputPath: parsed.data.script_path });
    if (!read.ok) {
      return { result: false, errorCode: SAVE_WORKFLOW_FAILURE_CODE, message: read.message };
    }
    script = read.file.script;
  }

  const { scope, name } = parsed.data;
  const shadowing = findSavedWorkflowShadowing({ cwd, name, scope });
  return {
    result: true,
    input: {
      ...parsed.data,
      ...(script === undefined ? {} : { script }),
      path: savedWorkflowPath(savedWorkflowRoot(cwd, scope), name),
      overwrite: savedWorkflowExists({ cwd, name, scope }),
      // 无同名时省略该键：一个 undefined 会给每次保存挂一个噪音字段。
      ...(shadowing === undefined ? {} : { shadowing }),
    } satisfies SaveWorkflowInput,
  };
}

/**
 * 编译 → 落盘的执行体；确认与归一化已在 executor 侧完成，这里不再弹窗。
 *
 * 输入：resolveInput 归一化后的入参——`script` 已由 `script_path` 读入，`path`/`overwrite`
 *   已按 scope 算好。输出：SaveWorkflowOutput；`diagnostics` 恒在，`overwritten` 只在
 *   ok=true 时出现。
 * 副作用：`saveSavedWorkflow` 同步写一个（可能覆盖）文件到项目或全局工作流目录；这是本
 *   工具唯一的外向动作。
 * 失败/降级：脚本编译失败 → 不落盘、返回 ok=false 的诊断输出（是可预期业务结果，不是
 *   工具失败）；写盘失败（只读挂载、权限）**向上冒泡**成工具调用失败，绝不吞成"已保存"。
 * 不变量：`overwritten` 由写的那一刻重新判定，不读入参里的 `overwrite`——那个字段是给
 *   确认窗和 hook 看的事实，而 hook 能改写入参，让它决定落盘自述会把展示字段变成行为开关。
 */
const saveWorkflowHandler: ToolHandler = async (input, context) => {
  const parsed = SaveWorkflowInputSchema.parse(input) as SaveWorkflowInput;
  const cwd = context.workingDirectory ?? ".";
  const scope = parsed.scope;
  // 落点由归一化填好；缺席只可能是有人绕过了 executor 的生命周期，此时自己算一遍而不是崩。
  const path = parsed.path ?? savedWorkflowPath(savedWorkflowRoot(cwd, scope), parsed.name);
  const script = parsed.script;
  if (script === undefined) {
    // 到不了：validateInput 挡掉「两个都不给」，resolveInput 会把 `script_path` 读成 `script`。
    // 真发生了说明有人绕过了 executor 的生命周期，说出来好过静默存一个空文件。
    throw new Error("SaveWorkflow handler received input without a resolved script");
  }

  const { diagnostics, ok } = analyzeScript(script);
  if (!ok) {
    return {
      name: parsed.name,
      scope,
      path,
      diagnostics,
      ok,
      response: [
        "The workflow script has errors:",
        ...diagnostics.map(
          (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
        ),
        "",
        DIAGNOSTICS_NOT_SAVED_NOTE,
      ].join("\n"),
    } satisfies SaveWorkflowOutput;
  }

  // 写失败（只读挂载、权限）向上冒泡成工具调用失败：绝不吞成一个报告了路径的成功输出，
  // 那会让模型据此告诉用户"已保存"。
  //
  // `overwritten` 由**写的那一刻**重新判定，不读入参里那个 `overwrite`：入参上的那个是给
  // 确认窗与 hook 看的事实，而 hook 能改写入参——让它改变落盘后的自述会把一个展示字段
  // 变成一个行为开关。
  const written = saveSavedWorkflow({
    cwd,
    name: parsed.name,
    meta: toMeta(parsed),
    script,
    scope,
  });

  const isGlobal = written.scope === "global";
  return {
    name: parsed.name,
    scope: written.scope,
    path: written.path,
    diagnostics,
    ok,
    overwritten: written.overwritten,
    response: [
      written.overwritten
        ? isGlobal
          ? `Replaced the saved global workflow '${parsed.name}' at ${written.path}.`
          : `Replaced the saved workflow '${parsed.name}' at ${written.path}.`
        : isGlobal
          ? `Saved global workflow '${parsed.name}' to ${written.path}.`
          : `Saved the workflow '${parsed.name}' to ${written.path}.`,
      `Run it with CreateWorkflow using \`saved: { name: "${parsed.name}" }\`.`,
    ].join(" "),
  } satisfies SaveWorkflowOutput;
};

/**
 * 判断"把这段脚本写进仓库"值不值得打断用户。
 *
 * **不带 display**：确认窗要展示的一切——脚本、元数据、落点、是不是覆盖——都已经在归一化
 * 入参里了。新桌面按 `toolName === "SaveWorkflow"` 读入参渲染富确认块，旧桌面与 legacy v3
 * 得到带完整入参的通用权限提示：降级但内容完整，而且在**所有**版本组合上成立。往
 * display 上加一个新 kind 反而只有新客户端读得到（见 tool-result-metadata.ts 的注释）。
 *
 * 编不过的脚本直接放行给 handler：它会回诊断且不落盘，没有可裁决的东西就不该有窗。
 */
function prepareSaveWorkflowApproval(input: unknown): ToolApprovalGate {
  const parsed = SaveWorkflowInputSchema.safeParse(input);
  // 归一化之后 `script` 必在场；缺席即有人绕过了生命周期，此时放行给 handler 报错。
  if (!parsed.success || parsed.data.script === undefined) return { gate: "proceed" };
  return analyzeScript(parsed.data.script).ok ? { gate: "ask" } : { gate: "proceed" };
}

/**
 * 把 output 收窄成模型可见文本：只取 `response`（一句"已保存/已替换 + 路径 + 如何再跑"）。
 *
 * 结构化字段（diagnostics/ok/overwritten/path）不重复回显——确认窗与调用方读的是归一化
 * 入参和 output 本体。schema 不匹配时返回固定占位而不抛错：落盘已经发生，序列化阶段的
 * 失败不能反过来把一次成功的保存改写成工具失败。
 */
function formatSaveWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = SaveWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "SaveWorkflow returned an invalid result.";
  return parsed.data.response;
}

/**
 * SaveWorkflow 的工具声明。
 *
 * 接线顺序（由 executor 保证）：validateInput（名字/来源互斥/内联哨兵）→ resolveInput
 *   （技能门 + 落点与覆盖归一化）→ prepareApproval（只有能编译的脚本才弹窗）→ handler
 *   （编译 + 落盘）。
 * 关键取舍：`alwaysAsk: true` 且 `askOptions.allowAlways: false`——写进用户仓库的决定不可
 *   被持久规则记住，否则一次"总是允许"会把之后每次保存都变成静默写入。
 * 降级：刻意不带 display；确认窗要展示的脚本、元数据、落点、是否覆盖全在归一化入参里，
 *   旧桌面与 legacy v3 也能拿到完整内容（display 新字段它们读不到，甚至可能整块校验不过）。
 * 并发：`concurrentSafe:false`——两次保存同名定义会互相覆盖，必须串行。
 */
export const saveWorkflowToolEntry: ToolEntry = {
  capability:
    "Typecheck a dynamic-workflow script and, once confirmed, save it into the project as a reusable definition",
  metadata: {
    shouldDefer: true,
    name: SAVE_WORKFLOW_TOOL_NAME,
    description: SAVE_WORKFLOW_TOOL_DESCRIPTION,
    readOnly: false,
    // 覆盖一个已有定义会丢掉磁盘上那一份，但确认窗会先把这件事说清楚；与 Write 同档。
    destructive: false,
    concurrentSafe: false,
    timeoutMs: SAVE_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: SAVE_WORKFLOW_MODEL_BYTES,
    // 写的是项目里的一个文件，与 Write/Edit 同一个作用域。
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
  },
  handler: saveWorkflowHandler,
  validateInput: (input) => validateSaveWorkflowInput(input),
  // 把落点与覆盖判定算进入参：确认窗与 hook 读的是同一份事实，且对所有客户端版本可见。
  resolveInput: (input, context) =>
    // 技能门先于落点解析（handlers/workflow-skill-gate.ts）：保存的也是一段脚本。
    requireDynamicWorkflowSkill(context, SAVE_WORKFLOW_TOOL_NAME) ??
    resolveSaveWorkflowInput(input, context.workingDirectory ?? "."),
  prepareApproval: prepareSaveWorkflowApproval,
  inputSchema: SaveWorkflowInputJsonSchema,
  outputSchema: SaveWorkflowOutputJsonSchema,
  runtimeInputSchema: SaveWorkflowInputSchema,
  runtimeOutputSchema: SaveWorkflowOutputSchema,
  formatModelContent: formatSaveWorkflowModelContent,
  permission: {
    permission: "saveWorkflow",
    // 诊断用，不面向用户：确认窗自己渲染本地化标题。
    reason: "saveWorkflow.confirmation: user must confirm writing the workflow into the project",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 与 CreateWorkflow 同档：写进仓库的东西会被提交、被别人看见、以后被再次运行，
    // 任何权限模式（含 yolo / plan）都要先问。
    alwaysAsk: true,
    // 每次调用写的是不同的文件与不同的内容，持久项目规则记不住"这一次的决定"，
    // 只会把这道确认永久关掉。
    askOptions: { allowAlways: false },
  },
  resultBudget: {
    maxInlineBytes: SAVE_WORKFLOW_MODEL_BYTES,
    maxModelBytes: SAVE_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: SAVE_WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: SAVE_WORKFLOW_TIMEOUT_MS,
    maxMs: SAVE_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "SaveWorkflow typechecks and writes synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
