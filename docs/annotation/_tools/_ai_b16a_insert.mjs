import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/realtime/realtime-event-reducer.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    at: 0,
    expect: 'import {',
    text: [
      "// 【职责】实时语音会话的事件归约器：把服务端 RealtimeServerEvent 折叠成 RealtimeState",
      "//   （消息列表 + 状态 + 事件缓冲），并把需要外部执行的副作用以 effects 返回。",
      "//",
      "// 【在链路中的位置】上游是 realtime-session（WebSocket 收帧）；下游是 React 侧的",
      "//   渲染与工具执行器（消费 tool-call effect）。",
      "//",
      "// 【不变量】",
      "//   INV-01 reduceServerEvent 不得就地修改入参 state，所有变更都经 nextState 替换。",
      "//     守住位置：每个分支的 nextState = this.xxx(nextState, ...)。",
      "//   INV-02 文本与工具参数按 itemId / callId 累加，绝不能按消息下标累加。",
      "//     守住位置：textAccumulators 与 toolArgAccumulators。",
      "//   INV-03 part 位置一旦登记就固定，后续 delta 只更新不新增。",
      "//     守住位置：itemIdToPartLocation 只在首次追加时写入。",
      "//   INV-04 副作用不得直接执行，必须放进 effects 由调用方执行。",
      "//     守住位置：audio-delta、tool-call、error 三处 push。",
      "//   INV-05 参数解析失败不能让整条会话中断，只能产出 error effect。",
      "//     守住位置：function-call-arguments-done 的 parseResult.success 分支。",
    ],
  },
  {
    find: 'export type RealtimeStatus =',
    text: [
      "// 会话状态机：disconnected → connecting → connected → closing → disconnected。",
      "// error 是可由任意状态进入的分支；本文件只负责迁移到 connected 这一步。",
      "// 其余迁移由调用方（useRealtime / session 生命周期）显式设置。",
      "// 不要在此枚举里加中间态：UI 依赖这五个值做渲染分支。",
    ],
  },
  {
    find: 'export interface RealtimeState {',
    text: [
      "// events 是调试用的近期事件缓冲（默认 500 条），不参与渲染决策。",
      "// session 是底层会话句柄，未连接时为空。",
      "// messages 与 events 都以不可变方式替换，便于 React 做引用比较。",
      "// isCapturing/isPlaying 是麦克风与播放器的即时状态，与 status 独立。",
    ],
  },
  {
    find: 'export type RealtimeReducerEffect =',
    text: [
      "// 归约器不能自己做 I/O，因此把需要外部动作的部分抽成 effect：",
      "//   play-audio 交给音频播放器，speech-started 用于打断本地播放，",
      "//   tool-call 交给工具执行器，error 交给上层展示。",
      "// effect 的顺序与事件顺序一致，调用方按序消费，不要并行。",
      "// 同一事件可能产生多个 effect（例如解析失败同时推进状态与报错）。",
      "// tool-call 的 args 是解析后的对象，rawArguments 保留原始文本用于排错。",
    ],
  },
  {
    find: 'export type RealtimeToolOutput = {',
    text: [
      "// 工具执行完成后回传给服务端的载荷：只回传字符串化结果。",
      "// name 取自缓存的调用名，可能为空（调用名在 done 事件才到达）。",
    ],
  },
  {
    find: 'export function createInitialRealtimeState(): RealtimeState {',
    text: [
      "// 初始状态不带 session/events：连接建立后由 setStatus 与事件流填充。",
    ],
  },
  {
    find: 'export class RealtimeEventReducer {',
    text: [
      "// 所有累加器都是跨事件的私有状态，生命周期与 reducer 实例一致。",
      "// currentAssistantMessageId 是当前正在流式输出的 assistant 消息：",
      "//   服务端一次只允许一个活动响应，因此单个 id 足够。",
      "// textAccumulators 按 itemId 累积文本：delta 只带增量，必须自己拼。",
      "// toolArgAccumulators 按 callId 累积参数 JSON 片段。",
      "// toolCallIdToMessageId/Name 让之后到达的输出能回到正确的消息与工具名。",
      "// inputAudioMessageInsertIndex 记录输入音频提交时刻的消息位置，",
      "//   用于把转写结果插回用户说话的那个时间点，而不是追加到末尾。",
      "// itemIdToPartLocation 是增量更新的定位表，避免每次 delta 都线性搜索。",
    ],
  },
  {
    find: 'constructor(private readonly maxEvents = 500) {}',
    text: [
      "// maxEvents 控制事件缓冲上限，超出后丢弃最旧的。",
      "// 只有 events 受限；messages 不设上限，由调用方按会话长度清理。",
      "// 累加器不在此初始化：字段声明处已给出空 Map。",
      "// 500 是经验值，仅影响调试面板，不影响对话正确性。",
    ],
  },
  {
    find: 'setStatus(state: RealtimeState, status: RealtimeStatus): RealtimeState {',
    text: [
      "// 三个 setter 都是浅合并，只改目标字段，其余部分保持同一引用。",
      "// 这样 React 只在相关字段变化时重渲染，不要改成整体重建 state。",
      "// 状态迁移的合法性校验不在这里做，由调用方保证。",
    ],
  },
  {
    find: 'addUserTextMessage(state: RealtimeState, text: string): RealtimeState {',
    text: [
      "// 用户主动输入单独成一条 user 消息，state 直接置 done。",
      "// id 用 Date.now()，同一毫秒内可能重复——实际输入间隔远大于 1ms，暂不引入计数器。",
      "// 该消息不进入 itemId 定位表：它不来自服务端事件，不会有后续 delta。",
      "// 追加而非插入：用户输入按发生顺序排在对话末尾。",
    ],
  },
  {
    find: 'addToolOutput(',
    text: [
      "// 工具执行结果的本地回填：把 part 推到 output-available，并给出回传载荷。",
      "// output 的 name 可能为 undefined（调用名尚未到达），调用方需容忍。",
      "// JSON.stringify 可能抛错（循环引用），此处不捕获，由调用方处理。",
      "// 找不到对应调用时 updateToolPartState 返回原 state，但 output 仍会生成。",
    ],
  },
  {
    find: 'async reduceServerEvent(',
    text: [
      "// 归约主入口：先无条件记录事件（便于调试），再按类型分派。",
      "// 返回新的 state 与本次新增的 effects；本函数不修改入参。",
      "// switch 没有 default：未识别的事件只进缓冲，不改变状态——",
      "//   这是为兼容服务端新增事件类型，不应因此报错。",
      "// 归约基本同步，唯一 await 在参数解析，因此事件处理顺序有保证。",
      "// 外层若并发调用同一 reducer，私有累加器会竞争；调用方必须串行。",
      "// effects 不含历史，调用方应逐条消费且只消费一次。",
      "// 状态推进统一用 nextState 变量，避免误改原始 state。",
    ],
  },
  {
    find: "case 'session-created':",
    text: [
      "// 建连/改配置成功：只有处于 connecting 时才迁移到 connected，",
      "//   避免重复事件把已连接状态再推一次。",
    ],
  },
  {
    find: "case 'audio-delta':",
    text: [
      "// 音频增量只产出 effect，不进 messages：播放由外部音频管线负责。",
      "// itemId 让播放器把同一段的多个 delta 拼成连续流。",
    ],
  },
  {
    find: "case 'audio-committed':",
    text: [
      "// 输入音频提交完成：记下此刻的消息数量作为插入锚点。",
      "// 之后到达的转写会插到这个位置，从而出现在用户发言的时间点。",
      "// 锚点是当时的长度，后续插入会让它失效，因此只使用一次。",
    ],
  },
  {
    find: "case 'audio-transcript-delta':",
    text: [
      "// 两种 delta 共用累加逻辑：用户转写与助手文本在结构上一致。",
      "// itemId 是该段内容的稳定标识，同一 item 的所有 delta 必须落到同一 part。",
    ],
  },
  {
    find: "case 'audio-transcript-done':",
    text: [
      "// 收尾用事件携带的完整文本覆盖累加值，随后清理累加器与定位表。",
      "// 以服务端文本为准：本地累加可能因丢帧而不完整。",
    ],
  },
  {
    find: "case 'input-transcription-completed':",
    text: [
      "// 用户语音的最终转写：按 itemId 去重后插入或更新。",
      "// 与 text-delta 路径分开，因为它的位置由 audio-committed 决定。",
    ],
  },
  {
    find: "case 'response-created':",
    text: [
      "// 响应结束或新响应开始：清空当前 assistant 指针，",
      "//   下一个文本/工具事件会创建新消息，而不是继续往旧消息追加。",
    ],
  },
  {
    find: "case 'speech-started':",
    text: [
      "// 助手开始说话：除清指针外还产出 speech-started，供调用方打断本地播放。",
    ],
  },
  {
    find: "case 'function-call-arguments-delta':",
    text: [
      "// 工具参数以 JSON 片段流式到达，必须先建占位 part 再累积。",
      "// assistant 消息在这里才被创建（延迟到真正有内容时）。",
      "// 占位 dynamic-tool 的 toolName 为空：名字要等 done 事件才可信。",
      "// ensureToolPart 幂等，重复 delta 不会产生多个 part。",
      "// 累积键是 callId，不是 itemId：工具调用与文本是两条独立通道。",
      "// 该分支不产出 effect：参数尚未完整，无可执行内容。",
    ],
  },
  {
    find: "case 'function-call-arguments-done':",
    text: [
      "// 参数结束：此时 event.arguments 是完整 JSON，用它覆盖式解析。",
      "// 解析失败不抛错：part 仍推进到 input-available（input 为空对象），",
      "//   同时产出 error effect，让 UI 展示参数解析失败而不是中断整条流。",
      "// 累加器在解析前就删除：即使解析失败也不该继续累积。",
      "// toolCallIdToName 只在这里写入，因此在此之前 addToolOutput 的 name 为空。",
      "// messageId 缺失说明 delta 阶段没建过 part（协议异常），此时只报 error。",
      "// 成功时产出 tool-call effect，由调用方执行真正的工具。",
    ],
  },
  {
    find: "case 'error':",
    text: [
      "// 服务端错误转为 effect，不改变 status：连接可能仍然可用。",
      "// 是否需要断开由调用方的 effect 处理器决定，本层不做假设。",
    ],
  },
  {
    find: 'private pushEvent(',
    text: [
      "// 追加事件并按 maxEvents 截断：slice(-max) 而非 shift，避免逐条搬移。",
      "// 返回新数组，保证 React 能感知变化。",
    ],
  },
  {
    find: 'private getOrCreateAssistantMessage(',
    text: [
      "// 懒创建 assistant 消息：只有第一个内容事件到达时才建，避免空占位。",
      "// id 用时间戳 + 4 位随机串，降低同一毫秒内的碰撞概率。",
      "// 创建后立即缓存到 currentAssistantMessageId，后续事件复用。",
      "// 返回新 state 与新 id，调用方必须用返回值替换 nextState。",
      "// 该函数不检查消息是否已存在：指针为空就一定新建，这是有意的简化。",
    ],
  },
  {
    find: 'private addInputTranscriptionMessage(',
    text: [
      "// 已存在同 id 消息时整体替换 parts：转写可能分多次完成，最后一次为准。",
      "// 插入位置取 audio-committed 记录的锚点，并夹在 [0, length] 内，",
      "//   防止并发缩短消息列表后 splice 越界。",
      "// 用 splice 而非 push：转写要出现在用户说话的位置。",
      "// 插入后不回写锚点：同一条音频只插入一次。",
      "// 消息 id 用 user-<itemId>，与 addUserTextMessage 的 user-<时间戳> 不冲突。",
    ],
  },
  {
    find: 'private appendTextDelta(',
    text: [
      "// 文本增量：先拼接，再决定更新已有 part 还是新建。",
      "// 已登记位置说明该 item 有正在流式的 part，直接原地替换。",
      "// 新建分支在 push 之前登记下标，保证记录与最终数组一致。",
      "// 只修改目标消息，其余消息保持同一引用，缩小渲染范围。",
      "// 累加器在定位表之前更新：即使定位丢失，文本也不会回退。",
    ],
  },
  {
    find: 'private finalizeText(',
    text: [
      "// 收尾：优先用事件携带的完整文本，缺失时回退到本地累加值。",
      "// 无定位记录说明没有对应 part（例如只有 done 没有 delta），直接返回原 state。",
      "// 清理必须在更新之前完成，避免中途异常留下脏定位。",
      "// 置 state=done 后该 part 不再接受增量。",
      "// 该函数不产出 effect：文本收尾纯属状态变更。",
    ],
  },
  {
    find: 'private ensureToolPart(',
    text: [
      "// 按 callId 查找已有 dynamic-tool part，存在则原样返回（幂等）。",
      "// 不存在时追加空占位：toolName 为空、input 为 undefined，",
      "//   等 done 事件再用真实数据填充。",
      "// 只扫描目标消息，不跨消息查找：调用必然属于当前 assistant 消息。",
      "// state 固定为 input-streaming，与 UI 协议的状态机一致。",
    ],
  },
  {
    find: 'private markToolInputAvailable(',
    text: [
      "// 参数就绪：写入真实工具名与解析后的 input，state 迁移到 input-available。",
      "// 找不到同 callId 的 part 时 map 不匹配即原样返回，不补建。",
      "// 这里不校验 input 是否符合工具 schema，校验发生在工具执行侧。",
    ],
  },
  {
    find: 'private updateToolPartState(',
    text: [
      "// 本地工具执行完成：把 part 推到 output-available 并写入结果。",
      "// 输出不做 schema 校验，由调用方的工具定义保证。",
      "// 消息或 part 已不存在时静默返回原 state。",
      "// 不写 errorText：失败路径由调用方以 error effect 表达。",
    ],
  },
  {
    find: 'private updateMessagePart(',
    text: [
      "// 替换指定下标的 part：先复制 parts 数组再赋值，不修改原数组。",
      "// 只替换整段 part，不做字段合并——调用方负责传入完整对象。",
      "// 下标越界会扩展数组并留下空洞，调用方必须保证 partIndex 有效。",
    ],
  },
];

for (const a of anchors) {
  if (a.at !== undefined) {
    if (!lines[a.at].includes(a.expect)) {
      console.error(`EXPECT FAIL at ${a.at}: ${lines[a.at]}`);
      process.exit(1);
    }
    a.idx = a.at;
  } else {
    const hits = lines.reduce((acc, line, i) => (line.includes(a.find) ? [...acc, i] : acc), []);
    if (hits.length !== 1) {
      console.error(`HITS ${hits.length} for: ${a.find}`);
      process.exit(1);
    }
    a.idx = hits[0];
  }
}

for (const a of [...anchors].sort((x, y) => y.idx - x.idx)) {
  lines.splice(a.idx, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
