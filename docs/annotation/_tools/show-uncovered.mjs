import fs from 'node:fs'
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const path = process.argv[3]
const from = Number(process.argv[4] || 0)
const to = Number(process.argv[5] || 1e9)
const r = j.rows.find(x => x.path === path)
for (const x of r.uncoveredUnits) {
  if (x.line >= from && x.line <= to) console.log(x.line + '\t' + x.text)
}
