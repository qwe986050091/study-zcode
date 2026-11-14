import {
  isFeishuBotProvider,
  type BotConfig,
  type BotProvider,
  type BotProviderCallbackResult,
  type BotsConfigFile,
} from "@zcode/shared";
// bots/feishuChannelRuntime.ts — 飞书/Lark WebSocket 长连接的生命周期管理。
//
// INV-01 同一 Bot 同时只有一个 RuntimeEntry；startWebSocket 对已存在的 bot.id
//        直接返回，避免重复连接。
// INV-02 连接指纹 = provider + appId + credentialRef + 凭据内容；任一项变化都
//        必须先 stop 再 start，不能让旧凭据的连接继续在线。
// INV-03 acquire 锁失败必须留在可恢复循环里（历史 Bug：锁异常导致未处理 rejection）。
// INV-04 等待连接终止要 race(abort, client.terminated)；首次 ready 不是生命周期
//        终点，SDK 重连耗尽必须进入 catch。
// INV-05 退避等待前必须已释放 client 与跨窗口锁，否则会占着旧资源睡眠。
// INV-06 reconcile 的每个 await 之后都要检查 isLatest；过期代次立即退出。
// INV-07 dispose 必须等所有 done 收敛后再清 map，且用 allSettled 避免单条失败阻断。
// [安全] 回调 payload 的 ok=false 必须抛错，阻止 provider 确认事件。
import type { ICredentialService } from "../credential/credential.js";
import { startFeishuBotWebSocket, type FeishuWebSocketClient } from "./providers/feishuProvider.js";
import {
  acquireFeishuWebSocketLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
  waitForAbort,
} from "./channelRuntime.js";

// 依赖注入：后台开关、凭据、配置读取、回调处理、锁与连接工厂。
interface FeishuChannelRuntimeDeps {
  // false 表示当前 Host 只暴露控制面，不起后台连接。
  runBackgroundTasks?: boolean;
  // 连接换代时通知上层清理旧线路绑定。
  onConnectionInvalidated?(botId: string): void;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  // 无外部配置时由这里读取最新快照。
  readConfig(): Promise<BotsConfigFile>;
  // 只用于日志，不得包含凭据明文。
  summarizeCallbackPayload(payload: unknown): string;
  processProviderCallback(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
  // acquireWebSocketLock 可选注入，测试由替换实现接管，生产必须用 acquireFeishuWebSocketLock。
  acquireWebSocketLock?: typeof acquireFeishuWebSocketLock;
  // 测试可替换连接工厂。
  startWebSocket?: typeof startFeishuBotWebSocket;
}

// 工厂：闭包持有 runtime map 与串行刷新队列。
export function createFeishuChannelRuntime(deps: FeishuChannelRuntimeDeps) {
  // 单条连接记录：controller 负责取消，fingerprint 决定是否换代。
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

  // 以 bot.id 为键；同一 Bot 只允许一条连接（见 INV-01）。
  const runtimes = new Map<string, RuntimeEntry>();
  // 串行 reconcile，保证配置变更按顺序生效。
  const refreshQueue = createLatestRuntimeRefreshQueue();

  // 指纹包含凭据内容，凭据轮换会触发重连（见 INV-02）。
  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    // credentialRef 缺失时按空串参与指纹，保证配置未变时指纹不变。
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.feishuAppId ?? "",
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

  // 单 Bot 的常驻循环：取锁 → 连接 → 等待终止 → 清理 → 退避。
  async function runBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    // client 在 finally 中关闭并置空，防止跨轮复用。
    let client: FeishuWebSocketClient | null = null;
    // abort 后不再进入下一轮。
    while (!signal.aborted) {
      // 锁句柄是本轮资源，必须在 finally 释放。
      let lock: Awaited<ReturnType<typeof acquireFeishuWebSocketLock>>;
      try {
        // 锁冲突返回 null 而不是抛错。
        lock = await (deps.acquireWebSocketLock ?? acquireFeishuWebSocketLock)(bot);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        // acquire 失败也要可恢复（见 INV-03）。
        // Bugfix: runtime 停止或锁目录异常时，锁文件创建可能在进入连接 try 块前失败。
        // 必须把 acquire 纳入可恢复循环，否则多窗口关闭会留下未处理 rejection。
        deps.logger.warn(
          undefined,
          `acquire Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? `${error.message}${"code" in error && typeof error.code === "string" ? ` code=${error.code}` : ""}` : String(error)}`,
        );
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          message: `Feishu WebSocket lock failed: ${error instanceof Error ? error.message : String(error)}`,
          // 锁异常先报 error 状态，退避后重试。
        });
        await waitFor(5_000, signal);
        continue;
      }
      // null 表示其他窗口持锁；本窗口保持 idle 并定期重试。
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "idle",
        // 多窗口场景：本窗口不抢锁，状态置 idle。
          message: "Feishu WebSocket is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      // 标记本轮失败，决定清理后是否退避。
      let retryAfterError = false;
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          messageId: "bots.runtime.feishuWebSocketConnecting",
          message: "Feishu WebSocket is connecting.",
        });
        // 新连接建立前先让旧线路绑定失效。
        deps.onConnectionInvalidated?.(bot.id);
        // 连接工厂拿到 signal；abort 由 SDK 负责关闭 socket。
        client = await (deps.startWebSocket ?? startFeishuBotWebSocket)({
          bot,
          signal,
          // 重连中与运行中都算 connected，但 reconnecting 要再次失效旧绑定。
          onConnectionStateChange: (state) => {
            if (state === "reconnecting") deps.onConnectionInvalidated?.(bot.id);
            deps.statusSink.setRuntimeStatus({
              botId: bot.id,
              provider: bot.provider,
              status: "connected",
              message:
                state === "reconnecting"
                  ? "Feishu WebSocket is reconnecting."
                  : "Feishu WebSocket is running.",
              messageId:
                state === "reconnecting"
                  ? "bots.runtime.feishuWebSocketConnecting"
                  : "bots.runtime.feishuWebSocketRunning",
            });
          },
          deps: {
            loadCredential: (key) => deps.credentialService.load(key),
          },
          // 每条事件串行处理；abort 后直接丢弃。
          onPayload: async (payload) => {
            if (signal.aborted) {
              return;
            }
            deps.logger.debug(
              undefined,
              `feishu websocket payload bot=${bot.id} ${deps.summarizeCallbackPayload(payload)}`,
            );
            // 回调必须确认成功，否则抛错阻止 provider 提交游标。
            const callbackResult = await deps.processProviderCallback(bot.provider, payload);
            // 抛错由 SDK 记录并重投；这里不做本地重试。
            assertBotCallbackSucceeded(bot.provider === "lark" ? "Lark" : "Feishu", callbackResult);
            // WebSocket 只回传第一条回复，其余由投递层处理。
            return callbackResult.replies[0];
          },
        });
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "connected",
          // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
          message: "Feishu WebSocket is running.",
          messageId: "bots.runtime.feishuWebSocketRunning",
        });
        // Bugfix：首次 ready 不是长连接生命周期终点。SDK 重连耗尽必须进入 catch，
        // 才能更新错误状态、关闭 client、释放跨窗口锁并进入外层恢复循环。
        // 等待 abort 或连接终止，二者任一发生都进入下一轮清理。
        await Promise.race([
          // abort 优先，即使连接尚未 terminated。
          waitForAbort(signal),
          // 没有 terminated 句柄时退化为只等 abort。
          client.terminated ?? new Promise<void>(() => undefined),
        ]);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
          status: "error",
          // 连接失败状态包含错误摘要，便于 UI 直接展示。
          message: `Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        // 失败只标记，清理在 finally 完成后再退避。
        retryAfterError = true;
      } finally {
        // 关闭失败不影响锁释放，仅记录 debug。
        if (client) {
          try {
            // 先关连接再放锁，避免新窗口拿到锁后与旧连接并存。
            client.close();
          } catch (error) {
            deps.logger.debug(
              undefined,
              `close Feishu WebSocket failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          // 防止 finally 之后仍被外层引用。
          client = null;
        }
        // 释放失败只告警：锁会在租约过期后被接管。
        await lock.release().catch((error: unknown) => {
          deps.logger.warn(
            undefined,
            `release Feishu WebSocket lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      // 修复原因：重试退避不能占着旧 client 和跨窗口锁等待，必须先完整清理资源。
      // 退避发生在资源清理之后（见 INV-05）。
      if (retryAfterError) {
        await waitFor(5_000, signal);
      }
    }
  }

  // 停止并等待收敛；重复调用幂等。
  async function stopWebSocket(botId: string): Promise<void> {
    const runtime = runtimes.get(botId);
    // abort 后必须等待 done，不能立即删除 map。
    runtime?.controller.abort();
    // 没有 runtime 时仍需刷新状态为 idle。
    if (runtime) {
      await runtime.done;
      // 只删除自己，避免误删新连接。
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    // 保留原有字段，只改状态（含 messageId 兜底）。
    const previous = deps.statusSink.getRuntimeStatus(botId);
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.feishuWebSocketStopped",
        message: "Feishu WebSocket is stopped.",
      });
    }
  }

  // 已存在连接时直接返回（见 INV-01）。
  function startWebSocket(bot: BotConfig, fingerprint: string): void {
    if (runtimes.has(bot.id)) {
      return;
    }
    // 每条连接独立 controller。
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: bot.provider,
      status: "connected",
      messageId: "bots.runtime.feishuWebSocketStarting",
      // 启动瞬间先给 starting，连接成功后覆盖为 running。
      message: "Feishu WebSocket is starting.",
    });
    // 先登记 done=resolved，随后替换为真实 Promise，避免竞态下 undefined。
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
    // finally 中按引用删除，过期 runtime 不影响新连接。
    runtime.done = runBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        // 只有仍在 connected 时才落 stopped，避免覆盖错误态。
        if (previous?.status === "connected") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: bot.provider,
            status: "idle",
            messageId: "bots.runtime.feishuWebSocketStopped",
            message: "Feishu WebSocket is stopped.",
          });
        }
      }
    });
    // 先启动再登记：runBot 的同步部分不会回调 map。
    runtimes.set(bot.id, runtime);
  }

  // 对齐配置：先停掉不再活跃的连接，再启动/换代，最后标记禁用。
  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
    // 迁移必须先于读取，保证看到 v3 配置。
    await deps.ensureBotStorageMigrated();
    // 回调里已带配置就不重复读。
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
    // 活跃集合口径与下面启动分支完全一致。
    const activeFeishuIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            isFeishuBotProvider(bot.provider) &&
            bot.enabled &&
            bot.credentialRef &&
            bot.feishuAppId,
        )
        .map((bot) => bot.id),
    );
    // 先停后启：避免同一 Bot 短暂双连接。
    for (const botId of runtimes.keys()) {
      // 配置里已移除或不再可用：停止连接。
      if (!activeFeishuIds.has(botId)) {
        await stopWebSocket(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
    // 再按配置启动或换代。
    for (const bot of currentConfig.bots) {
      if (
        isFeishuBotProvider(bot.provider) &&
        bot.enabled &&
        bot.credentialRef &&
        bot.feishuAppId
      ) {
      // 凭据读取是异步的，读后必须再检查代次。
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
      // 指纹不同才换代。
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: 飞书/Lark 的 provider、App ID 或凭据变化后，旧 WebSocket 仍持有旧配置。
          // 必须等待旧 client 和跨窗口锁释放后再启动新连接，保证同一 Bot 只有一个配置版本在线。
          await stopWebSocket(bot.id);
          if (!isLatest()) {
            return;
          }
        }
      // 已存在且指纹一致时 startWebSocket 内部会直接返回。
        startWebSocket(bot, fingerprint);
      // 禁用 Bot 只更新状态，不保留连接。
      } else if (isFeishuBotProvider(bot.provider) && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: bot.provider,
        // 禁用态与 idle 区分，UI 可展示不同提示。
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

  // 入队执行；调用方 await 可拿到本轮结果。
  function refresh(config?: BotsConfigFile): Promise<void> {
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

  // scheduleRefresh 的后台刷新吞掉错误只记日志，不能让一次 config 读取失败中断定时器。
  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：remote workspace host / desktop-attached 远端只暴露控制面服务；
      // bot runtime 后台连接必须留在本地桌面 host，避免配置变更后重新抢跑。
      return;
    }
    // 不能用 void 丢掉 rejection。
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Feishu WebSocket failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  // 销毁：先失效队列，再 abort 全部连接，最后等 done。
  async function dispose(): Promise<void> {
    refreshQueue.invalidate();
    // 快照用于结束后的按引用清理。
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：abort 只是发出取消信号；销毁终态必须等 WebSocket 关闭和 finally 释放跨进程锁。
    // allSettled：单条连接失败不影响其他连接关闭。
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    // 只删除快照中的 runtime，保留期间新建的连接。
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

  // 对外只暴露控制面，不暴露内部 map。
  return {
    // dispose 可重复调用。
    dispose,
    refresh,
    scheduleRefresh,
    // 单 Bot 停止用于配置变更与测试。
    stopWebSocket,
  };
}
