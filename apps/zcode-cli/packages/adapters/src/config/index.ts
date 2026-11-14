// INV-01 [失败路径] get 的三层回退链固定在 ConfigPortImpl.get：store 现值 → getDefaultValue → 抛 Config key not found；把抛错改成返回 undefined，上层类型守卫失效，调用方在运行时读到空值。
// INV-02 [权衡] 本模块没有缓存层：ConfigStore.get 每次直查 Map，getAll 每次新建快照；跨帧复用快照会读到过期配置，改返回值也不会回写 store。
// INV-03 [事务] ConfigStore.set 每次都整体替换 entry.sources 为一条记录，不追加历史；改成 push 会让 getSources 把旧 scope 当作最新来源。
// INV-04 [并发] set 的广播顺序固定为单 key observers 在前、allHandlers 在后；调换会让设置页整体刷新先于单 key 订阅读到旧值。
// INV-05 [失败路径] 订阅回调在 set 内同步执行且不捕获异常，异常会冒泡给 set 调用方，但此时 store 已写入；不要在 set 里吞掉异常制造静默不一致。
// INV-06 [事务] ConfigStore 构造时 initial 一律以 ConfigScope.System 写入，作为最低优先级基线；改成 Session 会压过后续 user/project 层。
// INV-07 [权衡] merge 的存在性判断分两套且不可互换：数值与布尔字段用 !== undefined 保留 0 与 false，mode、dir、level、use 用 truthy 跳过空串。
// INV-08 [事务] modelAnomalyGuard 与 hooks 是仅有的对象级合并字段，其余字段整体替换；写成整体替换会丢掉未提交的开关。
// INV-09 [事务] hooks 的 events 必须单独用 config.hooks.events ?? previous.events 兜底；删掉这行，浅合并会因 events 为 undefined 把已有事件表清空。
// INV-10 [失败路径] merge 对 modelStream 只识别 idleTimeoutMs；新增子字段必须先补 ConfigKey 与 getDefaultValue 的 case，否则用户配置被静默丢弃。
// INV-11 [资源] subscribe 依赖 observers 的懒建 Set；删掉 has 判断后对 undefined 调用 add 会直接抛 TypeError。
// INV-12 [并发] 取消订阅只能删除本 handler，不能 delete 整个 key 的 Set；否则会顺手退订同 key 的其他订阅者。
// INV-13 [资源] allHandlers 用 Set 去重，同一 handler 重复订阅只保留一份；换成数组会出现重复回调与重复刷新。
// INV-14 [资源] getSources 未写入时返回空数组而不是 undefined，调用方按 length 判断；改为 undefined 会让来源展示路径直接崩。
// INV-15 [权衡] ConfigPortImpl.has 的语义是 store.has 或 hasDefaultValue，与 ConfigStore.has 只认显式写入不同；两层混用会让是否用户设置过的判断失真。
// INV-16 [事务] ConfigPortImpl.set 固定写 ConfigScope.Session，是运行时最高优先级；改成 System 会让运行时修改被下次装配的文件配置覆盖。
// INV-17 [失败路径] getAll 的 permission 子字段走 this.get 而非 store 读取，DefaultConfig 对应值为 undefined 时会抛 Config key not found，与“不抛错”的注释不符。
// INV-18 [失败路径] getDefaultValue 用显式 switch 穷举 ConfigKey，default 返回 undefined；新增 key 漏加 case 会让 get 抛错、has 判 false，且没有编译期提示。
//
// 模块职责：ConfigPort 的进程内实现与 config 模块门面，负责按 ConfigKey 存储取值、来源记录、变更订阅，并 re-export 文件、环境、schema、合并与工厂适配器。
// 状态所有权：store、observers、allHandlers 归 ConfigStore；持久化文件、环境变量与多层合并分别由 file-config.adapter、env-config.adapter、config-merger 持有，本文件不读写任何外部 I/O。
// 阅读顺序：先看 ConfigEntry 与 ConfigStore 的 set/merge，再看 ConfigPortImpl 的 get/getAll 回退链，最后看 getDefaultValue 的穷举 switch 与文件末尾的 re-export 面。
// Config Port Implementation - Scoped configuration with change notification

/*
 * ============================================================
 * config / index.ts —— ConfigPort 实现与配置模块门面
 *
 * 定位：把 RuntimeConfig 拆成按 ConfigKey 存储的内存 store，提供 get/has/set/merge/
 * getSources/observe；文件末尾 re-export 其余 config adapter，形成模块公开面。
 *
 * 输入输出：ConfigStore 存“最后写入值 + 该值的来源”；get 缺失时回退 DefaultConfig，
 * 再缺才抛错。set 为 Session scope，merge 可按指定 scope 写入各字段。
 *
 * 副作用：进程内状态与订阅通知；不读写文件/网络。
 *
 * 失败语义：get 未知且无默认值的 key 抛 `Config key not found`；merge 空字段跳过。
 *
 * 不变量：每次 set 只产生一条 source 记录；订阅者在 set 后按注册顺序同步回调；
 * getAll 对每个字段都给出确定回退值。
 * ============================================================
 */

import {
  ConfigKey,
  type ConfigValue,
  type ConfigSource,
  type RuntimeConfig,
  type RuntimeConfigPatch,
  type Unsubscribe,
  type ConfigObserver,
  type ConfigPort,
  ConfigScope,
  DefaultRuntimeConfig as DefaultConfig,
} from "@zcode/contracts";

type Handler<K extends ConfigKey> = (value: ConfigValue<K>, prev: ConfigValue<K>) => void;
type AllHandler = (key: ConfigKey, value: unknown, prev: unknown) => void;

// ============================================================
// Config Store - Internal state
// ============================================================

// ConfigEntry 是 store 的最小存储单元，只承载两件事：当前值与这批值的来源。
// [事务] value 按 ConfigKey 泛型约束存放，这里不做 schema 转换也不填默认值，写入什么就保存什么。
// sources 在本实现中恒为 0 或 1 条：set 整体替换而不是追加，所以它表达最后一次写入由谁发起，不是历史审计链。
// [失败路径] 若把 sources 改成累积数组，getSources 的调用方会把第一条当最新来源，优先级解析随写入次数漂移。
// 来源条目里的 path 来自 set 的可选 source 参数，只用于定位，不参与优先级比较。
// 改动这个结构必须同步 ConfigStore.set、getSources 以及所有按 sources 长度分支的装配代码。
interface ConfigEntry {
  /** 当前生效值（按 ConfigKey 类型约束，不做 schema 转换）。 */
  value: unknown;
  /** 该值来源记录；本实现每次 set 只写一条。 */
  sources: ConfigSource[];
}

/**
 * 内存配置存储：按 key 保存值与来源，并向单 key / 全量订阅者广播变更。
 * 无 IO；所有方法同步执行，订阅回调异常会直接向 set 调用方冒泡。
 */
class ConfigStore {
  // 这三个字段共同界定本文件的状态所有权：store、observers、allHandlers 都只属于 ConfigStore 实例。
  // [资源] store 是唯一事实源，纯进程内存，不落盘也不跨进程共享；进程退出即丢，需要持久化的部分交给 file-config.adapter。
  // observers 是单 key 订阅索引，allHandlers 是全量订阅集合；两者只存回调，不存值，也不参与读取路径。
  // [并发] 所有读写同步执行，无锁无队列，依靠 JS 单线程模型保证一次 set 与它的广播之间不会插入别的写入。
  // 若把 store 换成异步存储（磁盘或 IPC），写后立即可读与通知顺序都会失效，需要重做整条订阅链。
  // 不要在这里补缓存层：get 直接命中 Map，多一层快照只会引入失效与跨 key 一致性问题。
  private store = new Map<ConfigKey, ConfigEntry>();
  private observers: Map<ConfigKey, Set<Handler<any>>> = new Map();
  private allHandlers: Set<AllHandler> = new Set();

  constructor(initial?: RuntimeConfigPatch) {
    // 初始 patch 一律视为 System scope，作为最低优先级基线。
    if (initial) {
      this.merge(initial, ConfigScope.System);
    }
  }

  /** 读取当前值；未设置返回 undefined（不在这里回退默认值）。 */
  get<K extends ConfigKey>(key: K): ConfigValue<K> | undefined {
    const entry = this.store.get(key);
    return entry?.value as ConfigValue<K>;
  }

  /** 仅判断 store 中是否显式写入过该 key，不代表“有默认值”。 */
  has(key: ConfigKey): boolean {
    return this.store.has(key);
  }

  /**
   * 写入单个 key 并通知订阅者（先单 key 后全量）。
   * 来源只记录本次写入，不累积历史；prev 供订阅者做差异处理。
   */
  set<K extends ConfigKey>(
    key: K,
    value: ConfigValue<K>,
    scope: ConfigScope,
    source?: string,
  ): void {
    // set 的固定顺序是：先取旧值 prev，再构造新 entry 覆盖 store，最后才广播。
    // [事务] prev 必须在写入之前读取；挪到 store.set 之后会让订阅者收到的 prev 等于新值，所有差异处理失效。
    // [事务] entry.sources 整体替换为单条记录（scope、key、value、path），这是每次 set 只产生一条来源的唯一实现点。
    // [失败路径] 写入与广播不在同一事务内：广播抛错时 store 已是新值，调用方看到失败但配置已生效，重试会造成重复通知。
    // [权衡] 这里刻意不在广播前回滚，因为回滚会让已经收到通知的订阅者与 store 再次不一致。
    // prev 传给回调时按 ConfigValue<K> 断言，回调需自行把 undefined 理解为此前未写入。
    // 新增任何通知通道都要插在两次遍历之后，保证仍在 store 写入之后执行。
    const prev = this.get(key);
    const entry: ConfigEntry = {
      value,
      sources: [{ scope, key, value, path: source }],
    };
    this.store.set(key, entry);

    // Notify observers
    const handlers = this.observers.get(key);
    if (handlers) {
      handlers.forEach((handler) => handler(value, prev as ConfigValue<K>));
    }

    // Notify all-handlers
    this.allHandlers.forEach((handler) => handler(key, value, prev));
  }

  /** 返回该 key 的来源列表（通常 0 或 1 条）；未设置返回空数组。 */
  getSources(key: ConfigKey): ConfigSource[] {
    const entry = this.store.get(key);
    return entry?.sources ?? [];
  }

  /**
   * 把 patch 展开成逐 key 的 set 调用，并按 scope 记录来源。
   *
   * 只处理已识别字段；null/undefined 跳过以保留下层值。modelAnomalyGuard/hooks 需要
   * 与已有值做对象级合并，其余字段整体替换。
   */
  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    // merge 是 patch 展开为逐 key set 的唯一入口，整个方法只做三件事：判断字段存在、映射到 ConfigKey、带上调用方 scope。
    // [权衡] 存在性判断有两套写法且不可互换：数值与布尔字段用 !== undefined 以保留 0 与 false；mode、dir、level、use 这类非空语义字段用 truthy 判断，空串被跳过。
    // [失败路径] 把 truthy 改成 !== undefined，空字符串会写进 store 并覆盖下层有效值；反过来把 !== undefined 改成 truthy，false 与 0 会被静默丢弃。
    // 每个分支都必须显式落到一个 ConfigKey；未列出的字段不会报错，只会被静默忽略，新增配置项必须同时补 ConfigKey 与这里的映射。
    // [事务] 同一 patch 内的字段按代码顺序逐个 set，每次都独立广播，订阅者会看到多次中间态而不是一次性批量更新。
    // scope 由调用方传入并由装配层决定优先级，merge 自身不做比较，只是把 scope 记进来源。
    // 没有字段被写入时方法静默返回、不产生通知；调用方不能靠通知次数判断 patch 是否生效。
    // 嵌套对象字段（permission、storage、network、features、recording 等）先判父对象存在再判子字段，避免对 undefined 取属性。
    if (config.modelStream?.idleTimeoutMs !== undefined) {
      this.set(ConfigKey.ModelStreamIdleTimeout, config.modelStream.idleTimeoutMs, scope);
    }
    if (config.permission) {
      if (config.permission.mode) this.set(ConfigKey.PermissionMode, config.permission.mode, scope);
      if (config.permission.allowedTools)
        this.set(ConfigKey.PermissionAllowedTools, config.permission.allowedTools, scope);
      if (config.permission.disallowedTools)
        this.set(ConfigKey.PermissionDisallowedTools, config.permission.disallowedTools, scope);
      if (config.permission.autoApproveHighRisk !== undefined) {
        this.set(
          ConfigKey.PermissionAutoApproveHighRisk,
          config.permission.autoApproveHighRisk,
          scope,
        );
      }
      if (config.permission.allowMediumRiskInAuto !== undefined) {
        this.set(
          ConfigKey.PermissionAllowMediumRiskInAuto,
          config.permission.allowMediumRiskInAuto,
          scope,
        );
      }
    }
    if (config.storage) {
      if (config.storage.dir) this.set(ConfigKey.StorageDir, config.storage.dir, scope);
      if (config.storage.sessionDbPath)
        this.set(ConfigKey.StorageSessionDbPath, config.storage.sessionDbPath, scope);
    }
    if (config.network) {
      if (config.network.httpProxy !== undefined)
        this.set(ConfigKey.HttpProxy, config.network.httpProxy, scope);
      if (config.network.noProxy !== undefined)
        this.set(ConfigKey.NoProxy, config.network.noProxy, scope);
      if (config.network.caCertFile !== undefined)
        this.set(ConfigKey.CaCertFile, config.network.caCertFile, scope);
      if (config.network.timeout !== undefined)
        this.set(ConfigKey.HttpTimeout, config.network.timeout, scope);
    }
    if (config.features) {
      if (config.features.compact !== undefined)
        this.set(ConfigKey.FeatureCompact, config.features.compact, scope);
      if (config.features.rewind !== undefined)
        this.set(ConfigKey.FeatureRewind, config.features.rewind, scope);
      if (config.features.subagent !== undefined)
        this.set(ConfigKey.FeatureSubagent, config.features.subagent, scope);
      if (config.features.memory !== undefined)
        this.set(ConfigKey.FeatureMemory, config.features.memory, scope);
      if (config.features.skill !== undefined)
        this.set(ConfigKey.FeatureSkill, config.features.skill, scope);
      if (config.features.mcp !== undefined)
        this.set(ConfigKey.FeatureMcp, config.features.mcp, scope);
    }
    if (config.memory) {
      if (config.memory.use !== undefined) this.set(ConfigKey.MemoryUse, config.memory.use, scope);
    }
    if (config.mcp) {
      if (config.mcp.servers !== undefined)
        this.set(ConfigKey.McpServers, config.mcp.servers, scope);
    }
    if (config.plugins) {
      if (config.plugins.enabled !== undefined)
        this.set(ConfigKey.PluginsEnabled, config.plugins.enabled, scope);
      if (config.plugins.dirs !== undefined)
        this.set(ConfigKey.PluginsDirs, config.plugins.dirs, scope);
      if (config.plugins.enabledPlugins !== undefined) {
        this.set(ConfigKey.PluginsEnabledPlugins, config.plugins.enabledPlugins, scope);
      }
      if (config.plugins.extraKnownMarketplaces !== undefined) {
        this.set(
          ConfigKey.PluginsExtraKnownMarketplaces,
          config.plugins.extraKnownMarketplaces,
          scope,
        );
      }
      if (config.plugins.options !== undefined) {
        this.set(ConfigKey.PluginsOptions, config.plugins.options, scope);
      }
      if (config.plugins.suppressedBuiltins !== undefined) {
        this.set(ConfigKey.PluginsSuppressedBuiltins, config.plugins.suppressedBuiltins, scope);
      }
    }
    if (config.skills) {
      if (config.skills.enabled !== undefined)
        this.set(ConfigKey.SkillsEnabled, config.skills.enabled, scope);
      if (config.skills.includeInstructions !== undefined) {
        this.set(ConfigKey.SkillsIncludeInstructions, config.skills.includeInstructions, scope);
      }
      if (config.skills.metadataBudget !== undefined) {
        this.set(ConfigKey.SkillsMetadataBudget, config.skills.metadataBudget, scope);
      }
      if (config.skills.roots !== undefined)
        this.set(ConfigKey.SkillsRoots, config.skills.roots, scope);
    }
    if (config.skillOverrides !== undefined) {
      this.set(ConfigKey.SkillOverrides, config.skillOverrides, scope);
    }
    if (config.commandOverrides !== undefined) {
      this.set(ConfigKey.CommandOverrides, config.commandOverrides, scope);
    }
    if (config.logging) {
      if (config.logging.level) this.set(ConfigKey.LogLevel, config.logging.level, scope);
      if (config.logging.format !== undefined)
        this.set(ConfigKey.LogFormat, config.logging.format, scope);
    }
    if (config.recording?.conversation) {
      if (config.recording.conversation.enabled !== undefined) {
        this.set(
          ConfigKey.RecordingConversationEnabled,
          config.recording.conversation.enabled,
          scope,
        );
      }
      if (config.recording.conversation.dir !== undefined) {
        this.set(ConfigKey.RecordingConversationDir, config.recording.conversation.dir, scope);
      }
    }
    if (config.toolConcurrency) {
      if (config.toolConcurrency.maxConcurrency !== undefined)
        this.set(ConfigKey.ToolConcurrencyMax, config.toolConcurrency.maxConcurrency, scope);
    }
    // modelAnomalyGuard 与后面的 hooks 是仅有的两个对象级合并字段，其余字段一律整体替换。
    // [事务] 合并基线取 store 现值的 previous，未写入时才回退 DefaultConfig.modelAnomalyGuard；漏掉兜底会让首次合并只得到 patch 里的部分字段。
    // [失败路径] 改成整体替换时，调用方只提交一个开关会丢掉其余守卫参数，模型异常保护退化为半套配置。
    // 展开顺序是 previous 在前、patch 在后，后者覆盖前者；调换会让新配置永远不生效。
    // [权衡] 这里只做一层浅合并，嵌套对象仍被整体替换；需要深合并的字段必须单独处理，不能假定递归。
    // 合并结果作为一次 set 写入，来源只记一条，scope 取本次调用的 scope。
    if (config.modelAnomalyGuard) {
      const previous = this.get(ConfigKey.ModelAnomalyGuard) ?? DefaultConfig.modelAnomalyGuard;
      this.set(
        ConfigKey.ModelAnomalyGuard,
        {
          ...previous,
          ...config.modelAnomalyGuard,
        },
        scope,
      );
    }
    if (config.hooks) {
      const previous = this.get(ConfigKey.Hooks) ?? DefaultConfig.hooks;
      this.set(
        ConfigKey.Hooks,
        {
          ...previous,
          ...config.hooks,
          events: config.hooks.events ?? previous.events,
        },
        scope,
      );
    }
    if (config.ui?.locale !== undefined) {
      this.set(ConfigKey.UiLocale, config.ui.locale, scope);
    }
    if (config.ui?.theme !== undefined) {
      this.set(ConfigKey.UiTheme, config.ui.theme, scope);
    }
  }

  /** 订阅单个 key；返回幂等的取消函数，同一 handler 重复订阅会被 Set 去重。 */
  subscribe<K extends ConfigKey>(key: K, handler: Handler<K>): Unsubscribe {
    if (!this.observers.has(key)) {
      this.observers.set(key, new Set());
    }
    this.observers.get(key)!.add(handler);

    return () => {
      this.observers.get(key)?.delete(handler);
    };
  }

  /** 订阅所有 key 的变更（用于设置页整体刷新）；返回取消函数。 */
  subscribeAll(handler: AllHandler): Unsubscribe {
    this.allHandlers.add(handler);
    return () => {
      this.allHandlers.delete(handler);
    };
  }
}

// ============================================================
// Config Port Implementation
// ============================================================

/**
 * ConfigPort 的进程内实现：包装 ConfigStore 并在读取时回退 DefaultConfig。
 *
 * 构造时若无 initial 则用 DefaultConfig 初始化；所有 get 方法保证要么返回确定值，
 * 要么对无默认值的 key 抛错。不涉及文件/网络。
 */
export class ConfigPortImpl implements ConfigPort {
  private store: ConfigStore;

  constructor(initial?: RuntimeConfigPatch) {
    this.store = new ConfigStore(initial ?? DefaultConfig);
  }

  /** 读取单 key：store → 默认值 → 抛错；运行时会话覆盖优先于默认配置。 */
  // get 是三层回退链的唯一入口：先取 store 现值，再查 getDefaultValue，最后抛错。
  // [事务] 空值判定用 !== undefined 而不是 truthy，因为 false、0、空数组都是合法配置；改成 truthy 会让关闭的开关回退成默认开启。
  // [失败路径] 末行抛出 Config key not found 并携带 key，这条文案同时是对外契约，改动会影响按消息匹配的调用方与测试。
  // 回退到默认值时不写回 store，也不产生来源记录，所以 getSources 返回空数组的含义就是仅默认值或未设置。
  // [权衡] 每次 get 都重查 Map 与 switch，没有缓存；好处是 set 之后立即可见，代价是热点路径上的重复分支。
  // 不要在 get 内做类型转换或克隆：调用方拿到的是同一引用，修改可变对象会绕过 set 与通知。
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const value = this.store.get(key);
    if (value !== undefined) return value;

    // Fallback to default config
    const defaultValue = getDefaultValue(key) as ConfigValue<K> | undefined;
    if (defaultValue !== undefined) return defaultValue;

    throw new Error(`Config key not found: ${key}`);
  }

  /** 组装完整 RuntimeConfig 快照；未设置字段统一回退 DefaultConfig，不抛错。 */
  // getAll 只负责组装快照，不写 store、不发通知，每次调用都返回新对象。
  // [失败路径] 多数字段走 store 读取加 ?? DefaultConfig，不会抛错；但 permission 的五个子字段与部分字段走 this.get，DefaultConfig 对应值为 undefined 时会抛 Config key not found，与不抛错的注释不一致。
  // [权衡] features 的六个开关与 skills 的两个开关硬编码 ?? true，logging.level 硬编码 "info"，其余才引用 DefaultConfig；改默认值必须同步这里，否则两处默认分叉。
  // [事务] 快照被调用方当作缓存跨帧复用时就会读到过期配置；需要最新值时应重新调用 getAll 或直接 get。
  // 未写入且无默认值的字段在快照里表现为 undefined 或抛错，取决于它走 store 读取还是 this.get，新增字段时必须明确选哪条路径。
  // 这里的对象结构必须与 contracts 的 RuntimeConfig 逐字段对齐，类型检查能挡住漏字段，但分组与顺序不影响语义。
  getAll(): RuntimeConfig {
    return {
      modelStream: {
        idleTimeoutMs:
          this.store.get(ConfigKey.ModelStreamIdleTimeout) ??
          DefaultConfig.modelStream.idleTimeoutMs,
      },
      permission: {
        mode: this.get(ConfigKey.PermissionMode),
        allowedTools: this.get(ConfigKey.PermissionAllowedTools),
        disallowedTools: this.get(ConfigKey.PermissionDisallowedTools),
        autoApproveHighRisk: this.get(ConfigKey.PermissionAutoApproveHighRisk),
        allowMediumRiskInAuto: this.get(ConfigKey.PermissionAllowMediumRiskInAuto),
      },
      storage: {
        dir: this.store.get(ConfigKey.StorageDir) ?? DefaultConfig.storage.dir,
        sessionDbPath:
          this.store.get(ConfigKey.StorageSessionDbPath) ?? DefaultConfig.storage.sessionDbPath,
      },
      network: {
        httpProxy: this.store.get(ConfigKey.HttpProxy),
        noProxy: this.store.get(ConfigKey.NoProxy),
        caCertFile: this.store.get(ConfigKey.CaCertFile),
        timeout: this.store.get(ConfigKey.HttpTimeout) ?? DefaultConfig.network.timeout,
      },
      features: {
        compact: this.store.get(ConfigKey.FeatureCompact) ?? true,
        rewind: this.store.get(ConfigKey.FeatureRewind) ?? true,
        subagent: this.store.get(ConfigKey.FeatureSubagent) ?? true,
        memory: this.store.get(ConfigKey.FeatureMemory) ?? true,
        skill: this.store.get(ConfigKey.FeatureSkill) ?? true,
        mcp: this.store.get(ConfigKey.FeatureMcp) ?? true,
      },
      memory: {
        use: this.store.get(ConfigKey.MemoryUse) ?? DefaultConfig.memory.use,
      },
      mcp: {
        servers: this.store.get(ConfigKey.McpServers) ?? DefaultConfig.mcp.servers,
      },
      plugins: {
        dirs: this.store.get(ConfigKey.PluginsDirs) ?? DefaultConfig.plugins.dirs,
        enabled: this.store.get(ConfigKey.PluginsEnabled) ?? DefaultConfig.plugins.enabled,
        enabledPlugins:
          this.store.get(ConfigKey.PluginsEnabledPlugins) ?? DefaultConfig.plugins.enabledPlugins,
        extraKnownMarketplaces:
          this.store.get(ConfigKey.PluginsExtraKnownMarketplaces) ??
          DefaultConfig.plugins.extraKnownMarketplaces,
        options: this.store.get(ConfigKey.PluginsOptions) ?? DefaultConfig.plugins.options,
        suppressedBuiltins:
          this.store.get(ConfigKey.PluginsSuppressedBuiltins) ??
          DefaultConfig.plugins.suppressedBuiltins,
      },
      skills: {
        enabled: this.store.get(ConfigKey.SkillsEnabled) ?? true,
        includeInstructions: this.store.get(ConfigKey.SkillsIncludeInstructions) ?? true,
        metadataBudget:
          this.store.get(ConfigKey.SkillsMetadataBudget) ?? DefaultConfig.skills.metadataBudget,
        roots: this.store.get(ConfigKey.SkillsRoots) ?? DefaultConfig.skills.roots,
      },
      skillOverrides: this.store.get(ConfigKey.SkillOverrides) ?? DefaultConfig.skillOverrides,
      commandOverrides:
        this.store.get(ConfigKey.CommandOverrides) ?? DefaultConfig.commandOverrides,
      logging: {
        level: this.store.get(ConfigKey.LogLevel) ?? "info",
        format: this.store.get(ConfigKey.LogFormat) ?? DefaultConfig.logging.format,
      },
      recording: {
        conversation: {
          enabled:
            this.store.get(ConfigKey.RecordingConversationEnabled) ??
            DefaultConfig.recording.conversation.enabled,
          dir: this.store.get(ConfigKey.RecordingConversationDir),
        },
      },
      toolConcurrency: {
        maxConcurrency:
          this.store.get(ConfigKey.ToolConcurrencyMax) ??
          DefaultConfig.toolConcurrency.maxConcurrency,
      },
      modelAnomalyGuard:
        this.store.get(ConfigKey.ModelAnomalyGuard) ?? DefaultConfig.modelAnomalyGuard,
      hooks: this.store.get(ConfigKey.Hooks) ?? DefaultConfig.hooks,
      ui: {
        locale: this.store.get(ConfigKey.UiLocale) ?? DefaultConfig.ui.locale,
        theme: this.store.get(ConfigKey.UiTheme) ?? DefaultConfig.ui.theme,
      },
    };
  }

  /** 有显式值或有默认值即为 true（与 store.has 的语义不同）。 */
  has(key: ConfigKey): boolean {
    return this.store.has(key) || hasDefaultValue(key);
  }

  /** 运行时修改固定记为 Session scope（最高优先级，仅本次进程有效）。 */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    // Runtime changes are always session scope
    this.store.set(key, value, ConfigScope.Session);
  }

  /** 返回订阅视图；subscribe/subscribeAll 均转发到内部 store。 */
  observe(): ConfigObserver {
    return {
      subscribe: <K extends ConfigKey>(key: K, handler: Handler<K>) =>
        this.store.subscribe(key, handler),
      subscribeAll: (handler: AllHandler) => this.store.subscribeAll(handler),
    };
  }

  /** 查询某 key 的来源（由哪一层写入）；空数组表示仅来自默认值或未设置。 */
  getSources(key: ConfigKey): ConfigSource[] {
    return this.store.getSources(key);
  }

  /** 按指定 scope 把 patch 展开写入 store（配置装配阶段使用）。 */
  merge(config: RuntimeConfigPatch, scope: ConfigScope): void {
    this.store.merge(config, scope);
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * ConfigKey → DefaultConfig 中的默认值；显式 switch 保证穷举、避免按字符串动态取值。
 * 未知 key 返回 undefined。
 */
function getDefaultValue(key: ConfigKey): unknown {
  const defaults = DefaultConfig;
  switch (key) {
    case ConfigKey.ModelStreamIdleTimeout:
      return defaults.modelStream.idleTimeoutMs;
    case ConfigKey.PermissionMode:
      return defaults.permission.mode;
    case ConfigKey.PermissionAllowedTools:
      return defaults.permission.allowedTools;
    case ConfigKey.PermissionDisallowedTools:
      return defaults.permission.disallowedTools;
    case ConfigKey.PermissionAutoApproveHighRisk:
      return defaults.permission.autoApproveHighRisk;
    case ConfigKey.PermissionAllowMediumRiskInAuto:
      return defaults.permission.allowMediumRiskInAuto;
    case ConfigKey.StorageDir:
      return defaults.storage.dir;
    case ConfigKey.StorageSessionDbPath:
      return defaults.storage.sessionDbPath;
    case ConfigKey.HttpProxy:
      return defaults.network.httpProxy;
    case ConfigKey.NoProxy:
      return defaults.network.noProxy;
    case ConfigKey.CaCertFile:
      return defaults.network.caCertFile;
    case ConfigKey.HttpTimeout:
      return defaults.network.timeout;
    case ConfigKey.FeatureCompact:
      return defaults.features.compact;
    case ConfigKey.FeatureRewind:
      return defaults.features.rewind;
    case ConfigKey.FeatureSubagent:
      return defaults.features.subagent;
    case ConfigKey.FeatureMemory:
      return defaults.features.memory;
    case ConfigKey.FeatureSkill:
      return defaults.features.skill;
    case ConfigKey.FeatureMcp:
      return defaults.features.mcp;
    case ConfigKey.MemoryUse:
      return defaults.memory.use;
    case ConfigKey.McpServers:
      return defaults.mcp.servers;
    case ConfigKey.PluginsEnabled:
      return defaults.plugins.enabled;
    case ConfigKey.PluginsDirs:
      return defaults.plugins.dirs;
    case ConfigKey.PluginsEnabledPlugins:
      return defaults.plugins.enabledPlugins;
    case ConfigKey.PluginsExtraKnownMarketplaces:
      return defaults.plugins.extraKnownMarketplaces;
    case ConfigKey.PluginsOptions:
      return defaults.plugins.options;
    case ConfigKey.PluginsSuppressedBuiltins:
      return defaults.plugins.suppressedBuiltins;
    case ConfigKey.SkillsEnabled:
      return defaults.skills.enabled;
    case ConfigKey.SkillsIncludeInstructions:
      return defaults.skills.includeInstructions;
    case ConfigKey.SkillsMetadataBudget:
      return defaults.skills.metadataBudget;
    case ConfigKey.SkillsRoots:
      return defaults.skills.roots;
    case ConfigKey.LogLevel:
      return defaults.logging.level;
    case ConfigKey.LogFormat:
      return defaults.logging.format;
    case ConfigKey.RecordingConversationEnabled:
      return defaults.recording.conversation.enabled;
    case ConfigKey.RecordingConversationDir:
      return defaults.recording.conversation.dir;
    case ConfigKey.ToolConcurrencyMax:
      return defaults.toolConcurrency.maxConcurrency;
    case ConfigKey.ModelAnomalyGuard:
      return defaults.modelAnomalyGuard;
    case ConfigKey.Hooks:
      return defaults.hooks;
    case ConfigKey.UiLocale:
      return defaults.ui.locale;
    case ConfigKey.UiTheme:
      return defaults.ui.theme;
    default:
      return undefined;
  }
}

/** key 是否存在默认值（undefined 视为无默认值）。 */
function hasDefaultValue(key: ConfigKey): boolean {
  return getDefaultValue(key) !== undefined;
}

// ============================================================
// Factory
// ============================================================

/** 创建 ConfigPort；不传 initial 时以 DefaultConfig 作为 System 基线。 */
export function createConfigPort(initial?: RuntimeConfigPatch): ConfigPort {
  return new ConfigPortImpl(initial);
}

// Re-export adapters and factory
// 本文件作为 config 模块门面，外部只需从这里导入。
export {
  loadFileConfig,
  getDefaultConfigPath,
  hasDefaultConfigFile,
  resolvePath,
  updatePluginEnabledInFileConfig,
  enablePluginsByDefaultInFileConfig,
  removePluginEnabledFromFileConfig,
  updatePluginOptionsInFileConfig,
  removePluginFromFileConfig,
  addSuppressedBuiltinInFileConfig,
  removeSuppressedBuiltinInFileConfig,
  updateUiLocaleInFileConfig,
  type PluginEnabledPatchResult,
  type PluginOptionsPatchResult,
  type PluginRemovePatchResult,
  type SuppressedBuiltinPatchResult,
  type UiLocalePatchResult,
} from "./file-config.adapter.js";
export { parseEnvConfig, getToolConcurrencyConfig } from "./env-config.adapter.js";
export { ZCodeConfigFileSchema, type ZCodeConfigFile } from "./schema.js";
export { mergeConfigs, createPrioritizedConfig, getScopePriority } from "./config-merger.js";
export {
  createConfig,
  resolveWorkspaceStorageDir,
  type ConfigFactoryOptions,
  type ConfigResult,
} from "./config-factory.js";
