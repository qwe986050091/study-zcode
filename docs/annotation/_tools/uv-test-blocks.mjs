// 产品/测试代码块级切分：排除所有 `#[cfg(...test...)] mod X { ... }` 的内联块。
// 不是「前缀切分点」，因为仓库里存在测试模块之后仍有产品代码的文件（如 uv-redacted/policy.rs）。

const ATTR_TEST = /^\s*#\[cfg\(.*\btest\b.*\)\]\s*$/;
const INLINE_MOD = /^(pub\s+)?mod\s+\w+\s*\{\s*$/;

// 逐行扫描，返回该行的花括号净增量；忽略注释、普通字符串、raw string、字符字面量。
function braceDelta(line, state) {
  let delta = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (state.block) {
      if (c === '*' && line[i + 1] === '/') { state.block = false; i += 2; continue; }
      i++;
      continue;
    }
    if (state.raw !== null) {
      if (c === '"') {
        let h = 0;
        while (line[i + 1 + h] === '#' && h < state.raw) h++;
        if (h === state.raw) { state.raw = null; i += 1 + h; continue; }
      }
      i++;
      continue;
    }
    if (state.str) {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') state.str = false;
      i++;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '/' && line[i + 1] === '*') { state.block = true; i += 2; continue; }
    // raw string：r"…" / r#"…"# / br#"…"#，必须在引号之外的 r/br 位置识别
    {
      let k = -1;
      if (c === 'r') k = i + 1;
      else if (c === 'b' && line[i + 1] === 'r') k = i + 2;
      if (k >= 0) {
        let h = 0;
        while (line[k + h] === '#') h++;
        if (line[k + h] === '"') { state.raw = h; i = k + h + 1; continue; }
      }
    }
    if (c === '"') { state.str = true; i++; continue; }
    if (c === "'") {
      // 字符字面量：'x' 或 '\n'；否则当生命周期撇号跳过
      if (line[i + 1] === '\\' && line[i + 3] === "'") { i += 4; continue; }
      if (line[i + 2] === "'") { i += 3; continue; }
      i++; continue;
    }
    if (c === '{') delta++;
    else if (c === '}') delta--;
    i++;
  }
  return delta;
}

export function testLineSet(lines) {
  const inTest = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!ATTR_TEST.test(lines[i])) continue;
    let modLine = -1;
    for (let j = i + 1; j < Math.min(i + 200, lines.length); j++) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('//') || t.startsWith('#[')) continue;
      if (INLINE_MOD.test(t)) modLine = j;
      break;
    }
    if (modLine < 0) continue;
    const state = { block: false, str: false, raw: null };
    let depth = 0;
    let end = -1;
    for (let j = modLine; j < lines.length; j++) {
      depth += braceDelta(lines[j], state);
      if (depth <= 0 && j > modLine) { end = j; break; }
      if (depth <= 0 && j === modLine && /}\s*$/.test(lines[j])) { end = j; break; }
    }
    if (end < 0) continue;
    for (let k = i; k <= end; k++) inTest.add(k + 1);
    i = end;
  }
  return inTest;
}
