import fs from 'node:fs';

const specPath = 'D:/code/_annot_baseline/ZC-deep-b69-spec-06.json';
const target = 'D:/code/ZCode/packages/ui/src/v4/highspeed/HighSpeedDiffusionCanvas.tsx';
const EXPECT_TOTAL = 64;

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const raw = fs.readFileSync(target, 'utf8');
const lines = raw.split(/\r?\n/);

const BANNED_START = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];
const CALL_RE = /[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+[ \t]*\(/;

let total = 0;
let blocks = 0;
const usedIdx = new Set();
const f = spec.files[0];

if (spec.files.length !== 1) throw new Error('spec must contain exactly one file entry');
if (f.file !== 'packages/ui/src/v4/highspeed/HighSpeedDiffusionCanvas.tsx') {
  throw new Error('unexpected file path in spec: ' + f.file);
}

const seenAnchors = [];
for (const item of f.items) {
  const anchor = String(item.anchor ?? '').trim();
  if (!anchor) throw new Error('empty anchor');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === anchor) hits.push(i);
  }
  const nth = item.nth || 1;
  if (hits.length < nth || (!item.nth && hits.length !== 1)) {
    throw new Error(`(a) anchor hits ${hits.length} (nth=${nth}): ${anchor}`);
  }
  seenAnchors.push(anchor);
  const idx = hits[nth - 1];
  if (usedIdx.has(idx)) throw new Error(`(b) duplicate insert index ${idx}: ${anchor}`);
  usedIdx.add(idx);

  let out;
  if (item.raw) {
    out = item.raw;
  } else {
    const indent = /^[ \t]*/.exec(lines[idx])[0];
    out = item.lines.map((t) => (t === '' ? indent + '//' : indent + '// ' + t));
  }

  for (const l of out) {
    if (!l.trim().startsWith('//') || l.includes('*/')) {
      throw new Error(`(c) illegal inserted line: ${l}`);
    }
    const body = l.trim().replace(/^\/\/[ \t]?/, '');
    if (body.endsWith(';')) throw new Error(`(d) trailing semicolon: ${l}`);
    if (body.includes('=>')) throw new Error(`(d) arrow found: ${l}`);
    if (CALL_RE.test(body)) throw new Error(`(d) call expression found: ${l}`);
    const first = body.split(/\s+/)[0];
    if (BANNED_START.includes(first)) throw new Error(`(d) banned leading word "${first}": ${l}`);
  }

  total += out.length;
  blocks += 1;

  if (blocks === 1) {
    const outRaw = item.raw;
    if (!outRaw) throw new Error('(f) first item must use raw');
    if (outRaw.length !== 22) throw new Error(`(f) header raw length ${outRaw.length} !== 22`);
    if (!outRaw[0].startsWith('// INV-01')) throw new Error('(f) header first line must start with // INV-01');
    if (outRaw[18] !== '//') throw new Error(`(f) header line 19 must be "//", got ${JSON.stringify(outRaw[18])}`);
    for (let k = 1; k <= 18; k++) {
      const wanted = `// INV-${String(k).padStart(2, '0')}`;
      if (!outRaw[k - 1].startsWith(wanted)) throw new Error(`(f) header line ${k} must start with ${wanted}`);
      if (!outRaw[k - 1].includes('守住位置') || !outRaw[k - 1].includes('改错故障')) {
        throw new Error(`(f) header line ${k} missing 守住位置/改错故障`);
      }
    }
  } else if (item.lines) {
    if (item.lines.length < 3 || item.lines.length > 6) {
      throw new Error(`block ${blocks} has ${item.lines.length} lines, expected 3..6: ${anchor}`);
    }
  }
}

if (new Set(seenAnchors).size !== seenAnchors.length) throw new Error('(a) duplicate anchors in spec');
if (total !== EXPECT_TOTAL) throw new Error(`(e) total inserted lines ${total} !== ${EXPECT_TOTAL}`);

console.log(`OK blocks=${blocks} lines=${total}`);
