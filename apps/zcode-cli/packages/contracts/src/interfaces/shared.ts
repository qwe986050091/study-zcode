// ============================================================
// Shared types used across protocol
// ============================================================
// 这些 ID 是跨进程/持久化/事件边界的稳定标识：运行时仍是无前缀语义的字符串，
// 但品牌类型阻止把不同种类的 ID 互相传递。构造必须走 create* 工厂，不能手写前缀。
// 层级约定：TraceId（一次顶层任务链）> SessionId > TurnId / QueryId > MessageId / PartId / ToolCallId；
// 任何异步任务都必须能沿这棵层级回溯到 TraceId，否则视为不可观测。

// 会话身份，格式 sess_<uuid>；持久化主键与事件/请求关联都用它，不能与会话标题或路径混用。
export type SessionId = string & { readonly __brand: "SessionId" };
// 一轮执行身份，格式 turn_<uuid>；一次用户输入可能对应多个内部模型步，但只有一个 turn。
export type TurnId = string & { readonly __brand: "TurnId" };
// 事件身份，格式 evt_<uuid>；sequenceNumber 由 event store 追加时分配，二者不可互换。
export type EventId = string & { readonly __brand: "EventId" };
// 任务链身份，纯 uuid；位于 session 之上，子 session/subagent/后台任务都必须继承。
export type TraceId = string & { readonly __brand: "TraceId" };
// 一次真实用户查询身份，格式 query_<uuid>；steer/drain 会切换 query，用于正确归因 tool 请求。
export type QueryId = string & { readonly __brand: "QueryId" };
// 工具调用身份，格式 tool_<uuid>；provider 的 callID 与本地 ToolPart.callID 通过它关联。
export type ToolCallId = string & { readonly __brand: "ToolCallId" };
// 消息身份，格式 msg_<可排序段时间>；排序段保证同一毫秒内创建的消息仍可稳定排序。
export type MessageId = string & { readonly __brand: "MessageId" };
// 消息部件身份，格式 part_<可排序段时间>；part 可流式覆盖写，ID 必须在多次写之间保持不变。
export type PartId = string & { readonly __brand: "PartId" };
// 输入历史项身份，格式 input_<可排序段时间>；revoke 之后的召回依赖稳定 ID。
export type InputHistoryId = string & { readonly __brand: "InputHistoryId" };
// 项目身份，格式 proj_<uuid>；用于 project 级权限/历史/用量聚合，不是 workspace 身份。
export type ProjectId = string & { readonly __brand: "ProjectId" };
// 工作区身份，格式 ws_<uuid>；身份隔离键，与 workspacePath（文件操作路径）严格分离。
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

// 子代理发起交互请求时的来源信息。生产者是 subagent runtime，消费者是权限/交互请求投影。
// 该结构让父会话在收到请求时能定位子 session/turn/tool call，而不是只看到一个匿名请求。
// 字段带 `| string` 是有意的宽松读侧兼容：旧记录/跨进程版本可能没有品牌化 ID。
export interface SubagentInteractionRequestOrigin {
  // 来源种类固定为 subagent；新增交互来源需要新类型而不是复用本结构。
  kind: "subagent";
  // 子代理实例 id；与注册表中的 agent 生命周期对应。
  agentId: string;
  // 子代理类型（如 explore/general），用于展示与权限策略选择。
  agentType: string;
  // 子会话身份；交互请求实际发生在该会话内。
  childSessionId: SessionId | string;
  // 子会话内当前轮次；进行中请求才有，可缺失。
  childTurnId?: TurnId | string;
  // 子代理任务描述，用于 UI 标明「谁在问」。
  description?: string;
  // 父会话身份；权限决议要回溯到发起任务的父会话。
  parentSessionId: SessionId | string;
  // 父会话中触发该子代理的工具调用 id；用于把请求挂回具体 task。
  parentToolCallId?: ToolCallId | string;
  // 父会话的轮次 id；恢复投影时用于定位请求所属轮。
  parentTurnId?: TurnId | string;
}

// 交互请求来源的联合类型；当前只有子代理一种，未来新增来源必须显式扩展。
export type InteractionRequestOrigin = SubagentInteractionRequestOrigin;

// 会话 ID 工厂：已有 id 时补 sess_ 前缀，否则生成随机 uuid。持久化/协议层不得绕过工厂。
export function createSessionId(id?: string): SessionId {
  return `sess_${id ?? crypto.randomUUID()}` as SessionId;
}

// 轮次 ID 工厂：补 turn_ 前缀。turnId 必须由 admission 阶段固定，不能在 drain 时重造。
export function createTurnId(id?: string): TurnId {
  return `turn_${id ?? crypto.randomUUID()}` as TurnId;
}

// 事件 ID 工厂：补 evt_ 前缀。事件的顺序事实由 event store 的 sequenceNumber 承担，不是 ID。
export function createEventId(id?: string): EventId {
  return `evt_${id ?? crypto.randomUUID()}` as EventId;
}

// 任务链 ID 工厂：纯 uuid，不带前缀；顶层 session 创建时生成并向下继承。
export function createTraceId(): TraceId {
  return crypto.randomUUID() as TraceId;
}

// 查询 ID 工厂：补 query_ 前缀；steer 输入会拥有自己的 query 以正确切分模型请求归因。
export function createQueryId(id?: string): QueryId {
  return `query_${id ?? crypto.randomUUID()}` as QueryId;
}

// 工具调用 ID 工厂：补 tool_ 前缀；本地工具声明与 provider callID 的关联键。
export function createToolCallId(id?: string): ToolCallId {
  return `tool_${id ?? crypto.randomUUID()}` as ToolCallId;
}

// 消息 ID 工厂：补 msg_ 前缀。缺省用可排序段（时间基36 + uuid），保证同毫秒内也能稳定排序；
// 传入 id 时直接拼接，调用方必须保证不同消息不重复。
export function createMessageId(id?: string): MessageId {
  return `msg_${id ?? createSortableIdSegment()}` as MessageId;
}

// 部件 ID 工厂：补 part_ 前缀；缺省同样用可排序段，便于按创建顺序稳定展示。
export function createPartId(id?: string): PartId {
  return `part_${id ?? createSortableIdSegment()}` as PartId;
}

// 输入历史 ID 工厂：补 input_ 前缀；缺省用可排序段，召回顺序与创建时间一致。
export function createInputHistoryId(id?: string): InputHistoryId {
  return `input_${id ?? createSortableIdSegment()}` as InputHistoryId;
}

// 项目 ID 工厂：补 proj_ 前缀；project 聚合边界，不能与 workspace 身份混用。
export function createProjectId(id?: string): ProjectId {
  return `proj_${id ?? crypto.randomUUID()}` as ProjectId;
}

// 工作区 ID 工厂：补 ws_ 前缀；上游提供的不透明隔离键，禁止用会改写字符串的生成器替换。
export function createWorkspaceId(id?: string): WorkspaceId {
  return `ws_${id ?? crypto.randomUUID()}` as WorkspaceId;
}

// 可排序 ID 段：时间（base36）+ uuid。时间在前保证粗排序，uuid 兜底同一毫秒的稳定性；
// 这不是加密随机标识，不能用于鉴权或防猜测。
function createSortableIdSegment(): string {
  return `${Date.now().toString(36)}_${crypto.randomUUID()}`;
}
