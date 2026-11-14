import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'prompt/index.ts',
    want: [10, 10],
    blocks: [
      { at: 1, expect: "import type { LanguageModelCallOptions } from './language-model-call-options';", lines: ['// 调用选项与请求选项的类型导入，供废弃别名复用。'] },
      { at: 4, expect: "export type { LanguageModelCallOptions } from './language-model-call-options';", lines: ['// 对外导出语言模型调用选项。'] },
      { at: 5, expect: "export type { RequestOptions, TimeoutConfiguration } from './request-options';", lines: ['// 请求选项与超时配置类型。'] },
      { at: 8, expect: 'export type CallSettings = LanguageModelCallOptions &', lines: ['// 兼容旧名：合并调用选项与不含超时的请求选项。'] },
      { at: 10, expect: 'export {', lines: ['// 各阶段超时计算辅助函数。'] },
      { at: 17, expect: 'export {', lines: ['// 各类消息的 schema 校验器。'] },
      { at: 24, expect: "export type { Instructions, Prompt } from './prompt';", lines: ['// 指令与提示词类型。'] },
      { at: 25, expect: "export { convertDataContentToBase64String } from './data-content';", lines: ['// 数据内容转 base64 字符串。'] },
      { at: 28, expect: 'export type {', lines: ['// 避免使用方直接依赖 provider-utils，统一从入口获取。'] },
      { at: 29, expect: 'AssistantContent,', lines: ['// 消息内容与角色消息类型集合。'] },
    ],
  },
  {
    name: 'registry/no-such-provider-error.ts',
    want: [11, 11],
    blocks: [
      { at: 1, expect: "import { AISDKError, NoSuchModelError } from '@ai-sdk/provider';", lines: ['// 依赖 provider 包的错误基类与未知模型错误。'] },
      { at: 3, expect: "const name = 'AI_NoSuchProviderError';", lines: ['// 错误名与用于 instanceof 判定的标记。'] },
      { at: 7, expect: 'export class NoSuchProviderError extends NoSuchModelError {', lines: ['// 提供方不存在错误：继承未知模型错误并补充提供方信息。'] },
      { at: 8, expect: 'private readonly [symbol] = true; // used in isInstance', lines: ['// 私有标记字段，配合 hasMarker 实现 isInstance。'] },
      { at: 10, expect: 'readonly providerId: string;', lines: ['// 出错的提供方标识。'] },
      { at: 11, expect: 'readonly availableProviders: string[];', lines: ['// 当前可用的提供方列表。'] },
      { at: 13, expect: 'constructor({', lines: ['// 构造参数：模型、提供方与可用列表，消息可覆盖。'] },
      { at: 22, expect: "| 'languageModel'", lines: ['// 模型类型联合，覆盖所有模型门类。'] },
      { at: 31, expect: "| 'evaluationModel';", lines: ['// 旧称 evaluationModel，已废弃，改用 decisionModel。'] },
      { at: 36, expect: 'super({ errorName: name, modelId, modelType, message });', lines: ['// 先交由基类构造标准错误信息。'] },
      { at: 42, expect: 'static isInstance(error: unknown): error is NoSuchProviderError {', lines: ['// 静态类型守卫：按全局标记判断错误归属。'] },
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
