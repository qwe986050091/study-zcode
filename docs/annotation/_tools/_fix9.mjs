import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-9.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const edits = j.files[0].edits;
const i = edits.findIndex((e) => e.anchor === '} catch (error) {');
edits.splice(i, 1);
const m = edits.find((e) => e.anchor.startsWith('message: `Weixin polling failed'));
m.lines = [
  '// 拉取/解析/回调任一失败都落到这里：置 error 状态后退避重试，锁在 finally 释放。',
  '// 游标停在上一次成功位置，未确认的消息会在下一轮重投（at-least-once）。',
  '// 不用指数退避，是因为 Weixin 侧限流窗口固定，5s 足够避开瞬时故障。',
  '// 错误摘要直接展示到 UI，不包含 token 或消息正文。',
];
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('patched, edits=' + edits.length);
