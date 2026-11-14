// 列出未被注释紧邻的类方法声明（含缩进）：node _unc2.mjs <file>
import fs from 'node:fs';

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
	const t = lines[i];
	if (!/^\t(public |private |protected )?(async )?[A-Za-z_$][\w$]*\(/.test(t)) continue;
	if (t.trim().startsWith('if') || t.trim().startsWith('for') || t.trim().startsWith('return')) continue;
	let j = i - 1;
	while (j >= 0 && lines[j].trim() === '') j--;
	const prev = j >= 0 ? lines[j].trim() : '';
	if (!prev.startsWith('//') && !prev.startsWith('*') && !prev.endsWith('*/')) {
		console.log(`${i + 1}: ${t.trim().slice(0, 90)}`);
	}
}
