/**
 * create-app：CLI/bootstrap 进程内的单会话主装配入口。
 * 定位：配置 → 插件/技能/子代理 → 会话存储 → runtimeConfig 合并 → 端口（MCP/execution/fs/http/pdf/image）
 *   → model factory → 三条 workflow 子装配线（script bridge、dwf run/snippet、expert facade）→ AgentRuntime
 *   → input/session/workflow 门面，最终拼成 ZCodeApp。
 * 不变量：
 *   1) Provider Registry 必须由调用方注入（唯一硬前置），且早于 modelFactory/Model 构造。
 *   2) modelFactory 全进程只此一份；父会话与所有 workflow 子代理共享同一 Registry 视图，不各自冻结。
 *   3) 所有权用 owns* 标记区分：只有本函数创建的 store/端口在 close 时释放，注入的由调用方负责。
 *   4) 失败路径按初始化逆序回收已创建资源，并先把 startupTimer 标为 total 失败再原样抛错。
 * 反直觉取舍：dwf run service 必须先于 AgentRuntime 构造（它是 runtime 的依赖），因此其回调统一惰性取
 *   runtime；而 resume/模型选择恢复推迟到首次真实用户执行边界，避免在无用户输入时提前绑定执行面。
 */
// 职责边界（createZCodeApp）：CLI/bootstrap 进程内单会话 App 的唯一装配入口。
// 做：配置 → 插件/技能/子代理 → 会话存储 → runtimeConfig 合并 → 端口 → model factory → 三条 workflow 装配线 → AgentRuntime → 三个门面。
// 不做：CLI 参数解析、TUI 渲染、任务执行；本函数只把已注入或自建的端口连成可运行的 App。
// 依赖：调用方注入 providerRegistry（唯一硬前置），其余端口/存储/事件汇可注入。
// 边界：所有权按 owns 标记区分；注入资源由调用方负责，本函数只回收自己创建的对象。
// 装配顺序：自上而下串行，后面的步骤依赖前面的产物，不能并行化。
// 失败语义：任何前置校验或装配失败都抛原错误，调用方丢弃半成品 App。
//
// INV 不变量表（每条都对应一种静默故障，改前先确认它守的是什么）
// INV-01 断言：Provider Registry 由调用方注入且早于 modelFactory/Model 构造 —— 守住它的位置：函数入口校验 —— 改错故障：模型绑定为空却继续跑，执行期才报错
// INV-02 断言：装配严格自上而下串行 —— 守住它的位置：try 块内语句顺序 —— 改错故障：runtimeConfig 早于 pluginOutcome 合并，插件 MCP 丢失
// INV-03 断言：runtimeConfig 只在 AgentRuntime 构造前合并一次 —— 守住它的位置：resolveAppRuntimeConfig 调用点 —— 改错故障：构造后再改会让 runtime 与“可见集合”分叉
// INV-04 断言：configuredMcpServers 与 runtimeConfig.mcp.servers 必须同源改写 —— 守住它的位置：browser broker 注入块 —— 改错故障：面板可见但运行时连不上
// INV-05 断言：modelFactory 全进程一份，父子会话共享 —— 守住它的位置：providerModelRuntime.modelFactory 赋值 —— 改错故障：child 各自冻结旧 Registry 视图
// INV-06 断言：只有 owns 标记为真的资源才能 close —— 守住它的位置：ownsMcpPort/ownsExecutionPort/ownsSessionStore —— 改错故障：关掉注入资源并连坐其他 App
// INV-07 断言：AgentRuntime 最后构造，run service 的 runtime 回调一律惰性 —— 守住它的位置：getRuntime —— 改错故障：提前取实例形成构造环或 NPE
// INV-08 断言：dwf run service 先于 AgentRuntime 构造 —— 守住它的位置：createDynamicWorkflowRunService 调用位置 —— 改错故障：runtime 缺少 workflowPort 依赖
// INV-09 断言：journal 缺失时不构造 run 端口 —— 守住它的位置：resolveDynamicWorkflowJournalStore 判空 —— 改错故障：半残端口静默丢持久化
// INV-10 断言：模型选择恢复只恢复“保存意图” —— 守住它的位置：setSessionModelSelection 入参 —— 改错故障：删档位后 Selection View 永久丢失原配置
// INV-11 断言：模型校验失败只影响绑定，不影响保存 —— 守住它的位置：validation?.ok 分支 —— 改错故障：把用户选择置空，账号恢复后无法重新解析
// INV-12 断言：失败回收只释放本函数创建的资源 —— 守住它的位置：catch 块 —— 改错故障：关闭注入 store 并破坏宿主其他会话
// INV-13 断言：catch 必须原样 throw 原始错误 —— 守住它的位置：catch 末尾 —— 改错故障：包装错误后上层无法按类型分类
// INV-14 断言：startupTimer.fail 只记账不改错误形态 —— 守住它的位置：fail 调用 —— 改错故障：在此抛新错会掩盖真实根因
// INV-15 断言：附件解码保留 text/plain 复用通道 —— 守住它的位置：decodePromptAttachmentDataUrl 媒体判断 —— 改错故障：文本材料预览被白名单一刀切拒绝
// INV-16 断言：附件 ref 优先取不可变 artifact 副本 —— 守住它的位置：resolvePromptAttachment —— 改错故障：直读 live 路径，源文件删除后冷热预览不一致
// INV-17 断言：close 顺序是 session → recorder → provider runtime → telemetry —— 守住它的位置：返回对象的 close 实现 —— 改错故障：关闭期间仍向已关 store 追加事件
// INV-18 断言：三层 try/finally 链不可简化 —— 守住它的位置：close 内部 —— 改错故障：任一前置失败都会跳过遥测 shutdown
// INV-19 断言：三个门面只是 runtime 的读写适配 —— 守住它的位置：facade 构造 —— 改错故障：出现第二份 runtime 或第二份模型事实源
// INV-20 断言：browser broker 只在宿主注入且 browserUse 开启时创建 —— 守住它的位置：注入条件 —— 改错故障：纯 CLI 假装拥有浏览器底座
//
// 阅读顺序：入口校验 → 配置与日志 → try 内资源装配 → model factory → workflow → runtime → 门面 → 返回。
// 本文件是 .ts：新增注释只放在语句之间，避免被当成语句或改变 ASI 语义。
// 判断“这段能不能挪”时先看 owns 标记与闭包捕获：多数错误不是类型错，而是关闭顺序或捕获时机。
// 运行时的 runtimeConfig 已定型；“可见集合/连接集合”都指此处之后的只读快照。
// 三条子装配线（script bridge、dwf run/snippet、expert facade）共享同一份 modelFactory 与 permissionService。
// close 的职责在 sessionFacade 与本文件末尾的显式覆盖之间分工，不要在两处重复释放同一资源。
import { subagentProfilesFromSnapshot } from "../runtime-subagents/index.js";
import { CliDefaultSelection } from "./cli-default-selection.js";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
} from "@zcode/adapters/storage";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import {
  createNodeExecutionAdapter,
  resolveEffectiveBashShellSelection,
} from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import {
  AgentRuntime,
  normalizeAgentProfiles,
  PermissionService,
  buildPluginReferenceCatalog,
  writeWorkflowDraft,
  type AmendWorkflowRunSettingsInput,
  type ResumeSessionResult,
} from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import {
  createRootTraceContext,
  traceContextToLogContext,
  type TraceContext,
  createSessionId,
  createSessionEvent,
  type ExecutionShellSelection,
  type MessageId,
} from "@zcode/contracts";
import { isRemoteWorkspaceIdentity, resolveZCodeRuntimeEnv } from "@zcode/shared";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";

import { createModelAdapter } from "../model-factory.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type {
  PrepareUserExecutionBoundary,
  ResumeOptions,
  ZCodeApp,
  ZCodeAppOptions,
} from "./types.js";
import {
  createConfigCliOverrides,
  isMessageEnabled,
  resolveEffectiveLocale,
  resolveEffectiveConfigResult,
} from "./app-config-options.js";
import { getCliStorageRoot, getModelIoDir, projectIdFromDirectory } from "./paths.js";
import {
  composeConversationEventSink,
  resolveConversationRecorder,
} from "../conversation-recording/index.js";
import {
  asInputHistoryStore,
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
  readSessionModelSelection,
} from "./session-store.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createInputFacade } from "./input-facade.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { createSessionFacade } from "./session-facade.js";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import {
  createDynamicWorkflowRunService,
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
} from "./dynamic-workflow-run-service.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import { workflowActorModelPolicy } from "./workflow-actor-model.js";
import {
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
} from "./workflow-actor-permission.js";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { resolveZCodeBuiltinPromptCommandInvocation } from "../builtin-prompt-command.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import {
  loadPluginAgentTemplates,
  resolvePluginAgentProfiles,
  loadZCodeAgentProfiles,
} from "../subagents.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import {
  completeAppStartup,
  debugRuntimeConfigResolved,
  markConfigurationLoaded,
  markMcpAdapterInitialized,
  markRuntimeConstructed,
  markStorageAdaptersInitialized,
  resolveStartupPlugins,
  startAppStartup,
} from "./startup-marks.js";

/**
 * 把 artifact 里的 data URL 还原成附件字节。
 * 输入：content 为完整 data URL；fallbackMime 是持久化记录里的 MIME，仅在 URL 头缺席时兜底；
 *   maxBytes 是解码后的硬上限。
 * 输出：原始字节与最终 mediaType（取自 URL 头，其次 fallback）。
 * 失败语义：非 base64、payload 字符集非法、长度非 4 对齐、超限、以及非受支持媒体类型都抛稳定错误码，
 *   让上层按错误码而非文本分类。
 * 不变量：只接受图片、视频、application/pdf，以及 fallback 同为 text/plain 的文本预览——
 *   后者是文本材料复用上传 artifact 的合法通道，不能用"媒体白名单"一刀切拒绝。
 */
function decodePromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
  maxBytes: number,
): { bytes: Uint8Array; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    throw new Error("fault.attachment.previewArtifactInvalid");
  }
  if (
    !mediaType.startsWith("image/") &&
    !mediaType.startsWith("video/") &&
    mediaType !== "application/pdf" &&
    // 根因：文本材料复用上传 artifact，但原 data URL 解码器仅接受媒体，合法预览被二次拒绝。
    !(
      mediaType === "text/plain" &&
      fallbackMime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
    )
  ) {
    throw new Error("fault.attachment.previewNotMedia");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("fault.attachment.previewTooLarge");
  }
  return { bytes, mediaType };
}

/**
 * 装配一个可运行的 ZCodeApp（单会话）。
 * 输入：ZCodeAppOptions——必填 providerRegistry；其余端口/存储/事件汇可注入，未注入则由本函数创建并接管所有权。
 * 输出：ZCodeApp，包含 runtime、session/workflow/input 门面、附件读写、workspace hook 审核入口与 close。
 * 副作用：打开会话存储（按需迁移）、启动模型运行时与遥测、注册 provider 运行时、清理启动日志、
 *   构造 workflow 子代理 runtime 与 MCP 适配器。
 * 失败语义：任何前置校验或装配失败都抛原错误；调用方需丢弃半成品 App（本函数只会回收自己创建的资源）。
 * 不变量：同一个 App 内只有一个 AgentRuntime、一个 modelFactory、一个并发治理器单例；
 *   provider registry 的选择只是"保存意图"，未校验通过时只影响执行绑定，不被删除或置空。
 */
// [契约] 唯一硬前置是 providerRegistry：模型事实源缺失时后续校验都无意义，因此先抛错再分配资源。
// 先算 sessionId、traceContext 与 workingDirectory，再解析配置：日志与端口都依赖它们。
// 不要在这里做 await 之外的副作用：抛出时调用方要求“没有半成品”。
// 返回值是结构化 App 对象而非类实例，扩展能力靠对象展开而不是继承。
// 配置解析的结果会同时进入 storage、runtimeConfig 与门面，三处必须读同一份。
// 任何新增的端口都要先决定所有权（注入还是自建），否则 close 一定会漏或误关。
// 本函数不抛业务错误，只抛装配错误与前置校验错误。
// 不要为了复用把某段装配抽成共享可变状态：单会话 App 的生命周期就是本函数的调用期。
export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    // 唯一硬前置：Registry 是模型事实源，缺它时后续 modelFactory/selection 校验都无从谈起。
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  // [可观测] startupStartedAt 必须早于任何配置解析，否则耗时统计漏掉最慢的一段。
  // appVersion 与 sessionId 在这里定型，后续日志与事件复用同一份值。
  // traceContext 未注入时创建根上下文：子 session 与工具调用都要挂同一 traceId。
  // workingDirectory 先 resolve 成绝对路径，后续 cwd、Git 与路径展示都以它为准。
  // env 可能由调用方注入，不能在这里读 process.env 覆盖它。
  // 版本回退值 0.0.0 只用于未打包场景，不要用来判断开发/生产。
  // sessionId 的生成必须在配置之前，配置日志需要它作为关联键。
  // 这些值一旦确定就不再改写，避免同一会话出现两个身份。
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  // [契约] loggerFactory 可注入（测试/宿主），未注入才创建 Node 实现。
  // logger 的 child 带 trace 上下文与 module 字段，后续子系统复用同一个 logger。
  // 不要在 logger 创建前写日志：会退化成 console 并绕过落盘。
  // startupTimer 与 logger 同在 try 之外创建，失败路径也要能用它记账。
  // modelLogger 是另一个 module 的 child，不能与 bootstrap logger 混用。
  // startAppStartup 与 markConfigurationLoaded 只记账，不参与装配决策。
  // modelTelemetry 的 owner 来自 options，缺失时由实现给默认归属。
  // 遥测在 try 之外创建：即使装配失败也要能 shutdown。
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  // [资源] 三个 let 是失败回收的抓手：只有本函数创建的对象才会被赋值。
  // nodeReplBrowserBroker 是“实际使用”，ownedNodeReplBrowserBroker 是“归我关闭”，不能合并。
  // providerModelRuntime 在 try 内创建，catch 里按是否已构造决定 dispose。
  // try 覆盖全部资源创建：catch 只能按“谁创建谁负责”回收，注入对象一律不碰。
  // 装配严格自上而下，后面的步骤依赖前面的产物，不能并行。
  // 新增可回收资源时必须同时在这里声明并在 catch 回收，漏一处就是泄漏。
  // 这些变量不要导出：它们只是闭包内的生命周期句柄。
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  // try 覆盖全部资源创建：catch 只能按"谁创建谁负责"回收，注入的对象一律不碰。
  // 装配严格自上而下：后面的步骤依赖前面的产物（如 runtimeConfig 依赖 pluginOutcome），不能并行。
  try {
    // [契约] storageRoot 来自最终配置，不要在别处再算一遍。
    // cliStorageRoot 是 CLI 自有子目录，与宿主共享的 storageRoot 所有权不同。
    // modelIoDir 只在 development 下展开，生产环境不落盘模型 IO。
    // conversationRecorder 是显式开启的旁路能力：关闭时不建目录、不改事件与模型路径。
    // eventSink 用 compose 叠加宿主 sink 与记录 sink，记录失败在 recorder 内部吞掉。
    // hostSubagentSnapshot 的 signal 用一次性 AbortController：启动期没有取消源。
    // 子代理配置优先用宿主快照，缺席才读本地 profiles。
    // 随 CLI 内置的技能包不属于任何插件，用户无法停用或卸载。
    // pluginTemplates 必须早于 pluginSubagentProfiles：后者依赖前者的保留名。
    // subagentProfiles 是内置与插件的合并结果，后续 runtimeConfig 直接消费它。
    const storageRoot = resolvePath(configResult.config.storage.dir);
    const cliStorageRoot = getCliStorageRoot(storageRoot);
    const modelIoDir = getModelIoDir(
      cliStorageRoot,
      resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
    );
    // 完整对话记录是显式开启的旁路能力；未开启时不创建目录、不改变事件与模型路径。
    const conversationRecorder = resolveConversationRecorder({
      ...(options.recordConversation === undefined
        ? {}
        : { cliEnabled: options.recordConversation }),
      ...(options.recordConversationDir ? { cliDir: options.recordConversationDir } : {}),
      cliStorageRoot,
      config: configResult.config.recording.conversation,
      logger: modelLogger,
    });
    // 记录 sink 与宿主 sink 同时生效；记录失败在 recorder 内部吞掉，不影响事件发布。
    const eventSink = composeConversationEventSink(options.eventSink, conversationRecorder);
    // 初始化与父轮必须使用同一 Host 来源，避免 CLI storage.dir 的另一份定义在首轮消失。
    // [契约] 宿主快照存在时不再读本地 agent 配置，避免两套身份来源。
    // readSubagentRuntimeConfig 是唯一异步读取入口，signal 必须传入。
    // built-in-fallback 快照表示宿主没有真实配置，此时不追加插件 profiles。
    // reservedProfileNames 用内置 profile 名，防止插件覆盖内置身份。
    // modelSelectionOverrides 只影响模型绑定，不改变 profile 的存在性。
    // pluginOutcome 必须在此之后解析：它依赖配置与 storage 根。
    // bundledSkillRoots 与插件 skillRoots 分开：前者不可停用。
    // pluginRuntimeFeatures 决定 browser broker 与 dynamic workflow 的可用面。
    // builtInMcpServers 与插件 MCP 的合并顺序在 resolveAppRuntimeConfig 内固定。
    // 不要在这里 push 到数组：合并只发生一次。
    const hostSubagentSnapshot = await options.readSubagentRuntimeConfig?.({
      signal: new AbortController().signal,
      traceContext,
    });
    const zcodeSubagentProfileOutcome = hostSubagentSnapshot
      ? subagentProfilesFromSnapshot(hostSubagentSnapshot)
      : await loadZCodeAgentProfiles({
          logger,
          storageRoot,
          workingDirectory,
          additionalDirectories: options.additionalDirectories,
        });
    const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
    const pluginOutcome = resolveStartupPlugins({
      cliStorageRoot,
      configResult,
      env: options.env,
      logger,
      options,
      startupTimer,
      workingDirectory,
    });
    // 随 CLI 内置的技能包（dynamic-workflows 等）：不属于任何插件，用户无法停用或卸载。
    const bundledSkillRoots = resolveBundledSkillRoots({ cliStorageRoot, logger });
    const pluginTemplates = loadPluginAgentTemplates({ logger, plugins: pluginOutcome.plugins });
    const pluginSubagentProfiles =
      hostSubagentSnapshot?.kind === "built-in-fallback"
        ? []
        : resolvePluginAgentProfiles(
            {
              logger,
              plugins: pluginOutcome.plugins,
              reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
              modelSelectionOverrides:
                zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
            },
            pluginTemplates,
          ).profiles;
    const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
    const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome,
      workingDirectory,
    });
    // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
    // [契约] 合并顺序是内置在前、插件在后，后者不得覆盖前者。
    // 数组在 runtimeConfig 解析前定型，后续只读，不要再 push。
    // 不要用展开生成第二份数组给不同消费者：这里就是唯一来源。
    // 插件 profile 与插件模板一一对应，缺模板时 resolvePluginAgentProfiles 自行跳过。
    // 内置 profile 为空是合法状态：宿主可能只提供插件身份。
    // 该数组同时进入 resolveAppRuntimeConfig 与 loadAgentDefinitions，语义必须一致。
    // 新增来源（如项目级 profile）必须在这里合并，不能在各 consumer 内各自追加。
    // 注释里的“内置”指随 CLI 分发的 profile，不含插件模板。
    const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
    // 存储所有权：注入的 store 归调用方（可能被多个 App 共享），关 App 时不得关它；
    // 只有本函数 openStartupSessionStore 打开的才在 close 中释放（并负责迁移完成）。
    // [资源] ownsSessionStore 决定 close 时是否释放 store：注入的 store 可能被多个 App 共享。
    // openStartupSessionStore 负责迁移与打开，注入路径不重复迁移。
    // localSettingStore 只是同一 store 的窄视图，不产生第二份连接。
    // projectID 由 workingDirectory 推导，权限模式读取按它定位。
    // persistedMode 只用于 runtimeConfig 合并，不写回 store。
    // 注入 store 时 localSettingStore 仍从同一实例派生，避免读写分叉。
    // [顺序] openStartupSessionStore 先跑迁移再返回 store；迁移前读设置会拿到旧列定义，写入直接失败。
    // 打开失败会让整个 try 失败，catch 只回收已创建对象。
    // 这里不关闭 store：关闭语义统一由 sessionFacade 承担。
    // sessionStore 的类型必须支持后续 dwf journal 探测，否则 run 能力会静默缺席。
    const ownsSessionStore = options.sessionStore === undefined;
    const sessionStore =
      options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
    const localSettingStore = asLocalSettingStore(sessionStore);
    const projectID = projectIdFromDirectory(workingDirectory);
    const persistedMode = options.runtimeConfig?.mode
      ? undefined
      : readProjectPermissionMode(localSettingStore, projectID);
    // runtimeConfig 必须在此一次性合并定型，且发生在 AgentRuntime 构造之前：
    //   pluginMcpServers（插件）→ 用户/项目配置 → builtInMcpServers（内建最后合并、保留 identity），
    //   三层合并与 untrusted 投影都在 resolveAppRuntimeConfig 内完成；App 之后只读不重算。
    // configuredMcpServers 是"启动时可见的 server 集合"（含内建、已过信任裁剪），
    // runtimeConfig.mcp.servers 是"运行时真正连接的那份"——两者在此之后才可能因 browser broker 注入而同步改写。
    let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } =
      resolveAppRuntimeConfig({
        cliStorageRoot,
        configResult,
        options,
        persistedMode,
        pluginHooks: pluginOutcome.hooks,
        pluginMcpServers: pluginOutcome.mcpServers,
        builtInMcpServers,
        pluginRuntimeFeatures,
        builtInSubagentModelSelectionOverrides:
          zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
        subagentOutputRootDir: join(cliStorageRoot, "agents"),
        subagentProfiles,
        storageRoot,
        workingDirectory,
        workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      });
    // browser-use 的 node_repl broker 注入必须紧跟 runtimeConfig 合并、且早于 AgentRuntime 构造：
    // 只有宿主（desktop）注入 browserControlPort 才生效，纯 CLI 无浏览器底座，故不提供本地 fallback。
    // 注入同时改写 configuredMcpServers 与 runtimeConfig.mcp.servers，保持"可见集合"与"连接集合"同源。
    const browserControlPort = options.browserControlPort;
    if (
      browserControlPort &&
      pluginRuntimeFeatures.browserUse === true &&
      runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
    ) {
      nodeReplBrowserBroker =
        options.nodeReplBrowserBroker ??
        (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
          browserControlPort,
          logger,
          platform: options.platform,
        }));
      configuredMcpServers = injectNodeReplBrowserBroker(
        configuredMcpServers,
        nodeReplBrowserBroker,
      );
      runtimeConfig.mcp = {
        ...runtimeConfig.mcp,
        servers: injectNodeReplBrowserBroker(
          runtimeConfig.mcp.servers ?? {},
          nodeReplBrowserBroker,
        ),
      };
    }
    startupTimer.mark("ZCode runtime configuration resolved", {
      context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
      event: "bootstrap.app.startup.runtime_config.completed",
      stage: "resolve_runtime_config",
    });
    // Plugin 对话引用：身份 catalog 在 App（Session runtime）
    // 创建时冻结一次。冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin。
    // [契约] Plugin 引用 catalog 在 Session runtime 创建时冻结一次，冷恢复重建 App 才会重读。
    // 不热加载新 Plugin：已有 Session 的 catalog 必须与历史消息里的引用一致。
    // runtimeConfig.pluginReferenceCatalog 是 runtime 的唯一读取入口。
    // catalog 依赖 pluginOutcome.plugins，必须在插件解析之后构建。
    // 冻结发生在 AgentRuntime 构造之前，构造之后再赋值不会生效。
    // catalog 不参与权限判定，只用于展示与引用解析。
    // 不要给 catalog 加增量更新接口：热更新会破坏历史引用。
    // 传给 buildPluginReferenceCatalog 的是最终插件集合，不要再过滤一遍。
    const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    const cliDefaultSelection =
      options.modelSelectionMode === "cli-default"
        ? new CliDefaultSelection(runtimeConfig.modelSelection)
        : undefined;
    // [契约] workspaceHookRuntimeSecurity 是可选能力：未注入 reviewHost 时整体缺席。
    // runtimeRoot 优先取 config-factory 推导结果，fallback 必须覆盖全部配置层。
    // 按单层 runtimeConfig.hooks 重建 runtimeRoot 会让 bundleDigest 与 toggle 不一致，必须保留完整推导。
    // emitReviewEvent 与 emitAdmissionEvent 惰性取 runtime：构造时 runtime 还不存在。
    // 两个 emit 各自判空并抛同一错误，避免半初始化时静默丢事件。
    // sessionId 与 traceContext 必须透传，否则审核事件无法归属会话。
    // snapshot 来自 configResult.sources.project，不能运行时重算。
    // userConfigPath 用于信任范围判定，不能省略。
    // workingDirectory 是 workspace 身份的一部分，缺失会让信任落到错误目录。
    // 返回值里的 respond/toggle/revoke 逐个兜底为 accepted:false，不能抛错。
    const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
      appVersion,
      logger,
      projectConfigPath: options.projectConfigPath,
      policy: options.workspaceHookPolicy,
      policyProvider: options.workspaceHookPolicyProvider,
      reviewHost: options.workspaceHookReviewHost,
      workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
      runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
        // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
        // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
        // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
        // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
        // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
        enabled: runtimeConfig.hooks?.enabled === true,
        timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
        maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
      },
      sessionId,
      snapshot: configResult.sources.project.workspaceHookSnapshot,
      userConfigPath: configResult.sources.user.path,
      workingDirectory,
      ...(options.workspaceHookReviewHost
        ? {
            emitReviewEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
            emitAdmissionEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
          }
        : {}),
    });
    const permissionService = new PermissionService({
      allowedTools: new Set(configResult.config.permission.allowedTools),
      autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
      disallowedTools: new Set(configResult.config.permission.disallowedTools),
      allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
    });
    const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
    const artifactStore =
      options.artifactStore ??
      createNodeToolArtifactStore({
        imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
        pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
        rootDir: join(storageRoot, "cli", "artifacts"),
        videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
      });
    const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
    const messageEnabled = isMessageEnabled(options.env ?? process.env);
    const sessionMailboxPort =
      options.sessionMailboxPort ??
      (messageEnabled
        ? createNodeSessionMailboxAdapter({
            rootDir: resolvePath(
              (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
            ),
          })
        : undefined);
    markStorageAdaptersInitialized({
      cliStorageRoot,
      hasInjectedArtifactStore: options.artifactStore !== undefined,
      hasInjectedSessionStore: options.sessionStore !== undefined,
      startupTimer,
      storageRoot,
    });
    // MCP 端口在此只"建适配器"，不建连接：连接与工具目录由 core/runtime 按需建立。
    // mcp.enabled === false 时端口为 undefined，runtime 因而不暴露 MCP 工具面。
    const mcpPort =
      options.mcpPort ??
      (runtimeConfig.mcp?.enabled === false
        ? undefined
        : (options.mcpPortFactory?.({ workingDirectory }) ??
          createMcpAdapter({
            clientVersion: appVersion,
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            workingDirectory,
          })));
    // 同上：mcp/execution 端口可能由宿主注入（多 App 共享），owns* 决定 close 时是否真的关闭；
    // 注入端口的生命周期由调用方管理。
    // [资源] ownsMcpPort 只在本函数创建 adapter 时为真；注入端口由调用方关闭。
    // mcp.enabled === false 时端口为 undefined，runtime 因此不暴露 MCP 工具面。
    // mcpPortFactory 优先级低于 options.mcpPort，只在没有显式注入时使用。
    // executionPort 与 mcp 端口读同一份 network 配置，不能各读一份。
    // ownsExecutionPort 与 ownsMcpPort 分开：两者可能一个注入一个自建。
    // pdfDocumentPort 依赖 executionPort，必须先有后者。
    // fileSystemPort 与 httpClientPort 没有 owns 标记，因为 App 不负责关闭它们。
    // browserControlPort 仅宿主注入，纯 CLI 无本地 fallback。
    // markMcpAdapterInitialized 只记账，不建立连接。
    // 连接与工具目录由 core/runtime 按需建立，这里只造适配器。
    const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
    const executionPort =
      options.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: options.onToolExecResource,
        network: {
          httpProxy: configResult.config.network.httpProxy,
          noProxy: configResult.config.network.noProxy,
          caCertFile: configResult.config.network.caCertFile,
        },
        outputRootDir: join(storageRoot, "cli", "exec"),
        bashOutputTempDir: tmpdir(),
        processEnv: options.env ?? process.env,
      });
    const ownsExecutionPort = options.executionPort === undefined;
    const pdfDocumentPort =
      options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
    // browser-use 控制端口：仅当宿主（desktop）注入时可用，无本地 fallback（纯 CLI 无浏览器底座）。
    const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
    const httpClientPort =
      options.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: options.env ?? process.env,
        timeoutMs: configResult.config.network.timeout,
        proxyUrl: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      });
    const providerEndpointRoutingPort = options.providerEndpointRoutingPort;
    markMcpAdapterInitialized({
      configuredMcpServers,
      hasInjectedMcpPort: options.mcpPort !== undefined,
      mcpEnabled: runtimeConfig.mcp?.enabled !== false,
      startupTimer,
      trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
    });
    debugRuntimeConfigResolved({
      configResult,
      logger,
      runtimeConfig,
    });
    // [生存期] getRuntime 是“runtime 已构造”的唯一断言点，所有惰性回调都必须经它取实例。
    // 直接闭包捕获 runtime 变量会读到 undefined，且在构造环里永远不会更新。
    // resumePrepared 标记只用于避免重复 resume，不是并发锁。
    // resolveDefaultShellSelection 每次调用都读 env/platform，不缓存。
    // resolveInitialShellSelection 用 ??= 缓存 Promise，成功与失败都被缓存。
    // initializeSessionShellEnvironment 必须在 resume 之前调用，否则模型看到的 shell 与执行 shell 分叉。
    // shell 初始化只做一次，重复调用必须幂等。
    // 这些闭包在 try 内定义，catch 不应依赖它们。
    // 不要在 getRuntime 里兜底创建 runtime：半初始化实例比抛错更危险。
    // runtime 的赋值只发生在一处，这里只读。
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
      return runtime;
    };
    let resumePrepared = false;
    const resolveDefaultShellSelection = (): ExecutionShellSelection =>
      resolveEffectiveBashShellSelection({
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
      }).selection;
    let initialShellSelectionPromise: Promise<ExecutionShellSelection> | undefined;
    const resolveInitialShellSelection = (): Promise<ExecutionShellSelection> => {
      initialShellSelectionPromise ??= (async () =>
        (await options.resolveInitialBashShellSelection?.()) ?? resolveDefaultShellSelection())();
      return initialShellSelectionPromise;
    };
    const initializeSessionShellEnvironment = async (): Promise<void> => {
      getRuntime().initializeSessionShellEnvironmentIfNeeded(await resolveInitialShellSelection());
    };

    // [失败路径] 读取选择失败只 warn，不拖垮历史恢复。
    // 不能读旧消息或默认模型来掩盖失败：那会把“未知”伪装成“已恢复”。
    // 校验失败只影响绑定，不影响保存意图：selection 仍原样返回。
    // 过去在校验失败时置空选择，Host 的 Selection View 从此拿不到原意图。
    // setSessionModelSelection 传 validation?.ok ? selection : undefined，只绑合法选择。
    // cliDefaultSelection 同步写同一结论，两条读路径不能分叉。
    // 日志包含 validationCode，便于区分“不存在”与“不可用”。
    // 该函数在 resume 与首次执行边界都可能调用，必须可重入。
    // 只查模型是否存在会抵消“未绑定初始化”，不要在恢复路径补这层校验。
    const restorePersistedModelSelection = async (): Promise<
      ResumeSessionResult["modelSelection"]
    > => {
      const registry = options.providerRegistry;
      let selection: ResumeSessionResult["modelSelection"];
      try {
        // 数据库启动已完成版本化迁移；恢复只读新字段，不按会话重复补迁。
        selection = await readSessionModelSelection(sessionStore, sessionId);
      } catch (error) {
        // 选择 entry 的读取/解析故障不能拖垮独立的历史恢复；留下真实存储错误，
        // 不读取旧消息或默认模型来掩盖失败。
        logger.warn("Session model selection restore failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "session.model_selection.restore_failed",
          sessionId,
        });
      }
      const validation = selection && registry.validateSelection(selection);
      if (selection && validation && !validation.ok) {
        // 观测：校验失败只影响运行绑定、不影响保存意图；但一旦不绑定，之后若只发送 execution 作用域的
        // 加速轮就没有机会重新绑定。曾在 Registry 刚就绪、账号权益未解析的 600ms 窗口内静默置空，
        // 直到加速卡过期降级找不到退回目标才暴露，日志里却看不到这一步。
        logger.warn("Session model selection restored but not bound to the runtime", {
          event: "session.model_selection.restore_unbound",
          modelId: selection.modelId,
          providerId: selection.providerId,
          sessionId,
          validationCode: validation.code,
        });
      }
      // 只查模型是否存在会把缺档位/已删除的选择重新绑定进 Runtime，
      // 抵消了未绑定初始化。历史恢复不要求可执行模型，只有完整选择可以绑定。
      getRuntime().setSessionModelSelection(validation?.ok ? selection : undefined);
      cliDefaultSelection?.set(validation?.ok ? selection : undefined);
      // 恢复结果是保存意图，不是执行绑定。过去在这里置空/删档位，Host 的
      // Selection View 就再也拿不到原意图，账号切换和配置恢复后也无法重新解析。
      return selection;
    };

    const resumeFromStore = async (resumeOptions?: ResumeOptions): Promise<ResumeSessionResult> => {
      const runtime = getRuntime();
      const unsubscribe = resumeOptions?.onEvent
        ? runtime.subscribeEvents({ onSessionEvent: resumeOptions.onEvent })
        : undefined;

      try {
        const resumeTraceContext = resumeOptions?.traceContext ?? traceContext;
        const modelSelection = await restorePersistedModelSelection();
        await initializeSessionShellEnvironment();
        const result = await runtime.resumeFromStore({
          ...(resumeOptions?.abortSignal ? { abortSignal: resumeOptions.abortSignal } : {}),
          // 只传调用方原始 mode；项目/全局默认值不能伪装成 invocation override，
          // 否则交互式 resume 将无法恢复真正持久化的 session mode。
          modeOverride: options.runtimeConfig?.mode,
          persistedMessages: resumeOptions?.persistedMessages,
          traceContext: resumeTraceContext,
        });
        await runtime.activatePausedTargetAfterResume(resumeTraceContext);
        resumePrepared = true;
        return { ...result, modelSelection };
      } finally {
        unsubscribe?.();
      }
    };

    const prepareResume = async (
      submitTraceContext?: TraceContext,
      abortSignal?: AbortSignal,
    ): Promise<void> => {
      if (!options.resume || resumePrepared) return;
      await resumeFromStore({
        ...(abortSignal ? { abortSignal } : {}),
        traceContext: submitTraceContext ?? traceContext,
      });
      resumePrepared = true;
    };

    const prepareUserExecutionBoundary: PrepareUserExecutionBoundary = async (boundaryOptions) => {
      // Bash shell 快照属于“首次真实用户执行”边界，而不是 chat
      // input 独有状态。普通 prompt、expert workflow、script workflow 都可能
      // 作为新 session 的第一个模型/子 agent 入口，必须统一在 resume/context
      // 初始化前落定一次，避免模型看到的 Shell 与 Bash 执行 shell 分叉。
      await initializeSessionShellEnvironment();
      await prepareResume(boundaryOptions?.traceContext, boundaryOptions?.abortSignal);
    };

    const modelExecutionConfig = {
      ...createRuntimeAiSdkModelExecutionConfig(options.env, {
        appVersion,
        endpointRoutingPort: providerEndpointRoutingPort,
        network: configResult.config.network,
        sourceTitle: options.sourceTitle,
      }),
      ...(conversationRecorder ? { conversationCapture: conversationRecorder } : {}),
    };
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    // 进程级并发治理器：run service 拿它的窄端口给
    // driver（每个 actor runtime 一个请求级准入端口）；主 runtime 挂它的 observer（下面 deps）——
    // 不排队、不看冷却，但计入在飞并喂信号。进程级单例——配额本就在账号上，不按会话分。
    // 不再经 adapter 级 addStatusSink 喂信号：同一事件只能沿 ticket 喂一次。
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // model factory 提前到三条 workflow child 装配线之前构造：script workflow bridge、dwf actor
    // runtime 与 expert workflow facade 都**共享**父会话这一份 factory——Registry 视图更新后
    // 新建的 Model 才看得到，child 不各自冻结一份。
    // [契约] modelFactory 全进程只此一份，父会话与所有 workflow 子代理共享。
    // Registry 视图更新后新建的 Model 才看得到，child 不各自冻结。
    // 提前到三条 workflow 装配线之前构造：script bridge、dwf actor、expert facade 都用它。
    // modelAdapter 注入时补 statusSink，未注入时由 createModelAdapter 内部接。
    // providerModelRuntime.start() 必须在取 modelFactory 之前调用。
    // 并发治理器是进程级单例，配额在账号上，不按会话分。
    // 不要为 child 单独 new 一个 factory：会绕过 Registry 更新。
    // modelTelemetry 的 statusSink 只接一次，重复接会让信号翻倍。
    // 治理器不再经 adapter 级 addStatusSink 喂信号，同一事件只能沿 ticket 喂一次。
    // workflow 装配线的 deps 里传的是同一个 modelFactory 引用，不要在调用点再包一层。
    const modelFactory = providerModelRuntime.modelFactory;
    const scriptWorkflowFacade = createScriptWorkflowBridge({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      pluginSkillRoots: pluginOutcome.skillRoots,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });

    // workflow run service：CreateWorkflow 的确认窗 Allow 之后真启动引擎的那一侧。
    // journal 窄化失败（store 不带 dwf_* 表）时**不构造**服务——端口保持 undefined，
    // CreateWorkflow 因此回到占位诊断路径。这是一个记了日志的可见降级，而不是一条
    // 会静默丢掉持久化的运行路径（详见 dynamic-workflow-run-service.ts 的文件头）。
    const dynamicWorkflowJournal = resolveDynamicWorkflowJournalStore(sessionStore, logger);
    const dynamicWorkflowRunPort =
      dynamicWorkflowJournal === undefined
        ? undefined
        : createDynamicWorkflowRunService({
            concurrency: workflowConcurrencyGovernor,
            createActorRuntime: ({
              actor,
              persona,
              pinnedModel,
              runSubagentModel,
              actorModel,
              subagentPermissionMode,
              sessionId: actorSessionId,
              submitPort,
              submitProfile,
              escalatePort,
              modelRequestAdmission,
            }) =>
              createScriptWorkflowAgentRuntime({
                childSessionId: actorSessionId,
                configOverrides: {
                  // persona 的身份（有效名 + system）→ context builder 的工作流子代理路径。
                  // 匿名 / 无 system 时字段缺席，builder 据此省略 named 从句与 persona 段。
                  workflowActor: {
                    ...(persona.name === undefined ? {} : { name: persona.name }),
                    ...(persona.system === undefined ? {} : { persona: persona.system }),
                  },
                  // actor 的工具面是减法（全集减去 plan 与越权的元工具），只能经 configOverrides
                  // 表达（request.opts.tools 只有 allowlist）。
                  ...workflowActorToolPolicy(),
                  // 权限面：子代理跑发起会话的权限模式（plan 除外），未记录即 YOLO
                  // （docs/dynamic-workflow/launch.md「Permissions inside a run」）。
                  ...workflowActorPermissionPolicy(subagentPermissionMode),
                  // 模型面：`runSubagentModel` 是本 run 自己的选择（`subagent_model`），在场时整条
                  // 覆盖，排在 pin 之上——主代理不受它影响。没有它也没有 pin 就不覆盖——child runtime
                  // 的基线本就是父会话当前模型（工厂的基线，见 script-workflow-child-runtime.ts）。
                  // resume 带来的 pin 钉住上一次实际跑的模型（persona 冻结不变式的持久化那一半，见
                  // workflow-actor-model.ts 的优先级表）；parentSelection 取父会话**当前**的选择，
                  // 与工厂基线同源，pin 比对才不会漂移。
                  ...workflowActorModelPolicy(
                    {
                      parentSelection: getRuntime().getSessionModelSelection(),
                      ...(runSubagentModel === undefined ? {} : { runSelection: runSubagentModel }),
                      // persona 点名的模型（脚本里的 `agent(…, { model })`）排在 run 选择之上。
                      ...(actorModel === undefined ? {} : { actorSelection: actorModel }),
                    },
                    pinnedModel,
                  ).configOverrides,
                },
                deps: {
                  agentTelemetry: modelTelemetry.agentExecution,
                  appOptions: options,
                  appVersion,
                  artifactStore,
                  configResult,
                  fileSystemPort,
                  httpClientPort,
                  imageProcessorPort,
                  logger,
                  mcpPort,
                  // 父会话的 model factory：actor 与主 turn 从同一份 Registry 视图造 Model，
                  // 不各自冻结一份。
                  modelFactory,
                  permissionService,
                  pluginSkillRoots: pluginOutcome.skillRoots,
                  runtime: getRuntime(),
                  runtimeConfig,
                  sessionId,
                  sessionStore,
                  storageRoot,
                  workingDirectory,
                },
                // persona 不再经 request.opts.systemPrompt 整段替换子代理的系统提示，而是经
                // workflowActor 叠加到基座之上。
                // request 在这里只是工厂签名的占位：opts 为空即「不覆盖任何东西」。
                request: { opts: {} } as never,
                // 权限窗的来源徽标点名这个子代理：`<persona 名> (<siteId>@<ordinal>)`。
                interactionDescription: workflowActorInteractionDescription({ actor, persona }),
                // 子代理的 Browser Use：父会话的端口，由工厂经 forChildSession 派生子端口（tab 归属是
                // actor 自己的 sessionId）。actor runtime 在 run dispose 时 closeBrowserSession，
                // 那一步连 tab 一起关并撤销登记（dynamic-workflow/docs/execution-engine.md「Subagent sessions」）。
                ...(browserControlPort === undefined ? {} : { browserControlPort }),
                traceContext,
                // submit profile → submit_result 形态：
                // `untyped` 不注入端口（core 的注册门是端口在场，于是没有这个工具——全 untyped 的子代理
                // 本来就无处可提交）；`mono` 注入端口 + typed 声明；`generic` 只注入端口（通用声明）。
                ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
                // 展开：dwf 的 JsonSchema 是无索引签名的 interface，contracts 的是 Record；
                // 字面量展开拿到隐式索引签名，不必在两包之间造一个转换函数。
                ...(submitProfile.kind === "mono"
                  ? { workflowSubmitSchema: { ...submitProfile.schema } }
                  : {}),
                // 升级端口与 submit 端口同进同出：两者都是 actor 会话的控制通道，而端口在场
                // 就是 core 侧的注册门。恒传（端口在 run service 里恒被构造），不做 opt-in——
                // 最可能撞上未预见之墙的 actor 恰是作者没标记的那一个。
                workflowEscalatePort: escalatePort,
                // 请求级准入端口：driver 在治理器在场时给出，runner 每次尝试先过闸门。
                ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
              }),
            // 边界记账与转录截断都读写 actor 会话的消息，走的必须是同一个 store。
            actorTranscriptStore: sessionStore,
            // 用户面产物的字节落点：与主会话、workflow 子
            // 代理共用同一个 tool-artifact store，产物因此和别的大结果落在同一棵目录树下。
            artifactStore,
            executionPort,
            fileSystemPort,
            journal: dynamicWorkflowJournal,
            logger,
            // 进度投影的接缝：一条引擎事件 → 一条父会话的会话事件 → v4 的 workflowRuns 状态键。
            // 走 runtime 的 append 链路（而不是直接推 eventSink）是必需的：只有它同时做持久化、
            // 补 sequenceNumber 与扇出，冷恢复与 replayable 重连因此免费。
            //
            // 身份闸门、runtime 未就绪与 append 失败三条降级路径都在这个汇里（连同它们的单测），
            // 见 dynamic-workflow-run-progress-sink.ts 的文件头。
            onRunEvent: createDynamicWorkflowRunProgressSink({
              // 惰性：run service 在 runtime 构造之前就建好了（它是 AgentRuntime 的依赖之一）。
              getRuntime,
              logger,
              sessionId,
            }),
            // 孤儿收敛的作用域：本 app 的会话。构造时把**这个会话**留在 journal 里的非终态
            // run（死进程的遗物）收敛成 failed；兄弟会话的在飞 run 因此绝不会被误伤。
            parentSessionId: sessionId,
            // 补全落在没有草稿的 run 上时铸草稿（docs/dynamic-workflow/launch.md「The draft after a
            // fill」）：内联规则只在工具层有一份实现，这里注入而不是让 run service 复制它。
            writeWorkflowDraft,
            // 建 run 那一刻会话的权限模式（记进 run-launched，子代理随之）。
            // 惰性同 onRunEvent：启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
            permissionMode: () => getRuntime().getMode(),
            // 在飞的引擎把本会话钉成常驻。2026-09-15 的 bug：引擎不进 runtime task registry，
            // 常驻池把带着在飞 run 的 App 按 idle（10 分钟）关掉，resume 又起了第二个引擎。
            // 惰性取 runtime 同 onRunEvent：run service 是 AgentRuntime 的依赖，构造更早；
            // 而启动只来自工具调用或 v4 命令，那时 runtime 必已就绪。
            registerResidencyBlockingWork: (work) => {
              void getRuntime().trackResidencyBlockingWork(work);
            },
            // 发起锚点：CreateWorkflow 在父会话的活动轮里执行，
            // 那一轮的 inputId 就是子代理 agent_step 要挂的 message。trace.turnId 对不上活动轮
            // （理论上不该发生）就交回 submit 侧兜底铸值，绝不把别的轮的 id 记成锚点。
            resolveLaunchInputId: (trace) => {
              const active = getRuntime().getActiveTurnInfo();
              return active !== undefined && active.turnId === trace.turnId
                ? active.inputId
                : undefined;
            },
            ...(isDynamicWorkflowTaskLinkStore(sessionStore)
              ? { taskLinkStore: sessionStore }
              : {}),
          });
    // dwf snippet service：EvalWorkflowSnippet 的执行面。刻意**不**依赖 dwf journal——
    // snippet 完全瞬态（内存 journal），不该被 run service 的 durability 前提连坐；
    // 所以即使 run 端口因 journal 缺席而不构造，实验通道仍然可用。
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // 模型目录：工具层把用户说的模型名解析成 workflow run 的子代理选型（model-catalog-port.ts）。
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    // AgentRuntime 放在最后构造：其 deps 里几乎是前面所有产物（store/端口/factory/治理器）。
    // workflowPort 与 dwf run/snippet 端口必须先存在，因为 runtime 构造时就消费它们；
    // 反过来 run service 的 runtime 回调一律惰性，避免"runtime 依赖 run service、run service 依赖 runtime"的构造环。
    // [装配] AgentRuntime 最后构造：deps 里几乎是前面所有产物。
    // workflowPort 与 dwf run/snippet 端口必须先存在，runtime 构造时就会消费它们。
    // run service 的 runtime 回调一律惰性，避免“runtime 依赖 run service、run service 依赖 runtime”的构造环。
    // eventStore 未注入时用内存实现：单会话进程内事件不落盘。
    // skillPort 只在 features.skill 与 skills.enabled 同时为真时创建。
    // dynamicWorkflowEnabled === false 时把内置技能路径也加入 disabledPaths。
    // contextSourcePort 等可选端口原样透传，不在本函数内构造。
    // isRemoteWorkspace 从 runtimeConfig 的记忆身份推导，不看 workingDirectory。
    // modelRequestAdmission 接治理器 observer：主代理立即放行但计入在飞。
    // markRuntimeConstructed 与 completeAppStartup 只记账，不改变 runtime 行为。
    runtime = new AgentRuntime(sessionId, runtimeConfig, {
      ...(options.readSubagentRuntimeConfig
        ? {
            loadAgentDefinitions: async (input) => {
              const snapshot = await options.readSubagentRuntimeConfig!(input);
              const parsed = subagentProfilesFromSnapshot(snapshot);
              const pluginProfiles =
                snapshot.kind === "built-in-fallback"
                  ? []
                  : resolvePluginAgentProfiles(
                      {
                        logger,
                        plugins: pluginOutcome.plugins,
                        reservedProfileNames: parsed.profiles.map((profile) => profile.name),
                        modelSelectionOverrides: parsed.pluginAgentModelSelectionOverrides,
                      },
                      pluginTemplates,
                    ).profiles;
              return {
                activeAgents: normalizeAgentProfiles(
                  [
                    ...(options.runtimeConfig?.subagents?.profiles ?? []),
                    ...parsed.profiles,
                    ...pluginProfiles,
                  ],
                  {
                    builtInModelSelectionOverrides: {
                      ...parsed.builtInModelSelectionOverrides,
                      ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
                    },
                  },
                ),
              };
            },
          }
        : {}),
      agentTelemetry: modelTelemetry.agentExecution,
      // 主代理的模型请求过治理器的 observer：立即放行，但让治理器看见它的 429 / 成功。
      modelRequestAdmission: workflowConcurrencyGovernor.observer(),
      eventStore: options.eventStore ?? createInMemorySessionEventStore(),
      sessionStore,
      sessionMailboxPort,
      logger,
      executionPort,
      workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
      workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      contextSourcePort:
        options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
      skillPort:
        configResult.config.features.skill && configResult.config.skills.enabled
          ? (options.skillPort ??
            createNodeSkillAdapter({
              additionalDirectories: options.additionalDirectories,
              extraRoots: configResult.config.skills.roots,
              extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
              disabledPaths: [
                ...collectDisabledPaths(configResult.config.skillOverrides),
                // 动态工作流关闭时不提供 dynamic-workflows 技能：
                // 十个工具都不在场，再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
                ...(runtimeConfig.dynamicWorkflowEnabled === false
                  ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                  : []),
              ],
            }))
          : undefined,
      mcpPort,
      eventSink,
      onOffPeakLifecycleEvent: options.onOffPeakLifecycleEvent
        ? (event) => options.onOffPeakLifecycleEvent!({ ...event, sessionId })
        : undefined,
      modelFactory,
      modelIoDir,
      providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
      resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
      isRemoteWorkspace: () =>
        isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
      permissionBroker: options.permissionBroker,
      permissionService,
      workflowPort: scriptWorkflowFacade.workflowPort,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      topicResourcePort: options.topicResourcePort,
      appVersion,
      traceContext,
    });
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    // 门面顺序：input 先建（只依赖 runtime/artifactStore），workflow 次之（复用同一 modelFactory、
    // permissionService 与 MCP 端口），session 最后（它持有端口关闭语义，需要 owns* 结论）。
    // 三个门面都只是 runtime 的读写适配，不创建第二份 runtime 或第二份模型事实源。
    const inputFacade = createInputFacade({
      cliDefaultSelection,
      artifactStore,
      customCommandPromptResolver: async (text, resolverOptions) => {
        const builtin = resolveZCodeBuiltinPromptCommandInvocation(text, {
          // 动态工作流灰度关闭时内置 `/workflow` 不得展开（DWG-03）。目录侧已经把它从 `/` 面板
          // 剔除，但用户仍可手打命令名，两条路径必须给出同一个结论。独立 CLI 的 TUI 与 headless
          // 按 --workflow-mode 显式取值；缺席（进程内嵌入方）不设门禁，见 runtimeConfig 字段注释。
          dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
          workingDirectory,
        });
        if (builtin !== undefined) {
          if (builtin.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
            // `/workflow` 的展开处就是 onDemand 会话的激活点（launch.md「On demand: activation」）：
            // 它先于 executeTurn，本轮首个模型请求就带着十个工具。alwaysOn / 已激活会话里是 no-op。
            // 问的是 runtime 而不是闭包里的 runtimeConfig——构造时 config 被拷贝，闭包看不到翻转。
            await runtime?.activateDynamicWorkflowTools({
              source: "command",
              traceContext: resolverOptions?.traceContext ?? traceContext,
            });
          }
          return builtin.prompt;
        }
        return await resolveZCodeCustomCommandPrompt(text, {
          additionalDirectories: options.additionalDirectories,
          env: options.env,
          executionPort,
          logger,
          projectConfigPath: options.projectConfigPath,
          sessionId,
          signal: resolverOptions?.abortSignal,
          skipUserConfig: options.skipUserConfig,
          traceContext: resolverOptions?.traceContext ?? traceContext,
          userConfigPath: options.userConfigPath,
          workingDirectory,
        });
      },
      inputHistoryStore,
      logger,
      prepareUserExecutionBoundary,
      runtime,
      sessionId,
      traceContext,
    });
    const workflowFacade = createWorkflowFacade({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      cliStorageRoot,
      configResult,
      eventSink,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      runtime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    const sessionFacade = createSessionFacade({
      cliDefaultSelection,
      // App 关闭时停下本会话拥有的 dwf run：
      // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
      configResult,
      configuredMcpServers,
      ...(options.configuredDefaultModelSelection
        ? {
            configuredDefaultModelSelection: options.configuredDefaultModelSelection,
          }
        : {}),
      executionPort,
      localSettingStore,
      logger,
      loggerFactory,
      mcpPort,
      ownsExecutionPort,
      ownsMcpPort,
      closeNodeReplBrowserBroker: async () => {
        await ownedNodeReplBrowserBroker?.close();
      },
      ownsSessionStore,
      prepareUserExecutionBoundary,
      prepareResume,
      projectID,
      providerRegistry: options.providerRegistry,
      resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
      runtime,
      sessionId,
      sessionStore,
      traceContext,
      untrustedProjectMcpServers,
      workingDirectory,
    });

    const closeSession = sessionFacade.close;
    const resolvePromptAttachment = async (input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
      let ref = input.ref;
      let mediaType = input.mime;
      let artifactUri: string | undefined;
      if (input.messageId && input.attachmentIndex !== undefined) {
        // 预览单个附件曾通过 messages() 解码整段会话；长会话会同步扫描
        // 所有 parts，且无关坏行也会让目标预览失败。按 session/message 定点读取即可。
        const persistedMessage = await sessionStore.messageWithParts({
          sessionID: sessionId,
          messageID: input.messageId as MessageId,
        });
        const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
          input.attachmentIndex
        ];
        if (persistedAttachment?.type === "file") {
          mediaType = persistedAttachment.mime;
          // live row 的 ref 仍是原始路径；如果直接读取，源文件删除或覆盖后
          // 热态预览会和冷恢复 artifact 不一致。同一 message/index 必须优先取不可变副本。
          artifactUri =
            persistedAttachment.metadata?.artifactUri ??
            (persistedAttachment.url.startsWith("zcode-artifact://")
              ? persistedAttachment.url
              : undefined);
          ref =
            artifactUri ??
            (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
        }
        // message row 会先于后续 FilePart 逐条落库；目标 part 尚未可见时仍应
        // 使用已经由当前 projection 授权的 input.ref，不能制造短暂的预览失败窗口。
      }
      return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
    };
    return {
      sessionId,
      traceId: traceContext.traceId,
      runtime,
      respondWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.respond(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.decision,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      toggleWorkspaceHookReviewItem: (input) =>
        workspaceHookRuntimeSecurity?.toggle(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.reviewItemId,
          input.enabled,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      revokeWorkspaceHookTrust: (input) =>
        ("hookDeclarationDigests" in input
          ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
          : workspaceHookRuntimeSecurity?.revoke(
              {
                sessionId: input.sessionId,
                taskId: input.taskId,
                runId: input.runId,
                ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
                workspaceIdentity: input.workspaceIdentity,
                bundleDigest: input.bundleDigest,
                reviewFlowId: input.reviewFlowId,
                generation: input.generation,
                interactionId: input.interactionId,
              },
              input.reviewItemIds,
            )) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      requestWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.requestReview({
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
        }) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      // Settings pretrust 写盘后由 server 按 workspace 调用：重载 Trust store 到本
      // session 的 coordinator 并重发 admission 状态（详见 types.ts 注释）。
      reloadWorkspaceHookTrust: () =>
        workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
      setModelIoFullRetentionEnabled: (enabled) =>
        modelAdapter.setModelIoFullRetentionEnabled(enabled),
      readToolResultArtifact: (uri) =>
        artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
      // wire/staging 全程是 decoded chunk；只有完整 checksum commit 后才在
      // CLI 进程内恢复既有 data-URL artifact 形态，保持 provider 读取链兼容。
      writePromptAttachment: async (input) => {
        const artifact = await artifactStore.writeToolResultArtifact({
          content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
          contentType: "text/plain",
          retention: "session",
          sessionId,
          toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          toolName: "prompt-attachment:upload",
          trace: traceContext,
        });
        if (
          input.mime.startsWith("image/") ||
          input.mime.startsWith("video/") ||
          input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
        ) {
          // 派生媒体只是可重建缓存；真实 IO 失败不破坏 durable data URL，最终请求投影会再次 ensure。
          void artifactStore
            .primeMediaAttachmentPath?.({
              bytes: input.bytes,
              mediaType: input.mime,
              uri: artifact.uri,
            })
            .catch(() => undefined);
        }
        return { ref: artifact.uri };
      },
      readPromptAttachment: async (input) => {
        const { ref, mediaType } = await resolvePromptAttachment(input);
        // 读取必须留在 session runtime 内：artifact 走 session store，路径走当前
        // FileSystemPort，SSH/WSL/Docker 才会命中正确的远端文件系统。
        if (ref.startsWith("zcode-artifact://")) {
          const artifact = await artifactStore.readToolResultArtifact({
            uri: ref,
            trace: traceContext,
          });
          return decodePromptAttachmentDataUrl(artifact.content, mediaType, input.maxBytes);
        }
        const read = await fileSystemPort.readBinaryFile({
          path: ref,
          maxBytes: input.maxBytes,
          trace: traceContext,
        });
        return { bytes: read.content, mediaType };
      },
      statPromptAttachment: async (input) => {
        const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
        if (artifactUri) {
          if (!artifactStore.statToolResultArtifact) {
            throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
          }
          const result = await artifactStore.statToolResultArtifact({
            uri: artifactUri,
            trace: traceContext,
          });
          return {
            totalBytes: result.bytes,
            mediaType: result.contentType || mediaType,
            ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
          };
        }
        const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
        if (result.kind !== "file") {
          // 目录/符号链接/已消失都意味着「这个附件不再是可分享的文件」，用稳定码上抛，
          // 让 share 预检按确定分类处理，而不是靠错误文本猜。
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statNotFile);
        }
        return {
          totalBytes: result.sizeBytes,
          mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      },
      resolvePromptAttachmentPreviewSource: async (input) => {
        const resolved = await resolvePromptAttachment(input);
        if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
        if (resolved.artifactUri) {
          if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
          try {
            const materialized = await artifactStore.ensureMediaAttachmentPath({
              uri: resolved.artifactUri,
              mediaType: resolved.mediaType,
            });
            if (materialized.status === "ready" && materialized.path.trim()) {
              return {
                kind: "local_path",
                path: materialized.path,
                mediaType: resolved.mediaType,
              };
            }
          } catch {
            // artifact 仍是不可变事实；派生文件失败只允许 gateway 回到 artifact chunk。
          }
          return { kind: "chunked" };
        }
        if (isAbsolute(resolved.ref)) {
          return {
            kind: "local_path",
            path: resolved.ref,
            mediaType: resolved.mediaType,
          };
        }
        return { kind: "chunked" };
      },
      ...sessionFacade,
      // close 是显式覆盖 sessionFacade 的实现：先让 session 门面按 owns* 释放它拥有的
      // store/端口/dwf run，再 flush 记录队列、dispose provider 模型运行时、最后 shutdown 遥测。
      // 顺序不可颠倒：先停写者（会话事件/录制）再停模型运行时；否则关闭后仍可能往已关的 store 追加。
      close: async () => {
        try {
          await closeSession?.();
        } finally {
          // 记录队列必须在进程退出前 flush；flush 失败只影响诊断文件，不改变关闭结果。
          try {
            await conversationRecorder?.close();
          } finally {
            // 模型运行时与遥测在最后释放：前面任何一步失败都不能跳过它们（try/finally 链的意义）。
            try {
              providerModelRuntime?.dispose();
            } finally {
              await modelTelemetry.shutdown();
            }
          }
        }
      },
      // 成员按对象展开的 last-wins 合并：显式 close 覆盖 sessionFacade 的同名成员；
      // 这里继续展开 workflow/script 门面，inputFacade 在末尾展开。
      ...workflowFacade,
      ...scriptWorkflowFacade,
      // dwf 事件日志的读面。**可选能力**：journal 不可用时 run service 整个不构造，
      // 这个方法随之缺席，v4 网关据此回结构化的能力不支持错误——「没有事件」与
      // 「这个会话没有这个能力」必须能被 renderer 区分。
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            listDynamicWorkflowRunEvents: async (input: {
              runId: string;
              afterSequence?: number;
              limit?: number;
              maxBytes?: number;
            }) =>
              dynamicWorkflowRunPort.listEvents(input.runId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
              }),
          }),
      // workflow run 的**用户面产物**读面。三条一起注册、
      // 一起缺席：它们是同一个 journal 读面的三个切片，部分在场只会让 UI 拿到一张有卡片
      // 却打不开的侧板。三个端口成员都是可选的（stub 端口不陪跑），所以逐个探测。
      // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是端口上的 `output`（顶层返回值）。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listArtifacts !== "function" ||
      typeof dynamicWorkflowRunPort.listArtifactItems !== "function" ||
      typeof dynamicWorkflowRunPort.readArtifact !== "function"
        ? {}
        : {
            listDynamicWorkflowRunArtifacts: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listArtifacts!(input.runId),
            listDynamicWorkflowRunArtifactItems: async (input: {
              runId: string;
              artifactId: string;
              afterSequence?: number;
              limit: number;
              maxBytes: number;
              fields?: readonly string[];
            }) =>
              dynamicWorkflowRunPort.listArtifactItems!(input.runId, input.artifactId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                limit: input.limit,
                maxBytes: input.maxBytes,
                ...(input.fields === undefined ? {} : { fields: input.fields }),
              }),
            readDynamicWorkflowRunArtifact: async (input: {
              runId: string;
              artifactId: string;
              version: number;
            }) =>
              dynamicWorkflowRunPort.readArtifact!(input.runId, input.artifactId, input.version),
          }),
      // workflow run 的工作区 transcript：两条一起
      // 注册、一起缺席，理由同产物的三条。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listWorkspaceNodes !== "function" ||
      typeof dynamicWorkflowRunPort.readWorkspaceNodeResult !== "function"
        ? {}
        : {
            listDynamicWorkflowRunWorkspaceNodes: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listWorkspaceNodes!(input.runId),
            readDynamicWorkflowRunNodeResult: async (input: {
              runId: string;
              siteId: string;
              ordinal: number;
              maxBytes: number;
            }) =>
              dynamicWorkflowRunPort.readWorkspaceNodeResult!(
                input.runId,
                input.siteId,
                input.ordinal,
                { maxBytes: input.maxBytes },
              ),
          }),
      // dwf run 的会话级生命周期读面（在飞计数 + 结算订阅）。消费者是宿主的 provider registry
      // 安全边界：子代理共用本会话的 live adapter，在飞 run 期间 replace registry 会 dispose
      // 它们绑定的请求资源。缺席条件同上。
      ...(dynamicWorkflowRunPort === undefined ? {} : {}),
      // dwf run 的枚举面（重启后的发现查询）。能力缺席条件同上；端口的 listRunsForSession
      // 是可选成员，方法缺席时本能力同样不注册。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listRunsForSession !== "function"
        ? {}
        : {
            listDynamicWorkflowRuns: async (input: { limit?: number }) =>
              dynamicWorkflowRunPort.listRunsForSession!(input.limit),
          }),
      // workflow run 的冷回放。能力缺席条件同上。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.replayProgressForSession !== "function"
        ? {}
        : {
            replayDynamicWorkflowRuns: async (input: { excludeRunIds: ReadonlySet<string> }) =>
              dynamicWorkflowRunPort.replayProgressForSession!(input),
          }),
      // dwf run 的恢复。能力缺席条件同上；此外
      // 端口的 resume 是可选成员（stub 端口不陪跑），方法缺席时本能力同样不注册——
      // 对 renderer「端口缺席」与「方法缺席」是同一个业务事实。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.resume !== "function"
        ? {}
        : {
            resumeWorkflowRun: async (input: { workId: string; name?: string }) => {
              const result = await dynamicWorkflowRunPort.resume!(input.workId);
              if (result.ok) {
                // 追踪重臂必须紧随成功的 resume：registry 登记（回收护栏）、backgroundWorks
                // 条目（cancellable）、终态通知。port.resume 已先替换注册表条目，
                // waiter 因此挂在新的结算 promise 上（run service 文件头不变式 5）。
                await getRuntime().trackResumedDynamicWorkflowRun({
                  runId: result.runId,
                  ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
                  ...(input.name === undefined ? {} : { name: input.name }),
                  traceContext,
                });
              }
              return result;
            },
          }),
      // 中枢直接启动一个已保存的工作流。能力缺席条件与
      // resumeWorkflowRun 家族一致：dwf 端口整体缺席（stub / 单测宿主）时不注册——GUI 据此拿到
      // 能力不支持错误并原样显示，而不是把「不支持直接启动」误当成一次失败的启动。
      // 与 /goal 控制轮同构：先走统一用户执行边界（否则首次持久化前 shell selection 为空，
      // 冷恢复退回 legacy fallback），再由 runtime 解析 + 校验 + 编译 + 落启动轮 + submit。
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            startSavedWorkflow: async (input: {
              name: string;
              scope?: "project" | "global";
              args?: Record<string, unknown>;
            }) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().startSavedWorkflowRun({ ...input, traceContext });
            },
          }),
      // GUI「配置」。它
      // 沿用前驱的脚本，所以端口必须既能 amend 又能读回脚本；缺一就不注册，GUI 拿到能力不支持。
      // 与 startSavedWorkflow 同一条用户执行边界：冷恢复的会话先恢复 Session 边界再落设置轮。
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.amend !== "function" ||
      typeof dynamicWorkflowRunPort.getScript !== "function"
        ? {}
        : {
            amendWorkflowRunSettings: async (
              input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
            ) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().amendWorkflowRunSettings({ ...input, traceContext });
            },
          }),
      ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
      getPluginReferenceCatalog: () => pluginReferenceCatalog,
      getSkillCatalog: async () => {
        // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
        // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
        await prepareUserExecutionBoundary({ traceContext });
        return await getRuntime().getSkillCatalog(traceContext);
      },
      resume: resumeFromStore,
      ...inputFacade,
    };
  // [失败路径] 只回收本函数创建的对象：注入资源由调用方负责。
  // ownedNodeReplBrowserBroker.close() 是异步且不等待，避免卡住失败路径。
  // 遥测 shutdown 用 catch 吞掉二次错误，保证原始装配错误优先抛出。
  // startupTimer.fail 只记账，不改变错误形态。
  // 最后原样 throw error：上层按错误类型分类，包装会丢信息。
  // providerModelRuntime.dispose 是同步的，先于异步清理执行。
  // 不要在 catch 里再抛新错误：会覆盖真正根因。
  // catch 不关闭 sessionStore：它的所有权已交给 sessionFacade 的失败语义。
  } catch (error) {
    // 失败回收只针对本函数创建的对象（注入资源由调用方负责）。ownedNodeReplBrowserBroker.close()
    // 是异步且不等待；遥测 shutdown 用 catch 吞掉二次错误，保证原始装配错误优先抛出。
    // startupTimer.fail 只记账，不改变错误形态：原样 throw，便于上层按类型分类。
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
