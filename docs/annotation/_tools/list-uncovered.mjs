import fs from 'node:fs'
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const r of j.rows) {
  const u = r.uncoveredUnits || []
  console.log('== ' + r.path + ' uncovered=' + u.length)
  const step = Number(process.argv[3] || 25)
  for (const x of u.slice(0, step)) console.log('  ' + x.line + '\t' + x.text)
}
