/**
 * ============================================================================
 * hooks/runner.ts —— Hook 执行器(匹配 → 授权 → 顺序执行 → 事件)
 * ============================================================================
 *
 * 【一次 run 的流程】
 *   1. 按 hookEventName + matcher 过滤出候选 hook;
 *   2. 预扫描 admission,剔除 skipLifecycle 的 hook,并算出"客户端可见"的 hookCount;
 *   3. 逐个 dispatch:
 *        - dispatch 前**重新**解析授权(前序 hook 运行期间可能发生 revoke/policy 收紧);
 *        - blocked → 只发 HookRunBlocked,不执行;
 *        - async hook → 启动后台执行并立即继续(其输出不得反向改变已继续的动作);
 *        - 同步 hook → 带 timeout/取消执行,输出合并进 HookRunResult,并发完成/阻断/失败事件。
 *
 * 【安全边界】
 *   授权决定不得缓存(注释里反复强调的 security revision):预扫描只用于跳过与计数,
 *   真正的 allowed 必须在每个 hook 执行前重新计算。
 *   所有进入事件/日志的文本都要 sanitize(凭证掩码 + 长度截断)。
 *
 * 【事件】每个 hook 都有 HookRunStarted/Completed/Failed/Blocked 之一,
 *   用 hookInvocationId 归组同一次 run,用 hookRunId 标识单条 hook,
 *   hookIndex 是"客户端可见序号"(跳过 skipLifecycle 后连续),不是内部数组下标。
 * ============================================================================
 */
// 文件头：core 包的工作区钩子执行器，负责候选匹配、授权重验、串行与后台执行、终态事件上报。
// 阅读顺序：先看 INV 建立边界，再看 run 主循环的四个阶段，最后看超时与诊断截断的细节。
// INV-01 事件名必须与注册时固定的 hook.event 完全相等，matcher 只做二次过滤；守住位置：run 的 matchingHooks 过滤；改错故障：近义事件被误触发，用户看到不属于该事件的 Hook 执行记录。
// INV-02 hookInvocationId 一次 run 只生成一次，所有单条 hook 事件共用；守住位置：run 开头的随机 id 赋值；改错故障：同一次事件被拆成多条链路，UI 无法归组这一批 Hook。
// INV-03 hookRunId 每条 hook 独立生成，不跨 hook 复用；守住位置：主循环内的随机 id；改错故障：两条 Hook 事件互相覆盖，审计无法定位具体执行。
// INV-04 预扫描 admission 只用于 skipLifecycle 剔除与计数，allowed 不得沿用；守住位置：participatingHooks 构建循环；改错故障：前序 Hook 运行期间 revoke 失效，已撤销的 Hook 仍被执行。
// INV-05 每条 Hook 实际 dispatch 前必须重新计算 admission；守住位置：主循环内第二次 admission 解析；改错故障：策略收紧后仍执行被禁止的 Hook，形成安全越权。
// INV-06 hookCount 必须等于客户端可见且会发事件的 Hook 数；守住位置：clientVisibleHookCount 的 filter；改错故障：进度分母偏大，用户以为 Hook 卡住不动。
// INV-07 hookIndex 是客户端可见序号，隐藏 hook 复用内部下标；守住位置：hookIndex 的三元取值；改错故障：序号跳号或重号，UI 列表错位。
// INV-08 admission 拒绝时只发 HookRunBlocked，且不进入 callback；守住位置：未授权分支的 continue；改错故障：未授权 Hook 仍产生副作用。
// INV-09 async hook 启动后台执行后立即继续，输出不得回改本轮结果；守住位置：hook.async 分支；改错故障：后台 Hook 的 deny 反向阻断已经继续的动作。
// INV-10 后台执行必须有 catch 兜底上报，避免未处理的 rejection；守住位置：后台调用后的 catch；改错故障：进程因未处理拒绝退出或静默丢事件。
// INV-11 同步 hook 严格串行，前一条终态事件发出后才进入下一条；守住位置：for-await 循环与超时执行调用；改错故障：并发执行导致输出合并顺序错乱。
// INV-12 单条 Hook 失败只记录 HookRunFailed 与 warn，不得中断整批；守住位置：主循环内的 try 分支；改错故障：一条坏 Hook 让其余 Hook 全部不执行。
// INV-13 每条 hook 使用独立 AbortController，父信号单向转发；守住位置：超时执行函数内的 controller 与 linkAbortSignal；改错故障：一个 Hook 取消连带取消同批其它 Hook。
// INV-14 超时必须由专属 reason 触发 abort 并区分于用户取消；守住位置：定时器与 abort 监听；改错故障：超时被报成 cancelled，用户按提示重试仍然失败。
// INV-15 超时定时器与父信号监听必须在 finally 清理；守住位置：超时执行函数的 finally 段；改错故障：长会话累积监听器并触发内存告警。
// INV-16 超时定时器 unref，不得阻止进程退出；守住位置：定时器创建后的 unref 调用；改错故障：CLI 退出后仍挂住，需要用户强杀。
// INV-17 进入事件与诊断文本必须 sanitize 并截断 4000 字符；守住位置：sanitizeHookDiagnostics 与显示文本清洗；改错故障：凭证或超长 stderr 进入持久化事件。
// INV-18 无事件出口时仍执行并合并结果，只是不发事件；守住位置：事件发送函数的提前返回；改错故障：测试或无 runtime 场景下 Hook 被整体跳过。
//
import {
  HookOutcome,
  SessionEventType,
  isCoreError,
  traceContextToLogContext,
  type HookExecutionDescriptor,
  type HookInput,
  type HookJSONOutput,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
// 输出归一化与结果合并交给 ./output.js，本文件只负责调度顺序与事件。
// 新增事件类型时先确认该模块已有对应解析分支，否则输出会被当成无操作。
import { mergeHookRunResult, processHookOutput } from "./output.js";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import {
  HOOK_TIMEOUT_ABORT_REASON,
  createHookCancelledError,
  createHookTimeoutError,
  linkAbortSignal,
  matchesAnyHookMatcher,
  readHookErrorMessage,
  resolveHookDescriptor,
  resolveHookFailureOutcome,
  resolveHookRunAdmission,
} from "./runner-helpers.js";
import type {
  HookRegistration,
  HookCallbackDiagnostics,
  HookCallbackResult,
  HookRunOptions,
  HookRunResult,
  HookRunner,
  HookRunnerOptions,
} from "./types.js";

// 内存实现的持有者：hooks 数组是唯一注册入口，构造时复制入参，避免外部数组后续被改写。
// 注册只做追加、不加锁：依赖调用方在启动期完成注册，run 期间不新增 Hook。
export class InMemoryHookRunner implements HookRunner {
  private readonly defaultTimeoutMs: number;
  private readonly emitEvent?: (event: SessionEvent) => Promise<void>;
  private readonly hooks: HookRegistration[];
  private readonly logger?: Logger;

  constructor(options: HookRunnerOptions = {}) {
    // [权衡] 默认 60 秒：够慢 Hook 跑完，又不至于让 turn 长时间无反馈。
    // hook.timeoutMs 可在注册时覆盖该默认值，覆盖粒度是单条 Hook 而不是全局。
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.emitEvent = options.emitEvent;
    this.hooks = [...(options.hooks ?? [])];
    this.logger = options.logger;
  }

  register(hook: HookRegistration): void {
    this.hooks.push(hook);
  }

  // 主线四段：筛出候选 → 预扫描剔除与计数 → 逐条 dispatch → 返回合并结果。
  // run 不向调用方抛出 Hook 执行错误，所有失败都落成事件或 warn 日志，主流程继续。
  async run(input: HookInput, options: HookRunOptions = {}): Promise<HookRunResult> {
    // matcher 匹配用 matchesAnyHookMatcher:同一 hook 可配置多个兼容模式,
    // 事件名必须完全一致(hook.event 是注册时固定的)。
    const matchingHooks = this.hooks.filter(
      // 事件名用严格相等，不做前缀或模糊匹配；matcher 允许配置多个兼容模式。
      // 过滤保持注册顺序，后续执行顺序与之相同，不存在隐式重排。
      (hook) => hook.event === input.hookEventName && matchesAnyHookMatcher(options, hook.matcher),
    );
    const result: HookRunResult = {
      additionalContexts: [],
    };
    // hookInvocationId 标识"这一次 run":同一次事件里所有 hook 的事件都共用它,
    // 便于 UI/日志把一条链路归组;hookRunId 才是单条 hook 的 id。
    // 一次 run 一个 invocation id，单条 hook 另有 hookRunId，两者不可混用。
    // id 直接取全局 crypto，便于测试只断言形态而不注入依赖。
    const hookInvocationId = crypto.randomUUID();

    // skipLifecycle 的 hook 不发事件，不能计入客户端等待完成的 hookCount。
    // 修复：先解析全部 matchingHooks 的 admission，把 skipLifecycle 的从参与列表
    // 剔除后再计算 clientVisibleHookCount，保证 hookCount === 实际会发事件的 hook 数。
    //
    // 注意：这里的 admission 结果只用于 skipLifecycle 剔除与 hookCount 计算——
    // 二者取决于「配置是否启用」这一稳定属性。allowed 授权决定绝不能沿用本阶段的
    // 缓存：一次事件匹配多个顺序执行的 Hook 时，前序 Hook 运行期间发生的
    // revoke / policy 收紧 / trust store reload 必须对尚未开始的 Hook 立即生效，
    // 因此循环内在每个 Hook 实际 dispatch 前重新调用 resolveHookRunAdmission。
    const participatingHooks: { hook: HookRegistration }[] = [];
    for (const hook of matchingHooks) {
      // 预扫描只关心 skipLifecycle：被跳过的 Hook 不占客户端序号也不发事件。
      // 此处拿到的 allowed 只是一次性快照，主循环内必须重算，见下一处同名解析。
      // [事务] 一段 run 内的授权结论不可复用，越靠近执行点越可信。
      const admission = resolveHookRunAdmission(hook, input, this.logger);
      if (admission.skipLifecycle) continue;
      participatingHooks.push({ hook });
    }

    // hookCount 是终态事件的公共字段，也是 UI 进度分母，必须与实际发事件数一致。
    // 隐藏 Hook 仍会被执行，只是不参与计数与可见序号。
    const clientVisibleHookCount = participatingHooks.filter(
      ({ hook }) => resolveHookDescriptor(hook, this.defaultTimeoutMs, input).clientVisible,
    ).length;
    let clientVisibleHookIndex = 0;

    for (const [runtimeIndex, { hook }] of participatingHooks.entries()) {
      const descriptor = resolveHookDescriptor(hook, this.defaultTimeoutMs, input);
      // 两个下标:
      //   clientVisibleHookIndex 是"用户能看到的第几条"(连续,跳过隐藏 hook);
      //   runtimeIndex 是内部顺序(隐藏 hook 复用运行时下标,不占用户序号)。
      // 双下标设计：用户序号连续递增，内部下标保留原始位置以便排障。
      // 隐藏 hook 复用内部下标，可能与相邻可见 Hook 同号，但语义不同不会混淆。
      const hookIndex = descriptor.clientVisible ? clientVisibleHookIndex++ : runtimeIndex;
      const hookRunId = crypto.randomUUID();
      const startedAt = Date.now();
      // dispatch 前重新解析授权决定。预扫描结果可能已过时——前序 Hook
      // 执行期间用户 revoke、管理员收紧 policy 或 trust store reload 都会改变
      // 结论。security revision 的价值就在执行边界重验，授权决定不得缓存。
      // 执行边界重验：前序 Hook 运行期间可能发生 revoke、policy 收紧或 trust store reload。
      // [事务] 授权决定不得缓存，这里重算是安全边界而不是性能浪费。
      // 重验结果只对本条 Hook 有效，不得回写给后续 Hook 复用。
      const admission = resolveHookRunAdmission(hook, input, this.logger);
      // [失败路径] 拒绝即跳过：只发 HookRunBlocked，携带 reasonCode 与 Blocked 结局。
      // 阻断原因同样经过展示文本清洗，避免策略内部标识直接暴露给客户端。
      if (!admission.allowed) {
        await this.emitHookEvent(
          SessionEventType.HookRunBlocked,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs: 0,
            errorCode: admission.reasonCode,
            outcome: HookOutcome.Blocked,
            ...(admission.reasonCode
              ? { blockReason: sanitizeHookDisplayText(admission.reasonCode) }
              : {}),
          },
        );
        continue;
      }
      await this.emitHookEvent(
        SessionEventType.HookRunStarted,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
      );

      // [并发] 异步 Hook 在后台跑，当前 turn 立即继续，不等待其完成。
      // [权衡] 代价是异步 Hook 的 deny 无法回滚已继续的动作，因此只允许非阻断类事件注册为异步。
      // 后台任务的异常由兜底 catch 记录，不向调用方冒泡。
      if (hook.async) {
        // async command 的生命周期独立于当前 turn；输出不得反向改变已经继续执行的动作。
        void this.runBackgroundHook({
          clientVisibleHookCount,
          descriptor,
          hook,
          hookIndex,
          hookInvocationId,
          hookRunId,
          input,
          parentSignal: options.signal,
          runtimeIndex,
          startedAt,
        }).catch((error) => {
          this.logger?.warn("Async hook lifecycle reporting failed", {
            ...traceContextToLogContext({
              traceId: input.traceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
            }),
            error: error instanceof Error ? error.message : String(error),
            event: "hook.run.async_reporting_failed",
            hookEventName: input.hookEventName,
            hookIndex,
            module: "core.hooks",
            source: hook.source,
          });
        });
        continue;
      }

      try {
        // 同步 Hook 在这里串行等待：前一条的输出合并与终态事件完成后才进入下一条。
        // 串行是有意为之，多条 Hook 的输出合并顺序必须稳定可重放。
        const callbackResult = await this.runCallbackWithTimeout(
          hook,
          input,
          runtimeIndex,
          options.signal,
        );
        const { output, diagnostics } = unwrapHookCallbackResult(callbackResult);
        const durationMs = Date.now() - startedAt;
        // 输出解析按事件类型分流，非法或空输出视为无操作而不是失败。
        // 合并只追加上下文、不覆盖已有字段，避免后一条 Hook 抹掉前一条的结论。
        const processed = processHookOutput(input.hookEventName, output);
        mergeHookRunResult(result, processed);
        // 四类阻断信号任一成立即视为阻断：权限 deny、请求结果 deny、阻止继续、显式阻断请求。
        // 判定先于事件发送，事件类型在 Blocked 与 Completed 之间二选一。
        const blocked =
          processed.permissionBehavior === "deny" ||
          processed.permissionRequestResult?.behavior === "deny" ||
          processed.preventContinuation ||
          processed.blockRequested;
        // 阻断原因必须随终态事件进入持久化投影；只放在 TurnResult/tooltip 会在
        // 重放或移动端恢复时丢失，用户无法从 Hooks 明细判断是哪条 Hook 拦截了请求。
        const blockReason = blocked
          ? sanitizeHookDisplayText(
              processed.stopReason ??
                processed.hookPermissionDecisionReason ??
                (processed.permissionRequestResult?.behavior === "deny"
                  ? processed.permissionRequestResult.message
                  : undefined) ??
                "Hook blocked execution",
            )
          : undefined;
        // [权衡] 只在阻断时保留诊断，成功路径不落 stdout/stderr 预览，控制持久化体积。
        // 副作用是成功 Hook 的排障信息只能查日志，不再随事件回放。
        const safeDiagnostics = blocked ? sanitizeHookDiagnostics(diagnostics) : undefined;

        await this.emitHookEvent(
          blocked ? SessionEventType.HookRunBlocked : SessionEventType.HookRunCompleted,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs,
            outcome: blocked ? HookOutcome.Blocked : HookOutcome.Success,
            ...(blockReason ? { blockReason } : {}),
            ...(safeDiagnostics?.errorMessage
              ? { errorMessage: safeDiagnostics.errorMessage }
              : {}),
            ...(safeDiagnostics?.stderrPreview
              ? { stderrPreview: safeDiagnostics.stderrPreview }
              : {}),
            ...(safeDiagnostics?.stdoutPreview
              ? { stdoutPreview: safeDiagnostics.stdoutPreview }
              : {}),
          },
        );
      // [失败路径] 单条 Hook 的异常在此收口，循环继续执行后续 Hook。
      // 错误消息清洗后同时作为 errorMessage 与 stderrPreview 上报。
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        // 错误到结局的映射集中在 helpers：超时、取消、失败各自有稳定语义。
        // 不靠错误文本判类型，避免提示语调整导致分支失效。
        const outcome = resolveHookFailureOutcome(error);
        const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
        await this.emitHookEvent(
          SessionEventType.HookRunFailed,
          input,
          hookInvocationId,
          hookRunId,
          hookIndex,
          clientVisibleHookCount,
          hook,
          descriptor,
          startedAt,
          {
            durationMs,
            errorCode: isCoreError(error) ? error.code : undefined,
            errorMessage,
            outcome,
            stderrPreview: errorMessage,
          },
        );

        this.logger?.warn("Hook execution failed", {
          ...traceContextToLogContext({
            traceId: input.traceId,
            sessionId: input.sessionId,
            turnId: input.turnId,
          }),
          durationMs,
          event: "hook.run.failed",
          hookEventName: input.hookEventName,
          hookIndex,
          matcher: hook.matcher,
          module: "core.hooks",
          source: hook.source,
        });
      }
    }

    return result;
  }

  private async runBackgroundHook(options: {
    clientVisibleHookCount: number;
    descriptor: HookExecutionDescriptor;
    hook: HookRegistration;
    hookIndex: number;
    hookInvocationId: string;
    hookRunId: string;
    input: HookInput;
    parentSignal: AbortSignal | undefined;
    runtimeIndex: number;
    startedAt: number;
  }): Promise<void> {
    const {
      clientVisibleHookCount,
      descriptor,
      hook,
      hookIndex,
      hookInvocationId,
      hookRunId,
      input,
      parentSignal,
      runtimeIndex,
      startedAt,
    } = options;
    try {
      await this.runCallbackWithTimeout(hook, input, runtimeIndex, parentSignal);
      await this.emitHookEvent(
        SessionEventType.HookRunCompleted,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
        {
          durationMs: Date.now() - startedAt,
          outcome: HookOutcome.Success,
        },
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const outcome = resolveHookFailureOutcome(error);
      const errorMessage = sanitizeHookDisplayText(readHookErrorMessage(error));
      await this.emitHookEvent(
        SessionEventType.HookRunFailed,
        input,
        hookInvocationId,
        hookRunId,
        hookIndex,
        clientVisibleHookCount,
        hook,
        descriptor,
        startedAt,
        {
          durationMs,
          errorCode: isCoreError(error) ? error.code : undefined,
          errorMessage,
          outcome,
          stderrPreview: errorMessage,
        },
      );
      this.logger?.warn("Async hook execution failed", {
        ...traceContextToLogContext({
          traceId: input.traceId,
          sessionId: input.sessionId,
          turnId: input.turnId,
        }),
        durationMs,
        event: "hook.run.async_failed",
        hookEventName: input.hookEventName,
        hookIndex,
        matcher: hook.matcher,
        module: "core.hooks",
        source: hook.source,
      });
    }
  }

  // 每条 Hook 独立超时与取消：controller 不复用，定时器只属于本条 Hook。
  // 超时即 abort：先以超时 reason 中止信号，再拒绝超时错误，双路径保证调用方不会悬挂。
  // callback 可能是同步返回、同步抛错或 promise，统一被归一成同一种结果。
  private async runCallbackWithTimeout(
    hook: HookRegistration,
    input: HookInput,
    hookIndex: number,
    parentSignal?: AbortSignal,
  ): Promise<HookJSONOutput | HookCallbackResult | void> {
    const timeoutMs = hook.timeoutMs ?? this.defaultTimeoutMs;
    // 每个 hook 独立 controller + 单一 timeout:
    // parentSignal 通过 linkAbortSignal 单向转发(取消也会中止 hook),
    // timeout 用专属 reason,便于下面区分"超时"与"用户取消"。
    const controller = new AbortController();
    const unlink = linkAbortSignal(parentSignal, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<HookJSONOutput | HookCallbackResult | void>((resolve, reject) => {
        if (controller.signal.aborted) {
          // 进入时就已取消:连 callback 都不调用,避免副作用已经发生时才发现被取消。
          reject(createHookCancelledError());
          return;
        }

        timer = setTimeout(() => {
          controller.abort(HOOK_TIMEOUT_ABORT_REASON);
          reject(createHookTimeoutError(timeoutMs));
        }, timeoutMs);
        // unref:超时定时器不应阻止进程退出;hook 本身由 callback 的 promise 持有。
        // [资源] timer.unref 只对 Node 的 Timeout 生效：定时器不阻止进程退出，hook 的存活仍由 callback 的 promise 保证。
        // 部分运行时不提供 unref，用可选调用兼容。
        timer.unref?.();

        controller.signal.addEventListener(
          "abort",
          () => {
            // 同一个 abort 事件有两种来源,错误类型必须区分:
            // timeout reason → HookTimeout;其它(父取消)→ HookCancelled。
            reject(
              // 同一个 abort 事件有两种来源，必须按 reason 区分超时与用户取消。
              // reason 用常量字符串而非错误对象，跨模块比较不依赖引用。
              controller.signal.reason === HOOK_TIMEOUT_ABORT_REASON
                ? createHookTimeoutError(timeoutMs)
                : createHookCancelledError(),
            );
          },
          { once: true },
        );

        // Promise.resolve 包裹:callback 可能是同步返回/抛错,也统一成 promise 语义。
        Promise.resolve(hook.callback(input, { hookIndex, signal: controller.signal })).then(
          resolve,
          reject,
        );
      });
    } finally {
      // 无论成功/失败都清理 timer 与 parent signal 监听,避免长会话里累积监听器。
      // [资源] finally 里清理定时器与父信号监听，长会话下监听器不会累积。
      // 清理与成败无关，提前返回的分支也必须走到这里。
      if (timer) clearTimeout(timer);
      unlink();
    }
  }

  private async emitHookEvent(
    type: SessionEventType,
    input: HookInput,
    hookInvocationId: string,
    hookRunId: string,
    hookIndex: number,
    hookCount: number,
    hook: HookRegistration,
    descriptor: HookExecutionDescriptor,
    startedAt: number,
    extra: Partial<SessionEvent["payload"] & Record<string, unknown>> = {},
  ): Promise<void> {
    // 没有事件出口时不发事件(测试/无 runtime 场景),但执行与结果合并照常进行。
    // 没有事件出口时直接返回，执行与结果合并照常发生，只是客户端看不到事件。
    // 测试与无 runtime 场景依赖该分支，不要改成抛错或跳过执行。
    if (!this.emitEvent) return;
    await this.emitEvent({
      id: crypto.randomUUID() as any,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type,
      // Started 用真实开始时刻(执行前就记录),终态用当前时刻:
      // 这样 UI 的"耗时"以事件时间差为准,不会因事件排队而失真。
      timestamp: type === SessionEventType.HookRunStarted ? new Date(startedAt) : new Date(),
      traceId: input.traceId,
      sequenceNumber: 0,
      payload: {
        agentName: input.agentName,
        descriptor,
        hookEventName: input.hookEventName,
        hookIndex,
        hookCount,
        hookInvocationId,
        hookRunId,
        hookSource: hook.source,
        matcher: hook.matcher,
        // 不同 HookEvent 的 input 形状不同:权限事件带 requestId,工具事件带 toolCallId。
        // 用 in 收窄而不是断言,缺失时保持 undefined 而不是伪造字段。
        requestId: "requestId" in input ? input.requestId : undefined,
        startedAt,
        toolCallId: "toolCallId" in input ? input.toolCallId : undefined,
        toolName: "toolName" in input ? input.toolName : undefined,
        ...extra,
      },
    });
  }
}

function unwrapHookCallbackResult(result: HookJSONOutput | HookCallbackResult | void): {
  output: HookJSONOutput | undefined;
  diagnostics: HookCallbackDiagnostics | undefined;
} {
  if (isHookCallbackResult(result)) {
    return { output: result.output, diagnostics: result.diagnostics };
  }
  return { output: result as HookJSONOutput | undefined, diagnostics: undefined };
}

function isHookCallbackResult(value: unknown): value is HookCallbackResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "hookCallbackResult",
  );
}

function sanitizeHookDiagnostics(
  diagnostics: HookCallbackDiagnostics | undefined,
): HookCallbackDiagnostics | undefined {
  if (!diagnostics) return undefined;
  // 三个字段都先 trim → sanitize(掩码敏感值)→ 截断 4000 字符:
  // 诊断会进事件并被持久化,不能把完整凭证或超长 stderr 原样带出去。
  const sanitize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? sanitizeHookDisplayText(trimmed).slice(0, 4000) : undefined;
  };
  const errorMessage = sanitize(diagnostics.errorMessage);
  const stderrPreview = sanitize(diagnostics.stderrPreview);
  const stdoutPreview = sanitize(diagnostics.stdoutPreview);
  if (!errorMessage && !stderrPreview && !stdoutPreview) return undefined;
  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
  };
}

export function createInMemoryHookRunner(options?: HookRunnerOptions): InMemoryHookRunner {
  return new InMemoryHookRunner(options);
}
