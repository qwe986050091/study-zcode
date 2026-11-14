// ============================================================
// Context Source Port - host/workspace context boundary
// ============================================================
//
// 【快照语义】`resolveContextSources` 产出的是**一次快照**：运行时在首个 model step 前调用
// 一次，把结果存进 `contextSourceSnapshot` 并复用，之后环境的任何变化（bash cd、切分支、
// 装依赖）都**不回填**这份快照。因此 `EnvInfo` 里的 cwd / git 状态描述的是「建立上下文的那
// 一刻」，不是当前时刻；需要最新事实的调用方必须重新解析，而不是读旧快照。
//
// 【生产者 / 消费者】生产者是 adapters 的 `NodeContextSourceAdapter`（真文件系统 + git 探测，
// 读失败只记诊断不抛）；消费者是 core 的 `ensureContextInitialized`（把解析出的目录回写为
// runtime 的 cwd / workspaceRoot，并交给 `createContextBuilderFromSnapshot` 渲染系统提示词）。
// `request` 上的同名字段是**显式覆盖**：给了 `envInfo` 就不再探测，这是预览/测试与
// config-only 降级路径的入口。
//
// 【降级】整个端口是可选的：缺席时 runtime 退回 config-only 快照，不因缺少环境信息失败。

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

/**
 * 【契约坐标】这是**上下文快照事实**，不是运行中环境的实时视图：生产者在 context 初始化时
 * 解析一次（`detectEnvInfo` + `resolveGitSnapshot`），此后不随 bash cd / 切分支 / 装依赖
 * 回填；消费者是系统提示词渲染（`createContextBuilderFromSnapshot`）。`cwd` 与 git 各项描述
 * 「建立上下文那一刻」；`gitStatus` 是三值判别（`not_repo` 与 `clean` 不是一回事），
 * `gitStatusLines` / `recentCommits` 是给提示词的行级摘要。`envInfo` 若由 config 显式传入，
 * 适配器**不再探测**——误把同步 preview 的 unknown 值写回 config 会让首轮真实探测被跳过。
 */
export interface EnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  nodeVersion: string;
  // 执行模型不是环境事实；只能由当前 model step 的 Model 在 Prompt 渲染时提供。
  isGitRepository?: boolean;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatus?: "clean" | "dirty" | "not_repo";
  gitStatusLines?: string[];
  recentCommits?: string[];
}

/**
 * 【契约坐标】用户指令文件的发现范围。`priorityFiles` 缺省为 `["AGENTS.md"]`；`maxBytes`
 * 缺省 100 KiB（102400），是**每个文件**的读取上界而不是合并后的上界。`projectRoot` 缺席时
 * 适配器自行向上寻找；`workingDirectory` 决定 workspace 文件的搜索起点。生产者：core 的
 * context 初始化（可透传用户配置）；消费者：`NodeContextSourceAdapter.resolveUserInstructions`。
 */
export interface UserInstructionsOptions {
  workingDirectory: string;
  projectRoot?: string;
  priorityFiles?: string[];
  maxBytes?: number;
}

/**
 * 【契约坐标】两值区分**文件归属**而不是内容优先级：`user` 来自用户主目录的
 * `~/.zcode/AGENTS.md`，`workspace` 来自工作区（含向上到 projectRoot 的搜索）。合并时以
 * `workspace` 为主文件，但两份内容都进入最终提示词（见 `mergeInstructionSources`）。
 * 生产者：适配器的候选去重；消费者：`ResolvedUserInstructions.sources` 的读者。
 */
export type UserInstructionSourceScope = "user" | "workspace";

/**
 * 【契约坐标】单个指令文件的读取事实：`content` 已按 `maxBytes` 截断，`bytesRead` 是截断后
 * 的实际字节数，`sizeBytes` 是磁盘原长，`truncated = sizeBytes > maxBytes`。因此
 * `bytesRead ≤ maxBytes` 恒成立，但「读到了多少」与「文件多大」是两件事，不能用
 * `bytesRead` 反推文件大小。读失败不产生本对象，只向快照的 `diagnostics` 追加一条。
 */
export interface ResolvedUserInstructionSource {
  scope: UserInstructionSourceScope;
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

/**
 * 【契约坐标】多份指令的**合并视图**：`content` 是各文件按候选顺序以 `\n\n` 拼接，`bytesRead`
 * / `sizeBytes` 是各源求和，`truncated` 是任一源被截断。顶层 `filePath` / `fileName` 取
 * `workspace` 源，没有 workspace 源才取第一个（users 源）——它只用于展示「主文件」，不表示
 * 其余内容被丢弃；完整清单在 `sources`。没有任何文件读到内容时整个字段缺席，不是空对象。
 */
export interface ResolvedUserInstructions {
  filePath: string;
  fileName: string;
  content: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
  sources?: ResolvedUserInstructionSource[];
}

/**
 * 【契约坐标】项目主语言的封闭集合，由 projectRoot 下的构建文件探得；`unknown` 是**真实值**
 * （不是「没探」）：没有可识别清单时明确报 unknown，消费者据此跳过语言相关的提示词段落。
 * 与 `PackageManager` 分离：一个 Python/Go 项目也可能有 `package.json`（工具链），所以两者
 * 不是同一条探测的结果。生产者：适配器 `detectProjectContext`；消费者：系统提示词的
 * 项目段与工具默认参数提示。
 */
export type ProjectType = "node" | "python" | "rust" | "go" | "java" | "unknown";
/**
 * 【契约坐标】Node 生态的包管理器判别，按 lockfile 的**存在性**而非版本决定；字段缺席即
 * 「无法判定」（例如只有 `package.json` 没有 lockfile），不是默认 `npm`。生产者：适配器的
 * 构建文件探测；消费者：提示词里「该用什么跑脚本」的建议。
 */
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

/**
 * 【契约坐标】对 projectRoot 的一次静态探测结果：`type` 恒在场（`unknown` 也算结果），
 * `packageManager` / `scripts` / `buildFiles` 只在探到对应证据时出现。`scripts` 取自
 * `package.json` 的 scripts 映射，用于提示词里列出可运行命令；`buildFiles` 是参与判别的
 * 清单路径。整个过程只读，不执行包管理器、不安装依赖，因此与运行中环境的变化无关。
 * 生产者：适配器 `detectProjectContext`；消费者：`ContextSourceSnapshot.projectContext`。
 */
export interface ProjectContext {
  type: ProjectType;
  packageManager?: PackageManager;
  scripts?: Record<string, string>;
  buildFiles?: string[];
}

/**
 * 【契约坐标】每个字段都是**可选覆盖**，缺席即由适配器自行探测：`envInfo` 给了就原样使用
 * （跳过 Node/git 探测），`userInstructions` / `projectContext` 同理。`currentDate` 缺席时由
 * `formatLocalIsoDate(new Date())` 生成；`effectiveShellDisplayName` 覆盖 `SHELL` / `ComSpec`
 * 的 basename。`trace` 只用于诊断/日志链路。生产者：core 的 `ensureContextInitialized`；
 * 消费者：`NodeContextSourceAdapter.resolveContextSources`。
 */
export interface ContextSourceRequest {
  workingDirectory: string;
  currentDate?: string;
  effectiveShellDisplayName?: string;
  envInfo?: EnvInfo;
  userInstructions?: UserInstructionsOptions;
  projectContext?: ProjectContext;
  trace?: TraceContext;
}

/**
 * 【契约坐标】**非致命**读取失败的记录：某个指令文件读不到、某个探测失败时，快照仍然成功
 * 返回，只是 `diagnostics` 多一条。`code` 是稳定分类（如 `user_instructions_read_failed`），
 * `message` 是原始错误文本，`path` 在涉及文件时给出。消费者：UI 的上下文诊断面板与日志；
 * 它不出现在系统提示词里，不能被当成模型可见的输入。
 */
export interface ContextSourceDiagnostic {
  code: string;
  message: string;
  path?: string;
}

/**
 * 【契约坐标】一次解析的**完整结果**，也是运行时上下文的事实底座：`workingDirectory` 是
 * `resolve()` 后的绝对路径，core 用它回写 runtime 的 cwd 与 workspaceRoot；`envInfo` 恒在场；
 * `userInstructions` / `projectContext` 可缺席（没读到 / 没探到）；`diagnostics` 恒为数组
 * （失败不是抛错）。快照在 `contextSourceSnapshot` 上被复用，**不因运行中环境变化重建**。
 * 生产者：`NodeContextSourceAdapter` 或 config-only 降级；消费者：`createContextBuilderFromSnapshot`。
 */
export interface ContextSourceSnapshot {
  workingDirectory: string;
  envInfo: EnvInfo;
  currentDate?: string;
  userInstructions?: ResolvedUserInstructions;
  projectContext?: ProjectContext;
  diagnostics: ContextSourceDiagnostic[];
}

/**
 * 【契约坐标】`signal` 中止本次解析（文件读取与 git 探测），不保留给后续使用；`context` 是
 * tracing 的执行上下文，用于把诊断挂到正确的 trace 上。两者都不影响解析结果的内容，只影响
 * 「这次调用是否完成」。
 */
export interface ContextSourceResolveOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

/**
 * 【契约坐标】唯一方法是**一次性解析**（Promise 完成即快照，没有流式增量、没有订阅）：调用方
 * 负责把它存起来复用，端口自身不缓存、不提供「刷新」语义——需要新事实时重新调用即可。
 * 端口在 runtime 上可选，缺席时 `ensureContextInitialized` 退回 config-only 快照；
 * 生产者：adapters 的 `NodeContextSourceAdapter`；消费者：core 的 context 初始化。
 */
export interface ContextSourcePort {
  resolveContextSources(
    request: ContextSourceRequest,
    options?: ContextSourceResolveOptions,
  ): Promise<ContextSourceSnapshot>;
}
