import fs from 'node:fs';

const prev = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/GC-deep-b54/scope.json', 'utf8'));
const EXCLUDE = [
  '/test/', '/tests/', '/__tests__/', '/e2e/', '/evals/', '/examples/', '/devtools/',
  '/test-utils/', '/mocks/', '/fixtures/',
];
const bad = (p) =>
  EXCLUDE.some((e) => p.includes(e)) ||
  /\.test\.[^/]+$/.test(p) ||
  /\.spec\.[^/]+$/.test(p) ||
  p.endsWith('loggers.test.circular.ts') ||
  p.includes('/context/system-tests/');

const rows = prev.rows
  .filter((r) => r.measured < 30 && !bad(r.path))
  .sort((a, b) => a.need - b.need);

console.log('below30 =', rows.length);
for (const r of rows.slice(0, 20)) {
  console.log(r.need, r.measured.toFixed(2), r.code, r.path);
}
