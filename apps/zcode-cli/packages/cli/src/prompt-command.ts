// 职责边界：headless（zcode -p）单次 prompt 运行的编排入口：参数到 app 的装配、slash
// 命令分流、提交流与结果投影、进程级资源的对称回收；这里的“顺序”本身就是契约。
// 不负责：命令语义解析（command-center）、事件形状与投影（headless-workflow）、会话内部生命周期（core app）。
//
// 不变量（INV）：每条断言都有对应的线上症状，动刀前先读“改错故障”列。
// INV-01 断言：空 prompt 必须在校验阶段直接返回 1，绝不建 app —— 守住它的位置：runPrompt 开头的 trim 检查 —— 改错故障：空文本被当合法请求提交给模型，脚本拿到 0 退出码。
// INV-02 断言：显式 --output-format 永远压过 --json —— 守住它的位置：wantsJsonSummary —— 改错故障：--output-format text 仍打印 JSON 摘要，调用方解析到意外结构。
// INV-03 断言：stream-json 的最后一行是 result，其后不得再有任何事件行 —— 守住它的位置：streamsEvents 分支与 stopObservingEvents —— 改错故障：流式解析方在终止符之后读到事件，判定协议错误。
// INV-04 断言：常驻订阅与 per-turn onEvent 绝不同时挂载 —— 守住它的位置：detachEvents 决定是否传 onEvent —— 改错故障：同一条事件被两个 sink 各写一次，NDJSON 出现重复行。
// INV-05 断言：事件订阅必须在 finally 收口 —— 守住它的位置：stopObservingEvents 与 finally 块 —— 改错故障：早退路径留下仍写 stdout 的 sink，后续输出错乱。
// INV-06 断言：closeApp 幂等且只真正执行一次 —— 守住它的位置：closePromise 的惰性缓存 —— 改错故障：信号处理器与 finally 各关一次，telemetry 二次 shutdown 抛错。
// INV-07 断言：app、browser、telemetry 各自独立超时回收 —— 守住它的位置：closeApp 内三次 runCliCleanupWithTimeout —— 改错故障：一步挂起就拖住其余回收，Chromium 变成孤儿进程。
// INV-08 断言：建 app 期间收到 abort 必须先释放迟到实例再抛出 —— 守住它的位置：abortController.signal.aborted 分支 —— 改错故障：app 泄漏，且进程级清理被重复触发。
// INV-09 断言：workflow 关闭时 /workflow 必须在建 app 之前失败 —— 守住它的位置：isWorkflowModeEnabled 的早退 —— 改错故障：命令原文被当普通文本发给模型，还“成功”退出 0。
// INV-10 断言：slash 命令按可解析性而非拼写分流 —— 守住它的位置：routesToPromptCommandCenter —— 改错故障：可解析的自定义命令走 command-center，跳过 dwf 结算等待，在飞 run 被孤儿化成 Interrupted。
// INV-11 断言：保留名必须先判再 load —— 守住它的位置：isResolvableCustomCommand 的首个分支 —— 改错故障：/compress 以字面文本提交给模型，无任何报错。
// INV-12 断言：只有 not found 才算不可解析，其余错误必须冒泡 —— 守住它的位置：customCommandNotFoundPattern 判断 —— 改错故障：读盘或 frontmatter 失败被一句 Unknown command 掩盖。
// INV-13 断言：可用性探测不得触发 prompt 展开 —— 守住它的位置：isResolvableCustomCommand 的 load 探测 —— 改错故障：用户命令里的 ! shell 片段被执行两遍。
// INV-14 断言：事件订阅挂载点必须在 command-center 分支之后 —— 守住它的位置：subscribeEvents 的位置 —— 改错故障：/expert、/goal 路径凭空多出 NDJSON 行。
// INV-15 断言：response 取最后一个回合的文本 —— 守住它的位置：turnResponses.at(-1) —— 改错故障：工作流结算后的总结被首回合答案取代。
// INV-16 断言：turnResponses 只在多回合时输出 —— 守住它的位置：multiTurn 条件展开 —— 改错故障：单回合 json 输出变形，快照与下游解析全部失配。
// INV-17 断言：multiTurn 不得抽成共享变量后再展开 —— 守住它的位置：两处 summary 的内联展开 —— 改错故障：TS 把键推成可选，formatJson 的 JsonValue 收不下。
// INV-18 断言：memoryBench 的 drain 必须先于 close —— 守住它的位置：options.memoryBench 分支 —— 改错故障：close 取消 Extraction，bench 指标缺失。
// INV-19 断言：workflow 结算等待必须先于停止事件订阅 —— 守住它的位置：waitForHeadlessWorkflowSettle 调用点 —— 改错故障：结算回合产生的整段事件行被丢弃。
// INV-20 断言：hook 阻断诊断只认 project 来源的 hook_run_blocked —— 守住它的位置：resolveHeadlessWorkspaceHookTrustDiagnostic 的事件过滤 —— 改错故障：用户级 hook 阻断被误报成工作区信任问题。
import type { ToolSearchMode } from "@zcode/contracts";
import { createCliProviderRefreshReporter } from "./provider-runtime-env.js";
import { extname } from "node:path";
import { formatJson, type PresentationSurface } from "@zcode/core";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import {
  buildManualSkillPrompt,
  createCommandCenter,
  formatSlashCommandHelp,
  parseSlashCommand,
} from "./command-center.js";
import { loadCliDotenv } from "./env.js";
import { createCliHeadlessBrowserRuntime } from "./headless-browser.js";
import {
  createHeadlessPermissionBroker,
  createHeadlessSessionObserver,
  readHeadlessRuntimeFacts,
  waitForHeadlessWorkflowSettle,
} from "./headless-workflow.js";
import { runLoginCommand, runLogoutCommand } from "./login-command.js";
import { resolveResumeSession } from "./resume.js";
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import {
  DEFAULT_CLI_CLEANUP_TIMEOUT_MS,
  registerCliShutdownHandlers,
  runCliCleanupWithTimeout,
} from "./shutdown.js";
import { runSkillsCommand } from "./skills-command.js";
import {
  DEFAULT_CLI_WORKFLOW_MODE,
  isWorkflowModeEnabled,
  resolveWorkflowModeRuntimeConfig,
  WORKFLOW_DISABLED_NOTICE,
} from "./workflow-mode.js";
import type { DynamicWorkflowMode } from "@zcode/shared";
import type { CommandCenterApp, SlashCommand } from "./command-center.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  ModeCapableApp,
  RunDependencies,
} from "./cli-types.js";

/**
 * Does this run print a JSON summary at the end?
 *
 * An explicit --output-format wins over the older --json flag, so that
 * `--output-format text` can turn the summary off again. Checking only
 * `options.json` here is a trap: `--output-format json` would parse fine and
 * then silently print plain text.
 */
const wantsJsonSummary = (options: GlobalOptions): boolean =>
  options.outputFormat === undefined
    ? options.json
    : options.outputFormat === "json" || options.outputFormat === "stream-json";

/** Does this run write each session event as it happens? */
const wantsEventStream = (options: GlobalOptions): boolean =>
  options.outputFormat === "stream-json";

const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"]);
const EMPTY_PROMPT_ERROR = "--prompt requires non-empty text.";
const MEMORY_BENCH_DISABLED_ERROR =
  "--memory-bench requires Project Memory to be enabled (features.memory=true and memory.use=true).";
const TARGET_SELECTION_UNAVAILABLE_ERROR =
  "Headless goal commands cannot open an interactive replacement picker. Re-run with --target-replace or use /goal replace <objective>.";

export const runPrompt = async (
  ctx: RunContext,
  prompt: string,
  attachmentPaths: string[],
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  mode?: CliPermissionMode,
  resumeRequest: CliResumeRequest = { continueSession: false },
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  toolsearchMode: ToolSearchMode = "off",
  presentationSurface: PresentationSurface = "terminal",
  workflowMode: DynamicWorkflowMode = DEFAULT_CLI_WORKFLOW_MODE,
): Promise<number> => {
  // [契约] 空 prompt 的退出码固定为 1，且发生在任何 app 构造与 telemetry 初始化之前。
  // [契约] 空 prompt 在构造 app 之前返回 1：下游只看到「什么都没发生」，不会收到一条空回合记录。
  // 把校验后移到 submitPrompt 之后，dotenv、provider registry 都会先跑一遍，
  // 脚本侧重试的空转成本被放大，真正的失败原因还会被入参校验改写。
  if (prompt.trim().length === 0) {
    ctx.stderr.write(`${EMPTY_PROMPT_ERROR}\n`);
    return 1;
  }

  // [契约] 只解析一次并复用：后续 known / unknown 分流共享这一份结果。
  // 重复解析会在两次调用之间看到不同的自定义命令集（磁盘可能已变），
  // 于是 help 展示一套、实际提交走另一套，问题极难复现。
  // 五个早退分支（help / workflow / skill / login / logout）都依赖它，且都早于建 app。
  const slashCommand = parseSlashCommand(prompt);
  if (slashCommand?.type === "known" && slashCommand.name === "help") {
    ctx.stdout.write(
      `${formatSlashCommandHelp(slashCommand.args, await listCustomCommandsForPrompt(deps), {
        workflowMode,
      })}\n`,
    );
    return 0;
  }
  // disabled 下 `/workflow` 不展开（builtin resolver 同判）；若照常建 app 提交，原文会作为普通文本
  // 发给模型并「成功」退出，脚本察觉不到。建 app 之前就报错退出，与 TUI 的本地提示同一句。
  if (
    slashCommand?.type === "known" &&
    slashCommand.name === "workflow" &&
    !isWorkflowModeEnabled(workflowMode)
  ) {
    ctx.stderr.write(`Error: ${WORKFLOW_DISABLED_NOTICE}\n`);
    return 1;
  }
  if (slashCommand?.type === "known" && slashCommand.name === "skill" && !slashCommand.skillName) {
    return await runSkillsCommand(ctx, options, deps, []);
  }
  if (slashCommand?.type === "known" && slashCommand.name === "login") {
    if (slashCommand.args.length > 0) {
      ctx.stderr.write("Usage: /login\n");
      return 1;
    }
    return await runLoginCommand(ctx, options, deps, false);
  }
  if (slashCommand?.type === "known" && slashCommand.name === "logout") {
    if (slashCommand.args.length > 0) {
      ctx.stderr.write("Usage: /logout\n");
      return 1;
    }
    return await runLogoutCommand(ctx, options, deps);
  }

  // [契约] 只有 /skill 会被改写成“技能前言 + 任务”的合成 prompt，其余一律原样透传。
  // 自定义命令故意不在这里改写：展开发生在 facade 的 customCommandPromptResolver，
  // 这里再拼一次会让 $ARGUMENTS 与 skills: 前言重叠。
  // 提交时必须用 runtimePrompt，误用 prompt 会让 /skill 的 skillName 静默丢失。
  const runtimePrompt =
    slashCommand?.type === "known" && slashCommand.name === "skill"
      ? buildManualSkillPrompt(slashCommand.skillName, slashCommand.task)
      : prompt;

  // [契约] traceId、app、closePromise 全部提到 try 之外声明，是因为 catch 要打 traceId，
  // finally 要 closeApp；声明在 try 内这两处都拿不到值。
  // 不要改回块内作用域，TS 会立刻报使用前未赋值，
  // 而用非空断言糊过去会在早退路径上把 undefined 当成 app 传下去。
  let traceId: string | undefined;
  let app:
    | Awaited<ReturnType<Awaited<ReturnType<typeof loadBootstrapModule>>["createZCodeApp"]>>
    | undefined;
  let closePromise: Promise<void> | undefined;
  let browserRuntime: ReturnType<typeof createCliHeadlessBrowserRuntime>;
  let shutdownTelemetry: (() => Promise<void>) | undefined;
  // 常驻事件订阅的摘除句柄。声明在这里而不是 try 内，是为了让 finally 也能收口——
  // 任何早退（command-center 路径、抛错）都不能留下一个还在写 stdout 的 sink。
  let detachEvents: (() => void) | undefined;
  const stopObservingEvents = () => {
    detachEvents?.();
    detachEvents = undefined;
  };
  let providerRegistryRuntime: Awaited<
    ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
  >;
  const abortController = new AbortController();
  const cleanupTimeoutMs = Math.max(
    1,
    Math.trunc(deps.shutdownCleanupTimeoutMs ?? DEFAULT_CLI_CLEANUP_TIMEOUT_MS),
  );
  // [资源] closePromise 缓存是本文件唯一的幂等闸门：信号处理器与 finally 都会调它，
  // 第二次必须直接 await 同一个 promise，而不是再跑一遍关闭流程。
  // 改成标志位或条件赋值，就会出现两次真正执行的时间窗。
  // 闭包里先快照 targetApp 再建 promise：promise 体同步执行到首个 await，之后变量被改写也不影响本次关闭。
  const closeApp = async (): Promise<void> => {
    const targetApp = app;
    closePromise ??= (async () => {
      await runCliCleanupWithTimeout(async () => targetApp?.close?.(), cleanupTimeoutMs);
      // Browser process 由 CLI adapter 持有；App close 悬空或失败也必须继续回收 Chromium。
      await runCliCleanupWithTimeout(async () => browserRuntime?.close(), cleanupTimeoutMs);
      // Bug 根因：App.close 只结束 Session 并 flush，共享 OTLP Owner 过去没有进程级终态。
      // 单次 prompt 是最外层生命周期，必须与 prepare 对称 shutdown。
      await runCliCleanupWithTimeout(async () => shutdownTelemetry?.(), cleanupTimeoutMs);
      providerRegistryRuntime?.dispose();
    })();
    await closePromise;
  };
  // [资源] 注销必须落在 finally 里，可以早于 closeApp，但绝不能省。
  // 否则同一个进程内的多轮 prompt 会累积 signal 监听器，
  // 最终触发 MaxListenersExceededWarning，且旧处理器仍持有上一轮的 abortController。
  // cleanup 传入 closeApp 而不是内联关闭逻辑，复用同一幂等闸门。
  const unregisterShutdownHandlers = registerCliShutdownHandlers({
    abort: (signal) => abortController.abort(new Error(`CLI received ${signal}`)),
    cleanup: closeApp,
    cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs,
    exitProcess: deps.exitProcess,
    process: deps.shutdownProcess,
  });
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    // [失败路径] dotenv 失败必须直接抛，不能降级成“忽略这一行配置”。
    // 静默忽略会让 provider 认证缺失以 401 的形式在几分钟后才暴露，
    // 错误原因被整体错位到网络层。
    // cause 保留原始错误对象：这里只补文件路径上下文，不做字符串化。
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    // [契约] resume 解析先于 app 创建：sessionId 是 createApp 的入参，不是事后补设。
    // 顺序颠倒会先建出一个空会话再切到目标会话，多留一条 session 记录。
    // undefined 表示“新会话”，所以下游必须用 !== undefined 判断，不能用 falsy 判断。
    // bootstrapModule 只在未注入 createZCodeApp 时才动态加载：注入 app 工厂的测试不走 import。
    const sessionId = await resolveResumeSession(resumeRequest, workingDirectory, env, deps);
    const bootstrapModule = deps.createZCodeApp ? undefined : await loadBootstrapModule();
    const createApp = deps.createZCodeApp ?? bootstrapModule?.createZCodeApp;
    if (!createApp) throw new Error("ZCode app factory is unavailable.");
    const streamsEvents = wantsEventStream(options);
    let mapSessionEvent: NonNullable<RunDependencies["mapSessionEvent"]> | undefined;
    if (streamsEvents) {
      mapSessionEvent = deps.mapSessionEvent ?? bootstrapModule?.mapSessionEvent;
      if (!mapSessionEvent) {
        throw new Error("Event streaming is unavailable: the bootstrap module did not load.");
      }
    }
    const observer = createHeadlessSessionObserver({
      ...(mapSessionEvent ? { mapSessionEvent } : {}),
      options,
      stderr: ctx.stderr,
      stdout: ctx.stdout,
    });
    const prepareTelemetry =
      deps.prepareZCodeTelemetryEnv ?? bootstrapModule?.prepareZCodeTelemetryEnv;
    if (prepareTelemetry) {
      shutdownTelemetry = deps.shutdownZCodeTelemetry ?? bootstrapModule?.shutdownZCodeTelemetry;
    }
    // [契约] prepareTelemetry 的返回值才是 app 该看到的环境，原始 env 只是它的输入。
    // 它可能注入 OTLP 端点等派生变量，所以 createApp 与 provider registry 都收 appEnv。
    // 未注入 prepareTelemetry 时两者相等，无 telemetry 场景保持零差异。
    // 只有在 prepare 存在时才登记 shutdown 句柄：没有 prepare 就没有需要对称关闭的 Owner。
    const appEnv = prepareTelemetry
      ? await prepareTelemetry(env, {
          cliVersion: version,
          productVersion: env.ZCODE_APP_VERSION,
        })
      : env;
    const startProviderRegistryRuntime =
      deps.startProcessProviderRegistryRuntime ??
      bootstrapModule?.startProcessProviderRegistryRuntime;
    if (!startProviderRegistryRuntime) {
      throw new Error("Provider Registry runtime is unavailable.");
    }
    // [契约] skipUserConfig 时传空对象而不是省略第二个参数：空对象表示不读用户配置，
    // 省略则回落到默认用户配置路径，测试与 CI 里两种行为完全不同。
    // 这个 runtime 必须在 createApp 之前就绪：app 要拿它的 registryService 与默认选型。
    // closeApp 里最后 dispose 且不套超时包装，因为它是同步释放、不阻塞进程退出。
    providerRegistryRuntime = await startProviderRegistryRuntime(
      appEnv,
      deps.skipUserConfig
        ? {}
        : {
            standalone: {
              ...createCliProviderRefreshReporter(ctx.stderr),
              ...(deps.userConfigPath ? { legacyCliUserConfigFilePath: deps.userConfigPath } : {}),
            },
          },
    );
    const createProviderEndpointRoutingPort =
      deps.createProviderEndpointRoutingPort ??
      bootstrapModule?.createDefaultProviderEndpointRoutingPort;
    const providerEndpointRoutingPort = createProviderEndpointRoutingPort?.({
      appVersion: version,
      env,
      workingDirectory,
    });
    // [资源] 返回值可能为空（未启用浏览器控制），所以 closeApp 用的是可选调用。
    // 必须在 createApp 之前构造：browserControlPort 要作为 app 入参传进去。
    // 反过来先建 app 再补端口，等于让 app 拿着一个永远连不上的端口。
    // 浏览器进程由 CLI adapter 持有，关闭由 closeApp 显式负责，不依赖 app.close 顺带回收。
    browserRuntime = createCliHeadlessBrowserRuntime(options, deps);
    // [契约] runtimeConfig 用条件展开而非显式 undefined：core 把“键存在”当作“被指定”。
    // mode、toolDisallowlist 缺席时下发的应是默认值，不是用 undefined 去覆盖。
    // memory.extractionEnabled 由 --memory-bench 单一驱动，开启它才允许后面的 drain。
    // permissionBroker 传的是最小 broker，原因见 headless-workflow 的注释，不要删。
    app = await createApp({
      modelSelectionMode: "cli-default",
      browserControlPort: browserRuntime?.browserControlPort,
      env: appEnv,
      // headless 没有交互审批面，core 因此退到 deny broker，于是 CreateWorkflow 的
      // alwaysAsk gate 在 -p 下**必然被拒**（"No permission client configured"）。
      // 这个最小 broker 只按工具名放行 CreateWorkflow，其余工具委托回同一个 deny
      // broker，语义逐字不变。详见 headless-workflow.ts 的注释。
      permissionBroker: createHeadlessPermissionBroker(),
      ...(providerEndpointRoutingPort ? { providerEndpointRoutingPort } : {}),
      providerRegistry: providerRegistryRuntime.runtime.registryService,
      configuredDefaultModelSelection: providerRegistryRuntime.configuredDefaultModelSelection,
      ...(providerRegistryRuntime.providerRuntimeHeadersPort
        ? {
            providerRuntimeHeadersPort: providerRegistryRuntime.providerRuntimeHeadersPort,
          }
        : {}),
      resume: sessionId !== undefined,
      runtimeConfig: {
        ...(mode ? { mode } : {}),
        ...(toolDisallowlist ? { toolDisallowlist } : {}),
        toolSearch: { mode: toolsearchMode },
        ...(forceMcs ? { midConversationSystem: { mode: "force" as const } } : {}),
        ...resolveWorkflowModeRuntimeConfig(workflowMode),
        memory: { extractionEnabled: options.memoryBench === true },
        modelStreaming: "on",
        presentationSurface,
        workingDirectory,
      },
      sessionId,
      ...(options.recordConversation === undefined
        ? {}
        : { recordConversation: options.recordConversation }),
      ...(options.recordConversationDir === undefined
        ? {}
        : { recordConversationDir: options.recordConversationDir }),
      uiDetectedLocale: options.detectedLocale,
      uiLocale: options.locale,
      version,
    });
    // 异步身份导入期间可能已收到退出信号；既有的 cleanup 尚拿不到这个 App。
    // 单独释放迟到实例，禁止继续提交，也不重启已结束的进程级清理。
    // [并发] 建 app 期间收到退出信号时，既有的 cleanup 还拿不到这个实例。
    // 所以这里手动关闭迟到实例、把 app 置空，再抛出 signal.reason。
    // 不置空会让 finally 的 closeApp 二次关闭同一个 app。
    // 抛 reason 而不是新建 Error，是为了把信号语义原样带给上游。
    if (abortController.signal.aborted) {
      const lateApp = app;
      app = undefined;
      await runCliCleanupWithTimeout(async () => lateApp.close?.(), cleanupTimeoutMs);
      throw abortController.signal.reason;
    }
    traceId = app.traceId;
    if (options.memoryBench && !app.runtime.isProjectMemoryEnabled()) {
      throw new Error(MEMORY_BENCH_DISABLED_ERROR);
    }

    // 按**可解析性**分流，不按拼写。
    //
    // 自定义命令解析出来一律是 `type === "unknown"`，过去因此全部早退进
    // command-center；那条路径自己 submit 完就 return，于是只挂在下面普通 prompt 路径上
    // 的三件机制全被跳过——dwf 结算等待、常驻事件订阅的单一写者、`response` 取最后一个
    // 回合。结果是 `zcode -p "/workflow ..."` 在第一个回合后就退出，把在飞的 run 孤儿化
    // 成 Interrupted。能解析成真实自定义命令的必须落到普通 prompt 路径，提交**原文**即可：
    // facade 的 customCommandPromptResolver 会在服务端展开（$ARGUMENTS、skills: 前言、`!`）。
    // 解析不出来的名字继续留在 command-center，拿它的 "Unknown command" 文案；保留名
    // （`/compress` 是唯一一个 CLI 解析成 unknown 而 facade 又拒绝展开的）同样留在那边，
    // 判据与 facade 的 gate 共用一个来源，见 isResolvableCustomCommand。
    // `/expert`、`/goal` 走不到 submitPrompt，路由逐字不变。
    // [权衡] 这是一次会读盘的 await 探测，但位置必须在事件订阅挂载之前，不能为了提前而移动。
    // 挂到订阅之后，/expert、/goal 就会凭空多出 NDJSON 行，因为它们从不 submitPrompt。
    // 返回 true 时直接 return，跳过普通 prompt 的全部机制：结算等待、response 取尾都不执行。
    // 因此能解析的自定义命令必须落 false 分支，判据见上面“按可解析性分流”的长注释。
    if (slashCommand && (await routesToPromptCommandCenter(slashCommand, deps))) {
      return await runPromptCommandCenterCommand(
        ctx,
        options,
        app as ModeCapableApp,
        prompt,
        mode,
        traceId,
        abortController.signal,
        deps,
        workflowMode,
      );
    }

    // 事件的**单一写者**。常驻订阅跨回合存活，所以完成通知驱动的回合（core 自驱，
    // `runtime-command-queue.ts:336`）的事件也在内；per-turn `onEvent` 则在 submitPrompt
    // 的 finally 里就被摘掉（`input-facade.ts:361-372`），看不到那些回合。
    //
    // 两者**绝不同时装**：同一条事件被两个 sink 各写一次就是一行重复的 NDJSON。
    // 这里用「二选一」而不是「双装 + 按 id 去重」，因为前者让恰好一次成为结构性事实，
    // 不依赖任何 sink 的调用顺序。
    //
    // 挂载点刻意在 command-center 分支**之后**：`/expert`、`/goal` 走不到 submitPrompt，
    // 过去也从不透出事件行，在这里挂就会给那条路径凭空加出 NDJSON 行。
    // [并发] 常驻订阅与 per-turn sink 互斥，判据就是 detachEvents 是否有值。
    // 只有 runtime 未暴露 subscriber 时才退回 per-turn onEvent。
    // 不要改成“两个都装、按事件 id 去重”：去重依赖 sink 的调用顺序，重放时会漏。
    // detach 句柄必须赋给外层变量，否则 finally 无从收口。
    const subscribeEvents = readRuntimeEventSubscriber(app.runtime);
    detachEvents = subscribeEvents?.({ onSessionEvent: observer.observe });
    const runtimeFacts = readHeadlessRuntimeFacts(app.runtime);
    const result = await app.submitPrompt(
      attachmentPaths.length > 0
        ? {
            text: runtimePrompt,
            attachments: attachmentPaths.map((path) => ({
              type: inferAttachmentTypeFromPath(path),
              path,
            })),
          }
        : runtimePrompt,
      {
        abortSignal: abortController.signal,
        // 常驻订阅装上了就绝不再装 per-turn sink（见上面的单一写者注释）。
        ...(detachEvents ? {} : { onEvent: observer.observe }),
      },
    );
    // 同步紧接着 submitPrompt：这一刻到第一个 await 之间没有任何事件能插队，所以
    // 「run 在回合内就结算了、通知回合已经在跑」这种情况也不会漏掉它的第一条事件。
    // [并发] beginWaitPhase 紧贴 submitPrompt 同步调用，中间不允许插入任何 await。
    // 一旦有 await，run 可能已经结算、通知回合已在跑，第一条事件就落在等待窗口之外。
    // turnId 转成字符串是因为下游按字符串键投影，数字键在批量映射时会被合并。
    // 只有走完这一步，后面的 workflow 结算等待才是完整的。
    observer.beginWaitPhase(result.turnId ? String(result.turnId) : undefined);
    traceId = result.traceId ?? traceId;
    // 在飞的 workflow run 不能被进程退出孤儿化。窄触发（观察到过 dwf 活动）+ 宽排水
    // （runtime 的两个 busy 事实）——论证见 waitForHeadlessWorkflowSettle 的注释。
    if (observer.hasWorkflowActivity() && runtimeFacts) {
      await waitForHeadlessWorkflowSettle({
        runtime: runtimeFacts,
        signal: abortController.signal,
      });
    }
    // bench 的正常等待必须先于 close；close 会取消 Extraction，且有独立的清理时限。
    if (options.memoryBench) {
      await app.runtime.drainMemoryExtractions(null);
      abortController.signal.throwIfAborted();
    }
    // 结果行之后绝不能再冒出事件行——stream-json 的 result 是流的终止符。
    stopObservingEvents();
    // `response` 取**最后**一个回合的文本：工作流结算后的那次总结才是答案。
    // 未进入等待时数组只有一项，于是 response ≡ result.response，行为逐字节不变。
    // [契约] 首个元素固定是 result.response，其后是等待期内各回合的文本，顺序即到达顺序。
    // 过滤依据是 trim 后为空，不是判 undefined：模型可能返回纯空白，那也不该占一个回合。
    // 未进入等待时数组长度为 1，于是 response 与 result.response 逐字节相同。
    // 数组尾部就是结算后的总结，这也是 response 取值方式能兼容旧行为的原因。
    const turnResponses = [result.response, ...observer.waitPhaseTurnResponses()].filter(
      (text) => text.trim().length > 0,
    );
    const response = turnResponses.at(-1) ?? result.response;
    // 只在真的多于一个回合时才带上数组——单回合运行的 json 输出因此逐字节不变。
    // 刻意在两处 summary 里各自内联这个条件展开而不是共享一个变量：展开一个联合类型的
    // 变量会让 TS 把键推成可选（`turnResponses?: string[]`），而 formatJson 只收 JsonValue。
    // [契约] 只有多于一个回合才输出 turnResponses，单回合 json 必须保持历史形状。
    // 下面两处 summary 各自内联展开这个条件，不是复制粘贴失误：
    // 先存变量再展开，TS 会把键推成可选，formatJson 的 JsonValue 就收不下。
    // 要改就两处一起改，并同步更新依赖单回合快照的测试。
    const multiTurn = turnResponses.length > 1;
    const hookTrustDiagnostic = await resolveHeadlessWorkspaceHookTrustDiagnostic({
      bootstrapModule,
      deps,
      events: result.events,
      workingDirectory,
    });

    // [契约] stream-json 的收尾行必须带 type 为 result 的标记，否则消费方无法识别流终止。
    // 字段与 --json 同构，只多一个 type 与 eventCount，便于同一解析器复用。
    // 这一行写出后立即返回，跳过文本与 hook 诊断输出：该模式下两者都不允许出现。
    // 此处不再停止订阅，那已在更早处完成；重复调用虽幂等，但会掩盖真正的漏停。
    if (streamsEvents) {
      // Closing summary, on its own line and tagged so it can be told apart
      // from the events preceding it. Same fields as --json, so a caller that
      // already parses that keeps working.
      ctx.stdout.write(
        `${JSON.stringify({
          type: "result",
          sessionId: app.sessionId,
          traceId,
          ...(result.turnId ? { turnId: result.turnId } : {}),
          response,
          ...(multiTurn ? { turnResponses } : {}),
          ...(result.usage ? { usage: { ...result.usage } } : {}),
          eventCount: result.events.length,
          projection: {
            status: result.projection.status,
            turnCount: result.projection.turnCount,
            totalTokenCount: result.projection.totalTokenCount,
            contextUsed: result.projection.contextUsed ?? null,
            contextWindow: result.projection.contextWindow ?? null,
          },
        })}\n`,
      );
      return 0;
    }

    if (wantsJsonSummary(options)) {
      ctx.stdout.write(
        formatJson({
          sessionId: app.sessionId,
          traceId,
          ...(result.turnId ? { turnId: result.turnId } : {}),
          response,
          ...(multiTurn ? { turnResponses } : {}),
          ...(result.usage ? { usage: { ...result.usage } } : {}),
          eventCount: result.events.length,
          ...(hookTrustDiagnostic
            ? {
                workspaceHookTrust: {
                  workspacePath: hookTrustDiagnostic.workspacePath,
                  workspaceIdentity: hookTrustDiagnostic.workspaceIdentity,
                  bundleDigest: hookTrustDiagnostic.bundleDigest,
                  reasonCode: hookTrustDiagnostic.reasonCode,
                  items: hookTrustDiagnostic.items.map((item) => ({
                    reviewItemId: item.reviewItemId,
                    event: item.event,
                    matcher: item.matcher,
                    displayCommand: item.displayCommand,
                    sourcePath: item.sourcePath,
                    configuredEnabled: item.configuredEnabled,
                    hookDeclarationDigest: item.hookDeclarationDigest,
                    trustState: item.trustState,
                  })),
                },
              }
            : {}),
          projection: {
            status: result.projection.status,
            turnCount: result.projection.turnCount,
            totalTokenCount: result.projection.totalTokenCount,
            contextUsed: result.projection.contextUsed ?? null,
            contextWindow: result.projection.contextWindow ?? null,
          },
        }),
      );
      return 0;
    }

    if (hookTrustDiagnostic) writeHeadlessWorkspaceHookTrustDiagnostic(ctx, hookTrustDiagnostic);
    // 每个回合的文本按到达序打印，所以最后一段自然就是结算后的总结。
    // 单回合时这与 `${result.response}\n` 逐字节相同。
    ctx.stdout.write(`${turnResponses.join("\n\n")}\n`);
    return 0;
  // [失败路径] 这里是 CLI 入口边界，是唯一允许把错误压成一行文本加退出码 1 的地方。
  // verbose 才输出 cause 与 stack：默认输出会把内部路径和依赖栈泄给终端用户。
  // traceId 只在已拿到时拼接；建 app 之前就失败的早退错误没有 traceId，属正常。
  // 不要在这里直接退出进程：退出码由调用方统一处理，测试也需要拿到返回值。
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}${traceId ? ` (traceId: ${traceId})` : ""}\n`);
    if (options.verbose) {
      if (error instanceof Error && error.cause) {
        ctx.stderr.write(`Cause: ${error.cause}\n`);
      }
      if (error instanceof Error && error.stack) {
        ctx.stderr.write(`${error.stack}\n`);
      }
    }
    return 1;
  // [资源] finally 的三步顺序固定：先停事件、再注销 signal、最后关闭资源。
  // 先关闭再停订阅，会让关闭过程产生的事件写到已经收尾的 stdout 上。
  // closeApp 是幂等闸门，信号处理器可能已经执行过它，这里只是 await 同一个 promise。
  // 即使 catch 已经写过错误也不能跳过，否则热路径每轮都会泄漏一个 Chromium。
  } finally {
    stopObservingEvents();
    unregisterShutdownHandlers();
    await closeApp();
  }
};

function inferAttachmentTypeFromPath(path: string): "file" | "image" | "video" | "pdf" {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (extension === ".pdf") return "pdf";
  return "file";
}

const customCommandNotFoundPattern = /not found/i;

/** headless 下这条 slash 命令该走 command-center 而不是普通 prompt 路径吗？ */
async function routesToPromptCommandCenter(
  slashCommand: SlashCommand,
  deps: RunDependencies,
): Promise<boolean> {
  if (slashCommand.type === "known") {
    return slashCommand.name === "expert" || slashCommand.name === "goal";
  }
  return !(await isResolvableCustomCommand(deps, slashCommand.rawName));
}

async function isResolvableCustomCommand(deps: RunDependencies, name: string): Promise<boolean> {
  // 保留名先问，再尝试加载——与 facade 那道 gate 的顺序逐字一致
  // （`bootstrap/src/custom-command-prompt.ts:31`）。判据必须是同一个：facade 对保留名
  // 直接返回 undefined、不做展开，所以这里若把一个保留名判成"可解析"，它就会以字面文本
  // `/compress …` 被当成普通 prompt 提交给模型——静默走错路，没有任何报错。
  //
  // 探测刻意用「保留名检查 + load」这一对，而不是直接调 resolveZCodeCustomCommandPrompt：
  // 后者会执行 `!` shell expansion，拿它探测等于把用户的 shell 片段跑两遍。
  // 这一对是它的无副作用等价物（load 只读文件）。
  if (await isReservedSlashCommandName(deps, name)) return false;
  try {
    await loadCustomCommandForPrompt(deps, name);
    return true;
  } catch (error) {
    // 只有"不存在"算不可解析（与 buildCustomCommandPrompt 同一判据）。读盘失败、
    // frontmatter 非法之类必须继续冒泡：把它们当成未知命令会用一句 "Unknown command"
    // 盖掉真正的失败原因。
    if (error instanceof Error && customCommandNotFoundPattern.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function isReservedSlashCommandName(deps: RunDependencies, name: string): Promise<boolean> {
  if (deps.isReservedSlashCommandName) return deps.isReservedSlashCommandName(name);
  const bootstrap = await loadBootstrapModule();
  return bootstrap.isReservedZCodeSlashCommandName(name);
}

async function runPromptCommandCenterCommand(
  ctx: RunContext,
  options: GlobalOptions,
  app: ModeCapableApp,
  prompt: string,
  mode: CliPermissionMode | undefined,
  traceId: string | undefined,
  abortSignal: AbortSignal,
  deps: RunDependencies,
  workflowMode: DynamicWorkflowMode,
): Promise<number> {
  const commandCenter = createCommandCenter({
    getApp: async () => app as unknown as CommandCenterApp,
    getMode: () => app.getMode?.() ?? mode ?? "build",
    listCustomCommands: () => listCustomCommandsForPrompt(deps),
    loadCustomCommand: (name) => loadCustomCommandForPrompt(deps, name),
    recordInputHistory: async (input, kind) => {
      await app.recordInputHistory?.(input, kind);
    },
    resumeApp: async () => app as unknown as CommandCenterApp,
    workflowMode,
    setLocale: async (locale) => {
      if (!app.setLocale) {
        throw new Error("Locale switching is not available in this client.");
      }
      return await app.setLocale(locale);
    },
    setMode: async (nextMode) => {
      if (app.setMode) {
        const result = await app.setMode(nextMode);
        return result.mode;
      }
      app.runtime.updateConfig({ mode: nextMode });
      return nextMode;
    },
  });
  const result = await commandCenter(prompt, {
    abortSignal,
  });
  const nextTraceId = result.traceId ?? traceId;
  if (result.selection) {
    ctx.stderr.write(
      `Error: ${result.response}\n${TARGET_SELECTION_UNAVAILABLE_ERROR}${nextTraceId ? ` (traceId: ${nextTraceId})` : ""}\n`,
    );
    return 1;
  }

  if (options.memoryBench) {
    await app.runtime.drainMemoryExtractions(null);
    abortSignal.throwIfAborted();
  }

  if (wantsJsonSummary(options)) {
    ctx.stdout.write(
      formatJson({
        sessionId: String(app.sessionId),
        ...(nextTraceId ? { traceId: nextTraceId } : {}),
        response: result.response,
      }),
    );
    return 0;
  }

  ctx.stdout.write(`${result.response}\n`);
  return 0;
}

async function listCustomCommandsForPrompt(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.listCustomCommands) {
    return await deps.listCustomCommands({ env, logger: deps.logger, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.listZCodeCustomCommands({ env, logger: deps.logger, workingDirectory });
}

async function loadCustomCommandForPrompt(deps: RunDependencies, name: string) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.loadCustomCommand) {
    return await deps.loadCustomCommand({ env, logger: deps.logger, name, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.loadZCodeCustomCommand({
    env,
    logger: deps.logger,
    name,
    workingDirectory,
  });
}

const HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS = [
  "workspace_hooks_pending_trust",
  "workspace_hooks_require_trust_capable_host",
  "workspace_hooks_feature_disabled",
] as const;
type HeadlessWorkspaceHookBlockReason = (typeof HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS)[number];

async function resolveHeadlessWorkspaceHookTrustDiagnostic(input: {
  bootstrapModule: Awaited<ReturnType<typeof loadBootstrapModule>> | undefined;
  deps: RunDependencies;
  events: readonly unknown[];
  workingDirectory: string;
}) {
  let reasonCode: HeadlessWorkspaceHookBlockReason | undefined;
  for (const event of input.events) {
    if (!event || typeof event !== "object") continue;
    const value = event as {
      type?: string;
      payload?: { errorCode?: string; descriptor?: { sourceKind?: string } };
    };
    if (value.type !== "hook_run_blocked" || value.payload?.descriptor?.sourceKind !== "project") {
      continue;
    }
    const errorCode = value.payload.errorCode;
    if (isHeadlessWorkspaceHookBlockReason(errorCode)) {
      reasonCode = errorCode;
      break;
    }
  }
  if (!reasonCode) return undefined;
  const inspect =
    input.deps.inspectWorkspaceHookTrust ?? input.bootstrapModule?.inspectWorkspaceHookTrust;
  if (!inspect) return undefined;
  const status = await inspect({
    workspacePath: input.workingDirectory,
    ...(input.deps.userConfigPath ? { userConfigPath: input.deps.userConfigPath } : {}),
  });
  return { ...status, reasonCode };
}

function isHeadlessWorkspaceHookBlockReason(
  value: string | undefined,
): value is HeadlessWorkspaceHookBlockReason {
  return HEADLESS_WORKSPACE_HOOK_BLOCK_REASONS.some((candidate) => candidate === value);
}

function writeHeadlessWorkspaceHookTrustDiagnostic(
  ctx: RunContext,
  status: Awaited<ReturnType<NonNullable<RunDependencies["inspectWorkspaceHookTrust"]>>>,
): void {
  ctx.stderr.write(
    [
      `Workspace Hooks skipped: ${status.reasonCode}`,
      `workspace: ${status.workspaceIdentity}`,
      `bundle: ${status.bundleDigest ?? "none"}`,
      ...status.items
        .filter((item) => item.configuredEnabled && item.trustState !== "trusted_persistent")
        .map((item) => `pending digest: ${item.hookDeclarationDigest}`),
      `Review with: zcode hooks trust review --workspace ${JSON.stringify(status.workspaceIdentity)}`,
    ].join("\n") + "\n",
  );
}
