import fs from 'node:fs';
const root = 'D:/code/ZCode/';
const files = fs.readFileSync('ZC-deep-b74-files.txt', 'utf8').trim().split(/\r?\n/);
for (const f of files) {
  const lines = fs.readFileSync(root + f, 'utf8').split(/\r?\n/);
  console.log('== ' + f);
  console.log(lines.slice(0, 3).join('\n'));
  console.log(lines.slice(19, 22).join('\n'));
}
