import fs from 'node:fs';

function patch(file, ops) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of ops) {
    const idx = text.indexOf(from);
    if (idx < 0) throw new Error('NOT_FOUND in ' + file + ': ' + from);
    if (text.indexOf(from, idx + 1) >= 0) throw new Error('AMBIGUOUS in ' + file + ': ' + from);
    text = text.slice(0, idx) + to + text.slice(idx + from.length);
  }
  fs.writeFileSync(file, text);
  console.log('PATCHED ' + file);
}

const session = 'd:\\code\\ZCode\\packages\\services\\src\\session\\';

patch(session + 'offPeakTask.ts', [
  ['// 删除会一并移除执行数据，不可恢复；只想隐藏历史用 deleteHistory。\r\n', ''],
]);

patch(session + 'offPeakWorkspaceIdentityMigration.ts', [
  ['// 终态任务不参与冲突判定，也不会被改写。\r\n', ''],
]);

patch(session + 'offPeakServerClient.ts', [
  [
    '        canTakeNumber: parsed.can_take_number,\r\n',
    '// 只有可取号时才没有恢复时间，用展开保证字段缺省。\r\n        canTakeNumber: parsed.can_take_number,\r\n',
  ],
]);
