// B57 insert: types/citation.ts + error/invalid-tool-input-error.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'types/citation.ts',
    want: [8, 8],
    blocks: [
      { at: 5, expect: '/** A reference supporting a generated text part. */', lines: [
        '// 引用来源：用 discriminatedUnion 区分 URL 与文档两类。',
        '// 与 provider 层的 LanguageModelV4Citation 保持一致。',
      ] },
      { at: 8, expect: 'export const citationSchema: ZodType<Citation> = z.object({', lines: [
        '// 运行时引用校验 schema，供 UI 消息与工具结果复用。',
        '// 索引区间与引用文本均可选，以适配不同模型的输出。',
      ] },
      { at: 9, expect: "source: z.discriminatedUnion('sourceType', [", lines: [
        '// 按 sourceType 选择不同的必填字段。',
      ] },
      { at: 10, expect: 'z.object({', lines: [
        '// URL 来源：id 与 url 必填，标题可选。',
      ] },
      { at: 18, expect: 'z.object({', lines: [
        '// 文档来源：mediaType 与 title 必填，文件名可选。',
      ] },
      { at: 28, expect: 'startIndex: z.number().int().nonnegative().optional(),', lines: [
        '// 引用在文本中的起止位置（可选）。',
      ] },
    ],
  },
  {
    name: 'error/invalid-tool-input-error.ts',
    want: [8, 8],
    blocks: [
      { at: 3, expect: "const name = 'AI_InvalidToolInputError';", lines: [
        '// 错误名称与 Symbol.for 标记，供跨包识别。',
        '// 标记用于 isInstance 的稳定判定。',
      ] },
      { at: 7, expect: 'export class InvalidToolInputError extends AISDKError {', lines: [
        '// 工具输入校验失败时抛出。',
        '// 保留原始输入，便于回放与调试。',
      ] },
      { at: 10, expect: 'readonly toolName: string;', lines: [
        '// 工具名与原始输入字符串。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// 未显式传入消息时，根据 cause 生成默认描述。',
      ] },
      { at: 17, expect: 'message = `Invalid input for tool ${toolName}: ${getErrorMessage(cause)}`,', lines: [
        '// 默认消息包含工具名与底层错误信息。',
      ] },
      { at: 24, expect: 'super({ name, message, cause });', lines: [
        '// 初始化基类后再保存输入细节。',
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
