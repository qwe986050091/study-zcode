import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const depthAtStart = new Array(src.length).fill(0);
let depth = 0, inBlock = false;
for (let i = 0; i < src.length; i++) {
  depthAtStart[i] = depth;
  const s = src[i];
  let j = 0;
  while (j < s.length) {
    if (inBlock) { const e = s.indexOf('*/', j); if (e === -1) { j = s.length; break; } inBlock = false; j = e + 2; continue; }
    if (s[j] === '/' && s[j + 1] === '*') { inBlock = true; j += 2; continue; }
    if (s[j] === '"' || s[j] === "'") { const q = s[j]; j++; while (j < s.length && s[j] !== q) { if (s[j] === '\\') j++; j++; } j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}') depth--;
    j++;
  }
}
const funcs = [];
for (let i = 0; i < src.length; i++) {
  if (depthAtStart[i] !== 0) continue;
  const line = src[i];
  if (!line.trim()) continue;
  if (/^\s/.test(line)) continue;
  if (/^(#|\}|\/\*|\*|\/\/)/.test(line)) continue;
  let braceLine = -1;
  for (let k = i; k < Math.min(src.length, i + 12); k++) {
    if (src[k].includes('{')) { braceLine = k; break; }
    if (src[k].trim().endsWith(';')) break;
  }
  if (braceLine === -1) continue;
  const head = src.slice(i, braceLine + 1).join(' ');
  if (!head.includes('(')) continue;
  let name = '';
  for (let k = braceLine; k >= i && !name; k--) {
    const cut = src[k].indexOf('{') === -1 ? src[k].length : src[k].indexOf('{');
    const ms = [...src[k].slice(0, cut).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
    if (ms.length) name = ms[ms.length - 1][1];
  }
  if (!name) continue;
  let end = braceLine;
  for (let m = braceLine; m < src.length; m++) {
    const next = m + 1 < src.length ? depthAtStart[m + 1] : 0;
    if (next === 0) { end = m; break; }
  }
  funcs.push({ name, start: i + 1, end: end + 1 });
  i = end;
}
for (const f of funcs) console.log(`${f.name}\t${f.start}-${f.end}\tlen=${f.end - f.start + 1}`);
console.log('total', funcs.length);
