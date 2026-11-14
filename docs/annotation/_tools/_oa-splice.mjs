// 按 1-based 行号区间替换为给定文本块（用于清理重复注释，不碰代码）。
import fs from 'node:fs';

const FILE = 'd:/code/ZCode/packages/services/src/oauth/oauthService.ts';
const [start, end] = [Number(process.argv[2]), Number(process.argv[3])];
const block = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const lines = fs.readFileSync(FILE, 'utf8').split('\n');
lines.splice(start - 1, end - start + 1, ...block);
fs.writeFileSync(FILE, lines.join('\n'));
console.log('replaced', end - start + 1, 'lines with', block.length);
