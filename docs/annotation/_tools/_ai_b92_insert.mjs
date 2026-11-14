import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/prepare-language-model-call-options.ts',
    want: [12, 12],
    blocks: [
      { at: 1, expect: "import { InvalidArgumentError } from '../error/invalid-argument-error';", lines: ['// 参数非法时抛出的错误。'] },
      { at: 2, expect: "import type { LanguageModelCallOptions } from './language-model-call-options';", lines: ['// 语言模型调用选项类型。'] },
      { at: 7, expect: 'export function prepareLanguageModelCallOptions({', lines: ['// 校验模型调用选项并返回归一化后的新对象。'] },
      { at: 8, expect: 'maxOutputTokens,', lines: ['// 输出 token 上限：可选，但必须为正整数。'] },
      { at: 9, expect: 'temperature,', lines: ['// 采样参数：温度、topP、topK 与存在/频率惩罚。'] },
      { at: 14, expect: 'seed,', lines: ['// 随机种子与停止序列。'] },
      { at: 18, expect: 'if (maxOutputTokens != null) {', lines: ['// 显式传入时必须是整数。'] },
      { at: 27, expect: 'if (maxOutputTokens < 1) {', lines: ['// 且至少为 1。'] },
      { at: 36, expect: 'if (seed != null) {', lines: ['// 种子同样要求为整数。'] },
      { at: 46, expect: 'return {', lines: ['// 按原字段集合重建对象，未传字段保持 undefined。'] },
      { at: 48, expect: 'temperature,', lines: ['// 输出与采样参数原样回填。'] },
      { at: 53, expect: 'stopSequences,', lines: ['// 停止序列与推理配置原样回填。'] },
    ],
  },
  {
    name: 'logger/deprecations.ts',
    want: [12, 12],
    blocks: [
      { at: 2, expect: 'const deprecationCodes = new Map<string, string>([', lines: ['// 废弃代码映射：设置名到稳定代码。'] },
      { at: 3, expect: "['generateObject', 'AISDK_DEP_GENERATE_OBJECT'],", lines: ['// 生成对象接口的废弃代码。'] },
      { at: 5, expect: "['experimental_generateSpeech', 'AISDK_DEP_EXPERIMENTAL_GENERATE_SPEECH'],", lines: ['// 语音生成与转写实验接口。'] },
      { at: 7, expect: "['\"image\" content part', 'AISDK_DEP_IMAGE_CONTENT_PART'],", lines: ['// 图像内容分片。'] },
      { at: 8, expect: '[', lines: ['// 工具结果文件数据：file-data 分片。'] },
      { at: 16, expect: "['\"tool-result\" content of type \"file-id\"', 'AISDK_DEP_TOOL_RESULT_FILE_ID'],", lines: ['// 工具结果文件：id 与引用形式。'] },
      { at: 21, expect: '[', lines: ['// 工具结果图片数据：data 分片。'] },
      { at: 25, expect: '[', lines: ['// 工具结果图片：url 形式。'] },
      { at: 33, expect: '[', lines: ['// 工具结果图片：文件引用形式。'] },
      { at: 37, expect: '[', lines: ['// UI 消息中的 rawInput 字段。'] },
      { at: 47, expect: 'function encodeCodePart(value: string): string {', lines: ['// 转义非字母数字字符，保证代码可逆且不丢大小写。'] },
      { at: 55, expect: 'export function getDeprecationCode({', lines: ['// 生成废弃代码：优先查表，否则按设置名拼装。'] },
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
