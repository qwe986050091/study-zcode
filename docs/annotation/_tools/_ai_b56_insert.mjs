// B56 insert: error/invalid-argument-error.ts + generate-object/inject-json-instruction.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/invalid-argument-error.ts',
    want: [9, 9],
    blocks: [
      { at: 3, expect: "const name = 'AI_InvalidArgumentError';", lines: [
        '// 错误名称与 Symbol.for 标记，保证跨包可识别。',
        '// 标记用于 isInstance，不依赖 instanceof。',
      ] },
      { at: 7, expect: 'export class InvalidArgumentError extends AISDKError {', lines: [
        '// 参数非法时抛出，附带参数名与原始值。',
        '// 统一的消息格式便于上层直接展示或记录。',
      ] },
      { at: 10, expect: 'readonly parameter: string;', lines: [
        '// 出错的参数名。',
      ] },
      { at: 13, expect: 'constructor({', lines: [
        '// 构造时拼接参数名与具体原因，形成完整错误消息。',
      ] },
      { at: 22, expect: 'super({', lines: [
        '// 交由基类设置错误名称与消息。',
      ] },
      { at: 27, expect: 'this.parameter = parameter;', lines: [
        '// 保留参数名与原始值，便于调用方做二次处理。',
      ] },
      { at: 31, expect: 'static isInstance(error: unknown): error is InvalidArgumentError {', lines: [
        '// 通过标记做运行时类型收窄。',
      ] },
    ],
  },
  {
    name: 'generate-object/inject-json-instruction.ts',
    want: [9, 9],
    blocks: [
      { at: 3, expect: "const DEFAULT_SCHEMA_PREFIX = 'JSON schema:';", lines: [
        '// 默认前缀/后缀：有 schema 时要求按给定结构输出，否则只要求 JSON。',
        '// 文案集中在此处，便于随模型行为统一调整。',
      ] },
      { at: 6, expect: "const DEFAULT_GENERIC_SUFFIX = 'You MUST answer with JSON.';", lines: [
        '// 无 schema 时的兜底约束。',
      ] },
      { at: 8, expect: 'export function injectJsonInstruction({', lines: [
        '// 把 JSON 输出约束注入到提示词中。',
        '// 前缀与后缀可按调用方需求覆盖。',
      ] },
      { at: 11, expect: 'schemaPrefix = schema != null ? DEFAULT_SCHEMA_PREFIX : undefined,', lines: [
        '// 存在 schema 时才默认添加前缀。',
      ] },
      { at: 12, expect: 'schemaSuffix = schema != null', lines: [
        '// 后缀按是否有 schema 选择结构化或通用文案。',
      ] },
      { at: 21, expect: 'return [', lines: [
        '// 按固定顺序拼装各行，再过滤空项并以换行连接。',
      ] },
      { at: 23, expect: "prompt != null && prompt.length > 0 ? '' : undefined, // add a newline if prompt is not null", lines: [
        '// 有提示词时补一个空行，避免与 schema 内容粘连。',
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
