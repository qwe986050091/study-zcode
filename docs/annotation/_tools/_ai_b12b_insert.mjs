import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';

function insertBefore(rel, needle, text, occurrence = 0) {
  const file = path.join(ROOT, rel);
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) {
      if (seen === occurrence) {
        lines.splice(i, 0, ...text);
        fs.writeFileSync(file, lines.join('\r\n'));
        console.log(`OK ${rel} +${text.length} @${needle}#${occurrence}`);
        return;
      }
      seen++;
    }
  }
  console.error(`MISS ${rel} ${needle}#${occurrence}`);
  process.exit(1);
}

const FJ = 'packages/ai/src/util/fix-json.ts';
insertBefore(FJ, 'function isHexDigit(char: string) {', [
  '// 只接受 ASCII 十六进制字符，不接受全角/Unicode 数字，保持与 JSON 规范一致。',
  '// [权衡] 不用 Number.parseInt，避免 "0x" 前缀与空格被误接受。',
]);
insertBefore(FJ, "case 'ROOT':", [
  '// ROOT 只应出现一次；多顶层值（如 "{}{}"）在 FINISH 后再无状态可匹配。',
  '// [失败路径] 这类非法输入不会被修正，最终由 JSON.parse 抛错。',
]);
insertBefore(FJ, "case 'INSIDE_OBJECT_AFTER_KEY': {", [
  '// key 之后的冒号可能尚未到达（流式截断），此时保持状态等下一个字符。',
  '// 结束时该状态会被补齐为 }，得到空对象。',
]);
insertBefore(FJ, "case 'INSIDE_ARRAY_AFTER_COMMA': {", [
  '// 数组逗号后可能立即截断；结束时按栈补 ]，得到不含尾随逗号的数组。',
  '// 与对象逗号后的处理对称。',
]);
insertBefore(FJ, "case 'INSIDE_NUMBER': {", [
  '// 数字可以跨多个 delta；e/E/-/. 不推进截断点，确保 "1e" 不会被截成 "1"。',
  '// 遇到分隔符时先弹栈再重新分派，避免数字状态吞掉容器的结构字符。',
  '// [权衡] 不校验数字语法（如 "1..2"），交给 JSON.parse。',
]);
insertBefore(FJ, 'let result = input.slice(0, lastValidIndex + 1);', [
  '// slice 的终点是 lastValidIndex + 1；它只增不减，因此不会回退到更早的前缀。',
  '// [失败路径] 输入为空或全是空白时返回空串。',
]);
insertBefore(FJ, 'for (let i = stack.length - 1; i >= 0; i--) {', [
  '// 从栈顶向下遍历，保证先闭合内层再闭合外层。',
  '// ROOT/FINISH 不出现在补齐分支里，因此不会追加多余字符。',
  '// [事务] 补齐阶段只读栈，不再修改状态，保证幂等。',
]);
insertBefore(FJ, "case 'INSIDE_STRING': {", [
  '// 第二处 INSIDE_STRING 位于补齐阶段：为未闭合字符串补右引号。',
  '// 注意它与扫描阶段同名分支语义不同：这里不更新 lastValidIndex。',
  '// [失败路径] 若字符串停在转义符后，截断点已回退，不会补出半个转义。',
], 1);

function apply(rel, anchors) {
  const file = path.join(ROOT, rel);
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');

  for (const a of anchors) {
    const idx = a.at - 1;
    if (idx < 0 || idx >= lines.length || !lines[idx].includes(a.expect)) {
      console.error(`MISS ${rel} @${a.at} expect=${a.expect} actual=${lines[idx]}`);
      process.exit(1);
    }
  }

  for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
    lines.splice(a.at - 1, 0, ...a.text);
  }

  fs.writeFileSync(file, lines.join('\r\n'));
  console.log(`OK ${rel} +${anchors.reduce((s, a) => s + a.text.length, 0)}`);
}

apply('packages/ai/src/registry/provider-registry.ts', [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// Provider 注册表：把 "providerId:modelId" 字符串解析成具体模型实例，并统一挂中间件。',
      '// 链路位置：不在用户直接 new 模型的主路径上，而是字符串模型 id 的解析后备。',
      '// 两类 provider：V4 原生实例与 V3 旧实例，注册时统一经 asProviderV4 适配。',
      '// 不变量：INV-01 id 必须含分隔符，否则抛 NoSuchModelError（守住 306-320）；',
      '//   INV-02 provider 必须存在，否则抛 NoSuchProviderError（守住 288-304）；',
      '//   INV-03 语言/图像模型必须经过中间件包装，其它模型不包装（守住 334、374）。',
      '// ============================================================================',
    ],
  },
  {
    at: 31,
    expect: 'type ProviderWithOptionalVideoModel = {',
    text: [
      '// 视频模型是实验能力，V3/V4 都可能存在。',
      '// 用 "可选方法" 描述，兼容尚未实现 videoModel 的 provider。',
      '// 该类型只用于注册时的适配，不进入公共接口。',
    ],
  },
  {
    at: 37,
    expect: 'type RegistryModelType =',
    text: [
      '// 注册表支持的全部模型类型，用于构造错误信息里的 modelType。',
      '// 新增模型类型时必须同步：这里的联合、接口方法、DefaultProviderRegistry 实现。',
      '// [权衡] 用字符串字面量而非 enum，保持可擦除类型与零运行时产物。',
    ],
  },
  {
    at: 47,
    expect: 'type ProviderVideoModelIdentifier<PROVIDER> =',
    text: [
      '// 从 provider.videoModel 的第一个参数类型里提取字面量联合，用于 id 的编译期校验。',
      '// 若 provider 没有 videoModel，退化为 never，任何 id 都不匹配。',
      '// [权衡] 仅做类型层推导，运行时不校验具体模型 id。',
      '// 这样 registry.videoModel("openai:xxx") 能在编辑器里得到补全与报错。',
    ],
  },
  {
    at: 53,
    expect: 'type ProviderDecisionModelIdentifier<PROVIDER> =',
    text: [
      '// 决策模型的 id 推导：优先 decisionModel，其次旧名 evaluationModel。',
      '// 与 videoModel 不同，这里两个方法可能同时存在，因此用条件类型串联。',
      '// 旧名只为兼容，新 provider 只应实现 decisionModel。',
      '// 推导结果同样只影响编译期。',
    ],
  },
  {
    at: 62,
    expect: 'export type DecisionProviderRegistry<',
    text: [
      '// 决策模型注册表：在稳定接口之上增加 decisionModel/evaluationModel。',
      '// 之所以单独扩展而不写进主接口，是因为决策能力仍是实验性的。',
      '// evaluationModel 返回带 doEvaluate 别名的对象，兼容旧调用方。',
      '// 交叉类型保证它仍可当作普通 ProviderRegistryProvider 使用。',
    ],
  },
  {
    at: 89,
    expect: 'export interface ProviderRegistryProvider<',
    text: [
      '// 稳定接口：每种模型一对重载。',
      '// 第一个重载用模板字面量 + 字面量联合做 "精确 id" 校验；',
      '// 第二个重载放宽为任意 string，用于运行时拼出的 id。',
      '// files/skills 只按 providerId 取，不涉及 modelId。',
      '// [权衡] 精确重载在前，保证编辑器优先给出字面量提示。',
    ],
  },
  {
    at: 96,
    expect: 'languageModel<KEY extends keyof PROVIDERS>(',
    text: [
      '// 语言模型：解析出 provider 后调用其 languageModel 工厂；',
      '// 若注册了语言模型中间件，则在返回前统一包装（INV-03）。',
      '// 中间件顺序：数组第一个先转换输入，最后一个最贴近模型。',
      '// 该方法不缓存实例：每次调用都会重新创建（provider 工厂通常很轻）。',
    ],
  },
  {
    at: 150,
    expect: 'videoModel<KEY extends keyof PROVIDERS>(',
    text: [
      '// 视频模型：解析后调用 provider.videoModel；',
      '// factory 结果统一经 asVideoModelV4 升级到 V4，屏蔽 V3/V4 差异。',
      '// 注册时已对 videoModel 做过 bind 与适配，这里只负责取值与升级。',
    ],
  },
  {
    at: 181,
    expect: 'export function createProviderRegistry<',
    text: [
      '// 工厂：创建 DefaultProviderRegistry 并逐个注册 provider。',
      '// 注册发生在构造之后，保证 "先建容器、再填内容"，避免构造参数与注册逻辑耦合。',
      '// separator 默认冒号，可自定义；它同时影响 splitId 与所有 id 模板类型。',
      '// 中间件只对 languageModel/imageModel 生效，其它模型类型不包装。',
      '// [并发] 返回后注册表视为只读；运行期再注册属于未定义行为。',
      '// [失败路径] provider 缺方法不会在此报错，而是在取模型时抛 NoSuchModelError。',
      '// 这样注册阶段不会因 "某个 provider 只实现了部分模型" 而整体失败。',
      '// 返回类型是 DecisionProviderRegistry，兼容稳定接口与实验决策接口。',
    ],
  },
  {
    at: 204,
    expect: 'for (const [id, provider] of Object.entries(providers)) {',
    text: [
      '// 逐项注册：Object.entries 的顺序即注册顺序，但不影响按 id 查找。',
      '// 断言 keyof PROVIDERS 只是让泛型推导收敛，运行时不校验 key。',
      '// [资源] providers 用 Object.create(null) 存放，避免原型链键被误命中。',
    ],
  },
  {
    at: 219,
    expect: 'class DefaultProviderRegistry<',
    text: [
      '// 默认实现：同时实现稳定接口与决策扩展接口。',
      '// 内部持有一个 "最宽" 的 provider 视图：V4 + 可选 videoModel + 决策方法。',
      '// 所有查找都走 getProvider/splitId，保证错误信息一致。',
      '// 中间件在取模型时即时包装，不在注册时包装，避免同一模型被多次包装。',
      '// [并发] 实例在构造完成后不可变，可安全被多请求复用。',
    ],
  },
  {
    at: 227,
    expect: 'private providers: Partial<',
    text: [
      '// 用 null 原型存 provider：防止 constructor/toString 等键命中 Object.prototype。',
      '// 值类型是交叉类型，兼容 V4、可选 videoModel 与决策方法。',
      '// Partial 表示允许只注册部分 provider。',
      '// 查找时用 as keyof PROVIDERS 收敛，运行时不保证键存在。',
    ],
  },
  {
    at: 255,
    expect: 'registerProvider<K extends keyof PROVIDERS>({',
    text: [
      '// 注册单个 provider，并做三件适配：',
      '// STEP-1 asProviderV4：V3 -> V4 升级；',
      '// STEP-2 绑定 videoModel 并包装为 V4（若存在）；',
      '// STEP-3 绑定 decisionModel/evaluationModel，适配实例保留原始 receiver。',
      '// [事务] 三步全部成功后才写入 this.providers。',
      '// 若 provider 已是 V4 且无 videoModel，registeredProvider 与原对象同一。',
    ],
  },
  {
    at: 262,
    expect: 'const providerV4 = asProviderV4(provider);',
    text: [
      '// asProviderV4 对 V4 实例是恒等，对 V3 实例返回适配对象。',
      '// 因此后续代码可以无条件按 V4 使用。',
      '// [失败路径] 适配器只补齐方法，不校验行为，错误留到实际调用。',
      '// 该调用不产生 I/O。',
    ],
  },
  {
    at: 267,
    expect: 'const decisionProvider = provider as DecisionProvider;',
    text: [
      '// 决策方法优先取 decisionModel，其次取旧名 evaluationModel。',
      '// 必须 bind(provider)：适配后的对象不是原 provider，this 会指错。',
      '// 两者都缺失时为 undefined，注册仍成功（只是不能取 decisionModel）。',
      '// 这里不包装返回值，交给 decisionModel() 里的 resolveDecisionModel。',
      '// [权衡] 保留 evaluationModel 回退，兼容尚未迁移的 provider。',
    ],
  },
  {
    at: 272,
    expect: 'const registeredProvider =',
    text: [
      '// 只有存在 videoModel 时才创建适配对象：',
      '// 用 Object.create(原型) + 展开，保留 prototype 上的其它方法。',
      '// videoModel 返回值经 asVideoModelV4 升级，调用方无需关心 V3/V4。',
      '// [权衡] 用原型复制而非 Proxy，避免代理开销与不可枚举属性陷阱。',
      '// 无 videoModel 时直接返回 providerV4，保持对象身份不变。',
    ],
  },
  {
    at: 282,
    expect: 'if (registeredProvider !== provider && decisionModel != null) {',
    text: [
      '// 若发生 V3->V4 适配（对象身份变化），把 bind 后的决策方法挂到新对象上。',
      '// V4 原生实例保持原样，避免覆盖 provider 自己实现的 decisionModel。',
      '// [失败路径] 决策方法缺失时跳过，不影响其它能力。',
    ],
  },
  {
    at: 288,
    expect: 'private getProvider(',
    text: [
      '// 按 providerId 查找，缺失时抛 NoSuchProviderError 并列出所有可用 provider。',
      '// modelType 只用于错误信息，帮助区分 "provider 不存在" 与 "模型不存在"。',
      '// [失败路径] 返回类型非空，调用方无需判空。',
      '// 错误里带 availableProviders，便于拼写错误时自助排查。',
      '// [权衡] 每次查找都是属性读取，不做缓存（注册表本身很小）。',
    ],
  },
  {
    at: 306,
    expect: 'private splitId(',
    text: [
      '// 拆分 "providerId + separator + modelId"。',
      '// 用首个分隔符切分：modelId 本身可以包含分隔符（如 openrouter 的模型名）。',
      '// [失败路径] 没有分隔符时抛 NoSuchModelError，并提示正确格式。',
      '// 空 providerId/modelId 不在这里拦截，交由 getProvider/工厂判断。',
      '// [权衡] 不做 trim，避免改变调用方传入的 id 语义。',
    ],
  },
  {
    at: 322,
    expect: 'languageModel<KEY extends keyof PROVIDERS>(',
    text: [
      '// 语言模型入口：split -> getProvider -> 调工厂 -> 判空 -> 包中间件。',
      '// [失败路径] 工厂返回空视为 "该 provider 无此模型"，抛 NoSuchModelError。',
      '// 中间件在判空之后包装，避免对空模型做无意义处理。',
      '// 多个中间件由 wrapLanguageModel 内部按数组顺序组合。',
      '// 返回 V4；V3 provider 已在注册时适配。',
      '// 不做缓存，每次调用产生新的包装对象。',
    ],
  },
  {
    at: 362,
    expect: 'imageModel<KEY extends keyof PROVIDERS>(',
    text: [
      '// 图像模型入口：与语言模型同构，但中间件是 imageModelMiddleware。',
      '// 判空在前、包装在后，保证错误信息指向原始 id。',
      '// 图像中间件只影响 imageModel，不影响 videoModel 等其它视觉能力。',
      '// 返回 V4 实例。',
    ],
  },
  {
    at: 447,
    expect: 'decisionModel<KEY extends keyof PROVIDERS>(',
    text: [
      '// 决策模型入口：取工厂（decisionModel 优先，evaluationModel 回退）。',
      '// 用 factory.call(provider, modelId) 而非直接调用，确保 this 正确。',
      '// 结果交给 resolveDecisionModel：可能返回字符串 id 对应的模型实例。',
      '// [失败路径] 工厂缺失或返回空 -> NoSuchModelError。',
      '// 与注册时的 bind 不同，这里保留原始 receiver，兼容未适配 provider。',
    ],
  },
  {
    at: 471,
    expect: 'files<KEY extends keyof PROVIDERS>(id: KEY & string): FilesV4 {',
    text: [
      '// files/skills 只按 providerId 取，不分模型。',
      '// 复用 getProvider 的 languageModel 错误类型，提示 provider 不存在。',
      '// [失败路径] provider 未实现 files()/skills() 时抛普通 Error。',
      '// 刻意区分：能力缺失是 provider 级问题，不是模型 id 问题。',
    ],
  },
]);

apply('packages/ai/src/rerank/rerank.ts', [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// 重排序入口 rerank：用 reranking 模型给 "query-document" 对打分并排序。',
      '// 链路位置：rerank -> resolveRerankingModel -> doRerank -> validateRankingIndices',
      '//   -> onEnd/telemetry -> DefaultRerankResult（附带 rerankedDocuments 投影）。',
      '// 空文档是合法输入：不发模型调用，直接返回空 ranking 并照常发 start/end 事件。',
      '// ============================================================================',
    ],
  },
  {
    at: 177,
    expect: 'if (documents.length === 0) {',
    text: [
      '// 空输入短路：仍然发 start/end，保证 telemetry 事件成对出现。',
      '// 不调用模型，也不进入 tracing span（没有实际工作可追踪）。',
      '// [权衡] 返回空结果而不是抛错，符合 "0 个文档 -> 0 条排序" 的直觉。',
    ],
  },
  {
    at: 231,
    expect: 'const documentsToSend:',
    text: [
      '// 统一文档形态：同一次调用只允许全 string 或全 JSONObject，由首元素决定。',
      '// [失败路径] 混合类型不会被这里拦截，provider 会因 schema 不符报错。',
    ],
  },
  {
    at: 308,
    expect: 'validateRankingIndices({ ranking, documents });',
    text: [
      '// 校验 provider 返回的下标：必须是 [0, documents.length) 的整数。',
      '// [失败路径] 越界或非整数抛 InvalidResponseDataError，避免下游拿到 undefined 文档。',
    ],
  },
]);

apply('packages/ai/src/generate-speech/generate-speech.ts', [
  {
    at: 1,
    expect: 'import type { JSONObject }',
    text: [
      '// ============================================================================',
      '// 语音合成入口 generateSpeech：单次 doGenerate，产出 GeneratedAudioFile。',
      '// 链路位置：generateSpeech -> resolveSpeechModel -> retry(doGenerate) -> 空音频检查',
      '//   -> mediaType 推断 -> DefaultSpeechResult。',
      '// 与 streamSpeech 的分工：本文件是非流式一次性结果，适合短文本。',
      '// ============================================================================',
    ],
  },
  {
    at: 209,
    expect: 'if (!result.audio || result.audio.length === 0) {',
    text: [
      '// 空音频视为失败：与 generateImage 不同，这里不重试，直接报 NoSpeechGeneratedError。',
      '// [失败路径] 错误带上 response，便于定位是 provider 空响应还是格式问题。',
    ],
  },
  {
    at: 219,
    expect: 'const detectedMediaType = detectMediaType({',
    text: [
      '// mediaType 三级推断：字节嗅探 > Content-Type > outputFormat 映射 > audio/mp3 兜底。',
      '// 嗅探优先，因为响应头可能缺失或被错误标注。',
      '// [权衡] outputFormat 只映射 pcm/mulaw/alaw/l16 等嗅探不出的格式。',
    ],
  },
  {
    at: 224,
    expect: 'const audio = new DefaultGeneratedAudioFile({',
    text: ['// 包装为 GeneratedAudioFile：统一暴露 uint8Array/base64/mediaType/format。'],
  },
]);
