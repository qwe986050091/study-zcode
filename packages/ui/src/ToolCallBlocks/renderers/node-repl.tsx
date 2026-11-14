// 职责：把一次 node_repl 工具调用投影成摘要行、可折叠结果区（短文本 / 代码块 / 图片）
// 以及技术明细（脚本源码与错误堆栈），并在 Computer Use 请求里换成目标应用图标。
// 不负责：工具调用的发起与状态流转、脚本语义解析、结果落盘与快照加载，这些由 runtime 与 display model 决定。
//
// INV-01 断言：renderContent 只在 hasDetails 为真时传入 ToolLayout —— 守住它的位置：组件末尾 renderContent 属性 —— 改错故障：空卡片出现可展开箭头，点开后一片空白
// INV-02 断言：displaySource 为 browser_turn_end 时整卡退化为纯图片网格 —— 守住它的位置：组件末尾的提前返回 —— 改错故障：回合结束节点重复渲染摘要行与图片
// INV-03 断言：statusLabel 固定传失败文案，只在 showFailureStatus 为真时可见 —— 守住它的位置：ToolLayout 的 statusLabel 与 showFailureStatus —— 改错故障：进行中的卡片被提前标红成失败
// INV-04 断言：visibleError 仅在 status 为 failed 时取 error.summary 或 errorText —— 守住它的位置：visibleError 计算 —— 改错故障：重试成功后仍残留上一次报错红条
// INV-05 断言：hasVisibleResult 把 persistedResult 也算作可见结果 —— 守住它的位置：hasVisibleResult 的 Boolean 表达式 —— 改错故障：大结果落盘后仍显示无结果
// INV-06 断言：operation 非 run 时只有失败才允许展开 —— 守住它的位置：hasDetails 的三元分支 —— 改错故障：reset 或配置成功也出现空的明细折叠区
// INV-07 断言：canToggle 尊重外部传入的显式值 —— 守住它的位置：canToggle 的空值合并 —— 改错故障：外层强制收起时内部仍可点击展开
// INV-08 断言：短结果判定同时排除换行与 JSON —— 守住它的位置：isCompactResult —— 改错故障：JSON 或日志被塞进单行文本，丢掉换行与复制按钮
// INV-09 断言：代码块语言按 looksLikeJson 在 json 与 log 之间切换 —— 守住它的位置：结果区 FriendlyCodeBlock 的 language —— 改错故障：合法 JSON 被当日志着色，高亮全丢
// INV-10 断言：log 语言关闭语法高亮 —— 守住它的位置：FriendlyCodeBlock 的 enableSyntaxHighlighting —— 改错故障：纯文本日志也走高亮，长输出卡顿
// INV-11 断言：eagerLayout 只在展开内容里的代码块开启 —— 守住它的位置：FriendlyCodeBlock 的 eagerLayout 与布局样式常量 —— 改错故障：折叠动画先展开过头再回落
// INV-12 断言：应用图标取不到时回落到 node_repl 自身图标 —— 守住它的位置：leadingIcon 的两处提前返回 —— 改错故障：摘要行图标闪烁或变成别的指针图形
// INV-13 断言：摘要 detail 只在配置模块目录时出现 —— 守住它的位置：getSummary 的 add-module-dir 分支 —— 改错故障：普通执行摘要后挂一段不相关路径
// INV-14 断言：denied 与 stopped 优先于失败与运行态 —— 守住它的位置：getSummary 的首个分支 —— 改错故障：用户拒绝后仍显示处理中
// INV-15 断言：userTitle 存在时状态改走 completed 文案 —— 守住它的位置：getSummary 末尾的三元 —— 改错故障：自定义标题旁出现与标题矛盾的重复状态词
// INV-16 断言：源码与堆栈两层明细共用 detail-surface 测试标识 —— 守住它的位置：两个明细容器 —— 改错故障：E2E 断言命中错误层，回归静默通过
// INV-17 断言：展开内容根节点不自带横向内边距 —— 守住它的位置：renderContent 根 div 的 className —— 改错故障：BUA 结果相对摘要行二次缩进，窄屏更明显
// INV-18 断言：快照字段提示始终挂在卡片外层 —— 守住它的位置：ToolSnapshotFieldNotice 的位置 —— 改错故障：卡片折叠时快照加载入口一并消失
import { useCallback, useMemo } from "react";
import { ChevronRightIcon, ExternalLinkIcon, SquareMousePointerIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockWrapButton,
} from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cuaAppKeyToIconRequest } from "@/lib/cuaAppIconRequest.js";
import { buildNodeReplDisplayModel, type NodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";
import { CuaAppSummaryIcon } from "@/ToolCallBlocks/renderers/cuaAppSummaryIcon.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { NodeReplImageGrid } from "@/ToolCallBlocks/renderers/nodeReplImageGrid.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// 摘要行默认图标固定为指针方块，不随主题或操作类型切换
// 只有 Computer Use 请求带应用身份时才在 leadingIcon 里替换
const NODE_REPL_TOOL_ICON = (
  <SquareMousePointerIcon className="size-4 shrink-0 text-foreground-subtle" />
);

// Radix 会在浏览器工具及执行详情打开时立即测量高度；代码块默认的 200px 离屏占位
// 会让动画先展开过头再回落。两层内容都只在对应区域展开时挂载，使用真实布局不会损失长会话性能。
// [权衡] 两个字段必须成对出现，缺 contentVisibility 时离屏内容仍会被完整绘制
// 缺 containIntrinsicSize 时折叠层按占位高度参与布局，展开瞬间会先跳一下
// 该样式只传给展开态代码块，折叠态的默认占位是长会话的性能保护，不要全局套用
// 新增使用点前先确认对应区域确实只在展开时挂载，否则等于关掉了渲染跳过
const COLLAPSIBLE_CODE_LAYOUT_STYLE = {
  containIntrinsicSize: "none",
  contentVisibility: "visible",
} as const;
// 160 是短结果与代码块展示的分界，按字符数而非字节数计算
// 调大会让带换行的日志也走单行样式，丢掉换行与复制按钮
// 调小会让标题、URL 这类正常结果被迫使用重型代码块
const COMPACT_RESULT_MAX_LENGTH = 160;

// 仅用于挑代码块语言与短结果判定，不做 schema 校验
// 首字符不是花括号或方括号时直接返回，避免对纯文本反复解析
// 同一结果可能先被短结果判定调用、再被语言选择调用，因此保持无副作用
function looksLikeJson(value: string): boolean {
  // 先 trim 再去掉首字符判断，容忍模型回包前后的空行与空格
  // 这里不动内部空白，JSON 解析本身能处理内部空白
  const trimmed = value.trim();
  // 只认对象与数组两种顶层结构，单独的数字或字符串不算 JSON
  // 放宽到任意合法 JSON 会把纯数字结果当成结构化数据高亮
  // 未知形态统一走 log 分支，最坏情况只是少一层着色
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return false;
  }

  // JSON.parse 在这里只作为探测器，解析结果直接丢弃
  // 用 try 捕获而不是预校验语法，避免维护第二套解析规则
  // 被截断的大结果会解析失败并回落到日志展示，这是预期路径
  try {
    JSON.parse(trimmed);
    return true;
  // 空 catch 是有意的：探测失败等价于不是 JSON，无需日志
  // 在此处打日志会在长会话里对每条非 JSON 结果刷屏
  // 不要改成重新抛出，调用方没有对应的错误展示分支
  } catch {
    return false;
  }
}

// 四条判定必须同时成立：非空、不超长、无换行、非 JSON
// 顺序按代价从低到高排列，JSON 探测最贵所以放最后
// 返回真时结果用普通段落展示，不再挂代码块标题栏与操作按钮
function isCompactResult(value: string): boolean {
  // 长度按 trim 后的值计算，首尾空白不计入 160 的上限
  // 裁剪只落在局部变量上，不外传被改写后的文本
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= COMPACT_RESULT_MAX_LENGTH &&
    !trimmed.includes("\n") &&
    !looksLikeJson(trimmed)
  );
}

// 摘要文案只由 operation、状态与是否运行中决定，不读结果内容
// formatMessage 按词条 id 取文案，缺失时由 i18n 提供兜底，此处不拼接
// 返回的 detail 仅用于附加路径，非空时摘要行右侧追加等宽文本
function getSummary(
  model: NodeReplDisplayModel,
  status: string,
  isRunning: boolean,
  formatMessage: (id: string) => string,
): { title: string; status?: string; detail?: string } {
  // 三种终态各自独立判断，不假设状态机只会出现其中一个
  // denied 与 stopped 由用户或调度触发，与执行失败语义不同
  // 新增状态时必须同时处理这三个布尔与后续分支，否则会落到通用完成文案
  const isFailed = status === "failed";
  const isDenied = status === "denied";
  const isStopped = status === "stopped";

  // 拒绝与中断优先于 operation 分支，避免把未执行的操作显示成失败
  // 这两类摘要不带 detail 与 status，保持单行最短文案
  if (isDenied || isStopped) {
    return {
      title: formatMessage(
        isDenied ? "chat.toolCall.nodeRepl.denied" : "chat.toolCall.nodeRepl.stopped",
      ),
    };
  }

  // 重置的三态文案按失败、进行中、完成顺序选择
  // 重置没有结果内容，不要在 getSummary 之外再补 detail
  // 新增 operation 必须在此前插入对应分支，否则会落到通用完成文案
  if (model.operation === "reset") {
    return {
      title: formatMessage(
        isFailed
          ? "chat.toolCall.nodeRepl.resetFailed"
          : isRunning
            ? "chat.toolCall.nodeRepl.resetting"
            : "chat.toolCall.nodeRepl.reset",
      ),
    };
  }

  // 配置模块目录是唯一带 detail 的摘要，展示的是目标目录路径
  // 路径直接取 display model 字段，不在渲染层做拼接或截断
  // 进行中也要显示路径，便于用户确认改的是哪个目录
  if (model.operation === "add-module-dir") {
    return {
      title: formatMessage(
        isFailed
          ? "chat.toolCall.nodeRepl.configureFailed"
          : isRunning
            ? "chat.toolCall.nodeRepl.configuring"
            : "chat.toolCall.nodeRepl.configured",
      ),
      detail: model.moduleDirectory,
    };
  }

  // 通用兜底文案同样按失败、处理中、已完成三态选择
  // userTitle 存在时把它当主标题，兜底文案降级为状态后缀
  // status 为 undefined 表示没有后缀，摘要行只显示标题
  const fallbackTitle = formatMessage(
    isFailed
      ? "chat.toolCall.nodeRepl.failed"
      : isRunning
        ? "chat.toolCall.nodeRepl.processing"
        : "chat.toolCall.nodeRepl.finished",
  );
  return {
    title: model.userTitle ?? fallbackTitle,
    status: model.userTitle
      ? formatMessage(
          isFailed
            ? "chat.toolCall.nodeRepl.failed"
            : isRunning
              ? "chat.toolCall.nodeRepl.processing"
              : "chat.toolCall.nodeRepl.completed",
        )
      : undefined,
  };
}

// 统一的只读代码块封装，固定开启换行、关闭 mermaid 渲染
// cardSurface 控制底色，eagerLayout 只在已展开区域开启
// 标题栏只放换行与复制两个按钮，不暴露下载或编辑入口
function FriendlyCodeBlock({
  cardSurface = false,
  code,
  copyLabel,
  eagerLayout = false,
  label,
  language,
  wrapLabel,
}: {
  cardSurface?: boolean;
  code: string;
  copyLabel: string;
  eagerLayout?: boolean;
  label: string;
  language: string;
  wrapLabel: string;
}) {
  return (
    <CodeBlock
      className={cardSurface ? "bg-card" : undefined}
      code={code}
      enableSyntaxHighlighting={language !== "log"}
      language={language}
      renderMermaid={false}
      style={eagerLayout ? COLLAPSIBLE_CODE_LAYOUT_STYLE : undefined}
      wrapLongLines
    >
      <CodeBlockHeader className="pl-3 pr-2 pt-2">
        <CodeBlockTitle>
          <span className="text-ui-base font-medium text-foreground-subtle">{label}</span>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockWrapButton aria-label={wrapLabel} title={wrapLabel} />
          <CodeBlockCopyButton aria-label={copyLabel} title={copyLabel} />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

// 组件是纯投影：输入 toolCall 与渲染上下文，不发起任何副作用请求
// 所有 i18n 文案在渲染前一次性取出，避免在 JSX 分支里重复取词条
// 返回值只有两条路径：browser_turn_end 的纯图片网格，其余情况一律是完整卡片
export function NodeReplToolCallBlock(context: ToolCallBlockRenderContext) {
  // intl 只用于取词条，不做日期或数字格式化
  // formatMessage 依赖 intl 实例，切换语言时必须重建
  const { intl } = useZCodeIntl();
  // toolCall 是唯一数据源，组件不缓存副本也不回写
  // display model 每次由 toolCall 重新推导，此处不做增量合并
  // 运行态等外部信息走 context，不塞进 toolCall
  const { toolCall } = context.toolCallNode;
  // display model 依赖 toolCall 整体引用，流式更新时整对象重建
  // 不要在 memo 内读取 context.isRunning 等外部字段，否则与 summary 的依赖口径错位
  // 字段归一化全部由 buildNodeReplDisplayModel 承担，渲染层只做展示分支
  const model = useMemo(() => buildNodeReplDisplayModel(toolCall), [toolCall]);
  const formatMessage = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  // 摘要随运行态与状态变化重算，依赖必须含 formatMessage 以便切换语言
  // 不能缓存成常量，否则运行中转完成时标题不会更新
  // getSummary 内部不再 memo，重复计算成本只是一次字符串查表
  const summary = useMemo(
    () => getSummary(model, toolCall.status, context.isRunning, formatMessage),
    [context.isRunning, formatMessage, model, toolCall.status],
  );
  // Computer Use 的 cell 携带目标应用身份时，leading icon 换成该应用的真实图标 —— 连续
  // CUA 步骤据此一眼看出各步操作的是哪个 app。图标由平台服务按
  // locator 现取，取不到时保持 node_repl 自己的图标，不切换成另一个指针图形。
  // 两个提前返回必须给出同一个默认图标常量，否则会出现两套指针样式
  // 先判 model.app 再解析 iconRequest，避免对空身份做无意义的 key 映射
  // 依赖只取 model.app，其他字段变化不应触发图标重建
  const leadingIcon = useMemo(() => {
    if (!model.app) return NODE_REPL_TOOL_ICON;
    const iconRequest = cuaAppKeyToIconRequest(model.app.appKey);
    if (!iconRequest) return NODE_REPL_TOOL_ICON;
    return (
      <CuaAppSummaryIcon
        iconRequest={iconRequest}
        name={model.app.displayName ?? model.app.appKey}
        fallback={NODE_REPL_TOOL_ICON}
      />
    );
  }, [model.app]);
  // 以下文案在渲染前统一取出，避免在 JSX 条件分支里重复调用
  // 词条 id 集中在 nodeRepl 命名空间下，新增文案需同步语言包
  const resultLabel = formatMessage("chat.toolCall.nodeRepl.result");
  const noResultLabel = formatMessage("chat.toolCall.nodeRepl.noResult");
  const detailsLabel = formatMessage("chat.toolCall.nodeRepl.details");
  const detailContentLabel = formatMessage("chat.toolCall.nodeRepl.detailContent");
  const technicalDetailsLabel = formatMessage("chat.toolCall.nodeRepl.technicalDetails");
  const copyResultLabel = formatMessage("chat.toolCall.nodeRepl.copyResult");
  const copyDetailsLabel = formatMessage("chat.toolCall.nodeRepl.copyDetails");
  const wrapLinesLabel = formatMessage("chat.toolCall.nodeRepl.wrapLines");
  const resultImageLabel = formatMessage("chat.toolCall.nodeRepl.resultImage");
  const fullResultLabel = model.persistedResult
    ? intl.formatMessage(
        { id: "chat.toolCall.nodeRepl.fullResult" },
        { size: model.persistedResult.sizeLabel },
      )
    : undefined;
  // 只有 failed 才暴露错误摘要，运行中与成功一律留空
  // 优先取 display model 归一化后的 summary，缺失时才退回原始错误文本
  // 错误文本直接进入红条渲染，不做截断，完整堆栈交给技术明细
  const visibleError =
    toolCall.status === "failed" ? (model.error?.summary ?? context.errorText) : undefined;
  const hasTechnicalDetails = Boolean(model.code || model.error?.stack);
  // 四类内容任一存在即视为有可见结果：错误、文本、图片、落盘结果
  // 图片用长度判断而非真值，空数组等同于无结果
  // 落盘结果必须计入，否则大结果会被误判成无输出
  const hasVisibleResult = Boolean(
    visibleError || model.resultText || model.images.length > 0 || model.persistedResult,
  );
  // run 操作只要有可见结果或技术明细就可展开
  // 其他操作只在失败时允许展开，成功态没有可看的内容
  // 这里决定折叠入口是否存在，与 canToggle 是两个层次的判断
  const hasDetails =
    model.operation === "run"
      ? hasVisibleResult || hasTechnicalDetails
      : toolCall.status === "failed" && (hasVisibleResult || hasTechnicalDetails);
  // 外部显式传入的 canToggle 优先级最高，用于强制收起或强制展开
  // 用空值合并而非逻辑或，显式 false 必须被尊重
  // 默认值与 hasDetails 保持一致，避免入口与内容不一致
  const canToggle = context.canToggle ?? hasDetails;
  // 摘要行由标题、可选状态后缀、可选等宽 detail 三段组成
  // 整行单行截断，标题与 detail 可压缩，状态后缀 shrink-0 不参与压缩
  // 依赖只列三个字段，summary 其他变化不应触发重建
  const summaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-medium text-foreground-subtle">{summary.title}</span>
        {summary.status ? (
          <span className="shrink-0 text-foreground-subtlest">· {summary.status}</span>
        ) : null}
        {summary.detail ? (
          <code className="min-w-0 truncate font-mono text-foreground-subtlest">
            {summary.detail}
          </code>
        ) : null}
      </span>
    ),
    [summary.detail, summary.status, summary.title],
  );
  // 展开内容按优先级渲染：错误、短文本、长文本代码块、无结果占位
  // 空态只在非运行中且无图片时显示，运行中保持静默
  // 依赖列表覆盖所有用到的文案与 model 字段，漏项会导致内容不刷新
  const renderContent = useCallback(
    () => (
      // ToolLayout 已提供展开间距，Node REPL 再叠加横向 padding 会让 BUA
      // 结果相对摘要行二次缩进，在窄屏消息流里尤其突兀。
      <div className="mb-2 space-y-3 py-1" data-testid="node-repl-expanded-content">
        {visibleError ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-base font-medium text-destructive">{resultLabel}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
              {visibleError}
            </p>
          </section>
        ) : model.resultText && isCompactResult(model.resultText) ? (
          // BUA 常返回 done、标题或 URL 等短结果，完整代码块的标题栏、边框和
          // 操作按钮会让内容重量远大于信息本身；短结果按普通次级正文展示。
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="node-repl-result-surface"
          >
            {model.resultText.trim()}
          </p>
        ) : model.resultText ? (
          <div
            className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
            data-testid="node-repl-result-surface"
          >
            <FriendlyCodeBlock
              cardSurface
              code={model.resultText}
              copyLabel={copyResultLabel}
              eagerLayout
              label={resultLabel}
              language={looksLikeJson(model.resultText) ? "json" : "log"}
              wrapLabel={wrapLinesLabel}
            />
          </div>
        ) : !context.isRunning && model.images.length === 0 ? (
          <p className="text-ui-base text-foreground-subtle">{noResultLabel}</p>
        ) : null}

        {model.images.length > 0 ? (
          <NodeReplImageGrid images={model.images} resultImageLabel={resultImageLabel} />
        ) : null}

        {model.persistedResult && fullResultLabel ? (
          <div className="flex flex-wrap items-center gap-2 text-ui-base text-foreground-subtle">
            <span>{fullResultLabel}</span>
            {context.onOpenCodeViewer ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="px-0"
                onClick={() =>
                  context.onOpenCodeViewer?.({
                    type: "file",
                    title: resultLabel,
                    path: model.persistedResult!.artifactPath,
                  })
                }
              >
                {formatMessage("chat.toolCall.nodeRepl.openFullResult")}
                <ExternalLinkIcon className="size-3" />
              </Button>
            ) : null}
          </div>
        ) : null}

        {hasTechnicalDetails ? (
          <Collapsible className="group/details">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-foreground-subtlest hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground"
              >
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/details:rotate-90" />
                {detailsLabel}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-2 pt-2">
                {model.code ? (
                  <div
                    className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
                    data-testid="node-repl-detail-surface"
                  >
                    <FriendlyCodeBlock
                      cardSurface
                      code={model.code}
                      copyLabel={copyDetailsLabel}
                      eagerLayout
                      label={detailContentLabel}
                      language="javascript"
                      wrapLabel={wrapLinesLabel}
                    />
                  </div>
                ) : null}
                {model.error?.stack ? (
                  <div
                    className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
                    data-testid="node-repl-detail-surface"
                  >
                    <FriendlyCodeBlock
                      cardSurface
                      code={model.error.stack}
                      copyLabel={copyDetailsLabel}
                      eagerLayout
                      label={technicalDetailsLabel}
                      language="log"
                      wrapLabel={wrapLinesLabel}
                    />
                  </div>
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    ),
    [
      context.isRunning,
      context.onOpenCodeViewer,
      copyDetailsLabel,
      copyResultLabel,
      detailContentLabel,
      detailsLabel,
      formatMessage,
      fullResultLabel,
      hasTechnicalDetails,
      model,
      noResultLabel,
      resultImageLabel,
      resultLabel,
      technicalDetailsLabel,
      visibleError,
      wrapLinesLabel,
    ],
  );

  // 回合结束节点只渲染图片网格，不再重复摘要行与展开区
  // 此分支在卡片主体之前返回，新增展示内容需判断是否也适用于该来源
  // 图片为空时仍返回空网格，由下游组件自行处理空数组
  if (model.displaySource === "browser_turn_end") {
    return <NodeReplImageGrid images={model.images} resultImageLabel={resultImageLabel} />;
  }

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={leadingIcon}
        showIcon={context.showIcon !== false}
        canToggle={canToggle}
        forceOpen={context.forceOpen ?? false}
        kindLabel={null}
        sourceLabel={context.sourceLabel}
        primaryText={summaryText}
        statusLabel={formatMessage("chat.toolCall.nodeRepl.failed")}
        statusTooltip={visibleError}
        showFailureStatus={toolCall.status === "failed" && Boolean(model.userTitle)}
        isRunning={context.isRunning}
        title={summary.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
