// ============================================================
// ZCode · 工作流工作区卡片 WorkflowWorkspaceCard —— 日志簿的一行
// ------------------------------------------------------------
// 不变量总览（不变量｜守护点｜改坏后的后果），改码前逐条对照：
// INV-01 卡片身份由 persistKey=sessionId:runId:card.key 唯一确定，守护点在 persistKey 与 rememberedOpen 调用处，改掉会让不同卡共享或丢失展开记忆
// INV-02 状态只取 workspaceCardStatus(node, run)，活投影仅叠加 replayed，若改为读本地运行态，历史 journal 卡会显示漂移状态
// INV-03 failed 必须同时覆盖 status==="failed" 与 exitCode 非 0，statusWord 与瓦片配色都用它，漏掉退出码分支会把失败染成成功绿
// INV-04 durationMs 用 Math.max(0, updatedAt-createdAt) 夹紧，守护点在派生处，去掉后时钟回拨或事件乱序会产出负耗时
// INV-05 Read 卡 expandable 恒为 false，只留摘要行，放开会让 Read 出现空正文面板并吞掉整卡点击
// INV-06 onKeyDown 先判 target===currentTarget，保证只有卡体自身获得焦点时才处理 Enter/Space，否则内部按钮会被双重激活
// INV-07 点击折叠前用 closest("[data-ws-body],button,a") 白名单放行，正文选择文本、Copy、文件芯片都不可折叠
// INV-08 toggle 内先写 setRememberedOpen 再返回新值，两处必须用同一个 !previous，写反会导致内存态与持久化相反
// INV-09 readSummary 只在 kind==="read" 时计算，依赖 card.primary/kind/workspacePath，缺 workspacePath 会把相对路径当绝对路径交给查看器
// INV-10 绝对路径判定同时认 POSIX 前导斜杠与 Windows 盘符正则，少一个分支会在 Windows 上拼出 workspacePath/C:/… 这类坏路径
// INV-11 openRead 在 readSummary 或 onOpenCodeViewer 缺席时直接返回而不抛错，否则宿主未接查看器时点 Read 会崩
// INV-12 verb 的五路分支顺序 read→search→git→terminal→step 必须与 KIND_ICON 对齐，错位会让 terminal 卡显示成 step 文案
// INV-13 terminal 动词按 isRunning 切换 running/ran 词条，改成只看 status 会让进行中的命令显示成已运行
// INV-14 object 分支里 read 必须消费非空 readSummary，search 的 secondary 可缺省，terminal 优先 card.command 再回退 primary
// INV-15 statusWord 优先级为 failed（含超时细分）> 有退出码 > 无，顺序颠倒会让失败卡只剩退出码、丢掉错误码
// INV-16 statusNode 的 key=statusWord 用来触发 wf-swap 换词动画，删掉 key 后状态词替换不再播动画
// INV-17 resultParts 的 running 分支只放 startedAgo（用 now 驱动），不得同时塞 statusNode，否则会同时出现正在运行与退出码
// INV-18 joined 先过滤 null/undefined 再用 out.length>0 判是否插分隔点，顺序反了会在首件前落一颗孤立圆点
// INV-19 peek 只在 terminal 且未展开且 status==="completed" 时挂载，展开后改由 WorkspaceCardBody 承载，二者互斥避免重复渲染输出
// INV-20 enterDelayMs 缺省或非正数时不写 animationDelay，animationFillMode 只能取 backwards，否则错位动画会重置首帧样式
// ------------------------------------------------------------
// ============================================================
// 脚本 transcript 的一个条目
// ============================================================
// 日志簿的一行：左边 28px 的种类瓦片（失败泛红、运行泛琥珀），中间两行——动词 + 对象、然后
// 结果行（`exit 1` 红、`41 files`、耗时、字节、replayed 芯片）——右边时间标尺（`+1:12`，跑着的
// 说 now）。收起的命令下面露出输出的尾巴（peek）；展开是完整面板。Read 只有摘要行，文件芯片开
// 代码查看器看**现在**的文件。状态以 journal 为准，活投影只叠 `cached`。

import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronRightIcon,
  FileIcon,
  GitBranchIcon,
  SearchIcon,
  SquareTerminalIcon,
  TerminalIcon,
} from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { ReadFileChip, type ReadSummary } from "@/ToolCallBlocks/renderers/read.js";
import { WorkspaceCardBody } from "@/app-shell/WorkflowWorkspaceCardBody.js";
import { WorkspacePeek } from "@/app-shell/WorkflowWorkspacePeek.js";
import {
  formatAgo,
  formatOffset,
  rememberedOpen,
  setRememberedOpen,
} from "@/app-shell/workflowWorkspaceLogbook.js";
import {
  formatWorkspaceBytes,
  formatWorkspaceDuration,
  isTimeoutError,
  workspaceCardStatus,
  type WorkspaceCardModel,
} from "@/app-shell/workflowWorkspaceTranscript.js";

// 依赖约定：react 只取 memo/useCallback/useMemo/useState，渲染期不做副作用
// 图标表与文案分离，全部文案经 useZCodeIntl，禁止硬编码中文进入生产包
// 状态判定与格式化取自 workflowWorkspaceTranscript，与本卡 Body/Peek 共用同一口径
const KIND_ICON = {
  read: <FileIcon className="size-3.5" />,
  search: <SearchIcon className="size-3.5" />,
  git: <GitBranchIcon className="size-3.5" />,
  terminal: <SquareTerminalIcon className="size-3.5" />,
  step: <TerminalIcon className="size-3.5" />,
} as const;

const CODE_CLASS = "truncate font-mono text-[12.5px] text-foreground";

// 入参全部只读：card 已归一化，本组件不再解析协议，也不用 session 状态反推
// origin/now 分离：零点由父级给、当前时刻由父级推进，组件自身不持时钟
// landed 与 enterDelayMs 只驱动入场动画，不参与状态与可展开性判定
interface WorkflowWorkspaceCardProps {
  card: WorkspaceCardModel;
  sessionId: string;
  runId: string;
  run: WorkflowRunState | undefined;
  /** 时间标尺的零点（第一张卡的准入时刻）；缺席即不画时刻。 */
  origin: number | undefined;
  /** 当前时刻（运行中的卡每秒推进）。 */
  now: number;
  /** 到场错位（每张 24 ms，封顶在面板侧）；缺席即立刻。 */
  enterDelayMs?: number;
  /** 落点那张卡：到位后底色亮一下。 */
  landed?: boolean;
  /** 工作区根：Read 卡的相对路径据此补成绝对路径再交给代码查看器。 */
  workspacePath: string;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

// 纯函数：不做 IO，只把相对路径补成绝对路径并解析出展示描述符
// 绝对路径判定必须同时覆盖 POSIX 与 Windows 盘符两种形态
// Windows 上 / 与 \ 都算分隔符，只认一种会在混写路径时误判为相对路径
// 返回固定 entryType=file，Read 芯片据此渲染类型图标与悬浮信息
function readSummaryOf(path: string, workspacePath: string): ReadSummary {
  const absolute =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${workspacePath}/${path}`;
  const descriptor = resolveFileDisplayDescriptor(absolute);
  return {
    path: absolute,
    fileName: descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: descriptor.fileIconSrc,
    entryType: "file",
  };
}

// joined 负责在结果行零件之间插 3px 圆点，纯展示、无状态、无副作用
// 先滤掉 null/undefined 再判断 out.length，保证首件前不会落单点
// key 用 sep-${index} 与零件下标，结果行重建频率低，索引作 key 可接受
/** 结果行的零件之间放一颗小点。 */
function joined(parts: readonly ReactNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (part === null || part === undefined) return;
    if (out.length > 0) {
      out.push(
        <span
          aria-hidden
          className="size-[3px] shrink-0 rounded-full bg-foreground-subtlest opacity-70"
          key={`sep-${index}`}
        />,
      );
    }
    out.push(<span key={index}>{part}</span>);
  });
  return out;
}

// [并发] memo 包裹：props 引用稳定时整卡跳过重渲染，父级每秒 now 只推动 running 卡
// 解构处 landed 默认 false，缺省即不亮底色，调用方漏传时不会误亮
// 组件名与文件同名，便于 DevTools 与快照定位到具体卡片
// 本组件不收 children，所有可选区块都由内部条件分支决定
export const WorkflowWorkspaceCard = memo(function WorkflowWorkspaceCard({
  card,
  enterDelayMs,
  landed = false,
  now,
  onOpenCodeViewer,
  origin,
  run,
  runId,
  sessionId,
  workspacePath,
}: WorkflowWorkspaceCardProps) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const { node, kind } = card;
  // [并发] status/replayed 每次渲染重算不缓存，journal 与活投影在纯函数内合并
  // [失败路径] 退出码非 0 但 status 仍为 completed 时，由下面的 failed 二次判定兜住
  // 时间戳相减可能因事件乱序为负，durationMs 先夹到 0 再交给格式化
  // exitCode 走 node.summary 可选链，缺失视为无退出码而不是 0
  // 此处只读 node，不写任何 store，渲染可被并发特性重复调用而不产生副作用
  const { status, replayed } = workspaceCardStatus(node, run);
  const isRunning = status === "running";
  const exitCode = node.summary?.exitCode;
  const failed = status === "failed" || (exitCode !== undefined && exitCode !== 0);
  const durationMs = Math.max(0, node.updatedAt - node.createdAt);

  // Read 只有摘要行；其余可展开（running 的命令也可展开看命令行）。展开态按卡记忆。
  // [权衡] Read 卡不展开：正文没有比摘要行更多的信息，展开只增加空白
  // persistKey 用冒号拼三元组，card.key 内不允许含冒号，这一点由上游保证
  // useState 惰性初始化只读一次 rememberedOpen，后续写入由 toggle 显式完成
  // [并发] 记忆表是模块级 Map，同一 key 并发挂载时后写覆盖先写，属已知取舍
  const expandable = kind !== "read";
  const persistKey = `${sessionId}:${runId}:${card.key}`;
  const [open, setOpen] = useState(() => rememberedOpen(persistKey));
  const toggle = useCallback(() => {
    setOpen((previous) => {
      setRememberedOpen(persistKey, !previous);
      return !previous;
    });
  }, [persistKey]);
  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // 正文与 peek 里的点击（选文本、Copy、文件芯片）不折叠。
      // 点击冒泡到卡体时先看命中链，正文、按钮、链接内部的交互不触发折叠
      // 白名单命中直接 return，不能 preventDefault，否则选文本与 Copy 会失效
      // toggle 引用只随 persistKey 变化，卡重渲染不重建处理器，减少子节点 diff
      // 卡体只在 expandable 时挂 onClick，非可展开卡不响应点击
      if ((event.target as HTMLElement).closest("[data-ws-body],button,a") !== null) return;
      toggle();
    },
    [toggle],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // 键盘只在事件源就是卡体时处理，内部可聚焦元素自行消费 Enter/Space
      // 空格与回车都映射为折叠切换，并 preventDefault 阻止页面滚动
      // 处理器不看 event.repeat，长按会连续切换，属可接受的视觉抖动
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  // 只有 Read 卡需要摘要，其余 kind 直接返回 null，省掉无谓的路径解析
  // 依赖只列原始值，workspacePath 变化时会重新拼出绝对路径
  // resolveFileDisplayDescriptor 是纯查表，不触发文件系统访问
  const readSummary = useMemo(
    () => (kind === "read" ? readSummaryOf(card.primary, workspacePath) : null),
    [card.primary, kind, workspacePath],
  );
  const openRead = useCallback(() => {
    if (readSummary === null || onOpenCodeViewer === undefined) return;
    onOpenCodeViewer({ type: "file", title: readSummary.fileName, path: readSummary.path });
  }, [onOpenCodeViewer, readSummary]);

  // 第一行：动词 + 对象。
  // 动词与对象分两段渲染：动词给动作词条，对象给具体参数
  // terminal 的动词随 isRunning 变，历史卡说已运行、活卡说正在运行
  // git 直接输出字面量 git 不占词条，因它在所有语言下同名
  // 兜底分支留给 step 卡，保证新 kind 未登记时仍有可读文案
  const verb =
    kind === "read"
      ? format({ id: "chat.toolCall.workflow.script.verb.read" })
      : kind === "search"
        ? format({ id: "chat.toolCall.workflow.script.verb.searched" })
        : kind === "git"
          ? "git"
          : kind === "terminal"
            ? format({
                id: isRunning ? "chat.toolCall.execute.running" : "chat.toolCall.execute.ran",
              })
            : format({ id: "chat.toolCall.workflow.script.kind.step" });
  const object: ReactNode =
    kind === "read" && readSummary !== null ? (
      <span className="inline-flex h-5 min-w-0 max-w-full items-center rounded-[5px] border border-border bg-card px-1.5 text-ui-sm [&_button]:text-foreground [&_span]:text-foreground">
        <ReadFileChip
          summary={readSummary}
          clickable={onOpenCodeViewer !== undefined}
          onClick={openRead}
        />
      </span>
    ) : kind === "search" ? (
      <span className="flex min-w-0 items-baseline gap-1.5 truncate">
        <code className={CODE_CLASS}>{card.primary}</code>
        {card.secondary === undefined ? null : (
          <>
            <span className="text-foreground-subtlest">
              {format({ id: "chat.toolCall.workflow.script.search.in" })}
            </span>
            <code className={CODE_CLASS}>{card.secondary}</code>
          </>
        )}
      </span>
    ) : kind === "git" ? (
      <code className={CODE_CLASS}>{card.primary.replace(/^git /, "")}</code>
    ) : kind === "terminal" ? (
      <code className={CODE_CLASS}>{card.command ?? card.primary}</code>
    ) : (
      <span className="truncate text-foreground">{card.primary}</span>
    );

  // 第二行：结果。状态词换值时新词进场。
  // 状态词优先级：failed（含超时细分）> 有退出码 > 无，顺序不可调换
  // 超时先判 isTimeoutError，命中直接给 timedOut 词条，不再暴露原始 code
  // 非超时失败优先展示 error.code，缺失才退通用失败文案，便于对照日志
  // 退出码只在非失败分支出现，避免失败卡重复显示错误码与 exit
  const statusWord =
    status === "failed"
      ? isTimeoutError(node.error)
        ? format({ id: "chat.toolCall.workflow.script.status.timedOut" })
        : (node.error?.code ?? format({ id: "chat.toolCall.workflow.graph.status.failed" }))
      : exitCode !== undefined
        ? format({ id: "chat.toolCall.workflow.script.status.exit" }, { code: String(exitCode) })
        : undefined;
  const statusNode =
    statusWord === undefined ? null : (
      <span
        className={cn("wf-swap font-semibold", failed ? "text-destructive" : "text-success")}
        data-failed={failed ? "true" : undefined}
        data-testid="workflow-workspace-status"
        key={statusWord}
        title={
          status === "failed"
            ? (node.error?.message ?? node.error?.code)
            : failed
              ? card.command
              : undefined
        }
      >
        {statusWord}
      </span>
    );
  // replayed 芯片只在活投影标记重放时出现，虚线边框表达非本次真实执行
  // 芯片带 hint 标题解释重放含义，避免被误读成缓存命中
  const replayedNode = replayed ? (
    <span
      className="inline-flex h-4 items-center rounded-[4px] border border-dashed border-border px-1 text-[10.5px] leading-none text-foreground-subtlest"
      data-testid="workflow-workspace-replayed"
      title={format({ id: "chat.toolCall.workflow.script.status.replayedHint" })}
    >
      {format({ id: "chat.toolCall.workflow.script.status.replayed" })}
    </span>
  ) : null;
  const bytes = node.summary?.resultBytes;
  const count = node.summary?.resultCount;
  // count 语义按 op 区分：grep 计匹配条数、其余计文件数，词条不可混用
  // count 缺失时返回 null，joined 会过滤，结果行不会留下空洞分隔
  // 计数用加粗强调但不改字号，保证结果行基线不被撑开
  const countNode =
    count === undefined ? null : (
      <b className="font-medium text-foreground-subtle">
        {format(
          {
            id:
              card.op === "grep"
                ? "chat.toolCall.workflow.script.result.matches"
                : "chat.toolCall.workflow.script.result.files",
          },
          { count: String(count) },
        )}
      </b>
    );
  // 结果行分支顺序即语义优先级：running → failed → read → search → terminal → 默认
  // running 分支用 now 算 startedAgo，父级每秒推进即驱动文案刷新
  // 失败分支固定两项：状态词与耗时，不再展示字节与计数，避免误导
  const resultParts: ReactNode[] = isRunning
    ? [
        format(
          { id: "chat.toolCall.workflow.script.startedAgo" },
          { ago: formatAgo(now - node.createdAt) },
        ),
      ]
    : status === "failed"
      ? [statusNode, formatWorkspaceDuration(durationMs)]
      : kind === "read"
        ? [
            <span className="truncate font-mono" key="path">
              {card.primary}
            </span>,
            bytes === undefined ? null : formatWorkspaceBytes(bytes),
            replayedNode,
          ]
        : kind === "search"
          ? [countNode, formatWorkspaceDuration(durationMs), replayedNode]
          : kind === "terminal"
            ? [
                statusNode,
                formatWorkspaceDuration(durationMs),
                formatWorkspaceBytes(node.summary?.stdoutBytes ?? bytes ?? 0),
                replayedNode,
              ]
            : [
                countNode,
                bytes === undefined ? null : formatWorkspaceBytes(bytes),
                formatWorkspaceDuration(durationMs),
                replayedNode,
              ];
  // 入参被截断时追加省略号，push 发生在渲染前，不打乱上面分支的既有顺序
  // 省略号带 args.truncated 标题，提示用户实际命令并不完整
  if (node.inputTruncated) {
    resultParts.push(
      <span title={format({ id: "chat.toolCall.workflow.script.args.truncated" })}>…</span>,
    );
  }

  // [资源] 入场错位只写 animationDelay，不起额外定时器，动画结束即释放
  // [失败路径] 缺省或非正数不写 delay，等价零延迟，避免负值把动画推回起点
  // animationFillMode 固定 backwards，延迟期间保持首帧而不是先闪现终态
  const style: CSSProperties =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? {}
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" };

  return (
    <div
      // 无障碍属性只在可展开时给值，非可展开卡不声明 aria-expanded，免得读屏误报
      // data-* 是测试与样式钩子：card-key、status、ordinal、site-id、phase-id 缺一不可
      // role/tabIndex/onClick/onKeyDown 必须同源（都看 expandable），否则会出现可聚焦却不可点的卡
      // grid 三列 28px/minmax(0,1fr)/auto 与左瓦片 28px、右时间栏 auto 严格对应
      aria-expanded={expandable ? open : undefined}
      className={cn(
        "wf-ws-entry wf-arrive group/ws grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-[9px] px-2 pb-2.5 pt-[9px] outline-none",
        expandable &&
          "cursor-pointer hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
        landed && "wf-ws-landed",
      )}
      data-card-key={card.key}
      data-open={open ? "true" : undefined}
      data-ordinal={node.ordinal}
      data-phase-id={card.phase?.id}
      data-site-id={node.siteId}
      data-status={status}
      data-testid="workflow-workspace-card"
      onClick={expandable ? onClick : undefined}
      onKeyDown={expandable ? onKeyDown : undefined}
      role={expandable ? "button" : undefined}
      style={style}
      tabIndex={expandable ? 0 : undefined}
    >
      <span
        // 种类瓦片图标取自 KIND_ICON 常量表，as const 保证 key 与 kind 联合类型对齐
        // 正常路径五种 kind 全命中，瓦片不会出现空白，配色由 failed/isRunning 叠加
        aria-hidden
        className={cn(
          "mt-px flex size-7 items-center justify-center rounded-[7px] bg-surface text-foreground-subtle transition-colors",
          failed &&
            "bg-[color-mix(in_oklab,var(--color-destructive)_10%,transparent)] text-destructive",
          isRunning && "bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] text-warning",
        )}
      >
        {KIND_ICON[kind]}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-1.5 text-ui-base leading-[18px]">
          <span
            className={cn(
              "shrink-0 font-medium text-foreground-subtle",
              isRunning && "wf-ws-shine",
            )}
          >
            {verb}
          </span>
          {object}
          {expandable ? (
            <ChevronRightIcon
              className={cn(
                "ml-0.5 size-3.5 shrink-0 self-center text-foreground-subtlest opacity-0 transition-[opacity,transform] duration-[160ms] group-hover/ws:opacity-100 group-focus-visible/ws:opacity-100",
                open && "rotate-90 opacity-100",
              )}
            />
          ) : null}
        </div>
        <div
          className="flex flex-wrap items-center gap-1.5 text-ui-sm leading-4 text-foreground-subtlest"
          // 结果行是 flex-wrap 容器，joined 产出带分隔点的零件，窄屏允许换行
          // 结果区下方按 kind 与 open 决定挂 peek 还是正文，terminal 收起且已完成才露尾巴
          // peek 与 WorkspaceCardBody 条件互斥，同一时刻只渲染一份输出，避免重复请求
          // 两者都是下钻视图，不改变本卡的 status 与右侧时间标尺
          data-testid="workflow-workspace-result"
        >
          {joined(resultParts)}
        </div>
        {kind === "terminal" && !open && status === "completed" ? (
          <WorkspacePeek node={node} runId={runId} sessionId={sessionId} />
        ) : null}
        {expandable && open ? (
          <WorkspaceCardBody card={card} runId={runId} sessionId={sessionId} />
        ) : null}
      </div>
      <span
        className="flex items-center gap-1.5 whitespace-nowrap font-mono text-ui-xs leading-[18px] tabular-nums text-foreground-subtlest"
        // 右侧时间栏：running 显示呼吸灯与 now 文案，历史卡显示相对 origin 的偏移
        // origin 缺席直接渲染 null，不显示 0 偏移，因不同面板的零点不可比
        // 时间用 tabular-nums 等宽数字，秒级跳动时列宽不抖
        data-testid="workflow-workspace-when"
      >
        {isRunning ? (
          <>
            <span aria-hidden className="wf-lamp-running size-1.5 rounded-full bg-warning" />
            {format({ id: "chat.toolCall.workflow.script.now" })}
          </>
        ) : origin === undefined ? null : (
          formatOffset(node.createdAt - origin)
        )}
      </span>
    </div>
  );
});
