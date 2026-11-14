const b = (s) => {
  const t = s.replace(/[\s\u201c\u201d"'\u0060]/g, '');
  const o = new Set();
  for (let i = 0; i < t.length - 1; i++) o.add(t.slice(i, i + 2));
  return o;
};
const sim = (x, y) => {
  const A = b(x), B = b(y);
  let i = 0;
  for (const k of A) if (B.has(k)) i++;
  return i / (A.size + B.size - i);
};
const a = '都通过它，而不是各自 new BrowserWindow，从而共享同一套启动 bootstrap 消费逻辑。';
const c = '都通过它，而不是各自 new BrowserWindow。';
console.log('sim=' + sim(a, c).toFixed(4));
