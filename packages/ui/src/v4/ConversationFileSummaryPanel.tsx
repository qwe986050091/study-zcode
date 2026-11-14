// ConversationFileSummaryPanel：单轮 turn 的「文件变更摘要」面板。
// 职责：用 header.fileChanges 聚合值渲染折叠头（文件数、增删行数、已撤销标记、撤销入口），
// 展开或需要剔除 gen-ui 源文件时按需读取明细，逐文件提供审阅 diff、打开文件、回退入口。
// 不负责：diff 内容渲染（交给代码查看器）、工作区文件读写、变更统计的权威计算（host 侧投影才是事实源）。
//
// INV-01 断言：折叠头默认只展示 header 聚合值，只有真的过滤掉 gen-ui 源文件后才用明细重算文件数与增删行数 —— 守住它的位置：summary 计算分支 —— 改错故障：头尾数字与展开列表条数不一致，用户以为文件丢失
// INV-02 断言：requestKey 必须同时覆盖身份、远端会话、会话、行、实体、缓存策略与 fileChanges 快照 —— 守住它的位置：requestKey 构造 —— 改错故障：上一轮或上一 revision 的明细被当成当前结果展示
// INV-03 断言：就绪判据只看 loadedDetails.key 是否等于当前 requestKey —— 守住它的位置：settled —— 改错故障：切轮后旧结果仍算就绪，出现串轮内容
// INV-04 断言：缓存策略由 header.state 派生，running 为 in-flight，其余为 terminal —— 守住它的位置：cachePolicy —— 改错故障：运行中永远拿不到详情，或终态无法持久缓存导致每次重读
// INV-05 断言：turn 进入终态后必须按 terminal 策略重读，运行中拿到的局部投影不能复用 —— 守住它的位置：拉取副作用依赖 —— 改错故障：展开列表比实际变更少，且撤销预检与摘要不符
// INV-06 断言：拉取回调必须受 disposed 标记约束，卸载后不得写入状态 —— 守住它的位置：effect 清理函数 —— 改错故障：快速折叠或切轮时旧响应覆盖新状态
// INV-07 断言：拉取失败也要以同一 key 写入 null 结果，让面板回到可重试态 —— 守住它的位置：失败回调 —— 改错故障：失败后永久 loading，展开区卡住无法恢复
// INV-08 断言：gen-ui 源文件必须同时从列表与聚合中剔除，且过滤场景就绪前整块返回空 —— 守住它的位置：filtersSources 分支 —— 改错故障：生成式界面源码文件混进普通变更，或数字先闪现后跳动
// INV-09 断言：撤销可用性要求注入能力、canRewindFiles 与非已撤销三者同时成立 —— 守住它的位置：canUndo —— 改错故障：不可回退环境仍显示可点按钮，点击后静默失败
// INV-10 断言：撤销走「先预检、再应用」两段式，应用成功判据为 accepted 或 duplicate —— 守住它的位置：handleApply —— 改错故障：重复点击产生二次回退，或幂等响应被当成失败
// INV-11 断言：预检与应用期间撤销按钮必须禁用 —— 守住它的位置：撤销按钮 disabled —— 改错故障：并发提交触发 host 侧重复回退
// INV-12 断言：打开 diff 需要补丁非空且已注入查看器，缺一即静默返回 —— 守住它的位置：openDiff —— 改错故障：打开空白 diff 页，或未注入环境抛错打断渲染
// INV-13 断言：diff 标题用工作区相对路径，path 保留原始路径，身份字段为空时不透传 —— 守住它的位置：openDiff 入参拼装 —— 改错故障：查看器标题显示绝对路径，或空身份覆盖宿主上下文
// INV-14 断言：列表以 item.path 作 key，同一轮同一文件只渲染一行 —— 守住它的位置：明细映射 —— 改错故障：同一文件出现多行，行内交互状态错位
// INV-15 断言：聚合有变更但明细为空时只记录告警，不改变渲染结果 —— 守住它的位置：空明细诊断副作用 —— 改错故障：把投影不一致升级成白屏，用户看不到任何摘要
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, Loader2Icon, Undo2Icon } from "lucide-react";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { buildChangeSummaryFilePreviewSource } from "@/messageChangeSummaryPreview.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import { logger } from "@/logger.js";
import { collectGenUiSourcePaths, matchesGenUiSourcePath } from "@/gen-ui/contract.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import type {
  ConversationFileChangesRequestOptions,
  ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";

// [契约] 明细类型直接从协议结果的 items 推导，不另建本地接口：
// 协议增删字段时这里自动跟随，手写接口会在字段改名后静默丢失数据。
// 若类型检查报错，应回到协议消费处调整，而不是在这里放宽结构。
type FileChangeItem = V4ConversationFileChangesResult["items"][number];

// header 是当前 turn 的行投影，只读；context 承载注入的能力与工作区身份。
// 三者都由外层行渲染器给出，本组件不自行取服务、不订阅 store。
// assistantText 用于识别本轮是否产出 gen-ui 源文件，缺省空串表示不参与过滤。
interface ConversationFileSummaryPanelProps {
  header: TurnHeaderRow;
  context: ConversationRowRenderContext;
  assistantText?: string;
}

// [契约] 把结构化补丁还原成 unified diff 文本，供代码查看器展示。
// 文件头两行与 hunk 头必须保持 a/ b/ 前缀和 @@ 计数原样，查看器靠它定位行号。
// 补丁顺序就是 host 给出的顺序，这里不排序也不合并，否则行号会整体错位。
// 空补丁交给调用方判断，这里不生成占位文本。
function formatPatch(path: string, patches: FileChangeItem["patches"]): string {
  // [失败路径] 没有补丁时返回空串，调用方据此跳过打开动作。
  // 若改成只返回文件头，查看器会打开一个没有任何 hunk 的空 diff。
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}

// [契约] 打开 diff 的入口：标题使用工作区相对路径，path 保持原始路径供查看器读取。
// context 只取需要的四个字段，避免把整个渲染上下文传进查看器造成耦合。
// `context.onOpenCodeViewer` 可能缺失（例如受限环境），这里不做兜底界面。
// 该函数是同步的，失败只体现为不打开，不产生错误提示。
function openDiff(
  item: FileChangeItem,
  context: Pick<
    ConversationRowRenderContext,
    "workspacePath" | "workspaceIdentity" | "workspaceRemoteSessionId" | "onOpenCodeViewer"
  >,
) {
  const patch = formatPatch(item.path, item.patches);
  const { workspacePath, workspaceIdentity, workspaceRemoteSessionId, onOpenCodeViewer } = context;
  // 能力缺失或内容为空都是合法状态，静默返回即可，不要抛错也不要记录告警。
  // 若改成弹提示，未注入查看器的环境会在每次点击时打扰用户。
  if (!patch || !onOpenCodeViewer) return;
  const relativePath = toWorkspaceRelativePath(workspacePath, item.path);
  onOpenCodeViewer({
    type: "patch",
    title: relativePath,
    path: item.path,
    patch,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  });
}

// 组件入口：副作用都在下方局部状态与副作用中完成，渲染保持纯投影。
// assistantText 默认空串，保证调用方不传时仍能展示聚合摘要。
export function ConversationFileSummaryPanel({
  header,
  context,
  assistantText = "",
}: ConversationFileSummaryPanelProps) {
  const { intl } = useZCodeIntl();
  // 每次本轮助手文本变化都重新解析源文件路径，长度即「是否需要过滤」的开关。
  // 不用状态缓存：文本是外部入参，缓存会在同一组件实例复用行时过期。
  // 解析异常由路径收集函数内部消化，这里按空数组处理。
  const genUiSources = useMemo(() => collectGenUiSourcePaths(assistantText), [assistantText]);
  const filtersSources = genUiSources.length > 0;
  const [open, setOpen] = useState(false);
  // [并发] 明细结果与它的请求键必须成对存放：只存结果就无法判断它属于哪一轮。
  // 若拆成两个状态，会出现键已更新而结果未更新的中间帧，渲染读到错配数据。
  // 结果为 null 表示「已确认读取失败」，与「尚未读取」必须区分。
  // 两者一起更新还能保证切换判据在同一帧内生效。
  const [loadedDetails, setLoadedDetails] = useState<{
    key: string;
    result: V4ConversationFileChangesResult | null;
  } | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // [契约] 缓存策略必须从 turn 状态派生，调用方不传、界面也不提供选项。
  // 运行中只能走 in-flight：终态缓存会把未完成的局部投影固化下来。
  // 终态必须走 terminal：否则同一份结果无法持久缓存，重开面板又要重读。
  // 派生策略还会进入请求键，跨策略的结果不会被误复用。
  const cachePolicy: ConversationFileChangesRequestOptions["cachePolicy"] =
    header.state === "running" ? "in-flight" : "terminal";
  const fileChangesState = header.fileChanges?.state;
  // header 只有聚合值。按当前投影读取明细后过滤，不能把源文件行数从普通文件中猜着扣除。
  // [权衡] 把整份 fileChanges 快照纳入键：宁可多读一次，也不串用不同 revision 的结果。
  // 数组顺序固定，序列化后的键序因此稳定，可直接做字符串相等比较。
  // 身份字段优先用 workspaceIdentity，缺失才回落到路径，与全局身份口径一致。
  // 不要把列表、摘要等渲染态放进键，否则每次渲染都生成新键并重复请求。
  const requestKey = JSON.stringify([
    context.workspaceIdentity?.trim() || context.workspacePath,
    context.workspaceRemoteSessionId,
    context.sessionId,
    header.rowId,
    header.entityId,
    cachePolicy,
    header.fileChanges,
  ]);
  // [并发] settled 是唯一的就绪判据，不能用明细是否为空来代替。
  // 空数组也是有效结果（本轮没有可展示文件），用真假判断会把空结果当成未就绪。
  // 键不等时明细必须视为空，防止切轮瞬间展示上一轮的文件列表。
  const settled = loadedDetails?.key === requestKey;
  const details = settled ? loadedDetails.result : null;
  // 过滤放在 memo 内，依赖只有明细与源文件列表；在渲染体里直接过滤会每次生成新数组。
  // 过滤按路径匹配而非文件名，避免同名不同目录被误删。
  const items = useMemo(
    () => details?.items.filter((item) => !matchesGenUiSourcePath(item.path, genUiSources)) ?? [],
    [details, genUiSources],
  );
  // [契约] 只有确实过滤掉条目时才用明细重算，否则沿用聚合值。
  // 重算只对已过滤项求和，不能从聚合值里按文件数估算源文件的行数。
  // 未过滤时保留原对象，引用不变可让下游 memo 继续生效。
  // 文件数与增删行数必须同时重算，只改其中一个会让头尾对不上。
  // 状态字段随原对象展开保留，已撤销标记不能因为重算而丢失。
  const summary =
    details && items.length !== details.items.length && header.fileChanges
      ? {
          ...header.fileChanges,
          files: items.length,
          additions: items.reduce((sum, item) => sum + (item.additions ?? 0), 0),
          deletions: items.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
        }
      : header.fileChanges;

  // 单复数走不同文案标识，数量以字符串传入以适配各语言格式。
  // 这里用的是重算后的摘要，所以过滤后的条数会同步反映在标题上。
  // 缺少摘要时按零插值，仅用于文案，不决定是否渲染。
  const filesChangedLabel = intl.formatMessage(
    {
      id:
        summary?.files === 1
          ? "chat.changeSummary.filesChanged.one"
          : "chat.changeSummary.filesChanged.other",
    },
    { count: String(summary?.files ?? 0) },
  );
  const isReverted = summary?.state === "reverted";
  // 三个条件缺一不可：注入能力、宿主允许回退、当前未撤销。
  // 任一能力缺失时按钮保持禁用而不是隐藏，避免头部布局在轮次间跳动。
  // 已撤销标记取自重算后的摘要，撤销完成后按钮立即失效。
  const canUndo =
    Boolean(context.applyFileRewind && context.previewFileRewind) &&
    header.actions?.canRewindFiles === true &&
    !isReverted;
  // 行目标只在存在实体标识时构造：没有实体就没有可定位的可撤销对象。
  // 依赖只列实体与行号，避免 header 其它字段变化导致引用抖动。
  // 这个对象同时供明细读取与撤销预检、应用复用，必须是稳定引用。
  const target = useMemo<ConversationRowTarget | null>(
    () => (header.entityId ? { rowId: header.rowId, entityId: header.entityId } : null),
    [header.entityId, header.rowId],
  );
  // 展开或需要过滤才拉明细；过滤场景没有明细就无法算出正确的头部数字。
  // 这两个条件任一为真都会触发下面同一个拉取副作用。
  const needsDetails = open || filtersSources;

  // [并发][资源] 明细拉取副作用：每次键变化都重新发起，旧请求用卸载标记丢弃。
  // 运行中拿到的是某个投影 revision 的局部结果，turn 终态后必须按终态策略重读。
  // 同一摘要反复展开时保留已加载内容，避免替换按钮节点导致焦点丢失。
  // 加载标记在请求前同步置真，保证首帧就显示加载态而不是空列表。
  // 成功与失败两条路径都必须清掉加载标记，否则会永久卡在加载态。
  // 清理函数只置标记，不取消请求，因为注入的拉取接口没有取消语义。
  useEffect(() => {
    // 三个前置条件缺一即不请求：不需要明细、没有拉取能力、行上没有实体。
    // 没有实体说明该行不指向可查询对象，发请求只会得到无意义的失败。
    // 直接返回也必须保证不进入加载态，否则折叠头会一直转圈。
    if (!needsDetails || !context.fetchFileChanges || !target) return;

    // 闭包内的卸载标记，只能声明在副作用内部，跨副作用共享会互相覆盖。
    // 两个回调都先检查它，再写状态。
    let disposed = false;
    // 运行中的 fileChanges 是某个 projection revision 的局部结果；turn
    // 进入终态后必须废弃局部 details，并用可持久缓存的终态策略重新读取。
    // requestKey 已同步隔离旧结果；同一摘要展开重读时保留已加载内容，避免卸载按钮丢失焦点。
    setLoadingDetails(true);
    void context
      .fetchFileChanges(target, {
        cachePolicy,
        fileChangesState,
      })
      .then(
        (result) => {
          if (disposed) return;
          setLoadedDetails({ key: requestKey, result });
          setLoadingDetails(false);
        },
        (loadError: unknown) => {
          if (disposed) return;
          logger.warn("[ConversationFileSummaryPanel] 读取文件变更详情失败", {
            error: loadError instanceof Error ? loadError.message : String(loadError),
            rowId: target.rowId,
          });
          setLoadedDetails({ key: requestKey, result: null });
          setLoadingDetails(false);
        },
      );

    return () => {
      disposed = true;
    };
  }, [
    cachePolicy,
    context.fetchFileChanges,
    fileChangesState,
    needsDetails,
    open,
    requestKey,
    target,
  ]);

  // [事务] 先 `setDialogOpen(true)` 再发预检：用户点击后要立刻看到容器与加载态。
  // 预检失败只写入错误文案，弹窗保持打开以便重试，不静默关闭。
  // 预检结果只有 canApply 为真时才能进入应用步骤。
  // 发起前清空错误，避免上一次失败提示残留到本次。
  const handlePreviewRewind = useCallback(async () => {
    if (!context.previewFileRewind || !target) return;
    setDialogOpen(true);
    setPreviewLoading(true);
    setError(null);
    try {
      setPreview(await context.previewFileRewind(target));
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setPreviewLoading(false);
    }
  }, [context, intl, target]);

  // [事务] 应用前再校验一次 canApply 与目标行，防止预检后上下文已变。
  // 重复受理视为成功：请求是幂等的，重复应用应表现为已完成而不是报错。
  // 应用期间置为处理中，按钮与弹窗共用这个标记做禁用。
  // 无论成功失败都在收尾分支复位，不能只在成功分支复位。
  const handleApply = useCallback(async () => {
    if (!context.applyFileRewind || !preview?.canApply || !target) return;
    setApplying(true);
    setError(null);
    try {
      const ack: CommandAck = await context.applyFileRewind(target);
      // [失败路径] 只有被接受或幂等重复才关闭弹窗，其它状态保留现场。
      // 宿主返回的消息优先于通用文案，便于定位被拒绝的具体原因。
      // 不要乐观关闭：关闭后错误无处展示，用户会误以为撤销成功。
      if (ack.status === "accepted" || ack.status === "duplicate") {
        setDialogOpen(false);
      } else {
        setError(
          ack.message ?? intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }),
        );
      }
    } catch {
      setError(intl.formatMessage({ id: "chat.changeSummary.rewindDialog.error" }));
    } finally {
      setApplying(false);
    }
  }, [context, intl, preview?.canApply, target]);

  // [诊断] 聚合显示有变更但明细为空，说明投影与详情已经不一致。
  // 这里只记录一次告警，不阻断渲染，也不清空摘要。
  // 升级成错误会白屏，退化成静默又会丢失线上可观测性。
  // 依赖里带行号与轮次号，便于按轮次对齐日志。
  useEffect(() => {
    if (
      !details ||
      !header.fileChanges ||
      header.fileChanges.files <= 0 ||
      details.items.length > 0
    ) {
      return;
    }
    logger.warn("[ConversationFileSummaryPanel] 文件摘要详情为空", {
      expectedFiles: header.fileChanges.files,
      rowId: header.rowId,
      turnId: header.turnId,
    });
  }, [details, header.rowId, header.turnId, header.fileChanges]);

  // 在明细到达前不闪现源文件的聚合统计；读取失败后恢复原摘要，仍可展开重试。
  // [权衡] 过滤场景未就绪时整块不渲染，宁可不显示也不闪现未过滤的数字。
  // 只有具备拉取能力且存在实体时才等待，否则会永久空白。
  // 这里不能加超时兜底：读取失败同样会落键，等待态自然结束。
  if (filtersSources && context.fetchFileChanges && target && !settled) return null;
  // 没有聚合值或文件数为零时不占位，避免空卡片打断消息流。
  // 这条判断必须放在过滤等待之后，否则会先渲染再消失。
  if (!summary || summary.files <= 0) return null;

  // 折叠头与内容区共用 `Collapsible` 容器，撤销弹窗挂在同层 Fragment 上。
  // 弹窗始终挂载、由开关控制显隐，保证预检结果到达时能立即呈现。
  return (
    <>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
      >
        <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-ui-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              aria-label={intl.formatMessage({
                id: open ? "chat.changeSummary.collapse" : "chat.changeSummary.expand",
              })}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-foreground-subtlest transition-transform",
                  open ? "rotate-90" : "rotate-0",
                )}
              />
              <span className="min-w-0 truncate font-medium">{filesChangedLabel}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-diff-added">+{summary.additions}</span>{" "}
                <span className="text-diff-removed">-{summary.deletions}</span>
              </span>
              {isReverted ? (
                <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: "chat.changeSummary.reverted" })}
                </span>
              ) : null}
            </button>
          </CollapsibleTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canUndo || previewLoading || applying}
            onClick={handlePreviewRewind}
            title={intl.formatMessage({ id: "chat.changeSummary.rewind" })}
          >
            {previewLoading || applying ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
            <span>{intl.formatMessage({ id: "chat.changeSummary.rewind" })}</span>
          </Button>
        </div>
        <CollapsibleContent>
          <div className="grid w-full border-t border-border">
            {loadingDetails ? (
              <div className="flex h-8 items-center gap-2 px-2 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-3.5 animate-spin" />
                {intl.formatMessage({
                  id: "chat.changeSummary.rewindDialog.loading",
                })}
              </div>
            ) : details && items.length === 0 ? (
              <div className="px-2 py-1.5 text-ui-base text-foreground-subtle">
                {intl.formatMessage({
                  id: "chat.changeSummary.diffUnavailable",
                })}
              </div>
            ) : (
              items.map((item) => {
                // [契约] 每项在映射时才计算相对路径，因为工作区路径属于渲染上下文的一部分。
                // 提前缓存成模块级变量会在切换工作区后返回错误路径。
                // 相对路径只用于展示与标题，打开文件仍然使用原始路径。
                // 预览来源同时带上身份与远端会话，保证远程文件能被正确解析。
                const relativePath = toWorkspaceRelativePath(context.workspacePath, item.path);
                // 可审阅标记同时决定可点击样式、tabIndex 与无障碍语义，三者必须一致。
                // `item.patches` 为空或 `onOpenCodeViewer` 缺失时保留行展示，只关闭审阅入口。
                // 键盘处理仍绑定在行上，但不可审阅时 tabIndex 为负，无法聚焦。
                const canReview = item.patches.length > 0 && Boolean(context.onOpenCodeViewer);
                const filePreviewSource = buildChangeSummaryFilePreviewSource({
                  path: item.path,
                  relativePath,
                  workspacePath: context.workspacePath,
                  workspaceIdentity: context.workspaceIdentity,
                  workspaceRemoteSessionId: context.workspaceRemoteSessionId,
                });
                return (
                  <div key={item.path} className="w-full bg-background/50 overflow-hidden">
                    <div
                      aria-disabled={!canReview}
                      className={cn(
                        "flex w-full items-center gap-1 px-2 py-2 text-left transition-colors",
                        canReview ? "cursor-pointer hover:bg-hover/30" : "cursor-default",
                      )}
                      onClick={() => openDiff(item, context)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        openDiff(item, context);
                      }}
                      role="button"
                      tabIndex={canReview ? 0 : -1}
                      title={item.path}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <div className="min-w-0 flex items-center">
                          <FileDisplayInline
                            path={item.path}
                            options={{
                              basePath: context.workspacePath,
                              showFilePath: true,
                              className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                              fileNameClassName:
                                "truncate text-ui-base font-medium text-foreground",
                              filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                            }}
                          />
                        </div>
                        {/* 修复原因：writeCount 是撤销预检使用的操作轨迹，摘要行已经用 +/- 表达最终结果；
                            在这里展示会把内部操作次数误当成变更指标，因此只在撤销弹窗保留。 */}
                        <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                          {item.additions > 0 ? (
                            <span className="text-diff-added">+{item.additions}</span>
                          ) : null}
                          {item.deletions > 0 ? (
                            <span className="text-diff-removed">-{item.deletions}</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="default"
                          aria-label={intl.formatMessage({
                            id: "chat.changeSummary.review",
                          })}
                          title={intl.formatMessage({
                            id: "chat.changeSummary.review",
                          })}
                          disabled={!canReview}
                          className="h-7 gap-1.5 rounded-lg bg-input px-2 text-ui-base"
                          onClick={(event) => {
                            event.stopPropagation();
                            openDiff(item, context);
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <span>
                            {intl.formatMessage({
                              id: "chat.changeSummary.review",
                            })}
                          </span>
                        </Button>
                        <OpenSplitButton
                          target={{
                            type: "file",
                            path: item.path,
                            title: relativePath,
                            label: relativePath,
                            previewSource: filePreviewSource,
                          }}
                          onOpenCodeViewer={context.onOpenCodeViewer}
                          hideOpenWithMenu={context.compactForRemoteControl === true}
                          stopPropagation
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConversationFileRewindDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        preview={preview}
        previewLoading={previewLoading}
        applying={applying}
        error={error}
        onApply={handleApply}
      />
    </>
  );
}
