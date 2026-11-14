// B36 insert: mcp-client (full) + mcp-apps
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/tool/';
const files = [
  {
    name: 'mcp-client.ts',
    want: [380, 400],
    blocks: [
      { at: 1, expect: "import type { JSONObject, JSONSchema7, JSONValue } from '@ai-sdk/provider';", lines: [
        '// ============================================================================',
        '// mcp-client：MCP 协议客户端实现',
        '// 负责传输启动、初始化协商、JSON-RPC 请求/响应配对、工具与资源调用。',
        '// 同时处理协议版本探测、能力校验、重试与事件适配。',
        '// 该文件是 packages/mcp 的核心，所有上层工具集都由这里产出。',
        '// ============================================================================',
      ] },
      { at: 3, expect: 'asSchema,', lines: [
        '// 从 provider 引入 JSON 基础类型，用于元数据与内容映射。',
        '// 从 provider-utils 引入 schema 转换、延迟、工具封装与重试等运行时能力。',
        '// 这些依赖只做类型与纯函数，不引入额外的运行时耦合。',
      ] },
      { at: 18, expect: 'import {', lines: [
        '// 事件适配层：把用户提供的 adapter 包装成统一的 ManagedMCPEvents。',
        '// validateMCPEventOperations 在构造阶段校验 adapter 契约，避免运行期才暴露缺方法。',
        '// 该模块与 mcp-client 分离，便于独立测试多后端事件存储。',
      ] },
      { at: 40, expect: "import { getMCPAppToolMeta, MCP_APP_MIME_TYPE } from './mcp-apps';", lines: [
        '// MCP App 扩展：从工具 _meta 中解析 UI 资源引用与固定 MIME 类型。',
        '// 仅当工具声明了 app 资源时才写入 metadata，普通工具不受影响。',
      ] },
      { at: 46, expect: 'import {', lines: [
        '// HTTP 头绑定相关：把工具入参映射成请求头，供现代协议传输层使用。',
        '// 绑定声明来自工具 inputSchema，解析失败的工具会在准备阶段被剔除。',
      ] },
      { at: 91, expect: "const CLIENT_VERSION = '1.0.0';", lines: [
        '// 客户端实现版本号，仅在调用方未显式传入 version 时使用。',
        '// 注意与协议版本区分：这里是客户端实现版本，不是 MCP 规范版本。',
        '// 常量集中在模块顶部，方便统一调整默认行为。',
        '// 后续的默认最大重试次数、探测超时等都由这些常量控制。',
      ] },
      { at: 92, expect: 'const DEFAULT_MAX_TOOL_CALL_RETRIES = 0;', lines: [
        '// 工具调用默认不重试，避免重复执行有副作用的工具。',
      ] },
      { at: 94, expect: 'const MAX_INPUT_REQUIRED_ROUNDS = 10;', lines: [
        '// 输入补充（input_required）最多往返轮数，防止服务端无限追问。',
      ] },
      { at: 96, expect: 'const MODERN_PROTOCOL_ERROR_CODES = [-32020, -32021, -32022];', lines: [
        '// 现代协议中表示版本/能力不匹配的错误码集合。',
      ] },
      { at: 98, expect: 'const DEFAULT_RETRY_ERROR_CODES = [', lines: [
        '// 可重试的底层网络错误码白名单。',
        '// 仅覆盖连接建立与被对端重置等瞬时故障。',
        '// 业务语义错误（如参数非法）不在此列，避免误重试。',
      ] },
      { at: 108, expect: 'function getErrorStatusCode(error: unknown): number | undefined {', lines: [
        '// 从任意错误对象上提取 HTTP 状态码。',
        '// 只做类型守卫读取，不假设错误来自特定库。',
        '// 读取失败返回 undefined，交由调用方决定后续判断。',
        '// 该函数不抛错，保证重试判定路径本身不会引入新的异常。',
      ] },
      { at: 119, expect: 'function getStringErrorCode(error: unknown): string | undefined {', lines: [
        '// 提取字符串形式的错误码（如 Node 的 ECONNRESET）。',
        '// 与状态码互补，用于覆盖没有 HTTP 层的传输错误。',
      ] },
      { at: 130, expect: 'function isRetryableMCPToolCallError(error: unknown): boolean {', lines: [
        '// 判断一次工具调用失败是否值得重试。',
        '// 优先看 HTTP 状态码：超时、冲突、限流与 5xx 视为可重试。',
        '// 已经包装过的 MCPClientError 直接判否，避免把业务错误当网络错误。',
        '// 最后回退到字符串错误码白名单。',
      ] },
      { at: 149, expect: 'function prepareMaxRetries(maxRetries: number | undefined): number {', lines: [
        '// 归一化并校验最大重试次数配置。',
        '// 未传时使用默认值；非整数或负数立即抛错，避免静默降级。',
        '// 校验放在构造阶段完成，运行期重试路径因此不必重复判断。',
        '// 返回的一定是合法的非负整数。',
      ] },
      { at: 169, expect: 'function getEffectiveTimeout({', lines: [
        '// 计算单次请求的实际超时：整体超时与单次超时取较小值。',
        '// 两者都缺省时返回 undefined，表示不启用超时。',
      ] },
      { at: 184, expect: 'function waitForAbort<T>(', lines: [
        '// 让一个 Promise 响应中止信号。',
        '// 未提供 signal 时直接返回原 Promise，零开销。',
        '// 包装后无论正常完成还是失败都会移除监听，避免泄漏。',
        '// 若 signal 已中止，会立即以中止原因拒绝。',
        '// 中止与正常完成竞争时，先到达者生效。',
      ] },
      { at: 219, expect: 'function mcpToModelOutput({', lines: [
        '// 把 MCP 工具结果转换为模型可消费的输出。',
        '// 字符串直接作为文本；非对象或缺少 content 时按 JSON 处理。',
        '// 文本分片原样保留，图片分片转换为文件分片。',
        '// 其余未知分片退化为 JSON 字符串，保证不丢信息。',
        '// 该函数只做形状转换，不修改原始结果。',
      ] },
      { at: 258, expect: 'export interface MCPClientConfig {', lines: [
        '// 创建 MCP 客户端的配置项。',
        '// 传输既可以是配置对象，也可以是调用方自行实现的自定义传输。',
        '// 事件、探测、初始化超时、重试与客户端身份都在这里声明。',
        '// 大部分字段有合理默认值，只有 transport 必填。',
        '// 具体语义见各字段上的注释。',
      ] },
      { at: 272, expect: 'protocolVersionDiscovery?: boolean;', lines: [
        '// 是否先用 server/discover 探测现代协议。',
        '// 对必须最先收到 initialize 的旧服务器应关闭。',
      ] },
      { at: 276, expect: 'initializationOptions?: RequestOptions;', lines: [
        '// 约束传输启动与 initialize 请求的超时和取消信号。',
        '// 初始化失败时，客户端会据此清理传输。',
      ] },
      { at: 287, expect: 'maxRetries?: number;', lines: [
        '// tools/call 的最大重试次数，仅作用于工具调用。',
        '// JSON-RPC 业务错误不会被重试。',
      ] },
      { at: 293, expect: 'initialInitializeResult?: InitializeResult;', lines: [
        '// 复用上一次会话的初始化结果，跳过重新握手。',
        '// 提供后客户端只启动传输，不再发送 initialize。',
      ] },
      { at: 309, expect: 'capabilities?: ClientCapabilities;', lines: [
        '// 初始化时向服务端声明的客户端能力。',
        '// 需要调用方自行处理对应的回调请求。',
      ] },
      { at: 312, expect: "export type ManagedMCPClient = Omit<MCPClient, 'experimental_events'> & {", lines: [
        '// 使用托管事件适配器时的客户端类型：experimental_events 收窄为 ManagedMCPEvents。',
        '// 便于调用方直接使用适配器提供的强类型方法。',
      ] },
      { at: 316, expect: 'export function createMCPClient(', lines: [
        '// 创建并初始化 MCP 客户端。',
        '// 三种重载根据是否传入事件适配器返回不同类型。',
        '// 工厂函数会等待 init 完成后再返回，调用方拿到即可使用。',
      ] },
      { at: 341, expect: 'export interface MCPClient {', lines: [
        '// MCP 客户端对外接口。',
        '// 覆盖工具、资源、提示、补全、事件与关闭等能力。',
        '// 服务信息与初始化结果只读暴露，便于调用方读取服务端元数据。',
        '// 所有可能触网的方法都接受 RequestOptions，可传入超时与取消信号。',
        '// 具体实现位于 DefaultMCPClient。',
      ] },
      { at: 366, expect: "tools<TOOL_SCHEMAS extends ToolSchemas = 'automatic'>(options?: {", lines: [
        '// 拉取服务端工具并转换为 AI SDK 工具集。',
        '// schemas 为 automatic 时按服务端 JSON Schema 动态生成。',
      ] },
      { at: 373, expect: 'listTools(options?: {', lines: [
        '// 列出工具，支持游标分页。',
        '// 返回结果包含 nextCursor，调用方可继续翻页。',
      ] },
      { at: 381, expect: 'callTool(args: {', lines: [
        '// 调用服务端工具。',
        '// arguments 会被原样作为工具入参发送。',
      ] },
      { at: 390, expect: "toolsFromDefinitions<TOOL_SCHEMAS extends ToolSchemas = 'automatic'>(", lines: [
        '// 在本地把已有工具定义转换为 AI SDK 工具，不触网。',
      ] },
      { at: 395, expect: 'listResources(options?: {', lines: [
        '// 列出资源，支持游标分页。',
        '// 返回结果可能包含 nextCursor。',
      ] },
      { at: 400, expect: 'readResource(args: {', lines: [
        '// 按 URI 读取单个资源内容。',
        '// 资源不存在时由服务端返回错误。',
      ] },
      { at: 405, expect: 'listResourceTemplates(options?: {', lines: [
        '// 列出资源模板，模板由服务端定义。',
        '// 模板本身不包含具体资源内容。',
      ] },
      { at: 409, expect: 'listPrompts(options?: {', lines: [
        '// 列出提示，支持游标分页。',
        '// 提示是服务端预置的可复用消息模板。',
      ] },
      { at: 414, expect: 'getPrompt(args: {', lines: [
        '// 获取指定提示并填入参数。',
        '// 返回结果为可渲染的消息列表。',
      ] },
      { at: 433, expect: 'complete(', lines: [
        '// 请求补全建议（如提示参数或资源 URI 的候选值）。',
        '// 需要服务端声明 completions 能力。',
      ] },
      { at: 439, expect: 'onElicitationRequest(', lines: [
        '// 注册处理服务端发起的补充输入（elicitation）请求。',
        '// 仅支持表单模式。',
      ] },
      { at: 446, expect: 'close: () => Promise<void>;', lines: [
        '// 关闭客户端并释放底层传输资源。',
      ] },
      { at: 465, expect: "class DefaultMCPClient implements Omit<MCPClient, 'experimental_events'> {", lines: [
        '// 默认实现：单服务端、轻量、面向工具转换。',
        '// 不处理带内通知、会话持久化与可续传 SSE。',
        '// 内部维护请求 ID、响应回调表与协议版本状态。',
        '// 一次实例只连接一个服务端；多服务端请创建多个实例。',
        '// 所有公开方法都委托给私有请求通道。',
      ] },
      { at: 466, expect: 'readonly experimental_events: MCPEvents | ManagedMCPEvents;', lines: [
        '// 事件能力在构造时确定，之后保持不变。',
        '// 可能是本地直连实现，也可能是托管适配器包装。',
        '// 两者都实现同一套 MCPEvents 接口。',
      ] },
      { at: 475, expect: 'private requestMessageId = 0;', lines: [
        '// 单调递增的请求 ID，用于匹配响应。',
      ] },
      { at: 476, expect: 'private responseHandlers: Map<', lines: [
        '// 已发出请求的响应回调表，按消息 ID 索引。',
        '// 连接关闭时会用统一错误通知所有挂起请求。',
      ] },
      { at: 480, expect: 'private serverCapabilities: ServerCapabilities = {};', lines: [
        '// 服务端在初始化时声明的能力，用于前置校验。',
      ] },
      { at: 482, expect: 'private _initializeResult: InitializeResult = {', lines: [
        '// 默认初始化结果，在握手完成前提供给调用方读取。',
        '// 握手成功后会被服务端返回的真实结果替换。',
      ] },
      { at: 488, expect: "private protocolEra: 'legacy' | 'modern' = 'legacy';", lines: [
        '// 当前协议代际：legacy 走 initialize，modern 走 discover。',
      ] },
      { at: 490, expect: 'private toolHeaderBindings = new Map<string, MCPToolHeaderBinding[]>();', lines: [
        '// 工具参数到请求头的绑定缓存，按工具名索引。',
      ] },
      { at: 491, expect: 'private isClosed = true;', lines: [
        '// 关闭标志，初始为已关闭，init 成功后置为可用。',
      ] },
      { at: 492, expect: 'private readonly closeController = new AbortController();', lines: [
        '// 客户端级中止控制器，关闭时统一取消所有在途请求。',
      ] },
      { at: 493, expect: 'private elicitationRequestHandler?: (', lines: [
        '// 补充输入处理器，由 onElicitationRequest 注册。',
      ] },
      { at: 497, expect: 'constructor({', lines: [
        '// 构造函数完成配置校验、传输创建与事件接线。',
        '// 不发起网络请求，真正的初始化在 init 中执行。',
        '// 事件适配器与本地存储互斥，二选一。',
        '// 传了适配器就必须提供 createAdapter 并满足操作契约。',
        '// 传输既可直接传入实例，也可传入配置由工厂创建。',
      ] },
      { at: 510, expect: 'if (', lines: [
        '// 事件适配器与本地 store / 参数校验不能同时配置。',
        '// 适配器自己负责参数校验，避免职责重叠。',
      ] },
      { at: 519, expect: 'if (', lines: [
        '// 适配器必须实现 createAdapter，否则无法产出操作集合。',
        '// 这里提前失败，比等到首次事件调用时才报错更易定位。',
      ] },
      { at: 528, expect: 'const operations = events?.adapter?.createAdapter({', lines: [
        '// 创建适配器操作集合，并把传输概要传给它。',
        '// 自定义传输不暴露 URL，只标注 type 为 custom。',
      ] },
      { at: 544, expect: 'if (isCustomMcpTransport(transportConfig)) {', lines: [
        '// 自定义传输直接使用；否则交给工厂按配置创建。',
        '// 这样上层无需关心具体传输类型。',
      ] },
      { at: 550, expect: 'this.transport.onclose = () => this.onClose();', lines: [
        '// 传输回调接线：关闭、错误与消息三条通道。',
        '// 消息带 method 时视为服务端请求或通知，否则视为响应。',
        '// 服务端请求目前只支持 ping 与 elicitation/create。',
      ] },
      { at: 569, expect: 'this.clientInfo = {', lines: [
        '// 记录客户端身份，initialize 时会随请求上报。',
        '// clientName 未传时回退到 name，再回退到默认名。',
      ] },
      { at: 573, expect: 'const directEvents = createMCPEvents({', lines: [
        '// 本地事件实现总是创建，作为托管适配器的底层来源。',
        '// 传入 store 或参数校验时交由它管理持久化。',
        '// 最终对外暴露的事件对象取决于是否配置了适配器。',
      ] },
      { at: 583, expect: 'get serverInfo(): Configuration {', lines: [
        '// 服务端信息，握手前为占位值。',
        '// 握手或探测成功后替换为真实值。',
      ] },
      { at: 587, expect: 'get initializeResult(): InitializeResult {', lines: [
        '// 完整初始化结果，包含协议版本与能力。',
        '// 由 initialize 响应或 discover 结果归一化得到。',
      ] },
      { at: 591, expect: 'get instructions(): string | undefined {', lines: [
        '// 服务端在握手中提供的使用说明，可选。',
        '// 调用方可把它拼进系统提示以提升调用正确率。',
      ] },
      { at: 595, expect: 'async init(): Promise<this> {', lines: [
        '// 启动传输并完成初始化或协议探测。',
        '// 超时由初始化选项控制，可与外部取消信号合并。',
        '// 优先复用调用方提供的初始化结果，其次尝试现代协议探测。',
        '// 探测失败或未启用时回退到 legacy initialize 握手。',
        '// 任一步失败都会关闭传输并清理状态，保证不残留半开连接。',
      ] },
      { at: 611, expect: 'if (timeout != null) {', lines: [
        '// 设置初始化超时定时器，到点主动中止。',
        '// 定时器与中止错误在 finally 中清理。',
      ] },
      { at: 620, expect: 'try {', lines: [
        '// 进入初始化主流程，失败时统一关闭传输。',
        '// 外部取消与超时会转换成明确的 MCPClientError。',
      ] },
      { at: 625, expect: 'if (this.initialInitializeResult) {', lines: [
        '// 有历史初始化结果时直接复用，跳过握手。',
        '// 复用前仍会按 schema 校验一次，防止脏数据。',
      ] },
      { at: 633, expect: 'if (', lines: [
        '// 传输支持探测且未禁用时，先尝试现代协议。',
        '// 探测成功即完成初始化，无需再走 legacy。',
      ] },
      { at: 643, expect: "this.protocolEra = 'legacy';", lines: [
        '// 回退到 legacy：固定协议版本并同步给传输。',
        '// 之后发送 initialize 并等待服务端能力。',
      ] },
      { at: 647, expect: 'const result = await this.request({', lines: [
        '// 发送 initialize 请求，附带客户端能力与身份。',
        '// 结果为 undefined 视为服务端返回非法数据。',
      ] },
      { at: 669, expect: 'await this.notification(', lines: [
        '// 握手完成后发送 initialized 通知，告知服务端可以开始。',
        '// 通知失败同样会使初始化整体失败。',
      ] },
      { at: 677, expect: '} catch (error) {', lines: [
        '// 初始化失败：关闭传输并转换错误。',
        '// 超时优先于取消，取消优先于原始错误。',
      ] },
      { at: 702, expect: 'private async tryProtocolDiscovery(', lines: [
        '// 尝试用 server/discover 建立现代协议会话。',
        '// 先把当前代际与版本切换为 modern，再发探测请求。',
        '// 探测超时可由传输自身控制，否则使用默认短超时。',
        '// 只有明确的现代协议错误码才视为“服务端不支持”而回退。',
        '// 其余错误原样抛出，避免掩盖真实故障。',
      ] },
      { at: 709, expect: 'try {', lines: [
        '// 发送探测请求；等待传输就绪时不再叠加默认超时。',
        '// 结果通过 applyDiscoverResult 归一化。',
      ] },
      { at: 723, expect: '} catch (error) {', lines: [
        '// 仅对现代协议错误码做兼容处理，其余直接抛出。',
        '// 版本被拒且服务端支持旧版本时，给出明确的配置指引。',
      ] },
      { at: 769, expect: 'private applyDiscoverResult(result: DiscoverResult): void {', lines: [
        '// 归一化探测结果：校验版本、提取服务信息并回填能力。',
        '// 服务信息来自 _meta 的约定键，缺失时保留原值。',
        '// 最终产出的初始化结果与 legacy 握手保持一致形状。',
      ] },
      { at: 776, expect: "const serverInfo = result._meta?.['io.modelcontextprotocol/serverInfo'];", lines: [
        '// 从 _meta 中读取服务端实现信息。',
        '// 只有 name 与 version 都是字符串时才采纳。',
      ] },
      { at: 798, expect: 'private setTransportProtocolVersion(version: string): void {', lines: [
        '// 把协议版本同步给传输：优先用方法，其次直接赋值。',
        '// 这样兼容仅暴露属性的简单传输实现。',
      ] },
      { at: 806, expect: 'private applyInitializeResult(result: InitializeResult): void {', lines: [
        '// 校验并应用 legacy initialize 结果。',
        '// 版本必须在支持列表内，否则直接失败。',
        '// 应用后同步代际、版本、能力与说明。',
      ] },
      { at: 822, expect: 'async close(): Promise<void> {', lines: [
        '// 关闭客户端：已关闭时幂等返回。',
        '// 关闭传输后再统一清理挂起请求。',
      ] },
      { at: 828, expect: 'private send(', lines: [
        '// 统一发送入口：无附加选项时走最简调用。',
        '// 这样避免给传输传空对象。',
      ] },
      { at: 837, expect: 'private assertCapability(method: string): void {', lines: [
        '// 按请求方法校验服务端是否声明了对应能力。',
        '// initialize 与 discover 不受能力约束。',
        '// 事件、工具、资源、提示、补全分别映射到各自能力位。',
        '// 未知方法直接判为不支持。',
        '// 校验失败统一抛 MCPClientError。',
      ] },
      { at: 890, expect: 'private async request<T extends z.ZodType<object>>({', lines: [
        '// 统一请求入口：现代协议下支持 input_required 多轮往返。',
        '// 非现代协议或不涉及补充输入的方法直接单次请求。',
        '// 多轮循环共享整体超时预算，避免每轮重新计时。',
        '// 每轮都可能向调用方索取补充输入，超过上限即失败。',
        '// 重建请求时从原始请求出发，防止状态跨轮泄漏。',
      ] },
      { at: 911, expect: 'for (let round = 0; ; round++) {', lines: [
        '// 多轮循环：每轮重新计算剩余超时预算。',
        '// 信号合并关闭控制器、超时控制器与调用方信号。',
        '// 任一方中止都会立即打断当前轮。',
      ] },
      { at: 944, expect: "if (result.resultType !== 'input_required') {", lines: [
        '// 非 input_required 结果直接按目标 schema 解析返回。',
        '// 需要补充输入时进入下面的处理分支。',
      ] },
      { at: 948, expect: 'const { inputRequests, requestState } =', lines: [
        '// 解析补充输入请求与下一轮需要回传的状态。',
        '// 轮数超过上限说明服务端反复追问，直接失败。',
      ] },
      { at: 956, expect: 'const responses: Record<string, ElicitResult> = Object.create(null);', lines: [
        '// 收集本轮每个输入请求的应答。',
        '// 目前仅支持表单模式的 elicitation/create。',
      ] },
      { at: 984, expect: 'const hasResponses = Object.keys(responses).length > 0;', lines: [
        '// 无应答时短暂退避，避免服务端立即再次追问造成空转。',
        '// 有应答则直接携带结果进入下一轮。',
      ] },
      { at: 992, expect: 'nextRequest = {', lines: [
        '// 从原始请求重建：合并应答与状态，丢弃上一轮临时字段。',
        '// 参数展开顺序保证 inputResponses 与 requestState 覆盖旧值。',
      ] },
      { at: 1000, expect: '} catch (error) {', lines: [
        '// 轮内异常处理：中止优先，其次保留原 MCPClientError。',
        '// 未知异常统一包装为处理失败。',
      ] },
      { at: 1021, expect: 'private async requestOnce<T extends z.ZodType<object>>({', lines: [
        '// 单次请求实现：把 JSON-RPC 请求发送出去并等待匹配响应。',
        '// 负责注册回调、设置超时、处理中止与清理。',
        '// 现代协议会给请求补 _meta（版本、能力、客户端信息）。',
        '// 工具调用还会根据绑定计算需要附加的请求头。',
        '// 发送失败与响应解析失败走同一条拒绝路径。',
      ] },
      { at: 1032, expect: 'return new Promise((resolve, reject) => {', lines: [
        '// 以 Promise 包装回调式传输：成功 resolve，失败 reject。',
        '// 所有退出路径都会经由 cleanup 移除监听与定时器。',
        '// 关闭后的客户端不允许再发请求。',
      ] },
      { at: 1057, expect: 'const messageId = this.requestMessageId++;', lines: [
        '// 分配消息 ID 并写入回调表，作为响应匹配依据。',
        '// ID 单调递增，避免同一连接内复用。',
      ] },
      { at: 1058, expect: 'const preparedRequest =', lines: [
        '// 现代协议下把版本、能力与客户端信息放入 _meta。',
        '// legacy 协议保持请求原样，不附加额外字段。',
        '// _meta 中已有内容会被保留，仅覆盖约定键。',
      ] },
      { at: 1075, expect: 'const jsonrpcRequest: JSONRPCRequest = {', lines: [
        '// 组装 JSON-RPC 请求，补齐 jsonrpc 与 id。',
        '// 其余字段沿用预处理后的请求。',
      ] },
      { at: 1080, expect: 'const headers = this.getToolRequestHeaders(preparedRequest);', lines: [
        '// 计算本次请求需要附加的 HTTP 头，非工具调用通常为空。',
        '// 头绑定缺失或不匹配时返回 undefined。',
      ] },
      { at: 1082, expect: 'const rejectWithAbortError = () => {', lines: [
        '// 中止时的统一拒绝：包装成带原因的 MCPClientError。',
        '// 保证调用方拿到的是可识别的错误类型。',
      ] },
      { at: 1091, expect: 'const cleanup = () => {', lines: [
        '// 清理：移除回调、中止监听与超时定时器。',
        '// 所有终态路径都必须调用它，避免资源泄漏。',
      ] },
      { at: 1099, expect: 'const rejectAndCleanup = (error: unknown) => {', lines: [
        '// 先清理再拒绝，保证不会留下悬挂的定时器。',
        '// 发送失败与解析失败共用这一路径。',
      ] },
      { at: 1104, expect: 'const onAbort = () => {', lines: [
        '// 中止回调：清理后以中止错误拒绝。',
        '// 监听器设置为 once，触发后自动移除。',
      ] },
      { at: 1109, expect: 'const onTimeout = () => {', lines: [
        '// 超时回调：构造超时错误并主动中止超时控制器。',
        '// 中止会进一步触发传输层的取消。',
      ] },
      { at: 1117, expect: 'this.responseHandlers.set(messageId, response => {', lines: [
        '// 注册响应处理器：负责类型守卫、错误转换与 schema 解析。',
        '// 已中止时直接拒绝；收到 Error 时原样拒绝。',
        '// 现代协议要求结果带 resultType，缺失视为协议错误。',
      ] },
      { at: 1159, expect: "signal?.addEventListener('abort', onAbort, { once: true });", lines: [
        '// 监听中止；发送前注册，确保竞态下也能收到通知。',
        '// 监听器只触发一次，清理时会移除。',
      ] },
      { at: 1161, expect: 'if (timeout != null) {', lines: [
        '// 启动超时定时器，超时后拒绝并中止传输。',
        '// 未配置超时时不创建定时器。',
      ] },
      { at: 1165, expect: 'const sendOptions: MCPTransportSendOptions = {', lines: [
        '// 仅在确有内容时构造发送选项，避免空对象。',
        '// 传输信号与请求头都可能缺省。',
      ] },
      { at: 1174, expect: 'sendPromise.catch(error => {', lines: [
        '// 发送失败同样走清理加拒绝，与响应路径保持一致。',
        '// 此时响应处理器已注册，清理会一并移除。',
      ] },
      { at: 1180, expect: 'async listTools({', lines: [
        '// 列出工具；首页会重置请求头绑定缓存。',
        '// 分页请求仅追加，不重置，保证绑定表完整。',
        '// 返回值经过 prepareToolDefinitions 过滤。',
      ] },
      { at: 1195, expect: 'private prepareToolDefinitions(', lines: [
        '// 为现代协议准备工具定义：解析并缓存请求头绑定。',
        '// 绑定解析失败的工具会被剔除并上报错误。',
        '// 非现代协议或不支持头绑定的传输直接原样返回。',
      ] },
      { at: 1206, expect: 'if (resetHeaderBindings) {', lines: [
        '// 首页重置绑定缓存，避免旧工具残留。',
        '// 后续分页只增量写入。',
      ] },
      { at: 1227, expect: 'private getToolRequestHeaders(', lines: [
        '// 为工具调用计算请求头：仅现代协议且参数为对象时生效。',
        '// 没有绑定或参数形状不符时返回 undefined。',
        '// 头生成失败会包装成 MCPClientError 再抛出。',
      ] },
      { at: 1238, expect: 'const bindings = this.toolHeaderBindings.get(request.params.name);', lines: [
        '// 取出该工具的绑定声明。',
        '// 未声明绑定的工具不需要附加头。',
      ] },
      { at: 1261, expect: 'private async callToolWithRetry({', lines: [
        '// 工具调用重试包装：未开启重试时直接执行。',
        '// 开启后仅对可重试的网络类错误生效。',
        '// 最终失败会包装为带最后一次原因的错误。',
      ] },
      { at: 1272, expect: 'return retryWithExponentialBackoff({', lines: [
        '// 指数退避重试，携带调用方的中止信号。',
        '// 重试判定与错误构造都在此配置。',
      ] },
      { at: 1284, expect: 'async callTool({', lines: [
        '// 调用服务端工具，默认参数为空对象。',
        '// 实际发送走统一请求通道，并受重试包装。',
        '// 返回原始 CallToolResult，由上层决定如何转换。',
      ] },
      { at: 1307, expect: 'private async listResourcesInternal({', lines: [
        '// 资源列表的内部实现，公开方法只是转调。',
        '// 单独抽出便于事件适配器复用同一通道。',
      ] },
      { at: 1321, expect: 'private async readResourceInternal({', lines: [
        '// 读取资源的内部实现。',
        '// 参数仅包含 URI 与请求选项。',
      ] },
      { at: 1335, expect: 'private async listResourceTemplatesInternal({', lines: [
        '// 资源模板列表的内部实现。',
        '// 该方法不接受分页参数。',
      ] },
      { at: 1347, expect: 'private async listPromptsInternal({', lines: [
        '// 提示列表的内部实现，支持游标分页。',
        '// 公开方法与其废弃别名都转调这里。',
      ] },
      { at: 1361, expect: 'private async getPromptInternal({', lines: [
        '// 获取提示的内部实现，把 arguments 原样透传。',
        '// 参数名在内部统一为 args，避免遮蔽外层 arguments。',
      ] },
      { at: 1377, expect: 'private async completeInternal({', lines: [
        '// 补全请求的内部实现，其余参数直接展开为请求参数。',
        '// options 单独取出，不进入 JSON-RPC 参数。',
      ] },
      { at: 1390, expect: 'private async notification(', lines: [
        '// 发送 JSON-RPC 通知（无 id、无响应）。',
        '// 补齐 jsonrpc 版本后交给传输，并支持中止。',
        '// 通知失败会向上抛出，由调用方决定是否忽略。',
      ] },
      { at: 1412, expect: "async tools<TOOL_SCHEMAS extends ToolSchemas = 'automatic'>({", lines: [
        '// 拉取全部工具并转换为 AI SDK 工具集。',
        '// 首页之后按 nextCursor 循环翻页，直到服务端不再返回游标。',
        '// 合并后的定义统一交给 toolsFromDefinitions 处理。',
        '// schemas 选项透传给转换逻辑，用于显式声明入/出参结构。',
      ] },
      { at: 1420, expect: 'while (definitions.nextCursor != null) {', lines: [
        '// 按游标翻页，逐页累积工具定义。',
        '// 每页请求都不重置绑定缓存，保证缓存与结果一致。',
      ] },
      { at: 1435, expect: "toolsFromDefinitions<TOOL_SCHEMAS extends ToolSchemas = 'automatic'>(", lines: [
        '// 把工具定义转换为 AI SDK 工具，不触网。',
        '// 先按协议与传输能力准备定义（可能剔除非法头绑定工具）。',
        '// 再逐个构建工具，注入元数据、执行器与输出转换。',
        '// 返回以工具名为键的集合。',
      ] },
      { at: 1442, expect: 'const tools: Record<string, Tool & { _meta?: ToolMeta }> =', lines: [
        '// 用无原型对象承载工具，避免与 Object 原型属性冲突。',
        '// 工具名来自服务端，理论上可能命中原型链键名。',
      ] },
      { at: 1445, expect: 'for (const {', lines: [
        '// 逐个处理工具定义。',
        '// 指定了 schemas 时，只保留其中声明的工具。',
        '// 标题优先取工具自身 title，其次取注解中的 title。',
      ] },
      { at: 1462, expect: 'const outputSchema =', lines: [
        '// 仅显式声明 schemas 时才解析输出结构。',
        '// automatic 模式不校验结构化输出，直接返回原始结果。',
      ] },
      { at: 1465, expect: 'const metadata = {', lines: [
        '// 组装提供商元数据：客户端名、工具名、标题、注解与 App 信息。',
        '// 只有非空字段才会写入，保持元数据精简。',
      ] },
      { at: 1500, expect: 'const execute = async (', lines: [
        '// 工具执行器：先检查中止，再调用服务端工具。',
        '// 工具返回错误时原样返回，交由模型感知失败。',
        '// 声明了输出结构时，从结果中提取并校验结构化内容。',
        '// 否则直接返回原始结果。',
      ] },
      { at: 1522, expect: 'const toolWithExecute =', lines: [
        '// 根据 schemas 模式选择 dynamicTool 或强类型 tool。',
        '// automatic 模式使用服务端 JSON Schema，并禁止额外属性。',
        '// 显式模式使用调用方提供的输入/输出结构。',
        '// 两种模式共用同一执行器与输出转换。',
      ] },
      { at: 1555, expect: 'private async extractStructuredContent(', lines: [
        '// 从工具结果中提取并校验结构化内容。',
        '// 优先使用 structuredContent，其次回退到文本内容解析。',
        '// 两者都不满足时抛出明确错误。',
      ] },
      { at: 1560, expect: "if ('structuredContent' in result && result.structuredContent != null) {", lines: [
        '// 优先路径：structuredContent 存在时直接按 schema 校验。',
        '// 校验失败说明服务端返回不符合约定，直接报错。',
      ] },
      { at: 1577, expect: "if ('content' in result && Array.isArray(result.content)) {", lines: [
        '// 回退路径：从文本内容中解析 JSON 并校验。',
        '// 仅取第一个文本分片作为候选。',
      ] },
      { at: 1604, expect: 'listResources({', lines: [
        '// 公开的资源列表方法，转调内部实现。',
        '// 参数原样透传，不做额外校验。',
      ] },
      { at: 1614, expect: 'readResource({', lines: [
        '// 公开的资源读取方法，转调内部实现。',
        '// uri 必须由调用方提供。',
      ] },
      { at: 1624, expect: 'listResourceTemplates({', lines: [
        '// 公开的资源模板列表方法，转调内部实现。',
        '// 仅接受请求选项。',
      ] },
      { at: 1632, expect: 'listPrompts({', lines: [
        '// 公开的提示列表方法，转调内部实现。',
        '// 支持游标分页。',
      ] },
      { at: 1642, expect: 'getPrompt({', lines: [
        '// 公开的提示获取方法，转调内部实现。',
        '// arguments 与内部命名不同，此处做一次映射。',
      ] },
      { at: 1655, expect: 'experimental_listPrompts(', lines: [
        '// 兼容旧名：experimental_listPrompts 转调 listPrompts。',
        '// 已标记废弃，保留仅为平滑迁移。',
      ] },
      { at: 1662, expect: 'experimental_getPrompt(', lines: [
        '// 兼容旧名：experimental_getPrompt 转调 getPrompt。',
        '// 参数类型直接复用公开方法的签名。',
      ] },
      { at: 1668, expect: 'complete(', lines: [
        '// 补全请求公开方法，转调内部实现。',
        '// options 随参数一起传入。',
      ] },
      { at: 1676, expect: 'onElicitationRequest(', lines: [
        '// 注册补充输入处理器。',
        '// 目前只接受 ElicitationRequestSchema，其他 schema 直接拒绝。',
        '// 注册后服务端的 elicitation/create 请求会交给它处理。',
      ] },
      { at: 1692, expect: 'private async onRequestMessage(request: JSONRPCRequest): Promise<void> {', lines: [
        '// 处理服务端主动发起的 JSON-RPC 请求。',
        '// 目前支持 ping 与 elicitation/create 两类。',
        '// ping 直接回空结果；其余未知方法返回“方法不存在”。',
        '// 未注册处理器或参数非法时也以 JSON-RPC 错误应答。',
        '// 处理器抛错会转成内部错误响应，并上报未捕获错误。',
      ] },
      { at: 1694, expect: "if (request.method === 'ping') {", lines: [
        '// ping 用于保活，立即回空结果。',
        '// 不触发任何业务逻辑。',
      ] },
      { at: 1703, expect: "if (request.method !== 'elicitation/create') {", lines: [
        '// 非补充输入请求一律拒绝，避免暴露未实现能力。',
        '// 错误码 -32601 表示方法不存在。',
      ] },
      { at: 1715, expect: 'if (!this.elicitationRequestHandler) {', lines: [
        '// 没有注册处理器时明确告知服务端，而不是静默失败。',
        '// 调用方可先用 onElicitationRequest 注册。',
      ] },
      { at: 1727, expect: 'const parsedRequest = ElicitationRequestSchema.safeParse({', lines: [
        '// 解析并校验补充输入请求的结构。',
        '// 只取 method 与 params，忽略其余字段。',
      ] },
      { at: 1732, expect: 'if (!parsedRequest.success) {', lines: [
        '// 结构非法时返回 -32602，并附上具体校验问题。',
        '// 便于服务端定位参数错误。',
      ] },
      { at: 1745, expect: 'try {', lines: [
        '// 调用处理器并把结果按 schema 校验后回传。',
        '// 处理器或校验失败都转成内部错误响应。',
      ] },
      { at: 1746, expect: 'const result = await this.elicitationRequestHandler(parsedRequest.data);', lines: [
        '// 处理器可能异步，这里统一 await。',
        '// 返回值必须符合 ElicitResult 结构。',
      ] },
      { at: 1768, expect: '} catch (error) {', lines: [
        '// 外层兜底：任何未预料的异常都上报，不影响传输。',
        '// 该路径通常只会在发送自身失败时触发。',
      ] },
      { at: 1773, expect: 'private onClose(): void {', lines: [
        '// 连接关闭的统一处理。',
        '// 幂等：已关闭时直接返回。',
        '// 中止关闭控制器，让所有在途请求立即失败。',
        '// 用同一个错误回调所有挂起请求并清空回调表。',
      ] },
      { at: 1781, expect: 'this.closeController.abort(error);', lines: [
        '// 中止客户端级控制器，通知所有在途请求。',
        '// 关闭错误会作为中止原因向下传递。',
      ] },
      { at: 1783, expect: 'for (const handler of this.responseHandlers.values()) {', lines: [
        '// 逐个回调挂起请求，保证它们不会永远等待。',
        '// 回调后立即清空，避免重复触发。',
      ] },
      { at: 1790, expect: 'private onError(error: unknown): void {', lines: [
        '// 错误上报钩子：仅当调用方注册了回调时才转发。',
        '// 未注册时静默丢弃，保持客户端不因通知失败而崩溃。',
      ] },
      { at: 1796, expect: 'private onResponse(response: JSONRPCResponse | JSONRPCError): void {', lines: [
        '// 处理传入的响应或错误消息。',
        '// 缺少 id 视为协议错误并上报，不中断后续消息。',
        '// 未知 id 说明响应与请求不匹配，直接抛协议错误。',
        '// 命中回调后先移出回调表，再交付结果或错误。',
        '// 错误分支会包装成带 code 与 data 的 MCPClientError。',
      ] },
      { at: 1797, expect: 'if (response.id == null) {', lines: [
        '// 没有 id 的响应无法匹配任何请求。',
        '// 按协议错误处理并上报。',
      ] },
      { at: 1808, expect: 'const messageId = Number(response.id);', lines: [
        '// 响应 id 在传输层可能被序列化为字符串，这里统一转数字。',
        '// 查找对应的挂起请求回调。',
      ] },
      { at: 1811, expect: 'if (handler === undefined) {', lines: [
        '// 找不到回调说明响应与请求不匹配，属于协议错误。',
        '// 该错误直接抛出，由传输层或调用方感知。',
      ] },
      { at: 1819, expect: 'this.responseHandlers.delete(messageId);', lines: [
        '// 交付前移除回调，避免重复处理同一响应。',
        '// 之后的清理逻辑不会重复删除。',
      ] },
      { at: 1821, expect: 'handler(', lines: [
        '// 成功响应直接交付；错误响应包装后交付。',
        '// 包装保留原始 code、data 与 cause，便于上层区分。',
      ] },
    ],
  },
  {
    name: 'mcp-apps.ts',
    want: [6, 6],
    blocks: [
      { at: 1, expect: "import { isJSONObject, type JSONObject } from '@ai-sdk/provider';", lines: [
        '// ============================================================================',
        '// mcp-apps：MCP Apps 扩展的元数据解析与资源读取',
        '// 负责识别工具的 ui:// 资源、拆分模型可见与应用可见工具、读取并校验资源 HTML。',
        '// ============================================================================',
      ] },
      { at: 86, expect: 'function getToolUiMeta(meta?: ToolMeta): JSONObject | undefined {', lines: [
        '// 取出工具 _meta.ui，仅在确实是 JSON 对象时返回。',
        '// 非对象值一律视为未声明，避免后续读取抛错。',
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
