// 建立批次基线：node _mkbase.mjs <Bnn> <rel1> <rel2> ...
// 从 HEAD 取出原文件，统一写成 CRLF，落到 D:/code/_annot_baseline/<Bnn>/orig/，并写 _files.txt。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/opensource/drizzle-orm';
const [batch, ...files] = process.argv.slice(2);
if (!batch || !files.length) {
	console.error('usage: node _mkbase.mjs <Bnn> <rel...>');
	process.exit(2);
}
for (const f of files) {
	const dest = path.join('D:/code/_annot_baseline', batch, 'orig', f);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	let text = execSync('git show HEAD:' + f, { cwd: ROOT, encoding: 'utf8' });
	text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
	fs.writeFileSync(dest, text);
}
fs.writeFileSync(path.join('D:/code/_annot_baseline', batch, '_files.txt'), files.join('\n') + '\n');
console.log('baseline ok', batch, files.length);
