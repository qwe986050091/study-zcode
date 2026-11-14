import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-5.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const f = s.files[0];
f.edits = f.edits.filter((e) => e.anchor !== 'return null;');
const owner = f.edits.find((e) => e.anchor === 'const currentOwner = await readBotRuntimeLockOwner(lockPath);');
owner.anchor = 'if (currentOwner) {';
const stale = f.edits.find((e) => e.anchor === 'await removeBotRuntimeLockPath(lockPath);');
stale.anchor = '// Bugfix：陈旧目录可能短暂被 Windows 文件句柄占用；有限重试后再放弃，避免静默残留。';
f.edits.push({
  anchor: 'await writeFile(join(pendingLockPath, `lease-${owner.nonce}`), "");',
  before: true,
  lines: ['      // 空的 lease 文件只需存在，续租靠 mtime。']
});
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('edits=' + f.edits.length);
