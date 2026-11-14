import fs from 'node:fs';

const file = 'd:/code/opensource/ai/packages/ai/src/ui/validate-ui-messages.ts';
const lines = fs.readFileSync(file, 'utf8').split('\r\n');

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

const edits = [];

function insertVariant(group, state, text) {
  const found = variants.filter(v => v.group === group && v.state === state);
  if (found.length !== 1) {
    console.error(`VARIANT ${group}/${state} hits ${found.length}`);
    process.exit(1);
  }
  edits.push({ idx: found[0].idx, text });
}

insertVariant('dynamic-tool', 'input-available', [
  '// 参数就绪但未执行：此时 output 必须缺席，否则会出现"未执行却有结果"。',
]);

insertVariant('dynamic-tool', 'approval-requested', [
  '// 待审批：input 必填（审批人据以判断），signature 可用于防篡改校验。',
]);

insertVariant('dynamic-tool', 'approval-responded', [
  '// 已响应但未执行：approved 必填，output 仍被禁止，等待本地执行。',
]);

insertVariant('tool-', 'input-streaming', [
  '// 参数流式中：input 可选（可能还没解析出任何字段），rawInput 保存原始文本。',
]);

insertVariant('tool-', 'approval-responded', [
  '// 已响应：此处不区分批准/拒绝，两者都等待执行阶段给出终态。',
]);

const uniqueIdx = (needle) => {
  const hits = lines.reduce((acc, l, i) => (l.includes(needle) ? [...acc, i] : acc), []);
  if (hits.length !== 1) {
    console.error(`HITS ${hits.length}: ${needle}`);
    process.exit(1);
  }
  return hits[0];
};

edits.push({
  idx: uniqueIdx('const tool = tools == null ? undefined : getOwn(tools, toolName);'),
  text: [
    '// 用 getOwn 读取工具而非 tools[toolName]：工具名可能撞上原型链属性，',
    '//   直接下标会让 toString 之类的键命中内置方法并产生离奇的行为。',
    '// 找不到工具时此处为 undefined，后续按"是否终态"分流。',
    '// 该判定只做一次，后面分支不再重复查询工具表。',
  ],
});

edits.push({
  idx: uniqueIdx('data: validatedMessages as Array<UI_MESSAGE>,'),
  text: [
    '// 走到这里说明三个阶段全部通过；类型断言是安全的，因为前面的校验已把',
    '//   形状收敛到 UIMessage，且调用方给出的泛型只是收窄 metadata/data/tools。',
    '// 返回的是校验后的新对象树，与入参不是同一引用。',
  ],
});

edits.push({
  idx: uniqueIdx('const err = error as Error;'),
  text: [
    '// 任何阶段抛出的错误都在此被收敛为 { success: false }，',
    '//   保持 safe 版本"不抛异常"的契约；非 Error 值统一包装。',
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
