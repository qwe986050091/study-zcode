import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';

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

apply('packages/ai/src/util/fix-json.ts', [
  {
    at: 1,
    expect: 'type State =',
    text: [
      '// ============================================================================',
      '// 部分 JSON 修复器 fixJson：对流式生成中 "尚未闭合" 的 JSON 做单遍线性扫描并补齐。',
      '// 链路位置：streamObject / streamText(output) 的 parsePartialJson -> fixJson -> JSON.parse。',
      '// 设计前提：输入只可能 "不完整"，不会 "非法"；真正的语法错误留给 JSON.parse。',
      '// 实现方式：状态栈 + lastValidIndex（最后一个可安全截断的位置），',
      '//   扫描结束后按栈内未闭合状态补引号/括号/字面量。',
      '// 不变量：INV-01 返回串必须是 input 的前缀 + 合法补齐（守住 386 的 slice）；',
      '//   INV-02 不修改已完整解析的前缀（守住 lastValidIndex 只增不减）；',
      '//   INV-03 字符串内的括号/逗号不得改变栈（守住 205-224）。',
      '// ============================================================================',
    ],
  },
  {
    at: 28,
    expect: 'export function fixJson(input: string): string {',
    text: [
      '// 入口：返回 "可 parse 的最长前缀 + 补齐"；调用方应再交给 JSON.parse 判合法性。',
      '// 复杂度 O(n)，无回溯；栈深度与 JSON 嵌套深度一致。',
      '// [资源] 只分配一个 result 字符串，适合每个 delta 调用一次。',
    ],
  },
  {
    at: 29,
    expect: "const stack: State[] = ['ROOT'];",
    text: ['// 状态栈：栈顶是当前状态，栈底固定为 ROOT，FINISH 表示已完整消费一个顶层值。'],
  },
  {
    at: 30,
    expect: 'let lastValidIndex = -1;',
    text: [
      '// 最后一个 "可安全截断" 的下标：截到这里再补齐，得到的一定是完整 JSON 前缀。',
      '// 数字/字符串/字面量的中间位置不会更新它，避免把半个 token 当成完整值。',
      '// 初值 -1 表示还没有任何可提交内容。',
    ],
  },
  {
    at: 31,
    expect: 'let literalStart: number | null = null;',
    text: ['// 字面量起点（true/false/null），用于结束时判断还缺哪些字符。'],
  },
  {
    at: 32,
    expect: 'let unicodeEscapeDigits = 0;',
    text: ['// \\uXXXX 已读到的十六进制位数；不足 4 位时不能算作合法转义。'],
  },
  {
    at: 34,
    expect: 'function isHexDigit(char: string) {',
    text: ['// 十六进制判定用比较而非正则：热路径上避免创建 RegExp 与字符串分配。'],
  },
  {
    at: 42,
    expect: 'function processValueStart(char: string, i: number, swapState: State) {',
    text: [
      '// 值起始分派：按首字符决定入栈的新状态，swapState 是 "值结束后应回到的状态"。',
      '// [事务] 先 pop 再 push(swapState)，把 "当前容器" 替换为 "等待值完成" 的状态。',
      '// 这里只处理合法起始字符；其它字符直接忽略，交由 JSON.parse 兜底。',
    ],
  },
  {
    at: 45,
    expect: "case '\"': {",
    text: ['// 字符串起始：记录位置并进入 INSIDE_STRING，swapState 留在栈中。'],
  },
  {
    at: 53,
    expect: "case 'f':",
    text: [
      '// true/false/null：记录 literalStart，结束时要按已读前缀补齐剩余字符。',
      '// [失败路径] 若后续字符不构成任何字面量前缀，会回退到容器状态（见 362）。',
      '// 三种字面量共用同一状态，靠前缀比较区分。',
    ],
  },
  {
    at: 64,
    expect: "case '-': {",
    text: ['// 负号不更新 lastValidIndex：单独的 "-" 不是完整数字，截断时会被丢弃。'],
  },
  {
    at: 87,
    expect: "case '{': {",
    text: ['// 对象开始：入栈 INSIDE_OBJECT_START，等待 key 或 }。'],
  },
  {
    at: 95,
    expect: "case '[': {",
    text: ['// 数组开始：入栈 INSIDE_ARRAY_START，等待 ] 或第一个值。'],
  },
  {
    at: 106,
    expect: 'function processAfterObjectValue(char: string, i: number) {',
    text: [
      '// 对象值结束后：逗号 -> 期待下一个 key；} -> 弹出对象容器。',
      '// 其它字符（如多余空白）被忽略，不改变状态。',
      '// 该函数在数字/字面量状态结束时也会被复用。',
    ],
  },
  {
    at: 121,
    expect: 'function processAfterArrayValue(char: string, i: number) {',
    text: ['// 数组值结束后：逗号 -> 期待下一个值；] -> 弹出数组容器。'],
  },
  {
    at: 136,
    expect: 'for (let i = 0; i < input.length; i++) {',
    text: [
      '// 主扫描：逐字符更新状态栈与 lastValidIndex。',
      '// 每一轮只读栈顶，因此天然支持任意嵌套，不需要递归。',
      '// [权衡] 单字符 switch 比正则/递归下降更啰嗦，但没有回溯、可中断、易审计。',
      '// 注意：这里不校验字符合法性，非法输入由最终 JSON.parse 负责报错。',
    ],
  },
  {
    at: 141,
    expect: "case 'ROOT':",
    text: ['// ROOT：只接受一个顶层值，完成后进入 FINISH。'],
  },
  {
    at: 145,
    expect: "case 'INSIDE_OBJECT_START': {",
    text: [
      '// 对象起始：第一个非空字符必须是引号或 }；其它字符被忽略。',
      '// [失败路径] 若模型输出的是 "{" 后直接结束，结束时由栈补齐为 {}。',
      '// 不在这里校验 key 的合法性，交给 JSON.parse。',
    ],
  },
  {
    at: 161,
    expect: "case 'INSIDE_OBJECT_AFTER_COMMA': {",
    text: ['// 逗号后只接受 key 的引号；这能跳过逗号与引号之间的空白。'],
  },
  {
    at: 172,
    expect: "case 'INSIDE_OBJECT_KEY': {",
    text: ['// key 内部：遇到未转义的引号才结束 key 状态。'],
  },
  {
    at: 183,
    expect: "case 'INSIDE_OBJECT_AFTER_KEY': {",
    text: ['// key 结束后期望冒号，其它字符忽略。'],
  },
  {
    at: 195,
    expect: "case 'INSIDE_OBJECT_BEFORE_VALUE': {",
    text: ['// 冒号之后进入 "值起始"，swapState 为对象值结束后的状态。'],
  },
  {
    at: 200,
    expect: "case 'INSIDE_OBJECT_AFTER_VALUE': {",
    text: ['// 对象值结束：交给 processAfterObjectValue 处理逗号/右括号。'],
  },
  {
    at: 205,
    expect: "case 'INSIDE_STRING': {",
    text: [
      '// 字符串内部：只有未转义的引号才闭合；反斜杠进入转义状态；其余字符推进截断点。',
      '// INV-03：字符串里的 { } [ ] , 都只是普通字符，绝不能影响状态栈。',
      '// 这也是本扫描器不做 "按字符类型全局判断" 的原因。',
    ],
  },
  {
    at: 213,
    expect: "case '\\\\': {",
    text: ['// 反斜杠：进入转义状态，下一个字符单独处理。'],
  },
  {
    at: 218,
    expect: 'default: {',
    text: ['// 普通字符：字符串内容继续，更新可截断位置。'],
  },
  {
    at: 226,
    expect: "case 'INSIDE_ARRAY_START': {",
    text: ['// 数组起始：] 直接闭合；其它字符视为值的开始。'],
  },
  {
    at: 242,
    expect: "case 'INSIDE_ARRAY_AFTER_VALUE': {",
    text: ['// 数组值结束：逗号/] 改变状态，其它字符继续推进（用于跳过空白与数字后续位）。'],
  },
  {
    at: 265,
    expect: "case 'INSIDE_ARRAY_AFTER_COMMA': {",
    text: ['// 逗号后开始下一个值。'],
  },
  {
    at: 270,
    expect: "case 'INSIDE_STRING_ESCAPE': {",
    text: [
      '// 转义状态：u 进入四位十六进制；其它转义字符本身即完整，更新截断点。',
      '// [失败路径] 若反斜杠后直接结束，截断点会退回到转义前。',
      '// 这是刻意保守：半个转义序列无法安全补全。',
    ],
  },
  {
    at: 283,
    expect: "case 'INSIDE_STRING_UNICODE_ESCAPE': {",
    text: [
      '// \\uXXXX：必须读满 4 位十六进制才算完成；不足 4 位时保持该状态。',
      '// 非十六进制字符会终止计数，但栈仍停留在 UNICODE_ESCAPE，最终截断回退。',
      '// [权衡] 不做严格校验，避免把 "不完整" 误判成 "非法"。',
    ],
  },
  {
    at: 296,
    expect: "case 'INSIDE_NUMBER': {",
    text: [
      '// 数字内部：数字继续；e/E/-/. 允许但不推进截断点；分隔符结束数字。',
      '// 结束时若停在数字中间，slice 会回退到最后一个完整数字位。',
      '// [失败路径] 其它字符直接弹出数字状态，交给容器状态重新判断。',
    ],
  },
  {
    at: 319,
    expect: "case ',': {",
    text: [
      '// 逗号：先弹出数字状态，再根据下层容器决定是数组还是对象的分隔符。',
      '// 这里的 "偷看下层" 让数字状态无需知道自己身处何种容器。',
      '// 两条 if 互斥，因为栈顶只可能是其中一种。',
    ],
  },
  {
    at: 333,
    expect: "case '}': {",
    text: ['// }：数字后直接遇到对象结束，弹出数字并交给对象值结束处理。'],
  },
  {
    at: 343,
    expect: "case ']': {",
    text: ['// ]：数字后直接遇到数组结束，弹出数字并交给数组值结束处理。'],
  },
  {
    at: 353,
    expect: 'default: {',
    text: ['// 非数字字符：结束数字状态；该字符会在下一轮由容器状态重新处理。'],
  },
  {
    at: 362,
    expect: "case 'INSIDE_LITERAL': {",
    text: [
      '// 字面量：按已读前缀与 true/false/null 比较。',
      '// 若不再是任何字面量的前缀，说明字面量已结束（或非法），弹出状态并交给容器。',
      '// [失败路径] 非法字面量不会被修正，最终由 JSON.parse 报错。',
    ],
  },
  {
    at: 386,
    expect: 'let result = input.slice(0, lastValidIndex + 1);',
    text: [
      '// 截断到最后可安全位置：此后的半个 token 全部丢弃，避免拼出非法 JSON。',
      '// INV-01：返回值一定以 input 的前缀开头，不会插入原输入中不存在的内容。',
      '// lastValidIndex 为 -1 时得到空串，随后由补齐逻辑生成最小合法结构。',
    ],
  },
  {
    at: 388,
    expect: 'for (let i = stack.length - 1; i >= 0; i--) {',
    text: [
      '// 自栈顶向下补齐：每个未闭合容器补一个右括号，顺序与嵌套相反。',
      '// 之所以从顶到底，是因为 result 末尾需要先闭合最内层。',
      '// 补齐只追加字符，不回溯修改已有内容。',
    ],
  },
  {
    at: 392,
    expect: "case 'INSIDE_STRING': {",
    text: ['// 未闭合字符串补引号；这是唯一需要插在括号之前的补齐。'],
  },
  {
    at: 397,
    expect: "case 'INSIDE_OBJECT_KEY':",
    text: [
      '// 所有 "对象内部" 状态都补 }，包括 AFTER_KEY/BEFORE_VALUE 等半截状态。',
      '// [权衡] 不尝试补缺失的值（如 null），因为那会改变语义；交由 JSON.parse 判非法。',
      '// 多个未闭合对象会连续补多个 }，与栈深度一致。',
    ],
  },
  {
    at: 407,
    expect: "case 'INSIDE_ARRAY_START':",
    text: ['// 未闭合数组补 ]；ARRAY_AFTER_COMMA 也补，得到除尾随逗号外的合法结构。'],
  },
  {
    at: 414,
    expect: "case 'INSIDE_LITERAL': {",
    text: [
      '// 未闭合字面量：按已读前缀补足 true/false/null。',
      '// 例如 "tru" -> "true"；前缀不在任何字面量路径上时不补。',
      '// [失败路径] 该分支只处理 "输入在字面量中间结束" 的情况。',
    ],
  },
]);

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
      '// 若 provider 没有 videoModel，则退化为 never，任何 id 都不匹配。',
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
    at: 61,
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
