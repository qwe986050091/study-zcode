import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/clone-model-message.ts',
    want: [14, 14],
    blocks: [
      { at: 1, expect: 'import {', lines: ['// 二进制判断工具与模型消息类型导入。'] },
      { at: 11, expect: 'export function cloneModelMessages<T extends ModelMessage>(', lines: ['// 克隆模型消息，保留 URL 等特殊对象。'] },
      { at: 14, expect: 'return cloneValue(messages, new Map()) as Array<T>;', lines: ['// 以共享 seen 映射递归克隆整个消息数组。'] },
      { at: 17, expect: 'function cloneValue(value: unknown, seen: Map<object, unknown>): unknown {', lines: ['// 递归克隆任意值，seen 用于处理循环引用。'] },
      { at: 18, expect: "if (value == null || typeof value !== 'object') {", lines: ['// 原始类型直接返回。'] },
      { at: 22, expect: 'if (seen.has(value)) {', lines: ['// 已克隆过的对象复用缓存副本。'] },
      { at: 26, expect: 'if (value instanceof URL) {', lines: ['// URL 需要重建实例，结构化克隆不支持。'] },
      { at: 32, expect: 'if (Array.isArray(value)) {', lines: ['// 数组按长度新建并逐项克隆。'] },
      { at: 35, expect: 'value.forEach((item, index) => {', lines: ['// 逐项递归克隆，保持数组顺序。'] },
      { at: 41, expect: 'if (isUint8Array(value)) {', lines: ['// Uint8Array 复制底层字节。'] },
      { at: 47, expect: 'if (isArrayBuffer(value)) {', lines: ['// ArrayBuffer 经视图复制后取回缓冲区。'] },
      { at: 53, expect: 'if (', lines: ['// Date 通过原型方法读取时间戳重建。'] },
      { at: 66, expect: 'const copy: Record<string, unknown> = {};', lines: ['// 普通对象逐键克隆并保留属性描述符。'] },
      { at: 69, expect: 'Object.defineProperty(copy, key, {', lines: ['// 定义可写、可枚举、可配置的属性。'] },
    ],
  },
  {
    name: 'index.ts',
    want: [16, 16],
    blocks: [
      { at: 2, expect: "import './global';", lines: ['// 为运行环境补齐必要的全局对象。'] },
      { at: 5, expect: 'export {', lines: ['// 网关创建器与网关提供方元数据类型。'] },
      { at: 8, expect: 'type GatewayAsyncJobMetadata,', lines: ['// 网关异步作业与模型标识类型。'] },
      { at: 12, expect: 'export {', lines: ['// provider-utils 的 schema、工具与 ID 生成工具。'] },
      { at: 42, expect: "export * from './agent';", lines: ['// 智能体与批处理。'] },
      { at: 44, expect: "export * from './embed';", lines: ['// 嵌入与错误类型。'] },
      { at: 46, expect: "export * from './decide';", lines: ['// 决策与图像生成。'] },
      { at: 48, expect: "export * from './generate-object';", lines: ['// 结构化对象与语音生成。'] },
      { at: 50, expect: "export * from './generate-text';", lines: ['// 文本生成与视频生成。'] },
      { at: 52, expect: "export * from './logger';", lines: ['// 日志与中间件。'] },
      { at: 54, expect: "export * from './prompt';", lines: ['// 提示词与实时接口。'] },
      { at: 56, expect: "export * from './registry';", lines: ['// 注册表与重排序。'] },
      { at: 60, expect: "export { toolSearch } from './tool-search/tool-search';", lines: ['// 工具搜索入口。'] },
      { at: 62, expect: "export * from './translate';", lines: ['// 转写与翻译。'] },
      { at: 64, expect: "export * from './ui';", lines: ['// 类型与 UI 接口。'] },
      { at: 66, expect: "export * from './upload-file';", lines: ['// UI 消息流与文件/技能上传。'] },
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
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`ANCHOR FAIL ${f.name} at=${b.at}\n  expect: ${b.expect}\n  actual: ${actual}`);
      process.exit(1);
    }
    total += b.lines.length;
  }
  console.log(`CHECK ${f.name} +${total}`);
  if (process.env.DRY) {
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`WANT FAIL ${f.name} total=${total} want=${f.want.join('~')}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  grand += total;
}
console.log(`SUMMARY files=${files.length} added=${grand}`);
