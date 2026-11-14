import fs from 'node:fs';
const lines = fs
  .readFileSync('D:/code/_annot_baseline/_tmp-bgm-uncovered.txt', 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((l) => Number(l.split('\t')[1]));
const bounds = [1, 82, 619, 774, 1139, 1278, 1351, 1422, 2091, 2249, 3002, 3322, 3797, 4212, 4694, 4867, 5176, 5239, 5461];
for (let i = 0; i < bounds.length - 1; i++) {
  const a = bounds[i];
  const b = bounds[i + 1] - 1;
  const n = lines.filter((l) => l >= a && l <= b).length;
  const br = fs
    .readFileSync('D:/code/_annot_baseline/_tmp-bgm-uncovered.txt', 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter((l) => {
      const [, ln, b2] = l.split('\t');
      return Number(ln) >= a && Number(ln) <= b && b2 === 'B';
    }).length;
  console.log(`${a}-${b}\tlines=${b - a + 1}\tuncovered=${n}\tbranch=${br}`);
}
