// bots/weixinChannelRuntime.ts — 微信（Weixin）长轮询 runtime 的锁、游标与附件保真。
//
// INV-01 同一 token 同时只有一个轮询实例：锁以 token 为 key，拿不到锁的窗口保持 idle 并定期重试。
// INV-02 get_updates_buf 是第三方队列的消费确认点：必须等本批消息全部进入业务处理（含回调
//        成功）后才持久化，回调失败绝不推进，否则消息会被永久跳过。
// INV-03 重新包装 inbound 时必须原样透传 attachments 与 context_token，纯图片消息不能因
//        text 为空而在 provider 层被吞掉。
// INV-04 连接指纹含凭据内容；凭据轮换需先 stop 旧循环再 start，不能让旧账号继续消费。
// INV-05 reconcile 每个 await 之后检查 isLatest，过期代次立即退出。
// INV-06 dispose 必须等所有 done 收敛（allSettled）后才清 map。
import type {
  BotConfig,
  BotProviderCallbackResult,
  BotsConfigFile,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { getWeixinUpdates } from "./providers/weixinProvider.js";
import {
  acquireWeixinPollingLock,
  assertBotCallbackSucceeded,
  BOT_RUNTIME_LOCK_RETRY_MS,
  createBotConnectionFingerprint,
  createLatestRuntimeRefreshQueue,
  type BotRuntimeLogger,
  type BotRuntimeStatusSink,
  waitFor,
} from "./channelRuntime.js";

// 依赖注入：凭据、游标读写、回调管线，以及可替换的锁/拉取实现（测试用）。
interface WeixinChannelRuntimeDeps {
// false 表示当前 Host 只暴露控制面，不起后台轮询（attached remote 场景）。
  runBackgroundTasks?: boolean;
  credentialService: ICredentialService;
  logger: BotRuntimeLogger;
  statusSink: BotRuntimeStatusSink;
  ensureBotStorageMigrated(): Promise<void>;
  readConfig(): Promise<BotsConfigFile>;
// 游标持久化由调用方负责；runtime 既不缓存也不推导 buf。
  readWeixinGetUpdatesBuf(botId: string): Promise<string | undefined>;
// 写入顺序必须在本批回调全部成功之后（见 INV-02）。
  writeWeixinGetUpdatesBuf(botId: string, buf: string): Promise<void>;
  processProviderCallback(
    provider: "weixin",
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
// 测试可替换拉取实现，生产走 weixinProvider。
  getUpdates?: typeof getWeixinUpdates;
  acquirePollingLock?: typeof acquireWeixinPollingLock;
}

// 工厂：闭包持有 runtime map 与串行刷新队列，返回 dispose/refresh 等生命周期入口。
export function createWeixinChannelRuntime(deps: WeixinChannelRuntimeDeps) {
// 单条轮询记录：controller 负责取消，fingerprint 决定是否需要换代。
  interface RuntimeEntry {
    controller: AbortController;
    fingerprint: string;
    done: Promise<void>;
  }

// 以 bot.id 为键；同一 Bot 只允许一条轮询（见 INV-01）。
  const runtimes = new Map<string, RuntimeEntry>();
// 串行 reconcile，保证配置变更按顺序生效，且旧代次自动作废。
  const refreshQueue = createLatestRuntimeRefreshQueue();

// 指纹包含凭据内容：凭据轮换会改变指纹，从而触发先停后启（见 INV-04）。
// 没有 credentialRef 时按空串参与指纹，避免 undefined 造成不稳定。
  async function getConnectionFingerprint(bot: BotConfig): Promise<string> {
    const credential = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
    return createBotConnectionFingerprint([
      bot.provider,
      bot.credentialRef ?? "",
      credential ?? "",
    ]);
  }

// 单 Bot 的常驻循环：取锁 → 轮询 → 释放 → 失败退避，直到 signal 中止。
// 所有 await 之后都可能被 abort，因此每轮推进前都要重新检查 signal。
  async function pollBot(bot: BotConfig, signal: AbortSignal): Promise<void> {
    const token = bot.credentialRef
      ? await deps.credentialService.load(bot.credentialRef)
      : null;
// 没有 token 时不取锁：无法鉴权的请求只会被服务端拒绝，且不应占用跨窗口锁。
// 状态保持 error 并直接返回，等配置刷新再次调用 reconcile。
    if (!token?.trim()) {
      deps.statusSink.setRuntimeStatus({
        botId: bot.id,
        provider: "weixin",
        status: "error",
        message: "Weixin bot token is missing.",
      });
      return;
    }

    while (!signal.aborted) {
// 锁句柄是本轮资源，必须在 finally 释放；先声明再在 try 内赋值。
// 取锁失败不能跳出循环（见下方 catch），否则后台 Promise 会意外终止。
      let lock: Awaited<ReturnType<typeof acquireWeixinPollingLock>>;
      try {
// 锁以 token + botId 为键；返回 null 表示其他窗口持有，不是错误。
        lock = await (deps.acquirePollingLock ?? acquireWeixinPollingLock)(
          token,
          bot.id,
        );
      } catch (error) {
// abort 期间的锁异常不写状态、不重试，直接收敛。
        if (signal.aborted) return;
        // Bugfix：每个窗口都有独立 host。微信锁 I/O 失败必须退避重试，不能让后台 Promise 退出。
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
          message: `Weixin polling lock failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
        continue;
      }
// 多窗口场景：本窗口不抢锁，保持 idle 并按固定间隔重试，绝不并发消费同一队列。
// 重试间隔远大于轮询间隔，避免多窗口空转争抢。
      if (!lock) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "idle",
          message: "Weixin long polling is handled by another ZCode window.",
        });
        await waitFor(BOT_RUNTIME_LOCK_RETRY_MS, signal);
        continue;
      }
      try {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "polling",
          // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
          message: "Weixin long polling is running.",
          messageId: "bots.runtime.weixinLongPollingRunning",
        });
        while (!signal.aborted) {
// 每轮先读已持久化游标，再拉取增量；服务端返回的 buf 才是新游标，请求里的 buf 只是提示。
// 不缓存 buf 到内存，避免与磁盘状态分叉。
          const buf = await deps.readWeixinGetUpdatesBuf(bot.id);
// getUpdates 内部负责鉴权与解析；signal 透传下去，abort 时能中断在途请求。
// 解析出的 messages 已包含 actor 与 attachments，后续不再二次解析。
          const result = await (deps.getUpdates ?? getWeixinUpdates)({
            bot,
            deps: { loadCredential: (key) => deps.credentialService.load(key) },
            buf,
            signal,
          });
          if (signal.aborted) {
            return;
          }
// 原始条数大于 0 但解析为 0 属于异常，需要留下诊断日志（不含正文）。
          if ((result.rawMessageCount ?? 0) > 0 || result.messages.length > 0) {
// 统计附件数，用于确认纯图片消息是否在解析层被保留。
            const attachmentCount = result.messages.reduce(
              (count, message) => count + (message.attachments?.length ?? 0),
              0,
            );
            // Bugfix 调试：微信附件可能没有文本，记录原始/解析数量来定位是否在 provider 层被过滤。
            deps.logger.debug(
              undefined,
              `weixin polling received bot=${bot.id} raw=${result.rawMessageCount ?? 0} parsed=${result.messages.length} attachments=${attachmentCount}`,
            );
// 只记录字段形状（rawMessageDiagnostics），不记录正文，避免日志泄露用户内容。
// 这类日志与消息流量同数量级，必须走 debug。
            if (result.messages.length === 0) {
              // Bugfix 调试：只记录字段形状，不记录正文，定位微信图片/附件为何被过滤。
              deps.logger.debug(
                undefined,
                `weixin polling diagnostics bot=${bot.id} ${(result.rawMessageDiagnostics ?? []).join(" | ")}`,
              );
            }
          }
// 逐条进入业务管线：即使前一条失败，本批游标也不会推进（见 INV-02）。
// 每次进入下一条前重新检查 abort，避免停止后继续消费。
          for (const inbound of result.messages) {
            if (signal.aborted) {
              return;
            }
// 重新包装成 provider 无关的 payload；字段名映射必须与 weixinProvider 解析结果一致。
// attachments 与 context_token 原样透传（见 INV-03），否则纯图片消息会静默无响应。
            const callbackResult = await deps.processProviderCallback("weixin", {
              botId: bot.id,
              messages: [
                {
                  id: inbound.actor.providerMessageId,
                  text: inbound.text,
                  from: inbound.actor.providerUserId,
                  chatId: inbound.actor.chatId,
                  displayName: inbound.actor.displayName,
                  context_token: inbound.actor.providerContextToken,
                  // Bugfix: 微信轮询已经解析出的附件在重新包装给 callback 管线时不能丢。
                  // 否则纯图片消息会因为 text 为空、attachments 被吞而静默无响应。
                  attachments: inbound.attachments,
                },
              ],
              ...(result.buf ? { buf: result.buf } : {}),
            });
// 回调 ok=false 时抛错，整批进入 catch：游标不推进，下一轮重投（at-least-once）。
// 因此业务处理必须按 providerMessageId 幂等。
            assertBotCallbackSucceeded("Weixin", callbackResult);
          }
// 只有本批全部回调成功后才提交新游标；这是微信侧的唯一确认点。
// 先处理再写游标，进程中途崩溃只会重放，不会跳过消息。
          if (result.buf) {
            // Bugfix: 微信 get_updates_buf 代表服务端游标，必须等本批消息全部进入业务处理后再持久化。
            // 之前先写游标再处理回复，进程在中途失败会跳过未完成消息，导致 AskUserQuestion 回复顺序错乱或丢失。
            await deps.writeWeixinGetUpdatesBuf(bot.id, result.buf);
          }
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "polling",
            // 修复：运行状态会直接展示到 UI。补充 messageId，让前端按当前语言渲染，message 仅作为旧版本兜底。
            message: "Weixin long polling is running.",
            messageId: "bots.runtime.weixinLongPollingRunning",
          });
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "error",
// 拉取/解析/回调任一失败都落到这里：置 error 状态后退避重试，锁在 finally 释放。
// 游标停在上一次成功位置，未确认的消息会在下一轮重投（at-least-once）。
// 不用指数退避，是因为 Weixin 侧限流窗口固定，5s 足够避开瞬时故障。
// 错误摘要直接展示到 UI，不包含 token 或消息正文。
          message: `Weixin polling failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        await waitFor(5_000, signal);
      } finally {
        // Bugfix：微信 buf 是第三方队列确认点；只有持锁 owner 能消费和写入，退出时必须释放给其他 host 接管。
// 释放失败只记录 debug：锁带租约，过期后会被其他 host 接管，不阻塞本轮退出。
// 释放必须在 abort/异常路径都执行，否则其他窗口要等到租约过期。
        await lock.release().catch((error: unknown) => {
          deps.logger.debug(
            undefined,
            `release Weixin polling lock failed bot=${bot.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  async function stopPolling(botId: string): Promise<void> {
// 停止幂等：没有 runtime 时仍然刷新一次状态，保证 UI 不会停在 polling。
// 必须等待 done 收敛，不能只 abort 就删 map。
    const runtime = runtimes.get(botId);
    runtime?.controller.abort();
    if (runtime) {
      await runtime.done;
      if (runtimes.get(botId) === runtime) {
        runtimes.delete(botId);
      }
    }
    const previous = deps.statusSink.getRuntimeStatus(botId);
// 保留原状态字段，只改 status/message，避免丢失 offset 等展示信息。
    if (previous) {
      deps.statusSink.setRuntimeStatus({
        ...previous,
        status: "idle",
        messageId: "bots.runtime.weixinLongPollingStopped",
        message: "Weixin long polling is stopped.",
      });
    }
  }

// 启动新轮询；已存在同 Bot runtime 时直接返回（见 INV-01）。
  function startPolling(bot: BotConfig, fingerprint: string): void {
// 换代必须先由 reconcile 调用 stopPolling，不能在这里隐式覆盖旧 runtime。
// 否则旧 controller 失去引用，abort 永远不会被触发。
    if (runtimes.has(bot.id)) {
      return;
    }
    const controller = new AbortController();
    deps.statusSink.setRuntimeStatus({
      botId: bot.id,
      provider: "weixin",
      status: "polling",
      messageId: "bots.runtime.weixinLongPollingStarting",
      message: "Weixin long polling is starting.",
    });
// done 先用已 resolve 的 Promise 占位：finally 回调里要引用 runtime 自身，
// 若直接赋值为 pollBot(...) 会形成 TDZ 自引用。
    const runtime: RuntimeEntry = {
      controller,
      fingerprint,
      done: Promise.resolve(),
    };
// 只允许自己删除自己：reconcile 可能已经启动了新代次，避免误删新 runtime。
// 自然退出时若仍显示 polling，需要回落 idle，防止 UI 长期显示运行中。
    runtime.done = pollBot(bot, controller.signal).finally(() => {
      if (runtimes.get(bot.id) === runtime) {
        runtimes.delete(bot.id);
        const previous = deps.statusSink.getRuntimeStatus(bot.id);
        if (previous?.status === "polling") {
          deps.statusSink.setRuntimeStatus({
            botId: bot.id,
            provider: "weixin",
            status: "idle",
            messageId: "bots.runtime.weixinLongPollingStopped",
            message: "Weixin long polling is stopped.",
          });
        }
      }
    });
// 注册必须在 done 赋值之后，保证外部拿到的 entry 一定带有效 Promise。
    runtimes.set(bot.id, runtime);
  }

// 对齐配置与运行态：先停掉不再活跃的，再启动/换代活跃的。
// 每个 await 后都检查 isLatest，过期代次不再改动运行态（见 INV-05）。
  async function reconcile(
    config: BotsConfigFile | undefined,
    isLatest: () => boolean,
  ): Promise<void> {
// 首次访问前完成存储迁移，避免旧版配置被当成“未启用”而错误停机。
// 迁移只做一次，失败会向上抛出，由 refreshQueue 交给调用方记录。
    await deps.ensureBotStorageMigrated();
    const currentConfig = config ?? (await deps.readConfig());
    if (!isLatest()) {
      return;
    }
// 活跃 = provider 为 weixin 且 enabled 且有凭据；缺凭据无法鉴权，视同不活跃。
// 用 Set 做差集，避免 O(n^2) 的 includes 扫描。
    const activeWeixinIds = new Set(
      currentConfig.bots
        .filter(
          (bot) =>
            bot.provider === "weixin" && bot.enabled && bot.credentialRef,
        )
        .map((bot) => bot.id),
    );
// 先做停机：已删除/禁用/改 provider 的 Bot 必须先释放锁和游标。
// 迭代 keys() 时只删除当前项，stopPolling 内部会做同对象校验。
    for (const botId of runtimes.keys()) {
      if (!activeWeixinIds.has(botId)) {
        await stopPolling(botId);
        if (!isLatest()) {
          return;
        }
      }
    }
// 再按配置顺序启动：保证同一份配置多次 reconcile 的结果稳定。
// 非 weixin 的 Bot 完全跳过，不触碰其他渠道的 runtime。
    for (const bot of currentConfig.bots) {
      if (bot.provider === "weixin" && bot.enabled && bot.credentialRef) {
// 指纹读取凭据可能涉及 IO，之后必须再次确认代次。
        const fingerprint = await getConnectionFingerprint(bot);
        if (!isLatest()) {
          return;
        }
// 已有 runtime 且指纹一致时复用，不打断长轮询。
        const runtime = runtimes.get(bot.id);
        if (runtime && runtime.fingerprint !== fingerprint) {
          // Bugfix: 微信凭据更新后旧 getupdates 循环仍闭包持有旧 BotConfig。
          // 串行等待旧请求退出后再接管，避免旧账号继续消费或新旧游标并发推进。
          await stopPolling(bot.id);
          if (!isLatest()) {
            return;
          }
        }
// 无 runtime 或刚换代完成，此时启动；内部会再次检查是否已存在。
        startPolling(bot, fingerprint);
// 禁用态只更新状态，不创建 runtime；凭据仍保留，便于重新启用。
// messageId 供前端本地化，message 仅作旧版本兜底。
      } else if (bot.provider === "weixin" && !bot.enabled) {
        deps.statusSink.setRuntimeStatus({
          botId: bot.id,
          provider: "weixin",
          status: "disabled",
          messageId: "bots.runtime.botDisabled",
          message: "Bot is disabled.",
        });
      }
    }
  }

// 外部刷新入口：返回 Promise，便于测试与 dispose 前等待。
  function refresh(config?: BotsConfigFile): Promise<void> {
// 交给最新代次队列：只有最后一次 enqueue 的 reconcile 会真正生效。
// config 为 undefined 时由 reconcile 内部读取最新快照。
    return refreshQueue.enqueue((isLatest) => reconcile(config, isLatest));
  }

// 配置变更回调入口：不返回 Promise，后台执行且必须显式 catch。
// attached remote 不起后台轮询，直接跳过（见 runBackgroundTasks）。
  function scheduleRefresh(config?: BotsConfigFile): void {
    if (deps.runBackgroundTasks === false) {
      // 修复原因：配置变更后的微信 long polling 属于本地桌面 host 后台任务；
      // attached remote 仅应暴露远端文件/agent 控制面。
      return;
    }
// 后台 Promise 必须挂 catch，否则未处理 rejection 会触发进程级告警。
    void refresh(config).catch((error: unknown) => {
      deps.logger.warn(
        undefined,
        `refresh Weixin polling failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

// 销毁：作废刷新队列，abort 全部 runtime，等待收敛后清空 map（见 INV-06）。
  async function dispose(): Promise<void> {
// 先作废队列：销毁过程中到达的 refresh 不再改动运行态。
// 之后再 abort，保证没有新代次在清理期间插入。
    refreshQueue.invalidate();
    const activeRuntimes = [...runtimes.values()];
    for (const runtime of activeRuntimes) {
      runtime.controller.abort();
    }
    // Bugfix：微信 buf 只能由锁 owner 提交；销毁必须等待请求退出和 finally 释放锁后才完成。
// allSettled 而非 all：单条轮询失败不应阻断其余 runtime 的清理与锁释放。
// done 收敛意味着 finally 已执行，锁与游标都已落盘。
    await Promise.allSettled(activeRuntimes.map((runtime) => runtime.done));
    for (const [botId, runtime] of runtimes) {
      if (activeRuntimes.includes(runtime)) {
        runtimes.delete(botId);
      }
    }
  }

// 对外只暴露生命周期入口；runtimes map 与指纹逻辑保持闭包私有。
// dispose 用于进程退出，refresh/scheduleRefresh 用于配置同步，stopPolling 用于单 Bot 停止。
  return {
    dispose,
    refresh,
    scheduleRefresh,
    stopPolling,
  };
}
