// ConversationQueuePanel 是 v4 会话队列面板：把 CLI 投影的 queue.items 渲染成可拖拽的行列表，并转发删除、撤回编辑、立即发送、恢复排空四类意图。
// 数据是权威投影而不是本地状态：任何增删改排序都只发 command，界面等下一次 queue 投影自然收敛，不在这里做乐观改写。
// 不负责：排空策略与 pauseReason 的产生、草稿持久化、发送时序与 ACK 重试、附件上传；这些分别属于 CLI 与上游 compositor。
//
// INV-01 断言：队列行一律以 queueItemId 作为 React key 与 dnd id，绝不用数组下标 —— 守住它的位置：面板 map 与 useSortable 的 id —— 改错故障：排序后行内容与按钮错位，删除会命中相邻项。
// INV-02 断言：dispatch.state 不是 queued 的行整行锁死，含拖拽手柄与所有按钮 —— 守住它的位置：dispatchLocked 计算 —— 改错故障：已进入派发链路的项被删除或重排，CLI 与投影互相覆盖导致队列错序。
// INV-03 断言：editPending 只锁 pendingEditQueueItemId 命中的那一行 —— 守住它的位置：QueueRow 的 rowLocked 与面板传参 —— 改错故障：撤回一项时全队列变灰，用户无法继续处理其它待发项。
// INV-04 断言：撤回编辑必须等权威删除 ACK 后才恢复 composer 草稿 —— 守住它的位置：onEditItem 契约与调用处的 void 语义 —— 改错故障：删除失败时草稿与队列项并存，用户重发产生重复消息。
// INV-05 断言：立即发送用乐观投影口径上报，只有恢复排空才要求 authority_ack —— 守住它的位置：sendNow 的 runUserAction 与 handleResume 的 runUserActionAsync —— 改错故障：失败被记成成功，队列未消费却显示已发送。
// INV-06 断言：恢复排空必须由 finally 复位 resumePending，异常路径也不例外 —— 守住它的位置：handleResume 的 try 与 finally —— 改错故障：一次失败后按钮永久禁用，用户只能重启界面。
// INV-07 断言：resumePending 是本地互斥量，不写回投影 —— 守住它的位置：useState 与 handleResume 的 guard —— 改错故障：双击重复下发 setAutoDrain，横幅闪烁且埋点重复计数。
// INV-08 断言：向下拖动时 before 取「移除自身后 over 的下一项」，null 表示队尾 —— 守住它的位置：resolveV4QueueReorderAnchor 的 fromIndex 小于 overIndex 分支 —— 改错故障：下移一格变成原地不动或跨两格，顺序与用户预期相反。
// INV-09 断言：向上拖动的 before 恒为 over 自身 —— 守住它的位置：同一函数的兜底返回 —— 改错故障：上移插入偏一位，拖到顶部落到第二位。
// INV-10 断言：active 等于 over、或任一 id 不在当前投影中时返回 null 且不下发 reorder —— 守住它的位置：函数前置判断与 handleDragEnd 的早退 —— 改错故障：无效拖拽也发 command，服务端报锚点非法并弹错误提示。
// INV-11 断言：拖拽只在面板内纵向移动，位移 x 恒为 0 —— 守住它的位置：restrictQueueDragToPanel —— 改错故障：行被拖出面板侧向漂移，松手位置与落点不符。
// INV-12 断言：拖拽中必须把 dnd-kit 的 scale 压回 1 —— 守住它的位置：行内 useMemo 的 style —— 改错故障：按钮与文字在拖拽中变形，松手瞬间跳回，触控目标抖动。
// INV-13 断言：autoDrain 为 false 时必须渲染暂停横幅并按 pauseReason 选文案 —— 守住它的位置：面板的感叹号 autoDrain 分支 —— 改错故障：队列静默停摆，用户继续发送却永远不派发，误以为消息丢失。
// INV-14 断言：队列为空时整块返回 null，且早退位于全部 hook 之后 —— 守住它的位置：ConversationQueuePanelImpl 的早退 —— 改错故障：composer 上方残留空磨砂条压住输入区，或 hooks 数量变化触发运行时崩溃。
// INV-15 断言：conversationQuotes 存在时覆盖正文解析出的 references —— 守住它的位置：parsedInput 的展开顺序 —— 改错故障：引用 chip 与真正发送内容不一致，用户看到的引用是旧文本。
// INV-16 断言：topic-history 附件对外只显示条数文案，不暴露内部路径 —— 守住它的位置：attachmentNames 的 sourceKind 分支 —— 改错故障：界面出现内部 topic 标识，泄露实现细节且用户无法辨认附件。
// INV-17 断言：未接线 onMoveItem 时拖拽必须整体禁用 —— 守住它的位置：sortable 传给 useSortable 的 disabled —— 改错故障：手柄可拖但松手无回调，行停在半途，视觉与数据永久不一致。
// INV-18 断言：compact 行固定渲染 /compact 且不提供编辑入口 —— 守住它的位置：isCompact 的文本与 onEditItem 分支 —— 改错故障：斜杠命令被当普通文本回填，撤回后产生非法 prompt。
// INV-19 断言：行内一律使用父级注入的 intl，不在 memo 行内自取 context —— 守住它的位置：QueueRowProps 的 intl —— 改错故障：语言切换时 memo 行不刷新，界面出现中英混排。
// INV-20 断言：data-queue-item-id 与 data-dispatch-state 与 data-edit-pending 是 e2e 唯一观察出口 —— 守住它的位置：行与面板的 data 属性 —— 改错故障：回归用例无法定位行状态，队列相关断言静默失效。
import { BotChannelMessageContent } from "@/v4/ChannelMentionContent.js";
import { parsePromptConversationSelections } from "@/lib/conversationSelectionReference.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  TID_V4_QUEUE,
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_ITEM_DELETE,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_SEND_NOW,
  TID_V4_QUEUE_PAUSED_BANNER,
  TID_V4_QUEUE_RESUME,
  testId,
} from "@zcode/shared/test-ids";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";
import { ArrowUpFromLine, GripVertical, PencilIcon, Trash2Icon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";

// [契约] 本组 props 全是回调与只读投影，组件内不保存队列副本，父级无需提供回写接口
// onMoveItem 的 beforeQueueItemId 传 null 表示队尾，面板不得把 null 翻译成某个具体 id
// pendingEditQueueItemId 只参与视觉与禁用，不参与删除判定，最终由 CLI 决定该项是否存在
// 所有回调均为可选：调用方未接线时对应按钮整块不渲染，而不是渲染成禁用态
export interface ConversationQueuePanelProps {
  queue: QueueState;
  /** 删除队列项（deleteQueueItem command）。 */
  onDeleteItem?: (queueItemId: string) => void;
  /** 撤回队列项到发起端 composer；权威删除成功后才恢复草稿。 */
  onEditItem?: (queueItemId: string) => Promise<void> | void;
  /** 正在等待 delete ACK / composer restore 的目标项；仅锁该 row。 */
  pendingEditQueueItemId?: string | null;
  /** 立即发送队列项（sendQueuedNow command，stop 当前 + 消费该项）。 */
  onSendNow?: (queueItemId: string) => void;
  /** 拖拽排序项（reorderQueueItem，移动到锚点前；null=队尾）。 */
  onMoveItem?: (queueItemId: string, beforeQueueItemId: string | null) => void;
  /** 暂停队列恢复：CLI setAutoDrain(true)，idle 立即消费、busy 仅武装。 */
  onResume?: () => Promise<void> | void;
}

// QueueItem 直接从协议 QueueState 派生，禁止在此另写一份形状相同的本地类型
// 协议新增的 dispatch 状态必须零改动流到这里，否则行锁判断会在新状态下全部失效
// 需要派生视图模型时用函数内局部变量展开，不要改这个别名的来源
type QueueItem = QueueState["items"][number];

export interface V4QueueReorderAnchor {
  beforeQueueItemId: string | null;
  queueItemId: string;
}

// [契约] 纯函数：只吃当前投影快照，不读 ref、不发 command，保证拖拽中重复调用结果稳定
// 返回的是「插入到谁之前」而不是目标下标，因为 CLI 的 reorder 只接受锚点 id
// 调用方拿到 null 必须放弃本次拖拽，不能退化成按 index 计算，两次投影之间 index 会漂移
// 参数顺序为 active 在前、over 在后，写反会让向上与向下分支整体颠倒
export function resolveV4QueueReorderAnchor(
  items: readonly QueueItem[],
  activeQueueItemId: string,
  overQueueItemId: string,
): V4QueueReorderAnchor | null {
  // [失败路径] 同一 id 视为没有拖到有效位置，返回 null 而不是返回自身 id
  // 若改成返回自身，CLI 会收到 before 等于自身的锚点，只能以非法参数拒绝
  // 判断必须放在查找下标之前：拖拽取消时 dnd-kit 的 over 往往仍是 active 自身
  // 紧随其后的下标缺失判断覆盖另一种窗口：投影已被权威快照替换，旧 id 已不存在
  if (activeQueueItemId === overQueueItemId) {
    return null;
  }

  const fromIndex = items.findIndex((item) => item.queueItemId === activeQueueItemId);
  const overIndex = items.findIndex((item) => item.queueItemId === overQueueItemId);
  if (fromIndex < 0 || overIndex < 0) {
    return null;
  }

  // 向下移动：目标在源之后，插入语义换算为「放在 over 的下一项之前」
  // 这是 dnd-kit 下标模型与 before 锚点模型之间唯一的换算点，别处不要做 index 运算
  // 向上移动走函数末尾的兜底返回，before 直接等于 over，因为移除自身不影响 over 下标
  // [权衡] 没有使用本地 arrayMove，因为本地移动只是预览，权威顺序仍以 CLI 回执为准
  if (fromIndex < overIndex) {
    // 先构造移除自身后的序列，再在它里面定位 over，模拟「已经挪走」之后的插入点
    // 若直接在原数组取 over 的下一项，向下拖一格会算出下一项的下一项，表现为原地不动
    // filter 用 queueItemId 而不是下标，避免并发投影更新时删掉错误的行
    // 这里依赖 items 中 id 唯一；重复 id 会一次滤掉多行，锚点随之后移导致落点偏移
    const itemsAfterRemoval = items.filter((item) => item.queueItemId !== activeQueueItemId);
    const overIndexAfterRemoval = itemsAfterRemoval.findIndex(
      (item) => item.queueItemId === overQueueItemId,
    );
    // over 已是移除后末项时 nextItem 为空，转成 null 交由协议表示队尾
    // 不要把 null 换成最后一个 id 的某种变体，两者在 CLI 侧是否等价没有保证
    // 定位不到 over 时同样落到 null，属于前置校验之外的安全兜底，不要在这里抛错
    const nextItem = itemsAfterRemoval[overIndexAfterRemoval + 1];
    return {
      beforeQueueItemId: nextItem?.queueItemId ?? null,
      queueItemId: activeQueueItemId,
    };
  }

  return {
    beforeQueueItemId: overQueueItemId,
    queueItemId: activeQueueItemId,
  };
}

// [资源] 拖拽修饰器每帧都会执行，只做纯数值夹取，不分配对象、不读取 DOM 尺寸
// x 恒为 0：队列是单列纵向列表，任何横向位移都会让行与面板边框错位
// 只改 y，transform 里其它字段原样带回，缺字段会让 dnd-kit 回退到默认变换
// 缩放不在这里处理，行内 style 会把 scale 单独压回 1，两处职责不要合并
const restrictQueueDragToPanel: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  // 首帧 draggingNodeRect 可能尚未测量，退回 activeNodeRect 保证夹取始终有参考矩形
  // 边界优先取容器矩形，容器在折叠或动画中拿不到时用 windowRect 兜底
  // 两者都为空时只禁用横向、纵向保持原值，避免 NaN 让整行飞出视口
  // 不要缓存这两个矩形，它们随滚动与窗口尺寸变化，缓存会让夹取范围过期
  const nodeRect = draggingNodeRect ?? activeNodeRect;
  const boundaryRect = containerNodeRect ?? windowRect;
  if (!nodeRect || !boundaryRect) {
    return {
      ...transform,
      x: 0,
    };
  }

  // minY 与 maxY 是让整行留在边界内的位移区间：上边界减行顶、下边界减行底
  // [权衡] 用行自身高度而非固定行高，compact 行与带附件行的视觉高度并不相同
  // 松手时不做二次校正，依靠 dnd-kit 的 transition 回落，否则回弹会有两段动画
  const minY = boundaryRect.top - nodeRect.top;
  const maxY = boundaryRect.bottom - nodeRect.bottom;
  return {
    ...transform,
    x: 0,
    y: Math.min(Math.max(transform.y, minY), maxY),
  };
};

// [契约] 行组件只收单项数据与已稳定的回调，不收整个 queue，避免任一项变动重建全部行
// intl 由面板注入而不是行内取 hook，保证 memo 行只在语言真正切换时重渲染
// editPending 传布尔而不是 id，行内不再重复做「我是不是待撤回项」的判断
interface QueueRowProps {
  item: QueueItem;
  index: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  sortable: boolean;
  onDeleteItem?: (queueItemId: string) => void;
  onEditItem?: (queueItemId: string) => Promise<void> | void;
  editPending: boolean;
  onSendNow?: (queueItemId: string) => void;
}

// memo 的收益依赖面板把 onDeleteItem 与 onEditItem 与 onSendNow 原样透传，不要在面板里包内联箭头
// 确需包装时必须用 useCallback 且依赖只含稳定引用，否则每次投影更新都会全量重渲染
// 拖拽中的 isDragging 来自 useSortable 内部状态，不经过 props，所以不会打断这层 memo
const QueueRow = memo(function QueueRow({
  item,
  index,
  intl,
  sortable,
  onDeleteItem,
  onEditItem,
  onSendNow,
  editPending,
}: QueueRowProps) {
  // [并发] dispatch.state 只有 queued 才允许操作，sending 与 consumed 都已进入派发链路
  // 锁的是行而不是整个队列：其余仍 queued 的项必须保持可拖动可删除，否则用户被卡死
  // 这里读投影快照、不订阅事件，解锁靠下一次 queue 投影到达后自然生效
  // 若改成「非 idle」之类的本地推断，会在 ACK 未回时提前解锁，造成双发或静默丢失
  const dispatchLocked = item.dispatch.state !== "queued";
  const rowLocked = dispatchLocked || editPending;
  const isCompact = item.kind === "compact";
  // 先展开正文解析结果，再用 conversationQuotes 覆盖 references：显式引用优先于正文里的旧标记
  // [契约] 是覆盖而不是合并，同一行存在两种来源时以发送时的快照为准
  // visibleContent 直接作为行正文与 title，行内不得再截断或二次解析
  // 不要在渲染中改写 item.text，队列项是只读投影，改文本只能走撤回编辑
  const parsedInput = {
    ...parsePromptConversationSelections(item.text),
    ...(item.conversationQuotes ? { references: item.conversationQuotes } : {}),
  };
  // topic-history 附件对外只暴露格式化后的条数文案，内部路径不能出现在界面上
  // 普通附件直接用 fileName，这里只生成展示串，不参与发送与去重
  // 计数缺失时按 0 渲染，避免出现读取了空值的脏文案
  const attachmentNames = item.attachments.map((attachment) =>
    attachment.sourceKind === "topic-history"
      ? intl.formatMessage(
          { id: "chat.attachments.topicHistory" },
          { count: attachment.messageCount ?? 0 },
        )
      : attachment.fileName,
  );
  // useSortable 的 id 必须是 queueItemId，与 SortableContext 的 items 完全同源，否则拖拽会命中错行
  // disabled 同时受 sortable 与 rowLocked 控制，未接线 onMoveItem 时手柄应当不可用
  // 不要用下标当 id，排序后下标会变，dnd-kit 会把同一行识别成新行
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    disabled: !sortable || rowLocked,
    id: item.queueItemId,
  });

  // [权衡] 把 scaleX 与 scaleY 压回 1，抵消 dnd-kit 按 over 节点尺寸计算的排序缩放
  // 队列行是固定触控目标，允许缩放会让拖拽中的按钮与文本变形，松手时整体跳动
  // zIndex 只在拖拽中抬到 10，平时不写值，避免每行生成独立的层叠上下文
  // useMemo 依赖只包含 transform 与 transition 与 isDragging，别把整个 item 塞进依赖
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(
        transform
          ? {
              ...transform,
              // dnd-kit 排序时会按 over 节点尺寸附带 scale；
              // 队列行是固定触控目标，缩放会让拖拽中的按钮和文本短暂变形。
              scaleX: 1,
              scaleY: 1,
            }
          : null,
      ),
      transition,
      zIndex: isDragging ? 10 : undefined,
    }),
    [isDragging, transition, transform],
  );
  // 行上的 data-queue-item-id 与 data-index 与 data-dispatch-state 是 e2e 的直接断言对象，改名等于打断回归
  // data-kind 与 data-edit-pending 是外部观察行状态的唯一出口，不要只保留在样式类里
  // [契约] 结构固定为「拖拽手柄 + 文本区 + 操作区」，新增动作放到操作区末尾，不要插入文本节点
  return (
    <li
      ref={setNodeRef}
      data-testid={testId(TID_V4_QUEUE_ITEM, item.queueItemId)}
      data-queue-item-id={item.queueItemId}
      data-index={index}
      data-kind={item.kind}
      data-dispatch-state={item.dispatch.state}
      data-edit-pending={editPending ? "true" : "false"}
      className={cn(
        "relative flex items-center gap-2 rounded-xl px-1.5 py-1 pr-1 transition-colors hover:bg-hover/30",
        isDragging ? "bg-hover/40 shadow-sm" : null,
        editPending ? "opacity-60" : null,
      )}
      style={style}
    >
      <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.drag" })}>
        <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          size="icon-md"
          data-v4-queue-drag-handle="true"
          data-queue-item-id={item.queueItemId}
          aria-label={intl.formatMessage({ id: "chat.queue.drag" })}
          className="shrink-0 cursor-grab touch-none text-foreground-subtlest active:cursor-grabbing"
          disabled={rowLocked}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </Button>
      </ControlHintTooltip>
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 truncate text-ui-base text-foreground",
          isCompact ? "font-mono" : null,
        )}
        title={parsedInput.visibleContent}
      >
        <span className="flex min-w-0 flex-col">
          <BotGroupSourceLabel source={item.botGroupSource} />
          <span className="truncate">
            <BotChannelMessageContent
              source={isCompact ? undefined : item.botGroupSource}
              text={isCompact ? "/compact" : parsedInput.visibleContent}
            />
          </span>
          {parsedInput.references.length ? (
            <ConversationSelectionReferenceChip references={parsedInput.references} />
          ) : null}
          {item.attachments.length > 0 ? (
            <span
              className="truncate text-ui-sm text-foreground-subtle"
              title={attachmentNames.join(", ")}
            >
              {attachmentNames.join(", ")}
            </span>
          ) : null}
        </span>
      </span>
      {onSendNow ? (
        <Button
          type="button"
          variant="secondary"
          size="default"
          data-icon="inline-start"
          data-testid={testId(TID_V4_QUEUE_ITEM_SEND_NOW, item.queueItemId)}
          data-queue-item-id={item.queueItemId}
          disabled={rowLocked}
          onClick={() =>
            runUserAction({
              input: {
                featureId: "conversation.queue.item",
                action: "send_now",
                trigger: "button",
              },
              operation: () => onSendNow(item.queueItemId),
              completed: { resultSource: "optimistic_projection" },
              failureStage: "queue_send_now",
            })
          }
        >
          <ArrowUpFromLine className="size-3.5" />
          {intl.formatMessage({ id: isCompact ? "chat.queue.runNow" : "chat.queue.sendNow" })}
        </Button>
      ) : null}
      {onEditItem && !isCompact ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_EDIT, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.edit" })}
            disabled={rowLocked}
            onClick={() => void onEditItem(item.queueItemId)}
          >
            <PencilIcon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onDeleteItem ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.remove" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_DELETE, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.remove" })}
            disabled={rowLocked}
            onClick={() => onDeleteItem(item.queueItemId)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
    </li>
  );
});

/**
 * 竖切 queue 面板：渲染 projection.queue.items + 单项删除入口。
 * queue 在运行中的 turn 期间存在（sendText 排队），是 CLI 投影权威态（非 renderer-local）。
 */
// 面板是竖切容器：把投影映射成行，并把用户意图翻译成 command 回调，除此之外不做决策
// 队列的增删改排序全部由 CLI 权威态决定，这里没有任何本地乐观改写
// onResume 对应 CLI 的 setAutoDrain(true)，busy 时立即消费还是仅武装由 CLI 判断，面板不猜
// 组件整体被 memo 包裹，接线处每次传新回调都会抵消优化，父级需保持引用稳定
function ConversationQueuePanelImpl({
  queue,
  onDeleteItem,
  onEditItem,
  pendingEditQueueItemId = null,
  onSendNow,
  onMoveItem,
  onResume,
}: ConversationQueuePanelProps) {
  const { intl } = useZCodeIntl();
  // [并发] resumePending 是纯本地互斥量，拦截双击与回车连发，不会写回投影
  // 它只在本实例内生效，多面板实例各自持锁，真正的幂等仍由 CLI 保证
  // PointerSensor 的 activation distance 设为 6，避免点击手柄上的图标被识别成拖拽
  // 距离调小会把点击变拖拽，调大则拖动明显迟滞，6 是触控与鼠标之间的折中
  const [resumePending, setResumePending] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const itemIds = useMemo(() => queue.items.map((item) => item.queueItemId), [queue.items]);
  // [并发] 依赖必须包含 queue.items：拖拽跨越多次投影时，旧闭包算出的锚点会指向已消费的项
  // over 为空表示拖到面板外或没有有效目标，直接放弃，不下发 reorder
  // 锚点解析失败同样静默返回，宁可本次拖拽无效，也不猜一个近似位置
  // onMoveItem 用可选调用兜底：未接线时拖拽本应已被 disabled 拦住，这是最后一道防线
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id;
      if (!overId) return;
      const anchor = resolveV4QueueReorderAnchor(
        queue.items,
        String(event.active.id),
        String(overId),
      );
      if (!anchor) return;
      onMoveItem?.(anchor.queueItemId, anchor.beforeQueueItemId);
    },
    [onMoveItem, queue.items],
  );
  // [事务] 成功口径是 authority_ack：只有 CLI 确认 setAutoDrain 生效才认为恢复完成
  // completed.resultSource 若写成乐观投影，失败也会记为成功，排障时数据全部失真
  // failureStage 固定为 queue_resume，便于按阶段聚合失败率，不要复用其它阶段名
  // finally 中必须复位 resumePending，包含 onResume 抛错路径，否则按钮永久禁用
  // guard 同时检查 onResume 与 resumePending：前者防止未接线时进入事务，后者防重入
  const handleResume = useCallback(async () => {
    if (!onResume || resumePending) return;
    setResumePending(true);
    try {
      await runUserActionAsync({
        input: { featureId: "conversation.queue.policy", action: "resume", trigger: "button" },
        operation: () => Promise.resolve(onResume()),
        completed: { resultSource: "authority_ack" },
        failureStage: "queue_resume",
      });
    } finally {
      setResumePending(false);
    }
  }, [onResume, resumePending]);

  // 空队列返回 null：composer 上方不保留占位条，否则会留下隐藏的磨砂层压住输入区
  // 早退必须放在全部 hook 之后，否则队列清空与新增之间 hooks 数量变化会直接报运行时错误
  // 暂停横幅只在有队列项时才有意义，空队列下 autoDrain 的取值不影响渲染结果
  // 面板根的 -mb-7 与 pb-7 以及 backdrop-blur 是贴合 composer 的视觉修正，删掉会出现双层底色缝
  if (queue.items.length === 0) return null;
  // 补回 v4 视觉迁移时漏掉的旧队列面板 blur 层，让列表保持贴合 composer 的磨砂背景。
  return (
    <div
      data-testid={TID_V4_QUEUE}
      data-queue-count={queue.items.length}
      data-queue-auto-drain={queue.autoDrain ? "true" : "false"}
      className={cn(
        "relative z-0 w-full overflow-hidden rounded-t-2xl border border-border bg-surface p-1 backdrop-blur-md",
        "-mb-7 pb-7",
      )}
    >
      {!queue.autoDrain ? (
        <div
          data-testid={TID_V4_QUEUE_PAUSED_BANNER}
          className="mb-1 flex min-h-10 items-center gap-3 rounded-xl border border-border/70 bg-surface-raised px-3 py-2 text-ui-base text-foreground"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({
              id:
                queue.pauseReason === "stopped"
                  ? "chat.queue.paused.stopped"
                  : queue.pauseReason === "error"
                    ? "chat.queue.paused.error"
                    : "chat.queue.paused.generic",
            })}
          </span>
          {onResume ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={TID_V4_QUEUE_RESUME}
              aria-label={intl.formatMessage({ id: "chat.queue.resume.description" })}
              disabled={resumePending}
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              onClick={() => void handleResume()}
            >
              {intl.formatMessage({ id: "chat.queue.resume" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictQueueDragToPanel]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5">
            {queue.items.map((item, index) => (
              <QueueRow
                key={item.queueItemId}
                item={item}
                index={index}
                intl={intl}
                sortable={Boolean(onMoveItem)}
                onDeleteItem={onDeleteItem}
                onEditItem={onEditItem}
                onSendNow={onSendNow}
                editPending={pendingEditQueueItemId === item.queueItemId}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

// 导出的是 memo 化组件，父级依赖引用稳定；不要在同一文件再导出一个未 memo 的别名
// memo 使用浅比较，queue 每次投影都是新引用，真正省下渲染的是行级 memo
// 若测试需要触达内部实现，另开独立导出，不要为了测试去掉这里的包裹
export const ConversationQueuePanel = memo(ConversationQueuePanelImpl);
