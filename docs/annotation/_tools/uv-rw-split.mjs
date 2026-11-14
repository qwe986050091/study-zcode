// 把注水报告按 crate 分成 6 个改写批次，输出每批的 JSON 清单。
import fs from 'node:fs';

const SRC = 'd:\\code\\_annot_baseline\\uv-rw-base-boiler.json';
const OUT = 'd:\\code\\_annot_baseline';
const report = JSON.parse(fs.readFileSync(SRC, 'utf8')).report.filter((f) => f.groups.length > 0);

// 批次 -> crate 列表（按行数均衡切分，尽量保持同一 crate 不拆散）
const PLAN = {
  A: ['uv-python-discovery', 'uv-python-types', 'uv-pep440', 'uv-pep508'],
  B: ['uv', 'uv-console', 'uv-dev', 'uv-macros', 'uv-trampoline-builder', 'uv-python-interpreter', 'uv-python-managed', 'uv-python-commands'],
  C: ['uv-project-commands', 'uv-project-edit', 'uv-tool-commands', 'uv-environment-operations', 'uv-install-operations', 'uv-installer', 'uv-install-wheel', 'uv-bin-install'],
  D: ['uv-distribution', 'uv-distribution-types', 'uv-distribution-filename', 'uv-extract', 'uv-client', 'uv-cache', 'uv-cache-info', 'uv-cache-key', 'uv-auth', 'uv-pypi-types', 'uv-netrc'],
  E: ['uv-lock-operations', 'uv-lock', 'uv-resolver', 'uv-resolver-types', 'uv-resolve-operations', 'uv-platform-tags', 'uv-platform', 'uv-build-backend', 'uv-build-frontend', 'uv-build', 'uv-build-commands', 'uv-metadata'],
  F: ['uv-types', 'uv-test', 'uv-fs', 'uv-configuration', 'uv-workspace-commands', 'uv-workspace', 'uv-audit-operations', 'uv-audit', 'uv-command-support', 'uv-dispatch', 'uv-warnings', 'uv-pip-commands', 'uv-publish-commands', 'uv-publish', 'uv-cli', 'uv-settings', 'uv-torch', 'uv-requirements', 'uv-requirements-txt', 'uv-logging', 'uv-options-metadata', 'uv-git-types', 'uv-globfilter', 'uv-small-str', 'uv-windows'],
};
const crateOf = (file) => {
  const p = file.split('/');
  return p[0] === 'crates' ? p[1] : p[0];
};
const seen = new Set();
for (const [batch, crates] of Object.entries(PLAN)) {
  const set = new Set(crates);
  const files = report.filter((f) => set.has(crateOf(f.file)));
  for (const f of files) seen.add(f.file);
  const lines = files.reduce((n, f) => n + f.groups.reduce((m, g) => m + g.count, 0), 0);
  fs.writeFileSync(`${OUT}\\uv-rw-batch${batch}.json`, JSON.stringify({ batch, files }, null, 2));
  console.log(`batch${batch} files=${files.length} groups=${files.reduce((n, f) => n + f.groups.length, 0)} lines=${lines}`);
}
const missing = report.filter((f) => !seen.has(f.file));
if (missing.length) console.error('UNASSIGNED: ' + missing.map((f) => f.file).join(', '));
