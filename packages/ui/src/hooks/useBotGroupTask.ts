// INV-01 工作区键优先使用规范化后的身份：守住位置 工作区键计算；改错故障 同一工作区出现两份状态。
// INV-02 每次刷新都有独立版本号：守住位置 版本号自增；改错故障 旧响应覆盖新结果。
// INV-03 版本不匹配的响应必须丢弃：守住位置 版本号比较；改错故障 快速切换任务时状态错位。
// INV-04 卸载后不得再写状态：守住位置 卸载标记；改错故障 卸载后触发更新警告。
// INV-05 任务为空时立即清空上下文：守住位置 任务标识判断；改错故障 残留上一条任务的群信息。
// INV-06 只在任务属于当前工作区且群内含该任务时匹配：守住位置 查找条件；改错故障 展示其他工作区的群。
// INV-07 工作区键按任务覆盖、群覆盖、默认的顺序回退：守住位置 空值合并链；改错故障 归属判断漏掉覆盖配置。
// INV-08 渠道优先取已接受来源：守住位置 输入首项读取；改错故障 已确认渠道被配置覆盖。
// INV-09 无已接受来源时回退到机器人配置：守住位置 配置拉取分支；改错故障 渠道名称显示为空。
// INV-10 渠道只接受飞书系提供方：守住位置 提供方判断；改错故障 其他提供方被错误标注。
// INV-11 订阅必须随卸载释放：守住位置 清理函数；改错故障 广播监听泄漏。
// INV-12 只响应群状态频道：守住位置 频道判断；改错故障 任意广播都触发刷新。
// INV-13 所有异步动作共用忙碌标识：守住位置 忙碌标识状态；改错故障 多个按钮同时可点。
// INV-14 重发与核对必须在同群同话题下才回填：守住位置 三重身份比较；改错故障 结果写入其他群。
// INV-15 回填只更新单条投递记录：守住位置 投递表展开；改错故障 整份群状态被替换。
// INV-16 重试话题材料必须携带任务与工作区信息：守住位置 请求入参；改错故障 服务端无法定位话题。
// INV-17 缺少服务能力时静默返回：守住位置 能力判断；改错故障 运行时抛错。
// INV-18 失败只记录日志，不向用户抛出：守住位置 捕获分支；改错故障 未捕获异常打断渲染。
//
// 模块职责：读取并同步单个任务的机器人群状态，提供重发、核对与话题材料重试动作。
// 状态所有权：上下文、渠道与忙碌标识由本 hook 持有；群状态事实来自机器人服务广播。
// 阅读顺序：先看工作区键与刷新，再读三个动作的守卫与回填，最后看返回值。
import { useCallback, useEffect, useState } from "react";
import { isFeishuBotProvider, type BotContextState, type FeishuBotProvider } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export function useBotGroupTask(
  taskId: string | null,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const { botsService, broadcastService } = useServices();
  const [context, setContext] = useState<BotContextState | null>(null);
  const [provider, setProvider] = useState<FeishuBotProvider>();
  const [busyId, setBusyId] = useState<string | null>(null);
  // workspaceKey 优先取 workspaceIdentity?.trim()，空串或缺失才退回 workspacePath；该键同时用于 refresh 里的
  // 归属匹配和 effect 依赖，因此只在身份缺失时才换值，避免同一工作区出现两份状态；
  // 这里已经 trim 过，下面 find 的相等比较不再二次去空白。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    // refresh 用闭包内的 revision 做请求代次：每次调用 requested = ++revision，await 回来后只要
    // disposed 或 revision !== requested 就直接 return，旧响应因此不能覆盖新任务的结果；
    // taskId 为空时先 setContext(null) 再返回，避免残留上一条任务的群信息；
    // find 同时要求 taskWorkspaces[taskId] 覆盖（或 state 自身身份/路径）等于 workspaceKey 且 taskIds 含 taskId。
    const refresh = async () => {
      const requested = ++revision;
      if (!taskId) {
        setContext(null);
        return;
      }
      try {
        const states = await botsService.getBotStates();
        if (disposed || revision !== requested) return;
        const nextContext =
          states.find(
            (state) =>
              (state.group?.taskWorkspaces?.[taskId]?.workspaceIdentity?.trim() ||
                state.group?.taskWorkspaces?.[taskId]?.workspacePath ||
                state.workspaceIdentity?.trim() ||
                state.workspacePath) === workspaceKey && state.group?.taskIds.includes(taskId),
          ) ?? null;
        setContext(nextContext);
        const savedProvider = Object.values(nextContext?.group?.inputs ?? {})[0]?.source.provider;
        setProvider(savedProvider);
        if (nextContext && !savedProvider) {
          // 首次准备还没有 accepted source，渠道名称取当前机器人配置，不默认猜作飞书。
          const config = await botsService.getConfig();
          if (disposed || revision !== requested) return;
          const configured = config.bots.find((bot) => bot.id === nextContext.botId)?.provider;
          setProvider(configured && isFeishuBotProvider(configured) ? configured : undefined);
        }
      } catch (error) {
        if (!disposed) logger.warn("读取群任务同步状态失败", { error: String(error) });
      }
    };
    setContext(null);
    setProvider(undefined);
    void refresh();
    const subscription = broadcastService.onMessage((message) => {
      if (message.channel === "bots:group-state") void refresh();
    });
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [botsService, broadcastService, taskId, workspaceKey]);
  // retry 先要求 context?.group 与 botsService.resendGroupResult 都存在，缺群信息或服务能力直接返回；
  // 请求带 botId/chatId/threadId/deliveryId，回填时再比较 current.botId、current.group.chatId、current.group.threadId
  // 三者和发起时一致，只把 deliveries[result.id] 合并进原 group，成功与否都在 finally 里 setBusyId(null)。
  const retry = useCallback(
    async (deliveryId: string) => {
      if (!context?.group || !botsService.resendGroupResult) return;
      setBusyId(deliveryId);
      try {
        const result = await botsService.resendGroupResult({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          deliveryId,
        });
        setContext((current) =>
          current?.group &&
          current.botId === context.botId &&
          current.group.chatId === context.group!.chatId &&
          current.group.threadId === context.group!.threadId
            ? {
                ...current,
                group: {
                  ...current.group,
                  deliveries: { ...current.group.deliveries, [result.id]: result },
                },
              }
            : current,
        );
      } catch (error) {
        logger.warn("重发群结果失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context],
  );
  // reconcile 与 retry 共用同一套守卫与身份回填：context?.group 与 botsService.reconcileGroupResult 缺一即返回，
  // received 原样传给服务；setContext 仍比较 botId/chatId/threadId，只合并 deliveries[result.id]，
  // 避免把整份群状态替换掉；失败只 logger.warn("核对群结果失败")。
  const reconcile = useCallback(
    async (deliveryId: string, received: boolean) => {
      if (!context?.group || !botsService.reconcileGroupResult) return;
      setBusyId(deliveryId);
      try {
        const result = await botsService.reconcileGroupResult({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          deliveryId,
          received,
        });
        setContext((current) =>
          current?.group &&
          current.botId === context.botId &&
          current.group.chatId === context.group!.chatId &&
          current.group.threadId === context.group!.threadId
            ? {
                ...current,
                group: {
                  ...current.group,
                  deliveries: { ...current.group.deliveries, [result.id]: result },
                },
              }
            : current,
        );
      } catch (error) {
        logger.warn("核对群结果失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context],
  );
  // retryPreparation 要求 context?.group?.threadId、taskId 与 botsService.retryTopicPreparation 全部就绪才发请求；
  // 入参同时带 botId/chatId/threadId/taskId/workspacePath/workspaceIdentity/messageId，服务端才能定位话题；
  // 成功后不改本地状态，失败只 logger.warn("重试话题材料失败")，finally 里按 messageId 清 busyId。
  const retryPreparation = useCallback(
    async (messageId: string) => {
      if (!context?.group?.threadId || !taskId || !botsService.retryTopicPreparation) return;
      setBusyId(messageId);
      try {
        await botsService.retryTopicPreparation({
          botId: context.botId,
          chatId: context.group.chatId,
          threadId: context.group.threadId,
          taskId,
          workspacePath,
          workspaceIdentity,
          messageId,
        });
      } catch (error) {
        logger.warn("重试话题材料失败", { error: String(error) });
      } finally {
        setBusyId(null);
      }
    },
    [botsService, context, taskId, workspacePath, workspaceIdentity],
  );
  return { context, provider, busyId, retry, reconcile, retryPreparation };
}
