// INV-01 条目集合由来源顺序、事件常量顺序、匹配器下标、钩子下标四级笛卡尔积唯一确定；守住位置：resolveWorkspaceHookEntries 的四层嵌套循环；改错故障：同一份配置两次发现得到不同条目顺序，bundleDigest 随之漂移，用户反复收到“配置已变更”提示。
// INV-02 事件遍历顺序取自 WORKSPACE_HOOK_EVENT_NAMES 常量数组，不依赖配置对象的键序；守住位置：resolveWorkspaceHookEntries 的第二层循环；改错故障：键序受运行时重排影响，摘要字节序在不同环境分叉，存量快照全部判脏。
// INV-03 reviewItemId 只由四级下标拼接，不含命令文本与超时值；守住位置：common 对象里 reviewItemId 的模板构造；改错故障：用户改一次命令就换 id，界面里已确认或已忽略的条目状态全部丢失。
// INV-04 声明摘要只覆盖声明内容与解析后的超时、输出上限，不覆盖运行时开关；守住位置：canonicalDeclarationPayload 返回的数组；改错故障：用户只拨总开关就触发全量摘要变更，无法区分“声明改动”与“运行时开关”。
// INV-05 摘要输入是 JSON 文本后取 sha256，依赖序列化器对数组与数字的输出细节；守住位置：sha256 函数；改错故障：换序列化方式或重排字段都让全部历史摘要失效，存量对账全量报变更。
// INV-06 可选配置值用二元组标记设置态，未设置与显式 false 必须产出不同字节；守住位置：canonicalOptional；改错故障：两种配置塌缩成同一字节串，摘要无法区分“未写”与“写 false”。
// INV-07 执行段按 type 分成两种形状，形状首元素即类型标签；守住位置：canonicalDeclarationPayload 的 execution 分支；改错故障：command 与 process 命令文本相同时撞摘要，删掉一种声明而另一种被判未变更。
// INV-08 shell 的三态（未设置、布尔真、字符串）各自独立编码，不得压成两种；守住位置：execution 中 command 分支的嵌套三元；改错故障：显式 true 与未设置混同，用户补上 shell 配置后摘要不变。
// INV-09 process 的 args 缺失时补空数组再入载荷，保证形状固定；守住位置：execution 的 process 分支；改错故障：参数个数变化不改变摘要，用户命令行为已变而系统仍报无变更。
// INV-10 相对路径统一把反斜杠折成斜杠，分隔符不进入摘要；守住位置：normalizeRelativeSourcePath 的 replaceAll；改错故障：Windows 与 Linux 对同一工作区算出不同摘要，双端同步的快照互相判脏。
// INV-11 两端路径先解析成绝对形式再取相对，点段必须被消解；守住位置：normalizeRelativeSourcePath 的 resolve 调用；改错故障：摘要里残留“..”片段，换机器后前缀不同导致全部条目判为改动。
// INV-12 相对结果为空时回退到源文件基名，载荷里不允许出现空串路径；守住位置：normalizeRelativeSourcePath 末尾的短路回退；改错故障：工作区与配置文件同目录时路径为空，不同来源在摘要里碰撞。
// INV-13 条目为空时返回 undefined，不返回空快照；守住位置：buildWorkspaceHookBundleSnapshot 的提前返回；改错故障：调用方拿空快照覆盖本地有效快照，用户已保存的钩子配置凭空消失。
// INV-14 快照的 schemaVersion 与 bundleDigest 必须由同一次构造产出；守住位置：buildWorkspaceHookBundleSnapshot 的返回字面量；改错故障：版本与摘要覆盖范围不一致，加载端按新版本解析旧字节后字段错位读空。
// INV-15 快照返回前必须深度冻结，hooks 与 sourceFiles 都不可被就地改写；守住位置：deepFreeze 的递归；改错故障：共享快照被一处修改，另一处按摘要判定未变更却读到被篡改数据。
// INV-16 发现时间只在调用方未注入时读时钟，注入值原样保留；守住位置：discoveredAt 的默认值表达式；改错故障：固定时间被覆盖成当前时刻，回放与快照对账每次都判定不一致。
// INV-17 超时与输出上限在构造条目时即解析定值，不向消费方传中间态；守住位置：resolveWorkspaceHookEntries 内对 resolveWorkspaceHookTimeoutMs 的调用；改错故障：下游两次解析得到不同值，同一条钩子的截断行为随调用次数变化。
// INV-18 四道门槛（来源、声明、运行时、最终生效）各自落盘，不只保存最终布尔；守住位置：gates 展开进 common 对象；改错故障：用户看到钩子没执行却无法解释是哪一道被关掉，排障只能盲猜。
// INV-19 摘要链路不得读取环境变量、时钟、文件系统或模块级缓存；守住位置：createWorkspaceHookDeclarationDigest 及其全部被调函数；改错故障：同输入在另一进程算出不同值，快照无法跨设备与跨会话比对。
// INV-20 新增任何参与行为的字段都要同时改声明载荷、包载荷与这两处不变量表；守住位置：canonicalDeclarationPayload 与 bundlePayload 的数组布局；改错故障：只改一处载荷，字段改动被摘要漏检，用户改了配置却收不到变更提示。
import { createHash } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import {
  WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
  WORKSPACE_HOOK_EVENT_NAMES,
  resolveWorkspaceHookConfiguredGates,
  resolveWorkspaceHookTimeoutMs,
  type WorkspaceHookConfigFileKind,
  type WorkspaceHookDefinition,
  type WorkspaceHookEventName,
  type WorkspaceHookRuntimeRoot,
  type WorkspaceHookSourceInput,
} from "./workspace-hook-config.js";

// CanonicalWorkspaceHookEntryData 是“已解析完成”的快照而不再需要二次求值：超时、输出上限、
// 四道门槛布尔值都在 resolveWorkspaceHookEntries 里算好，消费方读到即可直接执行。
// 声明摘要字段与 declarationDigestAlgorithm 成对出现而算法名一同落盘，
// 使得未来换算法时可以按条目逐条判定，而不是把整包快照丢弃重建。
// [失败路径] 可选字段缺失时用展开省略而不是 undefined 占位，序列化后键不存在，
// 摘要字节串因此稳定；若写成 undefined 就会依赖序列化器的具体行为。
export interface CanonicalWorkspaceHookEntryData {
  reviewItemId: string;
  event: WorkspaceHookEventName;
  matcherIndex: number;
  hookIndex: number;
  sourceFileIndex: number;
  sourceRelativePath: string;
  matcher: string | null;
  type: "command" | "process";
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  statusMessage?: string;
  sourceRootEnabled: boolean;
  declarationEnabled: boolean;
  runtimeHooksEnabled: boolean;
  configuredEnabled: boolean;
  editable: boolean;
  declarationDigestAlgorithm: "sha256";
  hookDeclarationDigest: string;
}

// 包级结构 WorkspaceHookBundleSnapshotData 由来源清单、条目表与两类摘要构成，可直接落盘。
// schemaVersion 声明为字面量类型而不是 number，编译器强制它与运行时常量同步，
// 避免手写数字与常量混用时加载端无法分辨来源。
// hooks 与 sourceFiles 必须来自同一轮发现，不允许分别构造后拼接，
// 否则 bundleDigest 覆盖的内容与实际数据可能不一致。
export interface WorkspaceHookBundleSnapshotData {
  schemaVersion: typeof WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION;
  workspaceIdentity: string;
  discoveredAt: string;
  sourceFiles: Array<{
    canonicalPath: string;
    baseDir: string;
    discoveryOrder: number;
    configFileKind: WorkspaceHookConfigFileKind;
    explicitProjectConfig: boolean;
    editable: boolean;
    hooksRoot: {
      enabled?: boolean;
      timeoutMs?: number;
      maxOutputBytes?: number;
    };
  }>;
  hooks: CanonicalWorkspaceHookEntryData[];
  digestAlgorithm: "sha256";
  bundleDigest: string;
}

// resolveWorkspaceHookEntries 把“配置来源 → 事件 → 匹配器 → 钩子”四层结构压平成扁平条目表，
// 下标本身就是身份：任一下标重排都会连带 reviewItemId 与声明摘要变化，
// 等于用户所有既有审阅状态归零，因此顺序不是实现细节而是对外契约。
// [权衡] 这里刻意不排序去重：条目顺序直接承载发现顺序，便于界面按来源分组；
// 若按命令文本排序，两个来源声明同一条命令会互换位置，而两者路径不同、摘要必改，
// 用户只看到 bundleDigest 变化，无从判断是重排还是真改了配置。
// [并发] 函数只读 input 且不写任何外部状态，可被多个调用方重复执行；
// 每次调用各自持有独立的 hash 对象，不共享可变缓冲区。
export function resolveWorkspaceHookEntries(input: {
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
}): CanonicalWorkspaceHookEntryData[] {
  const entries: CanonicalWorkspaceHookEntryData[] = [];

  // 来源数组的顺序由上层发现流程决定，本函数原样沿用，不做字典序归一。
  // [权衡] 曾考虑按 canonicalPath 排序以获得稳定输出，但那会让“新增一个更靠前
  // 目录的配置文件”导致其后所有来源下标后移，reviewItemId 批量失效。
  // 事件遍历固定用 WORKSPACE_HOOK_EVENT_NAMES 常量，因为整数样式的对象键
  // 会被语言规范重排，一旦将来加入数字样式事件名，依赖键序的实现会静默改变
  // 摘要字节序，而 workspace-hook-config 的解析层看不出任何异常。
  for (const [sourceFileIndex, source] of input.sources.entries()) {
    const sourceRelativePath = normalizeRelativeSourcePath(
      input.workspacePath,
      source.canonicalPath,
    );
    for (const event of WORKSPACE_HOOK_EVENT_NAMES) {
      for (const [matcherIndex, matcher] of (source.hooks.events?.[event] ?? []).entries()) {
        for (const [hookIndex, hook] of matcher.hooks.entries()) {
          const gates = resolveWorkspaceHookConfiguredGates({
            sourceEnabled: source.hooks.enabled,
            declarationEnabled: hook.enabled,
            runtimeHooksEnabled: input.runtimeRoot.enabled,
          });
          const resolvedTimeoutMs = resolveWorkspaceHookTimeoutMs(
            hook,
            input.runtimeRoot.timeoutMs,
          );
          const common = {
            reviewItemId: `workspace-hook-${sourceFileIndex}-${event}-${matcherIndex}-${hookIndex}`,
            event,
            matcherIndex,
            hookIndex,
            sourceFileIndex,
            sourceRelativePath,
            matcher: matcher.matcher ?? null,
            command: hook.command,
            resolvedTimeoutMs,
            resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
            ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
            ...gates,
            editable: source.editable,
            declarationDigestAlgorithm: "sha256" as const,
            hookDeclarationDigest: createWorkspaceHookDeclarationDigest({
              sourceRelativePath,
              sourceDiscoveryOrder: source.discoveryOrder,
              event,
              matcher: matcher.matcher ?? null,
              matcherIndex,
              hookIndex,
              hook,
              defaultTimeoutMs: input.runtimeRoot.timeoutMs,
              resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
            }),
          };

          entries.push(
            hook.type === "process"
              ? {
                  ...common,
                  type: "process",
                  ...(hook.args && hook.args.length > 0 ? { args: [...hook.args] } : {}),
                }
              : {
                  ...common,
                  type: "command",
                  ...(hook.async === true ? { async: true } : {}),
                  ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
                },
          );
        }
      }
    }
  }
  return entries;
}

// [失败路径] 没有任何条目时返回 undefined，把“无钩子”与“空快照”区分开，
// 调用方因此可以保留原有 WorkspaceHookBundleSnapshotData 而不是写空包把它覆盖掉。
// [权衡] 这里重新跑一遍 resolveWorkspaceHookEntries 而不是接收已解析条目，
// 换取调用方不必关心解析顺序；代价是一次重复计算，钩子数量在个位数时可接受。
// discoveredAt 可注入以支持确定性回放而只在缺省时才读时钟，
// 这样测试与快照对账不会因为毫秒差而永远不相等。
// 返回前统一深度冻结，切断调用方与内部结构之间的别名。
export function buildWorkspaceHookBundleSnapshot(input: {
  workspaceIdentity: string;
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
  discoveredAt?: string;
}): WorkspaceHookBundleSnapshotData | undefined {
  const hooks = resolveWorkspaceHookEntries(input);
  if (hooks.length === 0) return undefined;

  const sourceFiles = input.sources.map((source) => ({
    canonicalPath: source.canonicalPath,
    baseDir: source.baseDir,
    discoveryOrder: source.discoveryOrder,
    configFileKind: source.configFileKind,
    explicitProjectConfig: source.explicitProjectConfig,
    editable: source.editable,
    hooksRoot: {
      ...(source.hooks.enabled !== undefined ? { enabled: source.hooks.enabled } : {}),
      ...(source.hooks.timeoutMs !== undefined ? { timeoutMs: source.hooks.timeoutMs } : {}),
      ...(source.hooks.maxOutputBytes !== undefined
        ? { maxOutputBytes: source.hooks.maxOutputBytes }
        : {}),
    },
  }));
  // 摘要载荷用嵌套数组而不是对象：数组序列化不受键名顺序影响，
  // 也不会出现属性名被误改而导致摘要漂移的问题。
  // 第一段是固定标签与版本，第二段覆盖来源文件解析结果，第三段覆盖条目生效态；
  // 三段拼接顺序即协议，插入或调换都会改变全部存量摘要。
  // [权衡] bundlePayload 的来源段只放解析后的门槛值，不放原始配置文本：原文里的空格与
  // 注释不该影响摘要，否则用户仅调整缩进就会被判定为配置变更。
  const bundlePayload = [
    "workspace-hook-bundle",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sources.map((source) => [
      normalizeRelativeSourcePath(input.workspacePath, source.canonicalPath),
      source.discoveryOrder,
      source.configFileKind,
      source.explicitProjectConfig,
      canonicalOptional(source.hooks.enabled),
      canonicalOptional(source.hooks.timeoutMs),
      canonicalOptional(source.hooks.maxOutputBytes),
    ]),
    hooks.map((hook) => [
      hook.hookDeclarationDigest,
      hook.sourceRootEnabled,
      hook.declarationEnabled,
      hook.runtimeHooksEnabled,
      hook.configuredEnabled,
    ]),
  ];

  return deepFreeze({
    schemaVersion: WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    workspaceIdentity: input.workspaceIdentity,
    discoveredAt: input.discoveredAt ?? new Date().toISOString(),
    sourceFiles,
    hooks,
    digestAlgorithm: "sha256",
    bundleDigest: sha256(bundlePayload),
  });
}

export function createWorkspaceHookDeclarationDigest(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  defaultTimeoutMs: number;
  resolvedMaxOutputBytes: number;
}): string {
  return sha256(
    canonicalDeclarationPayload({
      ...input,
      resolvedTimeoutMs: resolveWorkspaceHookTimeoutMs(input.hook, input.defaultTimeoutMs),
    }),
  );
}

// canonicalDeclarationPayload 的布局是跨版本协议：字段位置比字段名更关键，因为数组没有名字可读。
// 执行段按 type 分成两种形状且首元素即类型标签，
// 使 command 与 process 即使命令文本相同也不会撞摘要。
// [权衡] 保留 matcherIndex 与 hookIndex 而不是只留 matcher 文本：
// 同一条命令在多处声明必须视为不同条目，否则删掉一处后另一处被判未变更。
// 数值一律以 JSON 数字输出，避免字符串化带来的前导零与前缀歧义。
function canonicalDeclarationPayload(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
}): unknown[] {
  const execution =
    input.hook.type === "process"
      ? ["process", input.hook.command, [...(input.hook.args ?? [])]]
      : [
          "command",
          input.hook.command,
          input.hook.async === true,
          input.hook.shell === undefined
            ? ["unset"]
            : input.hook.shell === true
              ? ["true"]
              : ["string", input.hook.shell],
        ];
  return [
    "workspace-hook-declaration",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sourceRelativePath,
    input.sourceDiscoveryOrder,
    input.event,
    input.matcher,
    input.matcherIndex,
    input.hookIndex,
    execution,
    input.resolvedTimeoutMs,
    input.resolvedMaxOutputBytes,
  ];
}

// 路径形态直接进摘要，因此必须先把两端都解析成绝对路径再取相对，
// 消掉单点与双点段；否则同一文件用不同写法声明会算出不同摘要。
// 统一转成斜杠是有意为之：Windows 的反斜杠在 JSON 里还要再转义一次，
// 两种分隔符会产出不同字节串，跨平台同步的快照将互相判脏。
// 相对结果为空说明源就在工作区根上，退回基名以保证载荷里没有空串。
function normalizeRelativeSourcePath(workspacePath: string, sourcePath: string): string {
  const value = relative(resolve(workspacePath), resolve(sourcePath)).replaceAll("\\", "/");
  return value || basename(sourcePath);
}

function canonicalOptional(value: boolean | number | undefined): unknown[] {
  return value === undefined ? ["unset"] : ["set", value];
}

// 哈希输入是 JSON 文本而不是二进制编码，因此结果依赖序列化细节：
// 数字格式、字符串转义、数组顺序都由序列化器决定，改动任一项都会分叉。
// [权衡] 不引外部规范化库：载荷已全部由本文件构造，顺序与类型都在掌控内，
// 引入外部规范化库反而多一层 JSON.stringify 行为不一致的风险。
// digest 取 hex 以便直接进入日志与快照字段，不需要再做一次转码。
// 空数组与 undefined 会得到不同摘要，调用方必须保证载荷不是 undefined。
function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// [资源] deepFreeze 只原地封住而不复制结构，调用方拿到的仍是同一份对象引用，
// 只是任何写入都会在严格模式下抛出异常。
// 先判断 isFrozen 再递归，既避免重复遍历共享子树，也避免对已冻结对象再次 freeze。
// [权衡] deepFreeze 只冻结而不做深拷贝：快照可能含大量条目，拷贝开销与内存翻倍不划算，
// 而 Object.freeze 已经能阻止就地篡改这一真正危险的操作。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
