import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/realtime/realtime-event-reducer.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const edits = [
  {
    needle: '//   INV-01 reduceServerEvent 不得就地修改入参 state，所有变更都经 nextState 替换。',
    text: [
      "// 【坑】两个容易忽略的点：",
      "//   1) textAccumulators 与 itemIdToPartLocation 必须成对清理，只清一个会让后续",
      "//      同 itemId 的 delta 追加到已收尾的旧 part 上；",
      "//   2) currentAssistantMessageId 只在 response/speech 边界清空，若忘记清空，",
      "//      下一轮响应会静默混入上一条消息，且从 UI 上几乎看不出来。",
    ],
  },
  {
    needle: 'addToolOutput(',
    text: [
      "// 该方法是唯一允许从外部（工具执行器）反向写入 reducer 状态的入口。",
      "// 它不改 currentAssistantMessageId：工具结果不产生新的 assistant 消息。",
    ],
  },
  {
    needle: 'setStatus(state: RealtimeState, status: RealtimeStatus): RealtimeState {',
    text: [
      "// 三个 setter 都不做深拷贝：messages/events 数组由各自的操作保证不可变。",
      "// 若调用方在 setStatus 之后又用旧 state 计算，旧引用依然有效（不会被改）。",
      "// 这是有意为之：reducer 的输出可以安全地存入 React state 历史。",
      "// 不要在这些 setter 里做副作用（如关闭连接），副作用应走 effects。",
    ],
  },
  {
    needle: 'private pushEvent(',
    text: [
      "// 事件缓冲纯粹用于调试与回放，丢旧事件不影响任何业务状态。",
    ],
  },
];

for (const e of edits) {
  const hits = lines.reduce((acc, l, i) => (l.includes(e.needle) ? [...acc, i] : acc), []);
  if (hits.length !== 1) {
    console.error(`HITS ${hits.length}: ${e.needle}`);
    process.exit(1);
  }
  e.idx = hits[0];
}

for (const e of [...edits].sort((x, y) => y.idx - x.idx)) {
  lines.splice(e.idx, 0, ...e.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', edits.reduce((s, e) => s + e.text.length, 0));
