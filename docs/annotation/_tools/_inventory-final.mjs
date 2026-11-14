// 全仓源码清点：packages/*/src 下 .ts/.tsx，跳过测试/示例/开发工具目录与 *.test/spec。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'd:/code/opensource/gemini-cli';
const ROOTS = ['core/src', 'cli/src', 'a2a-server/src', 'sdk/src', 'vscode-ide-companion/src'];
const EXCLUDE_SEGMENTS = new Set(['__tests__', 'e2e', 'evals', 'examples', 'devtools', 'node_modules', 'dist', 'build']);
const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_SEGMENTS.has(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile() && /\.(ts|tsx)$/.test(ent.name) && !TEST_RE.test(ent.name)) {
      out.push(path.relative(REPO, p).replace(/\\/g, '/'));
    }
  }
}

const pkgs = fs.readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();
const all = [];
const byPkg = {};
for (const p of pkgs) {
  const dir = path.join(REPO, 'packages', p, 'src');
  if (!fs.existsSync(dir)) continue;
  const out = [];
  walk(dir, out);
  byPkg[p] = out;
  all.push(...out);
}
const inScope = (rel) => ROOTS.some((r) => rel.startsWith('packages/' + r + '/'));
const scope = all.filter(inScope);
const excluded = all.filter((r) => !inScope(r));
console.log('packages=' + pkgs.join(','));
for (const p of Object.keys(byPkg)) console.log(`  ${p}: ${byPkg[p].length}`);
console.log(`allSource=${all.length} scope=${scope.length} excluded=${excluded.length} sum=${scope.length + excluded.length}`);
console.log('--- excluded ---');
for (const e of excluded) console.log(e);
