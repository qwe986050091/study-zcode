import { execSync } from 'node:child_process';

const REPO = 'd:/code/opensource/gemini-cli';
const diff = execSync('git -C "' + REPO + '" diff -U0 -- .', {
  maxBuffer: 1024 * 1024 * 128,
  encoding: 'utf8',
});

let file = null;
let added = 0;
let bad = [];
let slashStar = [];

for (const raw of diff.split('\n')) {
  if (raw.startsWith('+++ b/')) {
    file = raw.slice(6).trim();
    continue;
  }
  if (raw.startsWith('+') && !raw.startsWith('+++')) {
    const body = raw.slice(1);
    added++;
    if (body.trim() === '') continue;
    if (/^\s*\/\//.test(body)) {
      if (body.includes('*/')) slashStar.push(file + ' :: ' + body.trim());
      continue;
    }
    bad.push(file + ' :: ' + body);
  }
}

console.log('addedLines=' + added);
console.log('nonCommentAdded=' + bad.length);
bad.slice(0, 30).forEach((x) => console.log('BAD  ' + x));
console.log('commentWithStarSlash=' + slashStar.length);
slashStar.slice(0, 30).forEach((x) => console.log('SLASH ' + x));
