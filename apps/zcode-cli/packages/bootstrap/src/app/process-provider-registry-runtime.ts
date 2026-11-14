// INV-01 路径缺失立即抛错：守住位置 空值判断；改错故障 猜默认目录读到别人的库。
// INV-02 装配顺序即契约：守住位置 调用顺序；改错故障 先建选择仓库再建注册表。
// INV-03 凭据仓库只在独立进程创建：守住位置 独立态判断；改错故障 Host 进程多建一份凭据。
// INV-04 快照解析回调本轮捕获：守住位置 闭包入参；改错故障 异步读到另一份文件。
// INV-05 观测回调异常不外泄：守住位置 捕获分支；改错故障 账号观测错误改变账号事实。
// INV-06 账号恢复按代际比较：守住位置 两版本比较；改错故障 每次检查都强制刷新账号。
// INV-07 凭据变更串行发布：守住位置 顺序等待；改错故障 标题与账号各自发布产生裂口。
// INV-08 失败按后建先关释放：守住位置 逆序语句；改错故障 失败后残留订阅与监听。
// INV-09 成功对象冻结：守住位置 冻结调用；改错故障 调用方改写启动结果。
// INV-10 Host 不能覆盖独立账号：守住位置 独立态判断；改错故障 两侧同时写账号快照。
// INV-11 接收确认不等于应用确认：守住位置 返回值语义；改错故障 未生效也被当作已同步。
// INV-12 释放顺序固定：守住位置 语句顺序；改错故障 先关注册表再撤订阅导致回调落空。
// INV-13 内层失败只释放内层资源：守住位置 捕获分支；改错故障 账号服务被提前销毁。
// INV-14 外层失败释放全部资源：守住位置 逆序语句；改错故障 部分资源泄漏到进程退出。
// INV-15 两个版本都必须非空：守住位置 去空判断；改错故障 空版本写入账号覆盖层。
// INV-16 账号信封整体校验：守住位置 映射解析；改错故障 部分信封落库。
// INV-17 托管账号必须有当前标记：守住位置 类型判断；改错故障 投影不知道当前账号。
// INV-18 状态与覆盖层同快照保留：守住位置 条件展开；改错故障 只更新版本丢了连接事实。
//
// 模块职责：装配进程级 Provider Registry 的三层事实源与可选独立态能力。
// 状态所有权：注册表、账号服务与凭据订阅都归本函数所有，随返回对象释放。
// 阅读顺序：先看选项接口，再看装配主体，最后看信封解析。
import {
  AccountProviderService,
  MutableAccountProviderConfigSource,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
} from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_VERSION,
} from "@zcode/shared";
import { dirname, join } from "node:path";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  downloadZCodeBuiltinRelease,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";
import {
  createStandaloneProviderRuntimeHeadersPort,
  readStandaloneAccountProviderConfigSnapshot,
} from "./standalone-account-provider-runtime.js";

/**
 * 进程级 Provider Registry 的可选装配面；全部字段只在 standalone（Prompt CLI / TUI）出现。
 *
 * standalone 意味着本进程自己拥有账号凭据与旧 CLI 配置的一次性导入，Host 不能覆盖：
 * 因此它会建 credential store、AccountProviderService、legacy import 与凭据变更订阅；
 * 非 standalone 时这些全部缺席，账号快照只能由 Host 经 `syncAccountProviderConfig` 推入。
 */
// 可选面只在独立进程出现。
// Host 进程不提供账号与旧配置导入。
// 字段全部只读。
export interface ProcessProviderRegistryRuntimeOptions {
  /** Standalone Prompt CLI / TUI 自己拥有账号凭据与旧配置的一次性导入。 */
  readonly standalone?: {
    readonly credentialStore?: SharedZCodeCredentialStore;
    readonly legacyCliUserConfigFilePath?: string;
    readonly onAccountInitializationError?: (error: unknown) => void;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

/**
 * 启动进程级 Provider Registry（Built-in 配置 → Personal 配置 → Account Overlay 三层事实源）。
 *
 * 顺序在这里是契约：先解析运行时路径（缺失即抛，不猜默认目录）→ 建 account source / credential
 * store / legacy 导入回调 → 构造并 `start()` NodeProviderRegistryRuntime → 取启动快照 → 建
 * ModelSelectionConfigRepository 并读配置默认（“保存意图”，未绑定）。
 * standalone 才装配 AccountProviderService、凭据变更订阅与 Built-in 恢复检查；非 standalone
 * 拒绝 Host 以外的账号写入。
 * 失败语义：任何一步抛错都按“后建先关”逆序释放（订阅 → headers → 账号 → selection repo →
 * runtime），最后原样抛出；成功返回冻结对象，其 dispose 也按同一逆序。
 */
// resolveNodeProviderRuntimePaths(env) 返回空时直接抛错，不猜默认目录。
// 装配顺序固定为 accountSource 到 credentialStore 再到 runtime.start()。
// 成功时用 Object.freeze 包装返回值，调用方不能就地改写。
// 失败按后建先关逆序释放，最后把原错误抛出。
export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) {
    throw new Error("缺少进程 Provider Registry 的 ZCode Built-in / Personal Config 路径");
  }

  const accountSource = new MutableAccountProviderConfigSource();
  const credentialStore = options.standalone
    ? (options.standalone.credentialStore ?? createSharedZCodeCredentialStore({ env: { ...env } }))
    : undefined;
  let standaloneAccount: AccountProviderService | undefined;
  const bundledFile = options.standalone
    ? env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim()
    : undefined;
  // bundledFile 只在 options.standalone 存在时读 ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV。
  // credentialStore 同样按 standalone 判定，未启用时不创建共享凭据存储。
  // legacy 配置导入挂在 standalone 分支，非独立态不触碰旧配置。
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile
      ? {
          zcodeBuiltinFilePath: bundledFile,
          zcodeBuiltinActiveFilePath: paths.zcodeBuiltinFilePath,
          zcodeBuiltinRemote: {
            controlFilePath: join(
              dirname(paths.zcodeBuiltinFilePath),
              "zcode-builtin-refresh.json",
            ),
            resolveEndpointKey: () => resolveRuntimeZCodeEndpointOrigin(env),
            fetchRelease: (endpointOrigin, signal) =>
              downloadZCodeBuiltinRelease({
                endpointOrigin,
                signal,
                appVersion: ZCODE_VERSION,
                platform: resolveZCodeBuiltinClientPlatform(),
                request: options.standalone?.request ?? globalThis.fetch,
              }),
            onRefreshResult: options.standalone?.onBuiltinRefreshResult,
          },
        }
      : {}),
    onZCodeBuiltinRefreshError: options.standalone?.onBuiltinRefreshError,
    accountSource,
    ...(credentialStore
      ? {
          createAccountSource(configService) {
            standaloneAccount = new AccountProviderService({
              configSource: configService,
              async resolve({ configRevision, configuredProviders }) {
                // 使用本轮捕获的 Built-in，而不是异步读另一份文件后仅贴上新 revision。
                const snapshot = await readStandaloneAccountProviderConfigSnapshot(
                  credentialStore,
                  env,
                  {
                    revision: configRevision,
                    providers: configuredProviders,
                  },
                );
                return {
                  providers: snapshot.providers,
                  states: snapshot.states ?? {},
                };
              },
            });
            standaloneAccount.onDidRefreshError(({ error }) => {
              try {
                options.standalone?.onAccountInitializationError?.(error);
              } catch {
                /* 观测回调不能改变账号事实。 */
              }
            });
            return standaloneAccount;
          },
        }
      : {}),
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              ...(options.standalone?.legacyCliUserConfigFilePath
                ? { filePath: options.standalone.legacyCliUserConfigFilePath }
                : {}),
            }),
        }
      : {}),
  });
  const disposeRecovery = standaloneAccount
    ? runtime.onDidCheckZCodeBuiltin(async () => {
        const [config, account] = await Promise.all([
          runtime.configService.read(),
          standaloneAccount!.read(),
        ]);
        if (config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision)
          await standaloneAccount!.refresh("builtin-account-recovery");
      })
    : undefined;
  // 复用 AccountService 的串行、过期结果丢弃机制，凭据变化与 Built-in 变化不能各自发布。
  const standaloneHeaders = credentialStore
    ? createStandaloneProviderRuntimeHeadersPort(credentialStore, env)
    : undefined;
  const disposeCredentialSubscription = credentialStore?.onDidChange?.(async () => {
    await standaloneHeaders?.invalidateChangedCredentials();
    await standaloneAccount!.refresh("standalone-credentials-changed");
    await runtime.registryService.refresh("standalone-credentials-barrier");
  });
  try {
    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;
    const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
      personalRepository: runtime.personalRepository,
    });
    try {
      const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
      return Object.freeze({
        accountSource: standaloneAccount ?? accountSource,
        async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
          if (standaloneAccount)
            throw new Error("Standalone Account 由本进程管理，不接收 Host 覆盖");
          const changed = accountSource.replace(next, "host-account-config");
          // Source 去重只证明收过，不证明上次刷新成功。重交时仍刷新；配套配置未到
          // 则由 Registry 保留完整旧快照，不能把接收确认冒充应用确认。
          await runtime.registryService.refresh("host-account-config");
          return changed;
        },
        dispose() {
          disposeCredentialSubscription?.();
          standaloneHeaders?.clearProjectTokens();
          disposeRecovery?.();
          standaloneAccount?.dispose();
          modelSelectionConfigRepository.dispose();
          runtime.dispose();
        },
        ...(credentialStore
          ? {
              providerRuntimeHeadersPort: standaloneHeaders!,
            }
          : {}),
        runtime,
        snapshot,
        modelSelectionConfigRepository,
        configuredDefaultModelSelection,
      });
    } catch (error) {
      disposeCredentialSubscription?.();
      modelSelectionConfigRepository.dispose();
      throw error;
    }
  } catch (error) {
    disposeCredentialSubscription?.();
    disposeRecovery?.();
    standaloneAccount?.dispose();
    runtime.dispose();
    throw error;
  }
}

/** 把协议信封解析为进程 Registry 使用的第三层 Account Config Overlay。 */
/**
 * 输入：revision 与 basedOnZCodeBuiltinRevision 必须非空（trim 后），providers 走 Registry 的
 * 运行时 schema 校验；states 与 Overlay 属于同一快照，原样保留，绝不只更新 revision 而丢连接事实。
 * 额外约束：托管的内置账号（zhipu-account 且 entitled）必须带 `current` 布尔，否则拒绝整个信封——
 * 缺它会让 projection 无法判断“当前在哪台/哪个账号上”。
 * 失败语义：结构或约束不满足直接抛，调用方不应把部分信封落库。
 */
// revision 与 basedOnZCodeBuiltinRevision 先各自 trim，空串直接抛错。
// providers 交给 Registry 的运行时 schema 整体校验，不部分落库。
// states 与 Overlay 视为同一快照返回，不允许只更新 revision 丢连接事实。
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision 不能为空");
  const basedOnZCodeBuiltinRevision = input.basedOnZCodeBuiltinRevision.trim();
  if (!basedOnZCodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision 不能为空");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // 仅约束托管 Worker 的普通账号信封；独立 CLI、API 和闲时不需要 current。
    if (
      isBuiltinModelProviderId(providerId) &&
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State 缺少 current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnZCodeBuiltinRevision,
    providers,
    // 与 Overlay 属于同一快照；不能只更新 revision 却丢掉当前连接事实。
    ...(input.states ? { states: input.states } : {}),
  });
}
