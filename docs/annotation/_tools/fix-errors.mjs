import fs from 'node:fs';
const p = 'd:/code/opensource/mcp-sdk/packages/client/src/ext/skills/errors.ts';
let s = fs.readFileSync(p, 'utf8');
const bad = /\/\/[^\n]*早于任何[ \t]*[\r\n]+ew SkillVerificationError。/;
if (!bad.test(s)) {
    console.error('pattern not found');
    process.exit(1);
}
s = s.replace(bad, '// `static {}` 在类定义时执行，早于任何 `new SkillVerificationError`。');
fs.writeFileSync(p, s, 'utf8');
console.log('fixed');
