// 【模块】轨迹明细的纯展示层：把模型轨迹片段、用量与汇总投影成可读细节，不持有任何业务状态。
// 【边界】全部输入来自调用方 props，组件内不发请求、不订阅 store、不写日志，同一输入必得同一渲染。
// 【权衡】字段缺失一律降级为不渲染或占位符，宁可少显示一行，也不让一条脏记录拖白整块面板。
// 【契约】面向内容片段联合类型与轨迹记录类型，分发按 kind 穷举，未知类型落入兜底原始值分支。
// INV-01 【不变量】kind 分发按 text、reasoning、tool-call、tool-result、image 顺序穷举，其余落兜底；守住位置：ContentPartView 分支链；改错故障：新片段类型被误判成旧类型，用户看到错位文本或整段工具输入消失。
// INV-02 【失败路径】text 片段文本为空时直接不渲染，避免留下空白段；守住位置：ContentPartView 的 text 分支；改错故障：空段落撑出多余间距，轨迹看着有内容却读不到字。
// INV-03 【不变量】reasoning 片段只在有文本时渲染，且始终包进 DetailSection；守住位置：ContentPartView 的 reasoning 分支；改错故障：思考内容混入正文层级，用户分不清回答与推理。
// INV-04 【设计权衡】tool-call 标题由调用文案与工具名拼成一行，头部显隐交给 showToolHeader；守住位置：ContentPartView 的 tool-call 分支；改错故障：同一调用在内联与详情两处各出一份标题，看着像重复调用。
// INV-05 【失败路径】tool-result 在工具名缺失时退化成纯结果标题，不渲染悬空分隔符；守住位置：ContentPartView 的 tool-result 分支；改错故障：标题尾部挂一个孤立间隔号，用户误以为工具名为空。
// INV-06 【生命周期】image 片段不加载也不解码二进制，只输出带媒体类型的占位文本；守住位置：ContentPartView 的 image 分支；改错故障：误渲染 base64 数据，长列表滚动掉帧且内存抬升。
// INV-07 【不变量】ToolPayload 的头部展示与载荷渲染彼此独立，showHeader 为假时只输出载荷块；守住位置：ToolPayload 返回分支；改错故障：内联卡片多套一层标题，嵌套面板出现双层边框。
// INV-08 【设计权衡】工具编号用单行截断承接超长 id，完整值留在 title 供悬停核对；守住位置：ToolIdBadge；改错故障：调用 id 撑破标题行，右侧元信息被挤出可视区。
// INV-09 【不变量】DetailSection 在 meta 为空时不保留占位节点，标签独占剩余宽度；守住位置：DetailSection 的 meta 条件渲染；改错故障：无徽标段落右侧留白，长标签被提前截断。
// INV-10 【设计权衡】CodeBlock 用等宽滚动容器承接超长内容，纵向高度封顶；守住位置：CodeBlock 根节点；改错故障：上万字符输出把面板顶成单列长页，用户找不到下一条记录。
// INV-11 【失败路径】CodeBlock 收到空串时显示破折号占位，而非零高度空块；守住位置：CodeBlock 子节点；改错故障：空载荷看起来像渲染失败，用户反复点开折叠区。
// INV-12 【不变量】UsageBadges 在 usage 缺失时整体不渲染，不输出零值徽标；守住位置：UsageBadges 入口守卫；改错故障：没有用量的旧记录也显示零 token，统计被误读。
// INV-13 【失败路径】输入与输出 token 只在类型为数字时拼接，两者都缺则返回空；守住位置：UsageBadges 的分片累积与长度判断；改错故障：缺值被拼成字符串，徽标显示空值标记。
// INV-14 【设计权衡】token 数走本地化数字格式，千分位随界面语言变化；守住位置：UsageBadges 的 count 参数；改错故障：中文界面出现英文分组符号，读数需要二次换算。
// INV-15 【设计权衡】EmptyState 只识别 error 一种语气，其余落到次要文本色；守住位置：EmptyState 的 tone 判断；改错故障：错误态与提示态同色，用户分不清没数据还是加载失败。
// INV-16 【失败路径】EmptyState 的 detail 为可选第二行，缺失时不保留间距；守住位置：EmptyState 的 detail 条件渲染；改错故障：只有主文案时下方多出空白，卡片高度跳变。
// INV-17 【失败路径】summarizeRecords 只累加类型为数字的 totalTokens，其余按零处理；守住位置：summarizeRecords 循环内的类型判断；改错故障：脏记录把总数变成字符串拼接，汇总行出现无法解读的字符。
// INV-18 【不变量】summarizeRecords 的模型列表按首次出现去重，顺序稳定可比对；守住位置：summarizeRecords 的 Set 累积；改错故障：同一模型在筛选器里出现多次，切换后内容重复。
import type { ReactNode } from "react";
import type {
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
} from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

// 【不变量】分发只依据 part.kind，不看其余字段，保证同一片段在任何面板落到同一视图。
// 【边界】sectionLabel 仅在调用方显式传入时包裹外层标题，未传入则直接返回段落本体。
// 【权衡】折叠展开交给外层容器持有，明细层不保存显隐状态，重渲染不会丢失但又无需恢复记忆。
// 【失败路径】未知 kind 走原始值格式化兜底，宁可显示 JSON 也不静默吞掉片段。
// 【并发】ContentPartView 是纯渲染函数，不写模块级可变状态，同一 part 并发渲染不会互相污染。
// 【生命周期】组件不注册订阅或定时器，没有 cleanup 可写，反复挂载也不会累积监听器。
export function ContentPartView({
  part,
  intl,
  sectionLabel,
  showToolHeader = true,
}: {
  part: ZCodeModelTrajectoryContentPart;
  intl: IntlShape;
  sectionLabel?: string;
  showToolHeader?: boolean;
}) {
  // 【不变量】空文本提前返回，短路掉后续标题包裹与段落节点创建。
  // 【失败路径】仅含空白的文本仍原样渲染，不在此处裁剪，避免吞掉有意义的缩进。
  // 【权衡】保留预格式化换行与断词组合，换行交给内容本身，宽度超标才断词。
  if (part.kind === "text") {
    if (!part.text) {
      return null;
    }
    const content = (
      <p className="whitespace-pre-wrap break-words text-ui-sm leading-relaxed text-foreground">
        {part.text}
      </p>
    );
    return sectionLabel ? <DetailSection label={sectionLabel}>{content}</DetailSection> : content;
  }

  // 【不变量】推理块独立成段并使用等宽字体，与正文形成稳定视觉区分。
  // 【失败路径】推理文本缺失时不渲染空框，避免详情区出现无标签空段落。
  // 【权衡】推理默认展开不折叠，代价是长思考占用高度，收益是排查时无需额外点击。
  if (part.kind === "reasoning") {
    if (!part.text) {
      return null;
    }
    return (
      <DetailSection label={intl.formatMessage({ id: "modelTrajectory.reasoning" })}>
        <p className="whitespace-pre-wrap break-words font-mono text-ui-sm leading-relaxed text-foreground-subtle">
          {part.text}
        </p>
      </DetailSection>
    );
  }

  // 【不变量】调用片段统一交给 ToolPayload 渲染，输入载荷使用工具输入文案。
  // 【失败路径】工具名为空时标题仍会保留分隔符，属已知降级，不在明细层另行兜底。
  // 【权衡】标题拼接放在组件内完成，换取 ToolPayload 只承载结构、不感知业务文案。
  if (part.kind === "tool-call") {
    return (
      <ToolPayload
        id={part.toolCallId}
        label={`${intl.formatMessage({ id: "modelTrajectory.toolCall" })} · ${part.toolName}`}
        payloadLabel={intl.formatMessage({ id: "modelTrajectory.toolInput" })}
        value={part.input}
        intl={intl}
        showHeader={showToolHeader}
      />
    );
  }

  // 【不变量】结果片段与调用片段共用同一载荷组件，边框、间距与字号保持一致。
  // 【失败路径】工具名缺失时退化为纯结果标题，避免渲染出只有分隔符的标题。
  // 【权衡】标签在行内三元分支，代价是表达式偏长，收益是无需额外中间变量。
  if (part.kind === "tool-result") {
    return (
      <ToolPayload
        id={part.toolCallId}
        label={
          part.toolName
            ? `${intl.formatMessage({ id: "modelTrajectory.toolResult" })} · ${part.toolName}`
            : intl.formatMessage({ id: "modelTrajectory.toolResult" })
        }
        payloadLabel={intl.formatMessage({ id: "modelTrajectory.toolOutput" })}
        value={part.output}
        intl={intl}
        showHeader={showToolHeader}
      />
    );
  }

  // 【不变量】图像片段只输出占位文本，媒体类型存在时附加在占位符内。
  // 【生命周期】图片片段只渲染占位符（part.mediaType 文本），不发起加载也不缓存二进制，滚出视口不会留下引用。
  // 【失败路径】媒体类型缺失时省略附加段，避免出现尾部孤立的分隔点。
  if (part.kind === "image") {
    return (
      <span className="text-ui-sm italic text-foreground-subtle">
        [image{part.mediaType ? ` · ${part.mediaType}` : ""}]
      </span>
    );
  }

  return <CodeBlock value={formatValue(part.raw)} />;
}

// 【不变量】载荷块固定两层结构：载荷标签行加格式化后的取值块，对所有工具一致。
// 【权衡】showHeader 为假时直接返回载荷，由调用方在内联卡片里自行提供标题。
// 【失败路径】工具编号仅在有值时渲染徽标，缺失时元信息区整体留空而非渲染空壳。
// 【并发】载荷在渲染期一次性格式化，无异步补齐，展开与收起之间不会出现内容闪烁。
function ToolPayload({
  label,
  id,
  payloadLabel,
  value,
  intl,
  showHeader,
}: {
  label: string;
  id?: string;
  payloadLabel: string;
  value: unknown;
  intl: IntlShape;
  showHeader: boolean;
}) {
  const payload = (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-ui-sm font-medium text-foreground-subtle">{payloadLabel}</span>
      </div>
      <CodeBlock value={formatValue(value)} />
    </div>
  );

  return showHeader ? (
    <DetailSection label={label} meta={id ? <ToolIdBadge id={id} intl={intl} /> : null}>
      {payload}
    </DetailSection>
  ) : (
    payload
  );
}

// 【不变量】徽标宽度受父级约束，超出后省略号截断而不是横向撑开标题行。
// 【失败路径】完整 id 保留在悬停提示上，截断后仍可核对，不丢失可诊断信息。
// 【权衡】不提供复制按钮，避免标题行出现第二个焦点，复制需求交给外层面板。
function ToolIdBadge({ id, intl }: { id: string; intl: IntlShape }) {
  return (
    <Badge
      variant="outline"
      className="max-w-full truncate font-mono text-foreground-subtle"
      title={id}
    >
      {intl.formatMessage({ id: "modelTrajectory.toolId" })}: {id}
    </Badge>
  );
}

// 【不变量】段落由标题行与内容区两段组成，左侧标签自适应、右侧元信息按内容收缩。
// 【失败路径】meta 为空时不插入包裹节点，标题独占整行，长文本优先获得宽度。
// 【权衡】标题不参与折叠交互，折叠状态由外层持有，明细层保持无状态。
function DetailSection({
  label,
  meta,
  children,
}: {
  label: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1 px-1.5 py-1 text-ui-sm font-medium text-foreground-subtle">
        <span className="min-w-0 flex-1 break-words font-mono">{label}</span>
        {meta ? <span className="min-w-0 shrink">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

// 【不变量】统一等宽字体与预格式化换行，任何取值都按原样呈现，不做语法高亮。
// 【权衡】CodeBlock 用 max-h-64 + overflow-auto 封顶，牺牲一次性看全，让长日志保持可浏览。
// 【失败路径】取值为空时回退到破折号，避免零高度块让用户误判为渲染中断。
function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre rounded-md bg-surface px-2 py-1.5 font-mono text-ui-sm leading-relaxed text-foreground">
      {value || "—"}
    </pre>
  );
}

// 【不变量】用量以单枚徽标呈现，输入与输出分片之间用双空格分隔，保持对齐可读。
// 【失败路径】两个分片都为空时整体返回空，不渲染无内容的徽标外壳。
// 【权衡】只展示输入输出总量，其余字段不进入明细层，避免徽标行无限增长。
export function UsageBadges({
  usage,
  intl,
}: {
  usage?: ZCodeModelTrajectoryUsage;
  intl: IntlShape;
}) {
  // 【不变量】usage 缺失直接短路，历史记录没有用量字段时按无数据呈现。
  // 【失败路径】不在此处补零，缺数据与真实零值必须保持可区分。
  if (!usage) {
    return null;
  }
  const parts: string[] = [];
  if (typeof usage.inputTokens === "number") {
    parts.push(
      intl.formatMessage(
        { id: "modelTrajectory.usage.input" },
        { count: usage.inputTokens.toLocaleString() },
      ),
    );
  }
  if (typeof usage.outputTokens === "number") {
    parts.push(
      intl.formatMessage(
        { id: "modelTrajectory.usage.output" },
        { count: usage.outputTokens.toLocaleString() },
      ),
    );
  }
  // 【失败路径】分片集合为空时返回空，防止出现只有边框没有文字的徽标。
  // 【不变量】该判断在字段累积之后执行，新增字段时无需重复改动守卫。
  if (parts.length === 0) {
    return null;
  }
  return (
    <Badge variant="outline" className="font-mono text-foreground-subtle">
      {parts.join("  ")}
    </Badge>
  );
}

// 【不变量】空态由主文案与可选详情两行构成，垂直居中，最大宽度受父容器限制。
// 【失败路径】详情为空时不保留占位行，卡片高度只随主文案变化。
// 【权衡】EmptyState 的 tone 只区分错误与普通，用颜色而非图标表达，不需要额外图标资源。
// 【并发】无内部状态与过渡动画，空态与数据态切换时不会残留上一条文案。
export function EmptyState({
  text,
  detail,
  tone,
}: {
  text: string;
  detail?: string;
  tone?: "error";
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
      <p
        className={cn(
          "text-ui-base",
          tone === "error" ? "text-destructive" : "text-foreground-subtle",
        )}
      >
        {text}
      </p>
      {detail ? (
        <p className="max-w-full break-words font-mono text-ui-base text-foreground-subtlest">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

// 【不变量】单次遍历同时累计 token 与模型集合，复杂度与记录数线性相关。
// 【失败路径】totalTokens 只接受数字类型，字符串或缺失值一律忽略，避免汇总被污染。
// 【权衡】模型名优先取请求侧，回退到响应侧，兼容历史记录的字段迁移。
// 【不变量】模型集合天然去重，导出顺序为首次出现顺序，便于稳定比对。
// 【失败路径】记录数组为空时返回零与空列表，调用方无需额外判空。
export function summarizeRecords(records: ZCodeModelTrajectoryRecord[]): {
  totalTokens: number;
  models: string[];
} {
  let totalTokens = 0;
  const models = new Set<string>();
  for (const record of records) {
    const total = record.response?.usage?.totalTokens;
    if (typeof total === "number") {
      totalTokens += total;
    }
    const model = record.model.modelId ?? record.response?.modelId;
    if (model) {
      models.add(model);
    }
  }
  return { totalTokens, models: [...models] };
}

// 【不变量】字符串原样返回，不再加引号，避免正文被二次转义。
// 【失败路径】undefined 与 null 统一成空串，由 CodeBlock 决定占位样式。
// 【权衡】对象走两空格缩进的可读 JSON，牺牲紧凑性换取排查时的可读性。
// 【失败路径】序列化遇到循环引用时回退到字符串转换，保证渲染不抛错。
function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
