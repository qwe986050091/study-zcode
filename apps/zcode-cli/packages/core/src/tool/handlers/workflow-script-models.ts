// ============================================================
// 脚本点名的模型：解析成绑定表、解不出来的报成 9011（CreateWorkflow / AmendWorkflow / 直接启动 / GUI 配置共用）
// ============================================================
// 见 docs/dynamic-workflow/launch.md「Models the script names」与
// docs/dynamic-workflow/authoring.md「Choosing a model per subagent」。
//
// 编译器保证脚本能交给子代理的模型名是一个封闭集合（9010），分析结果以 `modelReferences` 交出来。
// 这里做编译器做不了的那一半——对着**本机**的模型目录解析每个名字：
//
//   - `resolveInput` 把解出来的写进入参的 `model_bindings`（名字逐字 → 规范串）；
//   - `prepareApproval` 看到有名字没绑定就不开窗；
//   - handler 把没绑定的名字报成 9011 诊断，走「编不过」那条路（文件行、改文件、`path` 重交）。
//
// 解不出来的名字**不是**调用的业务失败（不像解不出来的 `subagent_model`）：它写在脚本里，改的是
// 脚本文件，所以它该长得和编译错误一模一样，而不是一句让模型去改参数的话。

import {
  MODEL_UNRESOLVED_CODE,
  type AnalyzeResult,
  type ModelReference,
} from "@zcode/dynamic-workflow";
import type { CreateWorkflowDiagnostic, ModelCatalogPort, ModelSelection } from "@zcode/contracts";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import type { ToolInputResolutionResult } from "../types.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import { resolveModelReference } from "./model-reference.js";

/** 名字 → 规范串 `providerId/modelId[$level]`。 */
export type ScriptModelBindings = Record<string, string>;

/** 宿主没有模型目录时，每个名字的 9011 文案（脚本侧的改法，不是参数侧的）。 */
export const SCRIPT_MODELS_UNAVAILABLE =
  "This host cannot choose models; remove `model` from the personas (the subagents then run on the run's subagent model).";

/**
 * 解析一个名字的结果。`inherited` 在场说明绑定是从前驱沿用来的（`AmendWorkflow` / GUI 配置）：
 * 那一支解的是前驱记下的规范串，失败文案要说清是「沿用的那个模型没了」，否则模型会去改一个
 * 它根本没写错的名字。
 */
type NameResolution = { ok: true; canonical: string } | { ok: false; message: string };

// 解析单个名字，三条优先级：无目录 → 统一能力文案；有前驱绑定 → 解前驱的规范串；
// 否则解名字本身。顺序是刻意的：前驱绑定代表用户在上一轮确认窗里做过的选择，不能被
// 「重新按名字解析」悄悄覆盖。
function resolveName(
  name: string,
  catalog: ModelCatalogPort | undefined,
  inherited: ScriptModelBindings | undefined,
): NameResolution {
  if (catalog === undefined) return { ok: false, message: SCRIPT_MODELS_UNAVAILABLE };
  const entries = catalog.listModels();
  const previous = inherited?.[name];
  if (previous !== undefined) {
    // 沿用前驱的绑定：解的是它记下的规范串（命中第一档），不是名字本身——用户在前驱的确认窗
    // 里给这个名字换过模型的话，重新解析名字会悄悄把那次选择撤掉。
    const resolution = resolveModelReference(previous, entries);
    if (resolution.ok) return { ok: true, canonical: resolution.canonical };
    return {
      ok: false,
      message: `"${name}" keeps the model the amended run bound it to, ${previous}, which cannot be used now. ${resolution.message}`,
    };
  }
  const resolution = resolveModelReference(name, entries);
  if (resolution.ok) return { ok: true, canonical: resolution.canonical };
  return {
    ok: false,
    message: `The model "${name}" named in the script cannot be used: ${resolution.message}`,
  };
}

/** 去重后的名字，按第一次出现的顺序（确认窗画行、结果文案列名字都用这个序）。 */
// 顺序稳定是有意为之：同一脚本重复提交时，确认窗与诊断的排列不能随机漂移。
export function distinctModelNames(references: readonly ModelReference[]): string[] {
  return [...new Set(references.map((reference) => reference.name))];
}

/**
 * 把脚本点名的每个名字解析成绑定表。只收解得出来的；解不出来的不进表——`prepareApproval` 与
 * handler 都以「有名字没绑定」为准，所以失败不需要第二个载体。
 */
export function resolveScriptModelBindings(
  names: readonly string[],
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): ScriptModelBindings {
  const bindings: ScriptModelBindings = {};
  for (const name of names) {
    const resolution = resolveName(name, catalog, inherited);
    // 失败名字不写入（哪怕是空串占位）：下游以「键存在」判断已绑定，占位会让未解析的名字
    // 混过 prepareApproval 的检查。
    if (resolution.ok) bindings[name] = resolution.canonical;
  }
  return bindings;
}

/**
 * `resolveInput` 的最后一步：编译归一化后的脚本（单槽记忆让后面两次编译免费），把 `model_bindings`
 * 写进入参。**无条件覆盖**模型给的值（与 `adjustable_settings` 同一个姿态：伪造它是无效的）；脚本
 * 编不过或没点名任何模型时整个键缺席。
 */
export function withScriptModelBindings(
  input: Record<string, unknown>,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): Record<string, unknown> {
  // 先剥掉模型/旧 hook 传来的同名键再以本次解析覆盖：绑定表是宿主事实，不接受调用方伪造。
  const { model_bindings: _forged, ...rest } = input;
  void _forged;
  const script = rest.script;
  // 没有内联正文（例如纯 amend 设定）时无从分析，原样放行；需要绑定的路径会另行解析。
  if (typeof script !== "string") return rest;
  const analysis = analyzeScript(script);
  // 编不过就交给 handler 的「编译诊断」路径；这里不提前报 9011，也不伪造空绑定表。
  if (!analysis.ok) return rest;
  const names = distinctModelNames(analysis.modelReferences);
  if (names.length === 0) return rest;
  const bindings = resolveScriptModelBindings(names, catalog, inherited);
  // 一个都解不出来时整个键缺席（不是空对象）：确认窗与 handler 都以「键缺席 = 无需绑定」
  // 与「有名字没绑定」配合判断，空对象会让两者都误判为「全都处理好了」。
  return Object.keys(bindings).length === 0 ? rest : { ...rest, model_bindings: bindings };
}

/** {@link withScriptModelBindings} 套在一次归一化结果上：失败原样放行，成功的入参补上绑定表。 */
export function withScriptModelBindingsResolved(
  resolution: ToolInputResolutionResult,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): ToolInputResolutionResult {
  if (!resolution.result) return resolution;
  const input = resolution.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return resolution;
  return {
    result: true,
    input: withScriptModelBindings(input as Record<string, unknown>, catalog, inherited),
  };
}

/** 入参里的绑定表（`resolveInput` 写的那一张；hook 若改坏了形状就当没有）。 */
// 逐键只接受 string 值：形状损坏时宁可丢整张表（下游会重新报 9011/重新解析），
// 也不把 undefined/对象当规范串传给端口。
export function readScriptModelBindings(input: unknown): ScriptModelBindings {
  if (typeof input !== "object" || input === null) return {};
  const raw = (input as { model_bindings?: unknown }).model_bindings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const bindings: ScriptModelBindings = {};
  for (const [name, canonical] of Object.entries(raw)) {
    if (typeof canonical === "string") bindings[name] = canonical;
  }
  return bindings;
}

/** 脚本点名的名字是否全都有绑定（`prepareApproval` 据此决定开不开窗）。 */
// 用 `!== undefined` 而不是 truthy：空串绑定不存在，但用 truthy 会把「已解出但规范串为空」
// 误判成未绑定；前者是接线故障，应交给执行期暴露，而不是在确认窗前静默改变行为。
export function allScriptModelsBound(
  analysis: AnalyzeResult,
  bindings: ScriptModelBindings,
): boolean {
  return analysis.modelReferences.every((reference) => bindings[reference.name] !== undefined);
}

/**
 * 没有绑定的名字 → 9011 诊断，**每个名字一条**，落在它第一次出现的位置。每处都报会把最长四十行的
 * 候选清单重复 N 遍；改一处就改对了的名字，报一处就够。文案重新解析一遍得来（handler 手里有目录），
 * 所以 `resolveInput` 不必把失败文案塞进入参。
 */
export function unresolvedScriptModelDiagnostics(
  analysis: AnalyzeResult,
  bindings: ScriptModelBindings,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): CreateWorkflowDiagnostic[] {
  const diagnostics: CreateWorkflowDiagnostic[] = [];
  const reported = new Set<string>();
  for (const reference of analysis.modelReferences) {
    // 已绑定或本名字已报过就跳过：同一名字在脚本里可能出现多次，但确认/修复单位是名字，
    // 不是出现位置，重复报只会淹没其他诊断。
    if (bindings[reference.name] !== undefined || reported.has(reference.name)) continue;
    reported.add(reference.name);
    const resolution = resolveName(reference.name, catalog, inherited);
    diagnostics.push({
      code: MODEL_UNRESOLVED_CODE,
      line: reference.line,
      column: reference.column,
      // 到这里却解得出来，只可能是目录在 resolveInput 之后变了（provider 刚被加回来）。仍然报：
      // 用户批准的窗（或没开的窗）不含这个模型，悄悄用上它就是一个没人看过的选择。
      message: resolution.ok
        ? `The model "${reference.name}" became available only after this call was checked; submit the script again.`
        : resolution.message,
    });
  }
  return diagnostics;
}

/** 绑定表 → 端口要的结构化选择。解不开的规范串是接线故障（`resolveInput` 写的一定解得开）。 */
// 所以这里抛错而不是跳过：静默丢掉一个用户已批准的模型选择，会让 run 用错模型且没有提示。
// 空表返回 undefined（「没有覆盖」与「覆盖为空」对端口是两件事）。
export function scriptModelSelections(
  bindings: ScriptModelBindings,
): Record<string, ModelSelection> | undefined {
  const names = Object.keys(bindings);
  if (names.length === 0) return undefined;
  const selections: Record<string, ModelSelection> = {};
  for (const name of names) {
    try {
      selections[name] = parseModelPickerValue(bindings[name]!);
    } catch (cause) {
      throw new Error(`workflow model_bindings reached the handler un-canonicalised: ${name}`, {
        cause,
      });
    }
  }
  return selections;
}

/**
 * 结果文案里的那句话（docs/dynamic-workflow/launch.md「Models the script names」）：说的是规范串，
 * 模型可以原样贴进下一次调用。只在表非空时出现；以空格开头，接在设置句后面。
 */
export function describeScriptModelBindings(bindings: ScriptModelBindings): string {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return "";
  const pairs = entries.map(([name, canonical]) => `"${name}" = ${canonical}`);
  return ` Models named in the script: ${pairs.join("; ")}.`;
}

/**
 * 不经确认窗的两条启动路（中枢直接启动、GUI 配置）一步做完：解析全部名字，交出端口要的选择与
 * 没绑定的名字的 9011。`unbound` 非空时调用方拒绝，`selections` 不用。
 */
export function bindScriptModels(
  analysis: AnalyzeResult,
  catalog: ModelCatalogPort | undefined,
  inherited?: ScriptModelBindings,
): {
  selections: Record<string, ModelSelection> | undefined;
  unbound: CreateWorkflowDiagnostic[];
} {
  const bindings = resolveScriptModelBindings(
    distinctModelNames(analysis.modelReferences),
    catalog,
    inherited,
  );
  const unbound = unresolvedScriptModelDiagnostics(analysis, bindings, catalog, inherited);
  // 有未绑定名字时不构造 selections：调用方会据此拒绝启动，构造一份不完整的映射只会
  // 提供一条「部分模型静默生效」的错误路径。
  return { selections: unbound.length > 0 ? undefined : scriptModelSelections(bindings), unbound };
}
