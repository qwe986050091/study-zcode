// ============================================================
// Model Catalog Port - 宿主已配置模型的只读快照边界
// ============================================================
// 存在的理由只有一个：
// 工具层要把用户说的模型名（"GLM-5.3-Flash"）解析成一次 workflow run 的子代理选型，而 core
// 看不见 provider 注册表。端口把「有哪些模型」这件宿主事实递进来，解析本身留在 core
// （纯函数，无 I/O）。
//
// 刻意**同步、无 I/O**：调用点在 `resolveInput` 与 `ListModels` 的 handler 里，两处都不该
// 为了列一张表去等网络；宿主侧本来就只是读一份内存里的注册表视图。
// 生产者是宿主（bootstrap 把 provider 注册表投影成条目），消费者是 core 的模型解析
// 与 ListModels 工具。目录不含密钥/端点等敏感细节，也不能当作 provider 可用性探测：
// `disabledReason` 只表达"为何不可选"，不表达网络可达性。

// 条目集合必须覆盖"当前可选 + 明确不可选"两类，否则模型解析会静默挑中已禁用的模型；
// provider×model 的组合由宿主注册表去重，端口不承诺排序或稳定顺序。
/** 目录里的一个模型条目（一条 provider × model 的组合）。 */
export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  /** provider 的人类可读名；注册表没给就缺席（读侧退回 `providerId`）。 */
  providerLabel?: string;
  /** 该模型支持的推理档位（`$level` 的合法取值）。没有档位的模型是**空数组**，不是缺席。 */
  reasoningLevels: string[];
  /** 注册表的默认档位；`reasoningLevels` 为空时缺席。 */
  defaultReasoningLevel?: string;
  contextWindow?: number;
  /** 本条目是否就是会话当前的选择（provider + model 同一）。整张表至多一条为真。 */
  current: boolean;
  /** 不可选用的理由（未配置密钥、被策略禁用等）；可选用即缺席。 */
  disabledReason?: string;
}

// 目录端口。唯一方法是同步读取当前活视图；返回数组的每次调用都应是新快照，
// 调用方不得持有并跨 turn 复用，也不得据此持久化模型解析结果——
// provider 可能在会话中途被增删改，过期目录会让子代理选到已不存在的模型。
export interface ModelCatalogPort {
  /**
   * 列出此刻可选的模型。
   *
   * **每次调用都必须现读注册表的活视图**，绝不返回构造期冻结的拷贝：provider 可以在会话
   * 中途被增删改（stale provider registry 的教训就是子代理抱着父会话构造时的
   * 那一份适配器不放）。一份过期的目录会让解析挑中一个已经不存在的模型，而失败要到子代理
   * 第一次开口时才炸——离用户按下确认已经很远了。
   */
  listModels(): ModelCatalogEntry[];
}
