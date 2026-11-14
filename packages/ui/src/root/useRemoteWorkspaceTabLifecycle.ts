// 远程工作区 Tab 生命周期编排：把 tab 增删与 remote session 释放、路径/身份映射绑定解耦
// 三处 effect 分别负责关闭回收、用户主动关闭事件、active tab 映射刷新，声明顺序即副作用顺序
// 本文件不持有 UI 状态，只维护跨渲染 ref 记忆与平台侧 session 资源
// INV-01 身份 key 一律取 workspaceIdentity 去空白后优先、workspacePath 兜底；守住位置：remoteWorkspaceKey 的空值判定；改错故障：本地 tab 被误当远程 tab 而释放 session
// INV-02 三个远程字段全空才返回 null，任一存在都必须产出 key；守住位置：remoteWorkspaceKey 的前置守卫；改错故障：断连中的 tab 丢失 key，session 永久泄漏
// INV-03 关闭判定以 key 不在 next 集合为准，而非 tab id 消失；守住位置：collectClosedRemoteWorkspaceKeys 主循环；改错故障：仅改身份的 tab 被提前回收
// INV-04 sameTab 存活时即便 key 变化也不记为关闭；守住位置：collectClosedRemoteWorkspaceKeys 的 continue 分支；改错故障：切 workspaceIdentity 即触发释放，连接被掐断
// INV-05 rekeyedTab 用 previousWorkspaceIdentity 认领旧 key，避免改身份被误判关闭；守住位置：rekeyedTab 查找；改错故障：身份迁移后旧 session 泄漏到重连
// INV-06 关闭 key 结果去重且顺序稳定，供下游回调与记忆删除共用一份；守住位置：closedRemoteWorkspaceKeys 的 Set 收集；改错故障：同一 key 回调两次，上层重复释放
// INV-07 只有 previous 中未带 remoteSessionId 的 session 才走记忆补偿路径；守住位置：collectClosedRemoteWorkspaceSessionIds 的过滤；改错故障：与正常移除流程重复 dispose 同一 session
// INV-08 记忆补偿结果顺序跟随关闭 key 顺序，不另行排序；守住位置：collectClosedRemoteWorkspaceSessionIds 的 flatMap；改错故障：并发释放顺序抖动，日志无法对齐
// INV-09 ref 记忆跨渲染存活但不参与渲染，写入只发生在 effect 内；守住位置：三个 useRef；改错故障：渲染期写 ref 造成撕裂或重复释放
// INV-10 previous 快照必须过滤 isWorkspaceTab，避免非工作区 tab 污染 key 计算；守住位置：effect 开头的 previousWorkspaceTabs 构造；改错故障：普通 tab 被当远程 tab，误释放 session
// INV-11 无 tabStoreApi 时关闭回调必须同步触发并同步清记忆；守住位置：closedRemoteWorkspaceKeys.length 分支；改错故障：旧调用方收不到通知，记忆残留指向已死 session
// INV-12 记忆写入晚于关闭处理，保证本轮已关闭的 key 不会被写回；守住位置：nextWorkspaceTabs 写入 remembered 的循环；改错故障：刚释放的 key 残留映射，下次误绑
// INV-13 每个 session 至多被本 effect 释放一次，靠 disposedSessionIds 去重；守住位置：disposedSessionIds 的 continue 分支；改错故障：同一 session 并发释放，远端侧报未知会话
// INV-14 释放失败只降级为 warn，注销放 finally 保证本地注册表不残留；守住位置：disposeRemoteSession 的 try/catch/finally；改错故障：平台异常导致注册表泄漏并阻塞后续连接
// INV-15 提供 tabStoreApi 时，显式关闭 key 未命中则跳过释放，交由事件通道处理；守住位置：explicitlyClosedWorkspaceKeysRef 的守卫；改错故障：Store 侧与 hook 侧双重释放
// INV-16 第一处 effect 末尾必须让 next 快照与显式关闭集合同时归位；守住位置：effect 尾部的赋值与 clear；改错故障：下一轮以旧基线 diff，关闭事件丢失
// INV-17 订阅侧用 sequence 单调递增去重，防止重放事件重复通知；守住位置：lastSequence 比较；改错故障：同一关闭事件回调多次，tab 被重复回收
// INV-18 仅 origin 为 user-close 的事件写入显式关闭集合；守住位置：subscribe 回调的 origin 判断；改错故障：程序化关闭被误认作用户意图
// INV-19 active tab 变化后必须刷新 path 与 identity 两条映射，不能只绑一次；守住位置：末尾 effect 的绑定调用；改错故障：workspace 级 RPC 仍命中旧 session
import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  unbindRemoteWorkspaceIdentity,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import {
  isWorkspaceTab,
  type TabStoreState,
  type WindowTabState,
  type WorkspaceTabState,
} from "@/store/tabStore.js";

// [不变量] 空字符串身份视同缺失，trim 后为空即不计入远程判定
// [权衡] 身份 key 优先于路径，是为了让同路径的双远程 tab 各自独立
// [失败路径] 三个字段全空返回 null，调用方必须自行跳过而不是拼空串
// [不变量] 返回值只做比较与 Map 键，不参与持久化
// [失败路径] 身份为纯空白而路径存在时回落路径，避免空 key 覆盖 Map 条目
// [并发] 纯函数无状态，同一 tab 多次调用结果一致，可作为 diff 两侧的公共口径
function remoteWorkspaceKey(tab: WorkspaceTabState): string | null {
  if (
    !tab.workspaceIdentity?.trim() &&
    !tab.remoteSessionId &&
    !tab.remoteTarget
  ) {
    return null;
  }

  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

// [不变量] 入参是两次渲染的 tab 快照，函数只读不写，可安全重放
// [权衡] 先用 Set 建 next 侧 key 索引，把双循环查找压到近似线性
// [失败路径] previous 中无 key 的 tab 直接跳过，不产生关闭信号
// [不变量] 逐个 previous tab 求 key，与 next 侧索引比较得出关闭集合
// [失败路径] sameTab 存在的 tab 即便 key 消失也算存活，避免身份切换误判
// [失败路径] rekeyedTab 命中说明是改身份而非关闭，必须排除
// [设计] 关闭集合用 Set 累积再展开成数组，天然去重
// [并发] 结果顺序依赖 previous 遍历顺序，调用方不应依赖具体次序
export function collectClosedRemoteWorkspaceKeys(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
): string[] {
  const nextRemoteWorkspaceKeys = new Set(
    nextWorkspaceTabs.flatMap((tab) => {
      const workspaceKey = remoteWorkspaceKey(tab);
      return workspaceKey ? [workspaceKey] : [];
    }),
  );
  const closedRemoteWorkspaceKeys = new Set<string>();

  for (const previousTab of previousWorkspaceTabs) {
    const workspaceKey = remoteWorkspaceKey(previousTab);
    const sameTab = nextWorkspaceTabs.find((tab) => tab.id === previousTab.id);
    const rekeyedTab = nextWorkspaceTabs.find(
      (tab) => tab.previousWorkspaceIdentity?.trim() === workspaceKey,
    );
    if (
      !workspaceKey ||
      nextRemoteWorkspaceKeys.has(workspaceKey) ||
      Boolean(sameTab) ||
      Boolean(rekeyedTab)
    ) {
      continue;
    }
    closedRemoteWorkspaceKeys.add(workspaceKey);
  }

  return [...closedRemoteWorkspaceKeys];
}

// [不变量] 先算出 previous 侧仍存活的 session 集合，用于判断是否已被正规路径覆盖
// [设计] 关闭 key 到 session 的映射来自 remembered 表，而不是当前 tab 字段
// [失败路径] 记忆表无该 key 时返回空数组，跳过补偿释放
// [失败路径] session 仍在 previous 存活集合中时跳过，防止与正常移除流程重复
// [生命周期] 返回的 session 属于先断连后关 tab，只能由本函数驱动的补偿路径释放
// [并发] flatMap 保留 key 顺序，便于日志按 workspace 对齐
// [权衡] 不复用 previous tab 上的 remoteSessionId，是因为断连已把它清空
// [不变量] 函数无副作用，只读记忆表，可在任意渲染中调用
export function collectClosedRemoteWorkspaceSessionIds(
  previousWorkspaceTabs: WorkspaceTabState[],
  nextWorkspaceTabs: WorkspaceTabState[],
  rememberedSessionIdsByWorkspaceKey: ReadonlyMap<string, string>,
): string[] {
  const previousLiveSessionIds = new Set(
    previousWorkspaceTabs
      .map((tab) => tab.remoteSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );

  return collectClosedRemoteWorkspaceKeys(
    previousWorkspaceTabs,
    nextWorkspaceTabs,
  ).flatMap((workspaceKey) => {
      const sessionId = rememberedSessionIdsByWorkspaceKey.get(workspaceKey);
      // 仍带 remoteSessionId 的 tab 会由本 hook 下方的正常移除流程释放，
      // 这里只补释放“先断连、后清掉 tab 字段”的 session，避免重复 dispose。
    return sessionId && !previousLiveSessionIds.has(sessionId)
      ? [sessionId]
      : [];
  });
}

// [设计] 入参按能力注入：tab 列表、当前 tab、平台服务、关闭回调、可选 store 事件源
// [不变量] tabs 是渲染快照，hook 只依赖它做 diff，不反向写入 tab 状态
// [设计] tabStoreApi 可选，缺失时退化为纯 diff 模式，兼容旧调用方
// [生命周期] onRemoteWorkspaceTabsClosed 由调用方决定回收语义，hook 只负责通知
// [权衡] platform 走接口注入而非模块导入，保证桌面与 Web 实现可替换
// [不变量] 三个 ref 分别记忆上一轮快照、key 到 session 映射、显式关闭 key
// [并发] ref 初值只在首次挂载时构造，重渲染不重建 Map 与 Set
export function useRemoteWorkspaceTabLifecycle({
  tabs,
  activeWorkspaceTab,
  platform,
  onRemoteWorkspaceTabsClosed,
  tabStoreApi,
}: {
  tabs: WindowTabState[];
  activeWorkspaceTab: WorkspaceTabState | null;
  platform: IPlatformService;
  onRemoteWorkspaceTabsClosed?: (workspaceKeys: string[]) => void;
  tabStoreApi?: {
    subscribe(
      listener: (state: {
        lastClosedWorkspaceEvent: TabStoreState["lastClosedWorkspaceEvent"];
      }) => void,
    ): () => void;
  };
}) {
  const previousWorkspaceTabsRef = useRef<WindowTabState[]>([]);
  const rememberedSessionIdsByWorkspaceKeyRef = useRef<Map<string, string>>(
    new Map(),
  );
  const explicitlyClosedWorkspaceKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const previousWorkspaceTabs =
      previousWorkspaceTabsRef.current.filter(isWorkspaceTab);
    const nextWorkspaceTabs = tabs.filter(isWorkspaceTab);
    // [不变量] 每轮 effect 先取上一轮快照并过滤工作区 tab，再取当前快照
    // [设计] 关闭 key 与关闭 session 拆成两个纯函数计算，便于单测覆盖
    // [失败路径] 回调缺失时仍要清记忆表，否则残留映射指向已释放 session
    // [生命周期] 记忆刷新循环遍历 next 快照，逐 tab 覆盖为当前 sessionId
    // [失败路径] 缺 remoteSessionId 的 tab 不写记忆，避免空值抹掉可补偿的旧 session
    // [并发] 关闭回调同步执行，避免调用方在异步窗口内读到不一致的 tab 列表
    // [权衡] 无 store 事件源时由 diff 承担全部关闭语义，有事件源时两者互补
    const closedRemoteWorkspaceKeys = collectClosedRemoteWorkspaceKeys(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
    );
    const closedRemoteSessionIds = collectClosedRemoteWorkspaceSessionIds(
      previousWorkspaceTabs,
      nextWorkspaceTabs,
      rememberedSessionIdsByWorkspaceKeyRef.current,
    );
    if (!tabStoreApi && closedRemoteWorkspaceKeys.length > 0) {
      onRemoteWorkspaceTabsClosed?.(closedRemoteWorkspaceKeys);
      for (const workspaceKey of closedRemoteWorkspaceKeys) {
        rememberedSessionIdsByWorkspaceKeyRef.current.delete(workspaceKey);
      }
    }
    for (const tab of nextWorkspaceTabs) {
      const workspaceKey = remoteWorkspaceKey(tab);
      if (workspaceKey && tab.remoteSessionId) {
        rememberedSessionIdsByWorkspaceKeyRef.current.set(
          workspaceKey,
          tab.remoteSessionId,
        );
      }
    }

    for (const sessionId of closedRemoteSessionIds) {
      if (
        tabStoreApi &&
        ![...explicitlyClosedWorkspaceKeysRef.current].some(
          (workspaceKey) =>
            rememberedSessionIdsByWorkspaceKeyRef.current.get(workspaceKey) ===
            sessionId,
        )
      ) {
        continue;
      }
      void (async () => {
        try {
          // 断连事件会先清掉 tab 上的 remoteSessionId，导致下方正常移除流程
          // 无法释放该 session。这里使用记忆的 sessionId 补齐“断连后再关闭 tab”的清理路径。
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放断连远程 session 失败:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    const nextRemoteSessionIds = new Set(
      nextWorkspaceTabs
        .map((tab) => tab.remoteSessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    );

    for (const previousTab of previousWorkspaceTabs) {
      const stillExists = nextWorkspaceTabs.some(
        (nextTab) => nextTab.id === previousTab.id,
      );
      if (stillExists) {
        continue;
      }

      if (!previousTab.remoteSessionId) {
        continue;
      }

      const survivingRemoteTab = nextWorkspaceTabs.find((nextTab) => {
        if (!nextTab.remoteSessionId) {
          return false;
        }

        if (previousTab.workspaceIdentity && nextTab.workspaceIdentity) {
          return nextTab.workspaceIdentity === previousTab.workspaceIdentity;
        }

        return nextTab.workspacePath === previousTab.workspacePath;
      });

      if (survivingRemoteTab?.remoteSessionId) {
        // 之前只按 workspacePath 维护映射，关闭同路径 remote tab 时会把另一个远端 tab 一起“解绑”。
        // 这里优先复用幸存 tab 的绑定，并同步刷新 workspaceIdentity 映射，避免后续 RPC 命中错误 session。
        bindRemoteWorkspacePath(
          survivingRemoteTab.workspacePath,
          survivingRemoteTab.remoteSessionId,
        );
        if (survivingRemoteTab.workspaceIdentity) {
          bindRemoteWorkspaceIdentity(
            survivingRemoteTab.workspaceIdentity,
            survivingRemoteTab.remoteSessionId,
          );
        }
      } else {
        unbindRemoteWorkspacePath(previousTab.workspacePath);
        if (previousTab.workspaceIdentity) {
          unbindRemoteWorkspaceIdentity(previousTab.workspaceIdentity);
        }
      }
    }

    // [不变量] 释放循环只看 previous 快照，逐个 session 判断是否已不在 next 中
    // [失败路径] next 仍引用该 session 时跳过，说明只是 tab 迁移而非关闭
    // [并发] 同一 session 被多个 tab 共享时由集合去重，只释放一次
    // [失败路径] 有 store 事件源且 key 未标记显式关闭时跳过，交由事件通道收尾
    // [生命周期] 释放走异步任务，先落日志再调用平台，失败只降级告警
    // [生命周期] finally 中注销本地 session 注册，保证异常路径也不残留
    // [权衡] 不等待异步释放完成，避免阻塞 effect 与后续渲染
    const disposedSessionIds = new Set<string>();
    for (const previousTab of previousWorkspaceTabs) {
      const sessionId = previousTab.remoteSessionId;
      if (
        !sessionId ||
        nextRemoteSessionIds.has(sessionId) ||
        disposedSessionIds.has(sessionId)
      ) {
        continue;
      }
      if (
        tabStoreApi &&
        !explicitlyClosedWorkspaceKeysRef.current.has(
          remoteWorkspaceKey(previousTab) ?? "",
        )
      ) {
        continue;
      }

      disposedSessionIds.add(sessionId);
      const workspacePath = previousTab.workspacePath;
      void (async () => {
        try {
          logger.info(
            "[Root] remote workspace tab 已移除，主动释放远程 session",
            {
            workspacePath,
            workspaceIdentity: previousTab.workspaceIdentity,
            sessionId,
            },
          );
          await platform.disposeRemoteSession(sessionId);
        } catch (error) {
          logger.warn("[Root] 释放远程 session 失败:", {
            sessionId,
            error,
          });
        } finally {
          unregisterRemoteWorkspaceSession(sessionId);
        }
      })();
    }

    previousWorkspaceTabsRef.current = nextWorkspaceTabs;
    explicitlyClosedWorkspaceKeysRef.current.clear();
  // [并发] 依赖含 tabs 与两个注入项，任一变化都会重跑 diff，必须靠 ref 保持基线
  // [失败路径] platform 引用不稳会导致重复释放，故调用方需保证其稳定
  // [设计] 回调入依赖是为了拿到最新闭包，避免 stale closure 持有旧上层状态
  // [权衡] 把 ref 基线放在依赖之外，换来跨轮记忆但要求末尾必须回写
  }, [onRemoteWorkspaceTabsClosed, platform, tabStoreApi, tabs]);

  useEffect(() => {
    if (!tabStoreApi || !onRemoteWorkspaceTabsClosed) return;
    // [不变量] sequence 单调递增，仅严格大于才处理，天然幂等
    // [失败路径] 事件缺失或序号回退时直接返回，不清空显式关闭集合
    // [生命周期] 订阅在 effect 清理函数中取消，防止卸载后继续回调
    let lastSequence = 0;
    return tabStoreApi.subscribe((state) => {
      const event = state.lastClosedWorkspaceEvent;
      if (!event || event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      if (event.origin === "user-close") {
        explicitlyClosedWorkspaceKeysRef.current.add(event.workspaceKey);
        onRemoteWorkspaceTabsClosed([event.workspaceKey]);
      }
    });
  }, [onRemoteWorkspaceTabsClosed, tabStoreApi]);

  useEffect(() => {
    // [不变量] 没有 session 的 active tab 不参与映射，直接返回
    // [设计] 路径与身份两条映射同时刷新，保证按路径与按身份解析都命中当前 tab
    // [失败路径] 身份为空时只绑路径，避免空字符串作为键污染映射
    // [权衡] 依赖收窄到三个字段，减少无关渲染触发的重复绑定
    if (!activeWorkspaceTab?.remoteSessionId) {
      return;
    }

    // 同一路径的多个 remote tab 之间切换时，不能只在建连时绑定一次路径映射，
    // 否则切换后映射仍停留在旧 tab，按 workspacePath 解析服务的 hook 仍可能命中旧 session。
    // 这里在 active tab 切换后把路径与 workspaceIdentity 映射刷新到当前 tab，保证 workspace 级 RPC 跟着当前 tab 走。
    bindRemoteWorkspacePath(
      activeWorkspaceTab.workspacePath,
      activeWorkspaceTab.remoteSessionId,
    );
    if (activeWorkspaceTab.workspaceIdentity) {
      bindRemoteWorkspaceIdentity(
        activeWorkspaceTab.workspaceIdentity,
        activeWorkspaceTab.remoteSessionId,
      );
    }
  }, [
    activeWorkspaceTab?.remoteSessionId,
    activeWorkspaceTab?.workspaceIdentity,
    activeWorkspaceTab?.workspacePath,
  ]);
}
