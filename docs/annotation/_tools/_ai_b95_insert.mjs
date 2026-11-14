import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'generate-object/validate-object-generation-input.ts',
    want: [29, 29],
    blocks: [
      { at: 1, expect: "import type { FlexibleSchema } from '@ai-sdk/provider-utils';", lines: ['// 灵活 schema 类型。'] },
      { at: 2, expect: "import { InvalidArgumentError } from '../error/invalid-argument-error';", lines: ['// 参数非法错误。'] },
      { at: 4, expect: 'export function validateObjectGenerationInput({', lines: ['// 校验对象生成入参：不同 output 模式允许的字段不同。', '// 所有分支只做合法性检查，不修改入参。'] },
      { at: 5, expect: 'output,', lines: ['// 输出模式：对象、数组、枚举或无 schema。'] },
      { at: 6, expect: 'schema,', lines: ['// 结构化输出 schema。'] },
      { at: 7, expect: 'schemaName,', lines: ['// schema 名称与描述。'] },
      { at: 9, expect: 'enumValues,', lines: ['// 枚举模式下的候选值。'] },
      { at: 17, expect: "if (output === 'no-schema') {", lines: ['// 无 schema 模式不允许携带任何 schema 相关配置。', '// 以下逐项检查互斥字段。'] },
      { at: 18, expect: 'if (schema != null) {', lines: ['// 不允许 schema。', '// 命中即抛错。'] },
      { at: 26, expect: 'if (schemaDescription != null) {', lines: ['// 不允许 schema 描述。'] },
      { at: 34, expect: 'if (schemaName != null) {', lines: ['// 不允许 schema 名称。'] },
      { at: 42, expect: 'if (enumValues != null) {', lines: ['// 不允许枚举值。'] },
      { at: 51, expect: "if (output === 'object') {", lines: ['// 对象模式不允许枚举值。', '// schema 由调用方自行提供。'] },
      { at: 52, expect: 'if (enumValues != null) {', lines: ['// 枚举值与对象 schema 互斥。'] },
      { at: 61, expect: "if (output === 'array') {", lines: ['// 数组模式同样不允许枚举值。'] },
      { at: 62, expect: 'if (enumValues != null) {', lines: ['// 枚举值与数组 schema 互斥。'] },
      { at: 71, expect: "if (output === 'enum') {", lines: ['// 枚举模式要求提供枚举值，不接受 schema 配置。', '// 枚举值通过 enumValues 传入。'] },
      { at: 72, expect: 'if (schema != null) {', lines: ['// 枚举模式不允许 schema。'] },
      { at: 80, expect: 'if (schemaDescription != null) {', lines: ['// 不允许 schema 描述。'] },
      { at: 88, expect: 'if (schemaName != null) {', lines: ['// 不允许 schema 名称。'] },
      { at: 96, expect: 'for (const value of enumValues ?? []) {', lines: ['// 逐个校验枚举值。', '// 只接受字符串候选。'] },
      { at: 97, expect: "if (typeof value !== 'string') {", lines: ['// 非字符串直接抛错。', '// 枚举值用于约束模型输出。'] },
    ],
  },
  {
    name: 'generate-video/generate-video.ts',
    want: [31, 31],
    blocks: [
      { at: 1, expect: 'import type {', lines: ['// 视频模型 v4 的实验性接口与文件类型。'] },
      { at: 12, expect: 'import {', lines: ['// 二进制转换、延迟、ID 与请求头工具。'] },
      { at: 21, expect: "import { NoVideoGeneratedError } from '../error/no-video-generated-error';", lines: ['// 未生成视频时抛出的错误。'] },
      { at: 22, expect: 'import {', lines: ['// 生成文件抽象与类型。'] },
      { at: 26, expect: "import { logWarnings } from '../logger/log-warnings';", lines: ['// 警告日志与中止信号合并。'] },
      { at: 28, expect: "import { resolveVideoModel } from '../model/resolve-model';", lines: ['// 模型解析与视频模型类型。'] },
      { at: 30, expect: "import type { VideoModelResponseMetadata } from '../types/video-model-response-metadata';", lines: ['// 响应元数据与警告类型。'] },
      { at: 32, expect: "import { getOwn } from '../util/get-own';", lines: ['// 自有属性读写工具。'] },
      { at: 34, expect: "import { createDownload } from '../util/download/create-download';", lines: ['// 下载器、重试准备与版本号。'] },
      { at: 37, expect: "import type { GenerateVideoResult } from './generate-video-result';", lines: ['// 结果类型与 Data URL 拆分。'] },
      { at: 40, expect: 'export type GenerateVideoPrompt =', lines: ['// 视频生成提示词：文本或图像 + 文本。'] },
      { at: 55, expect: 'export type GenerateVideoPollOptions = {', lines: ['// 轮询配置：间隔、超时与自定义延迟。'] },
      { at: 117, expect: 'const defaultDownload = createDownload();', lines: ['// 默认下载器，带 2 GiB 上限。'] },
      { at: 286, expect: 'const model = resolveVideoModel(modelArg);', lines: ['// 解析模型并补全请求头。'] },
      { at: 293, expect: 'const { maxRetries, retry } = prepareRetries({', lines: ['// 准备重试策略。'] },
      { at: 298, expect: 'const {', lines: ['// 归一化提示词、图像、帧图像与参考输入。'] },
      { at: 310, expect: 'const hasStartStatus = model.doStart != null && model.doStatus != null;', lines: ['// 判断模型是否支持异步 start/status 流程。'] },
      { at: 316, expect: 'if (model.doGenerate == null && !hasStartStatus) {', lines: ['// 两种调用方式都不可用时直接报错。'] },
      { at: 323, expect: 'if ((poll != null || webhook != null) && !hasStartStatus) {', lines: ['// 模型不支持却传入轮询/回调配置时给出警告。'] },
      { at: 338, expect: 'const callCount = Math.ceil(n / maxVideosPerCallWithDefault);', lines: ['// 按每次调用可生成的视频数拆分并发批次。'] },
      { at: 344, expect: 'const results = await Promise.all(', lines: ['// 并发发起所有批次调用。'] },
      { at: 363, expect: 'if (useStartStatus) {', lines: ['// 异步流程走轮询或回调，否则直接调用 doGenerate。'] },
      { at: 379, expect: 'const videos: Array<GeneratedFile> = [];', lines: ['// 汇总视频、上传计数、响应元数据与提供方元数据。'] },
      { at: 386, expect: 'switch (videoData.type) {', lines: ['// 按视频数据类型分别处理。'] },
      { at: 393, expect: 'const { data, mediaType: downloadedMediaType } = await downloadFn({', lines: ['// URL 类型需要先下载再包装。'] },
      { at: 399, expect: 'const isUsableMediaType = (type: string | undefined): boolean =>', lines: ['// 过滤通用未知媒体类型，交由嗅探兜底。'] },
      { at: 420, expect: "case 'base64': {", lines: ['// base64 数据直接包装。'] },
      { at: 430, expect: "case 'binary': {", lines: ['// 二进制数据嗅探媒体类型。'] },
      { at: 450, expect: 'warnings.push(...result.warnings);', lines: ['// 合并警告与响应元数据。'] },
      { at: 464, expect: 'if (videos.length === 0 && uploadedVideos === 0) {', lines: ['// 未生成任何视频时抛错。'] },
      { at: 485, expect: 'if (videos.length === 0) {', lines: ['// 仅上传场景下 video 属性改为抛错访问。'] },
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
