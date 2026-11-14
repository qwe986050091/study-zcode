// Workspace Hook 信任的 CLI 侧操作：查看、授权、撤销。
//
// 信任绑定是「workspaceIdentity + hookDeclarationDigest」，不是文件路径或命令文本：
// 内容任何变化都会换 digest，需要重新授权。所有操作都以磁盘快照为唯一事实源，
// 不使用运行时缓存；store 损坏时一律 fail closed（inspect 报 corrupt，grant 直接抛），
// 避免把「损坏被当成空记录」的恢复副作用伪装成一次成功授权。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDefaultFileWorkspaceHookTrustStore } from "@zcode/adapters/storage";
import { getDefaultConfigPath } from "@zcode/adapters/config";
import {
  DefaultRuntimeConfig,
  createWorkspaceHookBundleSnapshot,
  type WorkspaceHookBundleSnapshot,
  type WorkspaceHookTrustRecord,
} from "@zcode/contracts";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";

export interface WorkspaceHookTrustCliTarget {
  /** workspace 根；会 resolve 成绝对路径参与身份与发现。 */
  workspacePath: string;
  /** 工具给出的 workspace 身份；缺省用 resolve 后的 workspacePath（同路径即同身份）。 */
  workspaceIdentity?: string;
  /** 用户配置路径；缺省 getDefaultConfigPath()。 */
  userConfigPath?: string;
}

export interface WorkspaceHookTrustCliItem {
  /** 稳定条目 id，grant/revoke 与 UI 定位都用它。 */
  reviewItemId: string;
  event: string;
  matcher: string | null;
  /** 展示命令（process 类型会拼上 args，便于用户核对将要执行什么）。 */
  displayCommand: string;
  /** 相对 workspace 的源文件路径，不泄漏绝对路径。 */
  sourcePath: string;
  /** 配置里是否启用；未启用的条目仍展示，但不影响整体 reasonCode。 */
  configuredEnabled: boolean;
  /** 声明内容摘要；信任记录按此绑定，内容变化即失效。 */
  hookDeclarationDigest: string;
  trustState: "trusted_persistent" | "pending_trust";
}

export interface WorkspaceHookTrustCliStatus {
  workspacePath: string;
  workspaceIdentity: string;
  /** 当前声明集合的摘要；null 表示没有可发现的 workspace hooks。 */
  bundleDigest: string | null;
  /** 单一结论码：feature 关闭/不适用/无启用 hook/pending/trusted/corrupt。 */
  reasonCode:
    | "workspace_hooks_not_applicable"
    | "workspace_hooks_no_enabled_hooks"
    | "workspace_hooks_pending_trust"
    | "workspace_hooks_trusted_persistent"
    | "workspace_hooks_feature_disabled"
    | "workspace_hooks_require_trust_capable_host"
    // status 必须与 grant/revoke 的失败语义一致——损坏 store 若伪装成
    // pending_trust，用户按提示 grant 只会撞上 trust_store_corrupt，恢复指引矛盾。
    | "workspace_hooks_trust_store_corrupt";
  items: WorkspaceHookTrustCliItem[];
}

/**
 * 查看当前信任状态（只读）。
 *
 * 顺序：规范化目标 → 发现快照 → 读取 trust store。store 损坏优先于一切：此时
 * snapshot 里的 hook 全部按 pending_trust 展示（但含 reviewItemId 等字段，UI 仍可列出），
 * 并给 workspace_hooks_trust_store_corrupt，提示先修复/删除 *.corrupt-<ts>。
 * 正常时按 identity 过滤记录，再以 digest 命中 trusted_persistent；
 * 整体结论只看 configuredEnabled 的条目（未启用条目不影响 pending/trusted）。
 */
export async function inspectWorkspaceHookTrust(
  input: WorkspaceHookTrustCliTarget,
): Promise<WorkspaceHookTrustCliStatus> {
  const target = normalizeTarget(input);
  const snapshot = await discoverSnapshot(target);
  const store = await createDefaultFileWorkspaceHookTrustStore({
    userConfigPath: target.userConfigPath,
  });
  const loaded = await store.load();
  // 损坏 store 优先于任何信任计算——所有记录不可信（adapters load 已
  // fail-closed 返回空 records），显式报 corrupt 让用户先修复/移除损坏文件，
  // 不再给出"grant 即可"的错误指引。恢复：adapters load 已把损坏文件改名为
  // *.corrupt-<ts>，确认无需保留后删除该文件或从备份恢复即可重建。
  if (loaded.status === "corrupt") {
    const corruptItems = (snapshot?.hooks ?? []).map((entry) => ({
      reviewItemId: entry.reviewItemId,
      event: entry.event,
      matcher: entry.matcher,
      displayCommand: formatCommand(entry),
      sourcePath: entry.sourceRelativePath,
      configuredEnabled: entry.configuredEnabled,
      hookDeclarationDigest: entry.hookDeclarationDigest,
      trustState: "pending_trust" as const,
    }));
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      bundleDigest: snapshot?.bundleDigest ?? null,
      reasonCode: "workspace_hooks_trust_store_corrupt",
      items: corruptItems,
    };
  }
  const trusted = new Set(
    loaded.records
      .filter((record) => record.workspaceIdentity === target.workspaceIdentity)
      .map((record) => record.hookDeclarationDigest),
  );
  if (!snapshot) {
    return {
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      bundleDigest: null,
      reasonCode: "workspace_hooks_not_applicable",
      items: [],
    };
  }
  const items = snapshot.hooks.map((entry) => ({
    reviewItemId: entry.reviewItemId,
    event: entry.event,
    matcher: entry.matcher,
    displayCommand: formatCommand(entry),
    sourcePath: entry.sourceRelativePath,
    configuredEnabled: entry.configuredEnabled,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    trustState: trusted.has(entry.hookDeclarationDigest)
      ? ("trusted_persistent" as const)
      : ("pending_trust" as const),
  }));
  const enabled = items.filter((item) => item.configuredEnabled);
  const reasonCode =
    enabled.length === 0
      ? "workspace_hooks_no_enabled_hooks"
      : enabled.every((item) => item.trustState === "trusted_persistent")
        ? "workspace_hooks_trusted_persistent"
        : "workspace_hooks_pending_trust";
  return {
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    bundleDigest: snapshot.bundleDigest,
    reasonCode,
    items,
  };
}

/**
 * 授权信任并返回最新状态。
 *
 * - 必须先有快照（没有声明直接抛），授权对象来自当前磁盘声明，不能凭空造 digest；
 * - 选择规则见 selectGrantEntries：显式 digest 或 --all-current（后者必须带 bundleDigest）；
 * - 每条记录把当时的 bundle/event/command/source/matcher 位置一起冻结，便于审计与后续排查；
 * - 写入前再读一次 store：corrupt 时抛错而不是触发「空记录覆盖」的恢复副作用；
 * - 成功后重新 inspect，保证返回值与磁盘事实一致。
 */
export async function grantWorkspaceHookTrust(
  input: WorkspaceHookTrustCliTarget & {
    hookDeclarationDigests?: readonly string[];
    allCurrent?: boolean;
    bundleDigest?: string;
    appVersion?: string;
  },
): Promise<WorkspaceHookTrustCliStatus> {
  const target = normalizeTarget(input);
  const snapshot = await requireSnapshot(target);
  const selected = selectGrantEntries(snapshot, input);
  const grantedAt = new Date().toISOString();
  const records: WorkspaceHookTrustRecord[] = selected.map((entry) => ({
    workspaceIdentity: snapshot.workspaceIdentity,
    hookDeclarationDigest: entry.hookDeclarationDigest,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt,
    bundleDigestAtGrant: snapshot.bundleDigest,
    eventAtGrant: entry.event,
    displayCommandAtGrant: formatCommand(entry),
    sourcePathAtGrant: entry.sourceRelativePath,
    sourceDiscoveryOrderAtGrant: snapshot.sourceFiles[entry.sourceFileIndex]?.discoveryOrder,
    matcherAtGrant: entry.matcher,
    matcherIndexAtGrant: entry.matcherIndex,
    hookIndexAtGrant: entry.hookIndex,
    ...(input.appVersion ? { appVersionAtGrant: input.appVersion } : {}),
  }));
  const store = await createDefaultFileWorkspaceHookTrustStore({
    userConfigPath: target.userConfigPath,
  });
  // workspace 级 Settings 预信任没有 session controller 帮忙拦截损坏存储；
  // 若直接 grant，store 的恢复逻辑会把 corrupt 当空记录并立即覆盖。首次显式授权必须
  // fail closed，让用户先看到损坏状态，不能把恢复副作用伪装成一次成功授权。
  const loaded = await store.load();
  if (loaded.status === "corrupt") {
    throw new Error("workspace_hooks_trust_store_corrupt");
  }
  await store.grant(records);
  return inspectWorkspaceHookTrust(target);
}

/**
 * 撤销信任：--all 与 --hook-digest 必须且只能选一个（两者都空/都给都算参数错误）。
 * 按 workspaceIdentity 撤销；不要求当前快照存在（允许先撤销再清理声明）。
 */
export async function revokeWorkspaceHookTrustCli(
  input: WorkspaceHookTrustCliTarget & {
    hookDeclarationDigests?: readonly string[];
    all?: boolean;
  },
): Promise<WorkspaceHookTrustCliStatus> {
  const target = normalizeTarget(input);
  const digests = unique(input.hookDeclarationDigests ?? []);
  if ((input.all === true) === digests.length > 0) {
    throw new Error("Specify exactly one of --all or --hook-digest.");
  }
  const store = await createDefaultFileWorkspaceHookTrustStore({
    userConfigPath: target.userConfigPath,
  });
  await store.revoke({
    workspaceIdentity: target.workspaceIdentity,
    ...(input.all ? {} : { hookDeclarationDigests: digests }),
  });
  return inspectWorkspaceHookTrust(target);
}

// 发现磁盘快照：读 workspace 声明（任何读取错误都抛首条路径，不能拿残缺集合做信任判定），
// 再合并 DefaultRuntimeConfig/user config/project 三层的 hooks 求 runtime root，
// 最后构造带 bundleDigest 的不可变快照；无声明时返回 undefined（不是空快照）。
async function discoverSnapshot(
  target: Required<Pick<WorkspaceHookTrustCliTarget, "workspacePath">> &
    WorkspaceHookTrustCliTarget & {
      workspaceIdentity: string;
    },
): Promise<WorkspaceHookBundleSnapshot | undefined> {
  const discovery = await readWorkspaceHookProjectSources({
    workingDirectory: target.workspacePath,
  });
  if (discovery.errors.length > 0) {
    throw new Error(`Unable to read Workspace Hook config: ${discovery.errors[0]?.path}`);
  }
  const userHooks = await readUserHooks(target.userConfigPath ?? getDefaultConfigPath());
  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([
    DefaultRuntimeConfig.hooks,
    userHooks,
    ...discovery.sources.map((source) => source.hooks),
  ]);
  const data = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity: target.workspaceIdentity,
    workspacePath: target.workspacePath,
    sources: discovery.sources,
    runtimeRoot,
  });
  return data ? createWorkspaceHookBundleSnapshot(data) : undefined;
}

// grant 必须有快照：没有声明时授权什么对象都不成立，直接报错而不是静默成功。
async function requireSnapshot(
  target: ReturnType<typeof normalizeTarget>,
): Promise<WorkspaceHookBundleSnapshot> {
  const snapshot = await discoverSnapshot(target);
  if (!snapshot) throw new Error("No Workspace Hook declarations were discovered.");
  return snapshot;
}

// 授权选择与一致性校验：
// - --all-current 与 --hook-digest 互斥且必须选一个；
// - --all-current 必须带 bundleDigest，且与当前快照一致（防止用户确认旧界面后内容已变）；
// - 显式 digest 必须全部能在快照中找到（数量不等即 snapshot_mismatch），不允许部分命中。
function selectGrantEntries(
  snapshot: WorkspaceHookBundleSnapshot,
  input: {
    hookDeclarationDigests?: readonly string[];
    allCurrent?: boolean;
    bundleDigest?: string;
  },
) {
  const digests = unique(input.hookDeclarationDigests ?? []);
  if ((input.allCurrent === true) === digests.length > 0) {
    throw new Error("Specify exactly one of --all-current or --hook-digest.");
  }
  if (input.bundleDigest && input.bundleDigest !== snapshot.bundleDigest) {
    throw new Error("workspace_hooks_bundle_changed");
  }
  if (input.allCurrent) {
    if (!input.bundleDigest) {
      throw new Error("workspace_hooks_bundle_changed");
    }
    return snapshot.hooks.filter((entry) => entry.configuredEnabled);
  }
  if (digests.length === 0) throw new Error("At least one --hook-digest is required.");
  const selected = snapshot.hooks.filter((entry) => digests.includes(entry.hookDeclarationDigest));
  if (new Set(selected.map((entry) => entry.hookDeclarationDigest)).size !== digests.length) {
    throw new Error("workspace_hooks_snapshot_mismatch");
  }
  return selected;
}

// 读取用户配置里的 hooks 段：文件不存在视为「无用户 hooks」，其余解析/schema 错误上抛，
// 避免把损坏的用户配置静默当成空配置（那会改变 runtime root 与信任判定）。
async function readUserHooks(path: string): Promise<WorkspaceHooksConfig | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value) || value.hooks === undefined) return undefined;
    return workspaceHooksConfigSchema.parse(value.hooks);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

// 身份口径：显式 identity 去空后使用，否则用 resolve 后的 workspacePath；
// 同一路径不同写法（相对/绝对）会归一到同一身份，避免信任记录漂移。
function normalizeTarget(input: WorkspaceHookTrustCliTarget) {
  const workspacePath = resolve(input.workspacePath);
  return {
    workspacePath,
    workspaceIdentity: input.workspaceIdentity?.trim() || workspacePath,
    ...(input.userConfigPath ? { userConfigPath: input.userConfigPath } : {}),
  };
}

// process 类型把 args 拼进展示命令（仅展示，不参与 digest）；其余类型只有 command。
function formatCommand(entry: WorkspaceHookBundleSnapshot["hooks"][number]): string {
  return entry.type === "process" && entry.args?.length
    ? [entry.command, ...entry.args].join(" ")
    : entry.command;
}

// 去重后的 digest 列表：重复输入不应被当成多个授权对象（数量校验会因此误报）。
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
