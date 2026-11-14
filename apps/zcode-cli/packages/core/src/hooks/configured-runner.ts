/**
 * ============================================================================
 * hooks/configured-runner.ts —— 把"配置 hook + 工作区 hook"装配成执行器
 * ============================================================================
 *
 * 两种来源:
 *   configured  来自用户/插件配置(config.enabled 控制);
 *   workspace   来自项目内 hook 声明(快照 + admission 端口),永远尝试装配,
 *               是否真的执行由 dispatch 时的 WorkspaceHookRuntimeAdmission 决定。
 *
 * 【顺序】insertWorkspaceHooks 把项目 hook 插到每类事件首个"非 user 来源"之前:
 * 项目策略应先于用户/内置 hook 生效,这样它才有机会拦截后续 hook 的副作用。
 *
 * 【标识】source 字符串形如 `config.<event>.<matcher>.<hook>` / `project.<reviewItemId>`,
 * 作为日志、telemetry 与 UI 的稳定归因键;plugin hook 额外带 plugin.id。
 * ============================================================================
 */
import {
  HookEventName,
  type CanonicalWorkspaceHookEntry,
  type HookConfig,
  type HookSourceKind,
  type HookMatcherConfig,
} from "@zcode/contracts";
import { resolveWorkspaceHookMaxOutputBytes } from "@zcode/shared/workspace-hook-discovery";
import { expandPluginVariables, resolveHookTimeoutMs } from "./configured-runner-input.js";
import { createHookExecutionDescriptor } from "./display-metadata.js";
import { InMemoryHookRunner } from "./runner.js";
import { createConfiguredHookCallback } from "./configured-runner-callback.js";
import type { ConfiguredHookRunnerOptions, HookRegistration, HookRunner } from "./types.js";

export function createConfiguredHookRunner(
  options: ConfiguredHookRunnerOptions,
): HookRunner | undefined {
  // config.enabled=false 只关闭"配置来源"的 hook;项目 hook 仍需装配,
  // 因为它们在 dispatch 时还有一层独立的信任/策略门。
  const configuredHooks = options.config.enabled ? createConfiguredHookRegistrations(options) : [];
  const workspaceHooks = createWorkspaceHookRegistrations(options);
  const hooks = insertWorkspaceHooks(configuredHooks, workspaceHooks);
  // 一条都没有就不创建 runner:让调用方拿到 undefined 走"无 hooks"的快速路径,
  // 而不是每次事件都进一个空执行的 runner。
  if (hooks.length === 0) return undefined;
  return new InMemoryHookRunner({
    defaultTimeoutMs: options.config.timeoutMs,
    emitEvent: options.emitEvent,
    hooks,
    logger: options.logger,
  });
}

function createConfiguredHookRegistrations(
  options: ConfiguredHookRunnerOptions,
): HookRegistration[] {
  const registrations: HookRegistration[] = [];

  for (const [eventName, matcherConfigs] of Object.entries(options.config.events)) {
    const event = eventName as HookEventName;
    for (const [matcherIndex, matcherConfig] of (matcherConfigs ?? []).entries()) {
      registrations.push(
        ...createHookRegistrationsForMatcher(options, event, matcherConfig, matcherIndex),
      );
    }
  }

  return registrations;
}

function createHookRegistrationsForMatcher(
  options: ConfiguredHookRunnerOptions,
  event: HookEventName,
  matcherConfig: HookMatcherConfig,
  matcherIndex: number,
): HookRegistration[] {
  return matcherConfig.hooks.flatMap((hook, hookIndex) => {
    if (hook.enabled === false) return [];
    return [
      createHookRegistration({
        event,
        hook,
        hookIndex,
        matcher: matcherConfig.matcher,
        matcherIndex,
        maxOutputBytes: resolveWorkspaceHookMaxOutputBytes(options.config.maxOutputBytes),
        options,
        source: hook.plugin
          ? `plugin.${hook.plugin.id}.${event}.${matcherIndex}.${hookIndex}`
          : `config.${event}.${matcherIndex}.${hookIndex}`,
        sourceKind: hook.plugin ? "plugin" : (hook.source?.kind ?? "internal"),
        timeoutMs: resolveHookTimeoutMs(hook, options.config.timeoutMs),
      }),
    ];
  });
}

function createWorkspaceHookRegistrations(
  options: ConfiguredHookRunnerOptions,
): HookRegistration[] {
  const { workspaceHookAdmission: admission, workspaceHookSnapshot: snapshot } = options;
  // 快照或授权端口缺席时直接不装配:没有信任门就不能执行项目 hook。
  if (!admission || !snapshot) return [];
  return snapshot.hooks.flatMap((entry) => {
    const hook = workspaceEntryToHookConfig(snapshot, entry);
    return [
      createHookRegistration({
        // admission 是**闭包**,在每次 dispatch 时按 digest + reviewItemId 重新求值:
        // 信任记录/策略可能在前序 hook 执行期间变化,不能装配时就固定 allowed。
        admission: () =>
          admission.evaluateDispatch({
            hookDeclarationDigest: entry.hookDeclarationDigest,
            reviewItemId: entry.reviewItemId,
          }),
        event: entry.event,
        hook,
        hookIndex: entry.hookIndex,
        matcher: entry.matcher ?? undefined,
        matcherIndex: entry.matcherIndex,
        maxOutputBytes: entry.resolvedMaxOutputBytes,
        options,
        source: `project.${entry.reviewItemId}`,
        sourceKind: "project",
        timeoutMs: entry.resolvedTimeoutMs,
      }),
    ];
  });
}

function workspaceEntryToHookConfig(
  snapshot: NonNullable<ConfiguredHookRunnerOptions["workspaceHookSnapshot"]>,
  entry: CanonicalWorkspaceHookEntry,
): HookConfig {
  const sourcePath = snapshot.sourceFiles[entry.sourceFileIndex]?.canonicalPath;
  const common = {
    command: entry.command,
    source: { kind: "project" as const, ...(sourcePath ? { path: sourcePath } : {}) },
    ...(entry.statusMessage ? { statusMessage: entry.statusMessage } : {}),
    timeoutMs: entry.resolvedTimeoutMs,
  };
  return entry.type === "command"
    ? {
        ...common,
        type: "command",
        ...(entry.async === undefined ? {} : { async: entry.async }),
        ...(entry.shell === undefined ? {} : { shell: entry.shell }),
      }
    : {
        ...common,
        type: "process",
        ...(entry.args ? { args: [...entry.args] } : {}),
      };
}

function createHookRegistration(input: {
  admission?: HookRegistration["admission"];
  event: HookEventName;
  hook: HookConfig;
  hookIndex: number;
  matcher?: string;
  matcherIndex: number;
  maxOutputBytes: number;
  options: ConfiguredHookRunnerOptions;
  source: string;
  sourceKind: HookSourceKind;
  timeoutMs: number;
}): HookRegistration {
  return {
    ...(input.admission ? { admission: input.admission } : {}),
    // async 只对 command 类型有效:process 类型没有独立的进程生命周期,
    // 语义上必须同步等待结果。
    async: input.hook.type === "command" && input.hook.async === true,
    callback: createConfiguredHookCallback(
      input.options,
      input.event,
      input.hook,
      input.matcherIndex,
      input.hookIndex,
      { maxOutputBytes: input.maxOutputBytes, timeoutMs: input.timeoutMs },
    ),
    descriptor: (hookInput) =>
      createHookExecutionDescriptor(input.hook, input.timeoutMs, (value) => {
        try {
          return expandPluginVariables(
            value,
            input.hook.plugin,
            hookInput,
            input.options.getWorkingDirectory(),
          );
        } catch {
          // Display metadata must never introduce a new execution failure.
          // (展示字段展开失败只影响文案,不能让 hook 本身失败。)
          return value;
        }
      }),
    event: input.event,
    matcher: input.matcher,
    source: input.source,
    sourceKind: input.sourceKind,
    timeoutMs: input.timeoutMs,
  };
}

function insertWorkspaceHooks(
  configured: HookRegistration[],
  workspace: HookRegistration[],
): HookRegistration[] {
  const result = [...configured];
  // 按事件分别插入,而不是整体前置:项目 hook 只应影响它声明的事件;
  // 插到该事件第一个非 user hook 之前,保证项目策略先于用户/内置 hook 执行。
  for (const event of new Set(workspace.map((registration) => registration.event))) {
    const eventWorkspace = workspace.filter((registration) => registration.event === event);
    const firstNonUserIndex = result.findIndex(
      (registration) => registration.event === event && registration.sourceKind !== "user",
    );
    if (firstNonUserIndex < 0) {
      result.push(...eventWorkspace);
    } else {
      result.splice(firstNonUserIndex, 0, ...eventWorkspace);
    }
  }
  return result;
}
