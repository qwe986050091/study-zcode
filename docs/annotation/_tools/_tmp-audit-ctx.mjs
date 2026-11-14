import fs from 'node:fs'
const rel = 'services/mcp/auth.ts'
const cur = fs.readFileSync('d:/code/claude-code-main/' + rel, 'utf8').split(/\r?\n/)
const targets = [2031,2033,2035,2037,2047,2103,2152,2204,2315,2454,2474,2484,2590,2633,2709,2798,2886,2940,3093,3108,3112,3169,3171,3271,3275,3311,3369,3397,3424,3516,3541]
for (const n of targets) {
  console.log('===== ' + n)
  for (let k = n - 6; k <= n + 2; k++) {
    if (k >= 1 && k <= cur.length) console.log(k + '\t' + cur[k - 1])
  }
}
