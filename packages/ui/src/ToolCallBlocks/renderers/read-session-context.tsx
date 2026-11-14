// INV-01 上下文块整体只读，任何 extract* 与渲染分支都不得回写 toolCall 节点；守住位置：ReadSessionContextToolCallBlock 及全部读取函数；改错故障：渲染期改写共享节点会让同一 toolCall 在其他面板显示错乱并引发无意义重渲染
// INV-02 一次工具调用只对应一个渲染实例，组件不生成列表 key 也不重排调用顺序；守住位置：ReadSessionContextToolCallBlock 根节点；改错故障：key 漂移导致展开状态与滚动位置在流式更新后丢失
// INV-03 展示值一律是 extract* 归一化后的字符串，禁止把 toolCall 对象直接塞进 JSX 子节点；守住位置：query、sessionId、resultContent 三处取值；改错故障：对象作为 React 子节点会直接抛错，整个工具块白屏
// INV-04 字段探测优先级固定为 input 再到 output 再到 rawInput 再到 rawOutput，命中即返回；守住位置：extractQuery 与 extractSessionId 的候选数组；改错故障：顺序调换会让带包装壳的旧快照丢失检索问题，标题退化成通用占位
// INV-05 会话号必须同时兼容 sessionId 与 session_id 两种序列化风格；守住位置：extractSessionId 的键列表；改错故障：只认驼峰会漏掉后端下划线快照，副标题永远为空
// INV-06 trim 后为空的字符串等价于字段缺失，不得向上返回；守住位置：readStringField 与 extractTextContent 的字符串分支；改错故障：返回空白串会让无结果占位被跳过，正文渲染成一片空白
// INV-07 失败状态优先展示 errorText 并整体遮蔽成功结果；守住位置：visibleResult 的状态三元分支；改错故障：失败时继续展示上一次成功输出会误导用户以为读取已成功
// INV-08 无结果时必须有本地化占位文案，panel 内不允许出现无文字的 section；守住位置：renderContent 中 visibleResult 的判空分支；改错故障：空 section 让用户看到不可解释的空白区域
// INV-09 检索问题与结果正文都必须可折行，不得横向溢出卡片；守住位置：query 的 whitespace-pre-wrap 与 MessageResponse 的 break-words；改错故障：超长无空格内容撑破卡片，详情面板出现横向滚动条
// INV-10 标题兜底顺序固定为 query 再到 toolCall.title 再到本地化通用标题；守住位置：primaryText 的 useMemo；改错故障：兜底顺序颠倒会让用户看到通用标题而非实际检索问题
// INV-11 敏感内容只按后端快照字段原样展示，前端不做脱敏替换或语义裁剪；守住位置：extractResultContent 与 MessageResponse 渲染；改错故障：前端私自改写会与原始快照不一致，排查时误判上下文来源
// INV-12 长结果文本的截断与省略由 MessageResponse 单层负责，本文件不做二次切片；守住位置：renderContent 传入的 children；改错故障：两层各自截断会让省略号与展开全文的计数对不上
// INV-13 派生值的依赖数组必须逐项列全，尤其 context 上的回调、主题与代码预览设置；守住位置：primaryText、secondaryText、renderContent 的依赖数组；改错故障：漏依赖导致切换主题或设置后内容不刷新
// INV-14 intl 对象变化必须让标题与全部文案重新计算；守住位置：primaryText 与 renderContent 的依赖项；改错故障：切换语言后工具块仍停留在旧语言文案
// INV-15 快照字段提示只在存在 snapshotRefs 时渲染，缺省必须归一成空数组；守住位置：ToolSnapshotFieldNotice 的 refs 传参；改错故障：把 undefined 交给该组件会让提示条常驻或直接判空崩溃
// INV-16 外层未提供加载回调时提示条退化为只读，点击不得抛异常；守住位置：onLoadFullToolCallFields 的三元传参；改错故障：无条件调用未定义回调会在用户点击时抛 TypeError 白屏
// INV-17 成功状态不得渲染失败配色与错误 tooltip；守住位置：statusTooltip 与 showFailureStatus 两个属性；改错故障：成功的工具块显示红色失败态，诱导用户重复重试
// INV-18 展开后副标题隐藏，避免与标题争抢横向空间；守住位置：ToolLayout 的 hideSecondaryTextWhenOpen；改错故障：折叠态下超长 sessionId 把标题压成省略号，用户无法辨认检索问题
// INV-19 图标常量在模块级创建一次，不得在渲染体内新建元素；守住位置：READ_SESSION_CONTEXT_TOOL_ICON 定义与 icon 传参；改错故障：每次渲染新建元素会让 ToolLayout 判定 icon 变化并触发无谓重渲染
import { BookOpenTextIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const READ_SESSION_CONTEXT_TOOL_ICON = (
  <BookOpenTextIcon className="size-4 shrink-0 text-foreground-subtle" />
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readNestedRecordField(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (isPlainRecord(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

// 该函数是结果正文的唯一入口，需要同时吃下字符串、数组、对象与数字四类快照形态。
// 字符串分支先 trim 判空再返回原串，保留首尾换行，避免 Markdown 代码块围栏被破坏。
// 数组分支递归后按换行拼接，多段 content 因此恢复成文本流，而不是挤成一行。
// [失败路径] 数组递归没有深度上限，但快照由后端序列化产生，结构有限且不可能自引用。
// 对象分支先查 content、output、result、text、message、error 六个直接字段，命中即返回。
// 直接字段全空时才下钻 rawOutput 与 output 嵌套层，兼容被多包一层的旧格式快照。
// 末尾再单独看一次 content 数组，覆盖 directText 阶段因数组被跳过而漏掉的情况。
// 全部分支失败时返回 undefined，由调用方决定占位文案，本函数绝不向上返回空串。
function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextContent(item))
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!isPlainRecord(value)) {
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }

    return undefined;
  }

  // 这里是对象快照的主干命中点，键顺序即优先级：content 最贴近正文，error 排最后。
  // [权衡] 用一次多键查找替代六段 if：六段判断要在每级重复写类型守卫，
  // 查找表写法把顺序即优先级这一契约集中到一个数组字面量上，改序只需改一处。
  // 命中空串或纯空白不算命中，readStringField 会继续往后试，避免空 content 遮蔽真实 output。
  // error 放最后：部分后端会同时返回成功结果与残留 error 字段，正文优先才不会丢内容。
  // 该数组每次调用都会新建，代价可忽略，因为没有索引构建与闭包捕获。
  // 直接字段的返回值不做 trim 归一化，保留原始缩进供 Markdown 识别嵌套代码块。
  // 后端新增字段名时只在此追加，不要调整既有顺序，顺序变化会改变已上线快照的展示结果。
  const directText = readStringField(value, [
    "content",
    "output",
    "result",
    "text",
    "message",
    "error",
  ]);
  if (directText) {
    return directText;
  }

  const nestedRecord = readNestedRecordField(value, ["rawOutput", "output"]);
  if (nestedRecord) {
    const nestedText = extractTextContent(nestedRecord);
    if (nestedText) {
      return nestedText;
    }
  }

  const content = value.content;
  if (Array.isArray(content)) {
    const contentText = extractTextContent(content);
    if (contentText) {
      return contentText;
    }
  }

  return undefined;
}

function readRawInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return undefined;
  }

  return raw.rawInput ?? raw.input;
}

function readRawOutput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return undefined;
  }

  return raw.rawOutput ?? raw.output;
}

// 检索问题是标题与正文的共用来源，取值口径必须与后端写入快照时保持一致。
// input 为字符串时直接采用，这是最老也最稳的形态，优先于任何对象解析。
// 字符串 input 为空时继续走对象候选而不是提前返回，否则会丢掉包装形态的快照。
// 候选顺序为 input 再到 output 再到 rawInput 再到 rawOutput，对应请求体更权威的判断。
// [失败路径] 任一候选不是普通记录就跳过，数组与 null 不会中断整个查找过程。
// 键列表 query 与 prompt 与 question 覆盖三种叫法，顺序固定，避免换版本后取值漂移。
// 找不到时返回 undefined，由标题兜底链接管，本函数不返回空串以区分缺失与空值。
// [权衡] 不在 output 里做语义猜测：输出正文里的问题往往是复述，展示后会与结果重复。
function extractQuery(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  if (typeof toolCall.input === "string") {
    const trimmed = toolCall.input.trim();
    return trimmed.length > 0 ? toolCall.input : undefined;
  }

  for (const candidate of [
    toolCall.input,
    toolCall.output,
    readRawInput(toolCall.raw),
    readRawOutput(toolCall.raw),
  ]) {
    if (!isPlainRecord(candidate)) {
      continue;
    }

    const query = readStringField(candidate, ["query", "prompt", "question"]);
    if (query) {
      return query;
    }
  }

  return undefined;
}

// 会话号是副标题的唯一来源，取错会让用户误判这次读取发生在哪个会话。
// 与 extractQuery 采用同一套候选顺序，保证两个字段取自同一层快照。
// 键列表同时接受 sessionId 与 session_id，两种序列化风格都必须覆盖。
// [失败路径] 命中空串视为未命中并继续，否则副标题会渲染出一个空的 code 标签占位。
// 每个候选只查一层，不做嵌套下钻：会话号在快照里始终是顶层标量。
// 找不到时返回 undefined，副标题整块不渲染，而不是渲染一行占位文案。
// [权衡] 不从 toolCall.id 或标题反推会话号，推断值猜错比不显示更有害。
// 该返回值直接进入 secondaryText 的依赖数组，保持字符串类型以便稳定比较。
function extractSessionId(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  for (const candidate of [
    toolCall.input,
    toolCall.output,
    readRawInput(toolCall.raw),
    readRawOutput(toolCall.raw),
  ]) {
    if (!isPlainRecord(candidate)) {
      continue;
    }

    const sessionId = readStringField(candidate, ["sessionId", "session_id"]);
    if (sessionId) {
      return sessionId;
    }
  }

  return undefined;
}

function extractResultContent(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  const outputText = extractTextContent(toolCall.output);
  if (outputText) {
    return outputText;
  }

  return extractTextContent(readRawOutput(toolCall.raw));
}

// 本组件把一次读取会话上下文调用降级成三个纯字符串：检索问题、会话号、结果正文，渲染层只消费这三者。
// 三个值在函数体顶部一次性算完，下面所有 JSX 分支都不再回查 toolCall，避免同一帧内出现两种取值口径。
// [权衡] 没有把 extract* 收进 useMemo：它们的入参 toolCall 在单次渲染内引用稳定，
// 提前缓存只增加依赖声明面积；真正需要复用的是下方三个带依赖数组的派生块。
// 失败分流在这里就完成，后续节点拿到的都是最终要展示的文本，不必再判断 status。
// [失败路径] status 为 failed 而 errorText 为空时 visibleResult 是空串，会落到无结果占位，而不是抛异常。
// 该组件按 kind 被注册表直接引用，改名会静默退化成通用工具块，样式与文案一并丢失。
// 组件不接收 children、不读全局 store，保持纯渲染才能在折叠与展开之间安全重挂载。
export function ReadSessionContextToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const query = extractQuery(toolCall);
  const sessionId = extractSessionId(toolCall);
  const resultContent = extractResultContent(toolCall);
  // [失败路径] 这是整块唯一的成功与失败分流点，分错会让用户在失败时看到上一次的内容。
  // failed 时用 errorText 覆盖 resultContent 而不是两者拼接：错误信息已包含后端给出的失败原因。
  // errorText 可能带换行与 Markdown，仍交给 MessageResponse 渲染，才能保持段落与代码块语义。
  // 非 failed 但结果为空的情况不在这里兜底，留给 renderContent 的占位分支，两种空态在视觉上保持可区分。
  // [权衡] 不在此处按长度截断：截断阈值属于 MessageResponse 的展示策略，
  // 在这里先切一刀会让折叠态的字符计数与实际渲染长度不一致。
  // failed 的 statusTooltip 也取同一个 errorText，两处读一个变量即可避免文案分叉。
  // 该值是字符串类型并被 useCallback 依赖数组引用，不要改成对象包装，否则缓存每帧失效。
  const visibleResult = toolCall.status === "failed" ? errorText : resultContent;
  const fallbackTitle = intl.formatMessage({ id: "chat.toolCall.sessionContext.title" });
  const primaryText = useMemo(
    () => <span className="min-w-0 truncate">{query ?? toolCall.title ?? fallbackTitle}</span>,
    [fallbackTitle, query, toolCall.title],
  );
  const secondaryText = useMemo(
    () =>
      sessionId ? (
        <code className="min-w-0 truncate rounded-md bg-surface px-1.5 py-0.5 font-mono text-ui-base text-foreground-subtle">
          {sessionId}
        </code>
      ) : undefined,
    [sessionId],
  );
  // 内容区按需构建，折叠时 ToolLayout 不调用它，因此这里的 JSX 不会被创建。
  // [权衡] 用 useCallback 而非普通函数：ToolLayout 依赖该引用的稳定性决定是否重建子树。
  // query 区块仅在取到问题时渲染，避免出现只有标题没有内容的空 section。
  // [失败路径] 结果为空且非失败态时渲染本地化占位，保证 panel 内始终有可读文本。
  // 结果正文交给 MessageResponse，代码块、文件链接与外链的打开行为统一由它接管。
  // break-words 与 whitespace-pre-wrap 同时存在：前者防长 token 溢出，后者保原始换行。
  // 依赖数组逐项列出 context 字段而非整个 context，防止外层每次新建对象导致缓存全失效。
  // 漏掉任一 context 字段都会让切换工作区或代码预览设置后内容不更新。
  const renderContent = useCallback(
    () => (
      <div className="space-y-3 rounded-xl border border-border bg-panel px-4 py-3">
        {query ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-base font-medium uppercase text-foreground-subtle">
              {intl.formatMessage({
                id: "chat.toolCall.sessionContext.query",
              })}
            </h4>
            <p className="whitespace-pre-wrap break-words text-ui-base text-foreground">{query}</p>
          </section>
        ) : null}
        <section className="space-y-1.5">
          <h4 className="text-ui-base font-medium uppercase text-foreground-subtle">
            {intl.formatMessage({
              id: "chat.toolCall.sessionContext.result",
            })}
          </h4>
          {visibleResult ? (
            <MessageResponse
              className="min-w-0 break-words text-ui-base"
              workspacePath={context.workspacePath}
              theme={context.theme}
              codePreviewSettings={context.codePreviewSettings}
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenExternalUrl={context.onOpenBrowserUrl}
            >
              {visibleResult}
            </MessageResponse>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "chat.toolCall.sessionContext.noResult",
              })}
            </p>
          )}
        </section>
      </div>
    ),
    [
      context.codePreviewSettings,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      intl,
      query,
      visibleResult,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={READ_SESSION_CONTEXT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({
          id: isRunning
            ? "chat.toolCall.sessionContext.reading"
            : "chat.toolCall.kind.sessionContext",
        })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={secondaryText}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        // 运行态只影响 kindLabel 的文案与指示器，不改变内容区的可见性。
        // 失败态与运行态可以同时为真：标题显示读取中，正文依旧展示 errorText。
        // [失败路径] 该属性与下方 showFailureStatus 必须同源，否则会出现运行中却标红的矛盾态。
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={renderContent}
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
