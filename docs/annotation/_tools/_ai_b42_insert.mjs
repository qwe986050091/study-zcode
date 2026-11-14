// B42 insert: mcp-event-types.ts + mcp-events-adapter.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/tool/';
const files = [
  {
    name: 'mcp-event-types.ts',
    want: [23, 27],
    blocks: [
      { at: 1, expect: "import type { JSONObject } from '@ai-sdk/provider';", lines: [
        '// ============================================================================',
        '// mcp-event-types：MCP 事件相关的 zod schema 与推导类型',
        '// 覆盖事件定义、订阅结果、事件载荷与会话控制帧。',
        '// 类型同时供客户端封装与 webhook 处理器复用。',
      ] },
      { at: 6, expect: 'const JsonSchemaSchema = z.union([', lines: [
        '// 宽松的 JSON Schema 表示。',
        '// 既允许布尔值（true/false schema），也允许任意记录。',
      ] },
      { at: 11, expect: 'export const MCPEventDefinitionSchema = z.looseObject({', lines: [
        '// 事件定义：名称、说明、支持的投递方式与两套 schema。',
        '// looseObject 保留服务端扩展字段，便于向前兼容。',
        '// delivery 至少声明一种方式。',
      ] },
      { at: 20, expect: 'export const ListEventsResultSchema = ResultSchema.extend({', lines: [
        '// 事件目录分页结果。',
        '// nextCursor 为空表示没有下一页。',
        '// 结果中混入的错误字段由 ResultSchema 提供。',
      ] },
      { at: 26, expect: 'export const SubscribeEventResultSchema = ResultSchema.extend({', lines: [
        '// 订阅结果：服务端分配的 id、续订时间与游标。',
        '// refreshBefore 使用带时区的 ISO 时间。',
        '// cursor 的 nullish 统一变换为 null，简化下游判断。',
      ] },
      { at: 37, expect: 'export const MCPEventSchema = z.looseObject({', lines: [
        '// 单条事件的载荷。',
        '// eventId 与投递头的 webhook-id 对应。',
        '// data 为事件自定义内容，cursor 用于断点续订。',
      ] },
      { at: 46, expect: 'export const MCPEventControlSchema = z', lines: [
        '// 控制帧：回放缺口与订阅终止。',
        '// gap 帧会被补上 truncated 标记，提醒调用方状态可能不完整。',
        '// terminated 帧携带服务端给出的错误信息。',
      ] },
      { at: 93, expect: 'export interface MCPEventStore {', lines: [
        '// 订阅存储接口，必须由应用提供持久化实现。',
        '// 记录包含签名密钥，绝不能暴露给浏览器。',
        '// update 只合并传入字段，且需要原子性。',
      ] },
      { at: 101, expect: 'export type MCPEventsConfig =', lines: [
        '// 两种互斥配置：直连存储，或委托给适配器。',
        '// 直连模式可自定义参数校验；适配器模式由后端负责生命周期。',
      ] },
    ],
  },
  {
    name: 'mcp-events-adapter.ts',
    want: [8, 11],
    blocks: [
      { at: 1, expect: "import type { JSONObject } from '@ai-sdk/provider';", lines: [
        '// ============================================================================',
        '// mcp-events-adapter：托管式事件订阅的适配器契约',
        '// 应用用后端服务承担回调注册、校验、续订与清理。',
      ] },
      { at: 7, expect: 'export type ManagedSubscription = {', lines: [
        '// 后端持有的订阅视图。',
        '// 状态比直连模式更细，覆盖授权失败与过期等情形。',
      ] },
      { at: 24, expect: 'export type ManagedSubscribeInput = {', lines: [
        '// 创建托管订阅的入参。',
      ] },
      { at: 42, expect: 'export interface MCPEventOperations {', lines: [
        '// 订阅生命周期操作集合。',
      ] },
      { at: 79, expect: 'export function validateMCPEventOperations(', lines: [
        '// 在建立传输前校验适配器返回值。',
        '// thenable 会被显式拒绝，并消费其拒绝以避免未处理异常。',
      ] },
      { at: 120, expect: 'export function createManagedMCPEvents(', lines: [
        '// 组合出对外事件接口。',
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
