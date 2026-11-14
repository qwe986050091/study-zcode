// ===========================================================================
// workspaceHookSettingsModel：把三种 Hook 来源统一解析成 Hook[]，并写回配置。
// INV-01：Hook.id 在同一来源内唯一且稳定（reviewItemId 或带自增序号的拼接）；
//         id 漂移会让 UI 的信任/启停状态错配到别的声明上。
// INV-02：enabled 的写回值由 configuredState 推导：用户改过就写用户值，
//         否则写声明级开关，避免把根目录开关误固化成用户显式禁用。
// INV-03：非法事件名、非数组 matcher、无 type/command 的条目一律丢弃；
//         这些来自用户手写 JSON，不能让它变成运行期崩溃或幽灵 Hook。
// INV-04：写回字段必须与类型匹配：command 用 timeout(秒)，process 用 args 与 timeoutMs。
// INV-05：写回按 (event, matcher) 分组，同一组合只产生一个 matcher 对象。
// ===========================================================================
import { dirname } from "node:path";
import type {
  Hook,
  HookConfiguredState,
  HookEvent,
  SettingsDirectoryLocation,
  WorkspaceHookDiscoveryState,
} from "@zcode/shared";
import {
  resolveWorkspaceHookEntries,
  type CanonicalWorkspaceHookEntryData,
  type WorkspaceHookBundleSnapshotData,
  type WorkspaceHookDefinition,
  type WorkspaceHookRuntimeRoot,
  type WorkspaceHookSourceInput,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";

// legacy 形状允许任意未知键：这些键要原样保留，回滚到旧客户端时才不会丢配置。
export interface LegacyHookDefinition {
  type?: "command" | "process" | string;
  command?: string;
  args?: string[];
  async?: boolean;
  enabled?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  [key: string]: unknown;
}

// 一层 matcher 承载同事件下的一组 hook；matcher 为空表示匹配全部。
interface LegacyHookMatcher {
  matcher?: string;
  hooks?: LegacyHookDefinition[];
}

// 顶层 hooks 以事件名为 key，值必须是数组，结构不合法时整体跳过。
export interface LegacyHooksConfig {
  hooks?: Partial<Record<string, LegacyHookMatcher[]>>;
  [key: string]: unknown;
}

// 类型守卫只认 command/process：其它字符串是旧版本残留或手写笔误，
// 放行会让下游按未知类型分支执行，行为不可预测。
function isHookType(value: unknown): value is Hook["type"] {
  return value === "command" || value === "process";
}

// 已知字段先解构出来的目的就是排除，剩下的才是 custom；直接把整个对象
// 塞进 custom 会让 type/command 在写回时出现两份来源。
function getCustomHookFields(hook: LegacyHookDefinition | WorkspaceHookDefinition) {
  const {
    type: _type,
    command: _command,
    args: _args,
    async: _async,
    enabled: _enabled,
    shell: _shell,
    statusMessage: _statusMessage,
    timeout: _timeout,
    timeoutMs: _timeoutMs,
    ...custom
  } = hook;
  return Object.keys(custom).length > 0 ? custom : undefined;
}

// INV-02：enabled 与 configuredEnabled 不同说明用户改过，写用户值；
// 相同说明这是声明级开关的结果，写回声明值以免把根开关固化成用户偏好。
function resolveWritableDeclarationEnabled(hook: Hook): boolean {
  const configured = hook.configuredState;
  if (!configured) return hook.enabled;
  return hook.enabled === configured.configuredEnabled
    ? configured.declarationEnabled
    : hook.enabled;
}

// 写回只产生 legacy 形状：command 用 timeout(秒) 与 shell/async，
// process 用 args 与 timeoutMs，两个分支不能共用同一个字段集。
function getWritableHook(hook: Hook): LegacyHookDefinition {
// 先铺 custom 再覆盖已知字段：低版本客户端写入的未知键得以保留，
// 已知字段永远是当前模型的值，不被旧数据反向污染。
  const common: LegacyHookDefinition = {
    ...hook.custom,
    type: hook.type,
    command: hook.command,
    enabled: resolveWritableDeclarationEnabled(hook),
    ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
  };
// command 与 process 的 legacy 字段名不同，分支早返回避免继续拼出
// 对方专属字段（例如 command 带 args 会被旧客户端误当参数）。
  if (hook.type === "command") {
    return {
      ...common,
      ...(hook.async ? { async: true } : {}),
      ...(hook.shell ? { shell: hook.shell } : {}),
      ...(hook.timeout ? { timeout: hook.timeout } : {}),
    };
  }
  return {
    ...common,
    ...(hook.args && hook.args.length > 0 ? { args: hook.args } : {}),
// process 的 legacy 字段是 timeoutMs，写回时换算，保持新旧客户端都能读。
    ...(hook.timeout ? { timeoutMs: hook.timeout * 1000 } : {}),
  };
}

// 按 sourceFileIndex/matcherIndex/hookIndex 三元组回查原始声明，
// 用于拿回 custom 字段与未规范化的 timeout；查不到说明快照与来源脱节。
function getRawHook(
  source: WorkspaceHookSourceInput,
  entry: CanonicalWorkspaceHookEntryData,
): WorkspaceHookDefinition {
  const hook = source.hooks.events?.[entry.event]?.[entry.matcherIndex]?.hooks[entry.hookIndex];
  if (!hook) throw new Error(`Workspace Hook provenance is incomplete for ${entry.reviewItemId}`);
  return hook;
}

// configuredState 是 UI 判断「能否写、写到哪」的唯一依据，必须逐项复制不合并。
function toConfiguredState(
  entry: CanonicalWorkspaceHookEntryData,
  sourcePath: string,
): HookConfiguredState {
  return {
    sourceRootEnabled: entry.sourceRootEnabled,
    declarationEnabled: entry.declarationEnabled,
    runtimeHooksEnabled: entry.runtimeHooksEnabled,
    configuredEnabled: entry.configuredEnabled,
    sourcePath,
  };
}

// 规范化条目加原始声明合成 UI 使用的 Hook；两者缺一不可——
// 条目负责类型与索引，raw 负责 custom 与原始超时。
function toHook(input: {
  entry: CanonicalWorkspaceHookEntryData;
  source: WorkspaceHookSourceInput;
  id: string;
  location: SettingsDirectoryLocation;
  workspaceHook?: Omit<
    WorkspaceHookDiscoveryState,
    keyof HookConfiguredState | "reviewItemId" | "sourceFileIndex"
  >;
}): Hook {
// 先取 raw 再组装：raw 缺失时立即抛错，不产出半成品 Hook。
  const raw = getRawHook(input.source, input.entry);
  const configuredState = toConfiguredState(input.entry, input.source.canonicalPath);
// workspaceHook 先铺配置态再覆盖调用方传入项，保证 sourcePath 等字段
// 不会被调用方遗漏；未传时整个字段不出现，而不是空对象。
  const workspaceHook = input.workspaceHook
    ? {
        ...configuredState,
        reviewItemId: input.entry.reviewItemId,
        sourceFileIndex: input.entry.sourceFileIndex,
        ...input.workspaceHook,
      }
    : undefined;
  return {
    id: input.id,
    event: input.entry.event,
// 空字符串 matcher 归一成 undefined，否则分组时会出现一个空 key 的匹配器。
    matcher: input.entry.matcher ?? undefined,
    type: input.entry.type,
    command: input.entry.command,
// process 复制数组而不是共享引用：调用方可能原地修改 Hook，
// 共享会让改动回写到 bundle 快照。
    ...(input.entry.type === "process" ? { args: [...(input.entry.args ?? [])] } : {}),
    ...(input.entry.type === "command" && input.entry.async !== undefined
      ? { async: input.entry.async }
      : {}),
    ...(input.entry.type === "command" && input.entry.shell !== undefined
      ? { shell: input.entry.shell }
      : {}),
    ...(input.entry.statusMessage ? { statusMessage: input.entry.statusMessage } : {}),
    timeout:
      (raw.type === "command" ? raw.timeout : undefined) ??
      (raw.timeoutMs !== undefined ? Math.round(raw.timeoutMs) / 1000 : undefined),
    enabled: input.entry.configuredEnabled,
    editable: input.entry.editable,
    configuredState,
    ...(workspaceHook ? { workspaceHook } : {}),
// custom 只保留未知字段：已知字段各有强类型位置，
// 若也留在 custom 里，写回会出现两份来源，谁覆盖谁取决于展开顺序。
    custom: getCustomHookFields(raw),
    location: input.location,
  };
}

// 从 bundle 快照还原项目级 Hook：快照缺失直接空数组，不能用磁盘再扫一遍，
// 否则会绕过快照生成时的规范化与信任判定。
export function fromProjectSnapshot(input: {
  sources: WorkspaceHookSourceInput[];
  snapshot: WorkspaceHookBundleSnapshotData | undefined;
  workspaceIdentity: string;
  workspacePath: string;
  persistentTrustedDigests?: ReadonlySet<string>;
}): Hook[] {
// 保留 undefined 语义：无快照代表该项目当前不可用，与「有快照但零 Hook」不同。
  const snapshot = input.snapshot;
  if (!snapshot) return [];
  return snapshot.hooks.map((entry) => {
    const source = input.sources[entry.sourceFileIndex];
// [失败路径] source 缺失说明快照引用了不存在的来源文件，属于内部一致性错误，
// 必须抛错；静默跳过会让被篡改的条目从列表中消失。
    if (!source) throw new Error(`Workspace Hook source is missing for ${entry.reviewItemId}`);
    return toHook({
      entry,
      source,
      id: entry.reviewItemId,
      location: {
        source: "zcode",
        scope: "project",
        directoryPath: dirname(source.canonicalPath),
        projectPath: input.workspacePath,
      },
      workspaceHook: {
        workspaceIdentity: input.workspaceIdentity,
        bundleDigest: snapshot.bundleDigest,
        hookDeclarationDigest: entry.hookDeclarationDigest,
// 信任按声明摘要判定：同一份声明在任意 workspace 信任过都算持久信任；
// 用 bundle 摘要会把无关改动算进去，导致已信任的 Hook 重新变灰。
        trustState: input.persistentTrustedDigests?.has(entry.hookDeclarationDigest)
          ? "trusted_persistent"
          : "pending_trust",
      },
    });
  });
}

// 用户级来源只有一份文件，但仍走与项目级相同的 resolveWorkspaceHookEntries，
// 保证事件匹配、matcher 归并、信任字段的规范完全一致。
export function fromUserZCodeSource(input: {
  source: WorkspaceHookSourceInput | undefined;
  runtimeRoot: WorkspaceHookRuntimeRoot;
  workspacePath: string;
  location: SettingsDirectoryLocation;
}): Hook[] {
// 用户级配置文件不存在是正常状态，返回空列表而不是错误。
  if (!input.source) return [];
// 解析细节交给共享实现，本文件只负责贴上位置与稳定 id；
// 自己再实现一遍会让用户级与项目级的行为逐渐分叉。
  return resolveWorkspaceHookEntries({
    workspacePath: input.workspacePath,
    sources: [input.source],
    runtimeRoot: input.runtimeRoot,
  }).map((entry, index) =>
    toHook({
      entry,
      source: input.source!,
// 用户级 hook 无 reviewItemId，用索引拼 id；顺序由解析器保证稳定。
      id: `hook-zcode-user-${index}`,
      location: input.location,
    }),
  );
}

// legacy 配置没有快照与信任信息，全部按不可编辑、未启用处理，
// 只用于展示迁移前的历史声明，不能直接执行。
export function fromLegacyHooksConfig(input: {
  legacyConfig: LegacyHooksConfig | null;
  location: SettingsDirectoryLocation;
  isHookEvent: (value: string) => value is HookEvent;
}): Hook[] {
// 逐层遍历 push，保持 JSON 中声明顺序，便于用户对照原始文件排查。
  const hooks: Hook[] = [];
// 自增序号跨事件、跨 matcher 连续，保证同一配置文件内 id 不重复。
  let idCounter = 0;
// Object.entries 会带上原型链之外的自身键；未知事件名在后面过滤，
// 这里不提前中断，避免一个坏键让整份配置失效。
  for (const [eventName, matchers] of Object.entries(input.legacyConfig?.hooks ?? {})) {
// INV-03：事件名必须命中白名单，matchers 必须是数组；手写 JSON 常见
// 把数组写成对象，这类结构错误只跳过该事件，不影响其它事件。
    if (!input.isHookEvent(eventName) || !Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
// [失败路径] type 不在枚举内或 command 为空时丢弃：没有命令的 Hook
// 执行时会立刻失败，且会在 UI 里显示为永远不可用的条目。
        if (!isHookType(hook.type) || !hook.command) continue;
        hooks.push({
          id: `hook-${input.location.source}-${input.location.scope}-${idCounter++}`,
          event: eventName,
          matcher: matcher.matcher,
          type: hook.type,
          command: hook.command,
// legacy 里 args 可能缺失，补空数组让调用方不必区分 undefined 与空。
          ...(hook.type === "process" ? { args: hook.args ?? [] } : {}),
// 只在显式给出时写 async，缺省即同步，不能写 false 覆盖声明。
          ...(hook.async !== undefined ? { async: hook.async } : {}),
// shell 省略即使用默认 shell；显式写 undefined 在 JSON 里会变成 null。
          ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
          ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
          timeout:
// 秒优先，缺省时把毫秒四舍五入回秒；单位混用会让超时差 1000 倍。
            hook.timeout ??
            (hook.timeoutMs !== undefined ? Math.round(hook.timeoutMs / 1000) : undefined),
// 迁移来的 legacy Hook 一律视为未启用：它们没有经过信任流程，
// 直接启用等于绕过项目 Hook 的信任确认。
          enabled: false,
          editable: false,
          location: input.location,
        });
      }
    }
  }
// 返回原始声明顺序的数组，id 已按同一顺序生成，二者保持一一对应。
  return hooks;
}

// 写回时按 (event, matcher) 归并：同一 matcher 下的多个 Hook 必须落进
// 同一个 matcher 对象，否则重新读取会被当成多个匹配器，重复执行。
export function toZCodeHooksEvents(hooks: Hook[]): WorkspaceHooksConfig["events"] {
// 只创建实际用到的 event 键，避免在配置里留下空的 hooks 事件表。
  const events: WorkspaceHooksConfig["events"] = {};
  for (const hook of hooks) {
// 每个事件维护一个 matcher 数组，首次出现时才登记回 events。
    const eventMatchers = events[hook.event] ?? [];
// matcher 是唯一分组键：undefined 与 undefined 相等，所以无 matcher 的
// Hook 会归并到一起，这正是旧格式的语义。
    let matcher = eventMatchers.find((item) => item.matcher === hook.matcher);
// 新建 matcher 时才写 matcher 字段：空 matcher 不能写成空字符串，
// 否则重新解析会得到两个不同的分组键。
    if (!matcher) {
      matcher = {
        ...(hook.matcher ? { matcher: hook.matcher } : {}),
        hooks: [],
      };
      eventMatchers.push(matcher);
      events[hook.event] = eventMatchers;
    }
// push 前经过 getWritableHook 转换：只写回 legacy 认识的字段，
// 把 configuredState 等运行期字段漏进配置文件会污染用户文件。
    matcher.hooks.push(getWritableHook(hook) as WorkspaceHookDefinition);
  }
  return events;
}

// 根开关的写回值：只要有 Hook 的启用状态偏离声明值，说明用户主动改过，
// 根开关必须为开，否则保存后这些用户选择会被根开关整体压掉。
export function resolveNextRootEnabled(
  existingEnabled: boolean | undefined,
  hooks: Hook[],
): boolean | undefined {
  if (
    hooks.some(
      (hook) =>
        hook.enabled &&
        (!hook.configuredState || hook.enabled !== hook.configuredState.configuredEnabled),
    )
  ) {
    return true;
  }
// 没有任何偏离时保持原值，包括 undefined；
// 写 false 会把「从未设置」变成「用户显式关闭」。
  return existingEnabled;
}
