/**
 * 文件职责：prompt-trajectory 工具的公共类型契约。
 * 这些类型是落盘 JSONL、manifest 与派生结果的唯一结构约定，跨进程/文件边界使用，
 * 因此字段命名与可选性是兼容性契约，不要随意增删或改语义。
 */

/**
 * 任意 JSON 对象：键为字符串，值未收窄。
 * 用于承载原始请求体等结构未知但可序列化的数据；调用方需自行做运行时校验，
 * 不能假定任意字段存在或有类型。
 */
export type JsonObject = Record<string, unknown>;

/**
 * 轨迹派生选项。
 * 输入：由 CLI/调用方传入，缺省视为空对象，行为等价于全部开关关闭。
 * 语义稳定：新增开关必须可选，保持旧调用方零改动可编译。
 */
export interface TrajectoryDerivationOptions {
  /**
   * 是否忽略 ToolSearch 相关的公告与工具引用变化。
   * 缺失/undefined 表示按原始消息逐字节比较；显式 true 才启用离线比较视图。
   * 只影响比较判定，不改变最终输出的原始消息内容。
   */
  ignoreToolSearchChanges?: boolean;
}

/**
 * 归一化后的 OpenAI 风格消息。
 * 在 JSON 之上强制存在字符串 role；其余字段（content、tool_calls 等）按 provider 差异保留原值。
 * 可序列化；缺失字段即“该 provider 未提供”，不补默认值。
 */
export interface OpenAiMessage extends JsonObject {
  /**
   * 消息角色（user/assistant/tool/system 等）。
   * 必填字符串；缺失值不应进入此类型，记录层会显式拒绝无 role 的消息。
   */
  role: string;
}

/**
 * JSONL 中的请求条目：记录一次请求的“骨架”，消息本体拆到后续 message 条目。
 * 由 MessageLedger 追加写入，一次请求只会产生一条；requestIndex 从 1 开始递增。
 */
export interface RequestEntry {
  /**
   * 判别字段，固定为 "request"，供反序列化时区分条目类型。
   * 可序列化；缺失或为其他值应视为损坏记录。
   */
  kind: "request";
  /**
   * 请求序号（1 基、单调递增）。
   * 与 message 条目的 requestIndex 关联；跨条目必须一致，否则无法重组请求。
   */
  requestIndex: number;
  /**
   * 去掉 messages/input 后的请求体副本。
   * 保留其余采样参数用于复现；缺失字段即原请求未提供，不补默认值。
   */
  bodyWithoutMessages: JsonObject;
}

/**
 * JSONL 中的消息条目：请求内消息或请求后补录的 assistant 回复。
 * 与 RequestEntry 同流追加，读取端按 requestIndex 归组。
 */
export interface MessageEntry {
  /**
   * 判别字段，固定为 "message"。
   * 可序列化；缺失或为其他值应视为损坏记录。
   */
  kind: "message";
  /**
   * 所属请求序号，与 RequestEntry.requestIndex 对应。
   * 补录的 assistant 回复沿用触发它的请求序号；不单独自增。
   */
  requestIndex: number;
  /**
   * 消息在请求 messages 数组中的下标（0 基）。
   * 仅请求内消息存在；请求结束后补录的 assistant 回复省略该字段，
   * 读取端据此区分“请求快照”与“回复追加”。
   */
  messageIndex?: number;
  /**
   * 消息本体，保持 provider 原样（可含 tool_calls、content 数组等）。
   * 必须可 JSON 序列化；role 必填，否则记录层拒绝写入。
   */
  message: OpenAiMessage;
}

/**
 * JSONL 行条目联合类型。
 * 通过 kind 判别；读取端必须容忍未知 kind 之外的结构错误并跳过/报错，
 * 不得把 message 当成 request 解析。
 */
export type TrajectoryJsonlEntry = RequestEntry | MessageEntry;

/**
 * 单条派生轨迹：从 JSONL 重组出的可独立回放的请求快照。
 * 由 derive 阶段产出，只读；不写盘时仅存在于内存。
 */
export interface DerivedTrajectory {
  /**
   * 轨迹标识，形如 `trajectory-<起始请求序号>`（具体格式由 derive 生成）。
   * 同一输入重复派生必须稳定，便于测试与去重。
   */
  id: string;
  /**
   * 轨迹在输出数组中的顺序下标（0 基）。
   * 仅用于展示与排序，不参与追踪关系。
   */
  index: number;
  /**
   * 该轨迹截取的最后一个请求序号（1 基）。
   * 后续请求若不再追加，则该轨迹在此处封闭。
   */
  lastRequestIndex: number;
  /**
   * 轨迹起点原因：
   * - initial：会话首个请求；
   * - post-compaction：上下文压缩后重建；
   * - non-incremental-change：历史被改写（非追加），必须新开轨迹。
   * 该值只描述起点，不表示整条轨迹内每个请求的差异。
   */
  reason: "initial" | "post-compaction" | "non-incremental-change";
  /**
   * 完整请求体：原始参数 + 在该轨迹内的 messages 数组。
   * messages 为按轨迹时间序拼接后的结果；可直接用于回放。
   * 可序列化，字段缺失语义同原始请求。
   */
  requestBody: JsonObject & {
    messages: OpenAiMessage[];
  };
  /**
   * 该轨迹包含的请求数量（含端点，1 基计数）。
   * 必须与 requestBody.messages 的演化历史一致，不是消息条数。
   */
  requestCount: number;
}

/**
 * 派生清单：一次 derive 运行产出的摘要，供 report/校验使用。
 * 写入文件时必须保持 schemaVersion=1 的字段集，新增字段需升版本。
 */
export interface DerivedTrajectoryManifest {
  /**
   * 清单结构版本，当前固定为字面量 1。
   * 读取端按此分支解析；改动既有字段语义必须同时升版本。
   */
  schemaVersion: 1;
  /**
   * 生成时间，ISO 8601 字符串（含时区）。
   * 仅用于人读与排序，不参与派生正确性判断。
   */
  generatedAt: string;
  /**
   * 本次派生是否启用了忽略 ToolSearch 变化。
   * 只在 true 时出现；缺失表示按原始比较。用于复现同一派生口径。
   */
  ignoreToolSearchChanges?: true;
  /**
   * 每条轨迹的摘要，顺序与 DerivedTrajectory.index 一致。
   * 不含消息本体，仅用于快速预览；缺失字段视为清单损坏。
   */
  trajectories: Array<{
    /** 轨迹标识，与 DerivedTrajectory.id 一致。 */
    id: string;
    /** 截取的最后一个请求序号（1 基）。 */
    lastRequestIndex: number;
    /** 该轨迹去重后的消息条数，用于人工核对规模。 */
    messageCount: number;
    /** 轨迹起点原因，与 DerivedTrajectory.reason 语义一致。 */
    reason: DerivedTrajectory["reason"];
    /** 该轨迹包含的请求数量（1 基）。 */
    requestCount: number;
  }>;
}
