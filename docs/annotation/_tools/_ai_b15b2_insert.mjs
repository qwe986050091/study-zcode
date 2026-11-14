import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/ui/validate-ui-messages.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

const edits = [];

// 1) 按 marker 定位，插入到它所属的 z.object({ 之前
function insertBeforeObjectWith(marker, text) {
  const hits = lines.reduce((acc, l, i) => (l.includes(marker) ? [...acc, i] : acc), []);
  if (hits.length !== 1) {
    console.error(`MARKER HITS ${hits.length}: ${marker}`);
    process.exit(1);
  }
  let idx = hits[0];
  while (idx >= 0 && !lines[idx].includes('z.object({')) idx--;
  if (idx < 0) {
    console.error('NO z.object BEFORE ' + marker);
    process.exit(1);
  }
  edits.push({ idx, text });
}

// 2) 按 (group, state) 定位变体
const variants = [];
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes('z.object({')) continue;
  let group = null;
  let state = null;
  for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
    if (lines[j].includes("type: z.literal('dynamic-tool'),")) group = 'dynamic-tool';
    if (lines[j].includes("type: z.string().startsWith('tool-'),")) group = 'tool-';
    const m = lines[j].match(/state: z\.literal\('([a-z-]+)'\)/);
    if (m) state = m[1];
  }
  if (group && state) variants.push({ group, state, idx: i });
}

function insertVariant(group, state, text) {
  const found = variants.filter(v => v.group === group && v.state === state);
  if (found.length !== 1) {
    console.error(`VARIANT ${group}/${state} hits ${found.length}`);
    process.exit(1);
  }
  edits.push({ idx: found[0].idx, text });
}

insertBeforeObjectWith("type: z.literal('custom'),", [
  '// 自定义片段没有 id，因此只能追加、不能更新；kind 由 provider 定义，本层不解释。',
  '// 若将来需要可更新的自定义内容，必须新增带 id 的变体，不能复用本分支。',
  '// providerMetadata 可选，缺失时 part 上不出现该字段。',
]);

insertBeforeObjectWith("type: z.literal('steering-message'),", [
  '// 插话片段的内部只允许 text 与 file，不允许嵌套工具或数据片段：',
  '//   插话发生在两步之间，不能携带需要执行的副作用。',
  '// id 只用于渲染 key，本层不做唯一性校验。',
]);

insertVariant('dynamic-tool', 'output-available', [
  '// 有输出即终态：preliminary 为真表示输出可能还会被覆盖，但 part 已可渲染。',
  '// approval 用 granted 版本，保证"有输出"与"已批准"在数据上一致。',
]);

insertVariant('dynamic-tool', 'output-error', [
  '// 错误终态：input 与 rawInput 都可缺失，因为失败可能发生在参数解析之前。',
  '// errorText 必填且为字符串，是唯一允许把错误文本直接暴露给 UI 的通道。',
]);

insertVariant('dynamic-tool', 'output-denied', [
  '// 拒绝终态：必须带 denied 版本的 approval，且不允许 output/errorText。',
]);

insertVariant('tool-', 'input-available', [
  '// 参数就绪：input 从可选变为必填，output 与 errorText 被禁止。',
]);

insertVariant('tool-', 'approval-requested', [
  '// 待审批：input 必填（审批人需要看到将要执行什么），output 必须缺席。',
]);

insertVariant('tool-', 'output-available', [
  '// 有输出：preliminary 允许为真，表示这是中间结果，后续还会覆盖。',
]);

insertVariant('tool-', 'output-error', [
  '// 执行失败：input 可缺失，但 errorText 必填，保证 UI 有可展示的原因。',
]);

insertVariant('tool-', 'output-denied', [
  '// 主动拒绝：与 output-error 的区别是没有错误文本，只有审批理由。',
]);

edits.push({
  idx: lines.findIndex(l => l.includes('if (metadataSchema) {')),
  text: [
    '// metadata 校验是逐条就地写回，失败即整批失败（不跳过该条）。',
    '// 上下文字段带 messages[i].metadata，便于调用方定位是哪条消息出错。',
  ],
});

edits.push({
  idx: lines.findIndex(l => l.includes('if (toolPart.state === \'output-available\' && tool.outputSchema) {')),
  text: [
    '// 输出校验只在"有输出且声明了 outputSchema"时进行；',
    '//   输出错误不走这里——错误的形状由 errorText 约束，不需要额外 schema。',
  ],
});

edits.push({
  idx: lines.findIndex(l => l.includes('warnIfUIMessageHasDeprecatedRawInput(validatedMessages);')),
  text: [
    '// 告警在形状校验之后、深度校验之前：此时数据已可信，告警不会误报。',
  ],
});

for (const e of edits) {
  if (e.idx < 0) {
    console.error('IDX NOT FOUND');
    process.exit(1);
  }
}

for (const e of [...edits].sort((x, y) => y.idx - x.idx)) {
  lines.splice(e.idx, 0, ...e.text);
}

fs.writeFileSync(file, lines.join('\r\n'));
console.log('ADDED', edits.reduce((s, e) => s + e.text.length, 0));
