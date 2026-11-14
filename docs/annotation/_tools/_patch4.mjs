import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/spec-b3b-4.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const f = s.files.find((x) => x.path.endsWith('/channelReply.ts'));
const e = f.edits.find((x) => x.anchor === 'else parts = resolveChannelReplyParts(request.parts, binding.trusted);');
e.anchor = '} else parts = resolveChannelReplyParts(request.parts, binding.trusted);';
fs.writeFileSync('d:/code/_annot_baseline/spec-b3b-4b.json', JSON.stringify({ files: [f] }, null, 2));
console.log('ok');
