// 列出 oauthService 相对 HEAD 的新增注释行里，zc-gate 判为 W/L/B/POEM 的条目（JSON 供修字用）。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { addedCommentEntries, judgeEntries } from './zc-gate.mjs';

const REL = 'packages/services/src/oauth/oauthService.ts';
const head = execFileSync('git', ['-C', 'd:/code/ZCode', 'show', `HEAD:${REL}`], { maxBuffer: 1 << 28 })
  .toString()
  .split('\n');
const cur = fs.readFileSync('d:/code/ZCode/' + REL, 'utf8').split('\n');
const entries = addedCommentEntries(head, cur);
const findings = judgeEntries(entries);
console.log(JSON.stringify(findings, null, 1));
console.error('findings', findings.length, 'added', entries.length);
