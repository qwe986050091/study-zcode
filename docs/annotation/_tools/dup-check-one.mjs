import fs from 'fs'

const rel = process.argv[2]
const basePath = 'd:/code/_annot_baseline/CCC-rework/baseline/' + rel
const curPath = 'd:/code/claude-code-main/' + rel
const base = fs.readFileSync(basePath, 'utf8').split(/\r?\n/)
const cur = fs.readFileSync(curPath, 'utf8').split(/\r?\n/)

let i = 0
let j = 0
const added = []
while (j < cur.length) {
  if (i < base.length && cur[j] === base[i]) {
    i++
    j++
    continue
  }
  if (cur[j].trim().startsWith('//')) {
    added.push(j + 1)
    j++
    continue
  }
  i++
  j++
}

const runs = []
for (const L of added) {
  if (runs.length && L === runs[runs.length - 1][1] + 1) runs[runs.length - 1][1] = L
  else runs.push([L, L])
}

const norm = s =>
  s
    .replace(/^\s*\/\/+/, '')
    .replace(/[\s，。、；：！？,.;:!?（）()【】\[\]”‘’—\-_`*"']/g, '')

const key = r => {
  const a = []
  for (let k = r[0]; k <= r[1]; k++) a.push(norm(cur[k - 1]))
  return a.join('|')
}

const m = new Map()
for (const r of runs) {
  const k = key(r)
  if (!m.has(k)) m.set(k, [])
  m.get(k).push(r[0])
}
const dups = [...m.entries()].filter(([k, v]) => v.length > 1 && k.length > 8)
let adj = 0
for (let x = 0; x < runs.length - 1; x++) {
  if (key(runs[x]) === key(runs[x + 1]) && runs[x + 1][0] - runs[x][1] <= 2) adj++
}
console.log(
  JSON.stringify({
    file: rel,
    addedLines: added.length,
    runs: runs.length,
    intraDup: dups.length,
    adjacentDup: adj,
    samples: dups.slice(0, 3).map(([, v]) => v),
  }),
)
