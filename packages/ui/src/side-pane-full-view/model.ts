// INV-01 纯计算模块：守住位置 无 DOM 与存储访问；改错故障 几何计算被宿主副作用污染，无法单测。
// INV-02 入场状态固定：守住位置 surface 与 floating 初值；改错故障 首次进入停在错误形态。
// INV-03 宽高都由槽尺寸推导：守住位置 两处 Math.min/max；改错故障 小窗口下浮窗溢出或为负。
// INV-04 位置必须钳制：守住位置 clampFloatingPosition；改错故障 拖动后浮窗一半在槽外。
// INV-05 吸附坐标由锚点字符串推导：守住位置 includes 与 startsWith；改错故障 新增锚点无法定位。
// INV-06 默认吸附点属于集合：守住位置 DEFAULT_FLOATING_ANCHOR；改错故障 默认值解析失败返回 null。
// INV-07 缩放原点与吸附角一致：守住位置 resolveFloatingTransformOrigin；改错故障 展开动画从屏幕中心飞出。
// INV-08 最近吸附按静止坐标距离：守住位置 Math.hypot；改错故障 松手后吸到更远的角。
// INV-09 锚点解析收敛外部输入：守住位置 集合判断；改错故障 任意字符串被当成合法锚点。
// INV-10 首次看到 owner 建立基线：守住位置 seenTurnKey 为 undefined 分支；改错故障 已结束回合重复弹气泡。
// INV-11 同 turnKey 不重复弹：守住位置 turnKey 不等判断；改错故障 每次状态刷新都弹一次。
// INV-12 关闭气泡保留基线：守住位置 dismiss 只清 answer；改错故障 关闭后同一回答再次弹出。
// INV-13 离开浮窗清基线留气泡：守住位置 rebaseline 的映射；改错故障 回浮窗时旧回答又弹一遍。
// INV-14 预览只留纯文本：守住位置 正则链；改错故障 气泡里出现 markdown 标记或代码块。
//
// 模块职责：Side Pane 完整视图的纯模型，含浮窗几何、吸附与回答气泡状态推进。
// 阅读顺序：先看常量与三个类型，再看几何函数，最后看气泡归约、关闭与预览清洗。
// Side Pane 完整视图的纯模型：状态类型与浮窗几何。spec：docs/ui/side-pane-full-view.md
// 只做纯计算，不读写 DOM / 存储；宿主组件负责测量 slot 并把结果写成 CSS 变量。
import type {
  ConversationPaneFloatingStatus,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  SidePaneFullViewState,
} from "@/side-pane-full-view/contract.js";

// 进入完整视图的初始形态固定。
export const SIDE_PANE_FULL_VIEW_ENTER_STATE: SidePaneFullViewState = {
  surface: "side-pane",
  floating: "collapsed",
};

// `FLOATING_ANCHORS` 的七个吸附点是对外契约的一部分。
export const FLOATING_ANCHORS: readonly FloatingAnchor[] = [
  "top-left",
  "top-right",
  "left-center",
  "right-center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export const DEFAULT_FLOATING_ANCHOR: FloatingAnchor = "bottom-right";
export const FLOATING_MARGIN_PX = 16;
export const FLOATING_WIDTH_PX = 560;
export const FLOATING_EXPANDED_MAX_HEIGHT_PX = 640;
export const FLOATING_MINIMIZED_SIZE_PX = 48;
/** 指针移动不足该距离时，⠿ 与圆形按钮按点击处理。 */
// 位移小于阈值按点击处理，避免误拖。
export const FLOATING_DRAG_CLICK_THRESHOLD_PX = 4;

export interface FloatingRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FloatingSize {
  readonly width: number;
  readonly height: number;
}

export interface FloatingPosition {
  readonly left: number;
  readonly top: number;
}

// 宽度不超上限，也不小于 0。
export function resolveFloatingWidth(slotWidth: number): number {
  return Math.max(0, Math.min(FLOATING_WIDTH_PX, slotWidth - FLOATING_MARGIN_PX * 2));
}

export function resolveFloatingExpandedHeight(slotHeight: number): number {
  return Math.max(
    0,
    Math.min(FLOATING_EXPANDED_MAX_HEIGHT_PX, slotHeight - FLOATING_MARGIN_PX * 2),
  );
}

// 钳制保证浮窗整体落在槽内。
export function clampFloatingPosition(
  position: FloatingPosition,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingPosition {
  const maxLeft = slot.left + slot.width - size.width;
  const maxTop = slot.top + slot.height - size.height;
  return {
    left: Math.max(slot.left, Math.min(position.left, maxLeft)),
    top: Math.max(slot.top, Math.min(position.top, maxTop)),
  };
}

export function resolveFloatingPosition(
  anchor: FloatingAnchor,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingPosition {
  const m = FLOATING_MARGIN_PX;
  // 只看字符串前缀即可恢复水平与垂直分量。
  const horizontal = anchor.includes("left")
    ? "start"
    : anchor.includes("right")
      ? "end"
      : "center";
  const vertical = anchor.startsWith("top")
    ? "start"
    : anchor.startsWith("bottom")
      ? "end"
      : "center";
  const left =
    horizontal === "start"
      ? slot.left + m
      : horizontal === "end"
        ? slot.left + slot.width - m - size.width
        : slot.left + (slot.width - size.width) / 2;
  const top =
    vertical === "start"
      ? slot.top + m
      : vertical === "end"
        ? slot.top + slot.height - m - size.height
        : slot.top + (slot.height - size.height) / 2;
  return clampFloatingPosition({ left, top }, slot, size);
}

/**
 * 最小化与恢复之间切换的缩放原点：圆形按钮与浮窗贴在同一个吸附角上，
 * 从这个角缩放，看起来是从按钮展开 / 收回按钮。
 */
// `resolveFloatingTransformOrigin` 的缩放原点贴在同一个吸附角。
export function resolveFloatingTransformOrigin(anchor: FloatingAnchor): string {
  const x = anchor.includes("left") ? "left" : anchor.includes("right") ? "right" : "center";
  const y = anchor.startsWith("top") ? "top" : anchor.startsWith("bottom") ? "bottom" : "center";
  return `${x} ${y}`;
}

/** 松手时按「窗口当前位置与各吸附位置静止坐标」的距离选最近的吸附点。 */
export function resolveNearestFloatingAnchor(
  position: FloatingPosition,
  slot: FloatingRect,
  size: FloatingSize,
): FloatingAnchor {
  // 先以 `DEFAULT_FLOATING_ANCHOR` 兜底，再按 `Math.hypot` 距离取更近者。
  let best: FloatingAnchor = DEFAULT_FLOATING_ANCHOR;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of FLOATING_ANCHORS) {
    const resting = resolveFloatingPosition(anchor, slot, size);
    const distance = Math.hypot(resting.left - position.left, resting.top - position.top);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

// 外部输入必须收敛到集合内，否则返回 null。
export function parseFloatingAnchor(raw: unknown): FloatingAnchor | null {
  return typeof raw === "string" && (FLOATING_ANCHORS as readonly string[]).includes(raw)
    ? (raw as FloatingAnchor)
    : null;
}

/**
 * 回答气泡状态推进：第一次看到某 owner 时建立基线（已结束的回合算看过）；之后出现 turnKey 不同、
 * 已结束且有最终回答的回合就弹出并记为看过，新回答替换旧回答。
 * 修复原因：曾要求先看到「运行中」再看到结束才弹出；回放或很快的回答在一次渲染批次里就结束，
 * 界面从未处于运行中（E2E 采样 data-running 始终为 false），气泡永远不弹。
 */
export function reduceFloatingAnswerBubbles(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
  status: Pick<ConversationPaneFloatingStatus, "ownerKey" | "latestTurn">,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  const turn = status.latestTurn;
  // 没有回合键就没有可推进的状态。
  if (!turn?.turnKey) return bubbles;
  const current = bubbles.get(status.ownerKey) ?? { seenTurnKey: undefined, answer: null };
  let next = current;
  // 第一次看到 owner 时建立基线。
  if (current.seenTurnKey === undefined) {
    next = { ...current, seenTurnKey: turn.running ? null : turn.turnKey };
  } else if (!turn.running && turn.answer && turn.turnKey !== current.seenTurnKey) {
    next = { seenTurnKey: turn.turnKey, answer: turn.answer };
  }
  if (next === current) return bubbles;
  const updated = new Map(bubbles);
  updated.set(status.ownerKey, next);
  return updated;
}

/** 点 × 或点气泡：清除该 owner 的气泡，基线不变。 */
export function dismissFloatingAnswerBubble(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
  ownerKey: string,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  const current = bubbles.get(ownerKey);
  // 没有气泡可关时返回原引用。
  if (!current?.answer) return bubbles;
  const updated = new Map(bubbles);
  updated.set(ownerKey, { ...current, answer: null });
  return updated;
}

/**
 * 离开浮窗形态时清空所有基线（保留已弹出的气泡）：回到浮窗时重新建立，
 * 在对话 tab 里已经看过的回答不会再弹出。
 */
export function rebaselineFloatingAnswerBubbles(
  bubbles: ReadonlyMap<string, FloatingAnswerBubbleState>,
): ReadonlyMap<string, FloatingAnswerBubbleState> {
  if (![...bubbles.values()].some((bubble) => bubble.seenTurnKey !== undefined)) return bubbles;
  // 只清 `seenTurnKey` 基线，已经弹出的回答保留。
  return new Map([...bubbles].map(([key, bubble]) => [key, { ...bubble, seenTurnKey: undefined }]));
}

/** 气泡里只放纯文本：去掉 markdown 的代码块、链接、标题、列表与强调标记，合并空白。 */
export function resolveFloatingAnswerPreview(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      // 下划线不当作强调：回答里常有 snake_case 等代码标识符。
      .replace(/(\*\*|~~|\*)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim()
  );
}
