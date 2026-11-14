// ---------------------------------------------------------------
// Model content protection (generic host vocabulary)
// ---------------------------------------------------------------

/**
 * 受保护模型内容的宿主原子性标记（通用 host 词汇，不含具体领域语义）。
 *
 * 生产者：产出受保护内容的权限/校验方（例如工具授权、预算闸门）在挂载内容时写入。
 * 消费者：host 管线只按 kind 做等值比较（注册表接线、预算校验、hook 投影），
 * 领域含义（保护什么、如何证明）由拥有该 kind 的生产方定义。
 *
 * 跨进程/持久化不变量：kind 是策略标识符而非自由文本；不同实现之间只承诺
 * “相等即同一保护策略”，不得让通用层解析其内部结构或据此放宽访问控制。
 *
 * 字段口径：`kind` 为唯一必填字段，取值是生产方自有的稳定字符串标识；同一 kind 在不同进程、
 * 不同实现中必须指向同一保护策略，改名等同于更换策略，需由生产方同步迁移历史数据。
 * 类型口径：类型是结构化 `{ kind: string }`，不做运行时校验、也不做品牌化，任意带字符串
 * kind 的对象都能赋值；消费方的信任判断来自 kind 等值比较，而不是类型系统。
 * 失败与降级：缺少 kind、空串或未知 kind 都不代表“放行”，一律按未识别策略处理，
 * 由消费者自行拒绝或降级；本模块不产生错误，也不吞掉上层校验错误。
 *
 * 以下原英文注释保留，作为该类型的设计出处。
 */
/**
 * Host-issued atomicity marker for protected model content. Values are opaque
 * policy identifiers owned by whichever authority verified the tool that
 * produced the content; the generic host pipeline only compares them for
 * equality (registry wiring, budget gates, hook projection). Domain semantics
 * (what the marker protects, how to attest it) live with the owning producer.
 */
export type ModelContentProtection = { kind: string };
