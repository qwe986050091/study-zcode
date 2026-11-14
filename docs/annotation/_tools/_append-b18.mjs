// 把补提交与 54 行改写登记追加到 ZC-DEEP-b18.md。
import fs from 'node:fs';

const mdPath = process.argv[2];
const table = fs.readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, '').trimEnd();
let text = fs.readFileSync(mdPath, 'utf8');

const anchor = '- 待决定（同 B17）：`remoteAssetInstaller.ts` 密度 36.07%，高于目标区间。\n  因硬约束禁止删行，本批未回退；是否在后续统一做「超密文件瘦身」仍待确认。';
if (!text.includes(anchor)) throw new Error('anchor not found');
const update = '\n> 2026-11-10 更新：该待决定项已处理——54 行水句按 DEEP-SPEC §2.16 整句改写（1→1，行数不变，密度不变），登记见 §7。原结论保留，不删除。';
text = text.replace(anchor, anchor + update);

text += `

## 7. 2026-11-10 补提交与 54 行水句改写登记

**背景**：本批 8 个文件从未提交——\`git log --all\` 无任何 b18 提交，工作区挂着 \`+2,161\` 行。其中 \`remoteAssetInstaller.ts\` 的 \`+300\` 先按旧标准落盘，用现行 \`zc-gate\` 复检为 \`waterLines=54\`（Poem 2 组 6 行、L 12 行、W 37 行，1358 行同时命中 L 与 W，去重后 54）。

**改写规则**（DEEP-SPEC §2.16）：只改本线自己写入的注释，代码行与上游注释行 0 删除；每行 1→1 替换，不改行数、不改密度。

**改写后门禁原始输出**

\`\`\`text
$ node _annot_baseline/zc-gate.mjs --scan ...\\RAI-b18-verify\\_files.txt
SUMMARY files=1 badFiles=0 addedCommentLines=300 waterLines=0 waterRate=0.00%
$ node _annot_baseline/zc-verify.mjs RAI-b18-verify
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=300
$ node _annot_baseline/check-code-tokens.mjs ...
SUMMARY files=1 codeTokenDiff=0
$ node _annot_baseline/check-comments-in-strings.mjs ...
SUMMARY files=1 scanned=1 stringRanges=359 violations=0 addedViolations=0
$ node _annot_baseline/deep-boilerplate.mjs ... --diff --files ...
SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
$ node _annot_baseline/check-upstream-comments.mjs ... HEAD
SUMMARY files=1 checked=1 upstreamComments=52 missing=0
\`\`\`

**落盘**：\`89d591aa\`，\`git show --numstat\` → \`300\t0\tpackages/server/src/remote/remoteAssetInstaller.ts\`。

**改写登记（\`rewrittenOwn\`，54 行）**

| 行号 | 类别 | 原文（已改写） | 新文 |
| ---: | --- | --- | --- |
${table}

> 本批其余 7 个文件仍处于「有台账、无提交号」状态，按 \`ZC-LEDGER-AUDIT-2026-11-10.md\` 统一处置，不在本次补提交范围内。
`;

fs.writeFileSync(mdPath, text, 'utf8');
console.log('appended, lines=', text.split('\n').length);
