import fs from 'node:fs';

const REPO = 'd:/code/opensource/valkey';
const REL = 'src/zmalloc.c';
const DIR = 'd:/code/_annot_baseline/VK-B41';

export function emit(name, baseOffset, E) {
  const SRC = `${REPO}/${REL}`;
  const lines = fs.readFileSync(SRC, 'utf8').split('\n');
  const ops = [];
  for (const [bl, c] of E) {
    const ln = bl + baseOffset;
    const cur = lines[ln - 1];
    if (cur === undefined) {
      console.error(`MISSING base=${bl} cur=${ln}`);
      process.exit(2);
    }
    const t = cur.trim();
    if (!t || t.startsWith('/*') || t.startsWith('//') || /^\*\s/.test(t) || t.startsWith('#')) {
      console.error(`BADANCHOR base=${bl} cur=${ln} ${t}`);
      process.exit(2);
    }
    ops.push({ line: ln, expect: t, lines: Array.isArray(c) ? c : [c] });
  }
  ops.sort((a, b) => b.line - a.line);
  fs.writeFileSync(`${DIR}/ins-${name}.json`, JSON.stringify([{ file: REL, ops }], null, 1));

  const out = `${DIR}/out-zmalloc.json`;
  const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
  fs.writeFileSync(out, JSON.stringify([...prev, ...ops.map((o) => ({ line: o.line, c: o.lines }))], null, 1));
  const added = ops.reduce((s, o) => s + o.lines.length, 0);
  console.log(`${name} ops=${ops.length} added=${added}`);
}
