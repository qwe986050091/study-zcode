/* oxlint-disable eslint(max-lines) -- summary 与同源 detail 投影暂集中维护，本次 review fix 不扩大重构范围。 */
//
// 职责边界：把 CUA（computer use）工具调用的模型输入与工具结果，投影成摘要行与详情模型。
// 本文件不持有状态、不发请求、不读平台接口，任何输出都只由传入的 toolCall 决定。
// 所有 unknown 都先经 asRecord / readText / readNumber 收口，禁止直接下标访问。
//
// INV-01 断言：工具名必须先归一化成小写、把连字符压成下划线，再判断是否含有 computer_use 段 —— 守住它的位置：normalizeCuaToolName 与 readCuaToolName —— 改错故障：main 的 plugin 命名空间写法被漏判，CUA 工具退化成普通工具卡。
// INV-02 断言：动作名只取最后一个双下划线之后的短段，且必须是纯小写字母、数字与下划线 —— 守住它的位置：readCuaToolName 的 lastSep 分支 —— 改错故障：把命名空间段当成动作名，摘要永远落到默认文案。
// INV-03 断言：任何 unknown 都必须先经 asRecord 收窄成对象，数组、null 与原始值一律视为无 —— 守住它的位置：asRecord —— 改错故障：数组被当成记录读取，字段全是 undefined 却仍渲染出空标签。
// INV-04 断言：文本必须去空白后非空才算存在 —— 守住它的位置：readText —— 改错故障：空串被当成有效值，详情出现只有标签没有内容的空行。
// INV-05 断言：数字必须是有限数才可用 —— 守住它的位置：readNumber —— 改错故障：NaN 进入时长插值，界面显示 NaN 秒。
// INV-06 断言：应用标识的读取顺序固定为 app、app_ref、记录自身 —— 守住它的位置：readBundleId 的容器循环 —— 改错故障：外层同名键抢占内层，图标挂到错误应用上。
// INV-07 断言：新结果带 authority 元数据时，定位列表为空也不回退模型输入 —— 守住它的位置：readCuaApplicationIconRequest 的 display 分支 —— 改错故障：身份冲突后重新显示未经 Helper 校验的旧图标。
// INV-08 断言：成功必须同时满足 display 未失败、工具调用未失败、无错误详情、权限就绪 —— 守住它的位置：buildCuaDetailsModel 的 success —— 改错故障：MCP 传输成功被当成动作成功，失败卡片显示成绿勾。
// INV-09 断言：失败时不得挂截图 —— 守住它的位置：screenshot 的三元赋值 —— 改错故障：失败截图渲染成空白占位，真正的失败原因被挤下去。
// INV-10 断言：元素目标要求 type 为 element 且 index 是数字，坐标目标要求 x 与 y 同时是数字 —— 守住它的位置：readTargetDescription —— 改错故障：只差一个分量也生成目标行，内容显示 undefined。
// INV-11 断言：失败原因与建议动作只对 element_stale 走专用文案，其余错误才用 display 文本 —— 守住它的位置：返回对象的尾部两个字段 —— 改错故障：陈旧元素同时出现两条互斥提示。
// INV-12 断言：状态 id 缺失时才回退错误里的 stateId —— 守住它的位置：stateRows 的前两段 —— 改错故障：失败结果覆盖成功结果里的真实状态 id。
// INV-13 断言：列表计数只来自详情列表长度，不读后端额外计数字段 —— 守住它的位置：resultValues 的 list 分支 —— 改错故障：文案写三项却只列出两行。
// INV-14 断言：纯数字的动作目标必须先本地化成元素编号再展示 —— 守住它的位置：actionTarget 的数字判定 —— 改错故障：胶囊里出现孤立的 57，用户不知道它指什么。
// INV-15 断言：应用名兜底顺序固定为 display 目标应用、结果应用、原始 cuaApp、通用文案 —— 守住它的位置：appName 的赋值链 —— 改错故障：兜底文案抢占真实应用名，标题永久显示「应用」。
// INV-16 断言：详情行与摘要文案都不得依赖数组下标生成 —— 守住它的位置：详情行由固定 labelId 组装、下游以 labelId 为键 —— 改错故障：重新渲染时行错位，展开状态串到别的行。
//
// 改动前先确认落点属于哪条不变量，再决定是新增分支还是修既有分支。
import { type ReactNode, useCallback, useMemo } from "react";
import type { ApplicationIconRequest } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isZCodeCuaToolName } from "@/lib/cuaPermissionAction.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { readCuaActionDetail } from "@/ToolCallBlocks/renderers/cuaActionDetail.js";
import { buildCuaAccessDetails } from "@/ToolCallBlocks/renderers/cuaAccessDetails.js";
import { CuaToolCallDetails } from "@/ToolCallBlocks/renderers/cuaDetails.js";
import { readCuaErrorDetails } from "@/ToolCallBlocks/renderers/cuaErrorDetails.js";
import { CUA_FALLBACK_ICON } from "@/ToolCallBlocks/renderers/cuaIcon.js";
import { CuaAppSummaryIcon } from "@/ToolCallBlocks/renderers/cuaAppSummaryIcon.js";
import {
  readCuaActionTargetName,
  readCuaAppName,
  readCuaResultBundleId,
  readCuaResultListCount,
  readCuaResultState,
} from "@/ToolCallBlocks/renderers/cuaResultState.js";
import {
  buildCuaDetailList,
  type CuaDetailList,
} from "@/ToolCallBlocks/renderers/cuaListDetails.js";
import {
  buildCuaScreenshotDetails,
  type CuaScreenshotDetails,
} from "@/ToolCallBlocks/renderers/cuaScreenshotDetails.js";
import { CUA_TOOL_SUMMARY_IDS } from "@/ToolCallBlocks/renderers/cuaSummaryMessages.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  // [契约] 入参来自工具协议与历史快照，签名只能是 unknown，这里统一收窄成可读记录。
  // [失败路径] 数组、null 与原始值都返回 null，调用方据此整段跳过，而不是抛出。
  // [权衡] 不做深拷贝：上游记录在本次渲染内只读，拷贝反而让引用比较失效。
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCuaToolName(value: string | null | undefined): string {
  // [契约] 归一化只在工具名这一层做，大小写与连字符差异不能渗透到后续比较。
  // [失败路径] 空值返回空串而不是 null，调用方用 includes 判断即可，无需二次判空。
  return value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
}

function readCuaToolName(value: string | null | undefined): string | null {
  const normalized = normalizeCuaToolName(value);
  // cua server key 段为 computer_use（feat）或 plugin namespace 里的 computer_use（main v3.5.3）。
  // [契约] CUA 工具名必须同时含有 computer_use 段，否则一律视为非 CUA。
  // [权衡] 用包含而不是前缀匹配，是为了同时兼容 feat 与 plugin 命名空间两套写法。
  // [失败路径] 名字被截断或缺段时返回 null，摘要层会退到通用工具卡，不会误报为 CUA。
  if (!normalized.includes("computer_use")) return null;
  // action = 最后一个 "__" 之后的段。兼容两种命名：
  //   feat:        mcp__computer_use__<action>
  //   main namesp: mcp__plugin_zcode_cua_computer_use__<action>
  // 都取尾部 <action>（get_app_state / left_click / type ...）。
  // [契约] 动作名取最后一个双下划线之后的段，命名空间层级再多也不影响结果。
  // [失败路径] 没有分隔符时整串就是动作名，随后仍要过字符校验。
  // [权衡] 不用正则一次性拆全名，避免命名空间里出现单下划线时误切。
  const lastSep = normalized.lastIndexOf("__");
  const shortName = lastSep >= 0 ? normalized.slice(lastSep + 2) : normalized;
  return /^[a-z0-9_]+$/u.test(shortName) ? shortName : null;
}

function readRawToolName(raw: unknown): string | null {
  const record = asRecord(raw);
  // [契约] 原始工具名的三个候选键按固定顺序探测，先命中者为准。
  // [失败路径] 三者都缺失时返回 null，由调用方过滤，不在这里编造默认名。
  for (const key of ["toolName", "tool_name", "name"] as const) {
    const value = readText(record, key);
    if (value) return value;
  }
  return null;
}

function readCuaUserTitle(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const raw = asRecord(toolCall.raw);
  // [契约] 标题先读 toolCall.input，再回退到 raw.rawInput 与 raw.input，三处都空才返回 null。
  // [失败路径] 三处都没有非空标题时返回 null，摘要会退回按动作类型生成的文案。
  for (const input of [asRecord(toolCall.input), asRecord(raw?.rawInput), asRecord(raw?.input)]) {
    const title = readText(input, "title");
    if (title) return title;
  }
  return null;
}

function collectToolNames(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): Array<string | null | undefined> {
  // [契约] 判定 CUA 要同时看四个字段，任一字段命中即算，避免历史记录字段缺失时漏判。
  // [权衡] 顺序固定为规范化名、kind、标题、原始名，短路由调用方的 some 完成。
  // [失败路径] 全部为空时得到四段空值，some 返回假，不会误把普通工具当 CUA。
  return [toolCall.toolName, toolCall.kind, toolCall.title, readRawToolName(toolCall.raw)];
}

function readBundleId(input: unknown): string | null {
  const record = asRecord(input);
  // [契约] 应用标识先看 app，再看 app_ref，最后才回退到记录自身。
  // [失败路径] 三层都读不到 bundle_id 与 bundleId 时返回 null，图标走通用兜底。
  // [权衡] 每层同时接受 bundle_id 与 bundleId，兼容模型输入与后端结果两套命名风格。
  for (const container of [asRecord(record?.app), asRecord(record?.app_ref), record]) {
    const bundleId = readText(container, "bundle_id") ?? readText(container, "bundleId");
    if (bundleId) return bundleId;
  }
  return null;
}

export function readCuaApplicationIconRequest(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ApplicationIconRequest | string | null {
  const display = readToolResultDisplay(toolCall.raw);
  // [契约] 结果里带上目标应用元数据时，图标定位只认 display 提供的定位列表。
  // [失败路径] 列表为空时返回 null，调用方渲染通用图标，不读模型输入。
  // [权衡] 只有历史记录没有这份元数据，才允许走旧 bundleId 兼容分支。
  // [契约] 这里的分支顺序就是优先级，先写回退会让 Helper 校验结果永远用不上。
  if (display?.kind === "cua" && display.targetApp) {
    return display.targetApp.iconLocators.length > 0
      ? { locators: display.targetApp.iconLocators }
      : null;
  }
  // 历史记录没有 authority metadata 时继续兼容旧 bundle_id；新记录即使 locator
  // 为空也不回退模型 input，避免身份冲突后重新显示未经 Helper 校验的图标。
  return readBundleId(toolCall.input) ?? readCuaResultBundleId(toolCall);
}

// [契约] 详情行只有四个字段，样式差异靠 code 与 status 两个布尔位表达。
// [契约] 行文案一律用 labelId 交给上层本地化，本文件不拼接最终字符串。
interface CuaDetailRow {
  labelId: string;
  value: string;
  code?: boolean;
  status?: boolean;
}

// [契约] 详情模型是纯数据投影，不含 React 节点，渲染顺序交给上层决定。
// [失败路径] 除 resultId、stateRows、actionRows、success 外全部可选，缺失即不渲染对应区块。
// [权衡] 失败原因拆成 id 与文本两条通道，前者走本地化，后者透传后端原文。
export interface CuaDetailsModel {
  actionRows: CuaDetailRow[];
  resultId: string;
  resultValues?: Record<string, string>;
  stateRows: CuaDetailRow[];
  success: boolean;
  list?: CuaDetailList;
  permissionRows?: CuaDetailRow[];
  environmentRows?: CuaDetailRow[];
  screenshot?: CuaScreenshotDetails;
  failureReasonId?: string;
  failureReason?: string;
  suggestedActionId?: string;
  suggestedAction?: string;
}

function readTargetDescription(
  input: unknown,
): { id: string; values: Record<string, string> } | null {
  // [契约] 目标描述只从 input.target 读取，缺一层就整段放弃。
  // [契约] 合法形状只有 element+index 与坐标对两种，其余类型一律视为没有目标并返回 null。
  // [权衡] 不在缺字段时补零，宁可少一行详情也不展示坐标 0,0。
  const target = asRecord(asRecord(input)?.target);
  // [契约] 元素目标必须同时满足类型为 element 且 index 是数字。
  // [失败路径] index 缺失时不生成元素目标行，不会渲染空编号。
  if (target?.type === "element" && typeof target.index === "number") {
    return {
      id: "chat.toolCall.cua.details.elementTarget",
      values: { index: String(target.index) },
    };
  }
  if (
    target?.type === "coordinate" &&
    typeof target.x === "number" &&
    typeof target.y === "number"
  ) {
    return {
      id: "chat.toolCall.cua.details.coordinateTarget",
      values: { x: String(target.x), y: String(target.y) },
    };
  }
  return null;
}

function buildCuaDetailsModel(
  toolName: string,
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  formatTarget: (id: string, values: Record<string, string>) => string,
): CuaDetailsModel {
  const input = asRecord(toolCall.input);
  // [契约] 结果状态只读一次，后续字段都从这一份快照投影，避免同次渲染读到不同结果。
  // [失败路径] 没有工具结果时返回 null，应用名与状态行都会安静跳过。
  // [权衡] 缓存成局部常量而不是反复调用读取函数，是为了保证行内字段同源。
  const result = readCuaResultState(toolCall);
  const appName = readCuaAppName(input, result);
  const stateRows: CuaDetailRow[] = [];
  const actionRows: CuaDetailRow[] = [];
  const actionDetail = readCuaActionDetail(toolName, input);
  // [契约] 输入文本只在 type 动作读取，其他动作即使带 text 字段也不展示。
  // [失败路径] 空白文本会被 readText 过滤成 null，动作值行不会出现空串。
  const typedText = toolName === "type" ? readText(input, "text") : null;
  const openUrl = readText(asRecord(input?.app), "url");
  const target = readTargetDescription(input);
  const list = buildCuaDetailList(toolName, toolCall);
  const access =
    toolName === "request_access"
      ? buildCuaAccessDetails(toolCall, (id) => formatTarget(id, {}))
      : null;
  // [契约] 只有 screenshot 与 zoom 两个动作会构建截图详情。
  // [失败路径] 其他动作得到 undefined，模型里不出现截图区块。
  // [权衡] 先算出候选再按成功与否裁掉，避免在构建函数内部再判一次状态。
  const screenshotCandidate =
    toolName === "screenshot" || toolName === "zoom"
      ? buildCuaScreenshotDetails(toolCall)
      : undefined;
  // [契约] 错误详情独立读取，既参与成功判定，也用于状态与应用名的兜底展示。
  // [失败路径] 没有错误时返回 null，所有 error 分支自动让位给正常结果。
  // [权衡] 不复用 display 的错误码，两套来源各自表达不同阶段的失败。
  const error = readCuaErrorDetails(toolCall);
  const display = readToolResultDisplay(toolCall.raw);
  const cuaDisplay = display?.kind === "cua" ? display : undefined;
  const waitDuration = toolName === "wait" ? readNumber(input, "duration") : null;

  // [契约] 正常结果拿不到应用名时，才用错误详情里的目标应用名补一行。
  // [失败路径] 两边都没有就跳过该行，而不是渲染空值。
  if (!appName && error?.targetAppName)
    actionRows.push({
      labelId: "chat.toolCall.cua.details.app",
      value: error.targetAppName,
    });

  // [契约] 权限申请类调用有独立的权限区块，不再重复展示应用行。
  // [失败路径] 非权限调用且无应用名时跳过，应用行不会出现空值。
  if (!access && appName)
    actionRows.push({
      labelId: "chat.toolCall.cua.details.app",
      value: appName,
    });
  // [契约] 操作行只对非权限、非列应用、非截图的动作生成。
  // [失败路径] 未知动作回退到通用文案，不会因为映射表缺键而渲染出键名。
  // [权衡] 映射表缺失时用空串键取默认值，保证文案永远可读。
  if (!access && toolName !== "list_apps" && toolName !== "screenshot") {
    actionRows.push({
      labelId: "chat.toolCall.cua.details.operation",
      value: formatTarget(CUA_TOOL_SUMMARY_IDS[toolName] ?? "chat.toolCall.cua.default", {}),
    });
  }
  // [契约] 动作值行的取值优先级是动作详情、输入文本、打开链接。
  // [失败路径] 三者都为空时不生成该行，详情区不留空白标签。
  // [权衡] 该行统一标 code，因为值通常是键名、路径或 URL 这类等宽更易读的内容。
  if (actionDetail || typedText || openUrl) {
    actionRows.push({
      labelId: "chat.toolCall.cua.details.value",
      value: actionDetail ?? typedText ?? openUrl ?? "",
      code: true,
    });
  }
  // [契约] 等待动作的时长用本地化模板插值，单位由文案决定。
  // [失败路径] 时长不是有限数字时不生成该行，避免出现 NaN 秒。
  if (waitDuration !== null)
    actionRows.push({
      labelId: "chat.toolCall.cua.details.duration",
      value: formatTarget("chat.toolCall.cua.seconds", {
        duration: String(waitDuration),
      }),
    });
  // [契约] 目标行只有解析出元素或坐标时才出现。
  // [失败路径] 解析失败即整行缺席，不会用占位符顶替。
  if (target) {
    actionRows.push({
      labelId: "chat.toolCall.cua.details.target",
      value: formatTarget(target.id, target.values),
    });
  }

  // [契约] 状态 id、窗口标题、焦点元素与变更计数都从同一份结果快照读取。
  // [失败路径] 字段缺失时各自为 null，对应状态行逐条跳过。
  // [权衡] 不在缺少状态 id 时编造序号，宁可少一行也不让用户误以为状态已同步。
  const stateId = readText(result, "state_id");
  const windowTitle = readText(asRecord(result?.window), "title");
  const focusedElement = result?.focused_element;
  const changes = asRecord(result?.changes);
  // [契约] 状态 id 只在正常结果没有时，才回退到错误携带的值。
  // [失败路径] 两处都没有就不生成状态 id 行。
  if (!stateId && error?.stateId)
    stateRows.push({
      labelId: "chat.toolCall.cua.details.stateId",
      value: error.stateId,
      code: true,
    });
  if (stateId)
    stateRows.push({
      labelId: "chat.toolCall.cua.details.stateId",
      value: stateId,
      code: true,
    });
  if (windowTitle)
    stateRows.push({
      labelId: "chat.toolCall.cua.details.window",
      value: windowTitle,
    });
  // [契约] 焦点元素只接受数字编号，字符串编号视为缺失。
  // [失败路径] 非数字时跳过，避免把未知结构渲染成元素编号。
  // [权衡] 焦点编号复用元素目标的标签与插值，保证两处措辞一致。
  if (typeof focusedElement === "number") {
    stateRows.push({
      labelId: "chat.toolCall.cua.details.focus",
      value: formatTarget("chat.toolCall.cua.details.elementTarget", {
        index: String(focusedElement),
      }),
    });
  }
  // [契约] 变更行只要增删两个计数有一个是数字就生成。
  // [失败路径] 缺失的那一侧按 0 补齐，保证模板两个占位都有值。
  // [权衡] 不用整体存在性判断，否则只报新增不报删除时整行消失。
  if (typeof changes?.added_count === "number" || typeof changes?.removed_count === "number") {
    stateRows.push({
      labelId: "chat.toolCall.cua.details.changes",
      value: formatTarget("chat.toolCall.cua.details.changeCounts", {
        added: String(typeof changes?.added_count === "number" ? changes.added_count : 0),
        removed: String(typeof changes?.removed_count === "number" ? changes.removed_count : 0),
      }),
    });
  }

  // MCP transport completed 不代表 CUA 动作成功；新 session 优先采用 display 状态。
  // [契约] 错误码以新 session 的 display 为准，错误详情只做兜底。
  // [失败路径] 两处都没有错误码时得到 undefined，后续按普通失败处理。
  // [契约] 成功判定与错误码读取必须同源，否则会出现显示失败但判定成功。
  // [权衡] 不用逻辑或而用空值合并，空字符串错误码不会被误当成缺失。
  // [失败路径] display 为 undefined 时整段退回旧判定，历史记录仍可正常展示。
  const errorCode = cuaDisplay?.errorCode ?? error?.code;
  const success =
    cuaDisplay?.status !== "failed" &&
    toolCall.status !== "failed" &&
    !error &&
    (access?.ready ?? true);
  // 失败截图也创建详情模型时会渲染无效截图占位；失败原因区已足够。
  // [契约] screenshot 只在 success 为真时保留，失败分支直接置 undefined。
  // [失败路径] 失败时丢弃候选，失败卡片不会渲染无效截图占位。
  // [权衡] 失败原因区块已经足够解释问题，再挂一张黑图只会干扰判断。
  const screenshot = success ? screenshotCandidate : undefined;
  const resultValues: Record<string, string> | undefined = list
    ? { count: String(list.items.length) }
    : waitDuration !== null
      ? { duration: String(waitDuration) }
      : undefined;
  // [契约] 结果文案按失败、权限、动作类型三级分流，先失败后权限。
  // [失败路径] 未知动作落到最后的通用完成文案，不会出现空文案。
  // [契约] 列表类动作要区分有结果与无结果两种文案，不能只报数量。
  // [权衡] 这里用嵌套三元而不是查表，是因为分支同时依赖动作与结果两个维度。
  const resultId = !success
    ? access
      ? "chat.toolCall.cua.details.accessIncomplete"
      : errorCode === "element_stale"
        ? "chat.toolCall.cua.details.elementStale"
        : "chat.toolCall.cua.details.failed"
    : access
      ? "chat.toolCall.cua.details.accessReady"
      : toolName === "type" && typedText
        ? "chat.toolCall.cua.details.typed"
        : toolName === "key"
          ? "chat.toolCall.cua.details.keyPressed"
          : toolName === "open_application"
            ? "chat.toolCall.cua.details.opened"
            : toolName === "get_app_state"
              ? "chat.toolCall.cua.details.observed"
              : toolName === "screenshot"
                ? "chat.toolCall.cua.details.screenshotCaptured"
                : toolName === "wait" && waitDuration !== null
                  ? "chat.toolCall.cua.details.waited"
                  : toolName === "zoom"
                    ? "chat.toolCall.cua.details.zoomed"
                    : toolName === "list_apps"
                      ? list?.items.length
                        ? "chat.toolCall.cua.details.appsFound"
                        : "chat.toolCall.cua.details.noApps"
                      : toolName === "list_windows"
                        ? list?.items.length
                          ? "chat.toolCall.cua.details.windowsFound"
                          : "chat.toolCall.cua.details.noWindows"
                        : "chat.toolCall.cua.details.completed";
  return {
    actionRows,
    resultId,
    resultValues,
    stateRows,
    success,
    list,
    permissionRows: access?.permissionRows,
    environmentRows: access?.environmentRows,
    screenshot,
    failureReasonId:
      errorCode === "element_stale" ? "chat.toolCall.cua.details.elementStaleReason" : undefined,
    failureReason:
      errorCode !== "element_stale" && cuaDisplay?.status === "failed"
        ? (cuaDisplay.text ?? cuaDisplay.errorCode)
        : undefined,
    suggestedActionId:
      errorCode === "element_stale" ? "chat.toolCall.cua.details.elementStaleAction" : undefined,
    suggestedAction: errorCode !== "element_stale" ? cuaDisplay?.suggestedAction : undefined,
  };
}

export function isCuaToolCall(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): boolean {
  // [契约] 是否 CUA 工具由四个候选字段任一命中决定。
  // [失败路径] 字段全空时返回假，普通工具不会进这个渲染器。
  return collectToolNames(toolCall).some(isZCodeCuaToolName);
}

// [契约] 摘要展示模型同时给出文本、图标与失败态，实际排版由调用方决定。
// [失败路径] 失败文案可选，仅在 display 或外部兜底提供时出现。
// [权衡] 图标与主文案在这里就组装好，避免调用方再读一次工具结果。
export interface CuaSummaryPresentation {
  toolName: string | null;
  icon: ReactNode;
  appName: string;
  primaryText: ReactNode;
  description: string;
  title: string;
  isFailed: boolean;
  failureText?: string;
}

type CuaIntl = ReturnType<typeof useZCodeIntl>["intl"];

export function buildCuaSummaryPresentation(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  intl: CuaIntl,
  options?: { fallbackErrorText?: string; appIconClassName?: "size-4" | "size-5" },
): CuaSummaryPresentation {
  // [契约] 摘要用的动作名从四个候选字段里第一个能解析出短名的位置取。
  // [失败路径] 全部解析失败时为 null，后续按通用文案处理。
  // [权衡] 用 find 取值而不是取首元素，容忍前面的字段是历史命名。
  const toolName = collectToolNames(toolCall).map(readCuaToolName).find(Boolean) ?? null;
  const display = readToolResultDisplay(toolCall.raw);
  const cuaDisplay = display?.kind === "cua" ? display : null;
  // [契约] 有 display 时失败态只看 display，否则回退到工具调用状态。
  // [失败路径] display 不是 failed 时即使工具调用失败也判成功，因为传输失败不等于动作失败。
  // [权衡] 摘要这里不等权限就绪，权限未完成由详情区的独立结果文案表达。
  const isFailed = cuaDisplay ? cuaDisplay.status === "failed" : toolCall.status === "failed";
  const failureText =
    cuaDisplay?.status === "failed"
      ? (cuaDisplay.text ?? options?.fallbackErrorText)
      : options?.fallbackErrorText;
  // [契约] 原始结果里的 cuaApp 是应用名的最后一道来源。
  // [失败路径] 缺失或不是对象时得到 null，读取函数会安静返回空。
  const rawCuaApp = asRecord(asRecord(toolCall.raw)?.cuaApp);
  const result = readCuaResultState(toolCall);
  const resultApp = asRecord(result?.app);
  const genericAppName = intl.formatMessage({ id: "chat.toolCall.cua.appName" });
  // [契约] 应用名的兜底顺序是 display 目标应用、结果应用、原始应用、通用文案。
  // [失败路径] 四级都缺失时用通用文案，标题仍能完整拼出。
  // [权衡] 通用文案由调用方传入的 intl 生成，不在本文件写死语言。
  const appName =
    cuaDisplay?.targetApp?.displayName ??
    readText(resultApp, "name") ??
    readText(rawCuaApp, "name") ??
    genericAppName;
  const bundleId =
    readText(resultApp, "bundle_id") ??
    readText(resultApp, "bundleId") ??
    readText(rawCuaApp, "bundleId") ??
    undefined;
  // [契约] 只有左键、右键与输入三个动作会读取可读元素名。
  // [失败路径] 其他动作得到 null，摘要不带胶囊。
  // [权衡] 读取放在这里而不是详情构建里，是因为摘要与详情需要不同粒度。
  const rawActionTarget =
    toolName === "left_click" || toolName === "right_click" || toolName === "type"
      ? readCuaActionTargetName(toolCall)
      : null;
  // CUA 无法解析元素可读名称时会返回纯数字 index；直接把 `57` 放进 tag
  // 看起来像无上下文的值，因此明确标注为本地化的元素编号。
  // [契约] 纯数字的元素名必须本地化成元素编号再展示。
  // [失败路径] 非数字名原样使用，不做截断或转义。
  // [权衡] 判定用整串数字，避免把 12a 这类真实名称误当成编号。
  const actionTarget =
    rawActionTarget && /^\d+$/u.test(rawActionTarget)
      ? intl.formatMessage({ id: "chat.toolCall.cua.elementTarget" }, { index: rawActionTarget })
      : rawActionTarget;
  // [契约] keyName 由 readCuaActionDetail 读取，key 与 hold_key 共用同一条入口。
  // [失败路径] 非按键动作得到 null，摘要不会多出按键胶囊。
  const keyName =
    toolName === "key" || toolName === "hold_key"
      ? readCuaActionDetail(toolName, toolCall.input)
      : null;
  const authoredDescription = toolName === "get_app_state" ? readCuaUserTitle(toolCall) : null;
  const listCount = toolName === "list_windows" ? readCuaResultListCount(toolCall) : null;
  // [契约] 动作文案只在动作目标存在时才需要，这里按输入、右键、左键三档选择。
  // [失败路径] 其他动作走通用映射表，缺键时仍落到默认文案。
  const actionId =
    toolName === "type"
      ? "chat.toolCall.cua.type"
      : toolName === "right_click"
        ? "chat.toolCall.cua.rightClick"
        : "chat.toolCall.cua.leftClick";
  // [契约] 描述文本的优先级是用户自填标题、动作目标、键名、列表计数、动作映射。
  // [失败路径] 列表计数为 0 也算有效值，会明确显示零个而不是退回通用文案。
  // [权衡] 计数用空值判断而不是真值判断，避免 0 被当成缺失。
  const description =
    authoredDescription ??
    (actionTarget
      ? intl.formatMessage({ id: actionId })
      : keyName
        ? intl.formatMessage({
            id:
              toolName === "hold_key"
                ? "chat.toolCall.cua.holdKey"
                : "chat.toolCall.cua.pressKeyAction",
          })
        : listCount !== null
          ? intl.formatMessage({ id: "chat.toolCall.cua.listWindowsCount" }, { count: listCount })
          : intl.formatMessage({
              id: CUA_TOOL_SUMMARY_IDS[toolName ?? ""] ?? "chat.toolCall.cua.default",
            }));
  const taggedTarget = actionTarget ?? keyName;
  const primaryText =
    taggedTarget && !authoredDescription ? (
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="shrink-0">{description}</span>
        <span className="cua-action-target min-w-0 truncate rounded-full border border-border px-1.5 text-ui-sm text-foreground-subtlest">
          {taggedTarget}
        </span>
      </span>
    ) : (
      description
    );

  return {
    toolName,
    icon:
      appName === genericAppName ? (
        CUA_FALLBACK_ICON
      ) : (
        <CuaAppSummaryIcon
          bundleId={bundleId}
          iconRequest={readCuaApplicationIconRequest(toolCall)}
          name={appName}
          className={options?.appIconClassName}
        />
      ),
    appName,
    primaryText,
    description,
    title: `${appName} ${description}`,
    isFailed,
    ...(failureText ? { failureText } : {}),
  };
}

export function CuaToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const summary = buildCuaSummaryPresentation(toolCall, intl, {
    fallbackErrorText: context.errorText,
    appIconClassName: context.cuaAppIconClassName,
  });
  const { toolName } = summary;
  const isActive =
    context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress";
  const detailsModel = useMemo(
    () =>
      toolName
        ? buildCuaDetailsModel(toolName, toolCall, (id, values) =>
            intl.formatMessage({ id }, values),
          )
        : null,
    [intl, toolCall, toolName],
  );
  const renderContent = useCallback(
    () => (detailsModel ? <CuaToolCallDetails model={detailsModel} toolCall={toolCall} /> : null),
    [detailsModel, toolCall],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={
        context.cuaAppIconClassName === "size-5" ? (
          <span className="shrink-0 size-4 flex items-center justify-center">{summary.icon}</span>
        ) : (
          summary.icon
        )
      }
      showIcon={context.showIcon !== false}
      canToggle={!isActive && (context.canToggle ?? true)}
      forceOpen={
        !isActive &&
        !(summary.isFailed && toolName === "screenshot") &&
        (context.forceOpen ?? false)
      }
      kindLabel={summary.appName}
      primaryText={summary.primaryText}
      statusLabel={
        summary.isFailed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
      }
      statusTooltip={summary.isFailed ? summary.failureText : undefined}
      showFailureStatus={summary.isFailed}
      isRunning={context.isRunning}
      title={summary.title}
      renderContent={renderContent}
    />
  );
}
