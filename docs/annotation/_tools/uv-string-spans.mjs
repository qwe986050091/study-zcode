// 计算 Rust 源码里的字符串字面量区间（含 raw string / byte string / 多行字符串）。
// 用途：插入注释前判定目标行是否落在字符串内部。落在 r#"..."#、indoc! 文本块、
// 含换行的普通字符串里插入 `//`，编译器不会报错，却会改变运行时数据或测试期望值。
//
// 用法（CLI）：node uv-string-spans.mjs <file.rs> [--lines]
//   --lines 输出落在字符串内部的起始行号（1-based）。

export function stringSpans(src) {
  const spans = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    // 行注释：跳过，避免注释里的引号被当成字符串起点
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    // 块注释：支持嵌套
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      i = j;
      continue;
    }
    // raw string：r"..." / r#"..."# / br#"..."#
    if (c === 'r' || (c === 'b' && src[i + 1] === 'r')) {
      const m = /^b?r(#*)"/.exec(src.slice(i, i + 64));
      if (m) {
        const hashes = m[1] || '';
        const start = i + m[0].length;
        const closer = '"' + hashes;
        const end = src.indexOf(closer, start);
        const stop = end < 0 ? n : end + closer.length;
        spans.push({ start: i, end: stop, multiline: src.slice(i, stop).includes('\n') });
        i = stop;
        continue;
      }
    }
    // byte string：b"..."
    if (c === 'b' && src[i + 1] === '"') {
      let j = i + 2;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      spans.push({ start: i, end: j, multiline: src.slice(i, j).includes('\n') });
      i = j;
      continue;
    }
    // 普通字符串
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      spans.push({ start: i, end: j, multiline: src.slice(i, j).includes('\n') });
      i = j;
      continue;
    }
    // 字符字面量 vs 生命周期：'x' / '\n' / 'a
    if (c === "'") {
      if (src[i + 1] === '\\') {
        let j = i + 2;
        while (j < n && src[j] !== "'") j++;
        i = j + 1;
        continue;
      }
      if (i + 2 < n && src[i + 2] === "'") {
        i += 3;
        continue;
      }
    }
    i++;
  }
  return spans;
}

// 返回每行行首偏移是否落在某个字符串区间内部（严格内部：区间起点所在行不算）。
export function linesInsideStrings(src) {
  const spans = stringSpans(src);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const inside = [];
  for (let ln = 0; ln < lineStarts.length; ln++) {
    const off = lineStarts[ln];
    inside.push(spans.some((s) => off > s.start && off < s.end));
  }
  return inside;
}

if (process.argv[1] && process.argv[1].endsWith('uv-string-spans.mjs')) {
  const fs = await import('node:fs');
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node uv-string-spans.mjs <file.rs> [--lines]');
    process.exit(2);
  }
  const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const spans = stringSpans(src);
  const inside = linesInsideStrings(src);
  const hits = inside.map((v, i) => (v ? i + 1 : 0)).filter(Boolean);
  const all = src.split('\n');
  const commentLike = hits.filter((ln) => /^\s*\/\//.test(all[ln - 1] || ''));
  console.log(
    `SPANS file=${file} strings=${spans.length} multiline=${spans.filter((s) => s.multiline).length} ` +
      `linesInside=${hits.length} commentLike=${commentLike.length}`,
  );
  if (process.argv.includes('--lines')) console.log(hits.join('\n'));
  if (commentLike.length) {
    console.log('--- comment-like lines inside strings ---');
    for (const ln of commentLike) console.log(`${ln}: ${(all[ln - 1] || '').trim()}`);
  }
}
