// INV-01 [事务] turnSummary 的取值优先级是 buildTurnChangeSummary(changeDetails) 优先、入参 summary 兜底，位置在组件首个 useMemo 回调内；写反会把历史轮次文件混进当前消息。
// INV-02 [事务] 该 useMemo 的依赖必须是 [changeDetails, summary]；漏掉任一项，切换消息后仍沿用上一轮的 fileCount 与增删行数。
// INV-03 计数文案的 one / other 分支只按 turnSummary.fileCount === 1 判定，位置在 filesChangedLabel 的 id 三元表达式；改用 added 判零会让 0 文件轮次出现复数文案。
// INV-04 [失败路径] formatMessage 的 count 必须传 String(turnSummary.fileCount)；改传数字违反字符串模板契约，文案会退化成 chat.changeSummary.filesChanged 裸 key。
// INV-05 [事务] snapshotsByPath 的键必须取 snapshot.path，与文件行的 file.path 同命名空间；换成相对路径后查表全空，文件行可点但 diff 源为空。
// INV-06 [资源] snapshotsByPath 依赖只保留 changeDetails；写成空数组会跨轮复用旧 Map，展开的 diff 仍指向上一轮快照。
// INV-07 [失败路径] isFileRewindApplied 只由 fileState === "reverted" 得出，fileState 的默认 applied 在参数解构处声明；删掉默认值后未传该 prop 的调用点得到 undefined，撤销按钮永不置灰。
// INV-08 [权衡] canRequestFileRewind 用 Boolean(onToggleFiles) 只做能力探测，不触发回调；写成恒真会让无宿主回调的场景渲染出点了没反应的撤销入口。
// INV-09 [失败路径] 撤销区要求 canRequestFileRewind、turnSummary.fileCount > 0、changeDetails 三者同时成立；删掉 fileCount 判断后零文件轮次也会出现无效撤销按钮。
// INV-10 [事务] 撤销按钮的 disabled 取 isFileRewindApplied，可见文案取 toggleActionLabel，两者来源必须同步；只改文案会让已回退状态仍可再次提交回退。
// INV-11 [并发] data-testid 在 messageId 存在时经 testId 拼接、否则用裸常量；写反后同页多条消息的选择器互相冲突，E2E 会点到别的消息。
// INV-12 [权衡] isFileListOpen 的初始值 false 是刻意的默认闭合；改成 true 后大批文件变更会展开并把最新回复顶出视口。
// INV-13 [失败路径] Collapsible 的 open 与 onOpenChange 必须绑同一个 setIsFileListOpen；只接 open 时点击触发器不生效，面板永远打不开。
// INV-14 [并发] hover 背景挂在整行 header 容器，折叠触发器只包左侧标题按钮；把 toggle 提到 header 上，点撤销按钮会冒泡折叠面板。
// INV-15 relativePath 必须由 toWorkspaceRelativePath(workspacePath, file.path) 生成，仅用于展示与打开目标；直接渲染 file.path 会暴露本机绝对路径并撑破窄屏布局。
// INV-16 [失败路径] diff 源与预览源分别来自 buildChangeSummaryDiffViewerSource、buildChangeSummaryFilePreviewSource，必须透传 workspaceIdentity 与 workspaceRemoteSessionId；漏传会让远程会话被当作同路径本地 workspace。
// INV-17 [并发] 文件行 key 必须用 file.path；换成下标后列表重排会复用错行，行级 disabled 与 diff 目标错位。
// INV-18 [并发] 行点击、回车/空格、审阅按钮统一走 openDiffViewer，按钮需阻断冒泡与 onPointerDown；删掉阻断会一次操作打开两次，或绕过 canOpenDiff 打开空 diff。
//
// 模块职责：消息内“变更汇总”面板的单轮投影与入口层，负责文件数与增删行统计展示、文件行折叠列表，以及 diff 与文件预览的打开动作。
// 状态所有权：折叠开合 isFileListOpen 是组件内局部状态；统计与文件列表来自 turnSummary 投影；回退能力由宿主通过 onToggleFiles 注入，本组件不写业务状态。
// 阅读顺序：先看 turnSummary 与 snapshotsByPath 两次投影，再看 header 的统计与回退按钮，最后看 CollapsibleContent 内的文件行与 diff 源构造。
import { useMemo, useState, type CSSProperties } from "react";
import type {
  ZCodePersistedFileChange,
  ZCodeTaskChangeSummary,
  ZCodeTurnFileState,
} from "@zcode/shared";
import { TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON, testId } from "@zcode/shared/test-ids";
import { ChevronRightIcon, Undo2 } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { buildTurnChangeSummary, toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { Button } from "@/components/ui/button.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import { cn } from "@/components/lib/utils.js";
import {
  buildChangeSummaryDiffViewerSource,
  buildChangeSummaryFilePreviewSource,
  openChangeSummaryDiffViewer,
} from "@/messageChangeSummaryPreview.js";
export {
  buildChangeSummaryDiffViewerSource,
  buildChangeSummaryFilePreviewSource,
  openChangeSummaryDiffViewer,
} from "@/messageChangeSummaryPreview.js";

interface MessageChangeSummaryPanelProps {
  summary: ZCodeTaskChangeSummary;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  changeDetails?: ZCodePersistedFileChange | null;
  readonlyDiffPatchesByPath?: ReadonlyMap<string, string>;
  fileState?: ZCodeTurnFileState;
  messageId?: string;
  compactForRemoteControl?: boolean;
  animationDelayMs?: number;
  // M5 ③-4：onPreviewFilesRewind/onApplyFilesRewind 已随 session/previewFileRewind、
  // session/applyFileRewind 旧协议词删除（全仓无 caller 传入）；文件撤销回退只剩
  // onToggleFiles 回调（数据面与协议无关）。
  onToggleFiles?: () => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}

export function MessageChangeSummaryPanel({
  summary,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  changeDetails,
  readonlyDiffPatchesByPath,
  fileState = "applied",
  messageId,
  compactForRemoteControl = false,
  animationDelayMs = 0,
  onToggleFiles,
  onOpenCodeViewer,
}: MessageChangeSummaryPanelProps) {
  const { intl } = useZCodeIntl();
  const [isFileListOpen, setIsFileListOpen] = useState(false);

  // 单轮统计的唯一来源：面板同时收到 summary 与 changeDetails 时，必须让 buildTurnChangeSummary 的结果优先，
  // 仅在其返回空值时才回退到入参 summary；这个优先级决定“文件数、增删行”究竟描述哪一轮。
  // [事务] 回退方向若写反（先用 summary），历史轮次改过的文件会混进当前消息的列表，
  // 用户点开看到的是上一轮的 diff，而标题计数却属于当前轮。
  // 文件头的 +added / -removed 直接取自 turnSummary 的 added 与 removed，不回读 changeDetails 原始快照，
  // 因此投影一旦错轮，计数与列表会同向错且无任何运行时告警。
  const turnSummary = useMemo(() => {
    // Bugfix: 某些链路传进来的 summary 可能还是 task/session 级汇总。
    // 面板已经拿到了当前轮 changeDetails，优先从单轮快照重算，避免历史轮次文件混进当前消息。
    return buildTurnChangeSummary(changeDetails) ?? summary;
  }, [changeDetails, summary]);

  // 计数文案的单复数只由 fileCount === 1 切换 one 与 other 两个 message id，位置在本行的 id 三元表达式。
  // 判定条件必须与 fileCount 同源，不能改看 added 或 files 长度，否则零变更轮次会出现复数文案。
  // count 参数显式 String(fileCount)：i18n 模板只接受字符串，传数字会在格式化阶段被拒。
  // [失败路径] 资源里缺对应 id 时不抛错，而是把裸 key 直接渲染出来，
  // 所以改 id 名必须同步多语言资源，否则只表现为界面出现 chat.changeSummary.filesChanged 字样。
  //
  const filesChangedLabel = intl.formatMessage(
    {
      id:
        turnSummary.fileCount === 1
          ? "chat.changeSummary.filesChanged.one"
          : "chat.changeSummary.filesChanged.other",
    },
    { count: String(turnSummary.fileCount) },
  );

  // Bugfix: 变更摘要以前只有聚合计数，文件行点击后拿不到对应的 before/after。
  // 这里按 path 建索引，把同一轮持久化快照重新接回 UI，文件列表才能展开真正的 diff。
  // 快照索引把本轮 changeDetails 的 snapshots 投影成 path 到 snapshot 的映射，供文件行按需取 before/after。
  // [事务] 键必须用 snapshot 的原始 path，与文件行的 file.path 保持同一命名空间；
  // 改成相对路径再做键，查表会全部落空，文件行仍可点但拿不到 diff 源，表现为审阅按钮无响应。
  // [资源] 依赖只保留 changeDetails：漏掉它会在切换消息后继续复用上一轮 Map，diff 内容与标题路径对不上。
  // snapshots 为空时得到的是空 Map 而非 undefined，下游一次查表即可判定有无快照；
  // 不要在这里补默认对象，否则空态会被伪装成“有快照但内容为空”。
  const snapshotsByPath = useMemo(
    () => new Map((changeDetails?.snapshots ?? []).map((snapshot) => [snapshot.path, snapshot])),
    [changeDetails],
  );
  // 回退态只由 fileState 的 reverted 值判定，fileState 的默认 applied 在参数解构处声明；
  // 删掉默认值会让未传该 prop 的调用点拿到 undefined，撤销按钮既不置灰也不显示已回退文案。
  // canRequestFileRewind 用 Boolean(onToggleFiles) 表达宿主是否提供回退能力，只做探测、不调用回调。
  // [权衡] 写成恒真会让无回调场景也渲染撤销入口，点击后静默无响应，比直接不渲染更难排查。
  // toggleActionLabel 与按钮的 disabled 共用 isFileRewindApplied，文案说已回退时按钮必须同时锁死。
  //
  const isFileRewindApplied = fileState === "reverted";
  const toggleActionLabel = intl.formatMessage({
    id: isFileRewindApplied
      ? "chat.changeSummary.reverted"
      : "chat.changeSummary.rewind",
  });
  const panelToggleLabel = intl.formatMessage({
    id: isFileListOpen ? "chat.changeSummary.collapse" : "chat.changeSummary.expand",
  });
  const reviewDiffLabel = intl.formatMessage({ id: "chat.changeSummary.review" });
  const canRequestFileRewind = Boolean(onToggleFiles);

  return (
    <>
    <Collapsible
      open={isFileListOpen}
      onOpenChange={setIsFileListOpen}
      // Bugfix: 历史消息里的文件卡会等二次校验后再出现；
      // summary 如果没有同样的渐入，会在文件卡稳定前后显得像突兀跳出。
      data-zcode-stream-animate="true"
      className="overflow-hidden rounded-xl border border-border bg-card shadow-none"
      style={
        {
          "--zcode-stream-animation-delay": `${animationDelayMs}ms`,
        } as CSSProperties
      }
    >
      {/* Bugfix: 展开/收起触发器之前只给内部小按钮加 hover 背景，
          收起态看起来像 header 里漂着一块。hover 视觉提升到整行 header，
          但仍只让左侧标题区域负责 toggle，避免右侧撤销按钮误触发折叠。 */}
      <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-hover">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={panelToggleLabel}
            title={panelToggleLabel}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left"
          >
            <ChevronRightIcon
              className={`size-3.5 shrink-0 text-foreground-subtlest transition-transform ${
                isFileListOpen ? "rotate-90" : ""
              }`}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-ui-base font-medium text-foreground">
              {filesChangedLabel}
            </span>
            <span className="shrink-0 tabular-nums text-ui-base">
              <span className="text-diff-added">+{turnSummary.added}</span>{" "}
              <span className="text-diff-removed">-{turnSummary.removed}</span>
            </span>
          </button>
        </CollapsibleTrigger>
        {canRequestFileRewind && turnSummary.fileCount > 0 && changeDetails ? (
          <div className="flex items-center gap-1.5 text-ui-base text-foreground-subtle">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={
                messageId
                  ? testId(TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON, messageId)
                  : TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON
              }
              data-message-id={messageId}
              aria-label={toggleActionLabel}
              title={toggleActionLabel}
              disabled={isFileRewindApplied}
              onClick={() => onToggleFiles?.()}
              className="h-7 gap-1.5 px-2 text-ui-base text-foreground-subtle hover:text-foreground"
            >
              <span>{toggleActionLabel}</span>
              <Undo2 className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>

      <CollapsibleContent>
        {/* Bugfix: 变更摘要整体之前没有折叠态，完成任务后会默认展开所有文件行。
            默认闭合可避免大批文件变更把最新回复向上挤开；单文件 diff 仍保持按需展开。 */}
        {turnSummary.files.map((file) => {
          const relativePath = toWorkspaceRelativePath(workspacePath, file.path);
          const snapshot = snapshotsByPath.get(file.path);
          const readonlyPatch = readonlyDiffPatchesByPath?.get(file.path);
          const diffViewerSource = buildChangeSummaryDiffViewerSource({
            patch: readonlyPatch,
            path: file.path,
            snapshot,
            relativePath,
            workspacePath,
            workspaceIdentity,
            workspaceRemoteSessionId,
          });
          const filePreviewSource = buildChangeSummaryFilePreviewSource({
            path: file.path,
            relativePath,
            workspacePath,
            workspaceIdentity,
            workspaceRemoteSessionId,
          });
          const canOpenDiff = Boolean(diffViewerSource && onOpenCodeViewer);
          const openDiffViewer = () => {
            openChangeSummaryDiffViewer(diffViewerSource, onOpenCodeViewer);
          };

          return (
            <div key={file.path} className="w-full bg-background/50 overflow-hidden">
              <div
                aria-disabled={!canOpenDiff}
                className={cn(
                  "flex w-full items-center gap-1 px-2 py-2 text-left transition-colors",
                  canOpenDiff ? "cursor-pointer hover:bg-hover/30" : "cursor-default",
                )}
                onClick={openDiffViewer}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") {
                    return;
                  }
                  event.preventDefault();
                  openDiffViewer();
                }}
                role="button"
                tabIndex={canOpenDiff ? 0 : -1}
                title={file.path}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="min-w-0 flex items-center">
                    <FileDisplayInline
                      path={file.path}
                      options={{
                        basePath: workspacePath,
                        showFilePath: true,
                        className: "inline-flex min-w-0 max-w-full items-center gap-1.5",
                        fileNameClassName: "truncate text-ui-base font-medium text-foreground",
                        filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                      }}
                    />
                  </div>
                  <span className="flex shrink-0 items-center gap-2 tabular-nums text-ui-base">
                    {file.added > 0 ? <span className="text-diff-added">+{file.added}</span> : null}
                    {file.removed > 0 ? (
                      <span className="text-diff-removed">-{file.removed}</span>
                    ) : null}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    aria-label={reviewDiffLabel}
                    title={reviewDiffLabel}
                    disabled={!canOpenDiff}
                    className="h-7 gap-1.5 rounded-lg bg-input px-2 text-ui-base"
                    onClick={(event) => {
                      event.stopPropagation();
                      openDiffViewer();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <span>{reviewDiffLabel}</span>
                  </Button>
                  <OpenSplitButton
                    target={{
                      type: "file",
                      path: file.path,
                      title: relativePath,
                      label: relativePath,
                      previewSource: filePreviewSource,
                    }}
                    onOpenCodeViewer={onOpenCodeViewer}
                    // Bugfix: 手机远控只需要在应用内预览 diff 文件，不需要桌面端的“选择 App 打开”菜单。
                    // 隐藏下拉区可以减少窄屏误触，同时保留主“打开”按钮的预览能力。
                    hideOpenWithMenu={compactForRemoteControl}
                    stopPropagation
                  />
                </div>
              </div>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
    </>
  );
}
