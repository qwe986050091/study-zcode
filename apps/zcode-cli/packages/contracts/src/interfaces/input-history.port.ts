// 输入历史契约：CLI 侧的「上一条输入」记忆，供方向键召回。
// 生产者是 bootstrap input-facade（用户提交被接受后记录），消费者是同一 facade 的召回路径。
// 作用域是 project（不是 session）：同一 project 下跨会话共享历史，sessionID 只作可选溯源。
// 历史写入是尽力而为：store 缺失或写失败只降级为「本次不记录」，不得阻断用户输入。

import type { InputHistoryId, ProjectId, SessionId } from "./shared.js";

// 记录种类决定召回时的展示/回填方式：prompt=用户主动提交，steered_input=排队/引导输入，
// slash_command=命令历史。读侧按原 kind 回填，不把 steer 输入伪装成普通 prompt。
export type InputHistoryKind = "prompt" | "steered_input" | "slash_command";

// 附件引用的轻量持久化形态：只存恢复所需的 path/content，
// 不保留已解析的 artifact，避免历史记录复制大对象或依赖运行时目录。
export interface InputHistoryAttachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
}

// 一条已记录的历史输入。projectID 是召回游标的必需维度，sessionID 可选（跨会话历史可为空），
// time.created 用于按时间倒序召回；该结构会跨进程/落盘，缺字段按旧数据降级。
export interface InputHistoryEntry {
  // 历史项身份，创建时生成；用于去重与稳定引用。
  id: InputHistoryId;
  // 作用域：召回只在本 project 内进行，不能跨 project 串历史。
  projectID: ProjectId;
  // 产生该输入的 session；可选，旧数据或非会话输入可以缺失。
  sessionID?: SessionId;
  // 原始文本；召回时原样回填，不做二次规范化。
  text: string;
  // 附件引用；缺省表示纯文本输入。
  attachments?: InputHistoryAttachment[];
  // 输入种类，决定召回后以何种交互回填。
  kind: InputHistoryKind;
  // 记录时间（unix ms）；决定召回顺序，写入后不变。
  time: {
    created: number;
  };
}

// 记录输入的入参。与 entry 的差异：id 由 store 生成，time.created 可省略（store 补当前时间）。
// 调用方必须在输入真正被接受后记录，避免把被拒绝的输入写进召回历史。
export interface RecordInputHistoryInput {
  projectID: ProjectId;
  sessionID?: SessionId;
  text: string;
  attachments?: InputHistoryAttachment[];
  kind: InputHistoryKind;
  time?: {
    created?: number;
  };
}

// 召回游标：skip=0 取最近一条，skip=n 向前回溯 n 条；只按 project 过滤，不按 session。
// 越界返回 null，调用方不能把 null 当成「历史为空」之外的错误。
export interface RecallPreviousInputHistoryInput {
  projectID: ProjectId;
  skip?: number;
}

// 输入历史存储边界。写入返回 entry（store 不记录时返回 null），召回返回单条或 null；
// 两个方法都不应抛错：历史是增益能力，失败只能降级，不能阻断主输入流程。
export interface InputHistoryStorePort {
  // 记录一条已接受的输入；返回 null 表示本次未落库（如去重/策略拒绝）。
  recordInputHistory(input: RecordInputHistoryInput): Promise<InputHistoryEntry | null>;
  // 按 project 内时间倒序召回；skip 从 0 开始，找不到返回 null。
  recallPreviousInputHistory(
    input: RecallPreviousInputHistoryInput,
  ): Promise<InputHistoryEntry | null>;
}
