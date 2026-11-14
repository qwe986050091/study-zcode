// B43 insert: packages/mcp/src/index.ts + tool/mcp-event-signature.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/';
const files = [
  {
    name: 'index.ts',
    want: [14, 17],
    blocks: [
      { at: 1, expect: "export { validateJSONRPCMessage } from './tool/json-rpc-message';", lines: [
        '// ============================================================================',
        '// @ai-sdk/mcp 公共入口',
        '// 汇总客户端、传输、协议类型、OAuth 与实验性事件能力。',
        '// 运行时导出保持稳定；实验性能力统一加 Experimental_ 前缀。',
        '// 类型与值分开导出，避免运行时代码被无意引入。',
      ] },
      { at: 11, expect: 'export {', lines: [
        '// 稳定导出：客户端工厂与配置类型。',
        '// 传输实现由调用方自行选择并传入。',
      ] },
      { at: 16, expect: 'export {', lines: [
        '// MCP Apps 资源读取与工具拆分。',
        '// fingerprint 与 drift 用于检测资源变更。',
      ] },
      { at: 29, expect: "export { ElicitationRequestSchema, ElicitResultSchema } from './tool/types';", lines: [
        '// 协议 schema：交互请求与结果。',
        '// 工具相关的类型随后以别名导出。',
      ] },
      { at: 43, expect: "export { auth, UnauthorizedError } from './tool/oauth';", lines: [
        '// OAuth 授权入口与未授权错误。',
        '// 客户端错误类型单独导出，便于 instanceof 判断。',
      ] },
      { at: 57, expect: 'export {', lines: [
        '// 实验性 webhook 处理器及其配置类型。',
        '// 事件相关类型均以 Experimental_ 前缀暴露。',
      ] },
    ],
  },
  {
    name: 'tool/mcp-event-signature.ts',
    want: [20, 22],
    blocks: [
      { at: 1, expect: 'import {', lines: [
        '// ============================================================================',
        '// mcp-event-signature：事件回调的签名生成与校验',
        '// 遵循 Standard Webhooks v1：HMAC-SHA256 覆盖 id、时间戳与原始字节。',
        '// 密钥形如 whsec_<base64>，长度限制在 24~64 字节。',
      ] },
      { at: 7, expect: 'export function createMCPEventSecret(): string {', lines: [
        '// 生成 32 字节随机密钥并编码为 base64。',
        '// 前缀用于在配置层面识别密钥类型。',
        '// 随机源来自 Web Crypto，适用于边缘与 Node。',
      ] },
      { at: 11, expect: 'export function decodeMCPEventSecret(secret: string): Uint8Array {', lines: [
        '// 解析并校验密钥。',
        '// 先检查前缀与 base64 字符集，再检查字节长度。',
        '// 任一不满足都抛配置错误，避免弱密钥被使用。',
      ] },
      { at: 13, expect: "if (!secret.startsWith('whsec_') || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {", lines: [
        '// 前缀或字符集不合法。',
        '// 使用宽松的 base64 校验，兼容有无填充两种写法。',
      ] },
      { at: 17, expect: 'if (bytes.length < 24 || bytes.length > 64) {', lines: [
        '// 字节长度过低不安全，过高则超出常见实现约定。',
      ] },
      { at: 26, expect: 'export async function verifyMCPEventSignature({', lines: [
        '// 按 Standard Webhooks v1 校验请求。',
        '// 返回布尔值而非抛错，调用方直接映射为 401。',
        '// 校验的是原始字节，因此必须在解析 JSON 之前调用。',
        '// 签名消息为「id.时间戳.请求体」。',
        '// 支持同一请求携带多个签名，便于密钥轮换。',
        '// 任一 v1 签名匹配即视为通过。',
      ] },
      { at: 38, expect: 'if (', lines: [
        '// 缺少必要头、时间戳非数字或超出 5 分钟窗口都拒绝。',
        '// 时间窗口用于缓解重放攻击。',
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
