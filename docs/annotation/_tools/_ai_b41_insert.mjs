// B41 insert: mcp-event-webhook.ts + mcp-stdio/mcp-stdio-transport.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/';
const files = [
  {
    name: 'tool/mcp-event-webhook.ts',
    want: [27, 31],
    blocks: [
      { at: 1, expect: "import { safeParseJSON } from '@ai-sdk/provider-utils';", lines: [
        '// ============================================================================',
        '// mcp-event-webhook：MCP 事件回调的 Web Request 处理器',
        '// 负责校验签名、识别控制帧，并把事件交给应用回调。',
        '// 所有失败都以相应 HTTP 状态码返回，便于服务端重试。',
      ] },
      { at: 3, expect: "import { MCP_EVENT_CALLBACK_KEY } from './mcp-events';", lines: [
        '// 回调地址中的订阅键参数名。',
        '// 事件定义与订阅状态都来自 mcp-event-types。',
      ] },
      { at: 15, expect: 'const MAX_BODY_BYTES = 256 * 1024;', lines: [
        '// 请求体上限：256 KiB。',
        '// 既用于 Content-Length 预检，也用于流式读取时累计计数。',
        '// 验证握手请求单独用一个最小的 schema。',
      ] },
      { at: 21, expect: 'export type MCPEventWebhookOptions = {', lines: [
        '// 回调处理器的配置。',
        '// store 保存订阅状态与游标；onEvent 处理普通事件。',
        '// onGap/onTerminated 分别处理回放缺口与订阅终止。',
        '// onError 只用于观察，不影响返回码。',
      ] },
      { at: 73, expect: 'export function createMCPEventWebhook({', lines: [
        '// 返回一个可直接挂到路由上的处理函数。',
        '// 校验失败一律拒绝，不向调用方泄漏具体原因。',
        '// 只有通过签名与内容校验后才会触发业务回调。',
        '// 返回 204 表示已被持久接受，服务端无需重试。',
      ] },
      { at: 82, expect: "if (request.method !== 'POST') {", lines: [
        '// 只接受 POST，并显式声明允许的方法。',
        '// 非 JSON 请求体返回 415。',
      ] },
      { at: 99, expect: 'const key = new URL(request.url).searchParams.get(MCP_EVENT_CALLBACK_KEY);', lines: [
        '// 从查询参数取订阅键，从请求头取订阅 ID。',
        '// 两者缺一不可，且必须与已保存的订阅匹配。',
        '// 不匹配时统一返回 401，避免暴露订阅是否存在。',
      ] },
      { at: 111, expect: 'const reader = request.body?.getReader();', lines: [
        '// 流式读取请求体，边读边累计长度。',
        '// Content-Length 可缺省且不可信，因此必须二次限长。',
        '// 超限时取消读取并返回 413。',
      ] },
      { at: 136, expect: 'if (', lines: [
        '// 校验签名：请求头、原始字节与订阅密钥。',
        '// 校验通过后才解析 JSON，避免为伪造请求做无用解析。',
      ] },
      { at: 151, expect: 'let control: MCPEventControl | undefined;', lines: [
        '// 带 type 字段的对象可能是控制帧。',
        '// verification 帧直接回显 challenge。',
      ] },
    ],
  },
  {
    name: 'tool/mcp-stdio/mcp-stdio-transport.ts',
    want: [40, 44],
    blocks: [
      { at: 1, expect: "import type { ChildProcess, IOType } from 'node:child_process';", lines: [
        '// ============================================================================',
        '// mcp-stdio-transport：基于子进程标准输入输出的 MCP 传输',
        '// 服务端以子进程形式启动，消息按行分隔通过 stdin/stdout 交换。',
        '// 该实现只负责字节收发与分行，不解析具体业务。',
        '// 子进程异常退出会触发 onclose，读写错误会触发 onerror。',
      ] },
      { at: 3, expect: "import { parseJSONRPCMessage, type JSONRPCMessage } from '../json-rpc-message';", lines: [
        '// JSON-RPC 消息解析与传输接口。',
        '// 错误统一使用 MCPClientError。',
      ] },
      { at: 8, expect: 'export interface StdioConfig {', lines: [
        '// 启动子进程所需的配置。',
        '// stderr 可重定向到流或文件描述符，便于收集服务端日志。',
        '// cwd 与 shell 直接透传给子进程创建逻辑。',
      ] },
      { at: 17, expect: 'export class StdioMCPTransport implements MCPTransport {', lines: [
        '// 标准输入输出传输实现。',
        '// 支持协议版本探测，因此声明 supportsProtocolVersionDiscovery。',
        '// 同一实例只允许启动一次，关闭后不可复用。',
        '// 消息以换行符为边界，读取缓冲按行切分。',
      ] },
      { at: 19, expect: 'private process?: ChildProcess;', lines: [
        '// 子进程句柄与中止控制器。',
        '// readBuffer 缓存尚未成行的字节。',
      ] },
      { at: 24, expect: 'onclose?: () => void;', lines: [
        '// 传输回调：关闭、错误与消息。',
        '// 没有 protocolVersion 字段，版本由上层协商。',
      ] },
      { at: 28, expect: 'constructor(server: StdioConfig) {', lines: [
        '// 仅保存配置，不在构造阶段启动进程。',
        '// 真正的启动发生在 start() 中。',
      ] },
      { at: 32, expect: 'async start(): Promise<void> {', lines: [
        '// 启动子进程并挂接事件。',
        '// 已启动时直接抛错，避免重复占用。',
        '// Promise 在 spawn 事件后 resolve，而非构造完成即返回。',
      ] },
      { at: 39, expect: 'return new Promise((resolve, reject) => {', lines: [
        '// 创建子进程；中止信号会随之传递给子进程。',
        '// 创建失败同样走 catch 分支。',
      ] },
      { at: 48, expect: "this.process.on('error', error => {", lines: [
        '// 子进程错误：主动中止视为正常关闭。',
        '// 其他错误先 reject，再上报给调用方。',
      ] },
      { at: 62, expect: "this.process.on('close', _code => {", lines: [
        '// 进程退出后清空句柄并通知关闭。',
        '// 之后的 send 会因缺少 stdin 而失败。',
      ] },
      { at: 71, expect: "this.process.stdout?.on('data', chunk => {", lines: [
        '// 收到数据先入缓冲，再尝试按行解析。',
        '// 不等待解析完成，避免阻塞数据流。',
      ] },
      { at: 79, expect: '} catch (error) {', lines: [
        '// 同步创建异常：同时 reject 与上报。',
        '// 此时 this.process 尚未赋值。',
      ] },
      { at: 86, expect: 'private async processReadBuffer() {', lines: [
        '// 循环取出完整行并逐行反序列化。',
        '// 单行解析失败只上报，不中断后续行。',
        '// 缓冲区无完整行时退出循环，等待下次数据到达。',
      ] },
      { at: 102, expect: 'async close(): Promise<void> {', lines: [
        '// 关闭传输：中止子进程并清空缓冲。',
        '// 清空 process 后重复关闭是安全的。',
      ] },
      { at: 108, expect: 'send(message: JSONRPCMessage): Promise<void> {', lines: [
        '// 发送消息：序列化为单行 JSON 后写入 stdin。',
        '// 未连接时抛错，而不是静默丢弃。',
        '// 写入被背压时等待 drain 再 resolve。',
      ] },
      { at: 110, expect: 'if (!this.process?.stdin) {', lines: [
        '// 没有可用 stdin，说明未启动或已关闭。',
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
