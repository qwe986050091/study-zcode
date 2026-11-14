// TUI Prompt Handler：把 RunDependencies 装配成一个可复用的 TuiPromptHandler。
// 只负责 App 生命周期、权限代理、命令中心接线与会话事件订阅；不负责斜杠命令的实现、
// 不负责 TUI 布局渲染，也不负责 session 状态的持久化细节（那些在 runtime 与 core 里）。
//
// INV-01 断言：同一时刻至多一个 App 实例对外可见 —— 守住它的位置：app 变量与 replaceApp —— 改错故障：/new 与 /resume 并发时两个 session 同时收事件，转写串台。
// INV-02 断言：同一 App 对象的 close 只真正执行一次 —— 守住它的位置：closePromises WeakMap —— 改错故障：重复 close 让 session 第二次收尾失败并抛出。
// INV-03 断言：进程级 runtime 跨 App 替换复用且不重建 —— 守住它的位置：processRuntime —— 改错故障：每换一次 session 就重建 telemetry 与 registry，旧句柄无人释放。
// INV-04 断言：关闭顺序为先 App 后 CLI 自启的 Chromium —— 守住它的位置：closeApp 内两段 cleanup —— 改错故障：Chromium 子进程残留，Windows 上端口占用导致下次启动失败。
// INV-05 断言：所有 cleanup 都受 cleanupTimeoutMs 约束 —— 守住它的位置：cleanupTimeoutMs 与 runCliCleanupWithTimeout —— 改错故障：某一步悬空即无法退出，用户只能强杀进程。
// INV-06 断言：没有交互审批回调时权限请求一律 deny —— 守住它的位置：permissionBroker.requestPermission —— 改错故障：默认放行让未授权工具调用真的被执行。
// INV-07 断言：activeRequestPermission 必须按回合成对设置并还原 —— 守住它的位置：submitPrompt 与 sendInput 的 finally —— 改错故障：上一回合的审批回调泄漏到下一回合，弹窗归属错乱。
// INV-08 断言：sendInput 里的 model 与 effort 命令必须回落 submitPrompt —— 守住它的位置：sendInput 的 known 分支 —— 改错故障：忙碌回合改模型被静默忽略，用户以为已生效。
// INV-09 断言：会话事件订阅在 App 替换后重新挂载且幂等 —— 守住它的位置：replaceApp 里的 sessionEventRelay.reattach —— 改错故障：/resume 后收不到出回合事件，dwf 进度与后台通知冻结。
// INV-10 断言：subscribeSessionEvents 在 App 未就绪时补挂一次 —— 守住它的位置：getApp().then 的两个分支 —— 改错故障：TUI 启动即订阅的事件永久丢失，首屏没有进度。
// INV-11 断言：主会话 id 每次现读而非缓存 —— 守住它的位置：getMainSessionId —— 改错故障：换 App 后陈旧 id 让整条转写被判为外来事件而丢弃。
// INV-12 断言：handler 进入关闭态后再建 App 必须抛错并回收 —— 守住它的位置：createApp 的 closeHandlerPromise 检查 —— 改错故障：迟到的 App 成为新当前会话，界面上已退出但进程仍持锁。
// INV-13 断言：App 构造失败时也要关掉已建的浏览器 runtime —— 守住它的位置：createApp 的 catch —— 改错故障：登录等待期间失败会遗留 Chromium，反复重试耗尽句柄。
// INV-14 断言：modeState.override 先落再改 App —— 守住它的位置：setCliMode —— 改错故障：App 尚未创建时切模式丢失，重启回到默认权限档。
// INV-15 断言：模式优先走 setMode，缺失时退回 runtime.updateConfig —— 守住它的位置：setCliMode 的两条分支 —— 改错故障：老 runtime 没有 setMode 时模式切换完全无效。
// INV-16 断言：locale 必须同时更新内存态与用户配置文件 —— 守住它的位置：setLocale —— 改错故障：本次生效但重启回退，用户反复切换同一项。
// INV-17 断言：fork 必须拿到新 session 后整体替换 App —— 守住它的位置：commandCenter.forkApp —— 改错故障：只换 id 不换 App，分叉后的写入落回原会话。
// INV-18 断言：handler.close 是终态且只执行一次 —— 守住它的位置：closeHandlerPromise 的 ??= —— 改错故障：重复 shutdown 让 telemetry 二次 flush 或 provider registry 二次 dispose 报错。
import type { ToolSearchMode } from "@zcode/contracts";
import { getDefaultConfigPath, updateUiLocaleInFileConfig } from "@zcode/adapters/config";
import type { SessionEvent } from "@zcode/contracts";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { DEFAULT_LOCALE, type SupportedLocale } from "@zcode/i18n";
import type { TuiRequestPermission } from "@zcode/tui";
import type { GlobalOptions } from "@zcode/shared-types";
import type { DynamicWorkflowMode } from "@zcode/shared";
import { createCommandCenter, parseSlashCommand } from "./command-center.js";
import type { CommandCenterApp } from "./command-center.js";
import { resolveDisplayLocale } from "./locale.js";
import { createCliHeadlessBrowserRuntime } from "./headless-browser.js";
// 复用防御式 runtime 读取：subscribeEvents 不在 app 的静态类型面上，
// 两处各写一份「怎么把它读出来」就会在方法改名时只修好一处。
import { readRuntimeEventSubscriber } from "./runtime-event-subscriber.js";
import { createTuiSessionEventRelay } from "./tui-session-event-relay.js";
import { attachTuiAppQueries, readTuiSessionMetadata } from "./tui-prompt-handler-queries.js";
import {
  createTuiProcessRuntimeState,
  prepareTuiAppRuntime,
} from "./tui-prompt-handler-runtime.js";
import { DEFAULT_CLI_CLEANUP_TIMEOUT_MS, runCliCleanupWithTimeout } from "./shutdown.js";
import {
  configureApiKeyForTui,
  loginBigmodelForTui,
  loginForTui,
  logoutForTui,
} from "./tui-auth.js";
import {
  listCustomCommandsForTui,
  listSessionsForTui,
  listSkillsForTui,
  loadCustomCommandForTui,
} from "./tui-command-data.js";
import {
  currentCliMode,
  readTuiMode,
  TUI_TITLE_GENERATION_CONFIG,
  type TuiPromptHandler,
} from "./tui-command-state.js";
import { createTuiModelAvailabilityChecker } from "./tui-login-state.js";
import { withTuiMetadata } from "./tui-submit-metadata.js";
import { DEFAULT_CLI_WORKFLOW_MODE, resolveWorkflowModeRuntimeConfig } from "./workflow-mode.js";
import type {
  CliModeState,
  CliPermissionMode,
  CliResumeRequest,
  CliRuntimeMode,
  ModeCapableApp,
  RunDependencies,
} from "./cli-types.js";

export function createTuiSubmitPrompt(
  deps: RunDependencies,
  modeState: CliModeState,
  version: string,
  resumeRequest: CliResumeRequest = { continueSession: false },
  uiLocale?: GlobalOptions["locale"],
  uiDetectedLocale?: GlobalOptions["detectedLocale"],
  startupLocale: SupportedLocale = DEFAULT_LOCALE,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
  toolsearchMode: ToolSearchMode = "off",
  browserUse?: GlobalOptions["browserUse"],
  browserExecutable?: GlobalOptions["browserExecutable"],
  workflowMode: DynamicWorkflowMode = DEFAULT_CLI_WORKFLOW_MODE,
  recordConversation?: boolean,
  recordConversationDir?: string,
): TuiPromptHandler {
  // app 是延迟创建的唯一实例：首个会话、/new、/resume、/fork 都写这一个变量
  // 这个变量从不置空，关闭后仍指向已关闭实例，靠 closeHandlerPromise 拦截新建
  // 命令中心与事件订阅都靠读这个闭包变量定位当前会话，不要改成每请求传参
  let app: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>> | undefined;
  let activeUiLocale = uiLocale;
  // 进程级句柄（telemetry / Provider Registry / endpoint 路由）跨 App 替换复用，见 runtime 文件。
  // 进程级句柄只在这里创建一次；换 App 时不得重建 telemetry 与 provider registry
  // 重建的代价是旧句柄没人 dispose，退出时 telemetry flush 与端点端口释放都会漏
  const processRuntime = createTuiProcessRuntimeState();
  let closeHandlerPromise: Promise<void> | undefined;
  // 按 App 对象身份缓存 close Promise，使重复关闭退化成同一次等待
  // 改成按 sessionId 缓存后，App 替换场景会把新实例当成已关闭，cleanup 被整段跳过
  const closePromises = new WeakMap<object, Promise<void>>();
  // 浏览器 runtime 的归属键与 closePromises 一致，都锚定 App 对象而不是会话 id
  // 两处键不一致会出现 App 已关、它自带的 Chromium 还活着的悬空实例
  const browserRuntimes = new WeakMap<
    object,
    NonNullable<ReturnType<typeof createCliHeadlessBrowserRuntime>>
  >();
  let activeRequestPermission: TuiRequestPermission | undefined;
  const cleanupTimeoutMs = Math.max(
    1,
    Math.trunc(deps.shutdownCleanupTimeoutMs ?? DEFAULT_CLI_CLEANUP_TIMEOUT_MS),
  );
  // [契约] 全局只装一个 broker，真正的审批回调按回合挂在 activeRequestPermission 上
  // 没有回调时立刻返回 deny，无人值守回合必须拿到确定结论而不是等待或抛错
  // 不要在这里加默认放行的兜底分支，deny 是权限体系最后一道闸
  // reason 里带 toolName 是为了让上层日志能定位被拒的是哪个工具
  const permissionBroker: NonNullable<ZCodeAppOptions["permissionBroker"]> = {
    requestPermission: async (request, requestOptions) => {
      const requestPermission = activeRequestPermission;
      if (!requestPermission) {
        return {
          decision: "deny",
          reason: `No interactive approval handler configured for ${request.toolName}`,
          resolvedAt: new Date(),
        };
      }

      return await requestPermission(request, requestOptions);
    },
  };

  // [资源] 先关 App 再关浏览器，顺序反了会让仍在收尾的 session 拿到已断开的端口
  // 两段 cleanup 各自带超时，任一段卡住都不能阻塞进程退出
  // 同一 App 的并发 close 合并到同一 Promise，避免 close 事件被触发两次
  // targetApp 参数只为关闭上一个 App 服务，不要改成固定关当前 app
  const closeApp = async (targetApp = app): Promise<void> => {
    if (!targetApp) return;
    const closeKey = targetApp as object;
    let closePromise = closePromises.get(closeKey);
    if (!closePromise) {
      closePromise = (async () => {
        await runCliCleanupWithTimeout(async () => targetApp.close?.(), cleanupTimeoutMs);
        // App/session 关闭悬空或失败时仍需释放 CLI 自己启动的 Chromium。
        await runCliCleanupWithTimeout(
          async () => browserRuntimes.get(closeKey)?.close(),
          cleanupTimeoutMs,
        );
      })();
      closePromises.set(closeKey, closePromise);
    }
    await closePromise;
  };

  // ── 跨回合常驻的会话事件订阅──
  // per-turn 的 onEvent 在回合结束即死，收不到出回合事件（dwf 进度、后台通知驱动的回合）。
  // [并发] 这个订阅跨回合常驻，生命周期跟随 handler 而不是单个 turn
  // sink 集在 handler 生命周期内只增不减，移除由 addSink 返回的退订函数负责
  // currentRuntime 用惰性读取，因为 relay 创建时 app 往往还不存在
  const sessionEventRelay = createTuiSessionEventRelay({
    currentRuntime: () => (app as { runtime?: unknown } | undefined)?.runtime,
    readSubscriber: readRuntimeEventSubscriber,
  });

  // 所有换 App 的路径（/new、/resume、/fork）都必须走这里，这是唯一收口
  // 先切变量再关旧实例，旧 App 关闭过程中的回调读 app 时必须读到新值
  // 不要在 replaceApp 之外直接赋值 app，绕过收口的后果是事件订阅不再重挂
  const replaceApp = async (
    factory: () => Promise<Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>>,
  ): Promise<CommandCenterApp> => {
    const previousApp = app;
    const nextApp = await factory();
    app = nextApp;
    if (previousApp && previousApp !== nextApp) {
      await closeApp(previousApp);
    }
    // 常驻订阅要跟着换 app 重挂：这里是 /new、/resume、/fork 共同的唯一收口，
    // 漏挂的后果是换 session 后 TUI 再也收不到出回合事件（dwf 进度、通知驱动回合）。
    // reattach 幂等，重复挂载不会让同一事件多次扇出到 sink
    // 漏掉这一行的症状是换 session 后 TUI 静默，再无出回合事件
    sessionEventRelay.reattach();
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  // 已进入关闭态时直接抛错，避免新 App 挂到正在释放的进程级句柄上
  // runtimeConfig 在这里一次性定稿，首个 App 与后续替换必须得到同样的 mode 与 workflow
  // providerEndpointRoutingPort 只在存在时透传，不要传 undefined 覆盖下游默认值
  const createApp = async (request: CliResumeRequest) => {
    if (closeHandlerPromise) throw new Error("TUI prompt handler is closed");
    const {
      appEnv,
      configuredDefaultModelSelection,
      createAppFactory,
      providerRegistryRuntime,
      sessionId,
      workingDirectory,
    } = await prepareTuiAppRuntime(deps, version, request, processRuntime);
    const providerEndpointRoutingPort = processRuntime.providerEndpointRoutingPort;
    const browserRuntime = createCliHeadlessBrowserRuntime({ browserExecutable, browserUse }, deps);
    let createdApp: Awaited<ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>>;
    try {
      createdApp = await createAppFactory({
        modelSelectionMode: "cli-default",
        browserControlPort: browserRuntime?.browserControlPort,
        env: appEnv,
        projectConfigPath: deps.projectConfigPath,
        ...(providerEndpointRoutingPort ? { providerEndpointRoutingPort } : {}),
        providerRegistry: providerRegistryRuntime.runtime.registryService,
        configuredDefaultModelSelection,
        ...(providerRegistryRuntime.providerRuntimeHeadersPort
          ? {
              providerRuntimeHeadersPort: providerRegistryRuntime.providerRuntimeHeadersPort,
            }
          : {}),
        resume: sessionId !== undefined,
        runtimeConfig: {
          ...(modeState.override ? { mode: modeState.override } : {}),
          ...(toolDisallowlist ? { toolDisallowlist } : {}),
          toolSearch: { mode: toolsearchMode },
          ...(forceMcs ? { midConversationSystem: { mode: "force" as const } } : {}),
          // 首个 app 与 /new、/resume、fork 都经这里创建，mode 因此在进程内一致。
          ...resolveWorkflowModeRuntimeConfig(workflowMode),
          modelStreaming: "on",
          titleGeneration: TUI_TITLE_GENERATION_CONFIG,
          workingDirectory,
        },
        permissionBroker,
        sessionId,
        ...(recordConversation === undefined ? {} : { recordConversation }),
        ...(recordConversationDir === undefined ? {} : { recordConversationDir }),
        skipUserConfig: deps.skipUserConfig,
        uiDetectedLocale,
        uiLocale: activeUiLocale,
        userConfigPath: deps.userConfigPath,
        version,
      });
    // [失败路径] App 构造失败时只回收本函数创建的浏览器 runtime，不碰进程级句柄
    // 进程级句柄由 handler.close 统一 dispose，这里提前释放会让重试无法复用
    // 错误原样抛出并保留原始 cause，格式化交给入口层统一处理
    } catch (error) {
      await runCliCleanupWithTimeout(async () => browserRuntime?.close(), cleanupTimeoutMs);
      throw error;
    }
    // 只有成功建出的 App 才登记浏览器 runtime，失败路径已在上面的 catch 里关掉
    // 登记键必须是 createdApp 本身，否则 closeApp 查不到对应实例
    if (browserRuntime) browserRuntimes.set(createdApp as object, browserRuntime);
    // 关闭是终态：等待期间 handler 被关掉时，这个迟到的 App 必须立刻回收并抛错
    // 不回收的后果是用户以为已退出，进程里还留着一个持锁的 session
    // 初始化在等待旧身份导入时 TUI 可能已关闭；迟到 App 不能重新成为当前会话。
    if (closeHandlerPromise) {
      await closeApp(createdApp);
      throw new Error("TUI prompt handler is closed");
    }
    modeState.current = readTuiMode(createdApp, currentCliMode(modeState));
    return createdApp;
  };

  // 惰性创建只发生一次，??= 保证并发首调不会建出两个 App
  // 每次返回前重读 mode，因为 App 内部的模式可能与 modeState 的缓存不同步
  const getApp = async (): Promise<CommandCenterApp> => {
    app ??= await createApp(resumeRequest);
    modeState.current = readTuiMode(app, currentCliMode(modeState));
    return app as unknown as CommandCenterApp;
  };

  const resumeApp = async (sessionId?: string): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp(
          sessionId
            ? {
                continueSession: false,
                resumeSessionId: sessionId,
              }
            : {
                continueSession: true,
              },
        ),
    );
  };

  const newApp = async (): Promise<CommandCenterApp> => {
    return await replaceApp(
      async () =>
        await createApp({
          continueSession: false,
        }),
    );
  };

  // 先写 modeState.override 再改 App，App 还没建时这条记录是唯一的真相
  // 有 setMode 就以它返回的模式为准，不要用入参覆盖返回值
  // 没有 setMode 时退回 runtime.updateConfig，老 runtime 只有这一条路径
  // 不要在这里等 close 或重建 App，切模式必须对进行中的回合无损
  const setCliMode = async (nextMode: CliPermissionMode): Promise<CliRuntimeMode> => {
    modeState.override = nextMode;

    if (app) {
      const modeCapableApp = app as ModeCapableApp;
      if (modeCapableApp.setMode) {
        const result = await modeCapableApp.setMode(nextMode);
        modeState.current = readTuiMode(modeCapableApp, result.mode);
        return modeState.current;
      }

      modeCapableApp.runtime.updateConfig({ mode: nextMode });
    }

    modeState.current = app ? readTuiMode(app, nextMode) : nextMode;
    return modeState.current;
  };

  // 命令中心只拿回调不拿 app 实例，避免把会话生命周期泄进命令实现里
  // getMode 与 getLocale 用函数而不是值，保证每次命令执行读到的是当下状态
  // 这里新增依赖时保持全部为惰性函数，任何提前求值都会在建 App 之前失败
  const commandCenter = createCommandCenter({
    // [事务] fork 先让当前 App 产出新 session，再用新 session 整体替换 App
    // 拿不到 fork 结果时抛错而不降级，静默留在原 session 会让用户以为已分叉
    // 替换必须通过 replaceApp 完成，不要在这里直接给 app 赋值
    forkApp: async (targetCheckpointId) => {
      const activeApp = await getApp();
      const result = await activeApp.forkFromCheckpoint?.({ targetCheckpointId });
      if (!result) {
        throw new Error("Forking is not available in this client.");
      }
      await replaceApp(
        async () =>
          await createApp({
            continueSession: false,
            resumeSessionId: result.forkedSessionId,
          }),
      );
      return {
        copiedMessageCount: result.copiedMessageCount,
        forkedSessionId: result.forkedSessionId,
        response: `${result.response}\nSwitched to forked session ${result.forkedSessionId}.`,
        restoredFileCount: result.restoredFileCount ?? result.restoredFiles?.length ?? 0,
      };
    },
    getApp,
    getMode: () => currentCliMode(modeState),
    getLocale: () =>
      app?.getLocale?.() ?? resolveDisplayLocale(activeUiLocale, uiDetectedLocale) ?? startupLocale,
    hasSelectableModels: createTuiModelAvailabilityChecker(getApp),
    listCustomCommands: () => listCustomCommandsForTui(deps),
    listSessions: () => listSessionsForTui(deps),
    listSkills: () => listSkillsForTui(deps),
    configureApiKey: (options) => configureApiKeyForTui(deps, options),
    login: (options) => loginForTui(deps, options),
    loginBigmodel: (options) => loginBigmodelForTui(deps, options),
    loadCustomCommand: (name) => loadCustomCommandForTui(deps, name),
    newApp,
    recordInputHistory: async (input, kind) => {
      await app?.recordInputHistory?.(input, kind);
    },
    resumeApp,
    // 默认模型写入走进程级 provider registry 而不是当前 App，换会话后仍然生效
    // repository 缺失时抛错，静默丢弃会让用户以为默认值已经持久化
    saveDefaultModelSelection: async (selection) => {
      const runtime = await processRuntime.providerRegistryRuntimePromise;
      if (!runtime?.modelSelectionConfigRepository) {
        throw new Error("Default model configuration storage is unavailable.");
      }
      await runtime.modelSelectionConfigRepository.saveConfiguredDefault(selection);
    },
    logout: () => logoutForTui(deps),
    // App 存在时由 App 落盘并返回结果，这条路径不要再写一次配置文件
    // 没有 App 时直接改写用户配置，并把新 locale 记在内存里等建 App 时带入
    // [权衡] 两条分支的返回结构必须一致，TUI 侧按同一形状渲染提示
    setLocale: async (locale) => {
      if (app?.setLocale) {
        const result = await app.setLocale(locale);
        activeUiLocale = locale;
        return result;
      }
      activeUiLocale = locale;
      const persisted = await updateUiLocaleInFileConfig(
        deps.userConfigPath ?? getDefaultConfigPath(),
        locale,
      );
      return {
        configPath: persisted.path,
        locale: resolveDisplayLocale(locale, uiDetectedLocale) ?? "en-US",
        requestedLocale: locale,
      };
    },
    setMode: setCliMode,
    workflowMode,
  });

  // [并发] 审批回调按回合覆盖再在 finally 还原，不能赋值后就不管
  // finally 里还原成进入前的值而不是 undefined，嵌套调用要能逐层回退
  // 结果附加 session 元数据只在 App 已存在时做，避免为补元数据强建 App
  // 不吞异常，命令中心的错误交给上层统一呈现
  const submitPrompt: TuiPromptHandler = async (input, options) => {
    const previousRequestPermission = activeRequestPermission;
    activeRequestPermission = options.requestPermission;

    try {
      const result = await commandCenter(input, options);
      return app ? { ...result, ...(await readTuiSessionMetadata(await getApp())) } : result;
    } finally {
      activeRequestPermission = previousRequestPermission;
    }
  };

  submitPrompt.setMode = async (nextMode) => ({ mode: await setCliMode(nextMode) });

  // sendInput 是忙碌回合的旁路入口，同样要在这层设置审批回调
  // 不设置的话本回合的审批会落到上一个回合的回调甚至无人处理
  // [契约] model 与 effort 属于配置下一次请求，必须回落 submitPrompt 走命令中心
  // 其余输入交给 App 的 sendInput，未启动回合时也要补齐 TUI 元数据
  submitPrompt.sendInput = async (input, options) => {
    const previousRequestPermission = activeRequestPermission;
    // busy-turn or resumed input can start a new turn through sendInput,
    // bypassing submitPrompt's scoped approval handler and leaving approvals invisible.
    activeRequestPermission = options?.requestPermission;

    try {
      // Model/effort changes configure subsequent requests, including during an active turn.
      const command = parseSlashCommand(typeof input === "string" ? input : input.text);
      if (command?.type === "known" && (command.name === "model" || command.name === "effort")) {
        return {
          kind: "command_result",
          result: await submitPrompt(input, {
            ...options,
            abortSignal: options?.abortSignal ?? new AbortController().signal,
          }),
        };
      }
      const activeApp = await getApp();
      if (activeApp.sendInput) {
        const result = await activeApp.sendInput(input, options);
        if (result.kind !== "started_turn") return result;
        return withTuiMetadata(result.result, activeApp, currentCliMode(modeState));
      }

      return withTuiMetadata(
        await activeApp.submitPrompt(input, options),
        activeApp,
        currentCliMode(modeState),
      );
    } finally {
      activeRequestPermission = previousRequestPermission;
    }
  };

  // 查询类方法统一在这里挂载，保持 handler 对外形状稳定，不要在别处零散赋值
  // 挂载发生在返回之前，调用方拿到 handler 时查询能力必须已经可用
  attachTuiAppQueries(submitPrompt, getApp);

  // sink 注册到常驻 relay 后立即返回退订函数，调用方无需感知挂载时机
  // App 未就绪时首次实挂会落空，所以建好后补挂一次
  // 补挂失败要吞掉：handler 正在关闭时 getApp 会 reject，这不是订阅方的错
  submitPrompt.subscribeSessionEvents = (sink: (event: SessionEvent) => void) => {
    const unsubscribe = sessionEventRelay.addSink(sink);
    // app 还没建好时首次实挂会落空；建好后再挂一次（reattach 幂等，不会重复扇出）。
    void getApp().then(
      () => sessionEventRelay.reattach(),
      () => undefined,
    );
    return unsubscribe;
  };

  // 主会话 id 供 TUI 做事件闸门，子会话事件仍保留自己的 sessionId 进同一个 sink 集
  // 每次现读而不是缓存，换 App 就换会话，缓存值会把整条转写判成外来事件
  // 空串按 undefined 返回，让调用方走尚无主会话的分支
  // 主会话 id：给 TUI 做会话闸门用（actor/子会话事件保留子 sessionId 投进同一个 sink 集）。
  // 每次现读而不是缓存：replaceApp 换 app 就换会话，缓存下来的 id 会把整条转写判成外来。
  submitPrompt.getMainSessionId = () => {
    const runtime = (app as { runtime?: { getSessionId?: () => string } } | undefined)?.runtime;
    const sessionId = runtime?.getSessionId?.();
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
  };

  // closeHandlerPromise 的 ??= 保证 shutdown 只执行一次，重复调用只是等待
  // 先关 App 再关进程级 telemetry 与 provider registry，顺序反了会丢掉退出前的事件
  // 不要在 /new、/resume 路径调用这里，那些路径只换 App 不做对称 shutdown
  // 即使某一步 cleanup 超时也要继续走完后续释放，不能中途返回
  submitPrompt.close = async () => {
    closeHandlerPromise ??= (async () => {
      await closeApp();
      // Bug 根因：TUI 的 Session 切换和进程退出共用了 App close，不能在 /new 等路径
      // 提前关闭共享 Owner；只有整个 Prompt Handler 终态才做对称 shutdown。
      await runCliCleanupWithTimeout(
        async () => processRuntime.shutdownTelemetry?.(),
        cleanupTimeoutMs,
      );
      const providerRegistryRuntime = await processRuntime.providerRegistryRuntimePromise;
      providerRegistryRuntime?.dispose();
    })();
    await closeHandlerPromise;
  };

  // 返回的 handler 已挂齐 setMode、sendInput、close 等能力，调用方不再二次装配
  // 此处是装配终点，新增出口能力应挂在上面这个 submitPrompt 上而不是另起对象
  return submitPrompt;
}
