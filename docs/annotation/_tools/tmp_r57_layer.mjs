// R57 层次重判落地：删 769（同层重复）、改写 1268（路径层）、新增 studio 914（路径层）
import fs from 'node:fs';
const REPO = 'D:/code/opensource/drizzle-orm/';
const err = [];

function edit(rel, fn) {
  const p = REPO + rel;
  const raw = fs.readFileSync(p, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let lines = raw.split(/\r?\n/);
  lines = fn(lines, rel);
  fs.writeFileSync(p, lines.join(eol), 'utf8');
}

// 1) 删除 gelSerializer 769
edit('drizzle-kit/src/serializer/gelSerializer.ts', (lines, rel) => {
  const drop = '顶层策略的 to 摊平与表内策略同构：字符串、GelRole、数组三种形态各走一个分支。';
  const hits = lines.filter((l) => l.trim() === '// ' + drop);
  if (hits.length !== 1) err.push(`${rel}: 删除目标命中 ${hits.length}`);
  const old1268 = 'pg_namespace 逐行按 schemaFilters 过滤，命中名字才加入 schemas 集合，未命中的库不生成 CREATE SCHEMA。';
  const next1268 = '命中 schemaFilters 的库才进 schemas 集合，未命中的库即使出现在 allSchemas 里也不会生成 CREATE SCHEMA。';
  const h2 = lines.filter((l) => l.trim() === '// ' + old1268);
  if (h2.length !== 1) err.push(`${rel}: 1268 旧文案命中 ${h2.length}`);
  return lines
    .filter((l) => l.trim() !== '// ' + drop)
    .map((l) => (l.trim() === '// ' + old1268 ? l.replace(old1268, next1268) : l));
});

// 2) studio 914 新增（插在 await next() 上一行，保持同缩进）
edit('drizzle-kit/src/serializer/studio.ts', (lines, rel) => {
  const idx = lines.findIndex((l) => l.trim() === 'await next();');
  if (idx < 0) { err.push(`${rel}: 找不到 await next()`); return lines; }
  const indent = lines[idx].match(/^\t*/)[0];
  const text = '先 await next() 让下游把响应写完，再补这个头；反过来会在响应定稿后写头，浏览器收不到。';
  lines.splice(idx, 0, indent + '// ' + text);
  return lines;
});

if (err.length) { console.error('FAIL\n' + err.join('\n')); process.exit(1); }
console.log('ok');
