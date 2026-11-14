// B49 insert: error/no-video-generated-error.ts + generate-speech/generated-audio-file.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'error/no-video-generated-error.ts',
    want: [7, 8],
    blocks: [
      { at: 4, expect: "const name = 'AI_NoVideoGeneratedError';", lines: [
        '// 使用 Symbol.for 生成稳定的错误标记，跨包实例也能被 isInstance 识别。',
        '// 名称同时用于错误消息与向后兼容的字段判断。',
      ] },
      { at: 8, expect: 'export class NoVideoGeneratedError extends AISDKError {', lines: [
        '// 视频生成失败时抛出，携带所有已尝试的模型响应。',
        '// 继承 AISDKError 以获得统一的 name/cause 处理。',
      ] },
      { at: 11, expect: 'readonly responses: Array<VideoModelResponseMetadata>;', lines: [
        '// 每次调用对应的响应元数据，便于排查失败原因。',
      ] },
      { at: 22, expect: 'super({ name, message, cause });', lines: [
        '// 先初始化基类，再保存响应明细。',
      ] },
      { at: 27, expect: 'static isInstance(error: unknown): error is NoVideoGeneratedError {', lines: [
        '// 基于标记做运行时不依赖 instanceof 的类型收窄。',
      ] },
    ],
  },
  {
    name: 'generate-speech/generated-audio-file.ts',
    want: [5, 6],
    blocks: [
      { at: 6, expect: '/**', lines: [
        '// 语音合成结果的音频文件契约：在通用文件基础上补充格式信息。',
        '// 格式用于下游按容器类型选择播放或转码策略。',
      ] },
      { at: 16, expect: 'export class DefaultGeneratedAudioFile', lines: [
        '// 默认实现从 mediaType 推导音频格式，缺省回退为 mp3。',
      ] },
      { at: 22, expect: 'constructor({', lines: [
        '// 构造时解析 MIME 子类型，audio/mpeg 特判为 mp3。',
      ] },
      { at: 30, expect: "let format = 'mp3';", lines: [
        '// 默认格式：未知或缺失信息时按 mp3 处理。',
      ] },
      { at: 55, expect: 'export class DefaultGeneratedAudioFileWithType extends DefaultGeneratedAudioFile {', lines: [
        '// 带 type 标识的子类，供消息内容部件按音频类型分发。',
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
