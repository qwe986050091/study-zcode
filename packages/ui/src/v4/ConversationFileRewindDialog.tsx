// INV-01 [边界] 组件只读 preview 与回调，不自行发起回退请求也不写 store；守住位置：ConversationFileRewindDialog 的全部形参与事件绑定；改错故障：UI 出现第二份回退事实，预览列表与真实落盘结果不一致。
// INV-02 [契约] 弹层开关完全受控，open 与 onOpenChange 均由父级提供；守住位置：Dialog 的两个 prop；改错故障：组件内自持开关后父级关不掉，遮罩残留挡住后续操作。
// INV-03 [权衡] variant 决定标题、描述与页脚分支，默认 fileRewind；守住位置：形参默认值与各处 variant 三元；改错故障：未传值时落入 editConflict 分支，取消按钮消失且只剩会话内回退。
// INV-04 [契约] 文件分类只有 safe、unsafe、ignored 三种；守住位置：FileRewindPreviewFile 联合类型与 PreviewFileList 的 type 形参；改错故障：类型收窄失败，reason 分支读到不存在的字段。
// INV-05 [失败路径] 未知 reason 回落到 unsupportedCheckpoint 文案；守住位置：formatReason 的 keyByReason 查表与 ?? 兜底；改错故障：抛出缺键异常，整块预览列表无法渲染。
// INV-06 [契约] 带 reason 的文件显示原因，其余显示操作数；守住位置：PreviewFileList 内的 in 判断；改错故障：safe 文件被套上原因占位，操作数彻底丢失。
// INV-07 [状态] 三类计数在渲染期从 preview 派生，null 时取 0；守住位置：safeCount、unsafeCount、ignoredCount 的 ?? 0；改错故障：空预览时标题出现 undefined 或 NaN。
// INV-08 [顺序] 加载中优先于有预览，有预览优先于空态；守住位置：内容区 previewLoading 与 preview 的三段三元；改错故障：加载中展示上一轮列表，用户误以为已经可以确认。
// INV-09 [失败路径] 安全文件区只在 fileRewind 变体出现；守住位置：safe 区块外层的 variant 判断；改错故障：冲突弹窗里冒出可回退文件，误导用户以为能整文件回滚。
// INV-10 [契约] 忽略区仅在计数大于 0 时挂载；守住位置：ignoredCount > 0 的条件渲染；改错故障：空分组仍占标题行，弹窗出现无意义的空区块。
// INV-11 [失败路径] 无预览时展示 noPreview 提示而非空白；守住位置：三元最后一段的段落；改错故障：内容区塌成空白，用户分不清是失败还是仍在等待。
// INV-12 [失败路径] error 文案独立于预览状态始终可见；守住位置：内容区底部的 error 条件段；改错故障：错误被预览分支吞掉，用户只看到列表却点不动确认。
// INV-13 [事务] canApply 为假时给出不可应用提示并禁用确认；守住位置：cannotApply 段落与确认按钮 disabled；改错故障：按钮可点但服务端拒绝，回退流程走到一半才报错。
// INV-14 [资源] 确认按钮在 applying 或 previewLoading 时禁用；守住位置：disabled 的三项或运算；改错故障：连点触发重复回退，同一版本被应用两次。
// INV-15 [资源] 冲突变体的取消按钮只受 applying 约束；守住位置：ghost 按钮的 disabled 与 onOpenChange 调用；改错故障：应用中被关窗，父子状态不同步。
// INV-16 [资源] 会话内回退按钮额外受 previewLoading 约束；守住位置：conversationOnly 按钮的 disabled；改错故障：预览未就绪就切到会话态，文件改动被无声丢弃。
// INV-17 [状态] 应用中的两个按钮都显示旋转图标，按钮文字不换；守住位置：两处 applying 条件图标渲染；改错故障：点击后无反馈，用户重复点击或直接关窗。
// INV-18 [契约] 冲突弹窗通过 test-id 暴露两个稳定钩子；守住位置：DialogContent 与 conversationOnly 按钮的 data-testid；改错故障：E2E 选择器失效，冲突路径失去回归保护。
//
// 模块职责：展示某条消息的文件回退预览，按安全、不安全、忽略三类列出文件并决定能否确认。
// 状态所有权：open、preview、loading、applying、error 与两个回调全部来自父级，本组件只做投影。
// 阅读顺序：先看 reason 文案映射与列表行组件，再看计数派生、内容三段分支，最后读页脚的两套按钮。
import { Loader2Icon, Undo2Icon } from "lucide-react";
import {
  TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY,
  TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG,
} from "@zcode/shared/test-ids";
import type { V4ConversationFileRewindPreviewResult } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type FileRewindPreviewFile =
  | V4ConversationFileRewindPreviewResult["safeFiles"][number]
  | V4ConversationFileRewindPreviewResult["unsafeFiles"][number]
  | V4ConversationFileRewindPreviewResult["ignoredFiles"][number];

interface ConversationFileRewindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: V4ConversationFileRewindPreviewResult | null;
  previewLoading: boolean;
  applying: boolean;
  error: string | null;
  onApply: () => void;
  variant?: "fileRewind" | "editConflict";
  onConversationOnly?: () => void;
}

// [契约] 职责单一：把后端 reason 枚举翻成 i18n key，判断逻辑留在上游。
// [失败路径] fallbackReasonKey 固定 unsupportedCheckpoint，保证任何未知枚举都有可读文案。
// [契约] keyByReason 覆盖 bash_ignored、checkpoint_missing、checkpoint_unreadable 三种来源。
// [契约] external_modified 与 file_read_failed 分别对应外部改动和读文件失败，语义不可合并。
// [失败路径] 取键时用 ?? 兜底而非索引直取，缺表项时不会返回 undefined 文案。
// [权衡] 这里只翻译不解释，文案细节全部交给语言包，避免组件内硬编码中文。
function formatReason(reason: string, intl: ReturnType<typeof useZCodeIntl>["intl"]) {
  const fallbackReasonKey = "chat.changeSummary.rewindDialog.reason.unsupportedCheckpoint";
  const keyByReason: Record<string, string> = {
    bash_ignored: "chat.changeSummary.rewindDialog.reason.bashIgnored",
    checkpoint_missing: "chat.changeSummary.rewindDialog.reason.checkpointMissing",
    checkpoint_unreadable: "chat.changeSummary.rewindDialog.reason.checkpointUnreadable",
    external_modified: "chat.changeSummary.rewindDialog.reason.externalModified",
    file_read_failed: "chat.changeSummary.rewindDialog.reason.fileReadFailed",
    unsupported_checkpoint: fallbackReasonKey,
  };
  return intl.formatMessage({ id: keyByReason[reason] ?? fallbackReasonKey });
}

// [边界] 入参只有 files 与 type，组件不读取 preview 也不判断 canApply。
// [契约] files 为只读数组，渲染顺序即父级给的顺序，不排序也不去重。
// [失败路径] 空数组直接返回 null，不渲染空容器，避免出现无边框的空白块。
// [状态] key 用 type 加 path 拼接，三个分组里的同名文件不会互相复用实例。
// [契约] 每行左侧是路径且允许截断，右侧是原因或操作数，宽度靠 shrink 与 min-w 分配。
// [失败路径] in 判断区分两类文件：带原因的是不安全或已忽略，不带的是安全文件。
// [权衡] 原因与操作数共用右侧 span，靠三元切换，不为两类文件各建一套行结构。
function PreviewFileList({
  files,
  type,
}: {
  files: readonly FileRewindPreviewFile[];
  type: "safe" | "unsafe" | "ignored";
}) {
  const { intl } = useZCodeIntl();
  if (files.length === 0) return null;
  return (
    <div className="grid gap-1">
      {files.map((file) => (
        <div
          key={`${type}:${file.path}`}
          className="flex items-center justify-between gap-3 rounded-md border border-border bg-input/30 px-2 py-1.5"
        >
          <span className="min-w-0 truncate font-mono text-ui-xs text-foreground">{file.path}</span>
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            {"reason" in file
              ? formatReason(file.reason, intl)
              : intl.formatMessage(
                  { id: "chat.changeSummary.rewindDialog.operationCount" },
                  { count: String(file.operationCount) },
                )}
          </span>
        </div>
      ))}
    </div>
  );
}

// [边界] 这是受控的展示组件：只消费 props，不订阅 store，也不调用服务层。
// [契约] preview 为 null 表示尚无结果，与空数组语义不同，不能提前当成零文件。
// [契约] onApply 只负责通知父级，确认逻辑与失败处理都留在调用方。
// [契约] onConversationOnly 可选，只在 editConflict 变体下由父级提供。
// [状态] 组件内唯一取用的是 intl，其余状态全部来自 props。
// [权衡] variant 默认 fileRewind，让旧调用点不必改动即可保持文件回退语义。
// [失败路径] 若把 applying 或 previewLoading 改成本地状态，重渲染后与真实请求脱节。
export function ConversationFileRewindDialog({
  open,
  onOpenChange,
  preview,
  previewLoading,
  applying,
  error,
  onApply,
  variant = "fileRewind",
  onConversationOnly,
}: ConversationFileRewindDialogProps) {
  const { intl } = useZCodeIntl();
  // [状态] 三个计数都是渲染期派生值，没有本地副本，preview 变化立即反映。
  // [失败路径] 可选链加 ?? 0 处理 null 预览，避免首帧读不到集合长度。
  // [契约] 计数只用于标题文案，不参与能否确认的判断，判定统一走 canApply。
  // [权衡] 忽略分组用 ignoredCount 做挂载条件，安全与不安全分组始终展示标题。
  const safeCount = preview?.safeFiles.length ?? 0;
  const unsafeCount = preview?.unsafeFiles.length ?? 0;
  const ignoredCount = preview?.ignoredFiles.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid={variant === "editConflict" ? TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG : undefined}
      >
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id:
                variant === "editConflict"
                  ? "chat.edit.workspaceConflict.title"
                  : "chat.changeSummary.rewindDialog.title",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({
              id:
                variant === "editConflict"
                  ? "chat.edit.workspaceConflict.description"
                  : "chat.changeSummary.rewindDialog.description",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
          {previewLoading ? (
            <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-3.5 animate-spin" />
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.loading" })}
            </div>
          ) : preview ? (
            <>
              {variant === "fileRewind" ? (
                <section className="grid gap-1">
                  <h3 className="text-ui-base font-medium">
                    {intl.formatMessage(
                      { id: "chat.changeSummary.rewindDialog.safeTitle" },
                      { count: String(safeCount) },
                    )}
                  </h3>
                  <PreviewFileList files={preview.safeFiles} type="safe" />
                </section>
              ) : null}
              <section className="grid gap-1">
                <h3 className="text-ui-base font-medium">
                  {intl.formatMessage(
                    { id: "chat.changeSummary.rewindDialog.unsafeTitle" },
                    { count: String(unsafeCount) },
                  )}
                </h3>
                <PreviewFileList files={preview.unsafeFiles} type="unsafe" />
              </section>
              {ignoredCount > 0 ? (
                <section className="grid gap-1">
                  <h3 className="text-ui-base font-medium">
                    {intl.formatMessage(
                      { id: "chat.changeSummary.rewindDialog.ignoredTitle" },
                      { count: String(ignoredCount) },
                    )}
                  </h3>
                  <PreviewFileList files={preview.ignoredFiles} type="ignored" />
                </section>
              ) : null}
            </>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.noPreview" })}
            </p>
          )}
          {error ? <p className="text-ui-base text-danger">{error}</p> : null}
          {variant === "fileRewind" && preview && !preview.canApply ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.cannotApply" })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {variant === "editConflict" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={applying}
                onClick={() => onOpenChange(false)}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                disabled={applying || previewLoading}
                data-testid={TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY}
                onClick={onConversationOnly}
              >
                {applying ? <Loader2Icon className="animate-spin" /> : null}
                {intl.formatMessage({ id: "chat.edit.workspaceConflict.conversationOnly" })}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="destructive"
              // [事务] 确认可用需同时满足 canApply 为真、非应用中、非加载中三个条件。
              // [失败路径] canApply 为假时按钮置灰，与上方 cannotApply 提示形成同一判定。
              // [资源] applying 期间禁用是防重复提交的主要闸门，不能只靠服务端幂等兜底。
              // [资源] previewLoading 期间禁用，避免在旧预览上提交已变化的文件集合。
              disabled={!preview?.canApply || applying || previewLoading}
              onClick={onApply}
            >
              {applying ? <Loader2Icon className="animate-spin" /> : <Undo2Icon />}
              {intl.formatMessage({ id: "chat.changeSummary.rewindDialog.confirm" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
