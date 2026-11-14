// INV-01 所有选择状态以 taskId 为键分区存放，drafts 与 dockStates 必须同键成对读取，禁止跨任务复用同一草稿
// INV-02 缺失任务一律回落到冻结的 EMPTY_DRAFT 与 DEFAULT_CONVERSATION_SHARE_DOCK_STATE，读取路径不得顺手写表
// INV-03 excludedRowIds 采用补集表示，只有出现在 availableRowIds 内的行才允许留在排除集合中
// INV-04 normalizeRowIds 必须先过滤非安全整数、再去重、最后升序，输出顺序即界面勾选顺序
// INV-05 选中行集合永远由 availableRowIds 减去 excludedRowIds 推导，不得再维护一份选中列表
// INV-06 productTurnIdByRowId 决定整轮选择的粒度，同一个 productTurnId 在多行出现时只输出一次
// INV-07 已确认范围读 excludedRowIds，待确认范围优先读 pendingExcludedRowIds，两者不得互相覆盖
// INV-08 syncAvailableTurns 在 draft 未 open 时直接返回原 state，弹层关闭期间不产生任何写入
// INV-09 分享范围变化必须让 disclosureAccepted 失效，比较对象是产品轮次集合而不是行集合
// INV-10 披露确认只由 syncAvailableTurns 的变化分支清除，其余动作一律不得触碰该字段
// INV-11 setAccessMode 只覆盖 accessMode，草稿其余字段必须原样保留，否则会清掉当前勾选
// INV-12 updateDockState 走浅合并补丁，未提供的字段沿用兜底插槽值，不允许整块重置
// INV-13 publishing 与 progress 由弹层动作推进，store 自身不推导进度也不自动翻转状态
// INV-14 error 与 warnings 是两类结果口径，阻断失败与部分跳过不得合并成同一个展示字段
// INV-15 publishedShareUrl 是唯一的发布成功凭据，为 null 即表示该任务尚未成功发布
// INV-16 attempt 持有幂等键，重试必须沿用同一 clientRequestId，重新生成会造成服务端重复发布
// INV-17 resetForTests 只清空两张状态表，不重建动作定义，生产代码禁止调用
// INV-18 弹层交互动作由 createConversationSharePopoverActions 注入，本文件不得再实现同名逻辑
//
// 模块职责：为每个任务的会话分享弹层保存选择草稿与发布插槽状态，并提供基于行与产品轮的选中集合推导
// 状态所有权：模块内单例 store 持有 drafts 与 dockStates 两张按 taskId 分区的表，其余均为纯函数读取与冻结兜底常量
// 阅读顺序：先看两个兜底常量与 getConversationShareDraft 确立读取口径，再看 normalizeRowIds 与两个选中推导函数，最后看 setAccessMode 与 syncAvailableTurns 的写入分支
import { createConversationSharePopoverActions } from "@/conversation-share-interaction/conversationSharePopoverActions.js";
// 四个导入分别提供动作工厂、状态容器、共享类型与服务端失败问题结构，缺任一项本文件都无法编译
// 动作工厂在本文件内被调用并展开，store 只负责数据所有权，交互编排留在 conversation-share-interaction
import { create } from "zustand";
import type { ConversationShareAccessMode, ConversationShareRejection } from "@zcode/shared";
import type { ConversationShareFailureIssue } from "@zcode/services";

// 默认访问模式是 public_importable，即链接可被他人导入，属于最宽松的一档授权
// 改错会让新建分享默认变成只读或私有，用户未在弹层显式选择时得到与预期相反的权限
export const DEFAULT_CONVERSATION_SHARE_ACCESS_MODE: ConversationShareAccessMode =
  "public_importable";

// attempt 是幂等重试凭据，key 与 clientRequestId 一旦生成就在整次发布流程内保持不变
// disclosureAcceptedAt 记录披露确认时刻，供审计与失败后是否需要重新确认时判定
export interface ConversationShareAttempt {
  key: string;
  clientRequestId: string;
  disclosureAcceptedAt: number;
}

// 展示错误同时保留 issues 明细与 issueCount 总数，omittedIssueCount 表示被截断未展示的条数
// requestId 与 operationId 只用于客服定位，缺失时界面仍须可用，不允许因缺字段整体不渲染
export interface ConversationShareDisplayError {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
  requestId?: string;
  clientRequestId?: string;
  operationId?: string;
  status?: number;
  code?: number;
  rejection?: ConversationShareRejection;
  /** 没有服务端 issues 时展示的、按错误类型解析出的可行动文案。 */
  messageId?: string;
}

/** 发布成功但有结果物被跳过时的非阻断提示。 */
export interface ConversationShareDisplayWarnings {
  issues: readonly ConversationShareFailureIssue[];
  issueCount: number;
  omittedIssueCount?: number;
}

export type ConversationShareProgressPhase = "collecting" | "uploading" | "checking";

// open 表示弹层是否展开，未 open 的草稿不接收轮次同步，也不会被写回状态表
// availableRowIds 与 excludedRowIds 共同表达选中集合，productTurnIdByRowId 提供行到产品轮的映射
export interface ConversationShareSelectionDraft {
  open?: boolean;
  pendingExcludedRowIds?: readonly number[] | null;
  availableRowIds: readonly number[];
  excludedRowIds: readonly number[];
  productTurnIdByRowId: Readonly<Record<number, string>>;
  accessMode: ConversationShareAccessMode;
}

// progress 只允许 collecting uploading checking 三态，取值推进由弹层动作负责而非本文件
// error 与 warnings 分别承载阻断失败与部分跳过，二者语义不同不可合流为一个字段
export interface ConversationShareDockState {
  title?: string;
  disclosureAccepted: boolean;
  publishing: boolean;
  progress: ConversationShareProgressPhase;
  completedArtifacts: number;
  totalArtifacts: number;
  publishedShareUrl: string | null;
  error: ConversationShareDisplayError | null;
  warnings: ConversationShareDisplayWarnings | null;
  attempt: ConversationShareAttempt | null;
}

// 接口把动作与两张状态表放在一起，调用方统一按 taskId 取用，不持有跨任务共享的可变引用
// resetForTests 仅供测试清场，生产代码调用会清空正在进行的发布状态并让弹层丢失进度
export interface ConversationShareSelectionState {
  openShare: (taskId: string) => void;
  closeShare: (taskId: string) => void;
  beginSelectionEdit: (taskId: string) => void;
  togglePendingRow: (taskId: string, rowId: number) => void;
  setAllPendingRowsSelected: (taskId: string, selected: boolean) => void;
  confirmSelectionEdit: (taskId: string) => void;
  cancelSelectionEdit: (taskId: string) => void;
  drafts: Record<string, ConversationShareSelectionDraft>;
  dockStates: Record<string, ConversationShareDockState>;
  setAccessMode: (taskId: string, accessMode: ConversationShareAccessMode) => void;
  syncAvailableTurns: (
    taskId: string,
    turns: readonly { rowId: number; productTurnId: string }[],
  ) => void;
  /** 按 product turn 身份整轮取消选择（阻断项的「取消选择该轮」入口）。 */
  deselectProductTurn: (taskId: string, productTurnId: string) => void;
  updateDockState: (taskId: string, patch: Partial<ConversationShareDockState>) => void;
  resetForTests: () => void;
}

// 空草稿用冻结对象做兜底，读取尚未初始化的任务时返回同一只读实例，避免每次新建对象
// 两个行数组都冻结为空数组，任何就地修改在严格模式下会直接抛错而不是静默污染兜底值
const EMPTY_DRAFT: ConversationShareSelectionDraft = Object.freeze({
  availableRowIds: Object.freeze([]),
  excludedRowIds: Object.freeze([]),
  productTurnIdByRowId: Object.freeze({}),
  accessMode: DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
});

// 默认插槽状态把每个字段显式写全，而不是依赖 undefined 兜底，消费方可以无条件取值
// publishing 为 false 且 progress 为 collecting，表示空闲且尚未开始任何上传
export const DEFAULT_CONVERSATION_SHARE_DOCK_STATE: ConversationShareDockState = Object.freeze({
  disclosureAccepted: false,
  publishing: false,
  progress: "collecting",
  completedArtifacts: 0,
  totalArtifacts: 0,
  publishedShareUrl: null,
  error: null,
  warnings: null,
  attempt: null,
});

// 先过滤非安全整数再去重最后升序，非法 rowId 在此处被拦下，不会进入排除集合或映射
// 排序让 availableRowIds 顺序稳定，改错会让勾选列表顺序随上游返回顺序抖动
function normalizeRowIds(rowIds: readonly number[]): number[] {
  return [...new Set(rowIds.filter(Number.isSafeInteger))].sort((left, right) => left - right);
}

// 读取一律用空值合并兜底到 EMPTY_DRAFT，缺失任务返回共享只读空草稿而不是 undefined
export function getConversationShareDraft(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): ConversationShareSelectionDraft {
  return state.drafts[taskId] ?? EMPTY_DRAFT;
}

export function getConversationShareDockState(
  state: Pick<ConversationShareSelectionState, "dockStates">,
  taskId: string,
): ConversationShareDockState {
  return state.dockStates[taskId] ?? DEFAULT_CONVERSATION_SHARE_DOCK_STATE;
}

// 选中行由 availableRowIds 减去 excludedRowIds 推导，不额外维护选中列表以免双写不一致
// [权衡] 每次调用重建一次排除集合，换来状态只有一份真相，行数在百级时开销可忽略
export function getConversationShareSelectedRowIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
): number[] {
  const draft = getConversationShareDraft(state, taskId);
  const excluded = new Set(draft.excludedRowIds);
  return draft.availableRowIds.filter((rowId) => !excluded.has(rowId));
}

// source 参数区分已确认范围与待确认范围，pending 分支优先读 pendingExcludedRowIds
// [失败路径] pendingExcludedRowIds 为 null 时回落到已确认的 excludedRowIds，避免编辑态丢失全部选择
// 同一 productTurnId 的多行只返回一次，seen 集合保证整轮选择的去重语义
export function getConversationShareSelectedProductTurnIds(
  state: Pick<ConversationShareSelectionState, "drafts">,
  taskId: string,
  source: "confirmed" | "pending" = "confirmed",
): string[] {
  const draft = getConversationShareDraft(state, taskId);
  const seen = new Set<string>();
  const excluded = new Set(
    source === "pending"
      ? (draft.pendingExcludedRowIds ?? draft.excludedRowIds)
      : draft.excludedRowIds,
  );
  return draft.availableRowIds
    .filter((rowId) => !excluded.has(rowId))
    .flatMap((rowId) => {
      const productTurnId = draft.productTurnIdByRowId[rowId];
      if (!productTurnId || seen.has(productTurnId)) return [];
      seen.add(productTurnId);
      return [productTurnId];
    });
}

// [资源] 仓库在模块加载期只创建一次，所有组件共享同一实例，重复创建会导致状态分裂
// 动作工厂的返回值先展开，再声明两张状态表，保证动作始终作用于本实例的 set
export const useConversationShareSelectionStore = create<ConversationShareSelectionState>()(
  (set) => ({
    ...createConversationSharePopoverActions(
      set,
      getConversationShareDraft,
      getConversationShareDockState,
      DEFAULT_CONVERSATION_SHARE_DOCK_STATE,
    ),
    drafts: {},
    dockStates: {},
    // 只覆盖 accessMode 一个字段，其余草稿字段靠展开保留，改错会把当前勾选一起清掉
    // [事务] 整个更新在一次 set 内完成，订阅方不会观察到只改了一半的中间态
    setAccessMode: (taskId, accessMode) =>
      set((state) => ({
        drafts: {
          ...state.drafts,
          [taskId]: {
            ...(state.drafts[taskId] ?? EMPTY_DRAFT),
            accessMode,
          },
        },
      })),
    // 未打开的草稿直接返回原 state，弹层关闭时后台轮次变化不写入任何东西
    // [并发] 同步始终基于回调内最新的 state 重算，不使用调用前读到的旧草稿快照
    // excludedRowIds 按新的 available 集合过滤，已经消失的轮次不会留下悬空排除项
    // [失败路径] 选中产品轮次集合变化时清除 disclosureAccepted，迫使调用方重新确认披露
    syncAvailableTurns: (taskId, turns) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (!current.open) return state;
        const productTurnIdByRowId = Object.fromEntries(
          turns.map((turn) => [turn.rowId, turn.productTurnId]),
        );
        const availableRowIds = normalizeRowIds(turns.map((turn) => turn.rowId));
        const available = new Set(availableRowIds);
        const nextDraft = {
          ...current,
          availableRowIds,
          excludedRowIds: current.excludedRowIds.filter((rowId) => available.has(rowId)),
          productTurnIdByRowId,
        };
        // 披露确认绑定有效分享范围；重开或运行轮次完成后新增内容，不能沿用旧确认。
        const before = new Set(getConversationShareSelectedProductTurnIds(state, taskId));
        const after = getConversationShareSelectedProductTurnIds(
          { drafts: { [taskId]: nextDraft } },
          taskId,
        );
        const changed = before.size !== after.length || after.some((id) => !before.has(id));
        return {
          drafts: { ...state.drafts, [taskId]: nextDraft },
          ...(changed
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: {
                    ...getConversationShareDockState(state, taskId),
                    disclosureAccepted: false,
                  },
                },
              }
            : {}),
        };
      }),
    // 补丁浅合并到兜底后的插槽状态上，未提供的字段保持原值，不会把进度与错误整块重置
    updateDockState: (taskId, patch) =>
      set((state) => ({
        dockStates: {
          ...state.dockStates,
          [taskId]: {
            ...getConversationShareDockState(state, taskId),
            ...patch,
          },
        },
      })),
    // 仅清空 drafts 与 dockStates 两张表，动作定义保留，测试之间不会互相污染
    // [资源] 清空用新的空对象引用替换，订阅方按引用比较能正确收到更新
    resetForTests: () =>
      set({
        drafts: {},
        dockStates: {},
      }),
  }),
);
