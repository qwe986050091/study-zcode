import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:/code/opensource/ai';
const rel = 'packages/ai/src/ui/process-ui-message-stream.ts';
const file = path.join(ROOT, rel);
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const anchors = [
  {
    find: 'const lastStepStartIndex = message.parts.findLastIndex(',
    text: [
      '// findLastIndex 需要完整扫描，但只在每次响应开始时执行一次，不在热路径上。',
      '// 续流会复用同一条消息，parts 里可能残留更早响应的 step-start，',
      '//   因此必须取"最后一个"而不是第一个。',
      '// 该下标同时作为 slice 起点，+1 表示跳过 step-start 本身。',
      '// 若消息里没有任何 step-start，结果为 -1，+1 后正好从 0 开始。',
      '// 这里假设 parts 顺序即到达顺序，本层所有写入都是 push/splice，成立。',
    ],
  },
  {
    find: "case 'text-end': {",
    text: [
      '// 若同一 id 的 text-start 从未到达，这里抛错而不是补建 part：',
      '//   补建会让 UI 出现两条互不相连的文本，掩盖真正的协议问题。',
      '// 收尾后该 id 可被下一次 text-start 复用，活动表以 id 为键天然支持复用。',
      '// citations 不做增量合并，协议保证只在 end 一次性下发全量。',
      '// providerMetadata 合并放在 state 置 done 之前，保证 UI 在 done 回调里能读到新值。',
      '// 本分支不 push 新 part，只改已有 part 与活动表。',
    ],
  },
  {
    find: "case 'custom': {",
    text: [
      '// kind 由 provider 定义，本层不解释，渲染层按 kind 分派组件。',
      '// 自定义片段没有 id，因此无法去重也无法更新，只能追加。',
      '// 若协议未来需要更新语义，必须新增带 id 的 custom 变体，不能复用本分支。',
      '// providerMetadata 可为空，此时 part 上不出现该字段。',
    ],
  },
  {
    find: "case 'file':",
    text: [
      '// 两种 type 共用逻辑，但下游渲染不同：file 是用户可见的产物，',
      '//   reasoning-file 是推理过程中产生的中间文件。',
      '// 不做 mediaType 归一化，保持 provider 原值，由渲染层决定展示方式。',
      '// 该分支不写活动表：文件是一次性完整对象，没有 delta 协议。',
      '// 同名文件多次出现会生成多个 part，去重由上层按 url 处理。',
    ],
  },
  {
    find: "case 'source-url': {",
    text: [
      '// title 可缺失，UI 需回退显示域名；本层不做该推导，保持数据原样。',
      '// sourceId 用于把引用与正文中的标记关联，必须原样保留。',
      '// 与 file 不同，来源 part 通常数量多、体积小，追加成本可忽略。',
      '// 该分支在 write 之前完成 push，保证同一帧内可见。',
    ],
  },
  {
    find: "case 'source-document': {",
    text: [
      '// filename 与 title 都可能为空，渲染层自行选择展示字段。',
      '// mediaType 决定预览方式（PDF/文本/图片），不做推断。',
      '// 文档来源与 URL 来源共用 sourceId 命名空间，但 type 不同，不会互相覆盖。',
      '// 该分支同样只追加、不参与状态机。',
    ],
  },
  {
    find: "case 'reasoning-start': {",
    text: [
      '// 与 text 一样，start 时立即 push，保证推理折叠面板能马上出现。',
      '// 不同 provider 的 reasoning id 生成规则不同，本层只要求同一段内稳定。',
      '// reasoning part 上的 id 会保留到最终消息里，供 UI 记忆折叠状态。',
      '// 若与 text 同 id 也不会冲突：两张活动表彼此隔离。',
    ],
  },
  {
    find: "case 'reasoning-end': {",
    text: [
      '// reasoning 的 id 留在 part 上（text part 不保留 id），供 UI 做折叠状态记忆。',
      '// 活动表删除后该 id 不再参与拼接，但 part 本身留在消息里。',
      '// 与 text-end 一样，缺失 start 会抛错，避免产生孤立推理片段。',
      '// 这里不接收 citations：推理片段没有引用语义。',
      '// 置 done 后 providerMetadata 不再更新，迟到的元数据会被丢弃。',
    ],
  },
  {
    find: "case 'message-metadata': {",
    text: [
      '// 与 finish 分支的区别：这里不涉及 finishReason，只更新 metadata。',
      '// 合并是幂等的，重复下发相同值不会产生额外影响。',
      '// 校验失败会中断整条流，这是有意的：宁可报错也不把非法元数据交给 UI。',
      '// 仅当 metadata 非空才 write，避免空 chunk 触发渲染。',
      '// 该 chunk 可以在任意位置出现，不要求位于 start 与 finish 之间。',
    ],
  },
  {
    find: "case 'steering-message': {",
    text: [
      '// steering 的 parts 已由上层构造完成，本层不校验其内部结构。',
      '// 它不参与后续 delta 拼接，因此不登记任何活动表。',
      '// 插话位置即 part 的插入位置，UI 可据此在对话流中还原打断点。',
      '// id 只用于渲染 key，本层不做唯一性校验。',
    ],
  },
  {
    find: "case 'tool-input-available': {",
    text: [
      '// 若此前没有 tool-input-start（provider 一次性给出完整参数），',
      '//   这里走 upsert 的新建分支，等价于补建 part，因此协议允许省略 start。',
      '// partialToolCalls 不清除：某些 provider 会在 available 之后继续补 delta，',
      '//   保留累加器可避免"缺失 tool call"报错。',
      '// write() 在 onToolCall 之前，保证回调里读取 state 时已能看到完整 input。',
      '// tool-input-available 表示"参数就绪"，不是"执行完成"，两者 state 不同。',
      '// 该分支不写 rawInput：参数已可结构化，不再需要原始文本降级展示。',
      '// 若 providerExecuted 为 true，工具由 provider 侧执行，本地不做任何副作用。',
      '// 同 id 重复 available 会原地覆盖 input，以最后一次为准。',
    ],
  },
  {
    find: "case 'tool-output-available': {",
    text: [
      '// 若 part 仍是 input-streaming（跳过了 available），这里直接跳到终态，',
      '//   因此 state 迁移并不严格要求经过 input-available。',
      '// resultProviderMetadata 在此写入，与调用阶段的 callProviderMetadata 区分。',
      '// preliminary 的 part 后续还会被新的 output chunk 覆盖，',
      '//   UI 需自行判断是否展示"更新中"状态。',
      '// 该分支不清除 partialToolCalls：同一工具可能被多次调用并输出多份结果。',
      '// 输出不与已有 output 合并，整体替换，避免结构冲突。',
      '// write 之后不改动活动表，工具 part 不参与文本拼接。',
    ],
  },
  {
    find: "case 'tool-output-error': {",
    text: [
      '// 与 tool-input-error 的区别：这是"执行失败"，参数已经完整可用。',
      '// 两者终态都是 output-error，UI 通过 rawInput/errorText 的来源区分。',
      '// 动态工具不写 rawInput，因其输入不一定有原始文本形式。',
      '// errorText 必须是非空字符串，协议层保证；本层不做空值兜底。',
      '// 出错后不会再有该 toolCallId 的 output chunk，除非是重试产生的新调用。',
      '// 该分支同样不触碰活动表。',
    ],
  },
  {
    find: "case 'tool-approval-request': {",
    text: [
      '// 请求阶段不写 approved：它只属于响应阶段，提前写入会让 UI 误判已决。',
      '// descriptor 是 provider 提供的结构化审批描述，本层原样透传。',
      '// signature 用于防篡改，响应回来时需与其比对（校验在 Chat 层或服务端）。',
      '// approval.id 必须在整条消息内唯一，否则响应可能命中错误的工具。',
      '// 若工具 part 已是终态，这里仍会覆盖为 approval-requested——',
      '//   协议上不应出现，但本层不额外做状态迁移合法性校验。',
      '// 该分支只改 part，不新建：审批必须依附于已知的工具调用。',
    ],
  },
  {
    find: "case 'tool-approval-response': {",
    text: [
      '// 允许 approval 缺失时用 { id } 兜底：部分传输会丢弃原始请求信息，',
      '//   此时仍要让状态机前进，而不是抛错。',
      '// reason 只在非空时写入，避免覆盖请求阶段的 requestReason。',
      '// 不修改 input/output：审批只影响执行许可，不影响参数与结果。',
      '// 若 response 早于 request 到达，会因找不到 approvalId 而抛错（协议乱序）。',
      '// 响应只应出现一次；重复响应会覆盖 approved，以最后一次为准。',
      '// 状态置为 approval-responded 后，是否继续执行由 Chat 的自动续跑逻辑决定。',
    ],
  },
  {
    find: "case 'reset-step': {",
    text: [
      '// 常见于"重试上一步"或服务端分支回退：UI 需看到内容整体消失再重建。',
      '// 若当前 step 为空则不做任何事也不 write，避免无意义空渲染。',
      '// 回滚不触碰 message.metadata：元数据属于整条消息而非单步。',
      '// 回滚也不重置 finishReason：它只在 finish chunk 上更新。',
      '// 活动表换新后，旧表里记录的 part 引用已从 parts 中移除，不会泄漏到 UI。',
      '// step-start part 本身保留，作为后续内容的新边界。',
    ],
  },
  {
    find: "case 'start': {",
    text: [
      '// 重置与改名是两件独立的事：重置清空内容，改名只换 id，二者可同时发生。',
      '// 若既不重置也不带 id/metadata，则完全不 write：合并流的后续 start',
      '//   常是空壳，避免因此触发多余渲染。',
      '// 重置后 message 引用不变，但 parts 被换成新数组——',
      '//   缓存旧 parts 引用的下游需要重新读取。',
      '// messageMetadata 在重置之后应用，保证重放携带的初始元数据不会丢。',
      '// 重置时 lastMessage 传 undefined，不继承任何历史 part。',
      '// 该分支是异步的（metadata 校验），因此整个 transform 也必须是 async。',
      '// 首帧 start 若不带任何字段，仅把 isFirstMessageStart 置 false，无副作用。',
      '// 不能在重置时清空 interruptedMessageIds 之类的消息级标记：',
      '//   那是 Chat 的状态，不在本文件的职责范围内。',
    ],
  },
  {
    find: "case 'finish': {",
    text: [
      '// finish 不关闭活动 part：协议要求显式 end chunk，缺失属于上游缺陷；',
      '//   错误收尾时允许残留 streaming 态，UI 需容忍。',
      '// finishReason 只写不改：先到的值优先，避免重复 finish 覆盖。',
      '// metadata 与 finishReason 可在同一个 chunk 里出现，处理顺序不影响结果。',
      '// 该分支不 write 状态：状态推进由 Chat 在流关闭后统一处理。',
      '// 若 finish 缺失，state.finishReason 保持 undefined，Chat 据此视为异常结束。',
    ],
  },
];

for (const a of anchors) {
  const hits = lines.reduce((acc, line, i) => (line.includes(a.find) ? [...acc, i] : acc), []);
  if (hits.length !== 1) {
    console.error(`HITS ${hits.length} for: ${a.find}`);
    process.exit(1);
  }
  a.idx = hits[0];
}

for (const a of [...anchors].sort((x, y) => y.idx - x.idx)) {
  lines.splice(a.idx, 0, ...a.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', anchors.reduce((s, a) => s + a.text.length, 0));
