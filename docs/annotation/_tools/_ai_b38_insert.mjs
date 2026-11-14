// B38 insert: mcp-http-transport.ts + mcp-http-headers.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/tool/';
const files = [
  {
    name: 'mcp-http-transport.ts',
    want: [174, 180],
    blocks: [
      { at: 1, expect: 'import {', lines: [
        '// ============================================================================',
        '// mcp-http-transport：Streamable HTTP 传输实现',
        '// 用 POST 发送消息，用 GET + SSE 接收服务端推送，兼容新旧两代协议。',
        '// 负责会话 ID 管理、401 自动授权、入站 SSE 断线重连与消息解析。',
        '// ============================================================================',
      ] },
      { at: 2, expect: 'EventSourceParserStream,', lines: [
        '// SSE 解析与 User-Agent 构造来自 provider-utils。',
        '// FetchFunction 允许调用方注入自定义 fetch。',
      ] },
      { at: 7, expect: "import { MCPClientError } from '../error/mcp-client-error';", lines: [
        '// 传输层统一使用 MCPClientError 上报错误，便于上层区分。',
      ] },
      { at: 8, expect: 'import {', lines: [
        '// JSON-RPC 消息的解析与形状校验。',
      ] },
      { at: 13, expect: "import type { MCPTransport, MCPTransportSendOptions } from './mcp-transport';", lines: [
        '// 传输接口与发送选项类型。',
      ] },
      { at: 14, expect: "import { VERSION } from '../version';", lines: [
        '// 版本号用于拼接 User-Agent。',
      ] },
      { at: 15, expect: 'import {', lines: [
        '// OAuth 相关：401 时触发授权流程。',
      ] },
      { at: 22, expect: 'import {', lines: [
        '// 新旧协议版本常量，用于判断当前代际。',
      ] },
      { at: 26, expect: "import { encodeMCPHeaderValue } from './mcp-http-headers';", lines: [
        '// 工具参数头需要按规范编码（必要时 base64）。',
      ] },
      { at: 28, expect: 'function isMessageEvent(event: string | undefined): boolean {', lines: [
        '// 判断 SSE 事件是否应作为普通消息处理。',
        '// 未标注 event 或标注为 message 都视为普通消息。',
        '// 其他命名事件（如自定义心跳）一律忽略。',
      ] },
      { at: 39, expect: 'export class HttpMCPTransport implements MCPTransport {', lines: [
        '// Streamable HTTP 传输实现。',
        '// 发送走 POST，接收既可能是 JSON 响应，也可能是 SSE 流。',
        '// 旧协议额外维护一条常驻入站 SSE 连接。',
        '// 新协议把会话、版本与工具头放在请求头中。',
        '// 关闭时会尽力终止服务端会话。',
        '// 重连采用指数退避，且只在旧协议下生效。',
        '// 所有对外回调都是可选的，未设置时静默跳过。',
      ] },
      { at: 40, expect: 'readonly supportsProtocolVersionDiscovery = true;', lines: [
        '// 该传输支持 server/discover 协议探测。',
        '// 同时需要等待探测完成后再建立 SSE 连接。',
      ] },
      { at: 43, expect: 'private url: URL;', lines: [
        '// 服务端 MCP 端点。',
      ] },
      { at: 44, expect: 'private abortController?: AbortController;', lines: [
        '// 传输级中止控制器，start 时创建，close 时中止。',
      ] },
      { at: 46, expect: 'private authProvider?: OAuthClientProvider;', lines: [
        '// OAuth 提供者；存在时才会在 401 后自动授权。',
      ] },
      { at: 48, expect: 'private sessionId?: string;', lines: [
        '// 服务端会话 ID，旧协议下随请求头回传。',
      ] },
      { at: 49, expect: 'private inboundSseConnection?: { close: () => void };', lines: [
        '// 旧协议的入站 SSE 连接句柄。',
      ] },
      { at: 52, expect: 'private authPromise?: Promise<AuthResult>;', lines: [
        '// 并发 401 时复用同一个授权过程，避免重复弹窗。',
        '// 授权结束（无论成败）后清空，允许后续再次触发。',
      ] },
      { at: 53, expect: 'private onSessionIdChange?: (sessionId: string | undefined) => void;', lines: [
        '// 会话 ID 变化的回调，交给上层持久化。',
      ] },
      { at: 54, expect: 'private onSessionExpired?: (sessionId: string) => void;', lines: [
        '// 会话过期回调，用于提示上层重建客户端。',
      ] },
      { at: 55, expect: 'private terminateSessionOnClose: boolean;', lines: [
        '// 关闭时是否向服务端发送 DELETE 终止会话。',
      ] },
      { at: 58, expect: 'private lastInboundEventId?: string;', lines: [
        '// 最近一次入站事件 ID，断线重连时作为 resume token。',
      ] },
      { at: 59, expect: 'private inboundReconnectAttempts = 0;', lines: [
        '// 当前已重连次数，成功后清零。',
      ] },
      { at: 60, expect: 'private readonly reconnectionOptions = {', lines: [
        '// 入站 SSE 重连参数。',
        '// 延迟按指数增长并封顶，最多重试两次。',
        '// 这些值固定，如需调整需修改实现。',
      ] },
      { at: 67, expect: 'onclose?: () => void;', lines: [
        '// 关闭通知。',
      ] },
      { at: 68, expect: 'onerror?: (error: unknown) => void;', lines: [
        '// 错误通知。',
      ] },
      { at: 69, expect: 'onmessage?: (message: JSONRPCMessage) => void;', lines: [
        '// 收到 JSON-RPC 消息的通知。',
      ] },
      { at: 70, expect: 'protocolVersion?: string;', lines: [
        '// 当前协议版本，由上层在探测或握手后设置。',
      ] },
      { at: 72, expect: 'constructor({', lines: [
        '// 构造函数只保存配置，不发起请求。',
        '// 未指定协议版本时默认使用旧版常量。',
        '// 未注入 fetch 时回退到全局 fetch。',
        '// 回调用于把会话变化同步给上层。',
      ] },
      { at: 108, expect: 'setProtocolVersion(version: string): void {', lines: [
        '// 更新协议版本，并据此调整入站 SSE。',
        '// 传输未启动时只记录版本，不做其它动作。',
        '// 切到新协议时关闭旧协议的常驻 SSE。',
        '// 切回旧协议且尚无连接时补建入站 SSE。',
      ] },
      { at: 126, expect: 'private isModernProtocol(): boolean {', lines: [
        '// 判断当前是否为新协议。',
        '// 未设置版本时视为最新协议。',
        '// 该判断决定会话头、工具头与 SSE 行为。',
      ] },
      { at: 133, expect: 'private async commonHeaders({', lines: [
        '// 构造所有请求共用的头部。',
        '// 合并基础头、调用方头与协议版本头。',
        '// 旧协议下按需附加会话 ID。',
        '// 有 OAuth 令牌时附加 Bearer 认证。',
      ] },
      { at: 147, expect: 'if (!this.isModernProtocol() && includeSessionId && this.sessionId) {', lines: [
        '// 旧协议才使用会话头；新协议通过其它机制关联会话。',
      ] },
      { at: 151, expect: 'if (this.authProvider) {', lines: [
        '// 已登录时优先使用现成令牌。',
      ] },
      { at: 158, expect: 'return withUserAgentSuffix(', lines: [
        '// 统一追加 SDK 与运行时 User-Agent。',
        '// 这样服务端可识别请求来源。',
      ] },
      { at: 165, expect: 'private setSessionId(sessionId: string | undefined): void {', lines: [
        '// 更新会话 ID，仅在变化时通知上层。',
        '// 避免重复回调造成无意义的持久化。',
        '// 传 undefined 表示会话失效或结束。',
      ] },
      { at: 174, expect: 'private applySessionIdFromResponse(response: Response): void {', lines: [
        '// 从响应头读取服务端下发的会话 ID。',
        '// 新协议不使用会话头，直接返回。',
        '// 只有响应确实带会话头时才更新。',
      ] },
      { at: 185, expect: 'private expireSessionId(sessionId: string): void {', lines: [
        '// 标记会话过期。',
        '// 若过期的正是当前会话，则清空本地会话 ID。',
        '// 无论是否为当前会话，都通知上层。',
      ] },
      { at: 196, expect: 'private authorizeOnce(', lines: [
        '// 为并发 401 执行一次授权流程。',
        '// 没有 OAuth 提供者时直接返回需要重定向。',
        '// 已有进行中的授权时复用同一个 Promise。',
        '// 完成后清空，允许后续再次授权。',
      ] },
      { at: 218, expect: 'async start(): Promise<void> {', lines: [
        '// 启动传输。',
        '// 重复启动会直接报错。',
        '// 旧协议下立即建立入站 SSE；新协议由上层驱动。',
      ] },
      { at: 225, expect: 'this.abortController = new AbortController();', lines: [
        '// 创建传输级中止控制器。',
      ] },
      { at: 227, expect: 'if (', lines: [
        '// 仅当明确使用旧协议时才提前建立 SSE。',
      ] },
      { at: 235, expect: 'async close(options?: { signal?: AbortSignal }): Promise<void> {', lines: [
        '// 关闭传输。',
        '// 先关闭入站 SSE 并中止所有在途请求。',
        '// 旧协议下尽力发送 DELETE 终止服务端会话。',
        '// 清理过程中的错误被吞掉，最后一定触发 onclose。',
        '// 关闭是幂等的：重复调用不会重复发送 DELETE。',
      ] },
      { at: 239, expect: 'try {', lines: [
        '// 会话终止是尽力而为，失败不影响关闭结果。',
      ] },
      { at: 249, expect: 'await this.fetchFn(this.url.href, {', lines: [
        '// 发送 DELETE 并忽略响应。',
        '// 网络错误同样忽略。',
      ] },
      { at: 256, expect: '} catch {}', lines: [
        '// 外部取消等异常在此吞掉，保证关闭流程完整。',
      ] },
      { at: 261, expect: 'async send(', lines: [
        '// 发送一条 JSON-RPC 消息。',
        '// 合并传输信号与调用方信号，任一中止都会取消请求。',
        '// 401 时触发授权并重试一次。',
        '// 响应可能是 JSON、SSE 流或空确认，分别处理。',
        '// 所有错误都会先上报 onerror 再抛出。',
        '// 通知类消息不等待响应，直接结束。',
      ] },
      { at: 275, expect: 'const attempt = async (triedAuth: boolean = false): Promise<void> => {', lines: [
        '// 单次发送尝试；triedAuth 防止授权后无限重试。',
      ] },
      { at: 277, expect: 'const isInitializeRequest =', lines: [
        '// initialize 请求不带会话头：此时会话尚未建立。',
        '// 其余请求沿用当前会话。',
      ] },
      { at: 296, expect: 'const init = {', lines: [
        '// POST 请求只接受 JSON 或 SSE 响应。',
        '// 重定向模式由构造参数决定，默认拒绝跟随。',
      ] },
      { at: 308, expect: 'if (response.status === 401 && this.authProvider && !triedAuth) {', lines: [
        '// 401 且尚未授权过：从挑战头提取元数据并授权。',
        '// 授权未完成时抛未授权错误。',
        '// 授权成功后用 triedAuth 重试一次。',
      ] },
      { at: 329, expect: 'if (response.status === 202) {', lines: [
        '// 202 表示消息已被接受但没有响应体。',
        '// 旧协议下借此机会补建之前可能失败的入站 SSE。',
        '// 不 await，避免阻塞发送流程。',
      ] },
      { at: 338, expect: 'if (!response.ok) {', lines: [
        '// 非 2xx：先尝试把响应体解析为 JSON-RPC 错误。',
        '// 能解析出错误消息时交给 onmessage，而不是抛传输错误。',
        '// 否则构造带状态码与响应体的传输错误。',
      ] },
      { at: 341, expect: "if ('id' in message && text != null) {", lines: [
        '// 只有带 id 的请求才可能收到 JSON-RPC 错误响应。',
        '// 解析失败时忽略，继续走通用错误路径。',
      ] },
      { at: 357, expect: 'if (response.status === 404) {', lines: [
        '// 404 在旧协议下通常意味着会话过期或服务端不支持 HTTP 传输。',
        '// 携带会话时标记过期，并提示重建客户端。',
      ] },
      { at: 369, expect: 'const error = new MCPClientError({', lines: [
        '// 构造统一错误并上报。',
        '// 保留状态码、URL 与原始响应体，便于上层诊断。',
      ] },
      { at: 381, expect: "const isNotification = !('id' in message);", lines: [
        '// 通知没有 id，不期待 JSON-RPC 响应。',
        '// 部分服务端会返回 200 确认，此时直接结束。',
      ] },
      { at: 386, expect: "const contentType = response.headers.get('content-type') || '';", lines: [
        '// 根据响应内容类型决定解析方式。',
        '// 缺失时按未知类型处理。',
      ] },
      { at: 387, expect: "if (contentType.includes('application/json')) {", lines: [
        '// JSON 响应可能是单条消息，也可能是消息数组。',
        '// 逐条校验后依次交给 onmessage。',
      ] },
      { at: 398, expect: "if (contentType.includes('text/event-stream')) {", lines: [
        '// SSE 响应：流式解析事件并逐条分发。',
        '// 没有 body 视为协议错误。',
        '// 只有普通 message 事件会被解析成 JSON-RPC。',
      ] },
      { at: 415, expect: 'const processEvents = async () => {', lines: [
        '// 事件读取循环；解析失败只上报不中断。',
        '// 中止导致的中断静默退出。',
      ] },
      { at: 421, expect: 'if (isMessageEvent(event)) {', lines: [
        '// 只处理普通消息事件。',
        '// 单条解析失败会包装成 MCPClientError 上报。',
      ] },
      { at: 446, expect: 'void processEvents().catch(error => {', lines: [
        '// 后台消费事件流，不阻塞 send 返回。',
        '// 中止错误静默忽略。',
      ] },
      { at: 458, expect: 'const error = new MCPClientError({', lines: [
        '// 不支持的内容类型直接报错。',
        '// 保留状态码与 URL 便于定位。',
      ] },
      { at: 465, expect: '} catch (error) {', lines: [
        '// 调用方主动中止时原样抛出，避免被包装成传输错误。',
        '// 其他错误先上报再抛出。',
      ] },
      { at: 477, expect: 'private getStandardRequestHeaders(', lines: [
        '// 新协议下把请求语义放进头部。',
        '// Mcp-Method 总是携带。',
        '// 资源读取用 URI，工具调用与提示获取用名称。',
        '// 名称需要按规范编码。',
      ] },
      { at: 484, expect: 'const name =', lines: [
        '// 不同方法从不同参数取名称。',
        '// 无法确定时不附加 Mcp-Name。',
      ] },
      { at: 498, expect: 'private getNextReconnectionDelay(attempt: number): number {', lines: [
        '// 计算下一次重连延迟。',
        '// 按增长因子指数放大，并受上限约束。',
      ] },
      { at: 510, expect: 'private scheduleInboundSseReconnection(): void {', lines: [
        '// 安排入站 SSE 重连。',
        '// 超过最大次数时上报错误并停止。',
        '// 延迟到点后若传输已中止则放弃。',
      ] },
      { at: 512, expect: 'if (maxRetries > 0 && this.inboundReconnectAttempts >= maxRetries) {', lines: [
        '// 达到重试上限：上报错误，不再重连。',
        '// 上限为 0 表示不限制。',
      ] },
      { at: 529, expect: 'private startInboundSse(', lines: [
        '// 启动入站 SSE（旧协议专用）。',
        '// 以 fire-and-forget 方式打开，错误通过 onerror 上报。',
      ] },
      { at: 546, expect: 'private async openInboundSse(', lines: [
        '// 打开入站 SSE 连接，尽力而为且可恢复。',
        '// 新协议不需要该连接，直接返回。',
        '// 401 时授权后重试一次，405 表示服务端不支持。',
      ] },
      { at: 555, expect: 'const sessionIdForRequest = this.sessionId;', lines: [
        '// 记录发起时的会话，便于 404 时判断是否过期。',
        '// 该值在响应处理后可能已被更新。',
      ] },
      { at: 565, expect: 'const response = await this.fetchFn(this.url.href, {', lines: [
        '// GET 请求接受 SSE。',
        '// 传输中止会同时取消该连接。',
      ] },
      { at: 574, expect: 'if (response.status === 401 && this.authProvider && !triedAuth) {', lines: [
        '// SSE 连接同样需要处理 401。',
        '// 授权未完成时只上报错误并返回，不重试。',
        '// 授权成功后重试一次，并保留 resume token。',
      ] },
      { at: 595, expect: 'if (response.status === 405) {', lines: [
        '// 405 表示服务端不支持入站 SSE。',
        '// 这是合法情况，静默返回。',
      ] },
      { at: 599, expect: 'if (!response.ok || !response.body) {', lines: [
        '// 非 2xx 或没有响应体：会话过期时先标记，再上报错误。',
      ] },
      { at: 613, expect: 'const stream = response.body', lines: [
        '// 解码并按 SSE 协议解析事件流。',
        '// 每条事件可能带 id，用于断点续传。',
      ] },
      { at: 618, expect: 'const processEvents = async () => {', lines: [
        '// 入站事件循环；异常时触发重连。',
      ] },
      { at: 633, expect: 'if (isMessageEvent(event)) {', lines: [
        '// 只解析普通消息事件。',
        '// 解析失败上报但不终止整个流。',
      ] },
      { at: 646, expect: '} catch (error) {', lines: [
        '// 中止导致的退出不重连。',
        '// 其他异常上报后按策略重连。',
      ] },
      { at: 657, expect: 'this.inboundSseConnection = {', lines: [
        '// 暴露关闭句柄：取消 reader 即可结束连接。',
        '// 取消时的错误同样会被上报。',
      ] },
      { at: 668, expect: 'void processEvents().catch(error => {', lines: [
        '// 后台消费事件流。',
        '// 非中止错误会触发重连。',
      ] },
      { at: 677, expect: '} catch (error) {', lines: [
        '// 建连阶段的异常：中止则静默退出。',
        '// 其他异常上报并安排重连。',
      ] },
    ],
  },
  {
    name: 'mcp-http-headers.ts',
    want: [43, 45],
    blocks: [
      { at: 1, expect: "import { convertUint8ArrayToBase64, isRecord } from '@ai-sdk/provider-utils';", lines: [
        '// ============================================================================',
        '// mcp-http-headers：工具参数到 HTTP 头的绑定解析与编码',
        '// 从工具 JSON Schema 中提取 x-mcp-header 注解，并在调用时生成请求头。',
        '// ============================================================================',
      ] },
      { at: 3, expect: "type HeaderValueType = 'boolean' | 'integer' | 'string';", lines: [
        '// 允许绑定到请求头的基础类型。',
        '// 复杂类型无法安全地表达为单个头值。',
      ] },
      { at: 11, expect: 'export type MCPToolHeaderBindingsResult =', lines: [
        '// 解析结果：成功返回绑定列表，失败返回原因。',
        '// 使用判别联合，避免调用方额外判空。',
      ] },
      { at: 16, expect: 'const BASE64_SENTINEL_PATTERN = /^=\\?base64\\?.*\\?=$/;', lines: [
        '// 识别已经采用 base64 哨兵格式的值，避免重复编码。',
      ] },
      { at: 18, expect: 'export function encodeMCPHeaderValue(value: string): string {', lines: [
        '// 按 MCP 规范编码头值。',
        '// 纯可打印 ASCII 且无首尾空白时原样返回。',
        '// 其余情况（含非 ASCII、换行、首尾空白、哨兵格式）转 base64。',
        '// base64 形式包裹在 =?base64?…?= 中，便于服务端识别。',
        '// 编码后不会引入非法头字符。',
      ] },
      { at: 32, expect: 'return `=?base64?${convertUint8ArrayToBase64(new TextEncoder().encode(value))}?=`;', lines: [
        '// UTF-8 编码后转 base64，避免头中出现非 ASCII 字节。',
        '// 哨兵格式与已编码值一致，因此需要上面的重复编码保护。',
      ] },
      { at: 35, expect: 'export function getMCPToolHeaderBindings(', lines: [
        '// 从工具 inputSchema 中提取头绑定声明。',
        '// 仅支持在静态可达的属性上声明 x-mcp-header。',
        '// 头名必须是合法且唯一的 HTTP token。',
        '// 只允许 boolean、integer、string 三种类型。',
      ] },
      { at: 38, expect: 'if (!isRecord(inputSchema)) {', lines: [
        '// 非对象 schema 无法遍历，直接失败。',
        '// 错误信息明确指出来源要求。',
      ] },
      { at: 45, expect: 'const bindings: MCPToolHeaderBinding[] = [];', lines: [
        '// 收集绑定与已占用的小写头名。',
        '// 头名比较不区分大小写，因此统一转小写去重。',
        '// error 一旦写入就停止继续遍历。',
      ] },
      { at: 49, expect: 'const visit = (', lines: [
        '// 深度遍历 schema 节点。',
        '// staticallyReachable 表示当前节点是否位于 properties 链上。',
        '// 只有可静态定位的属性路径才允许声明头绑定。',
        '// 一旦出错立即短路，避免产生部分结果。',
      ] },
      { at: 58, expect: "if ('x-mcp-header' in value) {", lines: [
        '// 处理头绑定声明：校验可达性、头名与类型。',
        '// 不可达或位于根节点时视为非法声明。',
        '// 重复头名会被拒绝，防止后写覆盖前写。',
      ] },
      { at: 79, expect: 'const valueType = value.type;', lines: [
        '// 只有基础类型才能安全地序列化为头值。',
      ] },
      { at: 94, expect: 'for (const [key, child] of Object.entries(value)) {', lines: [
        '// 递归遍历子节点。',
        '// 只有 properties 下的子节点保持“静态可达”。',
      ] },
      { at: 116, expect: 'function getValueAtPath(', lines: [
        '// 按键路径从参数对象中取值。',
        '// 中途遇到非对象时返回 undefined。',
        '// 该函数不抛错，缺失路径视为未提供。',
      ] },
      { at: 130, expect: 'export function createMCPToolHeaders({', lines: [
        '// 根据绑定与本次调用参数生成请求头。',
        '// 参数未提供（null/undefined）时跳过该头。',
        '// 类型不匹配时抛 TypeError，避免发送错误值。',
        '// 生成的头名统一加 Mcp-Param- 前缀。',
      ] },
      { at: 155, expect: 'headers[`Mcp-Param-${binding.headerName}`] = encodeMCPHeaderValue(', lines: [
        '// 头值统一经过编码，兼容非 ASCII 与空白。',
        '// 数字与布尔值先转字符串再编码。',
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
