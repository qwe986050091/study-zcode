// INV-01 同一 runtime 只维护一个已连接的 Browser；守住位置：#browser 字段与 ensureBrowser 的复用分支；改错故障：每条命令都新起 Chromium，进程与内存持续泄漏。
// INV-02 并发的 ensureBrowser 必须共享同一次 launch；守住位置：ensureBrowser 中 #launchPromise 的惰性赋值；改错故障：首条命令并发起多个 Chromium，关闭时只能回收其中一个。
// INV-03 请求必须带上当前后端身份；守住位置：execute 开头的 browserId 与 generation 校验；改错故障：旧 turn 的命令落到新后端，操作到错误标签页。
// INV-04 浏览器断连即让全部会话失效；守住位置：disconnected 回调中清空 #sessions 并递增 #generation；改错故障：断连后仍复用已销毁 context，命令报错含糊且标签页列表过期。
// INV-05 close 之后才完成的 launch 必须被关闭；守住位置：close 中的 launchPromise 分支与 ensureBrowser 的 #disposed 检查；改错故障：CLI 退出后残留无主的 Chromium 子进程。
// INV-06 关闭中的会话不得复活；守住位置：ensureSession 开头对 #closingSessionIds 的早返回；改错故障：已关闭会话被后续命令重新建出 context，资源无人回收。
// INV-07 一个 sessionId 对应且仅对应一个 BrowserContext；守住位置：#sessions 与 #sessionPromises 两张表的登记规则；改错故障：两个会话共享 context，标签页互相串扰且关闭互相踩踏。
// INV-08 取消信号必须贯穿到浏览器操作；守住位置：raceWithAbort 以及派发前后的 aborted 检查；改错故障：用户已取消但写操作照常执行，页面被意外修改。
// INV-09 只有已派发且带副作用的取消才标记 uncertain；守住位置：execute catch 分支中的 dispatched 与 hasSideEffects 组合判断；改错故障：调用方误判写操作未生效并重试，产生重复提交。
// INV-10 命令失败不向调用方抛出；守住位置：execute 的 catch 统一转 errorResult；改错故障：单条浏览器命令的异常冒泡打断整个 agent loop。
// INV-11 所有关闭路径都必须限时；守住位置：waitForPromise 的超时上限与 closeSession、close 的调用点；改错故障：WebSocket 或 SSE 页面挂住关闭流程，CLI 无法退出。
// INV-12 close 必须幂等；守住位置：close 开头对 #disposed 的早返回；改错故障：重复关闭报错或把已关闭实例再关一次。
// INV-13 关闭前先摘掉引用；守住位置：closeBrowser 先清 #browser 再调用实例关闭；改错故障：并发命令复用正在关闭的 browser，拿到必然失败的句柄。
// INV-14 创建期间环境变化则丢弃新 context；守住位置：ensureSession 中的 disposed、closing、browser 与 generation 守卫；改错故障：幽灵会话指向已断连浏览器，后续命令全部失败且错误归因困难。
// INV-15 成功结果必须带后端身份与耗时；守住位置：withMeta 组装的 meta 字段；改错故障：上层无法区分后端代际，排障与陈旧请求判定失去依据。
// INV-16 不支持的命令必须显式声明；守住位置：executeSessionCommand 中集中列出的 capability_unsupported 分支；改错故障：调用方收到 Playwright 的晦涩报错，无法走降级路径。
// INV-17 显式可执行路径要在构造期校验；守住位置：createManagedCdpBrowserRuntime 的 validateExplicitBrowserExecutable 调用；改错故障：非法路径拖到首条命令才失败，错误归属难以定位。
// INV-18 请求登记必须成对清理；守住位置：execute 的 finally 移除 abort 监听并删除 pending；改错故障：pending 表持续膨胀，取消信号串到已结束的请求上。
//
// 模块职责：把 BrowserControlPort 契约适配到无头 Chromium，承担后端身份、会话生命周期、取消与超时治理。
// 状态所有权：browser、context、session 与在飞请求全部由本类独占，调用方只持有描述符与结果，不得缓存 session。
// 阅读顺序：execute → ensureBrowser → ensureSession → executeSessionCommand → withMeta，最后看 closeSession 与 close 的回收路径。
// ============================================================
// 文件定位：托管无头 CDP 浏览器运行时：单例 Browser + 每 session 一个 Context + 每 tab 一个 Page。
// 输入输出：list 返回描述符数组；execute 按命令分派并附 elapsedMs/meta；close 释放全部资源。
// 副作用：动态加载 playwright-core、spawn Chromium 子进程、创建/关闭 context，订阅 abort 事件。
// 失败语义：所有命令失败都以 {ok:false,error} 返回而不抛出；close 有 1.5s 超时避免挂死。
// 不变量：browserId+generation 校验请求时效；迟到 launch 必须被关闭；session 关闭后禁止再登记。
// ============================================================
import { randomUUID } from "node:crypto";
import type {
  BrowserBackendDescriptor,
  BrowserCommand,
  BrowserCommandResult,
  BrowserControlExecuteInput,
  BrowserControlListInput,
  BrowserControlPort,
  BrowserErrorCode,
} from "@zcode/contracts";
import type { Browser } from "playwright-core";
import { createManagedCdpDescriptor } from "./descriptor.js";
import {
  loadPlaywrightChromium,
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
  type BrowserExecutableResolutionOptions,
  type PlaywrightChromiumModule,
} from "./executable.js";
import { executeManagedPageCommand } from "./page-command.js";
import { abortError, classifyError, hasSideEffects, raceWithAbort } from "./request.js";
import { ManagedCdpSession } from "./session.js";

// runtime 构造选项：在可执行文件解析选项之上，增加关闭超时与 Playwright 加载注入点。
export interface ManagedCdpBrowserRuntimeOptions extends BrowserExecutableResolutionOptions {
  // 单次 close 的最长等待（毫秒），默认 1.5s；超时即放弃等待而不阻塞退出。
  closeTimeoutMs?: number;
  // 测试注入：替换动态 import，避免真加载 playwright-core。
  loadPlaywright?: () => Promise<PlaywrightChromiumModule>;
}

// 对外产物：控制端口 + 关闭函数；调用方只依赖这两者，不感知内部 session 管理。
export interface ManagedCdpBrowserRuntime {
  browserControlPort: BrowserControlPort;
  close(): Promise<void>;
}

// 在飞请求：按 requestId 记录所属 session/turn，便于 turnEnded/closeSession 精准取消。
// [并发] 在飞请求只登记 controller 与归属的 sessionId、turnId，不持有 session 引用，避免请求反向延长会话生命周期。
// turnId 可缺省：非 turn 级命令只按 sessionId 取消。
interface PendingRequest {
  controller: AbortController;
  sessionId: string;
  turnId?: string;
}

// 默认关闭超时 1.5 秒：既覆盖正常 context 关闭，又不让退出流程被单个挂死页面拖住。
// [权衡] 该值只影响等待时长，不改变资源所有权；超时后由进程退出兜底回收子进程。
const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 1_500;

// 每个 runtime 实例即一个 backend：browserId 唯一，generation 随重连递增。
// 四个 Map 分别管理“进行中会话创建”“已完成会话”“在飞请求”“正在关闭的会话”，共同保证并发安全。
class ManagedCdpBrowserControlPort implements BrowserControlPort {
  readonly #browserId = `cdp:${randomUUID()}`;
  readonly #loadPlaywright: () => Promise<PlaywrightChromiumModule>;
  readonly #options: ManagedCdpBrowserRuntimeOptions;
  readonly #closeTimeoutMs: number;
  // [并发] 会话先进入此集合，再取消请求与关闭 context，形成「先标记后回收」的固定顺序。
  // 该集合是 ensureSession 拒绝复活的唯一依据，close 时整体清空。
  readonly #closingSessionIds = new Set<string>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #sessionPromises = new Map<string, Promise<ManagedCdpSession>>();
  readonly #sessions = new Map<string, ManagedCdpSession>();
  #browser: Browser | undefined;
  #disposed = false;
  #generation = 1;
  #launchPromise: Promise<Browser> | undefined;

  // 归一化关闭超时：至少 1ms，小数截断，避免 0 或负数导致计时器立即触发。
  // 构造只做依赖落位与超时归一化，不触碰 Playwright，因此工厂可在任何环境安全构造。
  // [资源] 注入 loadPlaywright 让测试无需真实拉起 Chromium，缺省走 executable 模块的动态加载。
  // [权衡] 超时下限取 1ms 而非 0，避免零延时定时器在关闭关键路径上立即判超时。
  constructor(options: ManagedCdpBrowserRuntimeOptions) {
    this.#options = options;
    this.#loadPlaywright = options.loadPlaywright ?? loadPlaywrightChromium;
    this.#closeTimeoutMs = Math.max(
      1,
      Math.trunc(options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS),
    );
  }

  // 列出后端：确保浏览器已启动（否则返回空描述符没有意义），仅返回当前这一个 backend。
  // list 是唯一会主动拉起浏览器的只读入口：先 ensureBrowser，再返回当前后端描述符。
  // [失败路径] 启动失败以异常抛给上层，list 不把失败包装成空数组，避免调用方误判后端不存在。
  async list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]> {
    await this.ensureBrowser(input.signal);
    return [this.descriptor()];
  }

  // 执行一条浏览器命令：身份校验 → 合并取消信号 → 确保浏览器/session → 派发 → 附 meta。
  // 任何异常都转成 errorResult；若已派发且有副作用，取消会标记 sideEffect=uncertain。
  async execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult> {
    const startedAt = Date.now();
    // browserId 或 generation 不匹配说明请求针对旧后端（浏览器已重连/已关闭），直接拒绝。
    // [失败路径] 身份不匹配直接返回 backend_unavailable，且不登记 pending，旧请求不会产生任何副作用。
    // 两个条件缺一不可：browserId 区分实例，generation 区分同一实例的重连代际。
    // [权衡] 拒绝发生在新请求登记之前，因此这里不需要回滚任何资源。
    if (input.browserId !== this.#browserId || input.browserGeneration !== this.#generation) {
      return this.errorResult(
        "backend_unavailable",
        `Browser backend '${input.browserId}' generation ${input.browserGeneration} is stale`,
        startedAt,
      );
    }

    const requestId = randomUUID();
    const controller = new AbortController();
    // 取消信号只转发到这个请求自己的 controller；同时登记 requestId 以支持按 session/turn 批量取消。
    const forwardAbort = () => controller.abort(input.signal?.reason ?? abortError());
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();
    this.#pending.set(requestId, {
      controller,
      sessionId: input.sessionId,
      turnId: input.turnId,
    });

    let dispatched = false;
    try {
      if (controller.signal.aborted) throw abortError();
      // 启动浏览器与建 session 都可能较慢，期间收到取消就不必再派发命令。
      await this.ensureBrowser(controller.signal);
      const session = await this.ensureSession(input.sessionId);
      if (controller.signal.aborted) throw abortError();
      // [并发] dispatched 只在真正进入命令执行前才置位，用于区分「尚未开始」与「可能已生效」。
      // 置位后若被取消，catch 分支才有资格把结果标成 uncertain。
      dispatched = true;
      const partial = await raceWithAbort(
        this.executeSessionCommand(session, input.command),
        controller.signal,
      );
      return await this.withMeta(session, input.command, partial, startedAt);
    } catch (error) {
      // 混合了纯读取与写操作的命令一旦被取消，无法确定是否已生效，只能标记为 uncertain。
      // [失败路径] classifyError 把取消、超时与 Playwright 错误映射为稳定错误码，上层不依赖错误文本做流程判断。
      // 对外只保留 message，底层 cause 不进入结果，避免把 profile 路径一类的内部信息透给模型。
      const code = classifyError(error);
      return this.errorResult(
        code,
        error instanceof Error ? error.message : String(error),
        startedAt,
        code === "cancelled" && dispatched && hasSideEffects(input.command)
          ? "uncertain"
          : undefined,
      );
    } finally {
      input.signal?.removeEventListener("abort", forwardAbort);
      this.#pending.delete(requestId);
    }
  }

  // 一个 turn 结束：取消该 session 该 turn 的所有在飞请求，避免旧 turn 的结果污染新 turn。
  // [并发] turnEnded 只取消同 session 同 turn 的在飞请求，不关闭会话，标签页状态因此可跨 turn 保留。
  // 直接遍历 pending 而不维护 turn 到请求的索引，请求规模由并发命令数天然约束。
  async turnEnded(input: BrowserControlListInput): Promise<void> {
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === input.sessionId && pending.turnId === input.turnId) {
        pending.controller.abort(abortError());
      }
    }
  }

  // 关闭一个 session：标记 closing、取消在飞请求、等在飞建 session 结束、关 context，空了就关浏览器。
  // 若建 session 的 promise 超时仍未结算，注册迟到回调，防止它在关闭后重新登记。
  async closeSession(input: BrowserControlListInput): Promise<void> {
    this.#closingSessionIds.add(input.sessionId);
    for (const pending of this.#pending.values()) {
      if (pending.sessionId === input.sessionId) pending.controller.abort(abortError());
    }
    const creating = this.#sessionPromises.get(input.sessionId);
    if (creating) {
      // [资源] 建会话期间被要求关闭时，先限时等待创建 promise，避免 context 建好后无人回收。
      // 未结算则不阻塞当前关闭调用，改为注册迟到回调，在创建最终结束时补做一次浏览器回收。
      // [并发] closingSessionIds 已先写入，因此迟到建出的 context 会被 ensureSession 的守卫拒绝登记。
      const settled = await waitForPromise(creating, this.#closeTimeoutMs);
      // 建 session 超时：等它最终完成/失败后再决定是否关浏览器，不阻塞当前 close 调用。
      if (!settled) {
        // late launch/context 创建完成后仍需再次回收；closingSessionIds 防止它重新登记 session。
        void creating.then(
          async () => {
            if (this.#sessions.size === 0) await this.closeBrowser();
          },
          async () => {
            if (this.#sessions.size === 0) await this.closeBrowser();
          },
        );
      }
    }
    const session = this.#sessions.get(input.sessionId);
    this.#sessions.delete(input.sessionId);
    if (session) await waitForPromise(session.close(), this.#closeTimeoutMs);
    if (this.#sessions.size === 0) await this.closeBrowser();
  }

  // 关闭整个 runtime：幂等；取消全部在飞请求，限时关闭所有 session/context 与 browser。
  // 额外等待“迟到的 launch”并关闭其结果，避免 Playwright 子进程泄漏。
  async close(): Promise<void> {
    // 关闭幂等：已处置的 runtime 再次 close 直接返回，不重复关 browser 也不重复清表。
    // [权衡] 幂等只依赖 #disposed 这一个标志，不把 browser 是否为空当成可变的前置条件。
    if (this.#disposed) return;
    this.#disposed = true;
    const launchPromise = this.#launchPromise;
    for (const pending of this.#pending.values()) pending.controller.abort(abortError());
    this.#pending.clear();
    this.#closingSessionIds.clear();
    await Promise.all(
      [...this.#sessionPromises.values()].map(async (promise) => {
        await waitForPromise(promise, this.#closeTimeoutMs);
      }),
    );
    await Promise.all(
      [...this.#sessions.values()].map(async (session) => {
        await waitForPromise(session.close(), this.#closeTimeoutMs);
      }),
    );
    this.#sessions.clear();
    await this.closeBrowser();
    // Playwright launch 可能仍在异步创建子进程；只关闭当前 #browser 会漏掉迟到进程。
    if (launchPromise) {
      await waitForPromise(
        launchPromise.then(async (browser) => this.closeBrowserInstance(browser)),
        this.#closeTimeoutMs,
      );
    }
  }

  // 当前后端描述符；generation 只有在浏览器断连重建时才会变化。
  private descriptor(): BrowserBackendDescriptor {
    return createManagedCdpDescriptor(this.#browserId, this.#generation);
  }

  // 确保存在已连接的 Browser：已连接直接复用；否则串行化一次 launch（#launchPromise 去重）。
  // 支持取消：signal 中途中止时会关闭已启动的 browser 并抛 AbortError，避免“取消却留下进程”。
  private async ensureBrowser(signal?: AbortSignal): Promise<Browser> {
    if (this.#disposed) throw new Error("Managed CDP browser runtime is closed");
    if (signal?.aborted) throw abortError();
    // [资源] 已连接即复用，只有断连或从未启动才进入 launch 分支，避免重复拉起进程。
    // #launchPromise 使用惰性赋值，保证同一时刻只有一个 launch 在飞。
    // [并发] 断连回调会把 #browser 置空，因此 isConnected 是复用前的必要条件而非可选优化。
    if (this.#browser?.isConnected()) return this.#browser;
    this.#launchPromise ??= (async () => {
      // 加载失败与启动失败分别包装：前者提示缺依赖，后者提示检查可执行文件/沙箱依赖。
      let playwright: PlaywrightChromiumModule;
      try {
        playwright = await this.#loadPlaywright();
      } catch (error) {
        throw new Error(
          "Managed headless Chromium is unavailable: failed to load the pinned Playwright runtime.",
          { cause: error },
        );
      }
      const executablePath = resolveInstalledBrowserExecutable(playwright, this.#options);
      let browser: Browser;
      try {
        // [资源] 固定无头模式并关闭首次运行与默认浏览器检查，减少首次启动的交互与外部网络行为。
        // 启动失败被包装为可操作提示并保留 cause，调用方可据此区分缺依赖与沙箱限制。
        browser = await playwright.chromium.launch({
          executablePath,
          headless: true,
          args: ["--no-first-run", "--no-default-browser-check"],
        });
      } catch (error) {
        // 底层 Playwright 错误可能包含临时 profile/CDP endpoint；对外只保留可操作分类，cause 供调试。
        throw new Error(
          "Managed headless Chromium is unavailable: launch failed. " +
            "Verify the browser executable and OS sandbox/runtime dependencies.",
          { cause: error },
        );
      }
      // launch 期间 runtime 已被 close：立即关闭刚拿到的 browser，防止孤儿 Chromium 进程。
      // [并发] launch 期间 runtime 可能已被关闭，这里必须立刻关闭刚拿到的 browser 再抛错。
      // 该分支与 close 中的迟到 launch 回收互为兜底，覆盖「先关后到」与「先到后关」两种顺序。
      if (this.#disposed) {
        await this.closeBrowserInstance(browser);
        throw new Error("Managed CDP browser runtime is closed");
      }
      // 断连后清空所有 session 并把 generation +1，使所有旧 tab/请求立即失效。
      // [失败路径] 断连是异步事实：先确认事件来自当前 browser，再清空会话表并递增 generation。
      // 只清空而不逐个关闭，因为连接已断，逐个关闭只会拉长失败路径且必然超时。
      browser.on("disconnected", () => {
        if (this.#browser !== browser) return;
        this.#browser = undefined;
        this.#sessions.clear();
        this.#generation += 1;
      });
      this.#browser = browser;
      return browser;
    })().finally(() => {
      this.#launchPromise = undefined;
    });
    const browser = signal
      ? await raceWithAbort(this.#launchPromise, signal)
      : await this.#launchPromise;
    if (signal?.aborted) {
      await this.closeBrowserInstance(browser);
      throw abortError();
    }
    return browser;
  }

  // 取得或创建 session（一个 session 对应一个独立 BrowserContext）。
  // 并发创建通过 #sessionPromises 合并；closing 中的 session 立即拒绝，防止关闭后又复活。
  // [并发] 同一 sessionId 的并发创建共用 #sessionPromises 中的同一个 promise，避免重复建 context。
  // 命中 closingSessionIds 时立刻抛错，这是「关闭后禁止复活」的唯一入口守卫。
  // [资源] promise 在 finally 中按同一性删除，防止旧 promise 误删后一次创建的登记。
  private async ensureSession(sessionId: string): Promise<ManagedCdpSession> {
    if (this.#closingSessionIds.has(sessionId)) {
      throw new Error(`Browser session '${sessionId}' is closing`);
    }
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const creating = this.#sessionPromises.get(sessionId);
    if (creating) return await creating;

    const promise = (async () => {
      const browser = await this.ensureBrowser();
      const generation = this.#generation;
      const context = await browser.newContext({
        acceptDownloads: false,
        viewport: { width: 1280, height: 720 },
      });
      // 创建期间浏览器可能已断连/重建/开始关闭：此时丢弃刚建好的 context，避免“幽灵 session”。
      if (
        this.#disposed ||
        this.#closingSessionIds.has(sessionId) ||
        this.#browser !== browser ||
        this.#generation !== generation ||
        !browser.isConnected()
      ) {
        await waitForPromise(context.close(), this.#closeTimeoutMs);
        throw new Error("Managed CDP browser context became unavailable during creation");
      }
      const session = new ManagedCdpSession(context);
      this.#sessions.set(sessionId, session);
      return session;
    })();
    this.#sessionPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.#sessionPromises.get(sessionId) === promise) {
        this.#sessionPromises.delete(sessionId);
      }
    }
  }

  // 命令分派：非页面级命令走 session 管理，其余交给 page-command 执行。
  // 明确列出的“不支持命令”统一返回 capability_unsupported，而不是让 Playwright 抛晦涩错误。
  private async executeSessionCommand(
    session: ManagedCdpSession,
    command: BrowserCommand,
  ): Promise<Omit<BrowserCommandResult, "elapsedMs">> {
    switch (command.method) {
      case "list":
        return { ok: true, tabs: await session.listTabs() };
      case "newTab": {
        const tab = await session.createTab();
        return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
      }
      case "activateTab": {
        const tab = await session.activateTab(command.tabId);
        return { ok: true, tab: (await session.listTabs()).find((item) => item.tabId === tab.id) };
      }
      case "close":
        await session.closeTab(command.tabId);
        return { ok: true };
      case "browserViewportSet":
        await session.setViewport(command.tabId, { width: command.width, height: command.height });
        return { ok: true };
      case "browserViewportReset":
        await session.setViewport(command.tabId, null);
        return { ok: true };
      // 无 dialog 时也要返回 null 而不是报错：getDialog 是查询语义，不是动作。
      // getDialog 是查询语义：没有待处理对话框时返回 dialog 为 null，而不是抛错。
      // 只接受四种对话框类型，类型不在白名单时同样按无对话框处理，避免把未知类型透给上层。
      case "getDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        const type = dialog?.type();
        return {
          ok: true,
          dialog:
            dialog && type && ["alert", "confirm", "prompt", "beforeunload"].includes(type)
              ? {
                  type: type as "alert" | "confirm" | "prompt" | "beforeunload",
                  message: dialog.message(),
                  ...(dialog.defaultValue() ? { defaultPrompt: dialog.defaultValue() } : {}),
                }
              : null,
        };
      }
      case "handleDialog": {
        const tab = await session.ensureTab(command.tabId);
        const dialog = session.dialogFor(tab.id);
        if (!dialog) throw new Error("No JavaScript dialog is pending for this tab");
        if (command.accept) await dialog.accept(command.promptText);
        else await dialog.dismiss();
        session.clearDialog(tab.id);
        return { ok: true };
      }
      case "nameSession":
        return { ok: true };
      case "listUserTabs":
        return { ok: true, userTabs: [] };
      case "browserVisibilityGet":
      case "browserVisibilitySet":
      case "capabilities":
      case "claimTab":
      case "finalize":
      case "finalizeTabs":
      case "markDeliverable":
      case "markHandoff":
      case "turnEnded":
      case "closeSession":
      case "cancelRequest":
        return {
          ok: false,
          error: {
            code: "capability_unsupported",
            message: `Browser command '${command.method}' is unavailable in managed headless CDP`,
          },
        };
      // 页面级命令统一交给 executeManagedPageCommand，本类只负责取标签页与透传结果。
      // [权衡] 不支持的命令在显式 case 中集中返回 capability_unsupported，默认分支只承接真正的页面动作。
      // 取标签页时兼容不带 tabId 的命令，把缺省值交给会话的活动标签页解析。
      default: {
        const tab = await session.ensureTab("tabId" in command ? command.tabId : undefined);
        return await executeManagedPageCommand(tab.page, command);
      }
    }
  }

  // 给结果补 elapsedMs 与 meta：包含后端身份、当前打开的 tab 集合与活动 tab 的 url/lifecycle。
  // active tab 解析失败不视为命令失败（catch 成 undefined），meta 始终可返回。
  private async withMeta(
    session: ManagedCdpSession,
    command: BrowserCommand,
    partial: Omit<BrowserCommandResult, "elapsedMs">,
    startedAt: number,
  ): Promise<BrowserCommandResult> {
    // meta 的 tabId 优先取命令指定值，其次取活动标签页；两者都没有时 meta 不包含 tabId。
    // [失败路径] 活动标签页解析失败被收敛为 undefined，meta 仍可返回，不让元数据缺失掩盖命令本身的结果。
    const tabId = "tabId" in command ? command.tabId : session.activeTabId;
    const active = tabId ? await session.ensureTab(tabId).catch(() => undefined) : undefined;
    return {
      ...partial,
      elapsedMs: Date.now() - startedAt,
      meta: {
        browserUse: true,
        backendType: "cdp",
        browserId: this.#browserId,
        browserGeneration: this.#generation,
        openTabIds: session.tabIds,
        ...(active ? { tabId: active.id, currentUrl: active.page.url(), lifecycle: "active" } : {}),
      },
    };
  }

  // 统一失败结果构造；sideEffect 只在确实可能已生效时出现，避免调用方误判“确定未执行”。
  private errorResult(
    code: BrowserErrorCode,
    message: string,
    startedAt: number,
    sideEffect?: "uncertain",
  ): BrowserCommandResult {
    return {
      ok: false,
      error: { code, message, ...(sideEffect ? { sideEffect } : {}) },
      elapsedMs: Date.now() - startedAt,
    };
  }

  // 先摘掉引用再关闭，避免关闭过程中并发 ensureBrowser 又复用这个已关闭实例。
  private async closeBrowser(): Promise<void> {
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser) await this.closeBrowserInstance(browser);
  }

  // 关闭单个 browser，限时等待：WebSocket/SSE 页面可能让 close 永不 settle，不能无限阻塞 CLI 退出。
  private async closeBrowserInstance(browser: Browser): Promise<void> {
    if (!browser.isConnected()) return;
    // WebSocket/SSE 页面可能让 Playwright 的 context/browser close 永不 settle。
    // adapter 只能有限等待；外层 session cleanup 和 CLI watchdog 会继续回收其它资源。
    // [资源] browser 关闭必须限时：WebSocket 或 SSE 页面可能让关闭永不结算，不能无限阻塞 CLI 退出。
    // 未连接时直接返回，避免对已断开的实例再发起关闭。
    // [权衡] 超时后放弃等待而非强杀进程，进程层 watchdog 负责最终回收，adapter 不越权处理进程信号。
    await waitForPromise(browser.close(), this.#closeTimeoutMs);
  }
}

// 工厂：构造前先校验显式可执行路径（非法时立即抛出，而不是拖到首次命令才失败）。
// 返回对象把 close 收敛为 port.close，保证 runtime 只有一个关闭入口。
export function createManagedCdpBrowserRuntime(
  options: ManagedCdpBrowserRuntimeOptions = {},
): ManagedCdpBrowserRuntime {
  // 工厂在构造前校验显式可执行路径：非法值立即抛出，错误停在调用栈近处。
  // 返回对象把 close 收敛为唯一关闭入口，调用方无法绕过 port 直接操作内部状态。
  const normalizedOptions = {
    ...options,
    executablePath: validateExplicitBrowserExecutable(options.executablePath, options.platform),
  };
  const port = new ManagedCdpBrowserControlPort(normalizedOptions);
  return {
    browserControlPort: port,
    close: async () => port.close(),
  };
}

export {
  resolveInstalledBrowserExecutable,
  validateExplicitBrowserExecutable,
} from "./executable.js";
export type { BrowserExecutableResolutionOptions, PlaywrightChromiumModule } from "./executable.js";
export { isAllowedManagedBrowserUrl } from "./page-command.js";

// 限时等待 promise 结算：成功/失败都算 settled=true；超时 settled=false 且不取消原 promise。
// 计时器未 unref：这里短暂的 1.5s 等待属于关闭关键路径，需要保持事件循环。
function waitForPromise(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(completed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
