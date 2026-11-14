import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'upload-skill/index.ts',
    want: [1, 1],
    blocks: [
      {
        at: 1,
        expect: "export { uploadSkill } from './upload-skill';",
        lines: ['// 技能上传入口与上传结果类型的出口。'],
      },
    ],
  },
  {
    name: 'util/zod.ts',
    want: [10, 10],
    blocks: [
      { at: 1, expect: 'import {', lines: ['// 逐个引入 zod/v4 工厂函数，配合聚合对象便于打包器 tree-shaking。'] },
      { at: 23, expect: 'export const z = {', lines: ['// 汇总校验工厂集合，键名沿用 zod 常用 API 以保持一致调用习惯。'] },
      { at: 26, expect: 'custom,', lines: ['// 自定义校验与判别式联合。'] },
      { at: 27, expect: 'discriminatedUnion,', lines: ['// 判别式联合按标签字段收窄分支。'] },
      { at: 30, expect: 'lazy,', lines: ['// 惰性求值，用于递归 schema 定义。'] },
      { at: 32, expect: 'looseObject,', lines: ['// 宽松对象保留未知键。'] },
      { at: 36, expect: 'object,', lines: ['// 基础对象校验。'] },
      { at: 37, expect: 'record,', lines: ['// 记录类型按值统一校验。'] },
      { at: 40, expect: 'unknown,', lines: ['// 未知类型兜底。'] },
      { at: 43, expect: "export type { ZodType } from 'zod/v4';", lines: ['// 对外复用 zod 的类型定义。'] },
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
