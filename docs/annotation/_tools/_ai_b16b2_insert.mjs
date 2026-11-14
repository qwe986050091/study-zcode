import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/batch/batch.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const edits = [
  { needle: 'const modelByRequestId = new Map(', text: [
    "// 警告归属需要 requestId → modelId 的映射，只在本次调用内有效。",
    "// 用 normalizedRequests 而不是原始 requests：id 与 modelId 已在此定型。",
    "// 该 Map 只读，供随后的警告循环查询。",
  ] },
  { needle: 'const transform = new TransformStream<', text: [
    "// TransformStream 的读写两端由 pipeTo 与读端分别持有；这里不设置 highWaterMark，",
    "//   因为背压由 provider 流自身控制，额外缓冲只会增加内存。",
    "// transformer.cancel 是唯一的取消入口，必须实现（否则读端取消不会传导）。",
    "// 转换器本身不持有请求状态，因此可以安全地被单次使用。",
  ] },
  { needle: 'asAsyncIterableStream(transform.readable)', text: [
    "// 把 Web Stream 适配成 AsyncIterable：调用方既能 for await，也能 getReader。",
    "// 该适配不复制数据，取消仍会沿 readable → writable → 上游一路传导。",
    "// 返回后函数即结束，生命周期完全交给调用方。",
  ] },
  { needle: 'finishReason: result.finishReason.unified,', text: [
    "// finishReason 同时给出统一值与原始值：前者用于跨 provider 比较，",
    "//   后者用于排错时还原 provider 的真实枚举。",
    "// usage 经过 asLanguageModelUsage 归一化，保证字段齐全。",
    "// response 只在存在时出现，避免给调用方一个全 undefined 的对象。",
  ] },
];

for (const e of edits) {
  const hits = lines.reduce((acc, l, i) => (l.includes(e.needle) ? [...acc, i] : acc), []);
  if (hits.length !== 1) {
    console.error(`HITS ${hits.length}: ${e.needle}`);
    process.exit(1);
  }
  e.idx = hits[0];
}

for (const e of [...edits].sort((x, y) => y.idx - x.idx)) {
  lines.splice(e.idx, 0, ...e.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', edits.reduce((s, e) => s + e.text.length, 0));
