import fs from 'node:fs';

const rows = fs
    .readFileSync('d:/code/_annot_baseline/all-uncovered2.txt', 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(l => {
        const [p, ln, , text] = l.split('\t');
        return { p, ln: Number(ln), text: text ?? '' };
    });

const isReexport = t => /^\s*export\s+(const|type)\s+\w+\s*=\s*(?:s\.\w+|\w+\.\w+)\s*;?\s*$/.test(t);
const isBarrel = t => /^\s*export\s+(type\s+)?(\*|\{)/.test(t);
const isParam = t =>
    /^\s*(?:(?:public|private|protected|readonly|static|override)\s+)*[A-Za-z_$][\w$]*\??\s*:\s*\S/.test(t) ||
    /^\s*\.\.\.[A-Za-z_$][\w$]*\s*[,;]?\s*$/.test(t) ||
    /^\s*[A-Za-z_$][\w$]*\??\s*[,;]\s*$/.test(t) ||
    /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type)\s+\w+.*\{\s*$/.test(t) ||
    /^\s*declare\s+module\s+/.test(t) ||
    /^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*[(<]/.test(t) ||
    /^\s*(?:(?:public|private|protected|static|async|override)\s+)+[A-Za-z_$][\w$]*\s*\(/.test(t) ||
    /^\s*[A-Za-z_$][\w$]*\s*\(.*\)\s*:\s*.+;\s*$/.test(t);

const buckets = { param: [], reexport: [], barrel: [], residual: [] };
for (const r of rows) {
    if (isReexport(r.text)) buckets.reexport.push(r);
    else if (isBarrel(r.text)) buckets.barrel.push(r);
    else if (isParam(r.text)) buckets.param.push(r);
    else buckets.residual.push(r);
}

for (const [k, v] of Object.entries(buckets)) console.log(`${k}\t${v.length}`);
console.log('\n=== RESIDUAL ===');
for (const r of buckets.residual) console.log(`${r.p}\t${r.ln}\t${r.text}`);
