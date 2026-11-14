import fs from 'node:fs'

const dir = process.argv[2]
const base = 'd:/code/_annot_baseline/' + dir
const cur = 'd:/code/claude-code-main'
const files = fs.readFileSync(base + '/_files.txt', 'utf8').trim().split(/\r?\n/)
let A = 0, N = 0, D = 0
for (const f of files) {
  const a = fs.readFileSync(base + '/' + f, 'utf8').split(/\r?\n/)
  const b = fs.readFileSync(cur + '/' + f, 'utf8').split(/\r?\n/)
  const used = new Array(b.length).fill(false)
  let j = 0, matched = 0
  for (const line of a) {
    while (j < b.length && b[j] !== line) j++
    if (j >= b.length) break
    used[j] = true
    matched++
    j++
  }
  const added = b.length - a.length
  const deleted = a.length - matched
  let non = 0
  for (let k = 0; k < b.length; k++) if (!used[k] && !/^\s*\/\//.test(b[k])) non++
  A += added; N += non; D += deleted
  console.log([f, '+' + added, 'nonC=' + non, 'del=' + deleted].join('\t'))
}
console.log('TOTAL added=' + A + ' nonComment=' + N + ' deleted=' + D)
