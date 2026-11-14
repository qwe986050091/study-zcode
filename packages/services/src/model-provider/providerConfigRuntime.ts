import { join } from "node:path";
import {
  NodeProviderConfigRuntime,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  type PersonalProviderConfigRecoveryEvent,
  type NodeProviderConfigRuntimeOptions,
} from "@zcode/provider-node";
import type { ModelProviderConfig } from "./legacyModelProviderSerialized.js";
import { getAppConfigDir } from "../paths.js";
import { importLegacyPersonalProviderConfig } from "./legacyPersonalProviderConfigImporter.js";

// INV-01：配置的唯一实现在 @zcode/provider-node，本类只做装配，不重新解释任何字段；
// 两处各自演化默认值会让 Host 与 Provider 包读到不同的配置。
// INV-02：readLegacyProviders 只在构造时注入一次迁移入口，迁移不会在每次 start 重跑。
export interface ProviderConfigRuntimeOptions {
  readonly zcodeBuiltinFilePath: string;
  readonly zcodeBuiltinActiveFilePath?: string;
  readonly zcodeBuiltinRemote?: NodeProviderConfigRuntimeOptions["zcodeBuiltinRemote"];
  readonly zcodeBuiltinEnvironment?: NodeProviderConfigRuntimeOptions["zcodeBuiltinEnvironment"];
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath?: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly readLegacyProviders?: () => Promise<readonly ModelProviderConfig[]>;
  readonly watch?: boolean;
}

/**
 * Services 装配层：提供 App 配置目录和已发布旧配置的一次性迁移入口。
 * 配置迁移保留 ZCode 用户的供应商数据，文件运行时由 @zcode/provider-node 唯一实现。
 */
// 职责：把 App 配置目录、内置配置远端/环境、旧配置迁移入口拼成运行时选项，
// 并把 configService/personalRepository 原样暴露给 Services 其余模块。
// 本类不持锁也不缓存快照：读一致性与轮询都由 NodeProviderConfigRuntime 负责。
export class ProviderConfigRuntime {
  readonly configService: NodeProviderConfigRuntime["configService"];
// [资源] 私有运行时是唯一需要释放的对象；configService 只是它的视图，
// 生命周期必须跟 ProviderRuntime 一起结束，禁止单独 dispose。
  readonly #runtime: NodeProviderConfigRuntime;

// 显式逐字段透传而不是展开 options：readLegacyProviders 是 Services 层概念，
// 不能泄漏给 provider-node 的选项类型。
// [权衡] 逐字段复制需要随新选项维护，但能保证未声明的字段不会静默穿透。
  constructor(options: ProviderConfigRuntimeOptions) {
    const runtimeOptions: NodeProviderConfigRuntimeOptions = {
      zcodeBuiltinFilePath: options.zcodeBuiltinFilePath,
      zcodeBuiltinActiveFilePath: options.zcodeBuiltinActiveFilePath,
      zcodeBuiltinRemote: options.zcodeBuiltinRemote,
      zcodeBuiltinEnvironment: options.zcodeBuiltinEnvironment,
      onZCodeBuiltinRefreshError: options.onZCodeBuiltinRefreshError,
      onPersonalConfigRecovery: options.onPersonalConfigRecovery,
      onPersonalConfigPollingError: options.onPersonalConfigPollingError,
// 未指定时落到 App 配置目录的标准文件名；自定义路径只用于测试与多实例隔离。
// personalPollingIntervalMs 允许 false 关闭轮询，与 watch 是两条独立的变更来源。
      personalFilePath:
        options.personalFilePath ?? join(getAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
      personalPollingIntervalMs: options.personalPollingIntervalMs,
      watch: options.watch,
// [事务] 迁移在运行时首次加载 Personal 文件时执行一次，用已发布的旧 config.json
// 反推用户意图；没有读取器就完全不装配 importLegacy。
      ...(options.readLegacyProviders
        ? {
            importLegacy: async () =>
              importLegacyPersonalProviderConfig({
                legacyProviders: await options.readLegacyProviders!(),
              }),
          }
        : {}),
    };
    this.#runtime = new NodeProviderConfigRuntime(runtimeOptions);
    this.configService = this.#runtime.configService;
  }

// start 幂等由运行时保证，本层不重复判断，避免出现两处状态机。
// 调用方（ProviderRuntime）负责在 dispose 之后调用 start 时报错。
  start(): Promise<void> {
    return this.#runtime.start();
  }

  get personalRepository(): NodeProviderConfigRuntime["personalRepository"] {
    return this.#runtime.personalRepository;
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#runtime.resolveZCodeBuiltinActiveFilePath();
  }

  refreshZCodeBuiltin(options?: { readonly force?: boolean }) {
    return this.#runtime.refreshZCodeBuiltin(options);
  }

  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    return this.#runtime.onDidCheckZCodeBuiltin(listener);
  }

// [资源] 停止轮询与文件监听，具体顺序由运行时内部决定，本层只转发一次。
// dispose 之后 configService 仍可读到旧快照，调用方必须先摘掉新的读取入口。
  dispose(): void {
    this.#runtime.dispose();
  }
}

export function createProviderConfigRuntime(
  options: ProviderConfigRuntimeOptions,
): ProviderConfigRuntime {
  return new ProviderConfigRuntime(options);
}
