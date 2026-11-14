import { execSync } from 'node:child_process';
const repo = 'd:/code/opensource/valkey';
const run = (c) => execSync(c, { cwd: repo, maxBuffer: 1e8 }).toString();
const commits = ['0b8d7f7', '20d5c67', '83e339a', '03a8e60', 'a12de69', '7e709ee', 'c03a1d5', '5854600'];
for (const c of commits) {
  const out = run(`git diff --numstat c96bdec ${c}`).trim().split('\n');
  let a = 0;
  for (const l of out) a += Number(l.split('\t')[0]);
  console.log(c, 'add=' + a, 'files=' + out.length);
}
