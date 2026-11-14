// Move each inserted comment block above the contiguous run of doc-comments / attributes
// that it currently sits below. Only touches lines that were inserted by the spec.
import fs from 'node:fs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const entry = spec[0];
const target = 'd:\\code\\opensource\\uv\\' + entry.file.replace(/\//g, '\\');
const original = fs.readFileSync(target, 'utf8');
const hadTrailingNewline = original.endsWith('\n');
let lines = original.split('\n');
if (hadTrailingNewline) lines.pop();

let moved = 0;
for (const item of entry.items) {
  const indent = (/^[ \t]*/.exec(item.anchor) || [''])[0];
  const text = item.lines.map((l) => (l === '' ? `${indent}//` : `${indent}// ${l}`));
  let blockStart = -1;
  for (let i = 0; i + text.length <= lines.length; i++) {
    if (text.every((t, k) => lines[i + k].replace(/\r$/, '') === t)) {
      // must be immediately followed by the anchor line (or be a unique match)
      if (lines[i + text.length].replace(/\r$/, '') === item.anchor) {
        blockStart = i;
        break;
      }
    }
  }
  if (blockStart < 0) {
    console.error('MISS block for anchor: ' + JSON.stringify(item.anchor));
    continue;
  }
  let top = blockStart;
  while (top > 0) {
    const prev = lines[top - 1].trim();
    if (prev.startsWith('///') || prev.startsWith('#')) {
      top -= 1;
    } else {
      break;
    }
  }
  if (top === blockStart) continue;
  const block = lines.splice(blockStart, text.length);
  lines.splice(top, 0, ...block);
  moved += 1;
}

if (lines.length !== original.split('\n').length - (hadTrailingNewline ? 1 : 0)) {
  console.error('FAIL line count changed');
  process.exit(1);
}
fs.writeFileSync(target, lines.join('\n') + (hadTrailingNewline ? '\n' : ''));
console.log(`MOVED ${moved}`);
