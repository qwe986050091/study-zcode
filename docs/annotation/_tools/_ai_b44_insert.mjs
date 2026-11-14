// B44 insert: json-rpc-message.ts + oauth-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/';
const files = [
  {
    name: 'tool/json-rpc-message.ts',
    want: [18, 20],
    blocks: [
      { at: 1, expect: "import { parseJSON } from '@ai-sdk/provider-utils';", lines: [
        '// ============================================================================',
        '// json-rpc-message：JSON-RPC 2.0 消息的 schema 与解析入口',
        '// 区分请求、通知、成功响应与错误响应四种形态。',
        '// 所有 schema 均为 strict，未知字段会被拒绝。',
        '// 请求与响应共享 id 约束，通知则完全不带 id。',
        '// 解析入口统一走 zod，错误由调用方决定如何呈现。',
      ] },
      { at: 5, expect: "const JSONRPC_VERSION = '2.0';", lines: [
        '// 固定协议版本；每个 schema 都以此做字面量校验。',
        '// 请求与响应共用 id 类型：字符串或整数。',
      ] },
      { at: 7, expect: 'const JSONRPCRequestSchema = z', lines: [
        '// 请求：必须有 id 与 method。',
        '// 通用请求字段来自 RequestSchema。',
      ] },
      { at: 17, expect: 'const JSONRPCResponseSchema = z', lines: [
        '// 成功响应：id 与 result 必填。',
      ] },
      { at: 27, expect: 'const JSONRPCErrorSchema = z', lines: [
        '// 错误响应：id 可缺省（解析失败时），error 必填。',
      ] },
      { at: 41, expect: 'const JSONRPCNotificationSchema = z', lines: [
        '// 通知：只有 method 与可选 params，没有 id。',
      ] },
      { at: 55, expect: 'export const JSONRPCMessageSchema = z.union([', lines: [
        '// 任意一条消息按四种形态依次匹配。',
        '// strict 约束让未知字段尽早暴露问题。',
        '// 导出推导类型供传输层与客户端复用。',
      ] },
      { at: 64, expect: 'export function validateJSONRPCMessage(message: unknown): JSONRPCMessage {', lines: [
        '// 同步校验：不通过时由 zod 抛出结构化错误。',
      ] },
      { at: 68, expect: 'export async function parseJSONRPCMessage(', lines: [
        '// 先安全解析 JSON，再走同一套校验。',
      ] },
    ],
  },
  {
    name: 'error/oauth-error.ts',
    want: [13, 15],
    blocks: [
      { at: 3, expect: "const name = 'AI_MCPClientOAuthError';", lines: [
        '// ============================================================================',
        '// oauth-error：MCP 客户端 OAuth 流程的错误类型',
        '// 通过 marker 与 Symbol 实现跨包 instanceof 稳定判断。',
        '// 子类只覆盖 errorCode，供错误码到类别的映射使用。',
      ] },
      { at: 10, expect: 'export class MCPClientOAuthError extends AISDKError {', lines: [
        '// OAuth 流程的基类错误。',
        '// 私有 symbol 字段用于标记实例来源。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// name 可被覆盖，便于子类复用构造函数。',
      ] },
      { at: 25, expect: 'static isInstance(error: unknown): error is MCPClientOAuthError {', lines: [
        '// 基于 marker 的类型守卫。',
      ] },
      { at: 29, expect: 'export class ServerError extends MCPClientOAuthError {', lines: [
        '// 以下四个标准 OAuth 错误分别对应服务端返回的 error 值。',
      ] },
      { at: 45, expect: "const mismatchName = 'AI_AuthorizationServerMismatchError';", lines: [
        '// 授权服务器不匹配单独使用一套 marker。',
      ] },
      { at: 49, expect: 'export class AuthorizationServerMismatchError extends MCPClientOAuthError {', lines: [
        '// 当发现元数据与预期授权服务器不一致时抛出。',
      ] },
      { at: 63, expect: 'export const OAUTH_ERRORS = {', lines: [
        '// error_code 到错误类的查找表，便于按字符串还原具体类型。',
        '// 未登记的错误码由调用方按未知错误处理。',
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
