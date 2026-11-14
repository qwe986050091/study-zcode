import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-3.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const m = s.files.find((f) => f.path.endsWith('/messages.ts'));
const fix = (from, to, before) => {
  const e = m.edits.find((x) => x.anchor === from);
  if (!e) throw new Error('missing anchor: ' + from);
  e.anchor = to;
  e.before = before;
};
fix('sessionExpiredNewTaskHint:', 'callbackFailed: "处理机器人回调失败：{message}",', false);
fix('groupTaskQueued:', 'groupTaskInteraction: "当前任务正在等待回答或审批。请先处理该交互，或使用 /停止 结束当前任务。",', true);
fix('remoteDisconnected:', 'noHistoryTasks: "当前 workspace 没有历史任务。",', false);
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('patched');
