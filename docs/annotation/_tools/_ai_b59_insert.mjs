// B59 insert: generate-text/prepare-step-call-settings.ts + util/parse-partial-json.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-text/prepare-step-call-settings.ts',
    want: [1, 1],
    blocks: [
      { at: 17, expect: 'return prepareLanguageModelCallOptions({', lines: [
        '// 逐项合并：步设置优先，未定义的项回退到外层调用设置。',
      ] },
    ],
  },
  {
    name: 'util/parse-partial-json.ts',
    want: [7, 7],
    blocks: [
      { at: 5, expect: 'export async function parsePartialJson(jsonText: string | undefined): Promise<{', lines: [
        '// 解析可能不完整的 JSON 文本，并报告解析状态。',
        '// 供流式结构化输出对增量片段做容错。',
      ] },
      { at: 13, expect: 'if (jsonText === undefined) {', lines: [
        '// 无输入时直接标记为 undefined-input。',
      ] },
      { at: 17, expect: 'let result = await safeParseJSON({ text: jsonText });', lines: [
        '// 先尝试严格解析。',
      ] },
      { at: 19, expect: 'if (result.success) {', lines: [
        '// 成功则返回原始解析结果。',
      ] },
      { at: 23, expect: 'result = await safeParseJSON({ text: fixJson(jsonText) });', lines: [
        '// 失败后用 fixJson 补齐结构再解析一次。',
      ] },
      { at: 25, expect: 'if (result.success) {', lines: [
        '// 修复后成功则标记为 repaired-parse。',
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
