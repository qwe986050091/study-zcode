/* eslint-disable max-lines -- 开发文档的数据字典需要完整列出迁移结构、字段含义和概念关系，集中维护方便校对。 */
// 本文件是 dev-docs 的静态数据源（概念、结构、流程、stdio traffic 说明与示例帧），不含运行时逻辑。
// 引用口径：概念用 id 互链，structure/flow 的 conceptIds 必须指向 concepts 中已声明的 id；
// summary/lifecycle/meaning/detail 为人工维护说明，允许换行与 markdown 片段。
// 示例帧 raw 保留原始 JSON 文本，仅作展示，不参与解析或类型校验。
// 概念分类：id 标识符 / state 状态字段 / protocol 协议接口 / runtime 运行时状态 / compat 已废弃兼容项；
// 仅用于文档分组与配色，不改变概念本身的引用关系。
//
// ============================================================
// 深度注释块 A：数据字典的不变量（DEEP-SPEC 的 L1 口径）
// ============================================================
//
// 本文件没有运行时副作用，风险全部集中在"文档与实现脱节"：读者会照着这里的
// 字段名、required 取值和示例帧直接写调用。因此注释只回答三件事：谁是事实源、
// 改哪一处必须连带改哪一处、写错以后读者会观察到什么故障。
//
// 五类数据各管一段，禁止互相复制：
//   concepts          跨模块概念字典，是 id 的唯一定义处；
//   structures        迁移形状 + 字段口径，来源指向真实 schema 或类型声明；
//   protocolSurfaces  协议方法面清单，回答"有哪些能力"；
//   flows             关键时序，回答"谁先谁后、谁等谁"；
//   stdioTraffic*     抓包示例，回答"线上二进制长什么样"。
//
// INV-1: concept.id 全文件唯一，且是 structure/field/flow 中 conceptIds 的唯一解引用目标 —— 破坏后果：按 id 建索引时后者覆盖前者，相关概念列表丢条目、跳转落空。
// INV-2: structure/flow/surface 的 id 一经发布不得改名 —— 破坏后果：深链与阅读索引指向旧锚点，定位失败且没有提示。
// INV-3: 协议 schema 变更必须同步本文件 —— 破坏后果：文档继续教旧字段名，照文档发送会被 strict 校验拒绝为 Invalid params。
// INV-4: FieldDoc.required 只有 required/optional/legacy 三态 —— 破坏后果：新增第四态不在渲染样式表内，字段徽标与图例错位。
// INV-5: legacy 表示"仍可读、新代码不可写" —— 破坏后果：写入路径继续产出 legacy 字段会被 schema 拒绝，远控链路直接断连。
// INV-6: source 是核对线索，不是可执行引用 —— 破坏后果：被当作 import 路径解析时，源文件移动会让构建失败。
// INV-7: 示例帧 raw 是纯展示字符串，不参与解析 —— 破坏后果：接入回放后假 sessionId 会写进真实 store。
// INV-8: linkedId 必须指向本数组内已存在的帧 id，且不得成环 —— 破坏后果：配对视图找不到对端，延迟列与耗时展示为空。
// INV-9: timestamp 是示例本地时间字符串，不参与排序 —— 破坏后果：改用 Date.parse 会因缺日期前缀得到 NaN，帧序被打乱。
// INV-10: 数组顺序即阅读顺序，禁止按字母重排 —— 破坏后果：时序演示失真，读者会以为 ACK 发生在 turn 事件之后。
// INV-11: concepts 的 kind 只影响分组与配色 —— 破坏后果：把 kind 当行为开关时，兼容项会被误当成可写能力隐藏。
// INV-12: 每个 structure.fields 必须覆盖 title 声称的结构 —— 破坏后果：字段缺口不会被任何单测发现，文档长期缺项。
// INV-13: compat 条目不得删除，只能标注废弃语义 —— 破坏后果：仍在线上的旧客户端搜不到迁移解释，误判字段是新增能力。
// INV-14: traceId 与 inputId 不得互相替代 —— 破坏后果：用 traceId 收口终态时同一会话多轮共享一个值，迟到事件关掉新一轮 assistant。
// INV-15: 同一事实只维护一份，字段清单以真实 schema 为准、这里不复述全文 —— 破坏后果：双源漂移后没人知道哪边过期。
// INV-16: stdioTrafficFrames 的 bytes/latencyMs 是示例常量 —— 破坏后果：用示例数字推算真实吞吐，预算与超时估算偏低。
// INV-17: message 与 parseError 互斥（message 为空才出现 parseError） —— 破坏后果：两者同时有值时查看器标红逻辑与解析结论相反。
// INV-18: 概念 id 大小写敏感且与协议字段名逐字一致 —— 破坏后果：写成 SessionId 后检索、互链、别名匹配全部失效。
// INV-19: flows 的每一步必须点名 actor（UI / host / agent），不允许写"系统" —— 破坏后果：读者无法判断该在哪一侧加日志或重试，排障时错过跨进程边界。
// INV-20: protocolSurfaces 的 fields 只是索引而非全量清单 —— 破坏后果：把索引当完整实现，新增方法永远不会出现在文档里。
//
// [维护流程] 改协议字段的顺序固定为：先改 schema，再改本文件对应 structure，
// 最后改 concepts 与 flows 的 conceptIds。反向操作会让阅读索引指向尚未存在的字段。
// 本文件与生成物不重叠：凡是能从 schema 生成的内容都不在这里手抄第二份。
// [阅读顺序] 建议按 concepts → structures → protocolSurfaces → flows → stdioTraffic
// 的次序读：先建立名词，再看形状，最后看时序；反过来读会把字段当成流程。
export type ConceptKind = "id" | "state" | "protocol" | "runtime" | "compat";

// 概念条目：id 为文档内主键并被 conceptIds 引用；aliases 为旧名/别名（可空）；
// lifecycle 描述创建→复用→清理过程；source 指向真实代码位置，便于核对而非可执行引用。
// Concept 是本文件唯一的"概念定义"形状；related 里的字符串必须是
// 本数组已存在的 id，否则渲染层拿不到对端，只能显示裸文本。
// [权衡] aliases 与 related 分开：别名用于搜索命中，相关概念用于导航，
// 合并会让"可搜索但不该推荐"的旧名污染阅读路径。
// 破坏后果：把 aliases 当 related 用，旧名会出现在相关概念列表里并指向不存在的 id。
export interface Concept {
  id: string;
  name: string;
  kind: ConceptKind;
  summary: string;
  lifecycle: string;
  owner: string;
  source: string;
  aliases?: string[];
  related: string[];
}

// 字段文档：required 区分 required/optional/legacy（legacy 表示仍兼容但应迁移）；
// oldName 记录迁移前字段名，notes 放口径例外；conceptIds 指向概念 id，允许空数组。
// FieldDoc 是"字段口径的最小单位"：meaning 写语义与空值含义，
// notes 只放例外，oldName 只放迁移映射。三者职责不能混。
// [失败路径] required 是联合字面量而不是 boolean，正是为了让 legacy 独立成态；
// 退回 boolean 时 legacy 字段会被当成可选，读者据此继续写入。
export interface FieldDoc {
  name: string;
  type: string;
  required: "required" | "optional" | "legacy";
  meaning: string;
  owner: string;
  source: string;
  conceptIds: string[];
  oldName?: string;
  notes?: string;
}

// 数据结构文档：oldShape/newShape 为迁移前后的形状描述（纯文本，可为代码片段）；
// migration 说明迁移动作；fields 为字段清单，允许为空但会导致文档缺口。
// StructureDoc 描述"迁移前后的形状 + 字段清单"；newShape 必填、
// oldShape 可选：缺 oldShape 表示这是新增结构而非改名，语义与空字符串不同。
// [权衡] shape 用纯文本而不是类型：它是给读者看的对照表，一旦写成真实类型
// 就会与 schema 形成第二份实现，改一处忘一处时两边都"能编译"却互相矛盾。
export interface StructureDoc {
  id: string;
  title: string;
  path: string;
  purpose: string;
  oldShape?: string;
  newShape: string;
  migration: string;
  fields: FieldDoc[];
}

// 流程步骤：actor 标注发起方（如 "UI -> host -> agent server"），detail 描述时序与不变量；
// conceptIds 供文档从流程跳转到概念定义。
// FlowStep 是时序的最小单位：actor 用箭头写出跨进程边界，
// detail 里嵌"必须 / 只有 / 不得"这类不变量，而不是复述接口参数。
// 破坏后果：detail 只写"做什么"时，读者无法判断哪一步是收敛点，
// 会以为 ACK 之后就可以结束展示。
export interface FlowStep {
  id: string;
  title: string;
  actor: string;
  detail: string;
  conceptIds: string[];
}

// traffic 帧方向：写入 agent stdin、读 agent stdout、或 agent stderr 旁路。
// 方向只有三种取值，由写入端决定，不由解析结果推断：
// 解析失败的行仍保留原方向，否则排障时会误以为方向本身出了错。
export type StdioTrafficDirection = "app-to-agent" | "agent-to-app" | "agent-stderr";

// 查看器归纳的帧类型；stderr 帧固定为 "stderr"，不参与 request/response 配对。
// [权衡] stderr 单独成为一种 kind，而不是借用 notification：
// 它不参与 request/response 配对，借壳会让耗时统计把旁路日志算进 RPC。
export type StdioTrafficKind = "request" | "response" | "notification" | "stderr";

// 示例帧（静态数据，非实时抓取）：timestamp 为示例本地时间字符串，bytes 为原始行字节数；
// latencyMs 仅对能配对的 response 有意义，linkedId 指向配对帧 id；
// raw 必须是原始文本（stdin/stdout 为单行 JSON，stderr 可为普通文本）。
// 帧结构是"查看器归纳后的形状"，不是协议本身的类型：
// 它与真实 NDJSON 记录一一对应，但字段留空表示该行没有这个概念。
// 破坏后果：把 kind 当协议字段传给后端时，stderr 帧会被误当成 notification。
export interface StdioTrafficFrame {
  id: string;
  timestamp: string;
  direction: StdioTrafficDirection;
  kind: StdioTrafficKind;
  method?: string;
  messageId?: string;
  sessionId?: string;
  inputId?: string;
  summary: string;
  bytes: number;
  latencyMs?: number;
  linkedId?: string;
  raw: string;
}

// traffic 日志字段说明：type 为展示用类型字符串（非 TS 类型），meaning 说明口径与空值语义。
// [权衡] 只保留 name/type/meaning 三列：traffic 记录本身是 NDJSON，
// 加更多列会诱导读者以为存在对应的 TS 类型，而实际解析结果是动态对象。
export interface StdioTrafficLogField {
  name: string;
  type: string;
  meaning: string;
}

// 文件读取步骤：command 为可直接执行的 shell 示例，detail 说明适用场景与观察重点。
// [失败路径] command 是"可直接复制执行"的示例，路径为约定值；
// 因此它不能被当成跨平台保证，Windows 下需要读者自行换算。
export interface StdioTrafficReadStep {
  id: string;
  title: string;
  command: string;
  detail: string;
}

// 概念字典（人工维护，按主题排序）：id 全文件唯一；related 为相关概念 id 列表，可为空。
// 新增概念后需同步 structures/flows 的 conceptIds，否则文档链接悬空。
// 概念数组是 id 的唯一定义处：新增条目必须先落这里，再去写
// structures/flows 的引用。反过来先写引用会让阅读索引指向不存在的概念。
// [权衡] 按主题而不按字母排序：阅读动线是 id → state → protocol → runtime →
// compat，字母序会把兼容项混进主流程中间。
// 破坏后果：删除任一条目都会让其它三处的 conceptIds 变成悬空引用。
// [失败路径] 缺 aliases 时旧名搜不到，只能靠 summary 里的文字碰运气。
export const concepts: Concept[] = [
  // sessionId 只能由 agent server 分配：UI 若先用本地临时 id 建会话再对齐，
  // resume 之后同一个 workspace 会出现两条记录，历史消息归到错的那一条。
  // 隐含前提：所有 envelope、message、part 都回带同一个 sessionId，
  // 因此它是跨进程唯一可信的会话归属键。
  // [失败路径] 读者若把它当成 UI 生成值，会在 create 之前就自造 id 发 send，
  // strict 校验返回 Invalid params，且错误不会提示"请先创建会话"。
  {
    id: "sessionId",
    name: "sessionId",
    kind: "id",
    summary: "Agent server 生成的会话主键，ZCode Protocol 里的核心实体 ID。",
    lifecycle:
      "由 `session/create` 创建；`session/resume` 复用；会随 snapshot、event、message、part 全程回传。",
    owner: "agent server",
    source: "apps/zcode-cli/packages/contracts/src/interfaces/shared.ts#createSessionId",
    aliases: ["legacy acpSessionId"],
    related: ["taskId", "traceId", "turnId", "messageId"],
  },
  // [权衡] 保留 taskId 而不是直接改叫 sessionId：迁移期 task 列表、本地缓存与
  // 历史导航仍以它为键，立即改名会让旧数据失去索引。
  // 它唯一的职责是"进入协议前找到对应 sessionId"，不参与任何协议校验。
  // 破坏后果：把 taskId 直接当 sessionId 发出去，create 可能成功但 send 一直 not found。
  {
    id: "taskId",
    name: "taskId",
    kind: "id",
    summary: "App/UI 任务列表里的产品层 ID。ZCode Agent 路径迁移后应等同或映射到 sessionId。",
    lifecycle:
      "UI task 列表、缓存、导航和本地持久化使用；进入 ZCode Protocol 时必须找到对应 sessionId。",
    owner: "app/ui",
    source: "packages/shared/src/zcode-task-types.ts#ZCodeTaskMeta",
    related: ["sessionId", "workspaceKey", "activeInputId"],
  },
  // [权衡] traceId 留在 envelope 上但不承担输入归属：链路观测需要一个跨 session
  // 关联的值，而 inputId 是 session 内语义，合并会把两种能力一起丢掉。
  // 破坏后果：若再用 traceId 判断"是否当前输入"，同一会话多轮输入共享同一 trace，
  // 迟到的 completed 会把新 turn 的运行态提前关掉。
  // 隐含前提：trace 在 create 时生成一次，此后只读、不随输入变化。
  {
    id: "traceId",
    name: "traceId",
    kind: "id",
    summary: "观测链路 ID，用于日志、事件 envelope、调试面板和跨模块追踪，不再表示一次用户输入。",
    lifecycle:
      "当前 agent server 在创建 session record 时用 UUID 生成 root trace；之后事件 envelope 带同一观测 trace。",
    owner: "agent runtime / protocol server",
    source:
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts#createProtocolTraceId",
    aliases: ["protocol trace", "envelope.traceId"],
    related: ["inputId", "sessionId", "eventEnvelope"],
  },
  // inputId 由 UI 在"真正提交"的瞬间生成（含队列 drain），agent 只做
  // 原样回带、不解析业务含义，因此它是唯一跨进程可信的相关性键。
  // 隐含前提：同一次提交重试必须复用同一个 inputId；换新 id 会让上一次 ACK
  // 对应的终态变成孤儿，UI 永远等不到收口。
  // [失败路径] 省略 inputId 时事件仍能流动，但 UI 无法区分迟到终态，
  // 表现为偶发"点了停止却仍在跑"。
  {
    id: "inputId",
    name: "inputId",
    kind: "id",
    summary: "每次用户提交输入的归属 ID，用于发送、排队、stop、终态事件收口和 UI stale 判断。",
    lifecycle:
      "UI 在每次直接发送、首发、队列 drain 时创建；通过 `session/send.inputId` 传给 agent；agent 在 turn 事件 payload 里原样回带。",
    owner: "app/ui creates, agent echoes",
    source: "packages/shared/src/zcode-task-types.ts#createInputId",
    aliases: ["clientMessageId 的新名", "per-input id"],
    related: ["activeInputId", "pendingInputId", "traceId"],
  },
  // [并发] 这是 UI 侧"当前消费者"指针：写入与清理必须成对，且清理只能由
  // inputId 匹配的终态事件触发。
  // 破坏后果：无条件清空时，A 轮次的 completed 会把 B 轮次置为 idle，
  // 停止按钮消失但 agent 仍在执行。
  // [权衡] 放在 renderer 而不是 server：它描述"本端正在等谁"，
  // 多端同时观察同一 session 时每端的值本来就不同。
  {
    id: "activeInputId",
    name: "activeInputId",
    kind: "runtime",
    summary: "UI store 里当前正在运行的 inputId，用来保护 stop、立即发送和迟到终态事件。",
    lifecycle:
      "直接发送或队列 drain 开始时写入；收到匹配 inputId 的 completed/failed 后清理或被下一轮覆盖。",
    owner: "renderer store",
    source: "packages/ui/src/store/zcodeSessionStoreTypes.ts#TaskRuntimeState",
    aliases: ["activeRunId 的新名"],
    related: ["inputId", "taskRuntimeState", "taskStreamMirrorBatch"],
  },
  // [失败路径] 保留 compat 条目只为回答"旧字段去哪了"，它不在任何新写入路径上。
  // 破坏后果：继续发送 clientMessageId 会被 strict 校验拒绝为 Invalid params，
  // 而错误信息不会提示应改成 inputId。
  // 隐含前提：旧客户端仍在线上，因此该条目只能标注、不能随迁移完成而删除。
  {
    id: "clientMessageId",
    name: "clientMessageId",
    kind: "compat",
    summary: "旧字段名，过去承载 UI 每次 prompt 的相关性 ID；已统一改名为 inputId。",
    lifecycle: "旧协议字段；新 ZCode Protocol schema 不再接受它，继续发送会触发 Invalid params。",
    owner: "deprecated",
    source: "dae26032: packages/shared/src/zcode-protocol/index.ts",
    related: ["inputId", "sessionSend"],
  },
  // [失败路径] 与 clientMessageId 同源的旧 UI 字段；它一直不是观测 trace，
  // 而是"当前输入归属"，改名只是让名字追上语义。
  // 破坏后果：按字面把它当 run id 使用，会把日志 trace 与输入归属混为一谈，
  // stop 与 stale 判断随之失效。
  {
    id: "activeRunId",
    name: "activeRunId",
    kind: "compat",
    summary: "旧 UI store 字段名，语义不是观测 trace，而是当前输入归属；已改为 activeInputId。",
    lifecycle:
      "旧 renderer runtime 字段；新代码只在少数 replayable/mirror legacy 字段里保留 runId 名称。",
    owner: "deprecated",
    source: "dae26032: packages/ui/src/store/zcodeSessionStoreTypes.ts",
    related: ["activeInputId", "taskRuntimeState"],
  },
  // [并发] 它与 UI 的 inputId 不是同一命名空间：前者是 agent 侧 steer 队列项，
  // 后者是 UI 侧一次提交，二者只在 drained/discarded/rejected 里通过 payload 关联。
  // 破坏后果：拿 pendingInputId 比对 activeInputId 永远不相等，UI 一直显示
  // "排队中"，而 agent 早已消费完。
  // 隐含前提：队列项可能被丢弃，因此它不能当作"必然有结果"的句柄。
  {
    id: "pendingInputId",
    name: "pendingInputId",
    kind: "id",
    summary: "Agent-side turn steering 队列里的等待项 ID，不等同于 UI inputId。",
    lifecycle:
      "运行中追加输入被 agent 接收为 steer queue 时生成；drained/discarded/rejected 事件回带。",
    owner: "agent runtime",
    source:
      "apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts#PendingSteerInputInfo",
    related: ["inputId", "turnId", "turnSteerQueued"],
  },
  // turnId 由 agent runtime 在 turn 启动时创建，是 turn 内事件的归属键；
  // 一个 inputId 通常对应一个 turnId，但 steer 追加输入会复用已有 turnId。
  // 破坏后果：把二者当一对一映射后，steer 场景的投影会把同一 turn 的两次输入
  // 算成两个并发 turn，进度条与停止按钮出现两份。
  {
    id: "turnId",
    name: "turnId",
    kind: "id",
    summary: "Agent core 中一次 turn 的主键；一个 inputId 通常启动或归属到一个 turnId。",
    lifecycle: "agent runtime 在 turn 启动时创建；所有 turn 内事件可携带。",
    owner: "agent runtime",
    source: "apps/zcode-cli/packages/contracts/src/interfaces/shared.ts#createTurnId",
    related: ["sessionId", "inputId", "messageId"],
  },
  // messageId 是消息 upsert/remove 的主键，也是 part 的父键；
  // 流式增量必须围绕同一个 messageId 累积，换 id 等于换了一条消息。
  // 破坏后果：若每帧都新建 messageId，transcript 会碎成多条 assistant 消息，
  // 冷恢复后与实时视图对不上。
  {
    id: "messageId",
    name: "messageId",
    kind: "id",
    summary: "消息主键，标识 user/assistant message。",
    lifecycle: "消息创建时生成；message upsert/remove、part、snapshot 都围绕它组织。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeMessageInfo",
    related: ["partId", "sessionId", "turnId"],
  },
  // partId 决定细粒度更新的作用域：text/reasoning/tool/patch 各自一条
  // part，delta 只追加到同 partId 上。
  // 破坏后果：partId 不稳定时 delta 找不到宿主，投影只能整段替换，
  // 表现为流式文字闪烁、思考块重复。
  {
    id: "partId",
    name: "partId",
    kind: "id",
    summary: "消息内部 part 的主键，用于 text、reasoning、tool、patch、compaction 等细粒度更新。",
    lifecycle: "part.started/upserted/delta/remove 时使用。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeMessagePart",
    related: ["messageId", "toolCallId"],
  },
  // [并发] toolCallId 在 scheduled/started/progress/result/error 全流程保持稳定，
  // 权限请求也挂在它上面，因此它是工具状态机的唯一键。
  // 破坏后果：result 换用新 id 时，call-runner 的配对逻辑找不到原调用，
  // ToolPart 会永远停在 running。
  {
    id: "toolCallId",
    name: "toolCallId",
    kind: "id",
    summary: "工具调用主键，用于工具状态、权限请求和 active tool projection。",
    lifecycle: "工具 scheduled/started/progress/result/error 流程中保持稳定。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeActiveToolCall",
    related: ["partId", "permissionRequest"],
  },
  // [事务] 权限是阻塞交互：server 发起、host 按 owner 路由、结果经
  // permission.resolved 回到 session，三处必须引用同一个 toolCallId。
  // 破坏后果：owner 路由丢掉后审批落到别的 client，原请求永远 pending，
  // 工具调用卡死到超时。
  // 隐含前提：UI 重连时必须能从 snapshot 的 pendingPermissions 恢复，
  // 否则刷新页面就等于丢掉了这次审批。
  {
    id: "permissionRequest",
    name: "permission request",
    kind: "protocol",
    summary: "Agent 请求用户批准工具调用或风险操作的阻塞交互。",
    lifecycle:
      "server 发起 `interaction/requestPermission`；host 路由给 owner client；结果通过 permission.resolved 回到 session。",
    owner: "agent server + host owner routing",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodePermissionRequestParamsSchema",
    related: ["toolCallId", "deliveryKind", "sessionId"],
  },
  // [并发] 这个事件是 steer 队列的唯一状态出口：queued 之后必然出现
  // drained/discarded/rejected 之一，UI 只据此更新"排队中"。
  // 破坏后果：UI 在 queued 时就把输入当已发送，drained 之前用户会看到
  // 两条相同输入，且第二次发送被误判为重复。
  {
    id: "turnSteerQueued",
    name: "turn.steerQueued",
    kind: "protocol",
    summary: "运行中追加输入被 agent-side queue 接收后的事件。",
    lifecycle:
      "UI 在 busy 时提交输入；agent 返回 pendingInputId，并在 drained/discarded/rejected 中更新状态。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeTurnSteerQueuedEventPayloadSchema",
    related: ["pendingInputId", "turnId", "inputId"],
  },
  // [并发] seq 是 session 内单调递增的水位：replayable 链路用它做 gap 检测，
  // 一旦断档必须重新取 snapshot，而不是继续追加。
  // 破坏后果：忽略 gap 直接应用事件，投影会缺中间状态，出现"工具结果没有调用"。
  // [权衡] 按 session 而不是全局递增：全局序号会让单会话重放依赖其他会话的写入。
  {
    id: "eventSeq",
    name: "eventSeq / seq",
    kind: "protocol",
    summary: "Session 事件日志的单调递增序号，是 replayable 恢复和 gap 检测的水位。",
    lifecycle:
      "每个 session 独立递增；desktop continuous 可实时消费，web remote replayable 必须用 afterSeq 补齐。",
    owner: "agent server",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeEventEnvelopeSchema",
    aliases: ["seq"],
    related: ["deliveryKind", "eventEnvelope"],
  },
  // [权衡] 用一个字段区分"实时可丢"和"可恢复必须补齐"，而不是让客户端各自猜：
  // 猜错的代价是手机端丢事件且无法自查。
  // 破坏后果：把 replayable 当 continuous 消费，重连后会静默跳过缺口。
  {
    id: "deliveryKind",
    name: "deliveryKind",
    kind: "protocol",
    summary: "区分桌面实时链路和手机远控可恢复链路。",
    lifecycle:
      "`session/read`、`session/subscribe` 和事件 envelope 可携带；影响 snapshot/replay 行为。",
    owner: "host / protocol client",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeDeliveryKindSchema",
    related: ["eventSeq", "taskStreamMirrorBatch"],
  },
  // 身份 key 统一为 workspaceIdentity 去空白后回退 workspacePath，
  // 去重、绑定、缓存、队列、持久化全部用它做隔离。
  // 破坏后果：某处改用 workspacePath 直接比较时，同一远程 workspace 在
  // SSH 重连后会分裂成两份缓存与两条队列。
  // 隐含前提：本地没有 identity，因此回退分支必须永远保留。
  {
    id: "workspaceKey",
    name: "workspaceKey",
    kind: "state",
    summary: "workspace 身份隔离 key，优先使用 workspaceIdentity，缺省回退 workspacePath。",
    lifecycle: "用于 tab、缓存、队列、持久化、远程历史匹配等身份/隔离语义。",
    owner: "app/host",
    source: "AGENTS.md Workspace Identity 约束",
    related: ["workspacePath", "workspaceIdentity", "taskId"],
  },
  // [权衡] 路径只承担执行语义（cwd、读写、Git、展示），不承担身份判等：
  // 远程路径在不同挂载点下可能相同，直接比路径会把两台机器混为一谈。
  // 破坏后果：用路径做 Map key 时，同一路径的本地与远程会话互相覆盖。
  {
    id: "workspacePath",
    name: "workspacePath",
    kind: "state",
    summary: "真实文件路径，只用于文件读写、命令 cwd、Git 操作和路径展示。",
    lifecycle: "本地 workspace 通常直接使用；远程 workspace 不能只靠它做身份判等。",
    owner: "app/host",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeWorkspaceRef",
    related: ["workspaceIdentity", "workspaceKey"],
  },
  // 远程 workspace 的稳定身份（authority + canonicalPath），
  // SSH/WSL/Docker 必须传；本地允许为空并回退路径。
  // 破坏后果：远程不带 identity 时，重连会被当成新 workspace，历史与会话全部丢失。
  {
    id: "workspaceIdentity",
    name: "workspaceIdentity",
    kind: "state",
    summary: "远程 workspace 的稳定身份，表达 authority + canonicalPath。",
    lifecycle: "远程 SSH/WSL/Docker 必须传递；本地允许为空并回退 workspacePath。",
    owner: "app/host",
    source: "AGENTS.md Workspace Identity 约束",
    related: ["workspacePath", "workspaceKey"],
  },
  // envelope 只描述"事件在日志里的位置与观测链路"，不描述输入归属；
  // payload.inputId 才是归属。两者混用是本文件最容易被误读的地方。
  // 破坏后果：把 envelope.traceId 当输入 id 后，同一会话多轮事件无法区分，
  // 终态收口逻辑会把任意一轮的 completed 当成当前轮。
  {
    id: "eventEnvelope",
    name: "ZCode Event Envelope",
    kind: "protocol",
    summary:
      "ZCode Protocol 事件外壳，承载 eventId、sessionId、turnId、seq、traceId、timestamp、deliveryKind。",
    lifecycle: "所有 `session/event` 通知和 `session/events` 读取结果都使用它。",
    owner: "agent server",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeEventEnvelopeSchema",
    related: ["sessionId", "traceId", "eventSeq", "deliveryKind"],
  },
  // [事务] send 是"接纳"而不是"完成"：立即 ACK 只表示输入进入 admission，
  // 后续进度全部走事件流。文档必须把这两件事分开写，否则读者会把 ACK 当结果。
  // 破坏后果：客户端等 send 返回值当最终输出时，UI 会提前结束流式展示；
  // 把 ACK 当 durable 提交时，崩溃后重放会重复执行同一输入。
  {
    id: "sessionSend",
    name: "session/send",
    kind: "protocol",
    summary: "提交用户输入的 ZCode Protocol 方法，立即 ACK，不等待整轮模型生成完成。",
    lifecycle: "client 调用后，agent 后台执行 turn，并通过 session.event/state.updated 推送进度。",
    owner: "protocol client -> agent server",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeSessionSendParamsSchema",
    related: ["sessionId", "inputId", "traceId"],
  },
  // [权衡] renderer 只保存视觉需要的 transient 状态：把它当 authoritative
  // 会让刷新后的 UI 与 server 投影分叉，且无法解释"谁赢"。
  // 破坏后果：用 store 的 status 决定是否发送，本地以为已结束而 server 仍在跑，
  // 新输入会与上一轮并发。
  {
    id: "taskRuntimeState",
    name: "TaskRuntimeState",
    kind: "runtime",
    summary: "Renderer store 的 task 运行态，只保存 UI 运行需要的 transient 信息。",
    lifecycle: "随 stream、snapshot、queue 和 stop 操作更新；不能作为 server authoritative state。",
    owner: "renderer store",
    source: "packages/ui/src/store/zcodeSessionStoreTypes.ts#TaskRuntimeState",
    related: ["activeInputId", "deliveryKind"],
  },
  // [并发] mirror 批次记录"运行中流式 op 的 seq 区间"，web remote 用
  // batchSeq/fromSeq/toSeq 补齐缺口；runId 是历史字段名而非观测 trace。
  // 破坏后果：按字面把 runId 理解成 trace 时，缺口恢复会去比观测 id，
  // 永远对不上批次，重连后丢失整段流式内容。
  {
    id: "taskStreamMirrorBatch",
    name: "TaskStreamMirrorBatch",
    kind: "runtime",
    summary:
      "手机远控 replayable 链路的 stream mirror 批次。字段名 runId 保留兼容，但语义上对应当前 input/mirror run。",
    lifecycle: "host 记录运行中流式 op；web remote 用 batchSeq/fromSeq/toSeq 恢复缺口。",
    owner: "host runtime",
    source: "packages/shared/src/zcode-task-types.ts#TaskStreamMirrorBatch",
    related: ["inputId", "activeInputId", "deliveryKind", "eventSeq"],
  },
];

// 结构迁移字典：覆盖协议/运行时/持久化等结构的旧形与新形，顺序即文档目录展示顺序。
// fields 逐字段描述口径；required=legacy 表示仍可读但新代码不应写入。
// 结构数组按"总纲 → 协议参数 → 事件 → 运行时 → 快照 → 身份 → 遗留"
// 排列，顺序本身就是讲解顺序，不是按文件或字母序。
// [权衡] 每个结构的 fields 只保留有解释价值的字段，不复述 schema 全部属性，
// 避免出现第二份实现。
// 破坏后果：把某个结构挪到前面会打断"先总纲后细节"的阅读路径。
export const structures: StructureDoc[] = [
  // 这一篇是其它结构的"总纲"：先讲清 trace 与 input 的分工，
  // 后面每个结构只补充自己的差异。改这里必须回头检查所有 fields 的语义。
  // [权衡] 迁移写"字段改名 + 语义收窄"两件事，而不是只列映射表：
  // 只给映射时读者会以为只是换名，继续用新字段承载旧语义，问题原样保留。
  // 隐含前提：legacy runId/ownerRunId 仍在协议面上，因此迁移说明必须交代
  // 它们"语义上等于 inputId"，否则读者会当成第三种东西。
  // 破坏后果：把 traceId 与 inputId 合并回一个字段，三端收口逻辑全部要重写。
  // [失败路径] 若这里漏掉 taskId 到 sessionId 的映射，按文档实现时会在
  // send 阶段才发现找不到会话，而错误信息不会指向本页。
  {
    id: "id-migration",
    title: "ID 语义迁移总览",
    path: "跨 UI / host / agent / ZCode Protocol",
    purpose:
      "把观测链路 traceId 和用户输入归属 inputId 拆开，解决 UI 状态收口、stop、队列和协议 schema 不一致。",
    oldShape:
      "traceId 同时承担日志追踪和每次 prompt 的 run/clientMessage 语义；UI 字段叫 activeRunId，协议字段叫 clientMessageId。",
    newShape:
      "traceId 只做观测链路；inputId 做每次用户输入归属；activeInputId 保存当前运行输入；sessionId 仍由 agent server 分配。",
    migration:
      "`clientMessageId -> inputId`，`activeRunId -> activeInputId`，`currentTraceIdRef -> currentInputIdRef`；保留 legacy runId/ownerRunId 字段时要注明它们语义上是 inputId。",
    fields: [
      {
        name: "traceId",
        type: "string / UUID",
        required: "required",
        meaning:
          "观测链路 ID，只用于日志、session event envelope、debug trace，不用于判断当前 prompt 是否完成。",
        owner: "agent runtime",
        source: "createProtocolTraceId / createTraceId",
        conceptIds: ["traceId"],
        notes:
          "旧实现用 `t-${taskId}-${time}-${random}` 且被当成 prompt run id；新实现对齐 agent UUID。",
      },
      {
        name: "inputId",
        type: "string / UUID",
        required: "optional",
        meaning: "每次用户提交输入的相关性 ID。缺省兼容旧事件，但新发送路径都应传。",
        owner: "app/ui creates, agent echoes",
        source: "createInputId",
        conceptIds: ["inputId"],
        oldName: "clientMessageId",
      },
      {
        name: "activeInputId",
        type: "InputId | undefined",
        required: "optional",
        meaning:
          "当前正在执行的输入 ID。迟到 completed/failed 如果不匹配它，不能关闭当前 assistant。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["activeInputId"],
        oldName: "activeRunId",
      },
      {
        name: "sessionId",
        type: "sess_${uuid}",
        required: "required",
        meaning:
          "ZCode Protocol 会话主键，由 agent server 生成并在 snapshot/event/message 中回传。",
        owner: "agent server",
        source: "createSessionId",
        conceptIds: ["sessionId"],
      },
      {
        name: "taskId",
        type: "string",
        required: "required",
        meaning:
          "App 产品层任务 ID。迁移期仍存在，但 ZCode Agent 路径进入协议时要找到对应 sessionId。",
        owner: "app/ui",
        source: "ZCodeTaskMeta",
        conceptIds: ["taskId", "sessionId"],
      },
    ],
  },
  // [事务] 该结构的 oldShape/newShape 只差一个字段名，但语义差一整层：
  // 改名同时把"相关性 id"从 trace 语义里剥离出来。
  // [失败路径] migration 那句"继续发送 clientMessageId 会 Invalid params"是
  // 给读者的唯一提示，不能删；strict 校验的报错并不指名应改成哪个字段。
  // 隐含前提：expectedRevision 是可选的乐观并发控制，省略时 server 不做
  // 版本比对，因此文档不能把它写成必填。
  // [权衡] content 允许已注入技能或已文本化附件：协议层只搬最终文本，
  // 不在 server 侧重放附件解析。
  {
    id: "zcode-session-send",
    title: "ZCodeSessionSendParams",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose: "`session/send` 的参数结构。它只提交输入并立即 ACK，结果通过事件流返回。",
    oldShape: "{ sessionId, clientMessageId?, content, attachments?, expectedRevision? }",
    newShape: "{ sessionId, inputId?, content, attachments?, expectedRevision? }",
    migration: "协议 schema 已 strict 校验，继续发送 clientMessageId 会 Invalid params。",
    fields: [
      {
        name: "sessionId",
        type: "string",
        required: "required",
        meaning:
          "目标 agent session。不是 UI 临时生成值，必须来自 `session/create` 或 `session/resume`。",
        owner: "agent server",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionId", "sessionSend"],
      },
      {
        name: "inputId",
        type: "string",
        required: "optional",
        meaning: "本次用户输入的相关性 ID；agent 不解析业务含义，只在 turn payload 里原样回带。",
        owner: "app/ui",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["inputId", "sessionSend"],
        oldName: "clientMessageId",
      },
      {
        name: "content",
        type: "string",
        required: "required",
        meaning: "用户提交给 agent 的最终文本，可以已经过技能注入或附件文本化。",
        owner: "app/ui",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionSend"],
      },
      {
        name: "attachments",
        type: "Record<string, unknown>[]",
        required: "optional",
        meaning: "图片、音频或文件附件的协议投影。普通文件可带 textContent，二进制附件带 base64。",
        owner: "app/ui",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionSend"],
      },
      {
        name: "expectedRevision",
        type: "number",
        required: "optional",
        meaning: "乐观并发控制的 session stateRevision；不匹配时 server 可拒绝以避免覆盖旧状态。",
        owner: "app/ui + agent server",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionSend"],
      },
    ],
  },
  // [并发] turn payload 的 inputId 是 UI 收口的唯一依据；envelope.traceId
  // 仍随事件走，但不参与"是否当前输入"的判断。
  // 该结构的字段来源跨两个文件（shared 协议与 contracts 事件），
  // 因此 source 逐个字段写具体类型名，便于核对而不是指向整页。
  // [失败路径] cacheStats 曾被 strict 校验丢掉，导致终态事件整条被拒；
  // 这里保留该字段的说明，提醒实现方"新增 payload 字段必须同步 schema"。
  // 隐含前提：turnPhase 只对 failed 有意义，success 路径不读它。
  // 破坏后果：若投影改为读 envelope.traceId，迟到终态会关闭新的 assistant。
  {
    id: "turn-event-payloads",
    title: "Turn Event Payloads",
    path: "packages/shared/src/zcode-protocol/index.ts + apps/zcode-cli/packages/contracts/src/events/session.events.ts",
    purpose:
      "turn.started / steerQueued / completed / failed 用 payload.inputId 把 agent 回流事件归属到某次 UI 输入。",
    oldShape: "turn payloads 使用 clientMessageId。",
    newShape: "turn payloads 使用 inputId；event envelope.traceId 保持观测 trace。",
    migration: "Projection 层读取 payload.inputId，不再把 envelope.traceId 改写成 prompt id。",
    fields: [
      {
        name: "turnNumber",
        type: "number",
        required: "required",
        meaning: "session 内第几轮 turn，主要用于展示和 reducer 投影。",
        owner: "agent runtime",
        source: "TurnStartedPayload",
        conceptIds: ["turnId"],
      },
      {
        name: "input",
        type: "string",
        required: "required",
        meaning: "启动 turn 的用户输入文本或 steer 队列文本。",
        owner: "agent runtime",
        source: "TurnStartedPayload / TurnSteerQueuedPayload",
        conceptIds: ["inputId"],
      },
      {
        name: "inputId",
        type: "string",
        required: "optional",
        meaning: "归属到 UI 这次提交；completed/failed 必须用它判断是否是当前 activeInputId。",
        owner: "agent echoes",
        source: "TurnStartedPayload / TurnCompletePayload / TurnErrorPayload",
        conceptIds: ["inputId", "activeInputId"],
        oldName: "clientMessageId",
      },
      {
        name: "pendingInputId",
        type: "string",
        required: "required",
        meaning: "turn steering 队列项 ID，用于后续 drained/discarded/rejected 对齐。",
        owner: "agent runtime",
        source: "TurnSteerQueuedPayload",
        conceptIds: ["pendingInputId", "turnSteerQueued"],
      },
      {
        name: "targetTurnId",
        type: "string",
        required: "required",
        meaning: "排队输入要注入的目标 active turn。",
        owner: "agent runtime",
        source: "TurnSteerQueuedPayload",
        conceptIds: ["turnId", "pendingInputId"],
      },
      {
        name: "cacheStats",
        type: "{ totalMessages, cachedMessages, lastCacheHit, cacheReadTokens? }",
        required: "optional",
        meaning: "turn.completed 里的缓存统计。新 schema 补齐该字段，避免 strict 校验丢终态事件。",
        owner: "agent runtime",
        source: "zcodeTurnCompletedEventPayloadSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "resultType",
        type: "success | error_max_turns | error_max_budget | error_during_execution | error_max_tool_calls",
        required: "required",
        meaning: "turn 完成原因，UI 用于区分正常完成和预算/工具/执行错误。",
        owner: "agent runtime",
        source: "TurnCompletePayload",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "turnPhase",
        type: "string",
        required: "required",
        meaning: "turn.failed 发生在哪个执行阶段，用于日志和错误展示。",
        owner: "agent runtime",
        source: "TurnErrorPayload",
        conceptIds: ["eventEnvelope"],
      },
    ],
  },
  // host 到 renderer 的事件同时带 traceId 与可选 inputId，是本文件
  // "两个 id 并存"最典型的样本：一个给日志，一个给收口。
  // [权衡] 所有可 mirror 的事件统一扩展 inputId 而不是新建并行事件类型：
  // 新类型会让 host 需要维护两套广播路径，漏发时手机端直接看不到。
  // 破坏后果：终态过滤若回退到 taskId，同一 task 的连续两轮输入无法区分。
  // 隐含前提：parentToolUseId 为 null 表示主 agent 正文，子 agent 事件必须
  // 带父 id，否则工具树无法归位。
  // [失败路径] error 正文是远控恢复时唯一的失败解释来源，不能省略。
  {
    id: "zcode-stream-event",
    title: "ZCodeStreamEvent / TaskStreamMirrorableEvent",
    path: "packages/shared/src/zcode-task-types.ts",
    purpose: "Host 到 renderer 的实时事件结构。现在同时携带 traceId 和可选 inputId。",
    oldShape: "每个 stream event 只有 traceId；UI 把它当 run id 使用。",
    newShape: "stream event 保留 traceId 做观测，同时新增 inputId 做输入归属。",
    migration:
      "所有可 mirror 的事件统一 `& { inputId?: InputId }`，终态事件优先用 inputId 过滤 stale。",
    fields: [
      {
        name: "type",
        type: "string union",
        required: "required",
        meaning: "事件类型，如 agent_message_chunk、tool_call、task_complete、task_error。",
        owner: "host/runtime",
        source: "ZCodeStreamEvent",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "taskId",
        type: "string",
        required: "required",
        meaning: "UI task 归属，用于找到对应消息列表、runtime state 和 task cache。",
        owner: "app/host",
        source: "ZCodeStreamEvent",
        conceptIds: ["taskId"],
      },
      {
        name: "traceId",
        type: "TraceId",
        required: "required",
        meaning: "观测 trace。日志、调试、链路排查使用，不再做 prompt 终态收口。",
        owner: "host/runtime",
        source: "ZCodeStreamEvent",
        conceptIds: ["traceId"],
      },
      {
        name: "inputId",
        type: "InputId",
        required: "optional",
        meaning: "事件所属用户输入。terminal complete/error 优先用它与 activeInputId 比较。",
        owner: "host/runtime echoes",
        source: "TaskStreamMirrorableEvent & ZCodeStreamEvent",
        conceptIds: ["inputId", "activeInputId"],
      },
      {
        name: "parentToolUseId",
        type: "string | null",
        required: "optional",
        meaning: "子 agent 或工具嵌套关系；null 表示主 agent 正文或主 agent 工具调用。",
        owner: "agent runtime",
        source: "ZCodeStreamEvent / TaskStreamMirrorableEvent",
        conceptIds: ["toolCallId"],
      },
      {
        name: "messageId",
        type: "string",
        required: "optional",
        meaning: "ZCode message upsert 主键；synthetic timeline 消息也用它做稳定更新。",
        owner: "agent runtime",
        source: "ZCodeStreamEvent",
        conceptIds: ["messageId"],
      },
      {
        name: "toolId",
        type: "string",
        required: "optional",
        meaning: "工具调用 ID；tool_call 与 tool_call_update 共享。",
        owner: "agent runtime",
        source: "ZCodeStreamEvent tool update",
        conceptIds: ["toolCallId"],
      },
      {
        name: "stopReason",
        type: "string",
        required: "optional",
        meaning: "task_complete 的结束原因。",
        owner: "agent runtime",
        source: "ZCodeTaskComplete",
        conceptIds: ["inputId"],
      },
      {
        name: "error",
        type: "string",
        required: "optional",
        meaning: "task_error 的可读错误正文；远控恢复依赖它展示失败原因。",
        owner: "agent runtime",
        source: "ZCodeTaskError",
        conceptIds: ["inputId"],
      },
    ],
  },
  // status 是 UI 所有按钮的派生源：发送、停止、恢复态都读它，
  // 因此该结构的字段顺序按"状态 → 错误 → 归属"排列，便于对照渲染分支。
  // [权衡] activeInputId 与 activeInputOwnerClientId 成对出现：前者决定"等谁"，
  // 后者决定"谁有权操作"，合并会让远控 owner 切换时误判。
  // 破坏后果：漏掉 owner 字段时，多端同时操作同一 session 会出现两套 stop。
  // [失败路径] provider/usage/apiRetry 允许为空，UI 必须降级渲染，
  // 不能因缺字段而整块不显示。
  // [事务] 该结构只由事件流和 snapshot 派生，不反向写回 server。
  {
    id: "task-runtime-state",
    title: "TaskRuntimeState",
    path: "packages/ui/src/store/zcodeSessionStoreTypes.ts",
    purpose: "Renderer 中每个 task 的运行态，驱动输入框状态、停止按钮、使用量和错误展示。",
    oldShape: "{ status, error, provider, usage, apiRetry, activeRunId?, activeRunOwnerClientId? }",
    newShape:
      "{ status, error, provider, usage, apiRetry, activeInputId?, activeInputOwnerClientId? }",
    migration: "字段名从 run 改为 input，明确它是输入归属，不是 trace。",
    fields: [
      {
        name: "status",
        type: "idle | creating | notReady | restoring | ready | streaming | completed | failed",
        required: "required",
        meaning: "task 当前 UI 运行阶段。发送按钮、停止按钮和恢复态都从这里派生。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "error",
        type: "string | null",
        required: "required",
        meaning: "当前运行错误，null 表示没有可展示错误。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "provider",
        type: "ZCodeProvider",
        required: "optional",
        meaning: "该 task 当前绑定的 legacy provider，用于 workspace 级兼容投影和 busy lock。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "usage",
        type: "TaskUsageState | null",
        required: "required",
        meaning: "上下文窗口使用量和费用展示。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "apiRetry",
        type: "ZCodeApiRetryStatus | null",
        required: "required",
        meaning: "模型 API 重试状态，展示网络/限流恢复进度。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "activeInputId",
        type: "InputId | undefined",
        required: "optional",
        meaning: "当前运行输入。stop、立即发送和 terminal 事件收口的核心对齐字段。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["activeInputId", "inputId"],
        oldName: "activeRunId",
      },
      {
        name: "activeInputOwnerClientId",
        type: "string | undefined",
        required: "optional",
        meaning: "当前输入的 owner client，用于远控 owner/lease 场景下判断命令路由。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["activeInputId", "deliveryKind"],
        oldName: "activeRunOwnerClientId",
      },
    ],
  },
  // [并发] seq 与 deliveryKind 同属"恢复语义"：前者给水位，后者给策略，
  // 缺任一个都无法判断该重放还是该重取 snapshot。
  // [权衡] 没有 oldShape：envelope 是新增结构而非改名，写空会更清楚，
  // 但这里保留结构体让字段清单完整，避免读者以为它从别的类型继承。
  // 破坏后果：把 eventId 当去重主键却忽略 sessionId，跨会话同名事件会被吞。
  // 隐含前提：turnId 可空，session 级事件（如 settings 变更）不属于任何 turn。
  // [失败路径] timestamp 只用于展示与排序参考，不能作为水位参与恢复。
  {
    id: "zcode-event-envelope",
    title: "ZCode Event Envelope",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose: "协议事件外壳。它描述事件日志顺序和观测链路，不描述 UI 输入归属。",
    newShape: "{ eventId, sessionId, turnId?, seq, traceId?, timestamp, deliveryKind? }",
    migration: "Projection 不再把 envelope.traceId 当 input/run；payload.inputId 才是输入归属。",
    fields: [
      {
        name: "eventId",
        type: "string",
        required: "required",
        meaning: "事件唯一 ID，用于日志和去重。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "sessionId",
        type: "string",
        required: "required",
        meaning: "事件所属 session。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["sessionId"],
      },
      {
        name: "turnId",
        type: "string",
        required: "optional",
        meaning: "事件所属 turn。session 级事件可为空。",
        owner: "agent runtime",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["turnId"],
      },
      {
        name: "seq",
        type: "number",
        required: "required",
        meaning: "session 内单调递增事件序号，replayable 恢复以它为水位。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["eventSeq", "deliveryKind"],
      },
      {
        name: "traceId",
        type: "string",
        required: "optional",
        meaning: "观测 trace。不要用它判断 completed/failed 是否属于当前输入。",
        owner: "agent runtime",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["traceId"],
      },
      {
        name: "timestamp",
        type: "number",
        required: "required",
        meaning: "事件发生时间，毫秒时间戳。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "deliveryKind",
        type: "desktop-continuous | web-remote-replayable",
        required: "optional",
        meaning: "事件配送语义。手机远控恢复必须尊重 replayable 边界。",
        owner: "host/protocol client",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["deliveryKind"],
      },
    ],
  },
  // snapshot 是"完整可恢复视图"的唯一入口：UI 冷启动只认它，
  // 不从事件流反推历史。因此六个顶层字段都必须完整。
  // [权衡] 把 projection 与 runtime 分开：前者是产品状态（可展示），
  // 后者是协议水位（用于续传），合成一个对象会让 UI 误把 seq 当业务字段。
  // 破坏后果：若 UI 用 messages 自行重建 projection，工具状态与权限面板
  // 会与 server 不一致，刷新后按钮可用性反跳。
  // 隐含前提：settings 是 server-authoritative，UI 不得本地改写后当作事实。
  // [失败路径] 缺 projection 时不能只渲染 messages：pendingPermissions 会丢。
  {
    id: "session-state-snapshot",
    title: "SessionStateSnapshot",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose:
      "`session/create`、`session/read`、`session/subscribe(includeSnapshot)` 返回的完整可恢复视图。",
    newShape: "{ protocol, session, settings, projection, runtime, messages }",
    migration: "server 是核心状态事实源；UI 只保留视觉和本端 transient 状态。",
    fields: [
      {
        name: "protocol",
        type: "{ name: 'ZCode Protocol'; version: 1 }",
        required: "required",
        meaning: "协议名和版本，客户端据此确定 schema。",
        owner: "agent server",
        source: "zcodeSessionStateSnapshotSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "session",
        type: "ZCodeSessionInfo",
        required: "required",
        meaning:
          "session 基本信息：sessionId、workspace、parent、kind、title、mode、status、model、target、时间戳。",
        owner: "agent server",
        source: "zcodeSessionInfoSchema",
        conceptIds: ["sessionId", "workspaceKey"],
      },
      {
        name: "settings",
        type: "ZCodeSessionSettingsState",
        required: "required",
        meaning: "server-authoritative 模型、思考深度、模式和权限规则状态。",
        owner: "agent server",
        source: "zcodeSessionSettingsStateSchema",
        conceptIds: ["sessionId"],
      },
      {
        name: "projection",
        type: "ZCodeSessionProjection",
        required: "required",
        meaning:
          "运行投影：status、currentTurnId、pendingPermissions、activeToolCalls、target、lastError 等。",
        owner: "agent server",
        source: "zcodeSessionProjectionSchema",
        conceptIds: ["turnId", "toolCallId", "permissionRequest"],
      },
      {
        name: "runtime",
        type: "ZCodeSessionRuntimeState",
        required: "required",
        meaning: "eventSeq、stateRevision、deliveryKind、activeTurnId、pendingRequestIds。",
        owner: "agent server",
        source: "zcodeSessionRuntimeStateSchema",
        conceptIds: ["eventSeq", "deliveryKind", "turnId"],
      },
      {
        name: "messages",
        type: "ZCodeMessageWithParts[]",
        required: "required",
        meaning: "可渲染消息及 part 列表。UI 从这里恢复 transcript。",
        owner: "agent server",
        source: "zcodeMessageWithPartsSchema",
        conceptIds: ["messageId", "partId"],
      },
    ],
  },
  // 三个字段是"执行路径 / 稳定身份 / 隔离键"的三分法：
  // workspacePath 管执行，workspaceIdentity 管身份，workspaceKey 是二者合成结果。
  // [权衡] 让 workspaceKey 随协议传输而不是由客户端各自计算：
  // 计算规则一旦分叉，同一个远程 workspace 会在两端得到不同 key。
  // 破坏后果：远程省略 workspaceIdentity 时 key 退化成路径，
  // 挂载点变化即被视为新 workspace。
  // 隐含前提：本地没有 identity，key 必然等于路径，属正常降级而非缺陷。
  {
    id: "workspace-ref",
    title: "ZCodeWorkspaceRef",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose: "协议层 workspace 身份结构，分清执行路径和身份隔离。",
    newShape: "{ workspacePath, workspaceIdentity?, workspaceKey }",
    migration:
      "远程 workspace 必须传 workspaceIdentity；身份/隔离 key 使用 workspaceIdentity || workspacePath。",
    fields: [
      {
        name: "workspacePath",
        type: "string",
        required: "required",
        meaning: "实际文件路径，用于 cwd、文件读写、Git 和展示。",
        owner: "app/host",
        source: "zcodeWorkspaceRefSchema",
        conceptIds: ["workspacePath"],
      },
      {
        name: "workspaceIdentity",
        type: "string",
        required: "optional",
        meaning: "远程 workspace 稳定身份。SSH/WSL/Docker 必传，本地可为空。",
        owner: "app/host",
        source: "zcodeWorkspaceRefSchema",
        conceptIds: ["workspaceIdentity"],
      },
      {
        name: "workspaceKey",
        type: "string",
        required: "required",
        meaning: "身份/隔离语义使用的 key：workspaceIdentity?.trim() || workspacePath。",
        owner: "app/host",
        source: "zcodeWorkspaceRefSchema",
        conceptIds: ["workspaceKey"],
      },
    ],
  },
  // [权衡] 单独列一篇"遗留字段"而不是把它们混进主结构：读者需要一眼看出
  // 哪些名字是历史包袱、语义上其实等于 inputId。
  // [失败路径] required 全部标 legacy，渲染层据此显示"勿写入"徽标；
  // 若误标 optional，读者会以为可以继续传。
  // 破坏后果：command.traceId 被当成观测 trace 使用后，host 命令路由与
  // 日志链路会互相干扰，stale command 防护失效。
  // 隐含前提：这些字段的删除取决于旧客户端下线，本文件不预设时间点。
  // [并发] batchSeq/fromSeq/toSeq 三者必须来自同一批次，跨批次混用会重放错位。
  {
    id: "mirror-compat",
    title: "Replayable Mirror Legacy Fields",
    path: "packages/shared/src/zcode-task-types.ts + packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts",
    purpose:
      "手机远控 replayable 链路仍有 runId/ownerRunId 等历史命名，但文档必须标明语义是 input 归属。",
    oldShape: "{ runId, ownerRunId, traceId } 都容易被理解成 trace。",
    newShape: "新 UI 边界统一称 inputId；legacy 字段保持兼容并显式转换。",
    migration:
      "调用 `sendTaskPromptWithSessionControl` 时传 inputId；legacy `sendPrompt.traceId` 和 host command `traceId` 仅作为旧路由字段。",
    fields: [
      {
        name: "runId",
        type: "string",
        required: "legacy",
        meaning:
          "TaskStreamMirrorBatch 的兼容字段。实际表示当前 mirror/input run，不是观测 trace。",
        owner: "host runtime",
        source: "TaskStreamMirrorBatch",
        conceptIds: ["taskStreamMirrorBatch", "inputId"],
      },
      {
        name: "ownerRunId",
        type: "string",
        required: "legacy",
        meaning: "远控 owner command 的 stale 防护字段。传入时使用 activeInputId。",
        owner: "host runtime",
        source: "enqueueTaskCommand",
        conceptIds: ["activeInputId", "deliveryKind"],
      },
      {
        name: "command.traceId",
        type: "TraceId",
        required: "legacy",
        meaning:
          "TaskRuntimeCommandBase 的路由字段；当前作为 host command 路由 ID，语义上对应 inputId。",
        owner: "host runtime",
        source: "TaskRuntimeCommandBase",
        conceptIds: ["inputId", "taskStreamMirrorBatch"],
      },
      {
        name: "clientId",
        type: "string",
        required: "optional",
        meaning: "提交队列命令的客户端 ID，用于 owner 路由、展示当前设备和 stale command 防护。",
        owner: "renderer/host",
        source: "TaskRuntimeCommandBase",
        conceptIds: ["deliveryKind"],
      },
      {
        name: "batchSeq/fromSeq/toSeq",
        type: "number",
        required: "required",
        meaning: "mirror 批次和 op 序号范围，用于手机 remote replayable 缺口恢复。",
        owner: "host runtime",
        source: "TaskStreamMirrorBatch",
        conceptIds: ["taskStreamMirrorBatch", "eventSeq"],
      },
    ],
  },
];

// 协议接口面：transport envelope、session/state API 与阻塞式交互四类；
// fields 是接口/字段名的展示清单，summary 描述职责边界（例如协议实体叫 session 而非 task）。
// [权衡] 方法面按"传输 / 会话 / 状态 / 阻塞"四类分组，而不是按 HTTP 动词或
// 命名空间平铺：读者需要的是职责边界，不是完整方法列表。
// 破坏后果：把阻塞交互混进会话 API，会误以为它也走 client-to-server 方向。
export const protocolSurfaces = [
  // [权衡] 这一组不是字段表而是"能力地图"：fields 只是常见字段的索引，
  // 完整定义仍以 schema 为准，避免这里成为第二份协议实现。
  // transport 的 trace.* 是传输层观测字段，与业务 traceId 同名不同层，
  // 阅读时必须区分"envelope 的 traceId"和"trace 对象的 spanId"。
  // 破坏后果：把 traceparent 当 correlation id 使用，跨服务追踪会断链。
  // [失败路径] 缺少 response 的 id/error 分支说明时，读者会以为错误也是 notification。
  {
    id: "transport",
    title: "Transport Envelope",
    summary:
      "轻量 JSON-RPC 风格：request 有 id/method/params/trace，notification 有 method/params/trace，response 有 id/result 或 id/error。",
    fields: [
      "id",
      "method",
      "params",
      "trace.traceId",
      "trace.parentId",
      "trace.spanId",
      "trace.traceparent",
    ],
    conceptIds: ["traceId", "eventEnvelope"],
  },
  // 协议实体叫 session 不叫 task：本组用"会话 API"命名，
  // 是为了让读者在写代码前就知道 taskId 只是产品层概念。
  // fields 只列最常用的五个方法，完整清单见协议 schema。
  // [权衡] 把 subscribe 与 read 并列而非合并：前者是增量推送入口，
  // 后者是一次性读取，合并会让 replayable 恢复路径失去锚点。
  // 破坏后果：漏掉 resume 时，读者无法解释"重启后会话为什么还在"。
  {
    id: "session-methods",
    title: "Session APIs",
    summary:
      "session/create/resume/read/subscribe/send/stop/fork/compact/rewind/close。协议实体叫 session，不叫 task。",
    fields: ["session/create", "session/read", "session/subscribe", "session/send", "session/stop"],
    conceptIds: ["sessionId", "sessionSend", "eventSeq"],
  },
  // [事务] 这一组是"状态变更"而不是"输入提交"：模型、思考深度、模式
  // 由 server 持有并广播，UI 只发意图，不做本地先行生效。
  // 破坏后果：UI 先改本地再发请求时，请求被拒后界面仍显示新模型，
  // 下一次 turn 用的是旧模型，行为与展示不一致。
  // 隐含前提：Provider 配置不在这里，它属于 Environment Config 与进程 Registry。
  // [权衡] 把 workspace/readPresentation 放进本组，是因为它同样只读不写状态。
  {
    id: "state-methods",
    title: "State Mutation APIs",
    summary:
      "会话模型选择、思考深度和模式由 agent server 维护；Provider 配置由 Environment Config 与进程 Registry 管理。",
    fields: [
      "session/setModel",
      "session/setThoughtLevel",
      "session/setMode",
      "workspace/readPresentation",
    ],
    conceptIds: ["sessionId", "workspaceKey"],
  },
  // [事务] 阻塞交互是 server 主动向 client 发 request，方向与普通 RPC 相反，
  // 因此 host 必须承担 owner 路由：只有持有该 session 的 client 能回答。
  // 破坏后果：路由缺失时，权限请求会广播给所有客户端，任何一端点击都会
  // 生效，出现"我没点却通过了"。
  // [失败路径] pendingRequestIds 是重连后找回未决请求的唯一线索，
  // 缺失时只能等超时，用户看到工具卡住且无法批准。
  {
    id: "blocking",
    title: "Blocking Interactions",
    summary:
      "权限和用户输入走 server-to-client request，host 负责 owner 路由与 pending request 恢复。",
    fields: ["interaction/requestPermission", "interaction/requestUserInput", "pendingRequestIds"],
    conceptIds: ["permissionRequest", "deliveryKind", "sessionId"],
  },
];

// 关键时序流程：创建会话 → 提交输入 → 立即 ACK → 事件回流 → 终态收口 → 远控恢复；
// 顺序即阅读顺序，detail 内嵌 inputId/activeInputId 的匹配不变量。
export const flows: FlowStep[] = [
  // 这是整条链路的第一步，也是唯一由 UI 发起的创建动作；
  // 后续所有 id 都由这一步的返回值派生。
  // [失败路径] 返回值必须是完整的 SessionStateSnapshot：只返回 sessionId 时，
  // UI 需要再发一次 read，冷启动就多了一个可失败的往返。
  // 破坏后果：root traceContext 若不在 create 时生成，后续事件无法归到同一观测链。
  {
    id: "create-session",
    title: "创建会话",
    actor: "UI -> host -> agent server",
    detail:
      "UI 调用 session/create，传 workspace/mode/model。server 生成 sessionId 和 root traceContext，返回 SessionStateSnapshot。",
    conceptIds: ["sessionId", "traceId", "workspaceKey"],
  },
  // [并发] inputId 必须在调用前生成并写入 activeInputId，顺序不能反：
  // 先发请求再写本地，响应可能比写入更快返回，终态匹配会落空。
  // 破坏后果：把 activeInputId 的写入放到 ACK 之后，ACK 与 turn 事件之间
  // 存在窗口，期间的终态没有任何 "当前输入" 可比对。
  // [权衡] 由 UI 生成而不是 server 返回：server 返回需要多一次往返，
  // 且丢失网络时无法区分"没发出去"和"发了没回"。
  {
    id: "send-input",
    title: "提交输入",
    actor: "UI",
    detail:
      "UI 为本次输入生成 inputId，写入 activeInputId，然后调用 session/send({ sessionId, inputId, content })。",
    conceptIds: ["inputId", "activeInputId", "sessionSend"],
  },
  // [事务] ACK 的语义边界必须写清：它只证明"输入被接纳"，不证明"已开始执行"，
  // 更不证明"已完成"。把它当任何终态都会造成 UI 提前收口。
  // 破坏后果：客户端在 ACK 后关闭 loading，用户看到的是一段空白等待。
  // [失败路径] ACK 丢失时输入可能仍被执行：client 需要靠 inputId 对账，
  // 而不是重发（重发会产生第二次执行）。
  {
    id: "ack-background",
    title: "立即 ACK",
    actor: "agent server",
    detail:
      "session/send 只确认收到输入，不等待模型输出。后台 turn 继续运行，状态变化由 events/state.updated 推送。",
    conceptIds: ["sessionSend", "eventEnvelope"],
  },
  // [并发] 事件回流是本文件的主干：payload 带 inputId（归属），envelope 带
  // traceId 与 seq（观测与水位），两者不可互换。
  // 破坏后果：若用 seq 判断输入归属，并发 steer 的两次输入会被算成同一轮。
  // [失败路径] seq 断档时必须走 snapshot，不能跳过后继续追加，
  // 否则投影永久缺失一段。
  {
    id: "turn-events",
    title: "事件回流",
    actor: "agent runtime -> host -> UI",
    detail:
      "turn.started/completed/failed payload 回带 inputId；event envelope 保留 traceId 和 seq。",
    conceptIds: ["inputId", "traceId", "eventSeq"],
  },
  // [事务] 终态收口是整条链路唯一的"关闭"动作：只有 inputId 匹配
  // activeInputId 时才能关闭当前 assistant。这是本文件最重要的一条不变量。
  // 破坏后果：不校验就关闭时，上一轮迟到的 completed 会让新一轮提前结束，
  // 表现为"回复被截断"且没有任何错误。
  // [权衡] 丢弃而不是排队处理迟到事件：迟到事件对应的输入已经结束，
  // 补渲染只会让 transcript 出现重复段落。
  {
    id: "terminal-guard",
    title: "终态收口",
    actor: "UI projection",
    detail:
      "completed/failed 只有在 event.inputId 匹配 activeInputId 时才能关闭当前 assistant。旧 input 的迟到事件会被忽略。",
    conceptIds: ["activeInputId", "inputId", "taskRuntimeState"],
  },
  // [并发] 远控恢复是"snapshot + afterSeq + mirror batch"三者协同：
  // snapshot 给基线，afterSeq 给增量起点，batch 给流式 op 的区间。
  // 破坏后果：只用 afterSeq 而不看 batch 时，流式中的部分内容会整段丢失
  // （它在 snapshot 之后、在事件之前）。
  // [失败路径] 恢复失败应回退到重新取 snapshot，而不是无限重试同一 seq。
  {
    id: "remote-replay",
    title: "远控恢复",
    actor: "web remote",
    detail:
      "web-remote-replayable 使用 snapshot + afterSeq + mirror batch 恢复。legacy runId 字段按 inputId 语义处理。",
    conceptIds: ["deliveryKind", "eventSeq", "taskStreamMirrorBatch"],
  },
];

// stdio traffic NDJSON 的字段口径：raw 的解析结果放 message，解析失败原因放 parseError，
// 两者互斥（message 为空时才会出现 parseError）。
export const stdioTrafficLogFields: StdioTrafficLogField[] = [
  // [权衡] ts 由写入端给出而不是查看器补：跨进程排障时两边时钟可能不同，
  // 以落盘侧时间为准才能把 app 与 agent 的日志拼成一条线。
  // 破坏后果：改用查看器读取时间，事故回放会得到"未来"的帧序。
  {
    name: "ts",
    type: "ISO timestamp",
    meaning: "proxy 写入磁盘的时间，用于按本机时间排序和定位。",
  },
  // workspaceKey 让多 workspace 的 traffic 能落进同一目录而不串味；
  // 它必须是身份 key 而非路径，否则远程挂载点变化后历史文件就找不回来。
  // 破坏后果：按 pid 归档时，重启会覆盖上一进程的最后一段日志。
  {
    name: "workspaceKey",
    type: "string",
    meaning: "身份隔离 key，远程 workspace 使用 workspaceIdentity，本地回退 workspacePath。",
  },
  // [失败路径] pid 是"这次进程"的标识，不能用来判断会话是否已结束：
  // 同一 pid 可以承载多个 session，退出码也不在 traffic 里。
  // 破坏后果：按 pid 去重会话时，多会话场景只保留最后一条。
  {
    name: "pid",
    type: "number",
    meaning: "agent 子进程 pid；同一个 workspace 重启后会出现新的 pid 文件。",
  },
  // direction 与 kind 正交：direction 描述管道，kind 描述协议角色；
  // 因此 agent-stderr 可以出现非 JSON 的 raw，而 app-to-agent 必须是 JSON。
  // 破坏后果：用 kind 推断管道方向，会把 stderr 的普通文本判成非法请求。
  {
    name: "direction",
    type: "app-to-agent | agent-to-app | agent-stderr",
    meaning: "帧方向：写入 stdin、读取 stdout，或 agent stderr 旁路。",
  },
  // [权衡] 保存原始行而不是只保存解析结果：解析器本身可能才是 bug，
  // 丢掉原文就再也无法复现"为什么这行没被识别"。
  // 破坏后果：只落结构化结果时，协议升级期的兼容问题全部不可查。
  {
    name: "raw",
    type: "string",
    meaning: "原始行内容。stdout/stdin 必须保持一行 JSON，stderr 可以是普通文本。",
  },
  // [失败路径] message 为空有两种原因：非协议行（stderr）或解析失败，
  // 必须靠 parseError 区分；把它当"没有消息"会漏掉真正的协议错误。
  // 破坏后果：两个字段同时有值时，查看器无法判断该以解析结果还是错误为准。
  {
    name: "message",
    type: "object | null",
    meaning: "raw 可解析为 ZCode Protocol 消息时的结构化结果；stderr 或解析失败时为空。",
  },
  // [资源] 解析失败不能截断转发：proxy 的职责是透传，判错由查看器做；
  // 一旦在写入端丢弃，agent 与 app 的行为就和日志不一致了。
  // 破坏后果：把 parseError 当断流信号，会让一次格式抖动打断整个会话。
  {
    name: "parseError",
    type: "string | null",
    meaning: "解析失败原因。proxy 不应因此截断转发，只在查看器里标红。",
  },
];

// 本地排查 traffic 的常用命令示例；command 中路径为约定路径，不保证在所有机器存在。
export const stdioTrafficReadSteps: StdioTrafficReadStep[] = [
  // [权衡] "实时跟随"用 cat 而不是 tail -f：traffic 文件按 workspace 分目录，
  // 直接 cat 能把已写内容一次看全，适合贴进事故记录。
  // 破坏后果：改成 tail -f 后示例不再可复制粘贴，读者会以为必须常驻终端。
  {
    id: "tail-current",
    title: "实时跟随当前文件",
    command: "cat ~/.zcode/v2/dev/stdio-traffic/<workspaceHash>/latest.txt",
    detail: "适合临时排查，按写入顺序看每一行 traffic record。",
  },
  // [失败路径] 只看 app-to-agent 能确认"请求到底发没发"，这是区分
  // "UI 没发"与"agent 没回"的最快一步，不能跳过直接看结果。
  // 破坏后果：两个方向混看时，缺帧无法归因到某一侧。
  {
    id: "pretty-stdin",
    title: "只看 app 发给 agent",
    command: "jq 'select(.direction == \"app-to-agent\") | .message' < traffic.ndjson",
    detail: "用于确认 session/send、session/stop、permission response 是否真的发出。",
  },
  // [事务] 按 JSON-RPC id 配对是唯一可靠的耗时口径：两帧的 id 相同即同一次调用，
  // 不能用时间戳相近来猜，并发请求的时间会重叠。
  // 破坏后果：按时间配对时，并发场景会把 A 的请求配到 B 的响应。
  {
    id: "pair-by-id",
    title: "按 JSON-RPC id 配对",
    command: "jq 'select(.message.id == 7)' < traffic.ndjson",
    detail: "同一个 id 的 request/response 放在一起，能快速看出耗时和结果。",
  },
];

// 一条完整的 create → send → events → completed 示例会话，帧按时间顺序排列；
// sessionId/inputId 等均为假值，仅用于文档演示与视觉对照，不驱动真实逻辑。
export const stdioTrafficFrames: StdioTrafficFrame[] = [
  // 第一帧是整段示例的起点：create 只传 workspace 与 deliveryKind，
  // 没有 identity 就说明这是本地 workspace，workspaceKey 会退化成路径。
  // 破坏后果：读者照抄时给远程 workspace 省略 identity，重连会被当成新工程。
  // [权衡] messageId 在这里是 JSON-RPC 的 id 字符串，不是消息主键；
  // 同名不同义，看配对时要认 linkedId 而不是 messageId。
  {
    id: "frame-001",
    timestamp: "10:42:18.124",
    direction: "app-to-agent",
    kind: "request",
    method: "session/create",
    messageId: "1",
    summary: "创建本地 workspace 会话",
    bytes: 428,
    linkedId: "frame-002",
    raw: `{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/Users/dev/workspace/z-code",
      "workspaceKey": "/Users/dev/workspace/z-code"
    },
    "deliveryKind": "desktop-continuous"
  }
}`,
  },
  // [事务] 这一帧与上一帧靠 messageId 相同（都是 "1"）配对，linkedId 双向指认；
  // latencyMs 只在这里有意义，request 帧不该出现耗时。
  // 破坏后果：给 request 也填 latencyMs，按 response 过滤耗时的统计会翻倍。
  // [失败路径] 返回体只截取了 session 与 runtime 两段，不能据此认为
  // snapshot 只有这两个字段；完整形状见 SessionStateSnapshot 一节。
  {
    id: "frame-002",
    timestamp: "10:42:18.191",
    direction: "agent-to-app",
    kind: "response",
    messageId: "1",
    sessionId: "sess_6b6a",
    summary: "返回 SessionStateSnapshot",
    bytes: 1816,
    latencyMs: 67,
    linkedId: "frame-001",
    raw: `{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_6b6a",
      "status": "ready"
    },
    "runtime": {
      "eventSeq": 0,
      "deliveryKind": "desktop-continuous"
    }
  }
}`,
  },
  // [并发] send 帧已经带上 inputId，且它必须与 UI 本地写入的 activeInputId
  // 完全一致；示例里的假值 inp_a31c 贯穿后续所有帧，正是为了演示这点。
  // 破坏后果：每帧换一个 inputId，终态就永远匹配不上当前输入。
  // [权衡] content 是最终文本而不是原始富文本：附件文本化在 UI 侧完成。
  {
    id: "frame-003",
    timestamp: "10:42:21.004",
    direction: "app-to-agent",
    kind: "request",
    method: "session/send",
    messageId: "2",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "提交用户输入并立即 ACK",
    bytes: 612,
    linkedId: "frame-004",
    raw: `{
  "id": 2,
  "method": "session/send",
  "params": {
    "sessionId": "sess_6b6a",
    "inputId": "inp_a31c",
    "content": "看一下 stdio traffic"
  }
}`,
  },
  // [事务] ACK 只有 accepted 与回带的 inputId，没有结果字段——这是示例里
  // 最重要的一处"否定性证据"：客户端不能把 7ms 的响应当完成。
  // 破坏后果：把 accepted 当 success 会提前结束 loading，用户看到长时间空白。
  // [失败路径] ACK 的 inputId 是 server 对账依据；省略它时客户端无法确认
  // 自己发的那条是否被接纳，只能靠后续 turn.started 反推。
  {
    id: "frame-004",
    timestamp: "10:42:21.011",
    direction: "agent-to-app",
    kind: "response",
    messageId: "2",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "session/send ack，不等待模型完成",
    bytes: 96,
    latencyMs: 7,
    linkedId: "frame-003",
    raw: `{
  "id": 2,
  "result": {
    "accepted": true,
    "inputId": "inp_a31c"
  }
}`,
  },
  // [并发] turn.started 同时带 seq=1、traceId 与 payload.inputId：
  // 三个字段分工固定：seq 定位水位；traceId 串观测链；payload.inputId 标归属，缺一个排障就少一条线索。
  // [失败路径] 注意后续帧的 seq 直接跳到 8：示例省略了中间帧，
  // 不能据此认为 seq 必须连续；真实链路里断档意味着要重新取 snapshot。
  // 破坏后果：把示例当"seq 应该连续"的证据，会在联调时误判为丢包。
  {
    id: "frame-005",
    timestamp: "10:42:21.036",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "turn.started 事件，payload 回带 inputId",
    bytes: 744,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 1,
    "traceId": "tr_9f20",
    "payload": {
      "type": "turn.started",
      "inputId": "inp_a31c",
      "turnId": "turn_01"
    }
  }
}`,
  },
  // [资源] stderr 帧没有 method、没有 linkedId、raw 也不是 JSON：
  // 它只用于旁路观察，永远不参与配对或解析。
  // 破坏后果：把 stderr 也送进 JSON 解析，会产生大量假的 parseError，
  // 把真正的协议错误淹没。
  // [权衡] 仍然记录 bytes 与 timestamp：定位"进程何时启动、何时报错"靠它。
  {
    id: "frame-006",
    timestamp: "10:42:21.212",
    direction: "agent-stderr",
    kind: "stderr",
    sessionId: "sess_6b6a",
    summary: "agent stderr 只作为旁路观察，不进入协议解析",
    bytes: 118,
    raw: "[zcode-agent] model provider ready provider=glm model=glm-4.7",
  },
  // 流式 delta 只带 inputId 与增量文本，不带完整消息：
  // 渲染端必须把 delta 追加到已有 part 上，而不是每帧新建一条消息。
  // 破坏后果：按帧新建消息时，transcript 会出现多条半截 assistant 消息。
  // [失败路径] 该帧 raw 省略了 messageId/partId 以便阅读，真实链路必须带，
  // 否则 delta 无处落地。
  {
    id: "frame-007",
    timestamp: "10:42:22.842",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "assistant text part delta",
    bytes: 532,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 8,
    "payload": {
      "type": "message.part.delta",
      "inputId": "inp_a31c",
      "delta": "可以，用 traffic inspector 看。"
    }
  }
}`,
  },
  // [事务] 最后一帧是收口点：turn.completed 的 payload.inputId 必须与
  // activeInputId 相等才允许关闭当前 assistant，这是整段示例的结论。
  // 破坏后果：只按 turn 类型收口而不比对 inputId，多轮并发时上一轮的完成
  // 会关掉当前这一轮。
  // [权衡] 示例止于 completed 而不展示 stop/失败分支：本条流程只讲成功路径，
  // 失败路径的收口规则见 flows 的 terminal-guard 一步。
  // [失败路径] 缺少 resultType 时 UI 无法区分正常结束与预算耗尽，
  // 只能显示"已完成"，掩盖了真实终止原因。
  {
    id: "frame-008",
    timestamp: "10:42:24.509",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "turn.completed，UI 用 inputId 收口",
    bytes: 604,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 12,
    "payload": {
      "type": "turn.completed",
      "inputId": "inp_a31c",
      "resultType": "success"
    }
  }
}`,
  },
];
