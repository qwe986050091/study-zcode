import fs from 'node:fs';
// 按「文件当前行号」替换注释正文：spec = { file, lines: { "12": "新正文" } }
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
// 保留原文件行尾：CRLF 文件若被 join('\n') 重写，会整文件变成 LF。
const raw = fs.readFileSync(spec.file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);
const bad = [];
for (const [num, text] of Object.entries(spec.lines)) {
    const i = Number(num) - 1;
    const m = /^(\s*)\/\/(\s?).*$/.exec(lines[i] ?? '');
    if (!m) {
        bad.push(num);
        continue;
    }
    lines[i] = `${m[1]}// ${text}`;
}
if (bad.length) {
    console.error('not a comment line: ' + bad.join(','));
    process.exit(1);
}
fs.writeFileSync(spec.file, lines.join(eol), 'utf8');
console.log('OK replaced=' + Object.keys(spec.lines).length);
