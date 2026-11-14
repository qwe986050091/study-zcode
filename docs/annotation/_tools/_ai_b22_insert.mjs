// B22 insert: custom provider + reasoning/json extraction middleware
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'registry/custom-provider.ts',
    want: [60, 64],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// customProvider：把「模型映射表 + 可选 fallback」包装成 ProviderV4',
          '// 解析顺序固定为：本地映射 → fallbackProvider → NoSuchModelError；',
          '// 本地命中后仍走 resolveXxxModel，保证对外返回的一定是 V4 形状。',
          '// 该工厂是 registry 的兜底实现，也是自定义模型映射的唯一入口。',
          '// ============================================================================',
        ],
      },
      {
        at: 40,
        expect: 'type ProviderWithOptionalVideoModel = {',
        lines: [
          '// 视频模型尚未进入 ProviderV4 的正式接口，这里只声明 fallback 可能暴露的最小形状；',
          '// 用结构化类型而非供应商具体类型，避免把实验能力写死。',
        ],
      },
      {
        at: 65,
        expect: 'export function customProvider<',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 解析顺序固定：本地映射 → fallback → NoSuchModelError，中间不得短路。',
          '// INV-02 本地命中也要适配：返回值必须经 resolveXxxModel 升到 V4。',
          '// INV-03 能力保持缺失：可选模型缺失时继续 fallback，而不是返回空实现。',
          '// INV-04 decisionModels 优先于已废弃的 evaluationModels。',
          '// INV-05 fallback 只适配一次：入口统一 asProviderV4，避免每次调用重复包装。',
          '// INV-06 files/skills 只在底层存在时注入，能力探测不能撒谎。',
          '// 守住位置：INV-01 在每个模型工厂，INV-02/03 在 resolve 与 fallback 分支，',
          '// INV-04 在入口，INV-05 在 fallbackProvider 赋值处，INV-06 在 filesAndSkills。',
        ],
      },
      {
        at: 80,
        expect: '>({',
        lines: [
          '// 解构时改名是为了保留「用户原始值」与「适配后值」两条引用：',
          '// decisionModelsArg 参与新旧名合并，fallbackProviderArg 保留未适配对象；',
          '// [权衡] 实验能力（决策/视频）依赖原始 provider 的 this，不能只留适配结果。',
          '// 其余映射表按引用保存，工厂方法调用时才读取，天然支持后续替换。',
        ],
      },
      {
        at: 132,
        expect: 'const decisionModels = decisionModelsArg ?? evaluationModels;',
        lines: [
          '// [事务] 新名优先、空值才回退旧名：同时传入时行为确定，不会合并两份映射。',
          '// 旧字段仅在类型层标记 deprecated，运行期仍需完整支持。',
        ],
      },
      {
        at: 133,
        expect: 'const fallbackProvider =',
        lines: [
          '// [事务] fallback 只在这里适配一次，后续所有工厂复用同一 V4 视图。',
          '// [权衡] asProviderV4 会过滤实验字段，所以决策/视频分支改用原始值，',
          '// 其余能力走适配后的 fallbackProvider，保证返回类型统一。',
          '// [资源] 适配层创建新对象但不复制模型，开销固定且与调用次数无关。',
        ],
      },
      {
        at: 136,
        expect: 'const baseProvider: ProviderV4 & {',
        lines: [
          '// 返回类型在这里重复声明，是为了让每个方法的 this 与参数获得完整推断；',
          '// 三个映射表在闭包里只读，provider 对象本身不持有可变状态。',
          '// 因此同一个 customProvider 实例可被多请求并发复用。',
        ],
      },
      {
        at: 157,
        expect: 'languageModel(modelId: ExtractModelId<LANGUAGE_MODELS>): LanguageModelV4 {',
        lines: [
          '// [失败路径] 三段式判定：本地命中 → fallback → 抛 NoSuchModelError。',
          '// 注意 in 会命中原型链上的键（如 toString），这是该分支的已知易踩坑；',
          '// decisionModel 因此改用 Object.hasOwn，两者行为差异是有意保留的。',
        ],
      },
      {
        at: 162,
        expect: 'if (fallbackProvider) {',
        lines: [
          '// fallback 返回的模型已经过入口适配，这里不再二次 resolve。',
        ],
      },
      {
        at: 169,
        expect: 'embeddingModel(',
        lines: [
          '// 向量模型与语言模型同构：本地映射优先，fallback 次之。',
          '// 本地值可能是 v2/v3，交给 resolveEmbeddingModel 统一升级。',
        ],
      },
      {
        at: 183,
        expect: 'imageModel(modelId: ExtractModelId<IMAGE_MODELS>): ImageModelV4 {',
        lines: [
          '// 图像能力在旧 provider 上可能不存在，fallback 分支必须用 ?. 探测。',
          '// 探测失败按「没有该能力」处理，最终仍抛 NoSuchModelError。',
        ],
      },
      {
        at: 195,
        expect: 'transcriptionModel(',
        lines: [
          '// 转写是可选能力：resolve 可能返回 undefined（默认 provider 未实现）。',
          '// undefined 不等于命中，必须继续走 fallback 而不是直接返回。',
          '// 只有本地值非空才提前返回，否则三段式顺序会被破坏。',
        ],
      },
      {
        at: 213,
        expect: 'speechModel(modelId: ExtractModelId<SPEECH_MODELS>): SpeechModelV4 {',
        lines: [
          '// 语音合成同样可选，缺失时按未命中处理，语义与转写一致。',
        ],
      },
      {
        at: 228,
        expect: 'rerankingModel(',
        lines: [
          '// 重排模型通常只有新 provider 支持，fallback 探测同样用 ?.。',
          '// 本地命中时 resolveRerankingModel 会保证版本合法。',
        ],
      },
      {
        at: 241,
        expect: 'decisionModel(modelId: ExtractModelId<DECISION_MODELS>): DecisionModelV4 {',
        lines: [
          '// 这里用 Object.hasOwn 而非 in，避免原型链键被误判为本地模型。',
          '// fallback 工厂用 call 绑定 provider：实验方法依赖 this 访问内部状态。',
          '// 工厂返回空与工厂不存在都视为未命中，统一落到 NoSuchModelError。',
          '// 最后再 resolveDecisionModel，补齐 v4 校验与 doDecide 兼容。',
        ],
      },
      {
        at: 259,
        expect: 'evaluationModel(modelId: ExtractModelId<DECISION_MODELS>) {',
        lines: [
          '// 兼容出口：旧调用方仍使用 evaluationModel，内部转调新方法。',
          '// this.decisionModel 依赖方法调用的接收者，解构后调用会丢失 this。',
          '// asEvaluationModel 把 doDecide 映射为 doEvaluate，两套命名行为等价。',
        ],
      },
      {
        at: 262,
        expect: 'videoModel(',
        lines: [
          '// 视频仍是实验能力：fallback 用原始 provider，避免适配层过滤 videoModel。',
          '// 本地值接受 v3/v4，具体版本兼容由 resolveVideoModel 判定。',
          '// 视频能力完全缺失时同样抛 NoSuchModelError，不做空实现。',
        ],
      },
      {
        at: 280,
        expect: 'const filesAndSkills = {',
        lines: [
          '// [事务] 用条件展开构造可选能力：底层不存在时连方法名都不出现。',
          '// 本地 files/skills 优先，其次才是 fallback；非空断言由条件保证。',
          '// 返回的是同一实例而非 getter，调用方拿到的能力对象稳定可比较。',
          '// [权衡] 不用原型或 Proxy，保持返回对象是普通可枚举结构。',
        ],
      },
      {
        at: 307,
        expect: 'return Object.assign(baseProvider, filesAndSkills);',
        lines: [
          '// assign 保留 baseProvider 上的方法本体，只把可选能力挂到同一对象；',
          '// 因 files/skills 条件注入，返回类型与运行期形状始终一致。',
        ],
      },
      {
        at: 310,
        expect: 'type ExtractModelId<MODELS extends Record<string, unknown>> = Extract<',
        lines: [
          '// 模型 id 只允许 string 键，避免 symbol/number 进入公开方法签名；',
          '// 该类型只存在于编译期，不产生任何运行时代码。',
        ],
      },
    ],
  },
  {
    name: 'middleware/extract-reasoning-middleware.ts',
    want: [64, 64],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// extractReasoningMiddleware：把文本里的推理段落拆成 reasoning 部件',
          '// 支持 XML 标签与字面分隔符两种形态；非流式重写 content，流式走状态机。',
          '// 流式难点在于标签可能被切碎，必须缓冲半截标签并延后 text-start。',
          '// 本文件不解析推理内容，只负责边界识别与事件重排。',
        ],
      },
      {
        at: 19,
        expect: 'export function extractReasoningMiddleware({',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 分隔符在此定稿：opening/closing 只展开一次，两种模式共用。',
          '// INV-02 分隔符是字面量：先转义再拼 RegExp，元字符不得被解释。',
          '// INV-03 事件成对：reasoning-start/end 与 text-start/end 由同一状态机发放。',
          '// INV-04 text-start 必须延后：先 reasoning-start 再 text-start（issue #7774）。',
          '// INV-05 半截标签不落盘：getPotentialStartIndex 命中的尾部留在 buffer。',
          '// INV-06 分隔符只补在非空段之间：首段与尾部不产生多余分隔。',
          '// 守住位置：INV-01/02 在函数入口，INV-03/04 在 publish 与 text-end，',
          '// INV-05 在 do-while 的未完整匹配分支。',
        ],
      },
      {
        at: 33,
        expect: 'if (openingTag.length === 0 || closingTag.length === 0) {',
        lines: [
          '// [失败路径] 空分隔符会让正则匹配任意位置，必须在建正则前拒绝。',
          '// 错误信息只描述参数约束，不回显用户传入的完整对象。',
        ],
      },
      {
        at: 41,
        expect: '// Delimiters are literal strings, including regex metacharacters such as `|`.',
        lines: [
          '// [事务] 转义发生在拼正则之前，保证 Gemma 的 `|` 等分隔符按字面匹配；',
        ],
      },
      {
        at: 45,
        expect: 'function extractReasoning(input: string) {',
        lines: [
          '// 非流式一次性提取：startWithReasoning 时先补 opening，让首段也能匹配。',
          '// 正则用非贪婪 + s 标志，跨行推理段会被完整捕获。',
          '// 多段推理用 separator 拼接，空段也会保留位置。',
        ],
      },
      {
        at: 53,
        expect: 'if (!matches.length) {',
        lines: [
          '// 没有匹配时原样返回，reasoning 为 undefined 以区分「未提取到」与「提取到空」。',
        ],
      },
      {
        at: 57,
        expect: 'const reasoning = matches.map(match => match[1]).join(separator);',
        lines: [
          '// 捕获组 1 才是推理正文，标签本身不进入结果。',
        ],
      },
      {
        at: 59,
        expect: 'for (let i = matches.length - 1; i >= 0; i--) {',
        lines: [
          '// [事务] 从后往前删除，前面匹配的 index 不会因字符串变短而失效。',
          '// 仅当标签两侧都还有内容时才插入分隔符，避免首尾多出空行。',
          '// 删除的是标签而不是文本，正文顺序保持不变。',
        ],
      },
      {
        at: 77,
        expect: 'wrapGenerate: async ({ doGenerate }) => {',
        lines: [
          '// 非流式只改写 content 中的 text 部件，其余部件原样保留。',
        ],
      },
      {
        at: 87,
        expect: 'const { text, reasoning } = extractReasoning(part.text);',
        lines: [
          '// 未命中时整个部件不动，避免把普通文本错误拆成空 reasoning；',
          '// 命中时先输出 reasoning 再输出 text，保证下游看到稳定顺序。',
          '// structuredOutputText 只取剥离后的 text，不产生 reasoning 部件。',
        ],
      },
      {
        at: 113,
        expect: 'wrapStream: async ({ doStream }) => {',
        lines: [
          '// 流式状态机按 text block id 隔离：并行文本块互不干扰。',
          '// 每个块独立维护 isReasoning/buffer/首次标记，切换只影响本块。',
          '// 所有输出都经 TransformStream，背压与取消沿用上游语义。',
          '// 推理正文不在内存中累积，只保留尚未决定归属的尾部。',
        ],
      },
      {
        at: 129,
        expect: 'let reasoningIdCounter = 0;',
        lines: [
          '// [并发] 计数器只保证同一流内 id 唯一，不承担跨流全局唯一性。',
        ],
      },
      {
        at: 131,
        expect: 'const delayedTextStarts: Record<',
        lines: [
          '// [事务] INV-04：text-start 先暂存，等首次文本真正下发时再补发；',
          '// 否则下游会先收到 text-start 再收到 reasoning-start，顺序错乱。',
          '// 暂存表按 text block id 索引，text-end 时兜底补发。',
        ],
      },
      {
        at: 150,
        expect: "if (chunk.type !== 'text-delta' && chunk.type !== 'text-end') {",
        lines: [
          '// 其它事件（tool/error/finish 等）不参与状态机，直接透传。',
        ],
      },
      {
        at: 155,
        expect: 'if (',
        lines: [
          '// 状态惰性创建：只有真正出现 text-delta 才分配，避免 text-end 空块。',
          '// startWithReasoning 决定初态，之后只由标签切换驱动。',
          '// buffer 初始为空，第一段文本进入后才开始寻找标签。',
          '// 该状态只服务于当前 text block，不跨块共享。',
        ],
      },
      {
        at: 181,
        expect: 'function getReasoningId() {',
        lines: [
          '// 推理 id 惰性生成并缓存；reasoning-end 后清空，下一段推理获得新 id。',
        ],
      },
      {
        at: 185,
        expect: 'function publish(text: string) {',
        lines: [
          '// publish 是唯一输出口：保证 reasoning/text 事件与 buffer 清空顺序一致。',
          '// 切换后的首块补 separator，使多段推理或多段文本保持可读间隔。',
          '// reasoning-start 只在首块或切换后发，避免同一 id 重复 start。',
          '// 空文本直接返回，不下发空 delta，避免下游渲染空节点。',
        ],
      },
      {
        at: 235,
        expect: "if (chunk.type === 'text-end') {",
        lines: [
          '// 收尾顺序：先 flush 残留 buffer，再补发被延后的 text-start，最后透传 end。',
          '// 缺失的 start 必须补发，否则下游会收到无主的 delta/end。',
          '// 清空 buffer 后状态对象仍在 map 中，便于同 id 的异常事件继续透传。',
        ],
      },
      {
        at: 247,
        expect: 'activeExtraction.buffer += chunk.delta;',
        lines: [
          '// 只缓冲尚未决定归属的部分，已 publish 的内容立即释放。',
        ],
      },
      {
        at: 249,
        expect: 'do {',
        lines: [
          '// STEP 循环：每轮处理一个最近的标签，直到没有完整标签可消费。',
          '// 当前状态决定要找 opening 还是 closing，状态翻转后继续下一轮。',
          '// 循环不设迭代上限，因为每轮至少消费一个标签或直接 break。',
        ],
      },
      {
        at: 269,
        expect: 'const foundFullMatch =',
        lines: [
          '// [事务] 只有完整标签才消费；半截标签从 startIndex 起整体留在 buffer，',
          '// 等下一块补齐。否则会把 `<thi` 当正文提前发出去。',
          '// getPotentialStartIndex 同时覆盖「标签前缀」与「完全无标签」两种情况。',
          '// foundFullMatch 为假只可能出现在流末尾的残缺标签。',
        ],
      },
      {
        at: 277,
        expect: 'if (activeExtraction.isReasoning) {',
        lines: [
          '// 空推理块也要发 reasoning-start，否则只有 end 没有 start；',
          '// 随后立即发 reasoning-end 并清空 id，下一段推理重新编号。',
          '// [失败路径] 该分支覆盖 <think></think> 与紧随其后的 </think> 两种写法。',
          '// 非推理分支不需要补 end，只翻转状态等待 closing。',
        ],
      },
      {
        at: 297,
        expect: 'activeExtraction.isReasoning = !activeExtraction.isReasoning;',
        lines: [
          '// 完整标签消费后翻转状态；afterSwitch 让下一段首块补分隔符。',
          '// 翻转后 buffer 可能还有内容，do-while 会继续处理下一个标签。',
        ],
      },
    ],
  },
  {
    name: 'middleware/extract-json-middleware.ts',
    want: [26, 28],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// extractJsonMiddleware：剥离 markdown 代码围栏，让结构化输出可直接解析',
          '// 非流式整体改写 text；流式用 prefix/streaming/buffering 三阶段状态机。',
          '// 难点是尾围栏可能被切碎，必须保留疑似后缀直到 text-end。',
        ],
      },
      {
        at: 11,
        expect: 'function defaultTransform(text: string): string {',
        lines: [
          '// 默认转换只处理首尾围栏并 trim，不解析 JSON、不修复内容。',
          '// 只有 ``` 与 ```json 两种前缀被识别，其它语言标记按原样保留。',
        ],
      },
      {
        at: 18,
        expect: 'function stripMarkdownCodeFenceSuffix(text: string): string {',
        lines: [
          '// 流式已输出前缀时只能剥后缀，否则会二次 trim 掉合法的前导空白。',
        ],
      },
      {
        at: 22,
        expect: 'function getPotentialSuffixStart(text: string): number {',
        lines: [
          '// 从尾部回退空白、最多 3 个反引号、再回退空白，得到可安全下发的位置。',
          '// 返回值之后的内容可能是半个尾围栏，必须留在 buffer 等下一块。',
          '// [权衡] 宁可多缓冲几个字符，也不把 ``` 提前发给下游。',
        ],
      },
      {
        at: 55,
        expect: 'export function extractJsonMiddleware(options?: {',
        lines: [
          '// 自定义 transform 无法增量执行，因此流式会退化为全量缓冲。',
        ],
      },
      {
        at: 63,
        expect: 'const transform = options?.transform ?? defaultTransform;',
        lines: [
          '// hasCustomTransform 决定 text-start 的初始 phase：',
          '// 默认转换可边流边剥，自定义转换只能 buffering 到结束。',
        ],
      },
      {
        at: 69,
        expect: 'wrapGenerate: async ({ doGenerate }) => {',
        lines: [
          '// 非流式对每个 text 部件与 structuredOutputText 各做一次完整转换。',
        ],
      },
      {
        at: 93,
        expect: 'wrapStream: async ({ doStream }) => {',
        lines: [
          '// 流式三阶段：prefix 判前缀、streaming 边流边留后缀、buffering 全量等结束。',
          '// 阶段只前进不回退，保证同一块的输出顺序与语义稳定。',
          '// pipeThrough 保留背压；下游取消会传导到上游流。',
        ],
      },
      {
        at: 96,
        expect: 'const textBlocks: Record<',
        lines: [
          '// 每个 text block 独立状态：startEvent 延后到确认有内容可发时再下发。',
          '// prefixStripped 记录前缀是否已消费，决定 text-end 该做完整转换还是只剥后缀。',
          '// createIdMap 避免 id 与对象原型键冲突。',
        ],
      },
      {
        at: 113,
        expect: "if (chunk.type === 'text-start') {",
        lines: [
          '// text-start 先暂存不转发，等首个 delta 判定完前缀后再补发。',
        ],
      },
      {
        at: 138,
        expect: "if (block.phase === 'prefix') {",
        lines: [
          '// prefix 判定：首字符非反引号立即进入 streaming；',
          '// 以 ``` 开头则等到换行再尝试剥完整围栏；其余情况缓冲到能决策为止。',
        ],
      },
      {
        at: 176,
        expect: "if (block.phase === 'streaming') {",
        lines: [
          '// 只下发确定安全的部分，尾部疑似空白或围栏继续留在 buffer。',
        ],
      },
      {
        at: 196,
        expect: "if (chunk.type === 'text-end') {",
        lines: [
          '// 收尾：从未发过 start 的块先补发，再按阶段选择完整转换或仅剥后缀；',
          '// 残留文本非空才补一个 text-delta，最后透传 text-end 并清理状态。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (f.name === 'registry/custom-provider.ts') {
    console.log('SKIP already inserted', f.name);
    continue;
  }
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      process.exit(1);
    }
    total += b.lines.length;
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
