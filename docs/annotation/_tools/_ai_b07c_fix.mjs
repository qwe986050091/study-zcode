import fs from 'node:fs';

const REPO = 'D:/code/opensource/ai/';

function add(rel, anchors) {
  const file = REPO + rel;
  const lines = fs.readFileSync(file, 'utf8').split('\r\n');
  const used = new Set();
  const items = anchors.map(a => {
    const idx = lines.findIndex((l, i) => !used.has(i) && l.includes(a.expect));
    if (idx < 0) {
      console.error(`MISS ${rel} :: ${a.expect}`);
      process.exit(1);
    }
    used.add(idx);
    return { idx, text: a.text };
  });
  items.sort((x, y) => y.idx - x.idx);
  let n = 0;
  for (const it of items) {
    lines.splice(it.idx, 0, ...it.text);
    n += it.text.length;
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  console.log(`ADDED ${rel} +${n}`);
}

add('packages/ai/src/generate-text/tool-caller-configuration.ts', [
  {
    expect: 'const resolved: ResolvedToolCallers = {};',
    text: [
      '// 用普通对象而不是 Map：返回值要进入 ModelMessage 与请求参数，',
      '// 普通对象更容易被序列化与调试打印。',
      '// 键顺序沿用 Object.entries 的插入顺序，便于日志对比。',
    ],
  },
]);

add('packages/ai/src/generate-text/tool-call-concurrency.ts', [
  {
    expect: 'const results = new Array<OUTPUT>(items.length);',
    text: [
      '// 稀疏数组在此处是安全的：所有下标都会被 worker 填满后才返回。',
    ],
  },
]);
