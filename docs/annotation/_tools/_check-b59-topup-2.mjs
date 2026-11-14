import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ZCode';
const specPath = 'd:/code/_annot_baseline/ZC-deep-b59-topup-2.json';
const expected = {
  'packages/shared/src/conversation-message-projection-policy.ts': 3,
  'packages/ui/src/ToolCallBlocks/renderers/eval-workflow-snippet.tsx': 3,
  'packages/ui/src/v4/agentSessionsIndexTransport.ts': 3,
  'packages/ui/src/store/index.ts': 5,
};

const SPEC_BAD_START = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
let failed = false;
const fail = (msg) => { failed = true; console.error('[FAIL] ' + msg); };

if (spec.files.length !== 4) fail(`files count ${spec.files.length} !== 4`);

for (const f of spec.files) {
  const exp = expected[f.file];
  if (exp === undefined) { fail(`unexpected file ${f.file}`); continue; }
  const abs = path.join(ROOT, f.file);
  if (!fs.existsSync(abs)) { fail(`missing file ${f.file}`); continue; }
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

  let inserted = 0;
  const seenIdx = new Set();
  for (const item of f.items) {
    if (item.raw) fail(`${f.file}: raw item forbidden`);
    if (!Array.isArray(item.lines) || item.lines.length === 0) fail(`${f.file}: empty lines`);
    const anchor = String(item.anchor ?? '').trim();
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() === anchor) hits.push(i);
    const nth = item.nth || 1;
    if (hits.length !== 1) fail(`${f.file}: anchor hits ${hits.length} (want 1): ${anchor}`);
    if (hits.length < nth) continue;
    const idx = hits[nth - 1];
    if (seenIdx.has(idx)) fail(`${f.file}: duplicate insert index ${idx + 1}`);
    seenIdx.add(idx);
    // 上方不能已经是注释行
    for (let j = idx - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
        fail(`${f.file}: line above anchor ${idx + 1} is a comment`);
      }
      break;
    }
    for (const text of item.lines) {
      inserted += 1;
      if (text === '') fail(`${f.file}: blank inserted line expected? (counts as //)`);
      if (text.includes('*/')) fail(`${f.file}: contains */ : ${text}`);
      if (/;\s*$/.test(text)) fail(`${f.file}: ends with ; : ${text}`);
      if (text.includes('=>')) fail(`${f.file}: contains => : ${text}`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(text)) fail(`${f.file}: call shape X.Y( : ${text}`);
      const bare = text.replace(/^\[[^\]]*\]\s*/, '').trim();
      if (SPEC_BAD_START.test(bare)) fail(`${f.file}: forbidden start word: ${text}`);
    }
  }
  if (inserted !== exp) fail(`${f.file}: inserted ${inserted} !== expected ${exp}`);
  else console.log(`[ok] ${f.file}: ${inserted} lines, anchors unique`);
}

if (failed) { console.error('CHECK FAILED'); process.exit(1); }
console.log('ALL CHECKS PASSED');
