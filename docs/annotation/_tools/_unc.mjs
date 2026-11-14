// 列出未被注释紧邻的函数/常量声明行：node _unc.mjs <file>
import fs from 'node:fs';

const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
	const t = lines[i];
	if (!/^(export )?(async )?(function|class|const|let) [A-Za-z_$]/.test(t)) continue;
	let j = i - 1;
	while (j >= 0 && lines[j].trim() === '') j--;
	const prev = j >= 0 ? lines[j].trim() : '';
	if (!prev.startsWith('//') && !prev.startsWith('*') && !prev.endsWith('*/') && !prev.endsWith('{')) {
		console.log(`${i + 1}: ${t.slice(0, 100)}`);
	}
}
