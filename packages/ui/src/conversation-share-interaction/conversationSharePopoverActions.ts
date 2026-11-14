// INV-01 编辑草稿与已确认范围必须是两份互不覆盖的状态：守住位置是各动作对 pendingExcludedRowIds 是否为空的判断；改错故障是取消编辑把试探性勾选写进已确认范围，发布范围被悄悄改动。
// INV-02 发布进行中时任何写入动作都必须原样返回旧状态：守住位置是八个动作开头的 publishing 守卫；改错故障是发布请求还在飞时改掉排除集，服务端收到的范围与界面展示不一致。
// INV-03 选择的最小单位是 product turn 而不是 query 行：守住位置是整轮切换与整轮取消按 productTurnIdByRowId 展开行；改错故障是同一轮只排除一半 query，分享摘要与真实发布内容错位。
// INV-04 排除集必须以升序数字数组落库：守住位置是三处设置排除集之后的排序；改错故障是同一集合因顺序不同被当成变更，触发多余的摘要重算与提示。
// INV-05 排除集为空表示全选，禁止用空集表达什么都没选：守住位置是确认动作拒绝全排除；改错故障是可以确认出零条内容的分享，下游发布拿到空范围。
// INV-06 面板未打开时不接受编辑类动作：守住位置是进入编辑与切换行对 open 与草稿为空的前置判断；改错故障是面板已关闭仍写入草稿，重开时出现幽灵勾选。
// INV-07 已发布链接存在时不允许再次进入编辑：守住位置是进入编辑对 publishedShareUrl 的拦截；改错故障是旧链接仍可访问而范围已被改动，读者看到与承诺不符的内容。
// INV-08 重新打开面板必须清空上一轮的失败与披露状态：守住位置是打开动作在重开分支重建 dock 状态；改错故障是旧错误提示挂在新一轮上，用户误以为本次发布失败。
// INV-09 重开时保留标题、其余 dock 字段回到默认：守住位置是重开分支用默认状态打底再单独回填 title；改错故障是标题被清空，用户每次重开都要重打标题。
// INV-10 关闭面板只能丢弃草稿，不能丢弃已确认范围：守住位置是关闭动作只清空草稿字段；改错故障是关一下面板就把用户之前的选择重置成全选。
// INV-11 所有写操作必须返回新对象或原状态二者之一，不得原地修改：守住位置是每个动作都以浅拷贝重建 drafts 与 dockStates；改错故障是原地改集合，订阅方拿不到新引用、界面不刷新。
// INV-12 只有范围真正变化时才重置披露与错误：守住位置是确认动作对 changed 的比较；改错故障是每次确认都清掉披露勾选，用户被迫反复确认同一件事。
// INV-13 确认写入前必须把已失效的行从排除集里剔除：守住位置是确认动作按可用行列表过滤草稿；改错故障是残留的旧行号让全选判断失真，分享漏掉或多出内容。
// INV-14 没有任何实际变化时必须返回原状态以避免无谓重渲染：守住位置是取消整轮的 changed 标记与确认动作的全排除早退；改错故障是空操作也产生新引用，列表持续抖动。
// INV-15 dockStates 的写入必须与其他任务的状态合并，不能整体替换：守住位置是各分支展开保留原 dockStates 后只覆盖当前 taskId；改错故障是多个任务同时分享时互相清空对方的面板状态。
// INV-16 本文件只做状态事务，不直接发起分享请求也不碰剪贴板：守住位置是动作体内不出现网络与剪贴板副作用；改错故障是把请求塞进状态更新里，重复渲染导致重复发布。
// INV-17 失败信息归 dock 层所有，本文件只负责清空它：守住位置是确认与取消路径把错误字段置空而不写入文案；改错故障是两处各写一份错误态，提示与实际请求结果对不上。
// INV-18 权限不足的降级只能体现在 dock 状态上，不能改动已确认范围：守住位置是权限相关字段只写在 dockStates 分支；改错故障是为了绕开权限去裁剪排除集，用户选择被静默篡改。
//
// 模块职责：把分享面板的打开、勾选、编辑、确认、关闭收敛成一组纯状态事务，真正的分享请求与剪贴板写入由面板组件承担。
// 状态所有权：草稿、已确认排除集与 dock 状态同属 conversationShareSelectionStore，本文件不持有第二份副本，也不缓存任何派生结果。
// 阅读顺序：先读文件头的 18 条不变量，再按打开、进入编辑、切换单行、批量勾选、确认、取消、关闭的顺序逐段对照源码。
import type {
  ConversationShareSelectionState,
  ConversationShareSelectionDraft,
  ConversationShareDockState,
} from "@/store/conversationShareSelectionStore.js";

/** 同一 store 的范围事务命令；只持有临时 UI 勾选，不产生第二份已确认分享状态。 */
export function createConversationSharePopoverActions(
  set: (
    updater: (
      state: ConversationShareSelectionState,
    ) => Partial<ConversationShareSelectionState> | ConversationShareSelectionState,
  ) => void,
  getConversationShareDraft: (
    state: ConversationShareSelectionState,
    taskId: string,
  ) => ConversationShareSelectionDraft,
  getConversationShareDockState: (
    state: ConversationShareSelectionState,
    taskId: string,
  ) => ConversationShareDockState,
  defaultDockState: ConversationShareDockState,
): Pick<
  ConversationShareSelectionState,
  | "deselectProductTurn"
  | "openShare"
  | "closeShare"
  | "beginSelectionEdit"
  | "togglePendingRow"
  | "setAllPendingRowsSelected"
  | "confirmSelectionEdit"
  | "cancelSelectionEdit"
> {
  return {
    /**
     * 按 product turn 身份整轮取消选择。
     *
     * Bug 根因：旧实现让 UI 用 service 的 turnOrdinal 去索引自己的 per-query 列表，
     * 两套编号在含系统上下文轮或多 steer query 的会话里必然错位；而且 toggleRow 只
     * 排除一行，同一轮的其他 query 仍留在选择里，阻断轮根本没被移除。
     * 「取消该轮」的语义是整轮，因此按 productTurnId 一次性排除全部行，且幂等。
     */
    // 这里是整轮取消的唯一入口：先确认面板已打开、轮次标识非空、且不在发布中，三者任一不成立就原样返回旧状态。
    // [并发] 发布进行中直接早退，因为服务端已按提交时的范围生成内容，此刻再改排除集只会造成界面与产物不一致。
    // 排除目标是整轮而非单行：遍历可用行、按 productTurnIdByRowId 命中同一轮的全部行一次性排除，避免同轮残留。
    // [事务] 编辑态写草稿字段，非编辑态写已确认字段，两条路径互斥，绝不互相覆盖。
    // 幂等要求：changed 为假说明该轮本就全部排除，此时必须返回原状态，否则会产生无意义的引用变化。
    // 非编辑态下撤销勾选等同于改变发布范围，因此顺带清空错误与披露标记，要求用户重新确认披露。
    deselectProductTurn: (taskId, productTurnId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (!current.open || !productTurnId || state.dockStates[taskId]?.publishing) return state;
        // 问题详情与列表共用同一范围事务：编辑时只改 pending，取消不能泄漏到 confirmed。
        const editing = current.pendingExcludedRowIds != null;
        const excluded = new Set(current.pendingExcludedRowIds ?? current.excludedRowIds);
        let changed = false;
        for (const rowId of current.availableRowIds) {
          if (current.productTurnIdByRowId[rowId] !== productTurnId || excluded.has(rowId)) {
            continue;
          }
          excluded.add(rowId);
          changed = true;
        }
        if (!changed) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              [editing ? "pendingExcludedRowIds" : "excludedRowIds"]: [...excluded].sort(
                (left, right) => left - right,
              ),
            },
          },
          ...(!editing
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: {
                    ...getConversationShareDockState(state, taskId),
                    disclosureAccepted: false,
                    error: null,
                  },
                },
              }
            : {}),
        };
      }),
    // 打开是幂等的：面板已开或发布中一律早退，避免重复点击把刚填好的标题与披露勾选重置掉。
    // [并发] 发布期间禁止重开，是因为发布结果回来时要回写 dock，此时重建状态会把回来的结果冲掉。
    // 上一轮留下已发布链接时视为新一轮：清空已确认排除集与整个 dock，但 title 例外地沿用，减少重复输入。
    // 草稿置空是本动作的关键副作用，保证打开后处于未编辑态，而不是带着上次残留的排除集进入编辑。
    // [权衡] openShare 清空排除集牺牲沿用上次选择的便利，换来新链接不继承旧范围这一可解释性。
    // 返回的新 drafts 必须逐任务合并，其他任务的面板状态不能被这次打开波及。
    openShare: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        const dock = getConversationShareDockState(state, taskId);
        if (dock.publishing || current.open) return state;
        // 成功结果只属于本次打开；新一轮必须清除 attempt，避免复用旧发布请求。
        const restart = Boolean(dock.publishedShareUrl);
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              ...(restart ? { excludedRowIds: [] } : {}),
              open: true,
              pendingExcludedRowIds: null,
            },
          },
          ...(restart
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: { ...defaultDockState, title: dock.title },
                },
              }
            : {}),
        };
      }),
    // 关闭只做两件事：把面板标记为已关并丢弃草稿，已确认的排除集原样保留。
    // [并发] 发布中不允许关闭，否则浮层消失而请求仍在飞，用户既看不到进度也收不到失败提示。
    // 丢弃草稿而不提交，是取消语义的兜底：即使调用方忘了先调取消编辑，关闭也不会把试探性勾选写进确认范围。
    // 这里刻意不动 dock 状态，错误与披露标记留到下次打开时由打开动作统一清理。
    closeShare: (taskId) =>
      set((state) => {
        if (state.dockStates[taskId]?.publishing) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...getConversationShareDraft(state, taskId),
              open: false,
              pendingExcludedRowIds: null,
            },
          },
        };
      }),
    // 进入编辑需同时满足四个条件：面板已打开、未在发布、没有已发布链接、当前不处于编辑态。
    // [权衡] 已发布链接存在时禁止再编辑，是因为链接内容已经对外可见，静默改范围会让读者与分享者的认知分裂。
    // 草稿从已确认排除集拷贝而来，之后所有勾选只改这份快照，确认之前不会触碰真正的发布范围。
    // 未打开面板就进入编辑会产生幽灵草稿，所以这里直接早退而不是隐式打开面板。
    beginSelectionEdit: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (
          !current.open ||
          state.dockStates[taskId]?.publishing ||
          state.dockStates[taskId]?.publishedShareUrl ||
          current.pendingExcludedRowIds != null
        )
          return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              pendingExcludedRowIds: [...current.excludedRowIds],
            },
          },
        };
      }),
    // 只在编辑态可用：草稿为空说明不在编辑，行标识不在可用列表说明该行已失效，两种情形都原样返回。
    // [并发] togglePendingRow 在 dock.publishing 时同样早退：以请求提交瞬间的排除集为准，避免勾选覆盖在途请求。
    // 目录按 query 呈现、发布按 product turn 生效，所以这里必须把单行点击翻译成整轮切换。
    // 方向由当前行是否已在排除集决定：在集合内表示反选，不在集合内表示选中，整轮的行共享同一方向。
    // 写回前排序，保证同一集合始终得到同一个数组形状，避免顺序差异被下游误判为范围变化。
    togglePendingRow: (taskId, rowId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (
          current.pendingExcludedRowIds == null ||
          !current.availableRowIds.includes(rowId) ||
          state.dockStates[taskId]?.publishing
        )
          return state;
        // 目录按 query 展示，发布按 product turn；同轮条目必须一起选择，避免摘要与实际发布范围不一致。
        const turnId = current.productTurnIdByRowId[rowId];
        const ids = turnId
          ? current.availableRowIds.filter((id) => current.productTurnIdByRowId[id] === turnId)
          : [rowId];
        const excluded = new Set(current.pendingExcludedRowIds);
        const remove = !excluded.has(rowId);
        for (const id of ids) {
          if (remove) excluded.add(id);
          else excluded.delete(id);
        }
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              pendingExcludedRowIds: [...excluded].sort((a, b) => a - b),
            },
          },
        };
      }),
    // 全选即排除集为空，全不选即把当前全部可用行写入排除集，一次赋值避免同轮多行被反复翻转。
    // 只在编辑态且非发布中生效，否则批量赋值会覆盖用户尚未提交的确认流程。
    // 只写草稿不写确认范围，提交仍由确认动作单独完成，保证一次编辑只有一次真正落定。
    setAllPendingRowsSelected: (taskId, selected) =>
      set((state) => {
        // 同一 product turn 可对应多条 query，批量赋值避免逐行 toggle 把同轮反复切回。
        const current = getConversationShareDraft(state, taskId);
        if (current.pendingExcludedRowIds == null || state.dockStates[taskId]?.publishing)
          return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              pendingExcludedRowIds: selected ? [] : [...current.availableRowIds],
            },
          },
        };
      }),
    // 取消只清空草稿，已确认范围与 dock 状态都保持不动，语义上等价于这次编辑从未发生。
    // 发布中禁止取消，避免用户以为撤销了范围而实际请求已按旧范围发出。
    // 这里不复位错误字段，因为取消不该抹掉上一次发布失败的原因说明。
    cancelSelectionEdit: (taskId) =>
      set((state) => {
        if (state.dockStates[taskId]?.publishing) return state;
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...getConversationShareDraft(state, taskId),
              pendingExcludedRowIds: null,
            },
          },
        };
      }),
    // 草稿为空说明不在编辑态，发布中说明范围已被请求锁定，两种情况都直接早退。
    // [事务] 落定前先按当前可用行过滤草稿，历史遗留的失效行标识会被剔除，避免排除集长期膨胀。
    // [失败路径] 全部可用行都被排除时拒绝确认：零条内容无法构成一次有意义的分享，宁可保持编辑态。
    // 只有排除集真的变化才重置披露与错误，用户重复确认同一范围时不会被要求再次勾选披露。
    // 成功后草稿置空、确认范围整体替换，两个写操作必须落在同一个返回对象里，中途失败不会留下半套状态。
    confirmSelectionEdit: (taskId) =>
      set((state) => {
        const current = getConversationShareDraft(state, taskId);
        if (current.pendingExcludedRowIds == null || state.dockStates[taskId]?.publishing)
          return state;
        const excluded = current.pendingExcludedRowIds.filter((id) =>
          current.availableRowIds.includes(id),
        );
        if (current.availableRowIds.every((id) => excluded.includes(id))) return state;
        const changed =
          excluded.length !== current.excludedRowIds.length ||
          excluded.some((id) => !current.excludedRowIds.includes(id));
        return {
          drafts: {
            ...state.drafts,
            [taskId]: {
              ...current,
              excludedRowIds: excluded,
              pendingExcludedRowIds: null,
            },
          },
          ...(changed
            ? {
                dockStates: {
                  ...state.dockStates,
                  [taskId]: {
                    ...getConversationShareDockState(state, taskId),
                    disclosureAccepted: false,
                    error: null,
                  },
                },
              }
            : {}),
        };
      }),
  };
}
