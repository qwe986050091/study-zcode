import fs from 'node:fs'

const SPEC = 'd:/code/_annot_baseline/ZC-deep-b71-spec-03.json'
const TARGET = 'd:/code/ZCode/packages/ui/src/presentation/presentationElementModel.ts'
const FILE = 'packages/ui/src/presentation/presentationElementModel.ts'
const EXPECT_LINES = 62
const EXPECT_HEADER = 22

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'))
const raw = fs.readFileSync(TARGET, 'utf8')
const lines = raw.split(/\r?\n/)

const FORBIDDEN = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/
const CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/

let total = 0
let blocks = 0
let header = null

if (spec.files.length !== 1) throw new Error('expect exactly one file entry')
for (const f of spec.files) {
  if (f.file !== FILE) throw new Error('unexpected file: ' + f.file)
  const seen = new Set()
  for (const item of f.items) {
    const anchor = String(item.anchor ?? '').trim()
    if (!anchor) throw new Error('empty anchor')
    const hits = []
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() === anchor) hits.push(i)
    const nth = item.nth || 1
    if (hits.length < nth || (!item.nth && hits.length !== 1)) {
      throw new Error(`anchor hit ${hits.length} times (nth=${nth}): ${anchor}`)
    }
    const idx = hits[nth - 1]
    if (seen.has(idx)) throw new Error('duplicate insert index ' + idx + ' anchor=' + anchor)
    seen.add(idx)

    let out
    if (item.raw) {
      if (item.lines) throw new Error('item has both raw and lines: ' + anchor)
      out = item.raw.slice()
    } else {
      if (!Array.isArray(item.lines)) throw new Error('missing lines: ' + anchor)
      const indent = /^[ \t]*/.exec(lines[idx])[0]
      out = item.lines.map((t) => (t === '' ? indent + '//' : indent + '// ' + t))
    }

    for (const l of out) {
      if (!l.trim().startsWith('//')) throw new Error('not comment line: ' + l)
      if (l.includes('*/')) throw new Error('contains */: ' + l)
      const body = l.trim().replace(/^\/\/ ?/, '')
      if (FORBIDDEN.test(body)) throw new Error('forbidden start word: ' + l)
      if (/;\s*$/.test(body)) throw new Error('trailing semicolon: ' + l)
      if (body.includes('=>')) throw new Error('arrow: ' + l)
      if (CALL.test(body)) throw new Error('call expression: ' + l)
    }

    if (!header) header = item
    total += out.length
    blocks++
  }
}

if (total !== EXPECT_LINES) throw new Error('inserted lines = ' + total + ', expect ' + EXPECT_LINES)
if (!header || !header.raw) throw new Error('first item must be raw header')
if (header.raw.length !== EXPECT_HEADER) throw new Error('header raw length = ' + header.raw.length)
if (!header.raw[0].startsWith('// INV-01')) throw new Error('header first line invalid: ' + header.raw[0])
if (header.raw[18] !== '//') throw new Error('header 19th line must be //, got: ' + header.raw[18])
for (let i = 0; i < 18; i++) {
  if (!header.raw[i].startsWith('// INV-' + String(i + 1).padStart(2, '0') + ' ')) {
    throw new Error('header INV order broken at ' + (i + 1))
  }
  if (!header.raw[i].includes('守住位置') || !header.raw[i].includes('改错故障')) {
    throw new Error('header INV missing 守住位置/改错故障 at ' + (i + 1))
  }
}

const body = spec.files[0].items.slice(1)
for (const item of body) {
  const n = item.lines.length
  if (n < 3 || n > 6) throw new Error('block size out of range: ' + n + ' anchor=' + item.anchor)
}

const firstNonEmpty = lines.find((l) => l.trim() !== '')
if (header.anchor.trim() !== firstNonEmpty.trim()) {
  throw new Error('header anchor is not file top line: ' + header.anchor)
}

console.log(`OK blocks=${blocks} lines=${total}`)
