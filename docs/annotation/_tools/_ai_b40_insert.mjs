// B40 insert: mock-mcp-transport.ts + mcp-sse-transport.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/tool/';
const files = [
  {
    name: 'mock-mcp-transport.ts',
    want: [109, 115],
    blocks: [
      { at: 1, expect: "import { delay } from '@ai-sdk/provider-utils';", lines: [
        '// ============================================================================',
        '// mock-mcp-transport：内存版 MCP 传输实现',
        '// 用固定数据模拟 initialize、工具、资源、提示与补全等请求。',
        '// 仅用于测试与示例，不涉及任何网络 IO。',
        '// 通过构造参数可替换全部模拟数据或注入错误。',
      ] },
      { at: 2, expect: "import type { JSONRPCMessage } from './json-rpc-message';", lines: [
        '// JSON-RPC 消息类型。',
        '// 类型定义来自协议与 mcp 包的公共类型。',
        '// 这样模拟数据与真实传输保持同一形状。',
      ] },
      { at: 4, expect: 'import {', lines: [
        '// 协议版本与各类协议结果类型。',
        '// 默认工具会随包一起导出，便于测试直接引用。',
        '// 所有类型都只用于编译期。',
      ] },
      { at: 12, expect: 'const DEFAULT_TOOLS: MCPTool[] = [', lines: [
        '// 默认模拟工具集。',
        '// 一个带必填参数的普通工具，一个无参数工具。',
        '// 覆盖工具调用时“有参数/无参数”两种路径。',
        '// 参数 schema 固定为字符串，便于断言。',
      ] },
      { at: 32, expect: 'export class MockMCPTransport implements MCPTransport {', lines: [
        '// 模拟传输实现。',
        '// 所有 send 都同步或短延迟地通过 onmessage 回包。',
        '// 可按方法分别替换返回数据，也可让 start 触发错误。',
        '// 未覆盖的方法返回协议错误。',
        '// 该实现不维护连接状态，start/close 都是无操作。',
        '// 适合单元测试中替换真实传输。',
      ] },
      { at: 33, expect: 'private tools;', lines: [
        '// 以下字段保存构造时注入的模拟数据。',
        '// 每个字段对应一类请求的返回结果。',
        '// 默认值见构造函数参数。',
        '// 字段顺序与请求分发顺序无关。',
      ] },
      { at: 45, expect: 'onmessage?: (message: JSONRPCMessage) => void;', lines: [
        '// 传输对外回调：消息、关闭与错误。',
        '// 模拟实现只使用 onmessage 与 onerror。',
        '// protocolVersion 由上层设置，本实现不使用。',
        '// 保留该字段以满足 MCPTransport 接口。',
      ] },
      { at: 49, expect: 'constructor({', lines: [
        '// 构造函数：全部参数可选，默认提供一套可用的模拟数据。',
        '// 默认资源、提示与模板互相配套，便于端到端测试。',
        '// failOnInvalidToolParams 用于模拟参数校验失败。',
        '// sendError 用于模拟启动阶段的传输错误。',
        '// toolCallResults 可按工具名覆盖返回值。',
        '// completionResult 为空时补全请求返回不支持。',
      ] },
      { at: 135, expect: 'this.tools = overrideTools;', lines: [
        '// 把注入数据保存到实例字段。',
        '// 这里不做深拷贝，测试可直接修改数组观察效果。',
        '// 字段之间不交叉校验，保持实现简单。',
      ] },
      { at: 148, expect: 'async start(): Promise<void> {', lines: [
        '// 启动模拟传输。',
        '// 仅当 sendError 为真时触发一次错误回调。',
        '// 不做连接建立，也不改变任何状态。',
        '// 因此重复调用是安全的。',
        '// 错误对象形状与真实传输保持一致。',
      ] },
      { at: 157, expect: 'async send(message: JSONRPCMessage): Promise<void> {', lines: [
        '// 模拟服务端响应。',
        '// 只有带 method 与 id 的请求才会被处理。',
        '// 各类方法按顺序匹配，命中后通过 onmessage 回包。',
        '// 每个分支都使用短延迟模拟异步往返。',
        '// 未匹配的方法静默忽略，不产生响应。',
        '// 可在此基础上扩展新的模拟方法。',
      ] },
      { at: 159, expect: "if ('method' in message && 'id' in message) {", lines: [
        '// 只处理请求；通知与响应不在此模拟范围内。',
        '// 带 id 才能构造对应的 JSON-RPC 响应。',
        '// 该判断决定了后续所有分支的前提。',
        '// 缺少任一字段时直接返回。',
      ] },
      { at: 160, expect: "if (message.method === 'initialize') {", lines: [
        '// initialize：返回协议版本、服务端信息与能力。',
        '// 能力按实际注入的数据动态生成。',
        '// 未注入 initializeResult 时使用默认值。',
        '// 这样测试无需手写完整握手结果。',
      ] },
      { at: 181, expect: "if (message.method === 'completion/complete') {", lines: [
        '// 补全请求：未配置结果时返回“方法不支持”。',
        '// 配置了则原样回传。',
        '// 该分支用于测试服务端能力的可选性。',
        '// 错误码 -32601 对应 JSON-RPC 的 Method not found。',
      ] },
      { at: 202, expect: "if (message.method === 'resources/list') {", lines: [
        '// 资源列表：直接返回注入的资源数组。',
        '// 不实现分页，因此不返回 nextCursor。',
        '// 资源内容在 resources/read 中单独提供。',
        '// 结果形状与协议一致。',
      ] },
      { at: 213, expect: "if (message.method === 'resources/read') {", lines: [
        '// 读取资源：按 URI 过滤内容。',
        '// 支持文本与二进制两种内容。',
        '// 未找到时返回资源不存在错误。',
        '// 错误码 -32002 对应协议中的资源不存在。',
      ] },
      { at: 220, expect: 'if (contents.length === 0) {', lines: [
        '// 没有任何内容匹配该 URI。',
        '// 错误信息带上 URI，便于定位。',
        '// 该分支不再返回正常结果。',
      ] },
      { at: 241, expect: "if (message.method === 'resources/templates/list') {", lines: [
        '// 资源模板列表：返回注入的模板。',
        '// 模板本身不含内容，仅供客户端展示。',
        '// 同样不支持分页。',
      ] },
      { at: 252, expect: "if (message.method === 'prompts/list') {", lines: [
        '// 提示列表：返回注入的提示定义。',
        '// 提示参数在定义中声明。',
        '// 不实现分页。',
      ] },
      { at: 263, expect: "if (message.method === 'prompts/get') {", lines: [
        '// 获取提示：按名称查找预置结果。',
        '// 未配置的提示返回参数错误。',
        '// 结果包含说明与消息列表。',
        '// 错误码 -32602 对应 Invalid params。',
      ] },
      { at: 267, expect: 'if (!result) {', lines: [
        '// 未知提示名。',
        '// 错误信息包含名称，便于排查。',
        '// 命中后立即返回错误响应。',
      ] },
      { at: 285, expect: "if (message.method === 'tools/list') {", lines: [
        '// 工具列表：返回注入的工具定义。',
        '// 空列表视为不支持工具能力。',
        '// 该约定用于测试服务端未声明 tools 的场景。',
        '// 不支持时返回 -32000。',
        '// 正常时原样返回工具数组。',
      ] },
      { at: 287, expect: 'if (this.tools.length === 0) {', lines: [
        '// 没有工具时不返回空列表，而是报不支持。',
        '// 这与部分真实服务端的行为一致。',
      ] },
      { at: 307, expect: "if (message.method === 'tools/call') {", lines: [
        '// 工具调用：先查找工具，再处理参数与自定义结果。',
        '// 未知工具返回 -32601 并附带可用工具列表。',
        '// failOnInvalidToolParams 为真时模拟参数校验失败。',
        '// 命中自定义结果时优先返回。',
      ] },
      { at: 312, expect: 'if (!tool) {', lines: [
        '// 未知工具：错误数据中同时给出可用工具与请求工具。',
        '// 这让测试可以断言错误载荷。',
        '// 命中后立即返回。',
      ] },
      { at: 328, expect: 'if (this.failOnInvalidToolParams) {', lines: [
        '// 模拟参数校验失败，往返参数原样回显。',
        '// 便于测试客户端对 -32602 的处理。',
      ] },
      { at: 346, expect: 'const customResult = this.toolCallResults[toolName as string];', lines: [
        '// 按工具名取自定义结果。',
        '// 不存在时回退到默认文本结果。',
      ] },
      { at: 356, expect: 'this.onmessage?.({', lines: [
        '// 默认返回一段固定文本，表示调用成功。',
        '// 该结果不包含 structuredContent。',
        '// 足够覆盖大多数工具转换逻辑。',
      ] },
      { at: 372, expect: 'async close(): Promise<void> {', lines: [
        '// 关闭模拟传输：只需通知 onclose。',
        '// 没有真实资源需要释放。',
        '// 重复关闭不会产生副作用。',
      ] },
    ],
  },
  {
    name: 'mcp-sse-transport.ts',
    want: [97, 103],
    blocks: [
      { at: 1, expect: 'import {', lines: [
        '// ============================================================================',
        '// mcp-sse-transport：旧版 HTTP+SSE 传输实现',
        '// GET 建立 SSE 接收端点，POST 向服务端发送消息。',
      ] },
      { at: 7, expect: "import { MCPClientError } from '../error/mcp-client-error';", lines: [
        '// 统一错误类型与协议消息解析。',
        '// 这些依赖与 Streamable HTTP 传输保持一致。',
      ] },
      { at: 8, expect: "import { parseJSONRPCMessage, type JSONRPCMessage } from './json-rpc-message';", lines: [
        '// JSON-RPC 消息解析器。',
      ] },
      { at: 11, expect: 'import {', lines: [
        '// OAuth 授权入口与 401 挑战解析。',
      ] },
      { at: 20, expect: 'function isMessageEvent(event: string | undefined): boolean {', lines: [
        '// 判断 SSE 事件是否应作为消息处理。',
        '// 未命名事件与 message 事件都算。',
      ] },
      { at: 24, expect: 'export class SseMCPTransport implements MCPTransport {', lines: [
        '// 旧版 SSE 传输实现。',
        '// 通过 endpoint 事件获得 POST 地址，之后才能发送消息。',
        '// 401 时复用同一个授权过程，避免并发重复授权。',
      ] },
      { at: 25, expect: 'private endpoint?: URL;', lines: [
        '// 服务端下发的 POST 端点，收到前不可发送。',
        '// 其余字段保存连接、认证与请求配置。',
      ] },
      { at: 32, expect: 'private headers?: Record<string, string>;', lines: [
        '// 调用方自定义请求头。',
        '// 协议版本头会在此基础上覆盖。',
      ] },
      { at: 33, expect: 'private authProvider?: OAuthClientProvider;', lines: [
        '// OAuth 提供者；存在时才会自动处理 401。',
      ] },
      { at: 39, expect: 'onclose?: () => void;', lines: [
        '// 传输回调：关闭、错误与消息。',
        '// 另保留协议版本字段以满足接口。',
        '// 该实现只有一条 SSE 连接，无重连逻辑。',
      ] },
      { at: 44, expect: 'constructor({', lines: [
        '// 保存配置并解析 URL。',
        '// redirect 默认为 error，避免静默跟随重定向。',
        '// 未注入 fetch 时回退到全局 fetch。',
      ] },
      { at: 64, expect: 'setProtocolVersion(version: string): void {', lines: [
        '// 更新协议版本，后续请求头会使用该值。',
      ] },
      { at: 68, expect: 'private async commonHeaders(', lines: [
        '// 构造请求头：自定义头、基础头与协议版本头。',
        '// 有令牌时附加 Bearer 认证。',
        '// 最后统一追加 User-Agent。',
      ] },
      { at: 78, expect: 'if (this.authProvider) {', lines: [
        '// 已登录时使用现成访问令牌。',
      ] },
      { at: 95, expect: 'private authorizeOnce(', lines: [
        '// 为并发 401 执行一次授权。',
        '// 未配置提供者时直接要求重定向。',
      ] },
      { at: 99, expect: 'if (!this.authProvider) {', lines: [
        '// 没有 OAuth 提供者，无法自动授权。',
      ] },
      { at: 103, expect: 'if (!this.authPromise) {', lines: [
        '// 复用进行中的授权，结束后清空以允许再次触发。',
        '// finally 保证无论成功失败都会释放。',
      ] },
      { at: 117, expect: 'private async accessTokenChanged(', lines: [
        '// 判断 401 前后访问令牌是否已变化。',
        '// 变化说明别的请求已完成授权，可直接重试。',
        '// 未拿到令牌时视为未变化。',
      ] },
      { at: 126, expect: 'async start(): Promise<void> {', lines: [
        '// 建立 SSE 连接。',
        '// 已连接时幂等返回。',
        '// 收到 endpoint 事件才算启动成功。',
        '// 返回的 Promise 只表示握手完成，不表示流已结束。',
        '// 失败通过 reject 抛出，同时触发 onerror。',
      ] },
      { at: 128, expect: 'if (this.connected) {', lines: [
        '// 已连接：无需重复建立。',
      ] },
      { at: 134, expect: 'const establishConnection = async (triedAuth: boolean = false) => {', lines: [
        '// 建连尝试；triedAuth 防止授权后无限重试。',
        '// 所有失败都会先上报再 reject。',
        '// 中止导致的失败静默返回。',
      ] },
      { at: 145, expect: 'if (response.status === 401 && this.authProvider && !triedAuth) {', lines: [
        '// 401 且尚未授权：解析挑战并执行授权。',
        '// 授权未完成时以未授权错误失败。',
        '// 成功后再尝试一次建连。',
      ] },
      { at: 166, expect: 'if (!response.ok || !response.body) {', lines: [
        '// 非 2xx 或缺少响应体视为建连失败。',
        '// 405 时给出改用 http 传输的提示。',
        '// 错误对象保留状态码、URL 与响应体。',
      ] },
      { at: 170, expect: 'if (response.status === 405) {', lines: [
        '// 405 通常表示服务端不支持 SSE 传输。',
      ] },
      { at: 185, expect: 'const stream = response.body', lines: [
        '// 解码并按 SSE 协议解析事件流。',
        '// 事件可能是 endpoint，也可能是普通消息。',
        '// 只有收到 endpoint 后才会 resolve。',
      ] },
      { at: 191, expect: 'const processEvents = async () => {', lines: [
        '// 事件读取循环。',
        '// 连接异常关闭与 endpoint 缺失是两类不同错误。',
        '// 解析单条消息失败不应中断整个流。',
        '// 循环只在流结束或被中止时退出。',
      ] },
      { at: 196, expect: 'if (done) {', lines: [
        '// 流结束：主动中止时静默退出。',
        '// 已连接后结束视为连接意外关闭。',
        '// 未收到 endpoint 就结束则报启动失败。',
      ] },
      { at: 201, expect: 'if (this.connected) {', lines: [
        '// 已建立连接的流被关闭，说明连接中断。',
      ] },
      { at: 217, expect: "if (event === 'endpoint') {", lines: [
        '// endpoint 事件：确定后续 POST 地址。',
        '// 只接受第一个 endpoint，之后的忽略。',
        '// 地址必须与连接同源，防止被引导到其他服务器。',
        '// 同源校验通过后才标记已连接并 resolve。',
      ] },
      { at: 224, expect: 'if (endpoint.origin !== this.url.origin) {', lines: [
        '// 端点跨源：关闭连接并中止传输。',
        '// 清理已设置的状态，避免后续误用。',
      ] },
      { at: 237, expect: '} else if (isMessageEvent(event)) {', lines: [
        '// 普通消息事件：解析后交给 onmessage。',
        '// 单条解析失败只上报错误，继续处理后续事件。',
      ] },
      { at: 252, expect: '} catch (error) {', lines: [
        '// 读取阶段异常：中止则静默退出。',
        '// 其他异常上报并 reject。',
      ] },
      { at: 262, expect: 'this.sseConnection = {', lines: [
        '// 暴露关闭句柄：取消 reader 即可结束连接。',
      ] },
      { at: 281, expect: 'async close(): Promise<void> {', lines: [
        '// 关闭传输：清空状态、取消读取并中止请求。',
        '// 最后一定触发 onclose。',
        '// 没有真实连接时这些操作都是安全的。',
        '// 关闭后 endpoint 失效，再次 send 会报未连接。',
      ] },
      { at: 289, expect: 'async send(', lines: [
        '// 向服务端发送消息。',
        '// 未连接时直接报错。',
        '// 合并传输信号与调用方信号。',
        '// 消息使用 POST 发往 endpoint 事件给出的地址。',
        '// 发送成功后由 SSE 通道异步回传响应。',
      ] },
      { at: 295, expect: 'if (!this.endpoint || !this.connected) {', lines: [
        '// 尚未收到 endpoint 或连接已断开。',
        '// 此时无法确定 POST 地址。',
      ] },
      { at: 301, expect: 'const endpoint = this.endpoint as URL;', lines: [
        '// 计算本次请求的中止信号。',
        '// 优先保证传输关闭时能中断请求。',
      ] },
      { at: 310, expect: 'const attempt = async (triedAuth: boolean = false): Promise<void> => {', lines: [
        '// 单次发送尝试。',
        '// 401 时先判断令牌是否已被其他请求刷新。',
      ] },
      { at: 325, expect: 'if (response.status === 401 && this.authProvider && !triedAuth) {', lines: [
        '// 令牌已变化则直接重试，避免重复授权。',
        '// 否则解析挑战并授权。',
        '// 授权未完成时抛未授权错误。',
      ] },
      { at: 347, expect: 'if (!response.ok) {', lines: [
        '// 非 2xx：读取响应体并构造传输错误。',
        '// 错误包含状态码与端点地址。',
      ] },
      { at: 357, expect: '} catch (error) {', lines: [
        '// 调用方主动中止时原样抛出。',
        '// 其他错误先上报再抛出。',
      ] },
      { at: 369, expect: 'export async function deserializeMessage(', lines: [
        '// 把一行原始数据解析为 JSON-RPC 消息。',
        '// 保留为独立导出，便于复用与测试。',
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
