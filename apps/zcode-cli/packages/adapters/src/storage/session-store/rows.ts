// ============================================================
// Session store DB row shapes
// ============================================================
// 定位：SQLite 表行的原样形状（snake_case、JSON 列为 string），只给仓储与
// codecs 使用，不对外暴露。领域对象转换统一在 codecs.ts 完成。
// 输入输出：这些类型只描述查询结果的列；可空列在 SQL 里可为 NULL。
// 副作用：无（纯类型）。
// 失败语义：字段缺失/类型不符由 SQLite 驱动或 codecs 暴露，不在此处兜底。
// 不变量：message/part 的 sequence 可为 null（旧数据未回填），读取侧必须容忍；
// 时间戳全部为 epoch 毫秒。

export interface SessionRow {
  /** 会话主键。 */
  id: string;
  /** 所属项目。 */
  project_id: string;
  /** 工作区身份；null 表示早期未记录 workspace。 */
  workspace_id: string | null;
  /** 父会话（fork/subagent）；null 表示根会话。 */
  parent_id: string | null;
  /** 顶层任务 trace 标识；null 表示历史数据。 */
  trace_id: string | null;
  /** interactive / 其他任务类型字符串，解码时校验。 */
  task_type: string;
  /** URL 友好短标识。 */
  slug: string;
  /** 会话工作目录（执行路径，不是 identity）。 */
  directory: string;
  /** 会话文件/存储路径；null 表示无独立文件。 */
  path: string | null;
  /** 展示标题。 */
  title: string;
  /** 标题来源枚举；null 视为 first_input。 */
  title_source: string | null;
  /** 生成标题所依据的消息 id。 */
  title_message_id: string | null;
  /** 会话 schema/版本标记。 */
  version: string;
  /** 分享链接；null 表示未分享。 */
  share_url: string | null;
  /** 摘要新增行数；null 表示无摘要。 */
  summary_additions: number | null;
  /** 摘要删除行数。 */
  summary_deletions: number | null;
  /** 摘要涉及文件数。 */
  summary_files: number | null;
  /** 摘要 diff 的 JSON 字符串。 */
  summary_diffs: string | null;
  /** revert 状态的 JSON 字符串。 */
  revert: string | null;
  /** 权限规则集的 JSON 字符串。 */
  permission: string | null;
  time_created: number;
  time_updated: number;
  /** 标题最后生成时间；null 表示未生成。 */
  time_title_updated: number | null;
  /** compact 开始时间；null 表示未在压缩。 */
  time_compacting: number | null;
  time_archived: number | null;
  /** 软删除时间；null 表示未删除。 */
  time_deleted: number | null;
  /** 最近一次轮次结果；null 表示无结果（未结束或历史数据）。 */
  last_outcome: "completed" | "error" | "interrupted" | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  /** 会话内单调序号；null 为旧数据，排序时需回落到时间戳。 */
  sequence: number | null;
  time_created: number;
  time_updated: number;
  /** 整条 MessageInfo 的 JSON。 */
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  /** 同一 message 内 part 的序号；null 表示旧数据。 */
  sequence: number | null;
  time_created: number;
  time_updated: number;
  /** 整条 MessagePart 的 JSON。 */
  data: string;
}

export interface SessionEntryRow {
  id: string;
  session_id: string;
  /** entry 类型（model_selection 等），扩展类型原样存储。 */
  type: string;
  time_created: number;
  time_updated: number;
  /** entry 内容的 JSON。 */
  data: string;
}

export interface TodoRow {
  session_id: string;
  content: string;
  /** TodoItem 状态字符串（pending/in_progress/completed）。 */
  status: string;
  /** 优先级字符串（high/medium/low）。 */
  priority: string;
  /** 会话内展示顺序，按升序读取。 */
  position: number;
  time_created: number;
  time_updated: number;
}

export interface PermissionRow {
  project_id: string;
  time_created: number;
  time_updated: number;
  /** PermissionRuleset 的 JSON。 */
  data: string;
}

export interface LocalSettingRow {
  /** 设置值（通常为 JSON 或标量字符串）。 */
  value: string;
}

export interface InputHistoryRow {
  id: string;
  project_id: string;
  /** 关联会话；null 表示尚未绑定会话的全局历史。 */
  session_id: string | null;
  /** 用户输入原文（已脱敏/截断后的展示文本）。 */
  text: string;
  /** 附件元数据的 JSON；null 表示无附件。 */
  attachments: string | null;
  /** 输入类型（如 prompt/command）。 */
  kind: string;
  time_created: number;
}
