// workspace hook 配置的发现、校验与归一：从 zcode.json / .zcode/config.json 收集候选文件，
// 用 zod 严格校验 hooks 段，再由 resolve* 系列把超时与输出上限折叠成可执行的运行时参数。
// 本模块只产出纯数据（source input / runtime root / gate 结果），不创建回调、不启动子进程，
// 因此可被同步与异步 discovery 以及摘要（digest）计算共享，避免多条路径各自定义规则。
// INV-01 三档超时来源的优先级不可倒置：timeoutMs 优先于 command 的 timeout（秒转毫秒）再退到默认值；守住位置：resolveWorkspaceHookTimeoutMs 的 ?? 链；改错故障：显式超时被默认 60s 静默覆盖，长任务 Hook 被误杀。
// INV-02 超时归一必须夹到不小于 1 且取整；守住位置：resolveWorkspaceHookTimeoutMs 末尾的 Math.max 与 Math.round；改错故障：0 或小数传给子进程，Hook 立即退出或定时器抖动。
// INV-03 最大输出字节归一与超时同构；守住位置：resolveWorkspaceHookMaxOutputBytes；改错故障：截断阈值变成 0，Hook 的 stdout 被整体丢弃。
// INV-04 roots 折叠采用「后者覆盖标量、enabled 单向或」；守住位置：resolveWorkspaceHookRuntimeRoot 的 for 循环；改错故障：父级 enabled=false 覆盖子级 true，用户显式开启的 Hook 静默失效。
// INV-05 roots 中的 undefined 条目必须跳过而非重置默认；守住位置：resolveWorkspaceHookRuntimeRoot 的 if (!root) continue；改错故障：未声明的层把已合并的超时打回默认值。
// INV-06 运行时根默认关闭；守住位置：resolveWorkspaceHookRuntimeRoot 中 enabled 的初值 false；改错故障：无配置工作区意外执行磁盘上遗留的 Hook。
// INV-07 configuredEnabled 为三重 gate 的合取；守住位置：resolveWorkspaceHookConfiguredGates 的返回对象；改错故障：source 或 declaration 任一关闭仍执行 Hook，权限边界失效。
// INV-08 gate 的缺省语义是「未声明即允许」；守住位置：sourceEnabled/declarationEnabled 的 !== false 判断；改错故障：undefined 被当禁用，默认配置下 Hook 全部不触发。
// INV-09 候选路径顺序固定为 zcode.json 先于 .zcode/config.json；守住位置：buildWorkspaceHookCandidatePaths 的 flatMap；改错故障：同目录两份配置的优先关系翻转，trust 记录失效。
// INV-10 配置 refs 按 resolve 后路径去重并保留首次出现；守住位置：deduplicateWorkspaceHookConfigRefs；改错故障：同一文件产生重复 source 与重复 declaration，digest 分叉触发重复授权提示。
// INV-11 去重不得重排剩余条目；守住位置：deduplicateWorkspaceHookConfigRefs 的 push 顺序；改错故障：discoveryOrder 变化使既有 trust 记录全部失效，用户被重新提示全部 Hook。
// INV-12 显式路径排在 auto-discovery 之后；守住位置：discoverWorkspaceHookConfigPaths 的 refs.push；改错故障：显式配置在去重中被丢弃，用户指定的 Hook 文件不加载。
// INV-13 单文件解析失败只进入 errors，不中断整体读取；守住位置：readWorkspaceHookProjectSources 的 try/catch；改错故障：一个坏 JSON 让工作区全部 Hook 静默失效且无提示。
// INV-14 缺少 hooks 键的文件不算 Hook 源；守住位置：readWorkspaceHookProjectSources 中 value.hooks === undefined 的 continue；改错故障：无 Hook 的 zcode.json 被登记为 source，摘要与 UI 计数虚高。
// INV-15 baseDir 需从 .zcode 目录上提一级；守住位置：createWorkspaceHookSourceInput 的 basename 判断；改错故障：相对 command 在 .zcode 子目录解析，找不到可执行文件。
// INV-16 configFileKind 的判定顺序是 explicit 优先于 zcode.json 优先于 .zcode/config.json；守住位置：createWorkspaceHookSourceInput 的三元链；改错故障：显式加载的文件被标成自动发现，编辑权限判断错误。
// INV-17 editable 仅对工作目录下的 .zcode/config.json 为真；守住位置：createWorkspaceHookSourceInput 的 editable 表达式；改错故障：上级目录或显式文件被允许写入，越权改动用户配置。
// INV-18 matcher 与 hooks 配置必须 strict，未知键要报错；守住位置：workspaceHookMatcherConfigSchema 与 workspaceHooksConfigSchema 的 .strict；改错故障：拼写错误的字段被静默忽略，用户误以为 Hook 已生效。
// INV-19 事件名集合以 WORKSPACE_HOOK_EVENT_NAMES 为唯一来源；守住位置：类型推导与 events 对象的七个键；改错故障：新增事件漏配 schema，该事件的 Hook 永远不触发。
import { existsSync, statSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

export const WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION = 1 as const;
export const DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKSPACE_HOOK_MAX_OUTPUT_BYTES = 32_768;
export const WORKSPACE_HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

export type WorkspaceHookEventName = (typeof WORKSPACE_HOOK_EVENT_NAMES)[number];
export type WorkspaceHookConfigFileKind = "zcode.json" | ".zcode/config.json" | "explicit";

// [失败路径] finite 同时排除 NaN 与正负 Infinity，避免非法超时流入定时器后变成 1ms 立即触发
// [权衡] 只要求 positive 而不设上界：允许超长 Hook，由用户自负等待成本，不硬编码业务上限
// [失败路径] 数值合法性在 schema 层拒绝而非 resolve 阶段兜底，使错误能定位到具体配置文件
const positiveNumberSchema = z.number().finite().positive();

// [权衡] passthrough 保留未知字段，新版本配置在旧客户端解析时不至于整体失败，代价是拼写错误不报错
// [资源] process 类型不提供 async 与 shell，进程生命周期完全由调用方按 timeoutMs 独占管控
// [失败路径] command 为空串被 min(1) 拒绝，防止 spawn 时抛出难以理解的 ENOENT
export const workspaceHookProcessConfigSchema = z
  .object({
    type: z.literal("process"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })
  .passthrough();

// [并发] async 标记决定命令是否脱离等待：为 true 时其输出不参与阻塞判定，需自行承担进程泄漏风险
// [权衡] timeout 以秒计而 timeoutMs 以毫秒计，并存只为兼容既有 shell hook 写法，解析时后者优先
// [失败路径] shell 仅接受 true 或非空字符串并显式拒绝 false，避免静默退回默认 shell 的安全歧义
export const workspaceHookCommandConfigSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string().min(1)]).optional(),
    timeout: positiveNumberSchema.optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
  })
  .passthrough();

// [失败路径] strict 拒绝未知键：matcher 拼错时立即报错，而不是退化为匹配全部工具的宽松语义
// [事务] hooks 数组 min(1)，空数组视为配置错误，避免出现有 matcher 却无动作的半配置
// [权衡] matcher 可省略，表示该组 Hook 对所有载荷生效，具体匹配语义由调用方决定
export const workspaceHookMatcherConfigSchema = z
  .object({
    matcher: z.string().min(1).optional(),
    hooks: z
      .array(
        z.discriminatedUnion("type", [
          workspaceHookProcessConfigSchema,
          workspaceHookCommandConfigSchema,
        ]),
      )
      .min(1),
  })
  .strict();

// [失败路径] events 只声明七个已知键且 strict，未知事件名直接失败，防止写错的 Hook 永不触发
// [权衡] events 整体 optional，缺省与空对象在运行时语义一致，都不产生任何声明
// [事务] enabled、timeoutMs、maxOutputBytes 均为可选覆盖，未出现时保留上层或默认值，不做零值填充
export const workspaceHooksConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveNumberSchema.optional(),
    maxOutputBytes: positiveNumberSchema.optional(),
    events: z
      .object({
        SessionStart: z.array(workspaceHookMatcherConfigSchema).optional(),
        UserPromptSubmit: z.array(workspaceHookMatcherConfigSchema).optional(),
        PreToolUse: z.array(workspaceHookMatcherConfigSchema).optional(),
        PermissionRequest: z.array(workspaceHookMatcherConfigSchema).optional(),
        PostToolUse: z.array(workspaceHookMatcherConfigSchema).optional(),
        PostToolUseFailure: z.array(workspaceHookMatcherConfigSchema).optional(),
        Stop: z.array(workspaceHookMatcherConfigSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkspaceHookDefinition =
  | z.infer<typeof workspaceHookCommandConfigSchema>
  | z.infer<typeof workspaceHookProcessConfigSchema>;
export type WorkspaceHooksConfig = z.infer<typeof workspaceHooksConfigSchema>;

// [事务] discoveryOrder 是摘要输入，代表发现顺序而非优先级，任何重排都会使既有 trust 记录失效
// [资源] canonicalPath 与 baseDir 分离：前者用于去重与摘要，后者用于解析相对 command 的工作目录
// [失败路径] editable 由创建方一次性决定，下游不得再次推导，避免出现两处不一致的写入判定
export interface WorkspaceHookSourceInput {
  canonicalPath: string;
  baseDir: string;
  discoveryOrder: number;
  configFileKind: WorkspaceHookConfigFileKind;
  explicitProjectConfig: boolean;
  editable: boolean;
  hooks: WorkspaceHooksConfig;
}

export interface WorkspaceHookRuntimeRoot {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface WorkspaceHookConfigPathRef {
  path: string;
  explicitProjectConfig: boolean;
}

export interface WorkspaceHookSourceReadError {
  path: string;
  error: unknown;
}

// [事务] 解析顺序固定：timeoutMs 优先，其次 command 的 timeout 乘 1000，最后落到默认值，前者存在即短路
// [失败路径] timeout 仅在 type 为 command 时换算，process 误配的 timeout 被忽略而不是静默按秒处理
// [并发] 只读取入参做数值归一，不修改对象本身，多个 Hook 可共享同一配置而互不影响
// [权衡] 秒与毫秒混用是历史兼容产物，换算集中在此单点，避免每个调用方各自乘 1000 产生分歧
// [资源] Math.round 消掉小数毫秒，防止长时间运行后定时器误差逐次累积
export function resolveWorkspaceHookTimeoutMs(
  hook: Pick<WorkspaceHookDefinition, "type" | "timeoutMs"> & { timeout?: number },
  defaultTimeoutMs: number,
): number {
  const timeoutMs =
    hook.timeoutMs ??
    (hook.type === "command" && hook.timeout !== undefined
      ? hook.timeout * 1000
      : defaultTimeoutMs);
  return Math.max(1, Math.round(timeoutMs));
}

// [失败路径] 下限夹到 1 字节，0 或负数会让截断逻辑把所有输出都判为越界
// [事务] 与超时共用同一套归一规则，保证两个运行时参数在同一次配置解析中得到一致处理
export function resolveWorkspaceHookMaxOutputBytes(maxOutputBytes: number): number {
  return Math.max(1, Math.round(maxOutputBytes));
}

/** Mirrors config-merger's hooks root semantics without materializing any callback. */
// [并发] roots 按传入顺序单向折叠，后者覆盖前者的标量，结果与输入数组顺序强相关
// [事务] enabled 只做或运算：任一层显式 true 即生效，不会被后续层的未声明重置为 false
// [失败路径] 跳过 undefined 条目，缺失层不得把已合并的超时或输出上限打回默认
// [权衡] 默认 enabled 为 false，宁可漏跑也不在无配置工作区执行磁盘上的 Hook
// [事务] 返回新对象而非复用入参，调用方修改结果不会反向污染配置来源
export function resolveWorkspaceHookRuntimeRoot(
  roots: readonly (
    | Partial<Pick<WorkspaceHooksConfig, "enabled" | "timeoutMs" | "maxOutputBytes">>
    | undefined
  )[],
): WorkspaceHookRuntimeRoot {
  let enabled = false;
  let timeoutMs = DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS;
  let maxOutputBytes = DEFAULT_WORKSPACE_HOOK_MAX_OUTPUT_BYTES;

  for (const root of roots) {
    if (!root) continue;
    if (root.enabled === true) enabled = true;
    if (root.timeoutMs !== undefined) timeoutMs = root.timeoutMs;
    if (root.maxOutputBytes !== undefined) maxOutputBytes = root.maxOutputBytes;
  }

  return {
    enabled,
    timeoutMs: Math.max(1, Math.round(timeoutMs)),
    maxOutputBytes: resolveWorkspaceHookMaxOutputBytes(maxOutputBytes),
  };
}

// [事务] configuredEnabled 是三个 gate 的合取，任一层关闭即整体关闭，不存在部分生效
// [失败路径] source 与 declaration 缺省视为允许（!== false），未声明不等于禁用
// [并发] 函数无副作用，同一输入在任意时刻返回相同结果，可同时用于渲染判定与摘要计算
// [权衡] runtimeHooksEnabled 原样透传而不参与默认值推导，运行时总开关由上层唯一持有
export function resolveWorkspaceHookConfiguredGates(input: {
  sourceEnabled?: boolean;
  declarationEnabled?: boolean;
  runtimeHooksEnabled: boolean;
}) {
  const sourceRootEnabled = input.sourceEnabled !== false;
  const declarationEnabled = input.declarationEnabled !== false;
  return {
    sourceRootEnabled,
    declarationEnabled,
    runtimeHooksEnabled: input.runtimeHooksEnabled,
    configuredEnabled: sourceRootEnabled && declarationEnabled && input.runtimeHooksEnabled,
  };
}

/**
 * 从已发现的配置目录列表生成 workspace hook 候选文件路径。
 * 纯函数，sync/async discovery 共享，确保候选文件名与顺序规则只在此处维护一次
 * （sync/async 共享同一份 flatMap，避免候选路径的生成规则出现分歧）。
 */
// [事务] 每个目录固定先产出 zcode.json、再产出 .zcode/config.json，该顺序即后续的发现顺序
// [并发] 纯函数且不触碰文件系统，同步与异步 discovery 共用同一份路径生成规则
function buildWorkspaceHookCandidatePaths(directories: readonly string[]): string[] {
  return directories.flatMap((directory) => [
    join(directory, "zcode.json"),
    join(directory, ".zcode", "config.json"),
  ]);
}

/**
 * 对已发现的 config refs 按规范化路径去重，保留首次出现的条目。
 *
 * 当 explicit projectConfigPath 恰好指向 auto-discovery 已发现的文件时，
 * 同一文件会以不同 explicitProjectConfig 标记出现两次，进入 snapshot 后产生重复
 * sourceFile 与重复 declaration，导致 bundleDigest 分叉。
 *
 * 去重策略：保留首次出现者（auto-discovered 条目在前、explicit 在后），丢弃后续重复。
 * 不得改变剩余条目的相对顺序——discoveryOrder 和 explicitProjectConfig 均为 digest 输入，
 * 任何重排都会使既有 trust 记录失效（用户被重新提示全部 Hook）。对于无 explicit path
 * 的 workspace，auto-discovery 本身不会产生重复，此函数为 no-op，bundleDigest 不变。
 */
// [事务] 去重键为 resolve 后的绝对路径，相对写法与符号链接差异不会产生重复条目
// [失败路径] 只丢弃后出现的重复项，保留 auto-discovered 在前，explicit 标记不被后续覆盖
// [事务] 剩余条目相对顺序不变，discoveryOrder 稳定，既有 trust 记录继续有效
function deduplicateWorkspaceHookConfigRefs(
  refs: readonly WorkspaceHookConfigPathRef[],
): WorkspaceHookConfigPathRef[] {
  const seen = new Set<string>();
  const result: WorkspaceHookConfigPathRef[] = [];
  for (const ref of refs) {
    const resolved = resolve(ref.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(ref);
  }
  return result;
}

// [并发] existsSync 只做瞬时探测，返回后结果可能已失效，读取阶段仍须独立处理 ENOENT
// [事务] 先收集自动发现项再 push 显式项，保证去重时自动条目在前、显式条目在末尾
// [失败路径] 显式路径不存在时静默跳过而非报错，避免一个拼错的路径让整体发现失败
export function discoverWorkspaceHookConfigPaths(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): WorkspaceHookConfigPathRef[] {
  const start = resolve(input.workingDirectory);
  const refs = buildWorkspaceHookCandidatePaths(getProjectConfigDirectories(start))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, explicitProjectConfig: false }));

  if (input.explicitProjectConfigPath) {
    const explicitPath = resolve(input.explicitProjectConfigPath);
    if (existsSync(explicitPath)) refs.push({ path: explicitPath, explicitProjectConfig: true });
  }
  return deduplicateWorkspaceHookConfigRefs(refs);
}

// [事务] configFileKind 判定顺序为 explicit、zcode.json、.zcode/config.json，互斥且全覆盖
// [失败路径] 目录名为 .zcode 时 baseDir 上提一级，否则相对 command 会在子目录解析失败
// [资源] editable 仅对工作目录下的 .zcode/config.json 为真，其余来源一律只读
// [并发] 所有路径先 resolve 再比较，消除 Windows 大小写与分隔符差异带来的误判
export function createWorkspaceHookSourceInput(input: {
  path: string;
  workingDirectory: string;
  hooks: WorkspaceHooksConfig;
  discoveryOrder: number;
  explicitProjectConfig?: boolean;
}): WorkspaceHookSourceInput {
  const canonicalPath = resolve(input.path);
  const explicitProjectConfig = input.explicitProjectConfig === true;
  const configDirectory = dirname(canonicalPath);
  return {
    canonicalPath,
    baseDir: basename(configDirectory) === ".zcode" ? dirname(configDirectory) : configDirectory,
    discoveryOrder: input.discoveryOrder,
    configFileKind: explicitProjectConfig
      ? "explicit"
      : basename(canonicalPath) === "zcode.json"
        ? "zcode.json"
        : ".zcode/config.json",
    explicitProjectConfig,
    editable:
      !explicitProjectConfig &&
      canonicalPath === resolve(input.workingDirectory, ".zcode", "config.json"),
    hooks: input.hooks,
  };
}

// [失败路径] 逐文件 try/catch：单个 JSON 语法错误或 schema 校验失败只写入 errors，不影响其余文件
// [事务] 缺少 hooks 键的文件直接 continue，不产生 source，也不进入摘要计算
// [并发] 串行 await 读取，保持 discoveryOrder 与 refs 下标严格一致
// [资源] 读取失败不向上抛出，由调用方依据 errors 决定提示，保证其余配置仍然生效
export async function readWorkspaceHookProjectSources(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): Promise<{ sources: WorkspaceHookSourceInput[]; errors: WorkspaceHookSourceReadError[] }> {
  const refs = await discoverWorkspaceHookConfigPathsAsync(input);
  const sources: WorkspaceHookSourceInput[] = [];
  const errors: WorkspaceHookSourceReadError[] = [];

  for (const [discoveryOrder, ref] of refs.entries()) {
    try {
      const value = JSON.parse(await readFile(ref.path, "utf8")) as unknown;
      if (!isRecord(value) || value.hooks === undefined) continue;
      sources.push(
        createWorkspaceHookSourceInput({
          path: ref.path,
          workingDirectory: input.workingDirectory,
          hooks: workspaceHooksConfigSchema.parse(value.hooks),
          discoveryOrder,
          explicitProjectConfig: ref.explicitProjectConfig,
        }),
      );
    } catch (error) {
      errors.push({ path: ref.path, error });
    }
  }
  return { sources, errors };
}

async function discoverWorkspaceHookConfigPathsAsync(input: {
  workingDirectory: string;
  explicitProjectConfigPath?: string;
}): Promise<WorkspaceHookConfigPathRef[]> {
  const start = resolve(input.workingDirectory);
  const candidates = buildWorkspaceHookCandidatePaths(
    await getProjectConfigDirectoriesAsync(start),
  );
  const refs: WorkspaceHookConfigPathRef[] = [];
  for (const path of candidates) {
    if (await pathExists(path)) refs.push({ path, explicitProjectConfig: false });
  }
  if (input.explicitProjectConfigPath) {
    const explicitPath = resolve(input.explicitProjectConfigPath);
    if (await pathExists(explicitPath)) {
      refs.push({ path: explicitPath, explicitProjectConfig: true });
    }
  }
  return deduplicateWorkspaceHookConfigRefs(refs);
}

async function getProjectConfigDirectoriesAsync(start: string): Promise<string[]> {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (await hasWorktreeMarkerAsync(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

async function hasWorktreeMarkerAsync(directory: string): Promise<boolean> {
  try {
    const stats = await stat(join(directory, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

// [事务] 从工作目录向上回溯到含 .git 标记的目录，命中后 reverse 成自根向下的顺序
// [失败路径] 回溯到文件系统根仍无标记时只返回起始目录，避免把整条盘符路径当成配置层级
function getProjectConfigDirectories(start: string): string[] {
  const directories: string[] = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (hasWorktreeMarker(current)) return directories.reverse();
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [start];
}

// [失败路径] .git 可能是目录，也可能是 worktree 的普通文件，两者都必须视为仓库根
// [资源] statSync 抛错一律吞掉并返回 false，权限问题或竞态不应中断目录发现
function hasWorktreeMarker(directory: string): boolean {
  const marker = join(directory, ".git");
  try {
    if (!existsSync(marker)) return false;
    const stats = statSync(marker);
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

// [失败路径] 排除 null 与数组，防止 JSON.parse 得到数组时被误当成可读取 hooks 的对象
// [事务] 类型守卫只判断形状，不校验 hooks 内容，结构校验交给 zod 单点负责
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
