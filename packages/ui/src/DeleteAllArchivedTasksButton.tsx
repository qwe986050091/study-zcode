// INV-01 交互与数据分离：守住位置 组件体；改错故障：跨工作区收集与删除散落在视图里，难以复用与测试。
// INV-02 双保险防重：守住位置 inFlight 与 busy；改错故障：连点触发两轮批量删除。
// INV-03 先清结果：守住位置 setResultMessage 的首次调用；改错故障：新操作开始时仍显示上一轮提示。
// INV-04 零计数早退：守住位置 selection.count 判断；改错故障：没有可删任务仍弹确认框。
// INV-05 不可用说明：守住位置 unavailable 的拼接；改错故障：部分工作区不可用时用户不知情。
// INV-06 取消无副作用：守住位置 confirmed 判断；改错故障：取消确认后仍发起删除。
// INV-07 结果合并：守住位置 删除结果与不可用说明的拼接；改错故障：部分失败被成功计数掩盖。
// INV-08 失败追加：守住位置 catch 里的数组拼接；改错故障：失败提示覆盖已成功的结果。
// INV-09 刷新也受保护：守住位置 onRefresh 的调用位置；改错故障：刷新抛错导致按钮永久忙碌。
// INV-10 必定收尾：守住位置 finally；改错故障：异常后 inFlight 永远为真，按钮再也点不动。
// INV-11 标签随忙碌：守住位置 actionLabel 的三元；改错故障：忙碌时无障碍名仍是旧文案。
// INV-12 菜单先收：守住位置 onSelect 的顺序；改错故障：确认框叠在未关闭的菜单上。
// INV-13 禁用一致：守住位置 触发器与菜单项的 disabled；改错故障：菜单里可点但触发器已禁用。
// INV-14 容器缺省：守住位置 actionsContainer 的三态判断；改错故障：未传容器时不渲染菜单。
// INV-15 提示不迁移：守住位置 结果提示的渲染位置；改错故障：提示被挂到操作容器，列表刷新后消失。
// INV-16 状态可读：守住位置 role=status；改错故障：读屏用户不知道删除结果。
// INV-17 文案全走字典：守住位置 所有 formatMessage；改错故障：界面出现硬编码语言。
// INV-18 测量不依赖：守住位置 组件外部结构；改错故障：把按钮塞进需要测量的行内布局，导致抖动。
//
// 模块职责：提供归档任务的批量删除入口，串起收集、确认、删除、刷新与结果提示。
// 状态所有权：归档数据与刷新归调用方；本组件只持有忙碌、菜单与结果文案。
// 阅读顺序：属性 → 防重状态 → 删除流程 → 菜单 → 容器与提示。
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderIcon, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  collectArchivedTaskDeletion,
  deleteArchivedTaskSelection,
  type ArchivedTaskDeletionWorkspace,
  type ArchivedTaskDeletionTarget,
} from "@/lib/archivedTaskDeletion.js";
import { logger } from "@/logger.js";

// 组件只负责交互与状态，跨工作区收集与删除都在工具函数里完成。
// 容器为 undefined 时原地渲染，为空值时整块不渲染。
//
export function DeleteAllArchivedTasksButton({
  workspaces,
  count,
  disabled,
  actionsContainer,
  onDeleted,
  onRefresh,
}: {
  workspaces: ArchivedTaskDeletionWorkspace[];
  count: number;
  disabled: boolean;
  actionsContainer?: HTMLElement | null;
  onDeleted: (target: ArchivedTaskDeletionTarget) => void;
  onRefresh?: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  // `inFlight` 拦同步连点，`busy` 驱动按钮禁用：两道保险各管一层。
  // 之所以拆成两个状态：`setBusy` 的界面更新落在下一帧，连点可能赶在禁用生效之前。
  //
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  // 入口先清空上一条结果，避免旧提示与新操作混淆。
  // 流程是收集、确认、删除、刷新四步，任一步失败都落到同一提示位。
  //
  async function handleDeleteAll() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setResultMessage(null);
    try {
      // 收集阶段同时返回不可用工作区，用于确认框与结果里的附加说明。
      // 计数为零时不再弹确认框，直接提示没有可删除任务。
      //
      const selection = await collectArchivedTaskDeletion(workspaces);
      const unavailable =
        selection.unavailableWorkspaces.length > 0
          ? intl.formatMessage(
              { id: "taskList.deleteAllArchivedUnavailable" },
              { projects: selection.unavailableWorkspaces.join("、") },
            )
          : "";
      if (selection.count === 0) {
        setResultMessage(unavailable || intl.formatMessage({ id: "taskList.noArchivedTasks" }));
        return;
      }
      // 确认框文案合并不可用说明，空串在拼接时被过滤。
      // 取消操作不写任何结果，保留原列表状态。
      //
      const confirmed = await confirmDialog({
        title: intl.formatMessage(
          { id: "taskList.deleteAllArchivedTitle" },
          { count: selection.count },
        ),
        description: [
          intl.formatMessage({ id: "confirmDialog.archivedTaskDeleteDescription" }),
          unavailable,
        ]
          .filter(Boolean)
          .join("\n\n"),
        confirmLabel: intl.formatMessage({ id: "taskList.deleteAllArchived" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      // 删除由工具函数逐个回调，组件不关心单条失败的细节。
      // 结果消息把删除、跳过、失败三个计数合并展示。
      //
      const result = await deleteArchivedTaskSelection(selection, onDeleted);
      setResultMessage(
        [
          intl.formatMessage(
            { id: "taskList.deleteAllArchivedResult" },
            { deleted: result.deleted, skipped: result.skipped, failed: result.failed },
          ),
          unavailable,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      await onRefresh?.();
    // 失败追加而不是覆盖已有结果，保留已成功的部分计数。
    // 刷新失败也走这里，因此提示用「删除或刷新失败」。
    //
    } catch (error) {
      logger.error("[ArchivedTaskDeletion] 批量删除或刷新失败", error);
      setResultMessage((current) =>
        [current, intl.formatMessage({ id: "taskList.deleteAllArchivedError" })]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // 忙碌时标签切换为进行中文案，同时用于无障碍名与提示。
  // `actionLabel` 只看 `busy`，`menuOpen` 不参与文案切换。
  //
  const actionLabel = intl.formatMessage({
    id: busy ? "taskList.deleteAllArchivedBusy" : "taskList.archivedActions",
  });
  // 菜单受控：选择后先收起再执行，避免确认框压在菜单上。
  // 触发器与菜单项共用同一禁用条件，两条路径都不会漏拦截。
  //
  const menu = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ControlHintTooltip title={actionLabel}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || busy}
            data-testid="archived-tasks-actions"
            aria-label={actionLabel}
            aria-busy={busy}
            className="shrink-0 text-foreground-subtle hover:text-foreground max-md:size-8"
          >
            {busy ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <MoreHorizontal className="size-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-ui-sm font-normal text-foreground-subtle">
          {intl.formatMessage({ id: "taskList.archivedTaskCount" }, { count })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled || busy}
          data-testid="delete-all-archived-tasks"
          className="max-md:min-h-9"
          onSelect={() => {
            setMenuOpen(false);
            void handleDeleteAll();
          }}
        >
          <Trash2 className="size-3.5" />
          {intl.formatMessage({ id: "taskList.deleteAllArchivedMenu" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {/* 只移动控件的渲染位置，查询/确认/删除仍随归档列表存活，菜单关闭不会卸载这些状态。 */}
      {actionsContainer === undefined
        ? menu
        : actionsContainer
          ? createPortal(menu, actionsContainer)
          : null}
      {resultMessage ? (
        <p
          role="status"
          className="min-w-0 whitespace-pre-line break-words px-2 py-1 text-ui-sm text-foreground-subtle"
        >
          {resultMessage}
        </p>
      ) : null}
    </>
  );
}
