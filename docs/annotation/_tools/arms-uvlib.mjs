import fs from 'node:fs';

const p = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const s = fs.readFileSync(p, 'utf8').split(/\r?\n/);
for (let i = 0; i < s.length; i++) {
  if (/^\s*(Commands|ProjectCommand|ToolCommand|PipCommand|CacheCommand|PythonCommand|SelfCommand|WorkspaceCommand)::/.test(s[i])) {
    const start = i;
    let j = i;
    while (j < s.length && !/=>/.test(s[j]) && j - start < 4) j++;
    console.log(`${start + 1}: ${s.slice(start, j + 1).map((x) => x.trim()).join(' ').slice(0, 160)}`);
  }
}
