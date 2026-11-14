// INV-01 [边界] 本模块只做展示投影，不写回 toolCall、identity 或预览源；守住位置：buildToolDisplayModel 的两个形参与 context 装配；改错故障：渲染层产生第二份事实，同一工具状态出现不一致。
// INV-02 [契约] 计划结果只从 output 提取，绝不回读 input；守住位置：extractToolPlanResultFromValue 首个实参取 toolCall.output；改错故障：EnterPlanMode 输入里的 plan 被当结果，和顶部计划事件重复渲染。
// INV-03 [失败路径] 计划必须是非空字符串才成立，缺字段与纯空白同归 null；守住位置：rawPlan 的类型判断与 trim 长度比较；改错故障：空计划渲染出空结果块，还压掉了原本可见的参数。
// INV-04 [边界] 计划文件路径相对 workspacePath 拼接，绝对路径原样保留；守住位置：isAbsoluteFilePath 三元分支与 joinFilePath 调用；改错故障：二次拼接产生坏路径，点击链接落到不存在的位置。
// INV-05 [契约] 返回值固定 plan 有值、planFilePath 可为 undefined；守住位置：extractToolPlanResultFromValue 末尾的对象字面量；改错故障：下游用真值判空失效，把空白路径当有效链接。
// INV-06 [权衡] patch 优先只对 diff 策略开放；守住位置：toInlinePreview 的 preferPatch 形参与第一个 if；改错故障：读写类工具遇到补丁源也进 diff 视图，只读操作被误标成改动。
// INV-07 [顺序] 预览选择次序固定为 patch、image、text、contentPreview、none；守住位置：toInlinePreview 内四个 if 的排列；改错故障：调换后图片被文本覆盖，真实差异被兜底内容抢走。
// INV-08 [失败路径] contentPreview 只在没有结构化预览时兜底；守住位置：toInlinePreview 最后一个 if 的位置；改错故障：提前命中丢掉 path，viewerSource 与摘要文件链接同时失效。
// INV-09 [顺序] 策略表按数组顺序取首个命中；守住位置：TOOL_DISPLAY_STRATEGIES 的元素次序与后续查找；改错故障：图片兜底策略前置会截胡 diff，补丁专属视图消失。
// INV-10 [契约] diff 判定同时依赖 isFileDiffToolCall 与 identity；守住位置：diffToolStrategy 的 matches；改错故障：退化成 kind 判断会把普通输出当补丁，打开错误的差异视图。
// INV-11 [契约] 读类策略只认 family 为 file-read；守住位置：readToolStrategy 的 matches 与 showSummaryFileLink 为 false；改错故障：放宽匹配后写工具被当只读，输入被收起却没有任何预览。
// INV-12 [契约] 写类策略由 isFileContentWriteToolCall 判定；守住位置：writeToolStrategy 的 matches；改错故障：漏判后落回默认模型，参数与结果被重复摊开。
// INV-13 [失败路径] 只要有内联预览就收起输入与种类；守住位置：各策略 build 里 hasInlinePreview 的取反；改错故障：预览与整坨参数同屏，正文被长 JSON 挤到视口之外。
// INV-14 [失败路径] 无错误时成功输出默认不展示；守住位置：四个策略里的 Boolean(errorText) 表达式；改错故障：结构化确认占一块 Result，聊天流被无意义内容拉长。
// INV-15 [事务] 出错时最后统一收敛成错误视图；守住位置：buildToolDisplayModel 末尾的 errorText 分支；改错故障：写失败仍铺 oldString/newString，真正的报错被挤出可见区。
// INV-16 [事务] 计划分支先于错误分支返回，且保留已选预览；守住位置：planResult 的提前 return 位于 errorText 分支之前；改错故障：顺序反转后出错即清空预览，计划块与内联视图无法共存。
// INV-17 [状态] 默认模型的查看入口与标签由 preview 决定；守住位置：defaultModel 的 viewerSource、viewerLabelId 三元与 showSummaryFileLink；改错故障：补丁显示成查看代码，用户误以为要打开全文。
// INV-18 [契约] 计划存在时默认模型先收起输入；守住位置：defaultModel 的 showInput 三元；改错故障：计划参数与计划正文同屏，双份内容互相抢注意力。
//
// 模块职责：把一次工具调用及其预览、错误、计划结果归一成展示模型，供聊天区决定渲染哪些区块。
// 状态所有权：toolCall、identity 与两类预览源都来自调用方；本模块只派生只读模型，不持有状态。
// 阅读顺序：先看类型与 isRecord 守卫，再读计划提取与预览选择，最后看策略表与 buildToolDisplayModel 的两处覆盖。
import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";
import {
  getToolCallCodeContentPreview,
  getToolCallCodePreview,
  type CodeViewerSource,
  type ImageCodeViewerSource,
  type PatchCodeViewerSource,
  type TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  isFileContentWriteToolCall,
  isFileDiffToolCall,
  resolveToolCallIdentity,
  type ToolCallIdentity,
} from "@/lib/toolIdentity.js";

export type ToolInlinePreview =
  | { type: "none" }
  | { type: "text"; source: TextCodeViewerSource }
  | { type: "patch"; source: PatchCodeViewerSource }
  | { type: "image"; source: ImageCodeViewerSource };

export interface ToolPlanResult {
  plan: string;
  planFilePath?: string;
}

export interface ToolDisplayModel {
  inlinePreview: ToolInlinePreview;
  planResult: ToolPlanResult | null;
  viewerSource: CodeViewerSource | null;
  viewerLabelId: "codeViewer.viewCode" | "codeViewer.viewDiff";
  showSummaryFileLink: boolean;
  showInput: boolean;
  showOutput: boolean;
  showKind: boolean;
}

interface ToolDisplayContext {
  toolCall: ChatToolCall;
  identity: ToolCallIdentity;
  preview: CodeViewerSource | null;
  contentPreview: TextCodeViewerSource | null;
  errorText?: string;
}

interface ToolDisplayStrategy {
  matches(context: ToolDisplayContext): boolean;
  build(context: ToolDisplayContext): Partial<ToolDisplayModel>;
}

// [边界] isRecord 只接受非 null、非数组的 object，用它把 unknown 输入收窄成可索引的记录。
// [失败路径] 计划提取先过这道守卫，字符串、数组、null 一律返回 null，不去猜结构。
// [契约] rawPlan 必须是字符串且 trim 后非空，纯空白计划与缺字段走同一条 null 分支。
// [边界] plan 文本返回时再次 trim，避免把模型给的缩进与空行带进展示层。
// [权衡] 这里不校验 markdown 也不容忍 todo 等字段，只认 plan 一个键，避免职责扩散。
// [失败路径] 若放宽到数组或字符串，普通结果会被误认成计划，计划专用视图被滥用。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolPlanResultFromValue(
  value: unknown,
  workspacePath: string,
): ToolPlanResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawPlan = value["plan"];
  if (typeof rawPlan !== "string" || rawPlan.trim().length === 0) {
    return null;
  }

  const rawPlanFilePath = value["planFilePath"];
  // [契约] planFilePath 仅当为非空字符串时才尝试解析，缺失或空白一律留 undefined。
  // [边界] 绝对路径原样透传，不再拼 workspacePath，避免二次拼接产生不存在的路径。
  // [边界] 相对路径走 joinFilePath 以 workspacePath 为基，与文件摘要链接保持同一根。
  // [权衡] 路径解析失败不抛错，降级为没有文件链接的计划块，正文仍然可读。
  // [契约] 返回对象固定两个键，plan 必有值，planFilePath 可缺，调用方据此判空。
  // [失败路径] 若在这里抛错，整个展示模型构建失败，连工具名和错误都渲染不出来。
  const planFilePath =
    typeof rawPlanFilePath === "string" && rawPlanFilePath.trim().length > 0
      ? isAbsoluteFilePath(rawPlanFilePath)
        ? rawPlanFilePath
        : joinFilePath(workspacePath, rawPlanFilePath)
      : undefined;

  return {
    plan: rawPlan.trim(),
    planFilePath,
  };
}

// [顺序] 优先级固定为 patch、image、text、contentPreview、none，后面的分支只能兜底。
// [权衡] preferPatch 只有 diff 策略传 true，其他策略即便拿到 patch 也按原类型呈现。
// [失败路径] patch 分支要先判，否则补丁被当文本处理，差异高亮与折叠全部失效。
// [契约] image 排在 text 前，图片源不会被文本预览覆盖，缩略图才能正常出现。
// [失败路径] contentPreview 只在前三个分支都落空后使用，提前命中会丢 path 与类型。
// [状态] 每个分支都新建对象而不复用入参，返回的 source 与 context 保持同一引用。
// [契约] 全军覆没时返回 none，调用方统一用 type 不等于 none 判断是否存在内联预览。
function toInlinePreview(context: ToolDisplayContext, preferPatch: boolean): ToolInlinePreview {
  if (preferPatch && context.preview?.type === "patch") {
    return {
      type: "patch",
      source: context.preview,
    };
  }

  if (context.preview?.type === "image") {
    return {
      type: "image",
      source: context.preview,
    };
  }

  if (context.preview?.type === "text") {
    return {
      type: "text",
      source: context.preview,
    };
  }

  if (context.contentPreview) {
    return {
      type: "text",
      source: context.contentPreview,
    };
  }

  return { type: "none" };
}

// [契约] diff 策略的入口判定绑定 isFileDiffToolCall 与 identity，不靠 kind 字符串。
// [顺序] diff 排在 read 与 write 之前，保证补丁类调用先拿到 patch 优先的预览。
// [失败路径] 有内联预览时 showInput 取反收起，避免参数 JSON 与差异图并排。
// [失败路径] showOutput 只看 errorText，成功时的确认输出不再占一块 Result。
// [状态] showKind 同样跟随 hasInlinePreview，预览在场就隐藏工具种类胶囊。
// [契约] read 策略只认 family 为 file-read，标题已含文件名，故关闭摘要文件链接。
// [契约] write 策略由 isFileContentWriteToolCall 判定，成功输出被显式丢弃只留错误。
// [权衡] 三类策略结构相同却各自声明，便于单独调整而不影响其他工具的展示语义。
const diffToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileDiffToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, true);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const readToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "file-read";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      // 读类工具的标题里通常已经包含目标文件，摘要行再额外补一个匹配出的文件名，
      // 会把同一文件重复显示两次。这里只保留标题和正文预览，避免只读操作显得像“又点开了一个文件”。
      showSummaryFileLink: false,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const writeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return isFileContentWriteToolCall(context.toolCall, context.identity);
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      // Write 工具的成功 output 常只是结构化确认结果，继续渲染会多出一块无意义的 Result。
      // 写入内容已经由 inlinePreview / 文件摘要承载；这里只在失败时保留错误，避免重复展示 result。
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

const genericImageStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.preview?.type === "image";
  },
  build(context) {
    const inlinePreview = toInlinePreview(context, false);
    const hasInlinePreview = inlinePreview.type !== "none";

    return {
      inlinePreview,
      showInput: !hasInlinePreview,
      showOutput: Boolean(context.errorText),
      showKind: !hasInlinePreview,
    };
  },
};

// [契约] shell 策略固定返回 none 预览并关闭 kind，命令正文交给专用渲染。
// [失败路径] showOutput 用 output 是否定义加 errorText 双重判断，无输出时不留空块。
// [契约] search 与 web-fetch 合用一个策略，命中结果才是主视觉，输入与摘要链接都关闭。
// [契约] goal 策略同样只留结果，input 是给 runtime 的状态参数，不该被用户阅读。
// [契约] node-repl 策略把展示完全交给专用 renderer，这里连 output 也一并关闭。
// [顺序] genericImage 排在策略表末尾，只承接前面都没命中的图片预览，避免截胡 diff。
// [权衡] 每个策略只覆写关心的字段，其余继续沿用默认模型，减少重复声明。
const executeToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "shell";
  },
  build(context) {
    return {
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const searchToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "search" || context.identity.family === "web-fetch";
  },
  build(context) {
    // search/fetch 类工具的输入通常只是 query、路径或过滤条件，
    // 用户真正关心的是命中的结果。之前走通用展示会把 Parameters 和 Result 一起展开，
    // 搜索结果被挤到下面很难扫读；这里统一只保留 result/error，避免无效输入信息抢主视觉。
    // 同时搜索范围本身已经体现在标题或结果里，摘要行再额外补一个匹配出的目录/文件名会重复噪音。
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const goalToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "goal";
  },
  build(context) {
    // Goal 工具的 input 是模型给 runtime 的状态变更参数，不是用户要读的结果。
    // 之前走通用 fallback 会同时摊开 Parameters、Result 和整包 raw，goal 状态反而被噪音淹没。
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: context.toolCall.output !== undefined || Boolean(context.errorText),
      showKind: false,
    };
  },
};

const nodeReplToolStrategy: ToolDisplayStrategy = {
  matches(context) {
    return context.identity.family === "node-repl";
  },
  build() {
    // 展示语义由专用 renderer 从 title/result/error 中归一化；通用 Parameters、Result
    // 和 kind 会暴露工具实现细节，并与专用结果区重复，因此这里全部关闭。
    return {
      inlinePreview: { type: "none" },
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    };
  },
};

// [顺序] 数组顺序即优先级，取首个命中，前移任何一项都会改变既有工具的展示。
// [状态] 表在模块加载时构建一次，运行时只读，不在渲染过程里增删策略。
// [契约] 新增工具族时只追加策略并想清插入位置，不改主渲染骨架。
// [失败路径] 全部落空时得到 undefined，由默认模型兜底，不会抛错中断渲染。
const TOOL_DISPLAY_STRATEGIES: ToolDisplayStrategy[] = [
  diffToolStrategy,
  readToolStrategy,
  writeToolStrategy,
  executeToolStrategy,
  searchToolStrategy,
  goalToolStrategy,
  nodeReplToolStrategy,
  genericImageStrategy,
];

export function buildToolDisplayModel(
  toolCall: ChatToolCall,
  workspacePath: string,
): ToolDisplayModel {
  const preview = getToolCallCodePreview(toolCall, workspacePath);
  const contentPreview = getToolCallCodeContentPreview(toolCall, workspacePath);
  const errorText = getToolCallErrorText(toolCall);
  const identity = resolveToolCallIdentity(toolCall);
  // 用户要看的 plan 来自 tool result，不是 tool input。
  // EnterPlanMode 一类输入里也可能带 plan/todo 结构；如果这里兜底读 input，
  // 同一份计划会被误当成结果渲染，和顶部真实 plan 事件的职责再次混在一起。
  const planResult = extractToolPlanResultFromValue(toolCall.output, workspacePath);
  const context: ToolDisplayContext = {
    toolCall,
    identity,
    preview,
    contentPreview,
    errorText,
  };

  // [状态] 默认模型先给出中性视图，再由命中的策略字段级覆盖，合并顺序不可颠倒。
  // [契约] viewerSource 直接复用 preview，viewerLabelId 按是否 patch 区分查看差异或查看代码。
  // [失败路径] 没有 preview 时摘要链接关闭，viewerSource 为 null，不伪造可点击入口。
  // [契约] planResult 在场时默认收起输入，把正文让给计划块，错误仍由后续分支保留。
  const defaultModel: ToolDisplayModel = {
    inlinePreview: { type: "none" },
    planResult,
    viewerSource: preview,
    viewerLabelId: preview?.type === "patch" ? "codeViewer.viewDiff" : "codeViewer.viewCode",
    showSummaryFileLink: Boolean(preview?.path),
    showInput: planResult ? false : toolCall.input !== undefined,
    showOutput: toolCall.output !== undefined || Boolean(errorText),
    showKind: true,
  };

  const matchedStrategy = TOOL_DISPLAY_STRATEGIES.find((strategy) => strategy.matches(context));

  // tool 展示之前靠 `kind === "edit"` 直接分叉，预览提取层已经能识别 read/replace/image，
  // 但渲染层完全吃不到，最后只剩一堆零散特判。这里收敛成“通用模型 + kind 策略增强”，
  // 后续新增 execute/search/fetch 的专用展示时，只需要追加策略，不再重写主渲染骨架。
  const model = matchedStrategy
    ? {
        ...defaultModel,
        ...matchedStrategy.build(context),
      }
    : defaultModel;

  // 退出计划模式的 result 会同时带 markdown plan 和 allowedPrompts 等结构化字段。
  // 之前这里直接走通用 JSON Result，聊天区很难读，而且同一份 plan 还会在别处重复渲染。
  // 现在优先把 `plan` 当成当前 tool 的专用结果块展示，只在出错时再回退到通用输出区。
  if (planResult) {
    return {
      ...model,
      showInput: false,
      showOutput: Boolean(errorText),
    };
  }

  if (errorText) {
    return {
      ...model,
      // edit/write 失败时继续展示 Parameters，会把 oldString/newString 整坨 JSON 顶上来，
      // 真正的报错反而被挤到下面甚至完全看不到。失败态优先收敛成错误信息视图，避免用户继续读无效参数。
      inlinePreview: { type: "none" },
      showInput: false,
      showOutput: true,
      showKind: false,
    };
  }

  return model;
}
