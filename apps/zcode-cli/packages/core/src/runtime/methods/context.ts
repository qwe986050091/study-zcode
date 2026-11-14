// INV-01 幂等门只认 contextInitialized 单一标志，置位必须留在函数末尾；守住位置：历史重建成功之后才置位；改错故障：提前置位会让中途抛错的 init 被永久跳过重试。
// INV-02 历史前缀是运行时事实的唯一来源；守住位置：先取 borrowReadOnlyRuntimeEntries 快照，再 init，再回灌；改错故障：丢掉快照会吞掉模型创建失败轮已持久化的用户输入。
// INV-03 snapshot、workingDirectory、workspaceRoot 三者同源；守住位置：统一由 snapshot.workingDirectory 回写；改错故障：各写各的会让工具 cwd 与系统提示词描述的工作区不一致。
// INV-04 contextSourcePort 缺席只降级不失败；守住位置：分支回落到 config-only 快照；改错故障：把缺端口当异常会让 preview 与测试场景整轮初始化失败。
// INV-05 unknown 占位 envInfo 不得写回 config；守住位置：仅当 persistEnvInfo 显式关闭才跳过回写；改错故障：占位值被当成显式 envInfo 会让后续跳过 Node env 与 git 探测。
// INV-06 执行模型只属于 model step；守住位置：作为 builder 选项透传而不落 config；改错故障：写回会把随轮次变化的模型固化进可复用 Context Source。
// INV-07 subagent 必须走裁剪版 builder；守住位置：分支置于主 contextConfig 组装之前；改错故障：父会话的 projectContext、工具面与内存索引会泄漏给子代理。
// INV-08 memory index 只在 default-index 分支读取；守住位置：分支判断置于任何 IO 之前；改错故障：其它检索分支会重复读 MEMORY.md 并越过各自实现边界。
// INV-09 memory 缺失不是错误；守住位置：disabled 与 missing port 都记 skip 后返回 undefined；改错故障：抛错会把可选能力降级升级成整轮初始化失败。
// INV-10 MEMORY.md 读取必须登记 readFileState；守住位置：在返回之前写入缓存条目；改错故障：漏登记会让 read 工具重复读盘并看到不一致的 revision 视图。
// INV-11 isPartialView 由格式化结果是否等于原文推导；守住位置：该字段与 content 成对写入；改错故障：写死会让下游把裁剪视图误判为完整原文。
// INV-12 skill 发现失败降级为一条诊断；守住位置：catch 内返回 skill_scan_failed 而不重抛；改错故障：扫描异常会阻塞整轮对话。
// INV-13 skillPort 缺席返回 undefined 而非空 catalog；守住位置：早退分支置于 try 之外；改错故障：伪造空结果会掩盖端口未接入与确实没有 skill 的差别。
// INV-14 catalog 必须过 init 门再读；守住位置：ensureContextInitialized 先于快照读取；改错故障：绕过门会让 UI 看到 runtime 尚未加载的新 Skill。
// INV-15 catalog 对外只给防御性副本；守住位置：skills 与 diagnostics 逐项展开拷贝；改错故障：共享引用会让 Composer 的改动污染本 Session 的快照。
// INV-16 build 是 init 唯一替换内存历史的入口；守住位置：最新 build 结果与 init 成对执行；改错故障：漏存结果会让 compact 与 token 统计读到陈旧值。
// INV-17 流式只认 modelStreaming 等于 on；守住位置：严格等值且不设默认回退；改错故障：把缺失当流式会改变请求形态并破坏 provider 兼容。
// INV-18 tool_call 归一必须去重；守住位置：扁平数组按 id 先查后追加；改错故障：重复项会让 compact 拒绝判定重复计数并误触发压缩。
//
// 模块职责：Context 初始化门、来源解析、memory 与 skill 快照、内存历史前缀的唯一装配点。
// 状态所有权：contextInitialized、contextSourceSnapshot、messageHistory 归 AgentRuntimeInternal，本文件只写不缓存副本。
// 阅读顺序：ensureContextInitialized → createContextBuilderFromSnapshot → loadProjectMemoryRoot 与 index content → initializeMessageHistoryFromContext。
/**
 * ============================================================================
 * runtime/methods/context.ts —— Context 初始化、来源解析与历史前缀装配
 * ============================================================================
 * 【定位】链路 4 的上游：在首个 model step 前建立系统提示词 + 工具面 + memory/skill 的稳定前缀。
 * 【输入/输出】输入 ContextSourcePort/config/端口；输出 contextBuilder、内存历史前缀与可复用的 contextSourceSnapshot。
 * 【关键不变量】初始化只做一次且异常可重试；历史前缀是运行时事实的唯一来源，不能被并发初始化重复覆盖。
 *             可选端口（contextSourcePort/fileSystemPort/skillPort）缺席时降级而不失败。
 * ============================================================================
 */
import { join } from "node:path";

import {
  traceContextToLogContext,
  createContextBuilder,
  createSubagentContextBuilder,
} from "../deps.js";
import type {
  Model,
  ModelToolCall,
  SkillLoadOutcome,
  TraceContext,
  ContextSourceSnapshot,
  ContextBuilder,
  ContextBuilderConfig,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ensureMemoryDirectoryExists } from "../../memory/directory.js";
import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";
import {
  ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  type ProjectMemoryRetrievalBranch,
} from "../../memory/project-memory-retrieval-branch.js";
import {
  createReadFileStateKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "./embedded-search-branch.js";
import { getContextSourceShellDisplayName } from "./session-shell-environment.js";
import {
  ensureGenUiOutputDirectory,
  resolveGenUiOutputDirectory,
} from "../helpers/gen-ui-output.js";

export { buildContextHistoryEntries };

export async function ensureContextInitialized(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  // 幂等门：并发/重复调用复用已建好的前缀，避免重复扫描 skill/memory 并覆盖已有历史。
  // 门只看单一布尔，不看 snapshot 或 builder 是否存在：两者可能已建好但历史尚未重建
  // 并发首调者都会通过这一行，真正的互斥来自上层串行化 model step，而非本函数
  // 重复调用直接返回，既省一次 skill 与 memory 扫描，也避免覆盖已灌入的运行时条目
  // 若改成按 builder 判空，等于把“建好”误当“完成”，历史前缀会缺一次 init
  // 该判断必须留在函数最前，任何 await 前置都会放大并发窗口
  if (this.contextInitialized) return;

  const shellDisplayName = getContextSourceShellDisplayName(this);
  // contextSourcePort 是可选端口：preview/测试场景下退回 config-only 快照，不因缺端口失败。
  const snapshot = this.contextSourcePort
    ? await this.contextSourcePort.resolveContextSources(
        {
          workingDirectory: this.workingDirectory,
          currentDate: this.config.currentDate,
          effectiveShellDisplayName: shellDisplayName,
          envInfo: this.config.envInfo,
          userInstructions: this.config.userInstructions
            ? {
                ...this.config.userInstructions,
                workingDirectory:
                  this.config.userInstructions.workingDirectory ?? this.workingDirectory,
              }
            : undefined,
          projectContext: this.config.projectContext,
          trace: traceContext,
        },
        { signal: undefined },
      )
    : this.createConfigOnlyContextSnapshot(this.workingDirectory);

  // 以 context source 解析出的目录为准回写运行时，后续工具 cwd 与提示词才能一致。
  this.workingDirectory = snapshot.workingDirectory;
  // Bash cd 之后 workingDirectory 会变化，但 workspaceRoot 仍表示会话初始工作区边界。
  this.workspaceRoot = snapshot.workingDirectory;
  this.contextSourceSnapshot = snapshot;
  // MCP 是两段式启动：这里只发起，不阻塞 context 初始化，工具面在回合边界再刷新（链路 10）。
  this.startMcpStartup(traceContext);
  // skill/memory 在本 runtime 初始化时只发现一次，作为本 Session 的稳定能力快照。
  this.skillLoadOutcome = await this.discoverSkillsForContext(traceContext);
  this.memoryRoot = await this.loadProjectMemoryRoot(traceContext);
  this.memoryIndexContent = await loadProjectMemoryIndexContent(
    this,
    this.memoryRoot,
    ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  );
  await ensureGenUiOutputDirectory(this);
  this.contextBuilder = this.createContextBuilderFromSnapshot(snapshot, this.memoryRoot, {
    memoryIndexContent: this.memoryIndexContent,
    model,
  });
  // Bug 根因：模型创建失败轮会在 Context 首次可初始化前接纳并持久化用户输入。
  // init 会替换全部内存历史，因此先保留这些权威运行条目，再接到新建的 Context 前缀之后。
  const preContextEntries = [...this.messageHistory.borrowReadOnlyRuntimeEntries()];
  this.initializeMessageHistoryFromContext(this.contextBuilder, traceContext);
  this.messageHistory.addEntries(preContextEntries);
  // 标记放在最后：只有历史重建成功才算初始化完成；中途抛错时下次调用仍会完整重试。
  this.contextInitialized = true;
}

export async function getSkillCatalog(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome> {
  // Composer 曾独立扫描磁盘，所以运行中的 Session 会看到 AgentRuntime
  // 尚未加载的新 Skill。先经过 runtime 唯一的 context 初始化门，再返回防御性副本，
  // 让 UI 与本 Session 实际可用的 Skill 保持同一快照；新 runtime 会自然重新发现。
  // 先过 init 门再读 skillLoadOutcome，保证 UI 与本 Session 看到同一份 skill 快照
  // 端口未接入时回头读的是空 outcome 兜底，它是降级结果而非伪造的成功扫描
  // 逐项展开拷贝 skills 与 diagnostics，阻断 Composer 通过引用改写 runtime 内部状态
  // totalDiscovered 是数字，直接透传，不参与展开拷贝
  await this.ensureContextInitialized(traceContext);
  const outcome = this.skillLoadOutcome ?? {
    skills: [],
    diagnostics: [],
    totalDiscovered: 0,
  };
  // 返回防御性拷贝：Composer/UI 不能通过引用改动 runtime 内的 skill 快照。
  return {
    skills: outcome.skills.map((skill) => ({ ...skill })),
    diagnostics: outcome.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    totalDiscovered: outcome.totalDiscovered,
  };
}

export function createContextBuilderFromSnapshot(
  this: AgentRuntimeInternal,
  snapshot: ContextSourceSnapshot,
  memoryRoot?: string,
  options: { memoryIndexContent?: string; model?: Model; persistEnvInfo?: boolean } = {},
): ContextBuilder {
  const envInfo = snapshot.envInfo;
  // 同步 preview / config-only fallback 会构造 unknown envInfo。
  // 这类临时值不能写回 config，否则首轮真实 context source 会把它当作显式 envInfo，
  // 从而跳过 Node env/git 探测。
  // 回写 config 的只能是真实探测到的 envInfo，unknown 占位必须被这层拦住
  // persistEnvInfo 只为预览与探测类调用预留，默认路径都应回写
  // 执行模型不在此处落盘：model 只在 builder 选项里随调用流转
  // 这里一旦放宽，首轮真实探测会被占位值短路，平台与 git 信息此后永久缺失
  if (options.persistEnvInfo !== false) {
    // 执行模型属于 model step，不写回可复用的 Context Source。
    this.config.envInfo = envInfo;
  }
  // subagent 使用裁剪版 builder：只带 agentPrompt/userInstructions，不注入主 agent 的
  // projectContext、工具面与内存索引，避免把父会话上下文泄漏给子代理。
  // 裁剪版 builder 必须在主 contextConfig 组装前分叉，否则泄漏无法在原处补救
  // 只透传 agentPrompt、currentDate、envInfo、model、skills 与子代理自己的 userInstructions
  // projectContext、工具注册表、内存索引一律不带，避免父会话上下文渗入子代理
  // skillMetadataBudget 仍遵 runtime 配置，子代理不另做一次 skill 发现
  // 分支内不挂注册表：子代理工具面在别处按白名单装配，混用会越权
  if (this.config.subagentContext) {
    return createSubagentContextBuilder({
      agentPrompt: this.config.subagentContext.agentPrompt,
      currentDate: snapshot.currentDate,
      envInfo,
      model: options.model,
      skillMetadataBudget: this.config.skillMetadataBudget,
      skills: this.skillLoadOutcome,
      userInstructions: this.config.subagentContext.userInstructions,
    });
  }

  const contextConfig: ContextBuilderConfig = {
    workingDirectory: snapshot.workingDirectory,
    additionalDirectories: this.config.additionalDirectories,
    envInfo,
    model: options.model,
    presentationSurface: this.config.presentationSurface,
    genUiOutputDirectory: resolveGenUiOutputDirectory(this),
    currentDate: snapshot.currentDate,
    userInstructions: snapshot.userInstructions,
    projectContext: snapshot.projectContext,
    memoryIndexContent: options.memoryIndexContent,
    memoryRoot,
    skills: this.skillLoadOutcome,
    agentProfiles: this.config.subagents?.profiles,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(this),
    skillMetadataBudget: this.config.skillMetadataBudget,
    customSystemPrompt: this.config.systemPrompt,
    workflowActor: this.config.workflowActor,
    language: this.config.language,
    outputStyle: this.config.outputStyle,
    compact: this.config.compact,
    guidanceToolNames: this.getTools(options.model).map((tool) => tool.name),
  };

  return createContextBuilder(contextConfig).setToolRegistry(this.registry);
}

// memoryRoot 绑定 workspaceRoot 而非实时 workingDirectory，cd 之后工作区边界不漂移
// 功能关闭或目录被排除先记 skip 再返回，不把“没有 memory”升级成错误
// 缺 fileSystemPort 属宿主降级：不建目录、不失败，只记 missing_file_system_port
// 目录创建成功后才返回根路径，保证下游读 MEMORY.md 时目录已存在
export async function loadProjectMemoryRoot(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<string | undefined> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot);
  // memory 功能关闭或目录被排除：记 skip 原因后返回，不把"没有 memory"当成错误。
  if (!memoryRoot) {
    this.logMemorySkipped(traceContext, "disabled_or_excluded", {
      taskType: this.config.taskType,
    });
    return undefined;
  }
  // 文件系统端口缺失属于宿主能力降级：不创建目录，也不让 context 初始化失败。
  if (!this.fileSystemPort) {
    this.logMemorySkipped(traceContext, "missing_file_system_port", {
      memoryRoot,
    });
    return undefined;
  }
  await ensureMemoryDirectoryExists(this.fileSystemPort, memoryRoot, traceContext, this.logger);
  return memoryRoot;
}

export async function loadProjectMemoryIndexContent(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): Promise<string | undefined> {
  // 只有 default-index 分支读取 MEMORY.md；其它检索分支由各自实现负责，不能在此越界。
  if (retrievalBranch !== "default-index") return undefined;
  const fileSystemPort = runtime.fileSystemPort;
  // 端口或根目录缺失 → 本次 context 没有 memory index，交由上层按"无来源"处理。
  if (!fileSystemPort || !memoryRoot) return undefined;
  // 读取失败一律吞成 undefined：缺失 index 与不可读 index 对上层语义相同
  // 格式化后为空视同未配置，避免空串进入系统提示词白占 token 预算
  // 写 readFileState 用同一 key 与 revision，read 工具命中即免重复读盘
  // isPartialView 由格式化结果是否等于原文推导，不能凭经验写死
  const indexPath = join(memoryRoot, "MEMORY.md");
  try {
    const read = await fileSystemPort.readTextFile({ path: indexPath });
    const formattedContent = formatProjectMemoryIndexContent(read.content);
    // 格式化后为空说明 index 没有有效内容，视同未配置，避免把空串注入系统提示词。
    if (!formattedContent) return undefined;
    // 记录到 readFileState：后续 read 工具命中同一内容/版本，不必重复读盘。
    runtime.readFileState.set(createReadFileStateKey(indexPath, undefined, undefined), {
      content: read.content,
      isPartialView: formattedContent !== read.content,
      limit: undefined,
      mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs),
      offset: undefined,
      path: indexPath,
      readAt: runtime.now(),
      revisionId: read.revision?.id,
      sizeBytes: read.sizeBytes,
    });
    return read.content;
  } catch {
    // 默认 Memory 分支将缺失或不可读的 index 视为没有该 context source。
    return undefined;
  }
}

export function logMemorySkipped(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: string,
  context: Record<string, unknown> = {},
): void {
  this.logger?.debug("Memory read skipped", {
    ...traceContextToLogContext(traceContext),
    event: "memory.read.skipped",
    module: "core.runtime",
    reason,
    status: "completed",
    ...context,
  });
}

export async function discoverSkillsForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome | undefined> {
  // skillPort 可选：未接入时返回 undefined，builder 会回退到空 catalog，而不是伪造空结果。
  if (!this.skillPort) {
    return undefined;
  }

  try {
    // 端口缺失已在上方早退，此处可假定 skillPort 存在，无需二次判空
    // 扫描异常转成 skill_scan_failed 单条诊断，context 初始化继续推进
    // 诊断只保留 message 文本，不携带宿主路径与 stack，避免写进上下文
    // 返回的是端口原对象，防御性拷贝职责留在 getSkillCatalog 一侧
    // 成功路径打 debug 摘要，失败路径打 warn 并附错误信息
    const outcome = await this.skillPort.discoverSkills({
      workingDirectory: this.workingDirectory,
      trace: traceContext,
    });
    this.logger?.debug("Skills discovered", {
      ...traceContextToLogContext(traceContext),
      diagnosticCount: outcome.diagnostics.length,
      module: "core.runtime",
      skillCount: outcome.skills.length,
      totalDiscovered: outcome.totalDiscovered,
    });
    return outcome;
  } catch (error) {
    // 扫描失败降级为一条诊断而不是中断初始化：skill 缺失不应阻塞整轮对话（fail soft）。
    this.logger?.warn("Skill discovery failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      module: "core.runtime",
    });
    return {
      skills: [],
      diagnostics: [
        {
          code: "skill_scan_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      totalDiscovered: 0,
    };
  }
}

export function createConfigOnlyContextSnapshot(
  this: AgentRuntimeInternal,
  workingDirectory: string,
): ContextSourceSnapshot {
  // config-only 快照不探测环境：unknown 仅是占位，不能据此推断平台/版本能力。
  return {
    workingDirectory,
    envInfo: this.config.envInfo ?? {
      cwd: workingDirectory,
      platform: "unknown",
      shell: "unknown",
      osVersion: "unknown",
      nodeVersion: "unknown",
    },
    currentDate: this.config.currentDate,
    projectContext: this.config.projectContext,
    diagnostics: [],
  };
}

export function initializeMessageHistoryFromContext(
  this: AgentRuntimeInternal,
  contextBuilder: ContextBuilder,
  traceContext: TraceContext,
): void {
  // 用 ContextBuilder 重建"系统前缀 + 历史"的初始内存态；这是 init 唯一替换历史的入口。
  const contextResult = contextBuilder.build();
  this.latestContextBuildResult = contextResult;
  this.messageHistory.init(buildContextHistoryEntries(contextResult));

  this.logger?.debug("Context built", {
    ...traceContextToLogContext(traceContext),
    event: "context.built",
    module: "core.runtime",
    sectionCount: contextResult.sections.length,
    status: "completed",
    tokenMethod: "estimated",
    tokenizer: "zcode.estimateTokens.v1",
    totalChars: contextResult.totalChars,
    totalTokens: contextResult.totalTokens,
    sections: contextResult.sections.map((s) => ({
      name: s.name,
      source: s.source,
      chars: s.chars,
      tokens: s.tokens,
      tokenMethod: "estimated",
      confidence: "medium",
      tokenizer: "zcode.estimateTokens.v1",
      preview: s.preview,
      content: s.content,
    })),
  });
}

// 先归一 responses 与 finishReasons，再归一扁平 toolCalls，两种形态可共存
// 扁平数组按 id 去重，嵌套形态先产出的同 id 项优先保留
// name 回落 toolName，兼容只给 toolName 的 provider 返回
// providerExecuted 原样透传，调用方据此区分本地执行与 provider 执行
// 无 id 的项也会入列，去重只对已存在的 id 生效
// 返回顺序为嵌套在前、扁平补充在后，compact 判定依赖这个稳定顺序
export function extractToolCallsFromResult(
  this: AgentRuntimeInternal,
  result: any,
): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];

  // 兼容两种 provider 返回形态（嵌套 responses/finishReasons 与扁平 toolCalls），统一归一成 ModelToolCall。
  // Try different result formats
  const responses = result.responses ?? result.finishReasons ?? [];

  for (const response of responses) {
    if (response.toolCalls && Array.isArray(response.toolCalls)) {
      for (const tc of response.toolCalls) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
        });
      }
    }
  }

  // 扁平数组按 id 去重，避免同一 tool_call 在 compact 拒绝判定里被重复计数。
  // Also check for flat tool_calls array
  if (result.toolCalls && Array.isArray(result.toolCalls)) {
    for (const tc of result.toolCalls) {
      if (!toolCalls.find((c) => c.id === tc.id)) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
        });
      }
    }
  }

  return toolCalls;
}

export function shouldStreamModelText(this: AgentRuntimeInternal): boolean {
  // 流式是显式开关：只有 "on" 才走流式，缺失或其它值一律按非流式，避免默认值改变请求行为。
  return this.config.modelStreaming === "on";
}
