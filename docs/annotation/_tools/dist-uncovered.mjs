import fs from 'node:fs'
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const r of j.rows) {
  const u = r.uncoveredUnits || []
  if (!u.length) continue
  const lines = u.map(x => x.line)
  const maxTxt = fs.readFileSync('d:/code/claude-code-main/' + r.path, 'utf8').split(/\r?\n/).length
  console.log('== ' + r.path + ' totalLines=' + maxTxt + ' uncovered=' + u.length + ' min=' + Math.min(...lines) + ' max=' + Math.max(...lines))
  const buckets = {}
  for (const l of lines) {
    const k = Math.floor(l / 100) * 100
    buckets[k] = (buckets[k] || 0) + 1
  }
  console.log('  buckets: ' + Object.keys(buckets).sort((a, b) => a - b).map(k => k + ':' + buckets[k]).join(' '))
}
