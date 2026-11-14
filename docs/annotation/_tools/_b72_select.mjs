import fs from 'node:fs';

const scope = JSON.parse(
  fs.readFileSync('d:/code/_annot_baseline/GC-deep-b71/scope.json', 'utf8'),
);
const EXCL = [
  /(^|\/)(test|tests|__tests__|e2e|evals|examples|devtools|test-utils|mocks|fixtures)\//,
  /\.(test|spec)\./,
  /loggers\.test\.circular\.ts$/,
  /^packages\/core\/src\/context\/system-tests\//,
];
const rows = scope.rows
  .filter((r) => r.measured < 30 && !EXCL.some((re) => re.test(r.path)))
  .sort((a, b) => a.need - b.need);
console.log('below30=' + rows.length);
console.log(
  rows
    .slice(0, 5)
    .map(
      (r) =>
        `${r.need}\t${r.measured.toFixed(2)}\t${r.total}\t${r.newComments}\t${r.path}`,
    )
    .join('\n'),
);

