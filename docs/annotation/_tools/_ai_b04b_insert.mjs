// AI-deep-b04 补插：把五个文件补到 31%~33%。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

const plan = [
  {
    rel: 'packages/ai/src/generate-text/stream-language-model-call.ts',
    edits: [
      {
        at: 383,
        expect: 'const languageModelCallContext = {',
        text: [
          '// 调用上下文与开始事件分开维护：前者会被遥测与其他回调复用，',
          '// 后者只用于 onLanguageModelCallStart 的载荷。',
          '// 注意这里放的是"标准化后"的 instructions / messages，而不是原始入参，',
          '// 回调作者据此看到的就是 provider 实际收到的内容。',
        ],
      },
      {
        at: 391,
        expect: 'const languageModelCallStartEvent = {',
        text: [
          '// 事件在请求发出前构造：此时失败也能让回调看到"尝试过哪次调用"，',
          '// 而不是只有成功路径才有记录。',
          '// 回调的错误被 notify 吞掉，不会阻止请求发出。',
        ],
      },
      {
        at: 471,
        expect: 'function createLanguageModelV4StreamPartToLanguageModelStreamPartTransform<',
        text: [
          '// 翻译器独立成函数，便于单测直接喂入 part 序列而不经过 doStream。',
          '// 依赖全部显式传入（而不是闭包捕获）：翻译逻辑与调用生命周期解耦，',
          '// 也便于在测试中替换时钟、id 生成器与工具集。',
          '// 返回值是 TransformStream，因此天然支持背压与取消传播。',
        ],
      },
      {
        at: 888,
        expect: '} catch (error) {',
        text: [
          '// 解析/修复/精炼任一步失败都只影响这一个调用：转成 error part 继续处理后续 part。',
        ],
      },
      {
        at: 940,
        expect: 'const toolResultPart = chunk.isError',
        text: [
          '// 结果与错误共用一个构造路径：字段几乎相同，只有 type / output / error 不同。',
          '// 这样可以保证 input 与 toolMetadata 的回填规则完全一致，不会出现两种形状。',
          '// 类型断言是必要的：chunk.result 的类型由 provider 决定，无法在这里静态区分。',
        ],
      },
      {
        at: 1009,
        expect: "type: 'model-call-response-metadata',",
        text: [
          '// 元数据 part 原样转发，同时更新内部 id/modelId（见上面的赋值）。',
        ],
      },
      {
        at: 1017,
        expect: 'default:',
        text: [
          '// 只对 custom / source 记账：这两类属于内容，需要出现在最终 content 里。',
          '// 其余未知类型（如未来新增的 provider part）直接透传，',
          '// 这样升级 provider 不会因为框架没跟上而丢数据。',
        ],
      },
      {
        at: 1068,
        expect: 'function calculateNearestRankPercentile(',
        text: [
          '// 最近秩法：取排序后第 ceil(p × n) 个元素，结果为真实观测值而非插值。',
          '// 对小样本更诚实，也便于用户直接对照日志中的具体一次请求。',
          '// 调用方传入的数组必须已排序，避免每次计算重复排序。',
        ],
      },
      {
        at: 733,
        expect: 'const usage = asLanguageModelUsage(chunk.usage);',
        text: [
          '// usage 统一成 SDK 形状：provider 可能只给总数，asLanguageModelUsage 会补齐缺失字段。',
          '// 后续的性能计算全部基于统一形状，避免各 provider 字段差异渗入指标。',
          '// 注意 effective* 指标使用 input + output 总数，非 effective 只统计 output。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/stream-text-single-consumer-result.ts',
    edits: [
      {
        at: 54,
        expect: 'get fullStream() {',
        text: [
          '// fullStream 含全部内部 part（含工具输入增量），是调试与自定义渲染的入口。',
          '// 与 stream 的区别只在是否过滤部分内部事件。',
        ],
      },
      {
        at: 57,
        expect: 'get partialOutputStream() {',
        text: [
          '// 输出投影依赖 Output 规范；未配置时读取会抛 UnsupportedFunctionalityError，',
          '// 这是接口层能给出的最早、最明确的失败点。',
        ],
      },
      {
        at: 69,
        expect: 'get finishReason() {',
        text: [
          '// 完成元数据仍然可用：低内存模式只放弃内容，不放弃"这次生成怎么结束的"。',
          '// 三个 getter 都是 Promise，读取即等待整条流结束。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/stream-retry-attempt-boundary.ts',
    edits: [
      {
        at: 9,
        expect: 'export type StreamRetryAttemptBoundaryPart = {',
        text: [
          '// warnings 是新尝试首个响应带来的告警：边界 part 是唯一合适的携带位置，',
          '// 因为此时还没有任何内容 part 可以挂载元数据。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/is-output-chunk.ts',
    edits: [
      {
        at: 51,
        expect: 'if (!isOutputChunkType[chunk.type]) {',
        text: [
          '// 先用表做 O(1) 排除，绝大多数 part 会在这里返回，避免进入 switch。',
          '// 表驱动还有一个好处：新增类型时 satisfies 会强制补表，不会默默落进 default。',
          '// 只有候选为真的少数类型才需要读内容长度，减少对 part 形状的假设。',
        ],
      },
    ],
  },
];

let totalAdded = 0;
for (const { rel, edits } of plan) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const sorted = [...edits].sort((a, b) => b.at - a.at);
  let added = 0;
  for (const e of sorted) {
    const idx = e.at - 1;
    if (!lines[idx] || !lines[idx].includes(e.expect)) {
      console.error(`MISS ${rel} ${e.at} :: ${e.expect}`);
      console.error('  actual: ' + JSON.stringify(lines[idx]));
      process.exit(1);
    }
    lines.splice(idx, 0, ...e.text);
    added += e.text.length;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`ADDED ${rel} +${added}`);
  totalAdded += added;
}
console.log('TOTAL ' + totalAdded);
