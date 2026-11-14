import fs from 'node:fs';
const f = 'd:/code/opensource/uv/crates/uv-cache-info/src/cache_info.rs';
const anchors = [
  ['fn cache_key_forms() -> Result<(), toml::de::Error> {', 1],
  ['let settings: ToolUv = toml::from_str(', 1],
  ['insta::assert_debug_snapshot!(settings.cache_keys, @r#"', 1],
  ['Ok(())', 1],
  ['fn cache_key_extra_field() {', 1],
  ['insta::assert_snapshot!(toml::from_str::<CacheKey>(r#"file = "Cargo.lock"', 1],
];
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
for (const [a, occ] of anchors) {
  let seen = 0, idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === a) { seen++; if (seen === occ) { idx = i; break; } }
  }
  if (idx < 0) { console.log('MISS', a); continue; }
  let s = idx;
  while (s - 1 >= 0 && lines[s - 1].trim().startsWith('//')) s--;
  console.log('remove target-line', idx + 1, 'comment-lines', s + 1, '-', idx, 'count', idx - s);
  lines.splice(s, idx - s);
}
fs.writeFileSync(f, lines.join('\n'), 'utf8');
