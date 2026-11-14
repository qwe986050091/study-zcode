// INV-01 display 是工具名的唯一权威来源，raw.display 通过守卫即直接返回，legacy 规则不得覆盖；守住位置：readMcpToolPresentation 的 display 分支；改错故障：新记录被 legacy 二次切分，插件工具名被截成残缺前缀
// INV-02 display 只有在 kind 为 mcp_tool 且 serverName、toolName 均为去空白后非空时才生效，否则整条退回 legacy；守住位置：isMcpToolPresentation；改错故障：缺 serverName 的投影拆名失败返回 null，整块调用不渲染
// INV-03 presentation 为 null 时组件返回 null，不渲染任何占位；守住位置：McpToolCallBlock 末尾的判空返回；改错故障：MCP 调用在时间线里整块消失，用户以为工具没有被调用
// INV-04 类型守卫不校验 description，该字段随后直接作为 React 子节点与 ToolLayout 标题使用；守住位置：description 的两处渲染；改错故障：上游塞入对象型 description 时渲染抛错，整条消息白屏
// INV-05 server 展示名只取 plugin 冒号命名空间的末段，其余形态原样进入格式化；守住位置：formatMcpServerLabel 的 plugin 分支；改错故障：界面暴露内部 server key，来源文字与用户配置的名字对不上
// INV-06 标识符格式化只替换分隔符并大写首字符，不改变其余大小写；守住位置：formatMcpIdentifier；改错故障：驼峰与缩写被压平，GitHub 变 Github、URL 变 Url，工具名不可再按原样搜索
// INV-07 工具名前缀去重是大小写无关的一次性机械裁剪，只裁掉 server 标签长度的那一段；守住位置：formatMcpToolLabel；改错故障：摘要出现 Firebase 与 Firebase get environment 这类重复来源文字
// INV-08 legacy 解析要求执行名按双下划线恰好切成三段且首段为 mcp，否则返回 null；守住位置：readLegacyMcpToolPresentation 的分段判断；改错故障：非 MCP 工具被套上 MCP 卡片，或含双下划线的真实名字被整条丢弃
// INV-09 legacy 的来源与动作名取「来源 token 后缀等于工具 token 前缀」的最长公共段，从最长往短试；守住位置：tokenCount 递减循环；改错故障：重复前缀没去干净，摘要里来源名出现两次
// INV-10 公共段覆盖整个工具名时不裁剪，动作名回退为完整编码名；守住位置：公共段长度小于工具 token 数的条件；改错故障：卡片标题只剩来源文字，动作名为空
// INV-11 plugin 前缀的来源只取最后一个 token，该分支只在 token 数组非空时可达；守住位置：pluginScoped 与末位取值；改错故障：非空断言落在空数组上，渲染期抛 TypeError
// INV-12 结果文本对字符串原样透传、对 null 与 undefined 折算为空、其余走两空格缩进 JSON；守住位置：stringifyMcpResult 的三个分支；改错故障：字符串结果被再加一层引号转义，或空结果被显示成 null 字样
// INV-13 序列化失败（循环引用、BigInt、自定义 toJSON 抛错）必须回退字符串转换而绝不外抛；守住位置：stringifyMcpResult 的捕获分支；改错故障：一个异常结果让整块工具卡在渲染阶段崩溃
// INV-14 失败态优先于任何结果文本展示，错误文本取 error 或 errorText 两者其一；守住位置：visibleError 与 renderContent 的首个分支；改错故障：失败调用只剩旧结果，用户看不到失败原因
// INV-15 单行、非 JSON、长度不超过 160 的结果走纯文本表面，其余一律走可滚动代码块；守住位置：isCompactResult 与 renderContent 的二分；改错故障：长文本撑爆卡片高度，或结构化输出被当散文显示而丢掉缩进
// INV-16 JSON 识别只看去除首尾空白后的首字符是否为左大括号或左方括号，标量 JSON 与纯文本同等对待；守住位置：looksLikeJson 的首字符判断；改错故障：一句恰好合法的文本被标成 JSON 并启用高亮，语言标签与内容不符
// INV-17 JSON 探测自吞全部解析异常，任何输入都返回布尔而不上抛；守住位置：looksLikeJson 的捕获分支；改错故障：截断或非法的结构化输出在渲染期抛错，工具卡整体不可用
// INV-18 本 renderer 不展开 content 数组、不渲染图片，数组整体当 JSON 文本，未知 type 只是文本的一部分；守住位置：stringifyMcpResult 与 resultText 分支；改错故障：base64 图片以整屏文本出现，用户既看不到图也读不懂内容
// INV-19 pending 与 stopped 固定 summary-only，禁用切换并强制关闭展开；守住位置：isSummaryOnlyLifecycle 与两处属性；改错故障：父层展开请求穿透，用户看到空内容或诊断参数
// INV-20 摘要状态槽位按生命周期互斥：stopped 走次要文本槽、failed 走状态标签与提示，正常生命周期不重复状态文字；守住位置：stoppedSummaryStatus 与 failedSummaryStatus；改错故障：同一状态显示两次，或 stopped 的两个文本节点粘连
import { ChevronRightIcon, PlugIcon } from "lucide-react";
import { useCallback } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockWrapButton,
} from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ToolCallProgressIndicator,
  readToolCallProgress,
} from "@/ToolCallBlocks/ToolCallProgressIndicator.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

interface McpToolPresentation {
  kind: "mcp_tool";
  serverName?: string;
  toolName: string;
  description?: string;
}

const MCP_TOOL_ICON = <PlugIcon className="size-4 shrink-0 text-foreground-subtle" />;
const COMPACT_RESULT_MAX_LENGTH = 160;
const COLLAPSIBLE_CODE_LAYOUT_STYLE = {
  containIntrinsicSize: "none",
  contentVisibility: "visible",
} as const;

// [权衡] 先按首字符粗筛而不是直接试解析：纯文本结果也付一次解析成本，且无法把「看起来像 JSON 的日志」与真正的结构化结果分开
// 探测结果不缓存，结果分支每次渲染都把同一份文本最多探测三次：紧凑判定一次，语言与高亮开关各一次
// 重复解析的开销随输出体积线性增长，MCP 结果常见几十 KB 的 JSON，这是本文件唯一随载荷放大的固定成本
// [失败路径] 解析异常必须在本函数内吞掉：调用点位于渲染路径，任何上抛都会把整个工具卡交给错误边界
// 首字符判断在去除首尾空白之后进行，避免前导换行让缩进良好的 JSON 被判成纯文本
// 只认对象与数组，标量 JSON 走纯文本分支，避免把一句恰好合法的文本高亮成 JSON
// 返回语义是「像 JSON」而不是「是 JSON」，代码块需要能容忍非法输入，高亮失败不回退也不报错
// [权衡] 若改为缓存探测结果，需要把状态提到组件外或改用记忆化钩子，生命周期比单次渲染更难保证，收益只有一次解析
function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// 阈值 160 是「短回执」与「需要代码块」的分界，按 UTF-16 码元计长，中文与 emoji 的实际观感长度与此不一致
// 换行判定先于 JSON 判定执行：多行文本无论多短都不进纯文本表面，否则卡片高度会随返回内容不可预期地增长
// JSON 一律不进纯文本分支，哪怕只有一个键：压平后的对象失去缩进，用户无法核对字段边界
// 空串与纯空白被显式排除，交给下游的状态占位分支，避免渲染一个空白盒子
// [权衡] 用长度属性而非字素计数是为了零依赖；代价是 160 个码元相当于 80 个汉字，中文比英文更早切成代码块
// 只对去空白后的副本测长，展示时再对原串去空白，测长与展示看到同一份内容
// 判定是纯函数，不读调用状态；生命周期语义完全由 renderContent 的分支顺序承担
// [失败路径] 非字符串输入到不了这里：上游转换已保证结果文本是字符串或 undefined
function isCompactResult(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= COMPACT_RESULT_MAX_LENGTH &&
    !trimmed.includes("\n") &&
    !looksLikeJson(trimmed)
  );
}

// MCP 的结果形态不固定：纯文本、结构化对象、content 数组都可能出现，本函数不做判别，统一转成可展示文本
// 字符串原样返回，不去空白也不试解析：服务端返回的缩进与换行本身就是用户要核对的证据
// null 与 undefined 都折算成 undefined，让上游的一次真值判断同时覆盖「没有结果」与「空结果」
// [资源] 结构化输出先整体序列化再交给代码块：base64 图片与长日志以原体积驻留在字符串里，没有截断阈值
// [失败路径] 序列化可能抛错（循环引用、BigInt、自定义 toJSON 抛异常），捕获后回退到字符串转换，宁可丢结构也不让卡片崩溃
// 回退产物可能是 [object Object] 这样的占位文本，这是刻意接受的降级：它至少能被复制出来用于反馈
// [权衡] 若把 content 数组拆成文本段与图片段分别渲染，需要引入 MIME 分支与图片加载失败态，本 renderer 选择整体当文本
// 缩进固定两空格而不跟随编辑器配置，保证复制出去的 JSON 与界面所见完全一致
function stringifyMcpResult(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// 守卫只承认 kind 为 mcp_tool 且 serverName 与 toolName 都是去空白后非空字符串的投影
// serverName 在接口里声明为可选，这里却要求必有：缺来源的投影无法定位 server，退回 legacy 还能从协议名里恢复
// [失败路径] 只填 toolName 的新记录会被拒，legacy 也拆不出三段，最终返回 null，整块调用不渲染
// description 不参与校验却会作为 React 子节点渲染，非字符串值会让渲染抛错，这是本守卫唯一未覆盖的字段
// 多余字段一律忽略，守卫不复制对象，直接把原引用交给调用方
// 去空白只用于判空，返回值仍是原始字符串，首尾空白留给格式化函数处理
// [权衡] 不引入 schema 校验库是为了让 renderer 保持零依赖，代价是字段类型错误只能在渲染期暴露
// kind 用严格相等比较，大小写变体不视为 MCP，避免把近似字段误判成投影
function isMcpToolPresentation(value: unknown): value is McpToolPresentation {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "mcp_tool" &&
    typeof record.serverName === "string" &&
    record.serverName.trim().length > 0 &&
    typeof record.toolName === "string" &&
    record.toolName.trim().length > 0
  );
}

// legacy 记录只剩协议执行名，本函数用纯机械规则恢复来源与动作名，不查任何注册表
// 先要求按双下划线恰好切成三段且首段为 mcp，段数不符直接返回 null，宁可整块不渲染也不误套卡片
// 来源与工具各自按下划线切成 token，再找来源后缀与工具前缀的最长公共段，用来消掉来源名在工具名里重复出现的情况
// 循环从最长候选往下试并命中即停：优先去掉尽可能长的重复前缀，剩下的动作名最短也最干净
// [权衡] 最长匹配也会误吞真实前缀：来源为 foo_bar、工具为 bar_baz 时公共段是 bar，标签变成 Bar Baz 并丢掉 foo
// 公共段覆盖整个工具名时不裁剪，直接保留完整编码名，避免动作名为空后标题只剩来源文字
// plugin 命名空间的来源只取最后一个 token，该分支与公共段分支互斥，公共段优先
// [失败路径] 末位取值的非空断言安全：plugin 前缀为真必然意味着 token 数组首元素存在
function readLegacyMcpToolPresentation(toolName: string | undefined): McpToolPresentation | null {
  if (!toolName) return null;
  const segments = toolName.split("__");
  if (segments.length !== 3 || segments[0] !== "mcp" || !segments[1] || !segments[2]) return null;

  const encodedServerName = segments[1];
  const encodedToolName = segments[2];
  const serverTokens = encodedServerName.split("_").filter(Boolean);
  const toolTokens = encodedToolName.split("_").filter(Boolean);
  let sharedTokenCount = 0;
  const maximumSharedTokens = Math.min(serverTokens.length, toolTokens.length);
  for (let tokenCount = maximumSharedTokens; tokenCount > 0; tokenCount -= 1) {
    if (
      serverTokens.slice(-tokenCount).join("_").toLocaleLowerCase() ===
      toolTokens.slice(0, tokenCount).join("_").toLocaleLowerCase()
    ) {
      sharedTokenCount = tokenCount;
      break;
    }
  }
  const pluginScoped = serverTokens[0]?.toLocaleLowerCase() === "plugin";
  const serverName =
    sharedTokenCount > 0
      ? serverTokens.slice(-sharedTokenCount).join("_")
      : pluginScoped
        ? serverTokens.at(-1)!
        : encodedServerName;
  const actionName =
    sharedTokenCount > 0 && sharedTokenCount < toolTokens.length
      ? toolTokens.slice(sharedTokenCount).join("_")
      : encodedToolName;

  // display 持久化上线前的 MCP 历史记录只剩协议执行名，通用 renderer
  // 会把内部 raw JSON 整块暴露出来。这里只按协议 envelope 和编码 token 做机械拆分；
  // 新记录仍以 tools/list 的 discovery display 为权威，不让 legacy 规则覆盖它。
  return { kind: "mcp_tool", serverName, toolName: actionName };
}

export function readMcpToolPresentation(
  context: Pick<ToolCallBlockRenderContext, "toolCallNode">,
): McpToolPresentation | null {
  const raw = context.toolCallNode.toolCall.raw;
  if (typeof raw === "object" && raw !== null) {
    const display = (raw as Record<string, unknown>).display;
    if (isMcpToolPresentation(display)) return display;
  }
  return readLegacyMcpToolPresentation(context.toolCallNode.toolCall.toolName);
}

export function formatMcpIdentifier(value: string): string {
  const words = value.trim().replace(/[-_]+/gu, " ").replace(/\s+/gu, " ");
  if (!words) return value;
  return words[0]!.toLocaleUpperCase() + words.slice(1);
}

export function formatMcpServerLabel(value: string): string {
  const namespaceSegments = value
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);
  // 插件 MCP 的 configured server key 带有 plugin:<plugin>:<server> 命名空间，
  // 直接作为 UI 文案会暴露内部路由标识。末段才是用户配置的 server 名称。
  const displayIdentifier =
    namespaceSegments[0]?.toLocaleLowerCase() === "plugin" && namespaceSegments.length > 1
      ? namespaceSegments.at(-1)!
      : value;
  return formatMcpIdentifier(displayIdentifier);
}

export function formatMcpToolLabel(toolName: string, serverLabel: string): string {
  const formattedToolName = formatMcpIdentifier(toolName);
  const repeatedPrefix = `${serverLabel} `;
  // 不少 MCP 工具会再次用 server 名作为 tool 前缀；summary 同时展示 server
  // 来源文字时会出现 Firebase / Firebase get environment。只做大小写无关的机械去重。
  return formattedToolName.toLocaleLowerCase().startsWith(repeatedPrefix.toLocaleLowerCase())
    ? formatMcpIdentifier(formattedToolName.slice(repeatedPrefix.length))
    : formattedToolName;
}

export function McpToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const presentation = readMcpToolPresentation(context);
  const { toolCall } = context.toolCallNode;
  const serverLabel = presentation?.serverName
    ? formatMcpServerLabel(presentation.serverName)
    : undefined;
  // 没有投影时回退到调用标题，这是旧记录与非 MCP 调用唯一可用的展示名，不会是空串
  // 来源标签先经格式化再作为去重前缀传入工具名格式化，两处必须使用同一份字符串，否则去重条件永不成立
  // 来源缺失时传空串而不是 undefined，避免前缀比较时把 undefined 拼进模板文本
  // [权衡] 去重放在展示层而不改数据：同名工具在不同来源下会得到不同标签，这是有意的，Firebase 的 get 与 GitHub 的 get 只差来源
  // 工具标签只用于主文本，不参与悬停标题；悬停标题走描述到工具名的兜底链
  // 标签计算每次渲染都执行，全是纯字符串操作，没有记忆化的必要
  // [失败路径] 投影里的工具名已由守卫保证非空白，此处不做二次判空
  const toolLabel = presentation
    ? formatMcpToolLabel(presentation.toolName, serverLabel ?? "")
    : toolCall.title;
  const callDetailsLabel = intl.formatMessage({ id: "chat.toolCall.mcp.callDetails" });
  const resultLabel = intl.formatMessage({ id: "chat.toolCall.mcp.result" });
  const copyResultLabel = intl.formatMessage({ id: "chat.toolCall.mcp.copyResult" });
  const wrapLinesLabel = intl.formatMessage({ id: "chat.toolCall.mcp.wrapLines" });
  const descriptionLabel = intl.formatMessage({ id: "chat.toolCall.mcp.description" });
  const parametersLabel = intl.formatMessage({ id: "chat.toolCall.mcp.parameters" });
  const hasCallDetails = Boolean(presentation?.description || toolCall.input !== undefined);
  // 结果来源是 output 而不是 input，后者只进参数折叠区，两者语义不可互换
  // 转换在渲染期完成且不缓存，父层每次重渲染都会重新序列化整份输出
  // 有无主结果同时取决于结果文本与可见错误，二者任一存在就要给出结果表面
  // 两者都为空时不渲染空盒子，而是落到状态占位分支
  // [资源] 序列化结果整份驻留内存，没有长度截断，滚动容器只限制可见高度
  // [权衡] 不在这里按 MIME 拆分图片，是因为 renderer 没有图片解码与失败态，代价是大图变成文本墙
  // 失败态仍会算出结果文本，只是渲染分支被可见错误抢先，避免失败时丢掉已经到达的部分结果
  const resultText = stringifyMcpResult(toolCall.output);
  const visibleError = toolCall.status === "failed" ? (toolCall.error ?? context.errorText) : undefined;
  const hasPrimaryResult = Boolean(resultText || visibleError);
  const isSummaryOnlyLifecycle = toolCall.status === "pending" || toolCall.status === "stopped";
  // R7：运行中且 agent 投影了 MCP 进度时，摘要行显示细进度条 + message；终态由投影清除。
  const progress = toolCall.status === "in_progress" ? readToolCallProgress(toolCall.raw) : null;
  const stoppedSummaryStatus =
    toolCall.status === "stopped" ? (
      <span className="inline-flex items-center gap-2">
        <span className="text-foreground-subtlest">·</span>
        <span>{context.statusLabel}</span>
      </span>
    ) : progress ? (
      <ToolCallProgressIndicator progress={progress} />
    ) : undefined;
  const failedSummaryStatus =
    toolCall.status === "failed" ? (
      <span className="inline-flex items-center gap-2">
        <span className="text-foreground-subtlest">·</span>
        <span>{context.statusLabel}</span>
      </span>
    ) : undefined;
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      // MCP 详情之前先展示 description 和参数，用户展开后仍像 API 调试器。
      // 参考 BUA，把结果作为一级内容；调用元数据收进透明的二级折叠区。
      <div className="mb-2 space-y-3 py-1" data-testid="mcp-expanded-content">
        {visibleError ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-base font-medium text-destructive">{resultLabel}</h4>
            <p
              className="whitespace-pre-wrap break-words rounded-lg bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
              data-testid="mcp-error-surface"
            >
              {visibleError}
            </p>
          </section>
        // 三个结果表面互斥且有序：错误、紧凑文本、代码块，顺序不可交换
        // 错误分支先判，失败时即使有结果也只显示错误，错误比半成品结果更需要被看见
        // 紧凑分支输出段落而不是代码块，省掉标题栏、复制与换行按钮，短回执不需要工具条
        // 代码块分支固定最大高度与滚动，长输出在容器内滚动而不撑高卡片
        // [资源] 代码块开启语法高亮与自动换行，语言与高亮开关都由结果文本再探测一次 JSON 决定，探测为假按日志处理
        // [失败路径] 未知 content 类型不进任何分支：它们只是 JSON 文本里的字段值，被原样显示而不是解析后丢弃
        // 紧凑分支与代码块分支共用同一个结果测试标记，端到端断言只区分有没有结果，不区分具体形态
        ) : resultText && isCompactResult(resultText) ? (
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="mcp-result-surface"
          >
            {resultText.trim()}
          </p>
        ) : resultText ? (
          <div
            className="max-h-72 overflow-auto rounded-xl border border-border bg-card"
            data-testid="mcp-result-surface"
          >
            <CodeBlock
              appTheme={context.theme}
              className="bg-card"
              code={resultText}
              enableSyntaxHighlighting={looksLikeJson(resultText)}
              language={looksLikeJson(resultText) ? "json" : "log"}
              renderMermaid={false}
              style={COLLAPSIBLE_CODE_LAYOUT_STYLE}
              wrapLongLines
            >
              <CodeBlockHeader className="pl-3 pr-2 pt-2">
                <CodeBlockTitle>
                  <span className="text-ui-base font-medium text-foreground-subtle">
                    {resultLabel}
                  </span>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockWrapButton aria-label={wrapLinesLabel} title={wrapLinesLabel} />
                  <CodeBlockCopyButton aria-label={copyResultLabel} title={copyResultLabel} />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        ) : toolCall.status === "pending" ? (
          <p
            className="break-words rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
            data-testid="mcp-pending-surface"
          >
            {context.statusLabel}
          </p>
        ) : (
          // 无 result 的 pending/running/stopped MCP 展开后 ToolCallBody 为空，
          // 用户无法判断当前阶段。这里沿用 summary 的国际化状态，不另造生命周期文案。
          <p className="text-ui-base text-foreground-subtle">{context.statusLabel}</p>
        )}
        {hasCallDetails ? (
          <Collapsible className="group/details">
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-foreground-subtlest hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground"
              >
                <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]/details:rotate-90" />
                {callDetailsLabel}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-3 pt-2">
                {presentation?.description ? (
                  <section className="space-y-1.5">
                    <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                      {descriptionLabel}
                    </h4>
                    <p className="whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
                      {presentation.description}
                    </p>
                  </section>
                ) : null}
                {toolCall.input !== undefined ? (
                  <section className="space-y-1.5">
                    <h4 className="text-ui-sm font-medium text-foreground-subtlest">
                      {parametersLabel}
                    </h4>
                    <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                      <CodeBlock
                        appTheme={context.theme}
                        code={JSON.stringify(toolCall.input, null, 2)}
                        language="json"
                      />
                    </div>
                  </section>
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </div>
    ),
    [
      callDetailsLabel,
      copyResultLabel,
      context,
      descriptionLabel,
      handleLoadFullToolCallFields,
      hasCallDetails,
      hasPrimaryResult,
      parametersLabel,
      presentation?.description,
      resultLabel,
      resultText,
      toolCall,
      visibleError,
      wrapLinesLabel,
    ],
  );

  if (!presentation) return null;

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={MCP_TOOL_ICON}
      showIcon={context.showIcon !== false}
      // Pending / stopped 没有可消费结果，展开只会重复状态或暴露诊断参数。
      // 即使父层请求 forceOpen，也必须遵守这两个生命周期的 summary-only 语义。
      // [失败路径] 生命周期判断位于与父层意愿做逻辑与的左侧，父层即使要求展开也穿不透 pending 与 stopped
      // stopped 属于可展开语义之外的异常终态，它的信息只在摘要状态槽位里
      // 已完成与运行中的调用不受这条约束，它们有结果或进度可以展开查看
      // [权衡] 两个属性各自复算同一个生命周期判断而不抽公共变量：条件同源，多一次比较换取与强制展开的对称可读性
      // 父层切换能力默认为真，这里用空值合并而不是逻辑或，避免父层显式传假被当成缺省
      // 强制展开默认假，同样用空值合并保留父层的显式值
      // 两个属性必须同时受生命周期约束：只关切换不关强制展开，展开内容仍会被强制渲染
      // [并发] 摘要进度与展开内容读同一份调用快照，进度只在运行中从原始数据投影一次，展开区不另读，避免出现两条不同进度的进度条
      canToggle={!isSummaryOnlyLifecycle && (context.canToggle ?? true)}
      forceOpen={!isSummaryOnlyLifecycle && (context.forceOpen ?? false)}
      kindLabel="MCP"
      kindDetail={
        serverLabel ? (
          <span className="text-foreground-subtle">{serverLabel}</span>
        ) : undefined
      }
      primaryText={toolLabel}
      summaryContentSeparator="·"
      // Pending/Running/Completed 都是正常生命周期，不在摘要重复状态；Stopped 是异常终态，
      // 用显式分隔节点避免非动画摘要的两个文本节点粘连。Failed 使用专用错误状态槽位。
      secondaryText={stoppedSummaryStatus}
      statusLabel={failedSummaryStatus}
      statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={context.isRunning}
      title={presentation.description ?? presentation.toolName}
      renderContent={renderContent}
    />
  );
}
