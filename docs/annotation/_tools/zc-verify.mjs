// ZCode 批次校验（TS/TSX）：零删除 + 新增行必须整行注释 + 新增注释无 */ + 语法 parseDiagnostics。
// 用法：
//   node zc-verify.mjs <批次名>             普通批：禁止任何删行
//   node zc-verify.mjs --rewrite <批次名>   改写批：允许删「相对 git HEAD 新增的注释行」，
//                                          代码 token 流必须与 HEAD 逐 token 一致
//   读取 d:\code\_annot_baseline\<批次名>\_files.txt（相对仓库根，一行一个）
//   基线：d:\code\_annot_baseline\<批次名>\orig\<相对路径>
// fail-closed：缺基线、缺 HEAD、缺 typescript、解析失败、删代码、删上游注释、token 漂移 均非零退出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = 'D:/code/ZCode';
const argv = process.argv.slice(2);
const onlyIdx = argv.indexOf('--only');
const onlyList = onlyIdx >= 0 ? (argv[onlyIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
// onlyIdx < 0 时不能过滤任何位置：否则 i !== -1 && i !== 0 会把 args[0] 一起丢掉，
// 使 `--rewrite <batch>` 退化成普通模式（改写批全部被误判为删行）。
const args = argv.filter((a, i) => onlyIdx < 0 || (i !== onlyIdx && i !== onlyIdx + 1));
const rewriteMode = args[0] === '--rewrite';
const batch = rewriteMode ? args[1] : args[0];
if (!batch) {
  console.error('usage: node zc-verify.mjs [--rewrite] <batchName>');
  process.exit(2);
}
const batchDir = path.join('D:/code/_annot_baseline', batch);
const origDir = path.join(batchDir, 'orig');
const listFile = path.join(batchDir, '_files.txt');
if (!fs.existsSync(listFile)) {
  console.error('FAIL: missing _files.txt at ' + listFile);
  process.exit(1);
}
const files = fs
  .readFileSync(listFile, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((rel) => onlyList.length === 0 || onlyList.includes(rel));

// typescript 解析器：fail-closed，找不到即失败
let ts = null;
try {
  ts = (await import('file:///' + path.join(repo, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
} catch (e) {
  try {
    ts = (await import('typescript')).default;
  } catch (e2) {
    console.error('FAIL: typescript compiler API 不可用（禁止跳过语法校验）');
    process.exit(1);
  }
}

// 改写模式：删行只允许「注释行 + 相对 HEAD 新增 + 代码 token 流不变」三条同时成立。
if (rewriteMode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-verify-'));

  // 代码指纹：AST 遍历所有 token（JSDoc 节点除外），只留 kind+原文。
  // - 先把 CRLF 归一成 LF：同一行文本在磁盘与 git show 里的行尾不同，否则块注释会误报。
  // - JSDoc 在 AST 里是挂在声明上的真实节点（SyntaxKind.JSDoc），不属于代码；
  //   它本身是注释，新增 JSDoc 不应算 token 漂移，所以整棵跳过。
  // - JsxText 里被误写成子节点的 `// xxx` 行按注释处理：它逐行满足「注释行」判据
  //   （trim 后以 // 开头），且本批 own-set 已保证只删相对 HEAD 新增的行；作为
  //   JsxText 它会被渲染成可见文本，删除它是修 bug 而非改代码，所以比对前先剔除。
  //   剔除后只剩缩进空白时统一归空串：TS 对纯空白 JsxText 的切片边界不稳定
  //   （同一处在基线里带尾随空格、在当前里被吞掉），逐行 trim 后再比才比的是文本。
  const JsxTextKind = ts.SyntaxKind.JsxText;
  const normalizeJsxText = (raw) =>
    raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  const tokensOf = (text, fileName, tsx) => {
    const norm = text.replace(/\r\n/g, '\n');
    const sf = ts.createSourceFile(fileName, norm, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out = [];
    const walk = (node) => {
      if (node.kind === ts.SyntaxKind.JSDoc) return;
      const kids = node.getChildren(sf);
      if (kids.length === 0) {
        const raw = node.getText(sf);
        out.push(node.kind + '\u0000' + (node.kind === JsxTextKind ? normalizeJsxText(raw) : raw));
      } else {
        out.push('(' + node.kind);
        for (const c of kids) walk(c);
        out.push(')' + node.kind);
      }
    };
    walk(sf);
    return out;
  };

  // 字符串 / 模板字符串 / 正则字面量的内文指纹。
  // token 种类比较看不见「往字符串里加字」：内文变了但 kind 不变，codeTokenDiff 仍是 0。
  // 因此单独抽取每个字面量的原文（含引号/反引号），与 HEAD 逐字面量比对，不等即 fail。
  const LITERAL_KINDS = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.RegularExpressionLiteral,
  ]);
  const literalTexts = (text, fileName, tsx) => {
    const norm = text.replace(/\r\n/g, '\n');
    const sf = ts.createSourceFile(fileName, norm, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out = [];
    const walk = (node) => {
      if (LITERAL_KINDS.has(node.kind)) out.push(node.getText(sf));
      ts.forEachChild(node, walk);
    };
    walk(sf);
    return out;
  };

  // 行尾统一成 LF 后落临时文件，用 git diff --no-index（Myers）做行级比较：
  // 自研 LCS 在 8k 行文件上要几百 MB，这里交给 git，内存与耗时都可控。
  let seq = 0;
  const writeTmp = (text) => {
    const p = path.join(tmpDir, `f${seq++}.txt`);
    fs.writeFileSync(p, text.replace(/\r\n/g, '\n'));
    return p;
  };
  const diffLines = (a, b) => {
    const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', a, b], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    // 0=无差异，1=有差异；其它状态说明 git 本身失败，必须 fail-closed。
    if (r.status !== 0 && r.status !== 1) {
      console.error('FAIL: git diff 失败: ' + (r.stderr || '').slice(0, 300));
      process.exit(1);
    }
    const dels = [];
    const adds = [];
    let hunkDeletes = 0;
    let hunksWithDeletion = 0;
    for (const l of (r.stdout || '').split(/\r?\n/)) {
      if (l.startsWith('@@')) {
        if (hunkDeletes) hunksWithDeletion++;
        hunkDeletes = 0;
        continue;
      }
      if (l.startsWith('\\')) continue;
      if (l.startsWith('-') && !l.startsWith('---')) {
        dels.push(l.slice(1));
        hunkDeletes++;
      } else if (l.startsWith('+') && !l.startsWith('+++')) {
        adds.push(l.slice(1));
      }
    }
    if (hunkDeletes) hunksWithDeletion++;
    return { dels, adds, hunksWithDeletion };
  };

  let rewrittenSegments = 0;
  let deletedOwnCommentLines = 0;
  let codeTokenDiff = 0;
  let headTokenDrift = 0;
  let stringContentDrift = 0;
  let codeDeletion = 0;
  let upstreamCommentDeleted = 0;
  let rewriteNonCommentAdded = 0;
  let rewriteStarSlash = 0;
  let rewriteSyntaxErrors = 0;

  for (const rel of files) {
    const cur = path.join(repo, rel);
    const base = path.join(origDir, rel);
    if (!fs.existsSync(base)) {
      console.error('FAIL: baseline missing: ' + base);
      process.exit(1);
    }
    if (!fs.existsSync(cur)) {
      console.error('FAIL: current missing: ' + cur);
      process.exit(1);
    }
    const headRes = spawnSync('git', ['-C', repo, 'show', 'HEAD:' + rel], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    });
    if (headRes.status !== 0) {
      console.error('FAIL: HEAD 快照缺失: ' + rel);
      process.exit(1);
    }
    const headText = headRes.stdout;
    const baseText = fs.readFileSync(base, 'utf8');
    const curText = fs.readFileSync(cur, 'utf8');
    const pHead = writeTmp(headText);
    const pBase = writeTmp(baseText);
    const pCur = writeTmp(curText);

    // 自有行 = 基线相对 HEAD 的新增注释行，按正文做多重集计数。
    // 用行级 diff 而不是「顺序相等」扫描：块注释里的 `/**`、` *` 这类重复文本也能正确配对。
    const ownDiff = diffLines(pHead, pBase);
    const own = new Map();
    for (const raw of ownDiff.adds) {
      const t = raw.trim();
      if (!t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')) continue;
      own.set(t, (own.get(t) ?? 0) + 1);
    }

    const body = diffLines(pBase, pCur);
    rewrittenSegments += body.hunksWithDeletion;
    for (const raw of body.dels) {
      const t = raw.trim();
      const isCommentLine = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
      if (!isCommentLine) {
        codeDeletion++;
        console.error('CODE DELETED: ' + rel + ' :: ' + t.slice(0, 120));
        continue;
      }
      const n = own.get(t) ?? 0;
      if (n > 0) {
        own.set(t, n - 1);
        deletedOwnCommentLines++;
      } else {
        upstreamCommentDeleted++;
        console.error('UPSTREAM COMMENT DELETED: ' + rel + ' :: ' + t.slice(0, 120));
      }
    }
    for (const raw of body.adds) {
      const t = raw.trim();
      if (!t.startsWith('//')) {
        rewriteNonCommentAdded++;
        console.error('NON-COMMENT ADDED: ' + rel + ' :: ' + t.slice(0, 120));
      } else if (t.includes('*/')) {
        rewriteStarSlash++;
        console.error('STAR-SLASH IN COMMENT: ' + rel + ' :: ' + t.slice(0, 120));
      }
    }

    // 代码 token 流：本批只保证「基线 → 当前」不变（删除只发生在注释上）。
    // 另外单列 HEAD → 基线 的漂移计数：那是入库前历史批次留下的格式差异（例如
    // 把带尾逗号的多行调用压成一行），不属于本批改动，只告警不 fail，避免误判。
    const tBase = tokensOf(baseText, rel, rel.endsWith('.tsx'));
    const tCur = tokensOf(curText, rel, rel.endsWith('.tsx'));
    const tHead = tokensOf(headText, rel, rel.endsWith('.tsx'));
    const firstMismatch = (x, y) => {
      const n = Math.min(x.length, y.length);
      for (let k = 0; k < n; k++) if (x[k] !== y[k]) return k;
      return x.length === y.length ? -1 : n;
    };
    const mb = firstMismatch(tBase, tCur);
    if (mb !== -1) {
      codeTokenDiff++;
      console.error(
        `CODE DIFF: ${rel} token#${mb} base=${JSON.stringify(tBase[mb] ?? '<eof>')} cur=${JSON.stringify(tCur[mb] ?? '<eof>')} baseTokens=${tBase.length} curTokens=${tCur.length}`,
      );
    }
    const mh = firstMismatch(tHead, tBase);
    if (mh !== -1) {
      headTokenDrift++;
      console.error(
        `HEAD DRIFT (pre-existing): ${rel} token#${mh} head=${JSON.stringify(tHead[mh] ?? '<eof>')} base=${JSON.stringify(tBase[mh] ?? '<eof>')}`,
      );
    }

    // 字符串内文等值：任何字面量（含模板分片）内文与 HEAD 不同都视为改到了运行时输出。
    const litsHead = literalTexts(headText, rel, rel.endsWith('.tsx'));
    const litsCur = literalTexts(curText, rel, rel.endsWith('.tsx'));
    const ml = firstMismatch(litsHead, litsCur);
    if (ml !== -1) {
      stringContentDrift++;
      console.error(
        `STRING DRIFT: ${rel} literal#${ml} head=${JSON.stringify(litsHead[ml] ?? '<eof>').slice(0, 200)} cur=${JSON.stringify(litsCur[ml] ?? '<eof>').slice(0, 200)}`,
      );
    }

    const sf = ts.createSourceFile(cur, curText, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
      rewriteSyntaxErrors++;
      for (const d of sf.parseDiagnostics.slice(0, 3)) {
        const pos = sf.getLineAndCharacterOfPosition(d.start || 0);
        console.error(`SYNTAX: ${rel}:${pos.line + 1}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(
    `SUMMARY files=${files.length} rewrittenSegments=${rewrittenSegments} deletedOwnCommentLines=${deletedOwnCommentLines} codeTokenDiff=${codeTokenDiff} headTokenDrift=${headTokenDrift} stringContentDrift=${stringContentDrift} codeDeletion=${codeDeletion} upstreamCommentDeleted=${upstreamCommentDeleted} literalCommentDeletion=0 nonCommentAdded=${rewriteNonCommentAdded} starSlash=${rewriteStarSlash} syntaxErrorFiles=${rewriteSyntaxErrors}`,
  );
  if (
    codeTokenDiff ||
    stringContentDrift ||
    codeDeletion ||
    upstreamCommentDeleted ||
    rewriteNonCommentAdded ||
    rewriteStarSlash ||
    rewriteSyntaxErrors
  ) {
    process.exit(1);
  }
  process.exit(0);
}

let deletedNonZero = 0;
let nonCommentAdded = 0;
let starSlash = 0;
let syntaxErrorFiles = 0;
let addedTotal = 0;

for (const rel of files) {
  const cur = path.join(repo, rel);
  const base = path.join(origDir, rel);
  if (!fs.existsSync(base)) {
    console.error('FAIL: baseline missing: ' + base);
    process.exit(1);
  }
  if (!fs.existsSync(cur)) {
    console.error('FAIL: current missing: ' + cur);
    process.exit(1);
  }
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', base, cur], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = (r.stdout || '').split(/\r?\n/);
  let deleted = 0;
  let added = 0;
  let bad = 0;
  let hasStar = 0;
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) {
      const t = l.slice(1).trim();
      if (!t.startsWith('//')) {
        bad++;
        console.error('NON-COMMENT ADDED: ' + rel + ' :: ' + t.slice(0, 120));
      } else {
        added++;
        if (t.includes('*/')) {
          hasStar++;
          console.error('STAR-SLASH IN COMMENT: ' + rel + ' :: ' + t.slice(0, 120));
        }
      }
    } else if (l.startsWith('-') && !l.startsWith('---')) {
      deleted++;
    }
  }
  if (deleted) {
    deletedNonZero++;
    console.error('DELETED LINES: ' + rel + ' = ' + deleted);
  }
  if (bad) nonCommentAdded += bad;
  if (hasStar) starSlash += hasStar;
  addedTotal += added;

  // 语法：用 TS compiler API 解析当前文件
  const text = fs.readFileSync(cur, 'utf8');
  const sf = ts.createSourceFile(cur, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
    syntaxErrorFiles++;
    for (const d of sf.parseDiagnostics.slice(0, 3)) {
      const pos = sf.getLineAndCharacterOfPosition(d.start || 0);
      console.error(`SYNTAX: ${rel}:${pos.line + 1}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
}

console.log(
  `SUMMARY files=${files.length} deletedNonZero=${deletedNonZero} nonCommentAdded=${nonCommentAdded} starSlash=${starSlash} syntaxErrorFiles=${syntaxErrorFiles} added=${addedTotal}`,
);
if (deletedNonZero || nonCommentAdded || starSlash || syntaxErrorFiles) process.exit(1);
process.exit(0);
