// bots/telegramChannelRuntime.ts — Telegram 长轮询 runtime 的锁、游标与命令同步。
//
// INV-01 同一 token 同时只有一个轮询实例：锁以 token 为 key，拿不到锁的窗口保持 idle。
// INV-02 offset 是外部队列的消费确认点，必须逐条“处理成功后再推进”；回调失败绝不
//        推进，否则消息/权限/问答响应会被永久跳过。
// INV-03 长轮询请求超时 40s，覆盖服务端 25s 等待 + 传输与响应体读取；超时过短会让
//        半开连接长期占锁。
// INV-04 连接指纹 = provider + credentialRef + 凭据内容；token 变化必须等旧轮询退出
//        并释放锁后再启动新实例。
// INV-05 每轮 reconcile 的 await 之后都要检查 isLatest，过期代次立即退出。
// INV-06 后台 Promise 必须显式 catch（收口），不能把 rejection 交给 host。
// INV-07 syncCommands 失败只告警：命令同步不是连接可用性的前置条件。
// [平台] 409 表示 token 被其他客户端占用，退避 10s 而不是 5s。
import type {
  BotConfig,
  BotProviderCallbackResult,
  BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { BotProviderAdapter } from "./providers/types.js";
import {
  fetchBotProvider,
  fetchBotProviderJson,
} from "./providers/providerRequest.js";
import {
  acquireTelegramPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
} from "./channelRuntime.js";

// getUpdates 响应；result 的形态在各版本可能不同，按 unknown[] 处理。
interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: unknown[];
  description?: string;
}

// Telegram 服务端长轮询最多等待 25 秒；客户端额外预留传输时间，但必须覆盖响应体读取，
// 避免半开连接永久占用 polling lock，导致配置刷新无法接管 runtime。
const TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS = 40_000;
// 该超时也是轮询锁的最长占用窗口，调整时需同步评估锁接管延迟。

// 依赖注入：凭据、provider、游标存储、回调处理与锁实现。
interface TelegramChannelRuntimeDeps {
  // false 表示 remote host 不拥有轮询线程。
  runBackgroundTasks?: boolean;
  // 凭据服务负责 token 解密与轮换。
  credentialService: ICredentialService;
  // telegramProvider 命令同步能力可缺省（测试或降级）。
  telegramProvider: BotProviderAdapter | null;
  // 日志用于锁/网络失败的诊断。
  logger: BotRuntimeLogger;
  // 状态写入 UI 可观测的 runtime 状态。
  statusSink: BotRuntimeStatusSink;
  // 迁移必须先于游标读写。
  ensureBotStorageMigrated(): Promise<void>;
  // 无外部配置时读取最新快照。
  readConfig(): Promise<BotsConfigFile>;
  // 游标缺失返回 undefined，表示从头开始。
  readTelegramOffset(botId: string): Promise<number | undefined>;
  // offset 持久化，重启后从断点继续。
  writeTelegramOffset(botId: string, offset: number): Promise<void>;
  // 回调处理与渠道无关，runtime 只负责传输。
  processProviderCallback(
    provider: "telegram",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  // acquirePollingLock 测试可替换锁实现。
  acquirePollingLock?: typeof acquireTelegramPollingLock;
}

// 注意：这里不排除数组，update 判定只需要对象形状。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 工厂：闭包持有 runtime map 与串行刷新队列。
export function createTelegramChannelRuntime(deps: TelegramChannelRuntimeDeps) {
  // 单实例记录；fingerprint 变化触发换代。
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  // 以 bot.id 为键；同 Bot 只跑一个轮询。
  const runtimes = new Map<string, RuntimeEntry>();
  // reconcile 串行执行。
  const refreshQueue = createLatestRuntimeRefreshQueue();

  // 指纹包含 token 内容（见 INV-04）。
  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      // 指纹片段顺序固定（见 INV-04）。
      bot.provider,
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  // 同步命令菜单；禁用 Bot 时也调用，用于清理旧菜单。
  async function syncCommands(bot: BotConfig): Promise<void> {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：desktop-attached 远端不拥有 Telegram runtime；
      // 删除或禁用 bot 时也不能为了清命令访问第三方 API。
      return;
    }
  // 失败只告警（见 INV-07）。
    await deps.telegramProvider?.syncCommands?.(bot).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `sync Telegram commands failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  // 单 Bot 轮询循环：取锁 → 清 webhook → 长轮询 → 逐条确认。
  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    // token 在循环外读取一次；轮换由指纹变化触发重启。
    const token = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    // 无 token 直接报错退出，不进入轮询。
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "telegram",
        status: "error",
        messageId: "bots.runtime.telegramTokenMissing",
        message: "Telegram bot token is missing.",
      });
      return;
    }

    while (!signal.aborted) {
      // 锁是本轮资源，finally 释放。
      let lock: Awaited<ReturnType<typeof acquireTelegramPollingLock>>;
      try {
        // 锁 key 是 token，保证跨窗口互斥。
        lock = await (deps.acquirePollingLock ?? acquireTelegramPollingLock)(
          token,
          bot.id,
        );
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // 取锁失败必须可观测、可取消（见 INV-06）。
        // Bugfix: 锁目录/rename 的瞬时 I/O 异常发生在轮询 try 之外时会终止后台 Promise。
        // 锁也是 runtime 生命周期的一部分，必须可观测、可取消地退避重试。
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          // 状态里带上当前游标，便于诊断卡在哪条更新。
          message: `Telegram polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(5_000, signal);
        continue;
      }
      // 其他窗口持锁：保持 idle 并定期重试。
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "idle",
          messageId: "bots.runtime.telegramLongPollingHandledElsewhere",
        // offset 一并展示，说明本窗口未消费任何更新。
          message: "Telegram long polling is handled by another ZCode window.",
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      try {
        try {
          // 长轮询前删除 webhook，否则 Telegram 不会投递 getUpdates。
          await fetchBotProvider(
            `https://api.telegram.org/bot${token}/deleteWebhook`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              // 不丢弃积压更新：由 offset 决定从哪里继续。
              body: JSON.stringify({ drop_pending_updates: false }),
              signal,
            },
          );
        } catch {
          if (signal.aborted) {
            return;
          }
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "polling",
          // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
          message: "Telegram long polling is running.",
          messageId: "bots.runtime.telegramLongPollingRunning",
          offset: await deps.readTelegramOffset(bot.id),
        });

        while (!signal.aborted) {
          // 每轮都重新 readTelegramOffset 读游标，外部可能已更新。
          const offset = await deps.readTelegramOffset(bot.id);
          // 长轮询请求；超时由 INV-03 的常量控制。
          const response =
            await fetchBotProviderJson<TelegramGetUpdatesResponse>(
              `https://api.telegram.org/bot${token}/getUpdates`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  // Telegram 服务端最长等待 25s。
                  timeout: 25,
                  // 首次没有游标时不传 offset。
                  ...(offset !== undefined ? { offset } : {}),
                  // allowed_updates 只订阅 message 与 callback_query，减少无关流量。
                  allowed_updates: ["message", "callback_query"],
                }),
                signal,
              },
              // 客户端超时必须大于服务端等待。
              TELEGRAM_LONG_POLL_REQUEST_TIMEOUT_MS,
            );
          // HTTP 失败按状态码区分退避。
          if (!response.ok) {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message:
                  // 409 = token 被其他轮询客户端占用。
                response.status === 409
                  ? "Telegram token is already used by another polling client."
                  : `Telegram getUpdates failed: HTTP ${response.status}`,
              offset,
            });
            // 409 退避更久，避免与其他客户端互相抢锁。
            await waitFor(response.status === 409 ? 10_000 : 5_000, signal);
            continue;
          }
          // payload 可能为 null；下面统一按 ok/result 校验。
          const payload = response.payload;
            // 非 ok 或 result 非数组都视为协议错误。
          if (payload?.ok !== true || !Array.isArray(payload.result)) {
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: "telegram",
              status: "error",
              message:
                // 优先使用服务端描述，缺失才用通用文案。
                payload?.description ??
                "Telegram getUpdates returned an invalid response.",
              offset,
            });
            await waitFor(5_000, signal);
            continue;
          }
          if (signal.aborted) {
            return;
          }
          // 串行处理：保证同一会话内顺序。
          for (const update of payload.result) {
            if (signal.aborted) {
              return;
            }
            // update_id 缺失时无法推进游标，仍处理但不确认。
            const updateId =
              isRecord(update) && typeof update.update_id === "number"
                ? update.update_id
                : null;
            // 回调内部负责发送与状态落盘。
            const callbackResult = await deps.processProviderCallback("telegram", {
              botId: bot.id,
              update,
            });
            // 失败抛错，跳过下面的游标推进。
            assertBotCallbackSucceeded("Telegram", callbackResult);
            if (updateId !== null) {
              // 回调失败时上一行的断言已抛出，走不到这里，因此不存在先推进后失败的窗口。
              // Bugfix: offset 是 Telegram 外部队列的消费确认点。业务回调失败前推进会让
              // 用户消息、权限和 elicitation 响应永久跳过；成功后逐条提交才能安全重试。
              // Telegram 的 offset 语义是“下一个要读的 id”。
              await deps.writeTelegramOffset(bot.id, updateId + 1);
            }
          }
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "telegram",
            status: "polling",
            // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
            message: "Telegram long polling is running.",
            messageId: "bots.runtime.telegramLongPollingRunning",
            offset: await deps.readTelegramOffset(bot.id),
          });
        }
      } catch {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
          status: "error",
          // messageId 供前端本地化，message 是旧版兜底。
          messageId: "bots.runtime.telegramPollingFailedRetrying",
          message: "Telegram polling failed; retrying.",
          offset: await deps.readTelegramOffset(bot.id),
        });
        await waitFor(5_000, signal);
      } finally {
        // 释放失败只记录：租约过期后可被接管。
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Telegram polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  // 停止并等待收敛，幂等。
  async function stopPolling(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    // abort 后必须 await done 再删 map。
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.telegramLongPollingStopped",
        message: "Telegram long polling is stopped.",
      });
    }
  }

  // 已存在实例时直接返回（见 INV-01）。
  function startPolling(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    // 每实例独立 controller。
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: "telegram",
      status: "polling",
      messageId: "bots.runtime.telegramLongPollingStarting",
      // starting 是过渡态，进入循环后覆盖为 polling。
      message: "Telegram long polling is starting.",
    });
    // 先占位 done，避免竞态下读到 undefined。
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    // 显式收口后台 rejection（见 INV-06）。
    runtime.done = pollBot(bot, controller.signal).catch((error: unknown) => {
      // Bugfix: 后台 runtime 的最终 Promise 必须显式收口，避免异常升级为 host 未处理 rejection。
      deps.logger.warn(
        undefined,
        `Telegram polling stopped unexpectedly bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    // 按引用删除，避免过期实例影响新实例。
    }).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        // 只有仍在轮询时才落 stopped，避免覆盖错误态。
        if (previous?.status === "polling") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "telegram",
            status: "idle",
            messageId: "bots.runtime.telegramLongPollingStopped",
            message: "Telegram long polling is stopped.",
            // 停止后保留游标，重启从原位置继续。
            offset: previous.offset,
          });
        }
      }
    });
    // 先构造 runtime 再 runtimes.set 登记。
    runtimes.set(bot.id, runtime);
  }

  // 对齐配置：迁移 → 停不活跃 → 同步命令/换代/禁用。
  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    // Bugfix: polling 游标和微信 buf 会写入 bot-state.v3.json。
    // 启动轮询前必须先完成旧 state 迁移，否则迁移写回可能覆盖刚更新的第三方游标。
    await deps.ensureBotStorageMigrated();
    // 已有配置就不重复读。
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    // 活跃集合口径与启动分支一致。
    const activeTelegramIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            bot.provider === "telegram" && bot.enabled && bot.credentialRef,
        )
        .map((bot) => bot.id),
    );
    // 先停后启，避免双实例。
    for (const botId of runtimes.keys()) {
      // 配置移除或不再可用。
      if (!activeTelegramIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    // 再按配置处理。
    for (const bot of currentConfig.bots) {
      // 启用且有权重的 Bot 才启动。
      if (bot.provider === "telegram" && bot.enabled && bot.credentialRef) {
        await syncCommands(bot);
        if (!isLatest()) {
          return;
        }
      // 读凭据后必须再检查代次。
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
      // 指纹不同才换代。
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: Bot id 不变不代表连接身份不变。必须等旧 token 的轮询和锁完全退出，
          // 再启动新凭据，避免配置已更新但后台仍消费旧账号或两个实例短暂并行。
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
      // 指纹一致时内部直接返回。
        startPolling(bot, fingerprint);
      // 禁用 Bot：清理命令菜单并标记状态。
      } else if (bot.provider === "telegram" && !bot.enabled) {
        await syncCommands(bot);
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "telegram",
        // 禁用态与 idle 区分。
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  // refresh 经 refreshQueue 入队执行。
  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  // 后台刷新任务吞错只记 logger 日志。
  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：配置变更后的轮询刷新也是 bot runtime 后台任务；
      // attached remote 不能绕过构造期保护启动 Telegram polling。
      return;
    }
    // 不能丢掉 rejection。
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Telegram polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  // 销毁：失效队列 → abort → 等 done → 清 map。
  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    // 快照用于按引用清理。
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：服务销毁返回前必须等长轮询退出并释放 token 锁，避免新 host 被迫等待下一轮重试。
    // 等长轮询退出并释放 token 锁。
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    // 只清理快照中的实例。
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  // 对外暴露控制面，含 dispose 与 refresh 成员。
  return {
    dispose,
    refresh,
    scheduleRefresh,
    // 单 Bot 停止。
    stopPolling,
    // 命令同步也对外暴露，便于测试与手动修复。
    syncCommands,
  };
}
