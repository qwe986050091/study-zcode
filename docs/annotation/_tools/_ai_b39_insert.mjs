// B39 insert: types.ts + mcp-events.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/tool/';
const files = [
  {
    name: 'types.ts',
    want: [96, 100],
    blocks: [
      { at: 1, expect: "import { z } from 'zod/v4';", lines: [
        '// ============================================================================',
        '// types：MCP 协议的全部 zod schema 与推导类型',
        '// 覆盖协议版本、能力、工具、资源、提示、补全与补充输入。',
        '// 这些 schema 同时用于请求参数校验与响应解析。',
        '// 所有 schema 均基于 zod/v4 定义。',
      ] },
      { at: 9, expect: "export const LATEST_PROTOCOL_VERSION = '2026-07-28';", lines: [
        '// 支持的最新协议版本。',
        '// 新协议使用 server/discover 探测，旧协议走 initialize 握手。',
        '// 版本常量集中在此，便于统一升级。',
      ] },
      { at: 11, expect: 'export const SUPPORTED_PROTOCOL_VERSIONS = [', lines: [
        '// 按新到旧排序的受支持版本列表。',
      ] },
      { at: 19, expect: 'export type McpProviderMetadata = {', lines: [
        '// 工具结果中附带的 MCP 提供商元数据。',
        '// 供上层识别来源客户端、工具名与 MCP App 信息。',
        '// 所有字段都是可选的。',
        '// 未提供时不会写入工具元数据。',
      ] },
      { at: 34, expect: 'export type McpToolAnnotations = {', lines: [
        '// 服务端声明的工具行为提示。',
        '// 这些提示默认不可信，除非服务端本身可信。',
        '// 用于给模型提供只读、幂等、开放世界等线索。',
        '// 这些提示只用于影响模型决策，不改变协议行为。',
      ] },
      { at: 46, expect: 'export type ToolSchemas =', lines: [
        '// 工具 schema 配置。',
        '// automatic 表示按服务端 JSON Schema 自动生成。',
        '// 也可以显式提供每个工具的输入/输出 schema。',
        '// undefined 等价于 automatic。',
        '// 显式配置适合需要强类型的调用方。',
      ] },
      { at: 69, expect: "export type McpToolSet<TOOL_SCHEMAS extends ToolSchemas = 'automatic'> =", lines: [
        '// 根据 schema 配置推导出的工具集合类型。',
        '// 显式配置时按键映射到具体的输入/输出类型。',
        '// 只提供 inputSchema 时输出退化为原始 CallToolResult。',
        '// automatic 模式下退化为通用的工具记录。',
        '// 这样调用方无需手动断言类型。',
      ] },
      { at: 105, expect: 'export const RequestSchema = z.object({', lines: [
        '// JSON-RPC 请求的基本形状：方法名与可选参数。',
      ] },
      { at: 110, expect: 'export type RequestOptions = {', lines: [
        '// 单次请求的取消与超时选项。',
        '// timeout 作用于单次尝试，maxTotalTimeout 覆盖重试总时长。',
        '// 两者都不传表示不设超时。',
      ] },
      { at: 119, expect: 'const ElicitationCapabilitySchema = z', lines: [
        '// 补充输入能力声明。',
        '// applyDefaults 表示服务端可自动填充默认值。',
      ] },
      { at: 125, expect: 'const ServerCapabilitiesSchema = z.looseObject({', lines: [
        '// 服务端能力集合。',
        '// 每个子能力都声明自身是否支持变更通知。',
        '// 使用 looseObject 保留未来新增的能力字段。',
      ] },
      { at: 159, expect: 'export const DiscoverResultSchema = ResultSchema.extend({', lines: [
        '// server/discover 的响应。',
        '// 返回受支持版本、能力、说明与缓存提示。',
        '// ttlMs 与 cacheScope 用于客户端缓存该结果。',
        '// 结果形状与 initialize 响应保持接近。',
        '// 缓存提示由调用方决定是否采用。',
      ] },
      { at: 168, expect: 'export const InitializeResultSchema = ResultSchema.extend({', lines: [
        '// initialize 握手的响应。',
        '// 包含协商后的协议版本、能力与服务端实现信息。',
        '// instructions 可选，用于指导模型如何使用该服务端。',
        '// 该响应只在 legacy 握手中出现。',
      ] },
      { at: 186, expect: 'const ToolSchema = z', lines: [
        '// 工具定义。',
        '// 输入 schema 至少是带 type 与 properties 的对象。',
        '// 注解与 _meta 均可选，其他字段原样透传。',
        '// 标题与输出 schema 都可选。',
      ] },
      { at: 222, expect: 'const TextContentSchema = z', lines: [
        '// 文本内容分片。',
        '// 允许额外字段，兼容实现方扩展。',
        '// 图片分片使用 base64 数据与 MIME 类型。',
      ] },
      { at: 228, expect: 'const ImageContentSchema = z', lines: [
        '// 图片内容分片，数据必须是合法 base64。',
      ] },
      { at: 235, expect: 'export const ResourceSchema = z', lines: [
        '// 资源描述：URI、名称与可选的展示信息。',
      ] },
      { at: 247, expect: 'export const ListResourcesResultSchema = PaginatedResultSchema.extend({', lines: [
        '// 资源列表响应，支持游标分页。',
      ] },
      { at: 252, expect: 'const ResourceContentsSchema = z', lines: [
        '// 资源内容的基础字段。',
        '// 文本与二进制变体在此基础上扩展。',
        '// 未知字段透传，兼容服务端扩展。',
      ] },
      { at: 293, expect: 'const UnknownContentSchema = z', lines: [
        '// 未知内容分片的兜底 schema。',
        '// 显式排除已知类型，避免错误地被归入未知分支。',
      ] },
      { at: 302, expect: 'const CallToolResultWithContentSchema = ResultSchema.extend({', lines: [
        '// 带内容列表的工具结果。',
        '// content 支持文本、图片、内嵌资源、资源链接与未知分片。',
        '// structuredContent 与 isError 可选。',
        '// 这是最常见的工具结果形态。',
      ] },
      { at: 319, expect: 'const CallToolResultWithStructuredContentSchema = ResultSchema.extend({', lines: [
        '// 仅返回结构化内容的工具结果。',
        '// 通过 transform 把它转换成统一的 content 形状。',
        '// 随后用 pipe 交给带内容 schema 做最终校验。',
        '// 这种形态要求 content 不存在。',
      ] },
      { at: 337, expect: 'export const CallToolResultSchema = CallToolResultWithContentSchema.or(', lines: [
        '// 工具结果支持三种形态。',
        '// 普通 content、仅 structuredContent，或直接返回 toolResult。',
        '// 按顺序尝试，命中即返回。',
      ] },
      { at: 346, expect: 'const ResourceTemplateSchema = z', lines: [
        '// 资源模板：以 URI 模板描述一类资源。',
      ] },
      { at: 356, expect: 'export const ListResourceTemplatesResultSchema = ResultSchema.extend({', lines: [
        '// 资源模板列表响应。',
      ] },
      { at: 363, expect: 'export const ReadResourceResultSchema = ResultSchema.extend({', lines: [
        '// 读取资源的结果。',
        '// 内容可能是文本，也可能是二进制块。',
      ] },
      { at: 392, expect: 'export const CompleteRequestParamsSchema = BaseParamsSchema.extend({', lines: [
        '// 补全请求参数。',
        '// ref 指向提示或资源，argument 是当前输入。',
        '// context 可携带已填写的其他参数，帮助生成候选。',
      ] },
      { at: 405, expect: 'export const CompleteResultSchema = ResultSchema.extend({', lines: [
        '// 补全结果。',
        '// 候选值最多 100 个，可分页返回。',
        '// hasMore 提示是否还有更多候选。',
      ] },
      { at: 425, expect: 'export const PromptSchema = z', lines: [
        '// 提示定义：名称、说明与可选参数列表。',
      ] },
      { at: 435, expect: 'export const ListPromptsResultSchema = PaginatedResultSchema.extend({', lines: [
        '// 提示列表响应，支持游标分页。',
      ] },
      { at: 440, expect: 'const PromptMessageSchema = z', lines: [
        '// 提示消息：角色与内容分片。',
        '// 内容不支持未知类型，避免渲染出无法处理的片段。',
      ] },
      { at: 453, expect: 'export const GetPromptResultSchema = ResultSchema.extend({', lines: [
        '// 获取提示的结果：可选说明与消息列表。',
      ] },
      { at: 459, expect: 'const ElicitationRequestParamsSchema = BaseParamsSchema.extend({', lines: [
        '// 补充输入请求参数。',
        '// message 展示给用户，requestedSchema 描述需要填写的结构。',
      ] },
      { at: 464, expect: 'export const ElicitationRequestSchema = RequestSchema.extend({', lines: [
        '// 服务端发起的补充输入请求。',
        '// 方法名固定为 elicitation/create。',
      ] },
      { at: 471, expect: 'export const ElicitResultSchema = ResultSchema.extend({', lines: [
        '// 补充输入的结果。',
        '// action 表示接受、拒绝或取消。',
        '// content 仅在接受时携带用户填写的内容。',
      ] },
      { at: 482, expect: 'export const InputRequiredResultSchema = ResultSchema.extend({', lines: [
        '// 现代协议中表示还需要补充输入的结果。',
        '// 必须至少携带 inputRequests 或 requestState 之一。',
        '// 客户端据此继续多轮往返。',
      ] },
      { at: 493, expect: 'export const InputRequiredElicitationSchema = ElicitationRequestSchema.extend({', lines: [
        '// 客户端目前只支持表单模式的补充输入。',
        '// requestedSchema 限定为对象，mode 默认为 form。',
      ] },
    ],
  },
  {
    name: 'mcp-events.ts',
    want: [57, 61],
    blocks: [
      { at: 1, expect: "import { MCPClientError } from '../error/mcp-client-error';", lines: [
        '// ============================================================================',
        '// mcp-events：MCP 事件订阅的本地封装',
        '// 在请求通道之上实现 subscribe / refresh / unsubscribe，并维护本地订阅状态。',
        '// 所有订阅都必须先持久化，再发起可能触发服务端回调的请求。',
        '// 所有失败都以 MCPClientError 抛出。',
      ] },
      { at: 19, expect: 'export function createMCPEvents({', lines: [
        '// 创建事件能力对象。',
        '// 依赖注入请求函数、可选的订阅存储与参数校验器。',
        '// 没有存储时只有 list 可用，其余操作会明确报错。',
        '// 返回的对象与 MCPEvents 接口一一对应。',
        '// 请求函数由 mcp-client 提供，复用统一的超时与重试。',
      ] },
      { at: 57, expect: 'async function subscribe(', lines: [
        '// 发起订阅请求并回写服务端返回的状态。',
        '// 只把已定义的字段放入参数，避免发送 undefined。',
        '// 成功后更新为 active 并记录游标与刷新时间。',
        '// 失败时保留原状态，由调用方决定恢复或退订。',
        '// 返回值原样透传服务端结果。',
      ] },
      { at: 80, expect: 'await getStore().update(subscription.key, {', lines: [
        '// 记录服务端分配的 id 与续订信息。',
      ] },
      { at: 90, expect: 'const events: MCPEvents = {', lines: [
        '// 对外暴露的事件能力。',
        '// list 直接透传请求，其余方法在本地维护订阅生命周期。',
        '// 订阅键在服务端回调校验前就已生成并持久化。',
        '// 这样即使响应超时也能按 key 恢复或退订。',
        '// 订阅状态由存储实现负责持久化与并发控制。',
      ] },
      { at: 91, expect: 'list({ params, options } = {}) {', lines: [
        '// 列出事件定义，支持游标分页。',
      ] },
      { at: 99, expect: 'async subscribe({', lines: [
        '// 订阅一个事件。',
        '// 先校验回调地址、投递模式与生命周期参数。',
        '// 再分页查找事件定义并校验是否支持 webhook。',
        '// 生成订阅键与密钥后先持久化，最后才请求服务端。',
        '// 这种顺序保证服务端回调到达时本地已有可匹配状态。',
        '// 任意一步失败都不会留下半成品订阅。',
      ] },
      { at: 114, expect: 'if (', lines: [
        '// 回调地址必须是 HTTPS。',
        '// 仅当显式允许时，接受回环地址上的 http。',
        '// 禁止携带用户名、密码与片段，防止凭据泄漏或地址歧义。',
        '// 不满足条件直接拒绝。',
      ] },
      { at: 125, expect: "if (delivery.mode !== 'webhook') {", lines: [
        '// 当前只支持 webhook 投递。',
      ] },
      { at: 130, expect: 'if (', lines: [
        '// 校验订阅生命周期与回放窗口。',
        '// ttlMs 必须为正整数，maxAgeMs 必须为非负整数。',
        '// 非法值会被拒绝，避免服务端收到无意义参数。',
        '// 两者都可省略，表示使用服务端默认值。',
      ] },
      { at: 139, expect: 'let pageCursor: string | undefined;', lines: [
        '// 分页游标与已访问集合用于检测循环。',
      ] },
      { at: 142, expect: 'do {', lines: [
        '// 逐页查找同名事件定义。',
        '// 游标重复说明服务端分页异常，立即失败。',
        '// 找到定义后停止翻页。',
      ] },
      { at: 167, expect: 'await validateArguments?.({ definition, arguments: args });', lines: [
        '// 允许调用方在提交前校验事件参数。',
      ] },
      { at: 168, expect: 'const secret = delivery.secret ?? createMCPEventSecret();', lines: [
        '// 使用调用方提供的密钥，否则生成新密钥。',
      ] },
      { at: 173, expect: 'const key = crypto.randomUUID();', lines: [
        '// 路由键在服务端分配订阅 ID 之前就可用。',
        '// 先把键与密钥持久化，再让服务端回调校验。',
        '// 键会作为查询参数附加到回调地址上。',
        '// 服务端回调时据此找到对应的待确认订阅。',
      ] },
      { at: 175, expect: 'const subscription: MCPEventSubscription = {', lines: [
        '// 本地订阅记录：初始状态为 pending。',
        '// 参数做一次深拷贝，避免调用方后续修改影响订阅。',
        '// 定义与投递信息一并保存，供刷新与退订复用。',
      ] },
      { at: 193, expect: 'async refresh(args) {', lines: [
        '// 刷新订阅有效期。',
        '// 先把状态置为 pending，再请求服务端续订。',
        '// 续订成功后才更新过期时间与游标。',
        '// 失败时保留 pending，便于按存储的键恢复。',
      ] },
      { at: 201, expect: 'async unsubscribe(args) {', lines: [
        '// 取消订阅。',
        '// 先请求服务端退订，成功后再删除本地记录。',
        '// 顺序很重要：先删本地会让失败的重试失去依据。',
        '// 投递信息只传 webhook 模式与地址即可。',
      ] },
    ],
  },
];

let grand = 0;
for (const f of files) {
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  let bad = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      bad++;
    }
    total += b.lines.length;
  }
  if (bad) process.exit(1);
  if (process.env.DRY) {
    console.log('DRY', f.name, total);
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`COUNT ${f.name}=${total} want ${f.want[0]}..${f.want[1]}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  console.log('ADDED', f.name, total);
  grand += total;
}
console.log('TOTAL', grand);
