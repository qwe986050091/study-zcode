import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/opensource/drizzle-orm';
const files = [
	'drizzle-orm/src/mysql-core/columns/double.ts',
	'drizzle-orm/src/mysql-core/columns/float.ts',
	'drizzle-orm/src/mysql-core/columns/json.ts',
];
for (const f of files) {
	const dest = path.join('D:/code/_annot_baseline/B110/orig', f);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	let text = execSync('git show HEAD:' + f, { cwd: ROOT, encoding: 'utf8' });
	text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
	fs.writeFileSync(dest, text);
}
fs.writeFileSync('D:/code/_annot_baseline/B110/_files.txt', files.join('\n') + '\n');
console.log('baseline ok');
