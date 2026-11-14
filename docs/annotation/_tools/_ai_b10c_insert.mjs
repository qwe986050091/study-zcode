import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';

// transcribe 补 2 行（30.61% -> 31.12%）
{
  const file = path.join(ROOT, 'packages/ai/src/transcribe/stream-transcribe.ts');
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const idx = lines.findIndex(l => l.includes('function getFullStream() {'));
  if (idx < 0) {
    console.error('MISS getFullStream');
    process.exit(1);
  }
  lines.splice(idx, 0,
    '// 这个 "只能一次" 的限制来自流本身不可重放：再次 getReader 会抛 locked 错误。',
    '// 错误信息区分 "重复获取" 与 "先读了 promise"，便于调用方定位误用。',
  );
  fs.writeFileSync(file, lines.join('\r\n'));
  console.log('OK transcribe +2');
}

function apply(rel, anchors) {
  const file = path.join(ROOT, rel);
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');

  for (const a of anchors) {
    const idx = a.at - 1;
    const actual = lines[idx];
    if (idx < 0 || idx >= lines.length || !actual.includes(a.expect)) {
      console.error(`MISS ${rel} @${a.at} expect=${a.expect} actual=${actual}`);
      process.exit(1);
    }
  }

  for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
    lines.splice(a.at - 1, 0, ...a.text);
  }

  fs.writeFileSync(file, lines.join('\r\n'));
  console.log(`OK ${rel} +${anchors.reduce((s, a) => s + a.text.length, 0)}`);
}

apply('packages/ai/src/generate-speech/stream-speech.ts', [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// 流式语音合成 streamSpeech：把文本（字符串/迭代器/流）持续送入语音模型，边合成边下发音频。',
      '// 链路位置：streamSpeech -> resolveSpeechModel -> isStreamingSpeechModel 能力检查',
      '//   -> doStream -> TransformStream 归一化 -> fullStream / audioStream。',
      '// 与 streamTranscribe 相同的单所有权模型：流可能无界，不能缓存或重放。',
      '// 不变量：INV-01 audioStream 与 fullStream 只能取其一（守住 389-420）；',
      '//   INV-02 finish 前必须有音频，否则 NoSpeechGeneratedError（守住 295-300）；',
      '//   INV-03 未 finish 即结束要区分 "有音频/provider 错误" 与 "完全无声"（守住 219-228）。',
      '// ============================================================================',
    ],
  },
  {
    at: 53,
    expect: 'export function streamSpeech({',
    text: ['// 入口同步返回结果对象；provider 流由后台 IIFE 驱动，不会阻塞调用方。'],
  },
  {
    at: 173,
    expect: 'const usagePromise = new DelayedPromise<SpeechStreamUsage>();',
    text: [
      '// 结果 promise 组：usage/warnings/responses/providerMetadata，由 finish 统一 resolve。',
      '// [事务] finish 是唯一提交点；cancel/abort 通过 rejectPendingPromises 统一回滚。',
    ],
  },
  {
    at: 211,
    expect: 'const pipeAbortController = new AbortController();',
    text: [
      '// 输出流 cancel 时以明确 reason 中止 pipe；undefined reason 在 Node 26 会变成',
      '// 未处理的 rejection，因此必须显式构造错误。',
    ],
  },
  {
    at: 219,
    expect: 'const incompleteStreamError = () =>',
    text: [
      '// 流结束却没有 finish 时的错误选择：',
      '// 有音频 -> 暴露 provider 的最后错误（或 StreamProviderError）；无音频 -> NoSpeechGeneratedError。',
    ],
  },
  {
    at: 253,
    expect: "case 'audio': {",
    text: [
      '// audio 分支：base64 字符串先解码为字节；',
      '// 空块仅在携带 providerMetadata（如 end-of-turn 标记）时保留，',
      '// 且空块不计入 hasAudio。',
    ],
  },
  {
    at: 281,
    expect: "case 'error': {",
    text: [
      '// error part 非致命：记录 lastError、异步通知 onError（不 await、吞掉其异常），',
      '// 并把错误 part 透传给 fullStream；audioStream 会跳过它。',
    ],
  },
  {
    at: 290,
    expect: "case 'finish': {",
    text: [
      '// finish 提交：补齐 warnings、检查是否真的产出过音频、settle 全部结果 promise。',
      '// [事务] finished 标记供 flush 判断流是否正常收尾。',
    ],
  },
  {
    at: 311,
    expect: 'flush() {',
    text: ['// 未 finish 就关闭 -> 抛 incompleteStreamError，让消费方感知未完成。'],
  },
  {
    at: 333,
    expect: 'if (abortSignal != null) {',
    text: [
      '// 外部 abort 独立处理：即使 doStream 还在 pending 或 provider 忽略 signal，',
      '// 也要立刻让结果 promise 与输出流失败。',
    ],
  },
  {
    at: 389,
    expect: 'let streamOwner:',
    text: [
      '// 单所有权：语音流可能无界（长文本 LLM 流），输出只允许一个消费者且不缓存。',
      '// 三种 owner 互斥，第二个消费者直接抛错。',
    ],
  },
  {
    at: 455,
    expect: 'function createAudioByteStream(',
    text: [
      '// 用 pull 型 ReadableStream 投影音频字节，而不是再 pipeThrough 一次：',
      '// 这样提前 cancel 会直接取消上游 part 流，避免链式 pipe 产生未处理 rejection。',
    ],
  },
  {
    at: 517,
    expect: 'function toSourceStream(',
    text: [
      '// 三种来源归一：ReadableStream 直接用；AsyncIterable 取其 asyncIterator；',
      '// 同步 Iterable 包成 async generator，避免阻塞调用栈。',
    ],
  },
]);
