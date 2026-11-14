// INV-01 无归属者即无绑定群：守住位置 空值早退；改错故障 展示其他账号的群。
// INV-02 只取当前机器人与归属匹配：守住位置 过滤条件；改错故障 群列表串到别的机器人。
// INV-03 主题状态不单独成行：守住位置 线程过滤；改错故障 一个群出现多条。
// INV-04 主题数按群聚合去重：守住位置 集合统计；改错故障 重复主题被计两次。
// INV-05 读取带代次防迟到覆盖：守住位置 自增版本比较；改错故障 旧响应覆盖新结果。
// INV-06 卸载后不再写状态：守住位置 存活标记；改错故障 卸载后写状态触发告警。
// INV-07 重新加载先清错误：守住位置 错误重置；改错故障 旧错误一直挂着。
// INV-08 失败只在最新请求生效：守住位置 双重判断；改错故障 迟到失败覆盖新读取。
// INV-09 订阅频道过滤单一：守住位置 频道比较；改错故障 无关广播触发重读。
// INV-10 清理时递增代次：守住位置 卸载分支；改错故障 在途响应写入已卸载组件。
// INV-11 保存禁止并发：守住位置 保存在途标记；改错故障 连点产生交错写入。
// INV-12 机器人未启用不保存：守住位置 启用判断；改错故障 停用机器人仍改授权。
// INV-13 能力缺失不保存：守住位置 方法存在性检查；改错故障 旧宿主直接抛错。
// INV-14 保存后读权威状态：守住位置 重新读取；改错故障 界面显示未生效的开关。
// INV-15 授权未变即报错：守住位置 实际值比较；改错故障 静默假装成功。
// INV-16 保存失败不阻塞后续：守住位置 收尾释放；改错故障 一次失败永久锁死。
// INV-17 行列表按依赖缓存：守住位置 记忆化；改错故障 每次渲染重算整表。
// INV-18 能力标志直接暴露：守住位置 返回对象；改错故障 调用方自行猜测支持性。
//
// 模块职责：读取并切换机器人已绑定的群聊，并把状态投影为设置页行。
// 状态所有权：群状态真值在服务端，本 hook 只持有最近一次读取与进行中标记。
// 阅读顺序：先看投影规则，再看读取与订阅，最后看保存与返回。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BotConfig, BotState } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

// BoundGroupRow 一行对应一个已绑定群聊。
// topicCount 是投影出来的派生值，不写回 BotState。
// enabled 直接取 group.enabled，不另存副本。
export interface BoundGroupRow {
  chatId: string;
  name: string;
  enabled: boolean;
  topicCount: number;
}

// 没有 ownerId 时 projectBoundGroups 直接返回空数组。
// 带 threadId 的主题行被 filter 掉，只计入 topicCount。
// topicCount 用 Set 按 threadId 去重，空 threadId 先过滤。
export function projectBoundGroups(
  states: BotState[],
  botId: string,
  ownerId?: string,
): BoundGroupRow[] {
  if (!ownerId) return [];
  const groups = states.filter(
    (state) => state.botId === botId && state.group?.ownerId === ownerId,
  );
  return groups
    .filter((state) => !state.group!.threadId)
    .map(({ group }) => ({
      chatId: group!.chatId,
      name: group!.name,
      enabled: group!.enabled,
      topicCount: new Set(
        groups
          .filter((state) => state.group!.chatId === group!.chatId)
          .map((state) => state.group!.threadId)
          .filter(Boolean),
      ).size,
    }));
}

// refresh 自增 revision，读取与保存共用同一代次。
// broadcastService 收到 bots:group-state 只触发 reload，不改本地状态。
// alive.current 为假时 setStates 与 setLoading 全部跳过。
export function useBotBoundGroups(bot: BotConfig) {
  const { botsService, broadcastService } = useServices();
  const [states, setStates] = useState<BotState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const alive = useRef(false);
  const revision = useRef(0);
  const savingRef = useRef(false);
  const refresh = useCallback(async () => {
    const requested = ++revision.current;
    const next = await botsService.getBotStates();
    if (alive.current && requested === revision.current) {
      setStates(next);
      setLoading(false);
    }
    return next;
  }, [botsService]);
  const reload = useCallback(async () => {
    const requested = revision.current + 1;
    setError(null);
    try {
      await refresh();
    } catch (cause) {
      // 迟到的失败不能覆盖广播触发的新读取结果。
      if (!alive.current || requested !== revision.current) return;
      logger.warn("读取已绑定群聊失败", { error: String(cause) });
      setError("load");
      setLoading(false);
    }
  }, [refresh]);
  useEffect(() => {
    alive.current = true;
    void reload();
    const subscription = broadcastService.onMessage((message) => {
      if (message.channel === "bots:group-state") void reload();
    });
    return () => {
      alive.current = false;
      ++revision.current;
      subscription.dispose();
    };
  }, [broadcastService, reload]);
  // savingRef.current 为真时 toggle 直接返回，忽略重复点击。
  // setGroupEnabled 成功后再 await refresh() 读一次权威状态。
  // 保存后 enabled 未变即 throw，视为授权未生效。
  const toggle = useCallback(
    async (chatId: string, enabled: boolean) => {
      if (savingRef.current || !bot.enabled || !botsService.setGroupEnabled) return;
      savingRef.current = true;
      setSaving(chatId);
      setError(null);
      try {
        await botsService.setGroupEnabled({ botId: bot.id, chatId, enabled });
        const next = await refresh();
        // 旧接口可能返回成功但未改变授权，必须读取权威状态再确认。
        const actual = projectBoundGroups(next, bot.id, bot.providerUserId).find(
          (row) => row.chatId === chatId,
        );
        if (actual?.enabled !== enabled) throw new Error("Group authorization was not updated");
      } catch (cause) {
        if (alive.current) {
          logger.warn("保存群聊开关失败", { error: String(cause) });
          setError("save");
        }
      } finally {
        savingRef.current = false;
        if (alive.current) setSaving(null);
      }
    },
    [bot.enabled, bot.id, bot.providerUserId, botsService, refresh],
  );
  const rows = useMemo(
    () => projectBoundGroups(states, bot.id, bot.providerUserId),
    [states, bot.id, bot.providerUserId],
  );
  return {
    rows,
    loading,
    error,
    saving,
    reload,
    toggle,
    supported: Boolean(botsService.setGroupEnabled),
  };
}
