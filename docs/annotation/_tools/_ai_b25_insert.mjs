// B25 insert: decide chain validation, orchestration and small type modules
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/ai/src/decide/';
const files = [
  {
    name: 'validate-decision.ts',
    want: [93, 93],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// validate-decision：决策输入与模型答案的双向校验',
          '// 输入侧拦 JSON 不可序列化形态，答案侧拦概率、均值与键集合。',
          '// 校验只读，不修复、不归一化供应商输出。',
        ],
      },
      {
        at: 9,
        expect: '// Absolute tolerance for sums and means. Never renormalize provider output.',
        lines: [
          '// 容差用于浮点求和与加权均值；超过容差即拒绝，而不是把概率重新缩放。',
        ],
      },
      {
        at: 12,
        expect: 'function isRecord(value: unknown): value is Record<string, unknown> {',
        lines: [
          '// 只接受普通对象与 null 原型对象；数组、类实例、Map 都不算 record，',
          '// 这样后续 Object.keys 的行为才是可预测的。',
          '// [权衡] 不递归校验原型链，嵌套值交给 isSerializableJSON。',
        ],
      },
      {
        at: 24,
        expect: 'function isSerializableJSON(',
        lines: [
          '// 检查 JSON.stringify 会静默改写或直接抛错的形态：',
          '// 非有限数、循环引用、稀疏数组。ancestors 只记录当前路径，',
          '// 因此同一对象被多处引用不会被误判为循环。',
        ],
      },
      {
        at: 28,
        expect: "if (typeof value === 'number') return Number.isFinite(value);",
        lines: [
          '// NaN 与 Infinity 会被序列化成 null，必须在校验阶段拒绝。',
        ],
      },
      {
        at: 30,
        expect: 'if (ancestors.has(value)) return false;',
        lines: [
          '// 命中祖先集合即为环；回溯时删除，保证兄弟节点可复用同一引用。',
        ],
      },
      {
        at: 32,
        expect: 'const valid = Array.isArray(value)',
        lines: [
          '// 稀疏数组用 keys 加 in 检查空洞，Object.values 会跳过空洞导致漏判。',
        ],
      },
      {
        at: 41,
        expect: 'function invalidInput(',
        lines: [
          '// 输入错误统一带 parameter 与原始 value，便于调用方定位字段。',
        ],
      },
      {
        at: 49,
        expect: 'export function validateDecisionInput({',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 state 中的 JSON 必须可序列化，数组形态还要拒绝空洞。',
          '// INV-02 questions 非空，且每题的 instructions/criteria 可序列化。',
          '// INV-03 choice 的 criteria 非空，score 的等级至少一级。',
          '// INV-04 boolean 允许仅 criteria，但 criteria 只能描述 true/false。',
          '// 守住位置：INV-01 在入口，INV-02 在循环前，INV-03/04 在 switch。',
        ],
      },
      {
        at: 56,
        expect: 'if (',
        lines: [
          '// 数组空洞在 JSON 里会变成 null，先于序列化检查单独拦截。',
          '// 只有 parts 形态需要检查空洞，字符串与对象不受影响。',
          '// 该分支不修改 state，只读取键集合。',
        ],
      },
      {
        at: 63,
        expect: 'const stateJSON = Array.isArray(state)',
        lines: [
          '// parts 形态只把 json 部件的 value 送去序列化检查；',
          '// text/file 部件可能含二进制，不参与 JSON 约束。',
          '// 对象与字符串形态直接作为整体检查。',
        ],
      },
      {
        at: 74,
        expect: 'if (Object.keys(questions).length === 0) {',
        lines: [
          '// 空问题映射没有决策意义，提前拒绝而不是发出空请求。',
        ],
      },
      {
        at: 78,
        expect: 'for (const [id, question] of Object.entries(questions)) {',
        lines: [
          '// 错误参数名带问题 id，便于在多题请求中定位到具体一题。',
        ],
      },
      {
        at: 80,
        expect: 'if (',
        lines: [
          '// instructions 与 criteria 都会进入 provider，必须先保证可序列化。',
        ],
      },
      {
        at: 90,
        expect: 'switch (question.type) {',
        lines: [
          '// 每种题型有自己的输入约束，box 没有额外输入要求。',
        ],
      },
      {
        at: 92,
        expect: 'if (Object.keys(question.criteria).length === 0) {',
        lines: [
          '// choice 至少要有可选选项，否则模型无法作答。',
        ],
      },
      {
        at: 101,
        expect: 'if (question.criteria.length === 0) {',
        lines: [
          '// score 的 criteria 是有序等级，空数组会让分值范围变成负数。',
        ],
      },
      {
        at: 109,
        expect: "case 'boolean': {",
        lines: [
          '// boolean 题没有 criteria 时允许，但必须提供 instructions。',
        ],
      },
      {
        at: 122,
        expect: 'if (',
        lines: [
          '// 即使提供了 criteria，也只能出现 true 与 false 两个键。',
        ],
      },
      {
        at: 138,
        expect: 'function invalidAnswer(answers: unknown, message: string): never {',
        lines: [
          '// 答案错误统一携带完整 answers，方便回放模型原始输出。',
        ],
      },
      {
        at: 142,
        expect: 'function isProbability(value: unknown): value is number {',
        lines: [
          '// 概率必须是有限数且落在闭区间 [0, 1]；',
          '// 该判定同时用于 choice、score 分布与 boolean。',
          '// NaN 会被 Number.isFinite 直接排除。',
        ],
      },
      {
        at: 151,
        expect: 'function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {',
        lines: [
          '// 键数量相等且每个键都存在，等价于键集合完全一致。',
        ],
      },
      {
        at: 158,
        expect: 'function validateDistribution(',
        lines: [
          '// 断言签名让调用方在通过后可直接把值当 Record<string, number> 使用。',
          '// 校验三件事：是 record、键集合完全匹配、每个值都是概率。',
          '// 分布缺项与多项都会被 hasExactKeys 拒绝。',
          '// roundingError 按题目的舍入精度放宽总和判定。',
        ],
      },
      {
        at: 175,
        expect: 'const sum = Object.values(value).reduce<number>(',
        lines: [
          '// 求和只用于校验，不写回 value；供应商输出保持原样。',
        ],
      },
      {
        at: 179,
        expect: 'if (Math.abs(sum - 1) > tolerance + keys.length * roundingError) {',
        lines: [
          '// 容差随选项数量线性放大：每个概率都可能带半个最低位的误差。',
        ],
      },
      {
        at: 187,
        expect: 'export function validateDecisionAnswers({',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 每个问题恰好一个答案，不多不少。',
          '// INV-02 refusal 先放行，由调用方统一转成拒绝错误。',
          '// INV-03 答案 type 必须与问题 type 一致。',
          '// INV-04 概率、均值与框边界都在声明精度内自洽。',
        ],
      },
      {
        at: 196,
        expect: 'function roundingError(decimals: number | undefined): number {',
        lines: [
          '// 未声明精度时容差为 0，避免无意放宽校验。',
        ],
      },
      {
        at: 206,
        expect: 'const probabilityError = roundingError(rounding?.probabilityDecimals);',
        lines: [
          '// 概率与分值各自使用自己的舍入精度，互不替代。',
        ],
      },
      {
        at: 208,
        expect: 'if (!isRecord(answers) || !hasExactKeys(answers, Object.keys(questions))) {',
        lines: [
          '// 答案键集合必须与问题键集合完全一致，缺题与多题都拒绝。',
        ],
      },
      {
        at: 215,
        expect: 'for (const [id, question] of Object.entries(questions)) {',
        lines: [
          '// 逐题校验，错误信息带题目 id。',
        ],
      },
      {
        at: 217,
        expect: "if (isRecord(answer) && answer.type === 'refusal') continue;",
        lines: [
          '// refusal 是合法答案形态，先跳过结构校验。',
        ],
      },
      {
        at: 225,
        expect: 'switch (question.type) {',
        lines: [
          '// 分派到各题型的专属校验。',
        ],
      },
      {
        at: 227,
        expect: 'if (',
        lines: [
          '// choice 必须落在 criteria 的键内，概率分布可选。',
        ],
      },
      {
        at: 236,
        expect: 'if (answer.probabilities !== undefined) {',
        lines: [
          '// 分布完整后，被选中的选项还必须是概率最高者（含容差）。',
        ],
      },
      {
        at: 259,
        expect: "case 'score': {",
        lines: [
          '// score 必须落在等级索引范围内，概率分布可选。',
        ],
      },
      {
        at: 271,
        expect: 'if (answer.probabilities !== undefined) {',
        lines: [
          '// 有分布时，score 必须等于分布的期望值。',
        ],
      },
      {
        at: 280,
        expect: 'const mean = Object.entries(answer.probabilities).reduce(',
        lines: [
          '// 期望值按等级索引加权求和；误差也按同样权重累加。',
        ],
      },
      {
        at: 301,
        expect: "case 'box': {",
        lines: [
          '// 框选答案要求四边都是概率，且 left < right、top < bottom；',
          '// 不校验面积或中心点，这些属于业务层语义。',
        ],
      },
      {
        at: 320,
        expect: "case 'boolean':",
        lines: [
          '// boolean 只要求 P(true) 是合法概率。',
        ],
      },
      {
        at: 60,
        expect: "invalidInput('state', state, 'state parts must not contain array holes');",
        lines: [
          '// 稀疏数组在 JSON 序列化时会变成 null，模型无法区分「空位」与「空值」，',
          '// 所以在进入 provider 前就必须拒绝，而不是等下游解析失败。',
          '// 该检查只针对数组形态的 state；对象与字符串没有空洞概念。',
          '// [失败路径] 错误抛出后不会再触发任何模型调用与遥测。',
          '// parameter 固定为 state，便于调用方把错误映射到表单字段。',
          '// value 原样回传，便于上层打印完整输入。',
          '// 该分支严格只读，不修复数组。',
        ],
      },
      {
        at: 93,
        expect: 'invalidInput(',
        lines: [
          '// choice 的 criteria 是选项映射：键是选项 id，值是描述文本。',
          '// 空映射意味着模型没有任何可选项，属于无效问题。',
          '// 这里只检查数量，不检查描述是否为空字符串，语义由业务层决定。',
          '// [权衡] 允许描述为任意可序列化值，保持与 provider 协议一致。',
          '// 选项顺序沿用对象键顺序，与 prepare-tools 的排序策略无关。',
          '// 该校验不读取 instructions，二者相互独立。',
          '// 错误参数名会带具体问题 id。',
        ],
      },
      {
        at: 164,
        expect: '): asserts value is Record<string, number> {',
        lines: [
          '// 分布校验是 choice 与 score 共用的核心：键必须与预期集合完全一致。',
          '// 值必须是有限概率，NaN、Infinity、负数与大于 1 都会被拒绝。',
          '// 总和允许 tolerance 加每个键的舍入误差，避免浮点求和误伤。',
          '// 这里不做归一化，供应商输出多少就是多少，只判断是否可接受。',
          '// asserts 签名让 TypeScript 在调用后收窄类型，无需二次断言。',
          '// answers 只用于错误载荷，不参与校验逻辑。',
          '// id 只用于拼接错误信息，帮助定位到具体问题。',
        ],
      },
      {
        at: 219,
        expect: 'invalidAnswer(',
        lines: [
          '// refusal 已在前一行放行，走到这里说明答案结构不合法。',
          '// 类型不一致是最常见的模型错误：例如 choice 题返回了 boolean 答案。',
          '// 该错误携带完整 answers，便于记录模型原始输出。',
          '// 校验失败不会尝试猜测或转换答案，直接拒绝。',
          '// 每个问题只校验一次，错误信息带问题 id。',
          '// 通过类型检查后才进入各题型的字段校验。',
          '// 该分支不产生任何副作用。',
        ],
      },
    ],
  },
  {
    name: 'decide.ts',
    want: [54, 54],
    blocks: [
      {
        at: 1,
        expect: 'import {',
        lines: [
          '// ============================================================================',
          '// decide：对一组带类型的问题做一次决策调用的编排层',
          '// 负责参数校验、模型能力检查、重试、遥测、答案校验与结果整形。',
          '// 实际推理全部委托给 DecisionModelV4.doDecide。',
        ],
      },
      {
        at: 30,
        expect: 'const originalGenerateCallId = createIdGenerator({',
        lines: [
          '// 默认 call id 用于把一次 decide 的 start/end/error 串起来；',
          '// _internal 允许测试注入确定性 id。',
        ],
      },
      {
        at: 36,
        expect: 'export async function decide<',
        lines: [
          '// 不变量（守住它的位置）：',
          '// INV-01 输入校验与能力检查都在模型调用之前完成。',
          '// INV-02 state 预处理只做一次，所有重试复用同一份 preparedState。',
          '// INV-03 答案先校验、再检查 refusal，最后才发 onEnd。',
          '// INV-04 任何失败都经过遥测 onError 后原样抛出。',
        ],
      },
      {
        at: 81,
        expect: 'const model = resolveDecisionModel(modelArg);',
        lines: [
          '// 字符串模型 id 在这里解析成实例，后续只面对统一接口。',
        ],
      },
      {
        at: 83,
        expect: 'prepareLanguageModelCallOptions({ maxOutputTokens });',
        lines: [
          '// 通用调用参数先校验，避免在输入错误上浪费一次模型请求。',
        ],
      },
      {
        at: 84,
        expect: 'validateDecisionInput({ state, questions });',
        lines: [
          '// 输入不可序列化会在这里被拒绝，不会发到 provider。',
        ],
      },
      {
        at: 86,
        expect: 'for (const [questionId, question] of Object.entries(questions)) {',
        lines: [
          '// 模型能力检查放在调用前，unsupported 错误带 provider/model 定位。',
        ],
      },
      {
        at: 97,
        expect: 'const callId = generateCallId();',
        lines: [
          '// 一次 decide 只生成一个 callId，重试共用。',
        ],
      },
      {
        at: 98,
        expect: 'const { maxRetries: resolvedMaxRetries, retry } = prepareRetries({',
        lines: [
          '// 重试器统一处理瞬时失败与 abortSignal。',
        ],
      },
      {
        at: 102,
        expect: 'const telemetryDispatcher = createRestrictedTelemetryDispatcher({',
        lines: [
          '// 受限分发器只暴露 decide 相关回调，避免误用其它操作的遥测。',
        ],
      },
      {
        at: 105,
        expect: 'const runInTracingChannelSpan =',
        lines: [
          '// 没有 tracing channel 时退化为直接执行，调用方无感知。',
        ],
      },
      {
        at: 109,
        expect: 'const startEvent = {',
        lines: [
          '// 事件在调用前快照输入，之后不再重读 state/questions，保证一致性。',
        ],
      },
      {
        at: 123,
        expect: 'return await runInTracingChannelSpan({',
        lines: [
          '// 整个 decide 包在 span 内，包括开始通知与最终结果。',
        ],
      },
      {
        at: 127,
        expect: 'await notify({',
        lines: [
          '// onStart 与遥测回调合并通知，用户回调失败不会阻断调用。',
        ],
      },
      {
        at: 132,
        expect: 'try {',
        lines: [
          '// 进入主流程；所有异常都会落到 catch 并经过 onError。',
        ],
      },
      {
        at: 133,
        expect: 'const preparedState = await prepareDecisionState(state, abortSignal);',
        lines: [
          '// 状态预处理可能下载文件，因此接受 abortSignal；',
          '// 结果在重试之间复用，避免重复 IO。',
        ],
      },
      {
        at: 142,
        expect: 'await notify({',
        lines: [
          '// 模型调用开始遥测先于 doDecide，便于观测真实耗时。',
        ],
      },
      {
        at: 148,
        expect: 'const result = await retry(async () => {',
        lines: [
          '// 重试只包住 doDecide；每次尝试都重新检查取消并补 UA 头。',
        ],
      },
      {
        at: 161,
        expect: 'abortSignal?.throwIfAborted();',
        lines: [
          '// 模型返回后再次检查取消，防止已取消请求继续进入校验。',
        ],
      },
      {
        at: 162,
        expect: 'validateDecisionAnswers({',
        lines: [
          '// 答案形状、概率与均值都在这里校验，失败视为无效响应。',
        ],
      },
      {
        at: 167,
        expect: 'const refusedQuestionIds = Object.keys(questions).filter(',
        lines: [
          '// refusal 是合法答案但不是成功结果，收集后统一抛错。',
        ],
      },
      {
        at: 177,
        expect: 'await notify({',
        lines: [
          '// 模型调用结束遥测携带原始结果，供集成记录用量与警告。',
        ],
      },
      {
        at: 182,
        expect: 'logWarnings({',
        lines: [
          '// 警告只记录不抛出，保持调用可继续。',
        ],
      },
      {
        at: 188,
        expect: 'const inputTokens = result.usage?.inputTokens;',
        lines: [
          '// usage 字段可能缺失，先取局部变量再统一整形。',
        ],
      },
      {
        at: 190,
        expect: 'const decisionResult: DecisionResult<QUESTIONS> = {',
        lines: [
          '// totalTokens 只在输入输出都存在时计算，避免伪造部分总量；',
          '// response 补默认 timestamp 与 modelId，保证返回结构稳定。',
        ],
      },
      {
        at: 210,
        expect: 'await notify({',
        lines: [
          '// onEnd 最后发出，此时结果已完整且校验通过。',
        ],
      },
      {
        at: 216,
        expect: '} catch (error) {',
        lines: [
          '// 错误遥测失败也不能覆盖原始错误，因此先 await 再原样 throw。',
        ],
      },
      {
        at: 55,
        expect: '/** A decision model instance or an ID resolved by the configured default provider. */',
        lines: [
          '// model 既可以是实例，也可以是交给默认 provider 解析的字符串 id；',
          '// 解析发生在函数体第一行，之后不再接受字符串形态。',
          '// 该参数必填，没有全局默认模型兜底。',
          '// 传入的实例必须实现 supportedQuestionTypes 与 doDecide。',
          '// [失败路径] 无法解析时由 resolveDecisionModel 抛 NoSuchModelError。',
          '// provider 与 modelId 会写入所有事件，便于按模型维度聚合。',
          '// 类型层面与 DecisionModel 别名保持一致。',
        ],
      },
      {
        at: 145,
        expect: 'telemetryDispatcher.experimental_onDecisionModelCallStart,',
        lines: [
          '// 只通知模型调用开始，不触发通用 onStart；',
          '// 受限分发器已把 decide 专用回调裁剪出来。',
          '// 该通知失败不会阻止 doDecide 执行。',
          '// 事件中的 state 是预处理后的 provider 形态。',
          '// questions 保持用户传入的原始结构。',
        ],
      },
      {
        at: 198,
        expect: ': undefined,',
        lines: [
          '// totalTokens 是派生字段：只有输入与输出都存在时才相加，',
          '// 任一缺失都返回 undefined，避免把未知量当成 0。',
          '// 该规则与语言模型 generateText 的 usage 整形保持一致。',
          '// 不修改 provider 返回的 usage 对象。',
          '// 消费方需自行处理 undefined。',
        ],
      },
    ],
  },
  {
    name: 'decision-state.ts',
    want: [17, 17],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// decision-state：把三种决策状态输入归一成 provider 的 V4 state',
          '// 字符串与普通对象直接包装，parts 形态只在含文件时才做转换。',
          '// 文件转换复用语言模型的 prompt 管线，避免两套 URL/下载逻辑。',
          '// 返回值形状与 Experimental_DecisionModelV4State 完全一致。',
        ],
      },
      {
        at: 10,
        expect: 'export type DecisionState =',
        lines: [
          '// 共享状态可以是纯文本、JSON 对象或多模态部件数组。',
        ],
      },
      {
        at: 15,
        expect: 'export type DecisionStatePart =',
        lines: [
          '// 部件类型与语言模型 prompt 对齐，额外增加 json 载体。',
        ],
      },
      {
        at: 20,
        expect: 'function isDecisionStateParts(',
        lines: [
          '// 数组即 parts，判定足够简单，不需要逐项嗅探。',
        ],
      },
      {
        at: 26,
        expect: 'export async function prepareDecisionState(',
        lines: [
          '// 字符串包装为单个 text 部件；',
          '// 非 parts 的 JSON 对象包装为单个 json 部件；',
          '// parts 不含文件时原样返回，避免无谓复制；',
          '// 含文件时才进入异步转换路径。',
          '// [资源] 只有 file 部件会触发网络或 IO，纯文本状态是纯同步开销。',
        ],
      },
      {
        at: 44,
        expect: "const files = state.filter((part): part is FilePart => part.type === 'file');",
        lines: [
          '// 只收集 file 部件，text/json 部件在转换后按原位置回填。',
        ],
      },
      {
        at: 46,
        expect: 'const prompt = await convertToLanguageModelPrompt({',
        lines: [
          '// 复用统一 prompt 转换：data URL、下载与 mediaType 推断都在其中；',
          '// supportedUrls 传空对象，禁止 provider 直接引用远程 URL。',
        ],
      },
      {
        at: 55,
        expect: 'const message = prompt[0];',
        lines: [
          '// 只有一条 user 消息，fileIndex 按出现顺序回填。',
        ],
      },
    ],
  },
  {
    name: 'index.ts',
    want: [6, 6],
    blocks: [
      {
        at: 1,
        expect: 'import type { Context } from \'@ai-sdk/provider-utils\';',
        lines: [
          '// ============================================================================',
          '// decide/index：决策能力的公开出口与旧命名兼容层',
          '// 新代码使用 experimental_decide 与 Experimental_Decision* 类型。',
        ],
      },
      {
        at: 29,
        expect: '/** @deprecated Use `experimental_decide` instead. */',
        lines: [
          '// evaluate 旧名保留为同一函数的别名，行为完全一致。',
        ],
      },
      {
        at: 32,
        expect: '/** @deprecated Use `Experimental_DecideStartEvent` instead. */',
        lines: [
          '// 旧事件类型只是新类型的 type alias，不产生运行时代码。',
        ],
      },
      {
        at: 65,
        expect: 'export type {',
        lines: [
          '// state 类型从实现模块再导出，保持对外命名空间集中。',
        ],
      },
    ],
  },
  {
    name: 'restricted-telemetry-dispatcher.ts',
    want: [14, 14],
    blocks: [
      {
        at: 1,
        expect: 'import type { Context } from \'@ai-sdk/provider-utils\';',
        lines: [
          '// ============================================================================',
          '// restricted-telemetry-dispatcher：把通用遥测分发器裁剪成 decide 专用视图',
          '// 用 decide 事件重新命名 onStart/onEnd，并在此过滤 runtimeContext。',
          '// [权衡] 不新建分发逻辑，只做适配，保证遥测行为与其它操作一致。',
          '// 该文件不读取 telemetry 之外的状态，可安全并发调用。',
        ],
      },
      {
        at: 9,
        expect: 'export function createRestrictedTelemetryDispatcher<',
        lines: [
          '// 返回类型用 Omit 去掉通用 onStart/onEnd 与 decide 专用别名，',
          '// 再补上 decide 事件签名的 onStart/onEnd；',
          '// 这样调用方只能拿到与 decide 生命周期匹配的回调。',
          '// 其余字段（runInTracingChannelSpan 等）原样透传。',
          '// 返回对象每次调用新建，不与其它 decide 调用共享。',
        ],
      },
      {
        at: 25,
        expect: 'const dispatcher = createTelemetryDispatcher({ telemetry });',
        lines: [
          '// 复用通用分发器，包括禁用判断与 integration 合并。',
        ],
      },
      {
        at: 27,
        expect: 'return {',
        lines: [
          '// 展开在前，后面的 onStart/onEnd 覆盖同名通用回调。',
        ],
      },
      {
        at: 29,
        expect: 'onStart: event =>',
        lines: [
          '// 开始事件按 includeRuntimeContext 规则过滤上下文。',
        ],
      },
      {
        at: 37,
        expect: 'onEnd: event =>',
        lines: [
          '// 结束事件使用同一过滤规则，保证首尾看到一致的上下文。',
        ],
      },
    ],
  },
  {
    name: 'decision-result.ts',
    want: [12, 12],
    blocks: [
      {
        at: 1,
        expect: 'import type {',
        lines: [
          '// ============================================================================',
          '// decision-result：决策调用对外的模型与结果类型',
          '// 这些类型只做编译期约束，不产生运行时校验。',
          '// 运行期校验在 validate-decision 中完成。',
        ],
      },
      {
        at: 8,
        expect: 'export type DecisionModel = string | DecisionModelV4 | EvaluationModelV4;',
        lines: [
          '// 字符串由 resolveDecisionModel 解析；旧 EvaluationModelV4 作为兼容分支。',
        ],
      },
      {
        at: 10,
        expect: 'export type DecisionAnswer<QUESTION extends DecisionQuestion> =',
        lines: [
          '// 条件类型按 question.type 推导答案形状：',
          '// choice 的键来自 criteria，score 允许可选分布，box 固定四边。',
        ],
      },
      {
        at: 26,
        expect: 'export type DecisionResult<QUESTIONS extends Record<string, DecisionQuestion>> =',
        lines: [
          '// usage 三个字段都可能是 undefined，由调用方决定如何展示；',
          '// response 在 provider 返回值基础上补齐 timestamp 与 modelId；',
          '// 所有字段只读，结果对象不应被消费方修改。',
          '// answers 的键与传入 questions 完全对应。',
          '// warnings/rounding/providerMetadata 直接沿用 provider 结果。',
        ],
      },
    ],
  },
  {
    name: 'decision-provider.ts',
    want: [1, 1],
    blocks: [
      {
        at: 6,
        expect: '/** Structural extension; decision is not part of the stable provider contract. */',
        lines: [
          '// decision 与 evaluation 都是结构化扩展：provider 按需实现，未实现的 provider 不会因此不兼容。',
        ],
      },
    ],
  },
];

let grand = 0;
for (const f of files) {
  if (f.name === 'validate-decision.ts' || f.name === 'decide.ts' || f.name === 'decision-state.ts' || f.name === 'index.ts' || f.name === 'restricted-telemetry-dispatcher.ts') {
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
