// B21 insert: model resolution chain
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/model/';
const files = [
  {
    name: 'resolve-model.ts',
    want: [69, 69],
    blocks: [
      {
        at: 1,
        expect: "import { gateway } from '@ai-sdk/gateway';",
        lines: [
          '// ============================================================================',
          '// resolve-model：把模型标识或模型对象统一解析为 V4 模型',
          '// 字符串走默认 provider，对象按 specificationVersion 校验后交给 asXxxV4；',
          '// 不支持的类型/版本一律抛错，不做静默降级。',
          '// ============================================================================',
        ],
      },
      {
        at: 35,
        expect: 'export function resolveLanguageModel(model: LanguageModel): LanguageModelV4 {',
        lines: [
          '// 语言模型是唯一必选能力：字符串必须能解析，解析不到由 provider 抛错。',
          '// 对象先校验版本白名单，再进入适配层。',
          '// 返回类型固定为 V4，调用方无需再关心原始版本。',
        ],
      },
      {
        at: 36,
        expect: "if (typeof model === 'string') {",
        lines: [
          '// 字符串形态依赖全局默认 provider，未配置时回退 gateway。',
        ],
      },
      {
        at: 40,
        expect: "if (!['v4', 'v3', 'v2'].includes(model.specificationVersion)) {",
        lines: [
          '// [失败路径] 用 any 读取未知版本字段，仅用于构造错误信息。',
        ],
      },
      {
        at: 52,
        expect: 'export function resolveEmbeddingModel(model: EmbeddingModel): EmbeddingModelV4 {',
        lines: [
          '// 向量模型与语言模型同构：字符串必选，对象三版本白名单。',
          '// [事务] 校验通过后交给 asEmbeddingModelV4，不在此处复制字段。',
          '// 若 provider 未注册向量模型，字符串路径会由 provider 抛 NoSuchModel。',
        ],
      },
      {
        at: 69,
        expect: 'export function resolveTranscriptionModel(',
        lines: [
          '// 转写模型是可选能力：字符串解析可能返回 undefined，',
          '// 调用方必须显式处理缺失，而不是拿到一个空实现。',
          '// 对象路径仍要求 v2/v3/v4，避免把未知版本伪装成可用模型。',
          '// 返回 undefined 时通常意味着默认 provider 未实现转写。',
        ],
      },
      {
        at: 72,
        expect: "if (typeof model === 'string') {",
        lines: [
          '// 可选链很重要：provider 未实现转写时返回 undefined 而非抛错。',
        ],
      },
      {
        at: 88,
        expect: 'export function resolveSpeechTranslationModel(',
        lines: [
          '// 语音翻译是实验能力：只接受 v4，没有 v2/v3 适配路径。',
          '// 因为该协议尚未进入 ProviderV4 接口，只能直接读全局 provider。',
          '// [失败路径] 默认 provider 不支持时给出可操作的错误文案。',
        ],
      },
      {
        at: 91,
        expect: "if (typeof model === 'string') {",
        lines: [
          '// 这里刻意绕过 getGlobalProvider：asProviderV4 会丢掉实验方法。',
        ],
      },
      {
        at: 94,
        expect: 'const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway;',
        lines: [
          '// [权衡] 直接访问内部字段并用 ts-expect-error 标注，',
          '// 是为了在实验协议稳定前不污染正式 provider 接口。',
        ],
      },
      {
        at: 109,
        expect: "if (model.specificationVersion !== 'v4') {",
        lines: [
          '// 实验模型不做跨版本适配：形状差异大，猜测转换风险高于收益。',
        ],
      },
      {
        at: 121,
        expect: 'export function resolveSpeechModel(',
        lines: [
          '// 语音合成同样是可选能力，语义与转写一致。',
          '// 缺失时返回 undefined，由上层决定是否报错。',
        ],
      },
      {
        at: 140,
        expect: 'export function resolveImageModel(model: ImageModel): ImageModelV4 {',
        lines: [
          '// 图像生成是必选能力：字符串解析失败由 provider 抛错。',
          '// 对象路径接受 v2/v3/v4，全部升到 V4 后返回。',
        ],
      },
      {
        at: 157,
        expect: 'export function resolveVideoModel(',
        lines: [
          '// 视频模型仅支持 v3/v4：v2 时代没有对应协议，无法可靠适配。',
          '// 与语音翻译一样直接读全局 provider 上的实验字段。',
        ],
      },
      {
        at: 163,
        expect: 'const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway;',
        lines: [
          '// 绕过 asProviderV4，保留 provider 的实验方法与 this 绑定。',
        ],
      },
      {
        at: 178,
        expect: "if (!['v4', 'v3'].includes(model.specificationVersion)) {",
        lines: [
          '// 白名单只含 v3/v4，v2 被明确拒绝而不是尝试转换。',
        ],
      },
      {
        at: 190,
        expect: 'export function resolveRerankingModel(model: RerankingModel): RerankingModelV4 {',
        lines: [
          '// 重排模型可选，且默认 provider 可能没有实现；',
          '// 字符串路径在缺失时抛带指引的错误，而不是返回 undefined。',
        ],
      },
      {
        at: 192,
        expect: 'const provider = getGlobalProvider();',
        lines: [
          '// 注意这里用统一适配后的 provider，与视频/翻译的实验路径不同。',
        ],
      },
      {
        at: 205,
        expect: 'if (',
        lines: [
          '// 重排只支持 v3/v4，v2 没有对应协议。',
        ],
      },
      {
        at: 220,
        expect: 'export function resolveDecisionModel(model: DecisionModel): DecisionModelV4 {',
        lines: [
          '// 决策模型同时兼容新旧命名：decisionModel 优先，evaluationModel 兜底。',
          '// 字符串路径必须保留 provider 作为 this，否则实验方法会丢绑定。',
          '// [事务] 解析出的对象还要再校验 v4 与 doDecide 是否存在。',
        ],
      },
      {
        at: 223,
        expect: 'const provider = (globalThis.AI_SDK_DEFAULT_PROVIDER ??',
        lines: [
          '// [权衡] 这里绕过 asProviderV4，因为适配对象会丢失实验字段，',
          '// 而决策模型当前仍属于实验能力。',
        ],
      },
      {
        at: 226,
        expect: 'const factory:',
        lines: [
          '// 旧名 evaluationModel 仍在生态中广泛使用，必须继续支持；',
          '// 新名 decisionModel 优先，避免同名实现出现行为分叉。',
        ],
      },
      {
        at: 249,
        expect: "if (model.specificationVersion !== 'v4') {",
        lines: [
          '// 对象路径只接受 v4：决策协议没有历史版本可适配。',
          '// 与字符串路径不同，这里直接抛错而不回退默认 provider。',
        ],
      },
      {
        at: 257,
        expect: "if ('doDecide' in model) {",
        lines: [
          '// 新接口直接可用；只有旧 doEvaluate 时才构造兼容包装。',
        ],
      },
      {
        at: 261,
        expect: 'const legacyModel = model;',
        lines: [
          '// [事务] 兼容包装是浅拷贝：保留原 provider/modelId 与能力声明，',
          '// 仅把 doDecide 转发到 doEvaluate，确保两套调用等价。',
        ],
      },
      {
        at: 271,
        expect: 'function getGlobalProvider(): ProviderV4 {',
        lines: [
          '// 全局 provider 优先取 AI_SDK_DEFAULT_PROVIDER，',
          '// 未设置时回退 gateway；最终统一升到 V4 再对外。',
        ],
      },
      {
        at: 276,
        expect: '/** Internal adapter for deprecated provider factories. */',
        lines: [
          '// 反向兼容：有些旧代码仍调用 doEvaluate，这里补一个等价方法；',
          '// 已存在则原样返回，避免重复包装。',
        ],
      },
      {
        at: 46,
        expect: '});',
        lines: [
          '// 错误对象只携带版本/provider/modelId，帮助定位但不泄露调用参数。',
        ],
      },
      {
        at: 57,
        expect: "if (!['v4', 'v3', 'v2'].includes(model.specificationVersion)) {",
        lines: [
          '// 嵌入模型与语言模型共用同一套版本白名单，行为保持一致。',
        ],
      },
      {
        at: 76,
        expect: "if (!['v4', 'v3', 'v2'].includes(model.specificationVersion)) {",
        lines: [
          '// 转写对象的版本校验与字符串路径分离：前者必须显式合法。',
        ],
      },
      {
        at: 128,
        expect: "if (!['v4', 'v3', 'v2'].includes(model.specificationVersion)) {",
        lines: [
          '// 语音合成同属可选能力，对象路径不做自动降级。',
        ],
      },
      {
        at: 145,
        expect: "if (!['v4', 'v3', 'v2'].includes(model.specificationVersion)) {",
        lines: [
          '// 图像模型版本白名单与语言模型一致。',
        ],
      },
      {
        at: 229,
        expect: "if (typeof factory !== 'function') {",
        lines: [
          '// [失败路径] 默认 provider 既无 decisionModel 也无 evaluationModel 时，',
          '// 给出带配置指引的 NoSuchModelError。',
        ],
      },
      {
        at: 239,
        expect: 'const resolvedModel = factory.call(provider, model);',
        lines: [
          '// 用 call 绑定 provider：实验方法依赖 this 访问内部状态。',
        ],
      },
      {
        at: 240,
        expect: 'if (resolvedModel == null) {',
        lines: [
          '// 工厂返回空同样视为不存在模型，统一走 NoSuchModelError。',
        ],
      },
      {
        at: 267,
        expect: 'doDecide: options => legacyModel.doEvaluate(options),',
        lines: [
          '// [事务] 包装后 doDecide 与旧 doEvaluate 完全等价，',
          '// 但调用方只应使用新名字，旧方法仅作兼容出口。',
          '// 返回对象是新引用，不修改用户传入的模型。',
        ],
      },
      {
        at: 272,
        expect: 'const provider = globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway;',
        lines: [
          '// 这里同样绕过 asProviderV4，避免实验字段被适配层过滤。',
        ],
      },
      {
        at: 280,
        expect: "if ('doEvaluate' in model && typeof model.doEvaluate === 'function') {",
        lines: [
          '// 已具备 doEvaluate 时直接返回，避免无限包装。',
        ],
      },
      {
        at: 285,
        expect: 'return {',
        lines: [
          '// [权衡] 同时提供两个方法名是过渡期策略，',
          '// 待生态迁移完成后可移除 doEvaluate。',
        ],
      },
    ],
  },
  {
    name: 'as-language-model-v3.ts',
    want: [28, 28],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// asLanguageModelV3：v2 语言模型 → v3 的最小适配',
          '// 只转换 finishReason 与 usage 两种结构差异，其余通过 Proxy 透传。',
          '// ============================================================================',
        ],
      },
      {
        at: 13,
        expect: 'export function asLanguageModelV3(',
        lines: [
          '// v3 直接返回；v2 才包装，并输出一次兼容性警告。',
          '// [权衡] 用 Proxy 而非深拷贝，保证新增属性自动可见。',
          '// 这样 v2 模型新增的自定义方法无需改动适配层。',
        ],
      },
      {
        at: 20,
        expect: 'logV2CompatibilityWarning({',
        lines: [
          '// 警告只在真正发生适配时输出，避免正常 v3 调用被噪声淹没。',
        ],
      },
      {
        at: 25,
        expect: '// TODO this could break, we need to properly map v2 to v3',
        lines: [
          '// 已知缺口：v2 的 stream part 与 tool 相关字段没有逐项映射，',
          '// 这里选择透传并在下方统一 cast，属于阶段性折中。',
        ],
      },
      {
        at: 27,
        expect: 'return new Proxy(model, {',
        lines: [
          '// 只拦截 specificationVersion / doGenerate / doStream 三个键，',
          '// 其余属性直接读目标对象。',
          '// 拦截返回值是函数时必须保持可调用，不能预先求值。',
        ],
      },
      {
        at: 33,
        expect: "return async (...args: Parameters<LanguageModelV2['doGenerate']>) => {",
        lines: [
          '// 非流式：结果展开后只替换 finishReason 与 usage，',
          '// content 形状在 v2/v3 之间兼容，不做逐项转换。',
        ],
      },
      {
        at: 42,
        expect: "return async (...args: Parameters<LanguageModelV2['doStream']>) => {",
        lines: [
          '// 流式：只包装 stream，其余元数据原样返回。',
        ],
      },
      {
        at: 56,
        expect: 'function convertV2StreamToV3(',
        lines: [
          '// 流转换用 TransformStream：逐块检查，只改写 finish 块；',
          '// 其他块直接透传，保持首 token 延迟与背压语义。',
          '// [资源] 下游取消会通过 pipe 传导到上游。',
          '// 转换过程中不缓存跨块状态，因此内存占用与流长度无关。',
        ],
      },
      {
        at: 63,
        expect: "case 'finish':",
        lines: [
          '// finish 块同时携带 finishReason 与 usage，二者都要升级。',
        ],
      },
      {
        at: 70,
        expect: 'default:',
        lines: [
          '// [权衡] 未映射的块直接 cast 透传，而不是丢弃或报错。',
        ],
      },
      {
        at: 80,
        expect: 'function convertV2FinishReasonToV3(',
        lines: [
          '// v2 的 unknown 在 v3 统一归为 other；raw 保留 undefined。',
          '// [事务] 不修改调用方传入的对象，返回新结构。',
          '// unified 是 v3 新增的归一化字段，用于跨 provider 比较。',
        ],
      },
      {
        at: 89,
        expect: 'function convertV2UsageToV3(usage: LanguageModelV2Usage): LanguageModelV3Usage {',
        lines: [
          '// 扁平 usage 升级为分组结构：input/output 各自 total 与细分项；',
          '// 缺失的细分项填 undefined，保留 totalTokens 到 raw。',
          '// [权衡] 不做字段猜测，未知细分项宁可为空也不臆造。',
        ],
      },
    ],
  },
  {
    name: 'as-transcription-model-v4.ts',
    want: [11, 11],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// asTranscriptionModelV4：v2/v3 转写模型 → v4',
          '// v4 直接返回；其余先升到 v3，再用 Proxy 补 v4 的 timestampGranularities。',
          '// ============================================================================',
        ],
      },
      {
        at: 8,
        expect: 'export function asTranscriptionModelV4(',
        lines: [
          '// [事务] 先归一到 v3，避免在 v4 层写两套 v2/v3 分支。',
          '// 返回的 Proxy 保留原始 provider/modelId，便于错误定位。',
        ],
      },
      {
        at: 15,
        expect: '// first convert v2 to v3, then proxy v3 as v4:',
        lines: [
          '// 两级升级的中间产物就是 v3 模型，后续只面对一种形状。',
          '// [资源] Proxy 不持有额外资源。',
        ],
      },
      {
        at: 19,
        expect: 'return new Proxy(v3Model, {',
        lines: [
          '// 只拦截 specificationVersion 与 doGenerate；',
          '// 后者负责剥离 v4 专属参数并补充不支持警告。',
        ],
      },
      {
        at: 27,
        expect: '// Bind to the original model, including when target is a v2 proxy.',
        lines: [
          '// 用 call 绑定原始 model，保证 v2 代理链上的 this 仍指向用户对象。',
        ],
      },
    ],
  },
  {
    name: 'as-provider-v3.ts',
    want: [9, 9],
    blocks: [
      {
        at: 1,
        expect: "import type { ProviderV2, ProviderV3 } from '@ai-sdk/provider';",
        lines: [
          '// ============================================================================',
          '// asProviderV3：v2 provider → v3',
          '// 返回新对象并逐个包装模型工厂；v2 没有重排能力，显式置 undefined。',
          '// ============================================================================',
        ],
      },
      {
        at: 8,
        expect: 'export function asProviderV3(provider: ProviderV2 | ProviderV3): ProviderV3 {',
        lines: [
          '// [事务] 已是 v3 直接返回；否则按 v2 的工厂名逐个升级。',
        ],
      },
      {
        at: 19,
        expect: 'return {',
        lines: [
          '// 注意 textEmbeddingModel 是 v2 的旧名，v3 统一为 embeddingModel。',
          '// 可选模型（转写/语音）缺失时保持 undefined，不构造假实现。',
          '// 重排模型在 v2 不存在，显式置 undefined 让能力探测得到否定答案。',
          '// 返回对象不含额外状态，可安全反复创建。',
        ],
      },
    ],
  },
  {
    name: 'as-embedding-model-v4.ts',
    want: [5, 5],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// asEmbeddingModelV4：向量模型的版本升级外壳',
          '// v2→v3 后只改写 specificationVersion，其余字段原样透传。',
          '// ============================================================================',
        ],
      },
      {
        at: 8,
        expect: 'export function asEmbeddingModelV4(',
        lines: [
          '// [事务] 结构在 v3/v4 之间未变，因此不需要新增字段转换。',
        ],
      },
    ],
  },
  {
    name: 'as-image-model-v4.ts',
    want: [5, 5],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// asImageModelV4：图像模型的版本升级外壳',
          '// v2→v3 后只改写 specificationVersion，其余字段原样透传。',
          '// ============================================================================',
        ],
      },
      {
        at: 8,
        expect: 'export function asImageModelV4(',
        lines: [
          '// [事务] 图像协议在 v3/v4 之间保持同形，无需字段映射。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (
    f.name === 'resolve-model.ts' ||
    f.name === 'as-language-model-v3.ts' ||
    f.name === 'as-transcription-model-v4.ts'
  ) {
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
