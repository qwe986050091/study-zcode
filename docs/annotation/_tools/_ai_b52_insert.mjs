// B52 insert: types/index.ts + util/data-url.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'types/index.ts',
    want: [10, 10],
    blocks: [
      { at: 1, expect: "export type { JSONSchema7 } from '@ai-sdk/provider';", lines: [
        '// 公共类型汇总出口：按领域分组重导出，供包内与外部共享。',
        '// 这里只做类型转发，不引入任何运行时代码。',
      ] },
      { at: 2, expect: "export type { Citation } from './citation';", lines: [
        '// 引用来源与 JSON Schema 基础类型。',
      ] },
      { at: 3, expect: "export type { Embedding, EmbeddingModel } from './embedding-model';", lines: [
        '// 嵌入模型契约及其调用中间件。',
      ] },
      { at: 5, expect: "export type { ImageModel, ImageModelProviderMetadata } from './image-model';", lines: [
        '// 图像模型、中间件、响应元数据与 provider 元数据。',
      ] },
      { at: 8, expect: "export type { JSONValue } from './json-value';", lines: [
        '// 通用 JSON 值类型，用于工具参数与结果。',
      ] },
      { at: 9, expect: 'export type {', lines: [
        '// 语言模型相关：调用告警、结束原因、工具选择与请求/响应元数据。',
      ] },
      { at: 19, expect: "export type { Provider } from './provider';", lines: [
        '// Provider 抽象、元数据与引用标识。',
      ] },
      { at: 22, expect: "export type { RerankingModel } from './reranking-model';", lines: [
        '// 重排序、语音与转写模型及其响应元数据。',
      ] },
      { at: 27, expect: 'export type {', lines: [
        '// 各模型的用量统计与通用告警类型。',
      ] },
    ],
  },
  {
    name: 'util/data-url.ts',
    want: [2, 2],
    blocks: [
      { at: 13, expect: 'export function getTextFromDataUrl(dataUrl: string): string {', lines: [
        '// 解析 text/* 形式的 data URL，按 charset 解码为字符串。',
      ] },
      { at: 21, expect: 'if (mediaType == null || base64Content == null) {', lines: [
        '// 头部或负载缺失时视为格式错误，统一抛出参数错误。',
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
