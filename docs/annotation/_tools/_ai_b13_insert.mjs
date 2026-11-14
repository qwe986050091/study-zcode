import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';
const rel = 'packages/ai/src/ui/chat.ts';
const file = path.join(ROOT, rel);
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    at: 1,
    expect: 'import {',
    text: [
      '// ============================================================================',
      '// Chat 状态机：框架无关的会话控制器，负责消息列表、请求生命周期与工具审批/输出回填。',
      '// 链路位置：useChat（React）等框架绑定只是薄壳；真正的逻辑在 AbstractChat，',
      '//   它通过 ChatTransport 发请求，用 processUIMessageStream 消费 UIMessageChunk 流。',
      '// 并发模型：所有改变消息/工具状态的操作都串行进入 jobExecutor，避免流式 chunk 与',
      '//   用户回调（addToolOutput/addToolApprovalResponse）并发写同一 parts 数组。',
      '// 不变量：INV-01 同一时刻只有一个 activeResponse（守住 1049 与 1219 的归属检查）；',
      '//   INV-02 非当前请求不得改状态（守住 921 的 isCurrentRequest）；',
      '//   INV-03 stop 之后排队中的自动请求必须作废（守住 829-851 的 generation 比对）；',
      '//   INV-04 中断消息不得自动续跑（守住 277-279 的 interruptedMessageIds）。',
      '// 阅读顺序建议：ChatInit 参数 -> makeRequestImpl 主流程 -> 工具回填两个入口 -> stop。',
      '// ============================================================================',
    ],
  },
  {
    at: 35,
    expect: 'export type CreateUIMessage<UI_MESSAGE extends UIMessage> = Omit<',
    text: [
      '// 允许调用方只传 parts，id/role 由 Chat 补齐；因此 Omit 掉后两者再设为可选。',
      '// 这样 sendMessage 的三种重载可以共享同一套消息构造逻辑。',
    ],
  },
  {
    at: 43,
    expect: 'export type UIDataPartSchemas = Record<string, FlexibleSchema>;',
    text: ['// data part 的 schema 映射：键是 part 的 type，值是运行时可校验的 schema。'],
  },
  {
    at: 53,
    expect: 'export type ChatRequestOptions = {',
    text: ['// 每次请求可覆盖的选项：headers/body 透传给 transport，metadata 供 transport 自定义使用。'],
  },
  {
    at: 70,
    expect: 'export type ChatAddToolApproveResponseFunction = ({',
    text: [
      '// 审批回填函数：只改本地消息，不直接发请求；是否续跑由 sendAutomaticallyWhen 决定。',
      '// 返回 promise 以便调用方等待 jobExecutor 中的更新完成。',
    ],
  },
  {
    at: 97,
    expect: 'export type ChatAddToolOutputFunction<UI_MESSAGE extends UIMessage> = <',
    text: [
      '// 工具输出回填：state 决定写 output-available 还是 output-error，二者互斥。',
      '// output 的类型由 tool 名推导，保证与工具定义一致。',
      '// 该函数同样只更新本地状态，自动续跑由调用方配置。',
    ],
  },
  {
    at: 134,
    expect: "export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';",
    text: [
      '// 四态：submitted（请求已发）-> streaming（收到 chunk）-> ready；任意阶段可进 error。',
      '// 状态只由 makeRequestImpl/setStatus 改写，UI 层只读。',
    ],
  },
  {
    at: 136,
    expect: 'type ActiveResponse<UI_MESSAGE extends UIMessage> = {',
    text: [
      '// 一次进行中的响应：流式状态 + 取消控制器 + 完成 promise（供 stop 等待）。',
      '// completionPromise 在 makeRequest 的 finally 中 resolve。',
    ],
  },
  {
    at: 152,
    expect: 'export interface ChatState<UI_MESSAGE extends UIMessage> {',
    text: [
      '// Chat 的可观察状态：由框架绑定实现（如 React 的 useState 包装）。',
      '// push/pop/replace 是唯一的写入口，保证绑定层能感知变更。',
      '// snapshot 在并发更新前拍快照，避免引用被后续 chunk 修改。',
    ],
  },
  {
    at: 165,
    expect: 'export type ChatOnErrorCallback = (error: Error) => void;',
    text: ['// 错误回调：只收到 Error，非 Error 的抛出会被包装或忽略（见 catch 分支）。'],
  },
  {
    at: 167,
    expect: 'export type ChatOnToolCallCallback<UI_MESSAGE extends UIMessage = UIMessage> =',
    text: ['// 工具调用回调：用于客户端自动执行工具；返回值不被使用，结果需通过 addToolOutput 回填。'],
  },
  {
    at: 172,
    expect: 'export type ChatOnDataCallback<UI_MESSAGE extends UIMessage> = (',
    text: ['// data part 回调：在每个 data-* chunk 到达时触发，适合做日志/埋点等副作用。'],
  },
  {
    at: 187,
    expect: 'export type ChatOnFinishCallback<UI_MESSAGE extends UIMessage> = (options: {',
    text: [
      '// 结束回调：无论正常、abort、网络断开还是错误都会调用一次。',
      '// finishReason 为 interrupted 时表示模型被中断，可据此决定是否续跑。',
    ],
  },
  {
    at: 196,
    expect: 'export interface ChatInit<UI_MESSAGE extends UIMessage> {',
    text: [
      '// Chat 构造参数：消息初值、transport、各类回调与自动续跑判定。',
      '// 除 messages 外都可热替换（通过实例字段），但通常只在构造时设置。',
    ],
  },
  {
    at: 251,
    expect: 'export abstract class AbstractChat<UI_MESSAGE extends UIMessage> {',
    text: [
      '// 抽象基类：不依赖任何 UI 框架，只依赖 ChatState 抽象。',
      '// 子类只需提供 state 的实现（如 React 的 useSyncExternalStore 包装）。',
      '// 所有公共方法都是箭头函数，便于解构传递而不丢 this。',
    ],
  },
  {
    at: 254,
    expect: 'get id(): string {',
    text: ['// id 惰性生成：只有真正需要时才调用 generateId，避免无谓的随机数消耗。'],
  },
  {
    at: 260,
    expect: 'protected state: ChatState<UI_MESSAGE>;',
    text: ['// state 由子类注入；protected 允许子类直接读写，但公共 API 只暴露 getter。'],
  },
  {
    at: 275,
    expect: 'private pendingMessagePreparations = new Set<AbortController>();',
    text: [
      '// 正在准备中的用户消息（文件转换等）；stop 会 abort 它们，完成后从集合移除。',
      '// [资源] 集合只保存 controller，不持有文件本身，避免长生命周期引用。',
    ],
  },
  {
    at: 277,
    expect: 'Keep interruption state after activeResponse is cleared',
    text: [
      '// 中断状态必须在 activeResponse 清空后仍保留：否则迟到的工具更新会触发自动续跑。',
      '// 这是 INV-04 的存储位置。',
    ],
  },
  {
    at: 280,
    expect: 'private activeResponse: ActiveResponse<UI_MESSAGE> | undefined = undefined;',
    text: ['// 当前活动响应；同一时刻至多一个（INV-01）。stop 会 abort 并等待其完成。'],
  },
  {
    at: 282,
    expect: 'private resumableStreamState:',
    text: ['// 可恢复的流状态：仅在网络断开时保留，供 resumeStream 续接；其它错误会清空。'],
  },
  {
    at: 285,
    expect: 'private jobExecutor = new SerialJobExecutor();',
    text: [
      '// 串行执行器：所有写消息的操作都经它排队，避免 chunk 回调与用户回调交叉修改 parts。',
      '// [并发] 它只保证顺序，不提供互斥锁；stop 通过 waitForIdle 等待队列排空。',
    ],
  },
  {
    at: 286,
    expect: 'private activeStopCount = 0;',
    text: [
      '// activeStopCount：stop 的嵌套计数；stopGeneration：每次 stop 自增的代际号。',
      '// 自动请求在发起前记录代际号，若期间发生 stop 则作废（INV-03）。',
      '// 两者配合覆盖 "stop 期间又排入新请求" 的边界。',
    ],
  },
  {
    at: 289,
    expect: 'constructor({',
    text: [
      '// 构造：transport 默认使用 DefaultChatTransport；state 必须由子类提供。',
      '// 回调与 schema 都存为实例字段，便于子类或测试替换。',
    ],
  },
  {
    at: 329,
    expect: 'protected setStatus({',
    text: [
      '// 状态写入的唯一入口：相同状态时只更新 error，避免无意义的绑定层重渲染。',
      '// error 为 undefined 表示清除错误。',
    ],
  },
  {
    at: 369,
    expect: 'sendMessage = async (',
    text: [
      '// 发送消息：三种输入形态（完整 parts / text+files / 仅 files），',
      '// 以及 message 为空时的 "处理待审批消息" 分支。',
      '// STEP-1 构造/定位消息；STEP-2 push 或 replace；STEP-3 makeRequest。',
      '// 方法 await 到请求流水线结束，流式内容通过 state 增量更新。',
    ],
  },
  {
    at: 391,
    expect: 'if (message == null) {',
    text: [
      '// 无 message：等价于 "继续处理挂起的工具审批"。',
      '// 优先用 pendingApprovalMessageId，其次找最近一条含 approval-responded 的 assistant 消息，',
      '// 以便页面重新水合后仍能把结果 chunk 关联回原 tool call。',
    ],
  },
  {
    at: 414,
    expect: 'const consumesPendingApproval =',
    text: [
      '// 判断本次请求是否真的消费了 pendingApprovalMessageId；',
      '// 只有消费时才需要在失败后恢复它（见 makeRequestForToolApproval）。',
    ],
  },
  {
    at: 430,
    expect: "if ('text' in message || 'files' in message) {",
    text: [
      '// text/files 形态：先转换文件（异步），再拼成 parts。',
      '// [资源] 转换期间注册 AbortController，stop 可中断；完成后按 signal 决定是否继续。',
      '// 纯 parts 形态（else）不再加工，直接使用。',
    ],
  },
  {
    at: 459,
    expect: 'if (message.messageId != null) {',
    text: [
      '// 带 messageId：替换已有用户消息，并截断其后的所有消息（重新生成语义）。',
      '// [失败路径] id 不存在或不是 user 消息时抛 InvalidArgumentError。',
      '// 这是唯一允许修改历史消息的入口。',
    ],
  },
  {
    at: 510,
    expect: 'regenerate = async ({',
    text: [
      '// 重新生成：定位目标消息，截断到它之前（assistant）或包含它（user）。',
      '// 缺省 messageId 时取最后一条消息。',
      '// [失败路径] id 不存在抛 InvalidArgumentError。',
    ],
  },
  {
    at: 548,
    expect: "resumeStream = async (options: ChatRequestOptions = {}): Promise<void> => {",
    text: ['// 恢复流：只走 resume-stream 分支，不发新请求。'],
  },
  {
    at: 559,
    expect: "'~resumeStreamIfDisconnected' = async ({",
    text: [
      '// 内部方法供框架绑定在 "疑似断线" 时调用：',
      '// 若已有活动响应则先等它结束，再判断是否真的留下了可恢复状态。',
      '// [并发] 等待期间状态可能被其它请求改写，因此结束后要重新比对 resumableStreamState。',
    ],
  },
  {
    at: 582,
    expect: 'clearError = () => {',
    text: ['// 仅清除 error 并回到 ready；不影响消息与进行中的请求。'],
  },
  {
    at: 589,
    expect: 'addToolApprovalResponse: ChatAddToolApproveResponseFunction = async ({',
    text: [
      '// 审批回填：串行进入 jobExecutor，避免与流式 chunk 并发改 parts。',
      '// STEP-1 找到含该 approval.id 的 part 并置为 approval-responded；',
      '// STEP-2 同步更新 activeResponse 的内存副本（若有）；',
      '// STEP-3 若满足条件且 sendAutomaticallyWhen 为真，异步续跑（不 await，避免死锁）。',
    ],
  },
  {
    at: 632,
    expect: 'if (this.activeResponse) {',
    text: [
      '// 同步更新活动响应：流式状态持有同一 message 对象的副本，',
      '// 若不更新，后续 chunk 写回时会把审批结果覆盖掉。',
    ],
  },
  {
    at: 637,
    expect: 'automatically send the message if the sendAutomaticallyWhen function returns true',
    text: [
      '// 自动续跑条件：有匹配消息、当前不忙、且配置了判定函数。',
      '// [并发] 这里用 void 启动，不 await：runAutomaticRequest 内部会再次校验代际号。',
      '// shouldSend 为 false 时什么都不做，等待用户手动发送。',
    ],
  },
  {
    at: 666,
    expect: 'addToolOutput: ChatAddToolOutputFunction<UI_MESSAGE> = async ({',
    text: [
      '// 工具输出回填：与审批同构，按 toolCallId 定位 part。',
      '// 两种终态：output-available（带 output）或 output-error（带 errorText）。',
      '// 只改本地状态，是否续跑由 sendAutomaticallyWhen 决定。',
    ],
  },
  {
    at: 683,
    expect: 'Output states can only retain approvals that were granted.',
    text: [
      '// 输出态只保留 "已批准" 的审批信息；错误/拒绝的审批不进入最终 tool part。',
      '// 这样 UI 不会在工具已完成后仍显示拒绝理由。',
    ],
  },
  {
    at: 730,
    expect: 'update the active response if it exists',
    text: ['// 同步活动响应中的 part，保证后续 chunk 不会覆盖刚写入的输出。'],
  },
  {
    at: 769,
    expect: 'stop = async () => {',
    text: [
      '// 停止：abort 所有准备中的消息、恢复请求与活动响应，然后等待它们完成。',
      '// 还要 drain jobExecutor：流取消可能先完成，而 onToolCall 仍阻塞在队列里。',
      '// [并发] activeStopCount 让嵌套 stop 安全；stopGeneration 使排队中的自动请求作废。',
    ],
  },
  {
    at: 799,
    expect: 'dispose = async (): Promise<void> => {',
    text: ['// 释放：先 stop，再关闭 transport 持有的资源（如长连接）。'],
  },
  {
    at: 804,
    expect: 'private async shouldSendAutomatically(',
    text: [
      '// 自动续跑判定：先排除中断消息，再调用用户函数，最后再检查一次中断状态。',
      '// 二次检查是因为用户函数可能 await，期间消息可能被标记为 interrupted。',
      '// messageId 缺省取最后一条消息；两个 id 任一被中断都拒绝续跑（INV-04）。',
      '// [失败路径] 用户函数抛错会向上传播，由调用方处理。',
    ],
  },
  {
    at: 829,
    expect: 'private async runAutomaticRequest(',
    text: [
      '// 自动请求的统一闸门：记录代际号与 "是否在 stop 期间启动"，',
      '// 若期间发生 stop 或仍在 stop 中，则直接放弃（INV-03）。',
      '// 这样即使回调在 stop 之后才排入队列，也不会偷偷发起新请求。',
      '// 真正的 request 只在校验通过后执行。',
    ],
  },
  {
    at: 853,
    expect: 'private async makeRequestForToolApproval({',
    text: [
      '// 审批专用请求：消费 pendingApprovalMessageId 时先清空，失败再恢复。',
      '// 恢复的意义：网络错误后用户重试 sendMessage() 仍能命中同一条审批消息。',
      '// 只在 status===error 且没有新的 pending 时恢复，避免覆盖后续审批。',
    ],
  },
  {
    at: 883,
    expect: 'private async makeRequest(options: MakeRequestOptions) {',
    text: [
      '// 统一包装：为每次请求创建 completionPromise，并在 impl 结束后 resolve，',
      '// 供 stop() 等待流水线真正退出（而不是只等 abort 信号）。',
    ],
  },
  {
    at: 896,
    expect: 'private async makeRequestImpl({',
    text: [
      '// 请求主流程：状态机 + 流消费 + 错误分类 + 收尾回调。',
      '// 关键顺序：先处理 resume 的重连，再置 submitted，最后创建 activeResponse。',
      '// [并发] isCurrentRequest 识别 "已被更新的 resume 请求取代" 的旧请求。',
      '// 所有 return 路径都必须清理 activeResumeRequest，避免悬挂。',
    ],
  },
  {
    at: 906,
    expect: "if (trigger !== 'resume-stream') {",
    text: ['// 非 resume 请求会作废已有的可恢复状态：新请求意味着旧断点不再有意义。'],
  },
  {
    at: 921,
    expect: 'const isCurrentRequest = () =>',
    text: [
      '// 当前请求判定：只有 resume 请求需要归属检查（同一时刻可能有多个重连尝试）。',
      '// 非 resume 请求的 activeResumeRequest 为 undefined，恒为 true。',
      '// 这让普通请求的状态写入不会被 resume 逻辑干扰。',
    ],
  },
  {
    at: 931,
    expect: 'For resume-stream, check if',
    text: [
      '// resume 先探测是否存在活动流，再决定是否置 submitted；',
      '// 否则页面加载时会出现 "submitted -> ready" 的闪烁。',
    ],
  },
  {
    at: 989,
    expect: "this.setStatus({ status: 'submitted', error: undefined });",
    text: ['// 从这里开始是真正的新请求：清除 error 并进入 submitted。'],
  },
  {
    at: 991,
    expect: 'const lastMessage = this.lastMessage;',
    text: [
      '// 定位响应消息：submit 且带 messageId 时找该消息，否则取最后一条。',
      '// 找不到（-1）时退回 lastMessage，保证响应仍可写入。',
      '// regenerate 传 undefined 时会创建全新 assistant 消息（见 1026 的三元）。',
    ],
  },
  {
    at: 1001,
    expect: 'The continued stream can start with input deltas or a tool result.',
    text: [
      '// 续流的特殊处理：若最后一条 assistant 消息还有未完成的工具 part，',
      '// 需要保留它作为 "接续目标"，让后续 result chunk 能找到对应 tool call。',
      '// 只保留 input-streaming、已执行的 input-available 与 approval-responded。',
    ],
  },
  {
    at: 1015,
    expect: 'const usesEarlierAssistantMessage =',
    text: ['// 响应消息不是最后一条时，更新要写回原位置，而不是 push 到末尾。'],
  },
  {
    at: 1026,
    expect: 'const response = {',
    text: [
      '// 构造活动响应：resume 复用 resumableStreamState；regenerate 用全新状态；',
      '// 其它情况对当前响应消息做 snapshot，避免流式写入污染历史引用。',
      '// messageId 总是新生成，保证每次响应有独立标识。',
      '// abortController 与 completionPromise 由本次请求独占。',
    ],
  },
  {
    at: 1045,
    expect: "response.abortController.signal.addEventListener('abort', () => {",
    text: ['// abort 标记用于区分 "用户主动停止" 与 "网络错误"，两者收尾语义不同。'],
  },
  {
    at: 1053,
    expect: "if (trigger === 'resume-stream') {",
    text: ['// resume 直接用重连流；其它 trigger 才调用 transport.sendMessages。'],
  },
  {
    at: 1068,
    expect: 'const runUpdateMessageJob = (',
    text: [
      '// 所有流式写入都经 jobExecutor 串行化，避免与用户回调并发改 parts。',
      '// 若请求已 abort，直接跳过，防止停止后仍写入。',
      '// write() 内部再检查一次 abort，并负责把内存消息同步到 state。',
      '// updateStatus=false 用于纯数据更新，不把状态从 submitted 改成 streaming。',
    ],
  },
  {
    at: 1091,
    expect: 'const existingMessageIndex = this.state.messages.findLastIndex(',
    text: [
      '// 优先按 id 就地替换；若响应消息是更早的 assistant 消息，',
      '// 则写回它原来的位置（usesEarlierAssistantMessage），否则追加。',
    ],
  },
  {
    at: 1120,
    expect: 'await consumeStream({',
    text: [
      '// 消费 UIMessageChunk 流：processUIMessageStream 负责协议解析与状态累积，',
      '// runUpdateMessageJob 把每次变更串行写回 state。',
      '// resume 开关让重连流可以重置旧状态，避免重复拼接。',
    ],
  },
  {
    at: 1141,
    expect: 'if (isAbort) {',
    text: ['// 正常 abort：回到 ready，并清掉对应的可恢复状态。'],
  },
  {
    at: 1157,
    expect: '} catch (err) {',
    text: [
      '// 异常收口：abort 错误不视为失败；非当前请求的异常直接丢弃。',
      '// 其余错误标记 isError，并按 TypeError 的消息文本判断是否为网络断开。',
      '// 断开时保留 resumableStreamState 供后续 resumeStream。',
    ],
  },
  {
    at: 1176,
    expect: 'if (err instanceof TypeError) {',
    text: [
      '// 网络断开的启发式判断：不同浏览器/运行时的错误文本不同，只能按关键字匹配。',
      '// 误判的代价是保留可恢复状态，但下次 resume 会自行失败并清理。',
    ],
  },
  {
    at: 1188,
    expect: 'if (isDisconnect) {',
    text: [
      '// 断开 -> 保留状态；非断开 -> 清掉该响应遗留的可恢复状态。',
      '// 只清理 "属于本次响应" 的状态，避免误删更新的 resume 结果。',
    ],
  },
  {
    at: 1199,
    expect: '} finally {',
    text: [
      '// 收尾：根据 finishReason 维护中断集合，然后调用一次 onFinish。',
      '// 中断消息加入集合，正常完成则移除（允许后续正常续跑）。',
      '// 最后清空 activeResponse 与 activeResumeRequest，但只清属于自己的。',
    ],
  },
  {
    at: 1227,
    expect: 'automatically send the message if the sendAutomaticallyWhen function returns true',
    text: [
      '// 正常结束后的自动续跑：abort/error/中断都不续跑。',
      '// 这里 await 整个自动请求，使调用方的 sendMessage/regenerate 能感知其完成。',
      '// 是否真正发送仍由 runAutomaticRequest 内部判定。',
    ],
  },
];

for (const a of anchors) {
  const idx = a.at - 1;
  if (idx < 0 || idx >= lines.length || !lines[idx].includes(a.expect)) {
    console.error(`MISS @${a.at} expect=${a.expect} actual=${lines[idx]}`);
    process.exit(1);
  }
}

for (const a of [...anchors].sort((x, y) => y.at - x.at)) {
  lines.splice(a.at - 1, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
