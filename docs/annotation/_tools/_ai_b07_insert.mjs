// AI-deep-b07：输出规范、工具审批校验、tool-caller 与并发执行。
import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

const plan = [
  {
    rel: 'packages/ai/src/generate-text/output.ts',
    edits: [
      {
        at: 24,
        expect: 'export interface Output<OUTPUT = any, PARTIAL = any, ELEMENT = any> {',
        text: [
          '// 输出规范（Output）是 generateText / streamText 的"结果形状插件"。',
          '//',
          '// 链路位置：调用方传入 output: Output.object({...})；框架据此',
          '// 1) 生成 responseFormat 发给 provider；2) 结束时 parseCompleteOutput；',
          '// 3) 流式过程中 parsePartialOutput 与 createElementStreamTransform。',
          '//',
          '// INV-01：responseFormat 是 PromiseLike 而不是值——schema 可能异步生成，',
          '// 但只能解析一次，重复 await 不应产生不同结果。',
          '// INV-02：parsePartialOutput 必须容忍不完整 JSON（返回 undefined 表示"暂时没有"），',
          '// 绝不能抛错：流式解析失败是常态。',
          '// INV-03：parseCompleteOutput 失败必须抛 NoObjectGeneratedError 并带上',
          '// 原始 text / response / usage，否则调用方无法诊断模型到底返回了什么。',
        ],
      },
      {
        at: 86,
        expect: 'type ValidatedSchema<SCHEMA> = 0 extends 1 & SCHEMA',
        text: [
          '// 用 0 extends 1 & SCHEMA 检测 any：any 与任何类型相交仍是 any，',
          '// 因此这个条件对显式 any 成立，对普通对象类型不成立。',
          '// 命中时返回 never，使重载回退到"从 schema 推断"的版本，保留向后兼容。',
        ],
      },
      {
        at: 126,
        expect: 'export function object<OBJECT>(',
        text: [
          '// 两个重载：第一个保留显式指定的输出类型，第二个从 schema 推断。',
          '// 实现签名故意用宽类型：具体推断由重载对调用方负责。',
        ],
      },
      {
        at: 145,
        expect: 'const schema = asSchema(inputSchema);',
        text: [
          '// 统一包装成 FlexibleSchema：调用方可能传 zod、valibot 或裸 JSON Schema。',
          '// jsonSchema 是 Promise：某些 schema 库需要异步转换，这里不提前 await，',
          '// 让 responseFormat 保持惰性，避免构造 Output 时就产生异步副作用。',
          '// 注意 asSchema 之后不再需要区分原始库类型，后续全部走统一接口。',
        ],
      },
      {
        at: 150,
        expect: 'responseFormat: resolve(schema.jsonSchema).then(jsonSchema => ({',
        text: [
          '// JSON 模式：把 schema 作为结构化输出约束发给 provider。',
          '// name / description 只在有值时展开：undefined 字段会让部分 provider 报错。',
          '// [权衡] 这里不做 schema 的本地校验，provider 未必严格遵守；',
          '// 真正的校验在 parseCompleteOutput 里完成。',
        ],
      },
      {
        at: 165,
        expect: 'const parseResult = await safeParseJSON({ text });',
        text: [
          '// 先解析再校验：两步分开报错，调用方才能区分"不是 JSON"与"不符合 schema"。',
        ],
      },
      {
        at: 178,
        expect: 'const validationResult = await safeValidateTypes({',
        text: [
          '// safeValidateTypes 不抛错，返回结果对象：便于统一包装成领域错误。',
        ],
      },
      {
        at: 197,
        expect: 'async parsePartialOutput({ text }: { text: string }) {',
        text: [
          '// 部分输出故意不做 schema 校验：不完整对象几乎必然校验失败，',
          '// 而 UI 需要"能拿到多少先渲染多少"。类型上标记为 DeepPartial 提醒调用方。',
          '// 两种成功状态都接受：repaired 表示自动补全了右括号等。',
        ],
      },
      {
        at: 280,
        expect: "validateArrayBound({ name: 'minItems', value: minItems });",
        text: [
          '// 参数校验放在工厂函数里，而不是等到解析阶段：',
          '// 非法边界属于调用方编码错误，越早失败越好定位。',
          '// 两个边界分别校验后再比较大小：先保证都是合法的非负整数。',
        ],
      },
      {
        at: 297,
        expect: 'responseFormat: resolve(elementSchema.jsonSchema).then(jsonSchema => {',
        text: [
          '// 数组模式把元素 schema 包进 { elements: [...] }：',
          '// JSON 模式的根必须是 object，裸数组 schema 很多 provider 不支持。',
          '// 根级 definitions/$defs 必须上提保留：元素 schema 可能用 #/definitions/... 引用，',
          '// 若留在 items 内部，引用路径会失效。',
          '// $schema 固定为 draft-07：与 provider 端解析器保持一致。',
          '// additionalProperties: false 让模型不能塞入多余字段，减少无意义 token。',
        ],
      },
      {
        at: 373,
        expect: 'const lengthValidationError = getArrayLengthValidationError({',
        text: [
          '// 长度约束在这里单独检查：schema 层只是"提示"，模型可能不遵守。',
          '// 元素级校验在下面逐个进行，能给出更精确的失败位置。',
        ],
      },
      {
        at: 390,
        expect: 'const validatedElements: Array<ELEMENT> = [];',
        text: [
          '// 逐个校验并保留顺序：任一元素失败即整体失败，',
          '// 不做"过滤掉坏元素"的容错——那会静默改变模型输出的含义。',
        ],
      },
      {
        at: 414,
        expect: 'async parsePartialOutput({ text }: { text: string }) {',
        text: [
          '// 数组的部分解析最棘手：最后一个元素通常是不完整的。',
          '// 策略是先解析、再丢弃"正在生成"的尾部元素，只返回已确定的完整元素。',
          '// 与 object 不同，这里对每个元素仍然校验：UI 直接渲染元素，形状必须可信。',
          '// 校验失败的元素被跳过而不是报错：部分输出阶段容错优先。',
        ],
      },
      {
        at: 437,
        expect: 'const rawElements =',
        text: [
          '// repaired 状态意味着 JSON 被补全过，最后一个元素很可能是残缺的：',
          '// 丢掉它，避免 UI 闪现半个对象又被下一帧替换。',
          '// successful 状态说明 JSON 已完整，所有元素都可直接用。',
          '// 空数组时不做 slice：避免把仅有的一个完整元素也丢掉。',
        ],
      },
      {
        at: 459,
        expect: 'createElementStreamTransform() {',
        text: [
          '// 元素流转换器：把"整体 partial 数组"变成"逐个完成的元素"。',
          '// publishedElements 是游标：partial 每次都是全量数组，只发新增部分。',
          '// [并发] 游标只在 transform 内读写，TransformStream 保证串行。',
          '// 不可回退：partial 数组只应增长；若上层重排，这里会漏发或错发。',
        ],
      },
      {
        at: 466,
        expect: 'transform({ partialOutput }, controller) {',
        text: [
          '// partialOutput 为 null 表示这一帧没有可用部分，直接跳过。',
          '// maxItems 在流式阶段也要检查：模型可能持续生成超出上限的元素。',
        ],
      },
      {
        at: 493,
        expect: 'function validateArrayBound({',
        text: [
          '// Number.isInteger 同时排除 NaN / Infinity / 小数：',
          '// 这些值传给 JSON Schema 会被静默截断或忽略。',
          '// 错误信息带参数名与值，便于调用方在一长串参数里定位。',
        ],
      },
      {
        at: 521,
        expect: 'function getArrayLengthValidationError({',
        text: [
          '// 返回 TypeValidationError 而不是直接抛：调用方需要把它包进',
          '// NoObjectGeneratedError，并附带 response / usage 等上下文。',
        ],
      },
      {
        at: 576,
        expect: 'responseFormat: Promise.resolve({',
        text: [
          '// 选择模式同样包一层 { result: ... }：复用 object 的根形状要求。',
          '// enum 直接列出候选值，让 provider 在解码阶段就受限。',
        ],
      },
      {
        at: 660,
        expect: 'const potentialMatches = choiceOptions.filter(choiceOption =>',
        text: [
          '// 部分匹配用前缀：模型逐字生成，已输出的前缀可以帮助 UI 提前高亮候选。',
          '// successful 状态要求精确命中候选值：此时文本已完整，没有歧义。',
          '// repaired 状态只在唯一匹配时返回：多个候选共享同一前缀时无法判断。',
          '// 这种"宁可不猜"的策略避免 UI 在候选之间来回跳动。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/validate-tool-approvals.ts',
    edits: [
      {
        at: 21,
        expect: '/**',
        text: [
          '// 客户端历史中的"已批准"审批会在下一轮被重放执行，这里是执行前的最后一道闸门。',
          '//',
          '// 历史可能被篡改、过期或被旧版本写入，因此三件事都要重做：',
          '// 签名校验（防篡改）、输入 schema 校验（防参数漂移）、审批策略（防策略变更）。',
          '//',
          '// INV-01：工具必须用 getOwn 查找，不能走原型链：',
          '// 否则 "constructor" 这类名字会取到 Object.prototype 上的函数并跳过校验。',
          '// INV-02：重新精炼后的输入必须与批准时的输入深比较相等，',
          '// 任何差异都意味着"批准的操作"与"将要执行的操作"不是同一个。',
        ],
      },
      {
        at: 54,
        expect: 'const approved: Array<CollectedToolApprovals<TOOLS>> = [];',
        text: [
          '// 三类结果分开返回：批准（继续执行）、拒绝（回灌模型）、无效（报错给模型）。',
        ],
      },
      {
        at: 60,
        expect: 'for (const collectedApproval of approvedToolApprovals) {',
        text: [
          '// 逐个处理而不是并行：签名校验与 schema 校验都可能 await，',
          '// 但顺序处理能让错误归因更清晰，且审批数量通常很小。',
          '// 单个审批失败不会影响其他审批：只有签名错误是"整批不可信"级别的异常。',
        ],
      },
      {
        at: 65,
        expect: 'const tool = getOwn(tools, collectedApproval.toolCall.toolName);',
        text: [
          '// 只在自有属性里找工具：toolName 来自客户端历史，完全不可信（见 INV-01）。',
          '// 找不到时 tool 为 undefined，后续会跳过 schema 校验，但审批策略仍会处理。',
          '// 这是刻意的降级：未知工具交给 resolveToolApproval 决定是否拒绝。',
        ],
      },
      {
        at: 75,
        expect: 'const approval: CollectedToolApprovals<TOOLS> = {',
        text: [
          '// 从当前服务端定义重建展示元数据：历史里的 toolMetadata / dynamic / title',
          '// 都可能被改写，不能直接信任。',
          '// 先解构剔除再展开，保证旧字段不会因为对象展开顺序而残留。',
        ],
      },
      {
        at: 86,
        expect: 'if (toolApprovalSecret != null) {',
        text: [
          '// 配置了密钥就强制要求签名：缺失视为攻击而不是兼容旧数据。',
          '// 签名覆盖 approvalId / toolCallId / toolName / input 摘要，',
          '// 也就是说任何字段被改动都会导致校验失败。',
        ],
      },
      {
        at: 113,
        expect: 'if (isExecutableTool(tool) && tool.inputSchema != null) {',
        text: [
          '// 有 inputSchema 才校验；provider 执行的工具与无 schema 的动态工具跳过。',
          '// 优先校验 inputSchemaInput：它是审批时展示给用户的规范化输入，',
          '// 缺失时退回 toolCall.input，兼容旧版本或裁剪过的历史。',
          '// 校验通过后还要再走一遍 refine：精炼可能改变输入（如补默认值）。',
        ],
      },
      {
        at: 130,
        expect: 'const revalidatedToolCall = await refineParsedToolCallInput({',
        text: [
          '// 精炼用的是"当前"回调实现：升级后语义可能变化，这正是要重做的原因。',
          '// 精炼失败按无效处理，而不是抛出：让模型看到错误并重新决策。',
        ],
      },
      {
        at: 139,
        expect: 'const revalidatedInput = structuredClone(revalidatedToolCall.input);',
        text: [
          '// 先 clone 再比较：输入可能含类实例、getter 或跨 realm 对象，',
          '// isDeepEqualData 只处理纯数据，clone 让两边处于同一 realm 与同一形状。',
          '// 比较的是"精炼后"的输入，而不是原始字符串：见 INV-02。',
        ],
      },
      {
        at: 154,
        expect: 'if (validationError != null) {',
        text: [
          '// 无效审批附上 InvalidToolInputError：toolInput 用 JSON 字符串，',
          '// 因为回灌给模型时必须是文本。',
        ],
      },
      {
        at: 167,
        expect: 'const approvalStatus = await resolveToolApproval({',
        text: [
          '// 策略在最后一步评估：它依赖当前配置与 messages，',
          '// 可能与批准时的策略不同（例如规则已收紧）。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/tool-caller-configuration.ts',
    edits: [
      {
        at: 11,
        expect: 'export const DIRECT_TOOL_CALL',
        text: [
          '// 特殊标记：表示该工具可以被模型直接调用，而不是必须经由某个 caller。',
          '// 用固定字符串而不是 Symbol：它要出现在用户配置里，必须可序列化。',
        ],
      },
      {
        at: 20,
        expect: 'export type Experimental_ToolCallers',
        text: [
          '// 配置形状：工具名 → 允许的调用方列表（含 DIRECT 标记）。',
          '// 用 ToolCallerName 约束候选值：只能填真实存在的 caller 工具名。',
        ],
      },
      {
        at: 28,
        expect: 'export function resolveToolCallerConfiguration',
        text: [
          '// 校验并归一配置：未知工具名直接抛错，而不是静默忽略。',
          '// [权衡] 静默忽略会让拼写错误变成"工具永远不可用"，很难排查；',
          '// 因此选择在初始化阶段 fail-fast。',
          '// 返回 undefined 表示未配置，调用方据此走普通路径。',
        ],
      },
      {
        at: 41,
        expect: 'for (const [toolName, callers] of Object.entries(toolCallers)) {',
        text: [
          '// 用 hasOwnProperty 判断工具存在：避免 "toString" 这类原型属性被当成工具。',
          '// callers 为 null 时跳过：允许用户用 undefined 占位后再补。',
        ],
      },
      {
        at: 58,
        expect: 'export function prepareToolsForToolCallers({',
        text: [
          '// 核心派生逻辑：把"用户配置的调用关系"翻译成三份产物。',
          '// executionTools：运行时实际可执行的工具集合（含绑定后的 caller）。',
          '// modelTools：真正发给 provider 的声明，被 caller 独占的工具会从里面删除。',
          '// toolCallerMessages：用自然语言告诉模型"这些工具经由某个 caller 提供"。',
          '//',
          '// INV-01：三个返回值必须来自同一次计算，调用方不得自行增删；',
          '// 否则会出现"声明里有、执行时没有"的错配。',
        ],
      },
      {
        at: 78,
        expect: 'const executionTools: ToolSet = { ...tools };',
        text: [
          '// 两份浅拷贝：executionTools 会被原地改写（绑定 caller、替换 prepared 工具），',
          '// modelTools 会被删键，都不能直接修改调用方传入的 tools。',
          '// 工具对象本身是共享的：只改容器，不改单个工具定义。',
        ],
      },
      {
        at: 89,
        expect: 'for (const [toolName, callerNames] of Object.entries(toolCallers)) {',
        text: [
          '// 逐个工具判定可用路径：直接可用、经 provider caller、经本地 caller。',
          '// 一个工具可以同时被多条路径使用，因此用布尔标记而不是提前 break。',
          '// preparedTool 会在 provider caller 处理时被替换（注入 providerOptions）。',
        ],
      },
      {
        at: 110,
        expect: "if (caller.type === 'provider') {",
        text: [
          '// provider caller 不改变执行位置，只改请求参数：',
          '// 工具仍然由本地执行，但 provider 需要额外选项才能正确调用它。',
          '// 因此工具保留在 modelTools 里，只是 providerOptions 被替换。',
        ],
      },
      {
        at: 119,
        expect: 'const localTools = localToolsByCaller.get(callerName) ?? {};',
        text: [
          '// 本地 caller 独占工具：从 modelTools 删除，改为在 caller 内部可见。',
        ],
      },
      {
        at: 134,
        expect: 'for (const [callerName, callerTool] of Object.entries(executionTools)) {',
        text: [
          '// 第二轮：把本地 caller 绑定到它独占的工具集。',
          '// 必须在第一轮结束后做：绑定需要完整的 localToolsByCaller。',
          '// bind 产出新的工具对象，因此后续执行用的是绑定版本。',
        ],
      },
      {
        at: 159,
        expect: 'export function appendToolCallerMessages({',
        text: [
          '// 把 caller 说明消息追加到历史末尾，并按文本去重：',
          '// 多步生成时同一段说明会被重复计算，重复注入会浪费 token 并干扰模型。',
        ],
      },
      {
        at: 170,
        expect: 'const latestUserText = messages.findLast(',
        text: [
          '// 只与"最后一条字符串用户消息"去重：说明消息本质上是用户侧提示，',
          '// 若用户已经自己写了同样内容，就不应再追加一遍。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/tool-approval-signature.ts',
    edits: [
      {
        at: 4,
        expect: 'const encoder = new TextEncoder();',
        text: [
          '// 模块级 encoder：TextEncoder 无状态且构造便宜，复用避免每次签名都新建。',
          '// 所有签名输入都先编码成 UTF-8 字节，保证跨运行时一致。',
        ],
      },
      {
        at: 10,
        expect: 'async function importKey(',
        text: [
          '// 字符串密钥按 UTF-8 编码；Uint8Array 直接使用（可能来自环境变量解码）。',
          '// extractable=false：密钥不应被导出，降低泄漏面。',
          '// 只申请 sign / verify 权限：最小权限原则。',
        ],
      },
      {
        at: 24,
        expect: '// Serialize with JSON so the encoding is injective',
        text: [
          '// JSON 数组编码是单射的：字段里的换行、分隔符都会被转义，边界不会混淆。',
          '// 版本前缀提供域分离：同一密钥在其他用途上的签名不会被误认。',
        ],
      },
      {
        at: 61,
        expect: 'export async function signToolApproval({',
        text: [
          '// 签名输入是"规范化后的摘要"，不是原始 input 对象：',
          '// 键序、数字表示等差异会被 hashCanonical 抹平，避免同一语义算出不同签名。',
          '// 返回 base64url：可直接放进 JSON 与 HTTP header，无需二次转义。',
          '// [失败路径] 密钥非法时 importKey 会抛错，由调用方决定如何呈现。',
        ],
      },
      {
        at: 81,
        expect: 'export async function verifyToolApprovalSignature({',
        text: [
          '// 先用当前格式校验，失败再尝试旧格式（仅限无换行字段）。',
          '// 不要用字符串相等比较签名：必须走 crypto.subtle.verify，',
          '// 它内部是常量时间比较，避免时序侧信道。',
        ],
      },
      {
        at: 105,
        expect: '// Backwards compatibility: accept a signature produced by the legacy',
        text: [
          '// 旧格式的碰撞攻击需要字段里含换行，因此这里显式排除该情况。',
        ],
      },
      {
        at: 129,
        expect: 'export async function maybeSignApproval({',
        text: [
          '// 未配置密钥时返回 undefined：审批请求不带签名，校验侧也会跳过。',
        ],
      },
    ],
  },
  {
    rel: 'packages/ai/src/generate-text/tool-call-concurrency.ts',
    edits: [
      {
        at: 6,
        expect: 'export function prepareToolCallConcurrency(',
        text: [
          '// 并发度只做参数校验，不做任何调度：undefined 表示"不限制/走默认"。',
          '// 校验为整数且 ≥1：0 会让工作协程立刻退出，导致工具永不执行。',
        ],
      },
      {
        at: 38,
        expect: 'export async function mapWithConcurrency<INPUT, OUTPUT>({',
        text: [
          '// 保序并发映射：结果按输入下标写回，调用方看到的顺序与输入一致。',
          '// 工作协程按输入顺序领取任务，因此"开始顺序"也是确定的。',
          '// 任一任务失败或收到 abort 即停止领取新任务（fail-stop）。',
          '// 注意已经在跑的任务不会被强制中断：execute 需自行响应 abortSignal。',
        ],
      },
      {
        at: 49,
        expect: 'if (concurrency == null || concurrency >= items.length) {',
        text: [
          '// 无限制或限制不小于任务数时退化为 Promise.all：',
          '// 少一层调度开销，且错误行为更直观（首个拒绝即整体拒绝）。',
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
