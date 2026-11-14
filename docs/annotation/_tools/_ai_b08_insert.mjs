// AI-deep-b08：generateText 非流式多步内核。
import fs from 'node:fs';

const REL = 'packages/ai/src/generate-text/generate-text.ts';
const FILE = 'D:/code/opensource/ai/' + REL;

const edits = [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// generateText：非流式的多步生成内核（与 stream-text.ts 并列的两条主干之一）。',
      '//',
      '// 链路：generateText → generateTextInternal → 初始化（提示归一、超时合并、遥测）',
      '// → do/while 逐步执行：prepareStep → doGenerate → 解析工具 → 审批 → 执行',
      '// → toResponseMessages 回灌 → 判断停止条件 → 聚合结果 → onEnd。',
      '//',
      '// 与 streamText 的关键差异：没有流，因此没有重试边界与 part 回放问题；',
      '// 代价是首字节要等整次生成结束，且无法在中途取消已完成的部分结果。',
      '//',
      '// INV-01：openStep 必须与 steps 同步：step 成功结束时它被清空，',
      '// 只有"已开始但未产出结果"的 step 才会在 catch 里触发 onStepError。',
      '// INV-02：每步的 messagesForNextStep = 本步请求消息 + 本步响应消息，',
      '// 不能只用响应消息，否则会丢掉用户输入与工具调用方说明。',
      '// INV-03：provider 执行的延迟工具结果未回灌前不得停止循环，',
      '// 否则调用方永远拿不到那部分结果。',
    ],
  },
  {
    at: 249,
    expect: 'export async function generateText<',
    text: [
      '// 公开入口只做一件事：托管 steering 生命周期的边界。',
      '// 失败发生在循环开始之前（例如提示非法）时，也必须结束 steering，',
      '// 否则等待中的消息会永远挂起。',
      '// 中止与错误分开上报：abortSignal 已中止时记为 aborted，否则记为 error。',
      '// 其余全部逻辑在 generateTextInternal 中，便于测试直接构造参数对象。',
    ],
  },
  {
    at: 276,
    expect: 'async function generateTextInternal<',
    text: [
      '// 内部实现：先做一次性的全局初始化，再进入 do/while 多步循环。',
      '//',
      '// STEP-1 归一：include 默认值、并发度、模型、tool-caller、toolSearch、停止条件。',
      '// STEP-2 超时：total / step 两类合并成 mergedAbortSignal；',
      '//        firstChunk / chunk 在非流式下无意义，转成 unsupported 警告而不是报错。',
      '// STEP-3 循环：prepareStep 覆盖 → doGenerate → 工具审批/执行 → 记账 → 停止判断。',
      '// STEP-4 收口：聚合 usage 与数组字段、触发 onEnd、按需解析 output、构造结果对象。',
      '//',
      '// 注意 settings 用剩余参数收集：所有采样参数原样透传给 provider，',
      '// 框架只认识其中少数几个用于事件与遥测。',
    ],
  },
  {
    at: 803,
    expect: 'try {',
    text: [
      '// openStep 是"已开始但未产出结果的 step"的快照（见 INV-01）。',
      '// 它在 onStepStart 之后赋值，在 steps.push 之后清空，因此 catch 里',
      '// 有值就说明失败发生在"已经开始、但结果尚不可用"的窗口内。',
    ],
  },
  {
    at: 807,
    expect: 'const {',
    text: [
      '// 首轮请求前先处理历史里的审批：客户端可能把上一轮的用户决定回传回来。',
      '// 这些审批必须在第一次模型调用之前执行完，结果作为初始 tool 消息并入历史。',
      '// 收集与校验分开：collect 只做结构收集，validate 才做签名/schema/策略校验。',
    ],
  },
  {
    at: 837,
    expect: 'if (',
    text: [
      '// 三类情况需要先执行一轮工具：有本地批准的调用、有未带结果的拒绝、有无效应答。',
      '// 都没有时跳过整段并直接进入模型循环，避免产生一条空的 tool 消息。',
      '// provider 执行的审批已被过滤掉：它们的执行发生在 provider 侧，不能本地跑。',
      '// [并发] 这里的工具执行与后续步骤共用同一并发度配置。',
      '// [事务] 结果按顺序写入 initialResponseMessages，作为第 0 步的历史。',
    ],
  },
  {
    at: 874,
    expect: 'const toolContent: Array<any> = [];',
    text: [
      '// toolContent 最终会构成一条 role=tool 的消息：三类来源顺序不可混。',
      '// 1) 正常结果；2) 无效审批（不执行，只回报错误）；3) 被拒绝的执行。',
      '// 顺序影响模型对历史的理解，正常结果应排在最前。',
      '// [权衡] 用 Array<any> 是因为三种 part 的 output 形状由工具决定，',
      '// 在这里做联合类型收窄价值不大，真正的类型保障在 toResponseMessages。',
    ],
  },
  {
    at: 896,
    expect: '// Report invalid approved tool calls to the model without executing',
    text: [
      '// 无效审批不能"修复后再执行"：修复会改变用户实际批准的操作（见 INV-02 的思路）。',
      '// 因此这里只回报错误，让模型重新发起调用。',
    ],
  },
  {
    at: 935,
    expect: 'initialResponseMessages.push({',
    text: [
      '// 即使 toolContent 为空也可能进入这里（例如只有被拒绝的调用），',
      '// 空 tool 消息无害，但能让下一轮的历史与审批记录对齐。',
    ],
  },
  {
    at: 968,
    expect: 'const shouldStartNextStep = async () => {',
    text: [
      '// 停止判定顺序即优先级，先判"必须停"的，再判"可以继续"的：',
      '// 1) interrupted 直接停；2) 客户端工具尚未全部产出结果则等下一轮；',
      '// 3) 没有客户端调用也没有延迟结果时，检查 steering 与截断；',
      '// 4) 最后才评估用户提供的 stopCondition。',
      '// steeringEndReason 只在返回 false 的分支里赋值：它解释"为什么没继续"。',
    ],
  },
  {
    at: 1016,
    expect: 'do {',
    text: [
      '// 每轮都重新建 step 超时：stepTimeoutMs 是"单步上限"，不是整次生成上限。',
      '// 首轮之外先 throwIfAborted：上一轮结束时若已被中止，不应再发请求。',
      '// steering 消息在 step 开始时取出并并入消息：它属于"下一步的输入"，',
      '// 因此必须在 prepareStep 之前合并，让用户能看到并改写。',
      '// [资源] finally 里清定时器，覆盖正常、异常与提前返回三种路径。',
    ],
  },
  {
    at: 1029,
    expect: 'const steeringMessages = steeringRun?.takeMessages() ?? [];',
    text: [
      '// take 是"取走"语义：取出的消息本轮必须处理，不可重复投递。',
      '// 是否真正投递成功由 prepareStep 之后的 resolveTakenMessages 判定。',
    ],
  },
  {
    at: 1045,
    expect: 'const prepareStepResult = await prepareStep?.({',
    text: [
      '// prepareStep 是唯一的"每步可编程入口"：能改模型、指令、工具、消息与采样参数。',
      '// responseMessages 只含模型产出的历史（不含初始用户消息），',
      '// 这样调用方可以按"本次生成新增了什么"做决策。',
      '// 未提供时返回 undefined，后续全部走 ?? 回退到全局配置。',
    ],
  },
  {
    at: 1212,
    expect: 'currentModelResponse = await retry(async () => {',
    text: [
      '// 整次 doGenerate 包在 retry 里：非流式调用失败可以安全重试，',
      '// 因为没有已消费的流或已发出的 part。',
      '// 遥测上下文在重试外层：重试共享一个 span，避免产生多条并列调用记录。',
      '// response 字段在这里补齐兜底值：id / timestamp / modelId 都可能缺失。',
    ],
  },
  {
    at: 1248,
    expect: 'const responseTimeMs = now() - stepStartTimestampMs;',
    text: [
      '// 计时从"调用开始前"算起，包含建连与重试；因此 effective* 指标是端到端口径。',
      '// 非流式没有首包概念，timeToFirstOutputMs 与 *TokensPerSecond 留空。',
    ],
  },
  {
    at: 1254,
    expect: 'const stepToolCalls: TypedToolCall<TOOLS>[] = await Promise.all(',
    text: [
      '// 并行解析所有工具调用：解析可能包含 schema 校验与用户修复回调，',
      '// 彼此独立，串行会显著拖慢多工具场景。',
      '// toolChoice=none 时禁用 repair / refine：不允许"帮助"一个本不该出现的调用通过。',
      '// [失败路径] 单个调用解析失败会变成 invalid 调用，而不是让整步抛错。',
    ],
  },
  {
    at: 1354,
    expect: 'const enforcedToolChoice =',
    text: [
      '// auto 不构成约束；none / required / 指定工具需要校验（与流式实现同规则）。',
      '// interrupted 例外：模型被打断时不应因"没来得及调用"判违约。',
      '// none 的判定只看"有没有调用"，不看执行结果：调用出现即违约。',
      '// 违约抛错而不是降级：静默忽略会让调用方误以为约束生效了。',
    ],
  },
  {
    at: 1379,
    expect: 'for (const toolCall of stepToolCalls) {',
    text: [
      '// 逐调用做三件事：输入回调、审批决议、登记审批请求/响应。',
      '// invalid 与"工具不可用"的调用直接跳过：前者已由 error 输出处理，',
      '// 后者常见于 provider 执行的动态工具（本地没有定义）。',
      '// onInputStart / onInputAvailable 都在执行前触发，便于 UI 提前展示参数。',
    ],
  },
  {
    at: 1422,
    expect: 'const toolApprovalStatus = await resolveToolApproval({',
    text: [
      '// 策略决议使用 stepExecutionTools：tool-caller 可能替换了实际执行的工具版本。',
      '// 决议结果四态：not-applicable / user-approval / approved / denied。',
      '// not-applicable 不消耗 approvalId：保持 id 序列对调用方稳定可预测。',
    ],
  },
  {
    at: 1438,
    expect: 'const approvalId = generateId();',
    text: [
      '// 每个需要审批的调用都分配一个 id，并可选地签名：',
      '// 签名覆盖 approvalId + toolCallId + toolName + input，防止客户端伪造。',
      '// 自动批准/拒绝也产生 request+response 对，便于审计与回放。',
      '// blockedToolCallIds 累积所有不应执行的调用（待人工审批或被拒绝）。',
    ],
  },
  {
    at: 1503,
    expect: '// insert error tool outputs for invalid tool calls:',
    text: [
      '// 无效调用需要一条 tool-error 输出，否则下一步历史里会出现"有调用无结果"，',
      '// 多数 provider 会直接拒绝这种历史。',
      '// 只补本地工具：provider 执行的调用由 provider 自己负责错误表达。',
    ],
  },
  {
    at: 1525,
    expect: '// execute client tool calls:',
    text: [
      '// 重置 clientToolOutputs：它表示"本步"的产出，不能跨步累积，',
      '// 否则 shouldStartNextStep 的结果计数会错。',
      '// clientToolCalls 包含 invalid 调用（用于计数对齐），执行时再过滤。',
      '// deniedToolApprovalResponses 单独保存：停止判定需要把它们计入"已完成"。',
    ],
  },
  {
    at: 1535,
    expect: 'if (',
    text: [
      '// 双重门禁：有可执行工具，且 finishReason 允许执行。',
      '// 例如 length / content-filter 时不应冒险执行可能不完整的调用。',
    ],
  },
  {
    at: 1604,
    expect: '// Track provider-executed tool calls that support deferred results.',
    text: [
      '// 延迟结果只对声明 supportsDeferredResults 的 provider 工具有意义。',
      '// 若同一响应里已有结果就不登记，避免下一步误以为还欠一个回灌。',
    ],
  },
  {
    at: 1650,
    expect: '// Add step information (after response messages are updated):',
    text: [
      '// request / response 的 body 与 messages 默认不保留：它们可能非常大，',
      '// 在多步生成里会成倍占用内存。需要排查时用 include 显式打开。',
      '// response.messages 必须深拷贝：多步之间会复用同一个消息对象，',
      '// 不拷贝会导致后续步骤的修改污染已记录的历史结果。',
    ],
  },
  {
    at: 1699,
    expect: 'steps.push(currentStepResult);',
    text: [
      '// 记账顺序固定：先 push step，再推进 instructions/messages，最后清 openStep。',
      '// openStep 清空后，后续若再抛错不会重复上报本步（见 INV-01）。',
      '// messagesForNextStep 用未拷贝的 stepResponseMessages：下一步会自行克隆。',
    ],
  },
  {
    at: 1713,
    expect: '} finally {',
    text: [
      '// 无论成功、抛错还是中止都清理 step 定时器：',
      '// 否则超时会在整次生成结束后仍然触发 abort，影响后续调用。',
    ],
  },
  {
    at: 1718,
    expect: '} while (await shouldStartNextStep());',
    text: [
      '// 循环条件本身是异步的：stopCondition 可以由用户实现为异步，',
      '// 因此必须在 while 条件里 await，而不能提前求值。',
    ],
  },
  {
    at: 1722,
    expect: 'const lastStep = steps[steps.length - 1];',
    text: [
      '// steps 至少有一项：do/while 至少执行一次，且失败会在 catch 里提前返回。',
      '// 单值字段（text / finishReason / response）一律取最后一步。',
    ],
  },
  {
    at: 1754,
    expect: 'const onEndEvent = {',
    text: [
      '// onEnd 的字段 = 跨步聚合数组 + 最后一步的单值字段。',
      '// responseMessages 含初始消息与每步新增消息，是下一轮请求可直接复用的历史。',
      '// totalUsage 与 usage 同时给出：前者是累计值，后者为兼容保留。',
      '// [事务] onEndEvent 构造在解析 output 之前：即使 output 解析失败，',
      '// 调用方仍能收到结束事件（解析错误随后抛出）。',
    ],
  },
  {
    at: 1793,
    expect: '// parse output for stop responses and non-empty responses that are not',
    text: [
      '// 只在"正常结束"或"有文本且不是工具调用步"时解析 output：',
      '// 工具调用步的文本通常是中间说明，强行按 schema 解析会误报。',
      '// JSON 模式下优先用 structuredOutputText：provider 可能把结构化结果',
      '// 放在独立字段而不是正文里。',
      '// 解析失败会抛 NoObjectGeneratedError，并带上 response / usage / finishReason。',
    ],
  },
  {
    at: 1823,
    expect: '} catch (error) {',
    text: [
      '// 统一收口：先包装网关错误（保留状态码与请求 id），再结束 steering。',
      '// generateText 没有 onAbort，因此中止与超时也走 onStepError 通知。',
      '// 只有 openStep 存在时才发 onStepError：已完成的步骤不应被报成失败。',
      '// 最后仍抛出包装后的错误，保证调用方的 catch 看到一致的错误类型。',
    ],
  },
  {
    at: 1847,
    expect: 'async function executeTools<TOOLS extends ToolSet>({',
    text: [
      '// 工具执行的薄封装：只负责并发调度与过滤空结果。',
      '// 真正的执行、回调、遥测与错误归一都在 executeToolCall 内。',
      '// 过滤 null 是为了允许单个工具"跳过执行"（例如被审批拦截）。',
      '// [并发] 顺序由 mapWithConcurrency 保证与输入一致，便于结果回填。',
    ],
  },
];

const lines = fs.readFileSync(FILE, 'utf8').split('\r\n');
const sorted = [...edits].sort((a, b) => b.at - a.at);
let added = 0;
for (const e of sorted) {
  const idx = e.at - 1;
  if (!lines[idx] || !lines[idx].includes(e.expect)) {
    console.error(`MISS ${e.at} :: ${e.expect}`);
    console.error('  actual: ' + JSON.stringify(lines[idx]));
    process.exit(1);
  }
  lines.splice(idx, 0, ...e.text);
  added += e.text.length;
}
fs.writeFileSync(FILE, lines.join('\r\n'), 'utf8');
console.log('ADDED ' + added);
