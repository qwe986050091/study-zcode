# ZC-fix-sql-literal（bug 修复批次：注释落入 SQL 字符串）

> 性质：**生产代码缺陷修复**，不是注释质量问题。`//` 落进多行 SQL 模板字符串后，`prepare` 收到的是含 `//` 的语句文本，SQLite 直接报语法错误。
> 触发证据：`node:sqlite` 实测 `PREPARE_ERR: near "/": syntax error`。
> 记账：独立批次，不计入 A5 注释产出；不改任何 SQL 语义，只把说明文字移出字符串。

## 1. 范围与口径

| 项 | 值 |
| --- | --- |
| 文件 | `packages/services/src/session/offPeakTaskRepo.ts` |
| 文件 | `packages/services/src/session/tasksDatabase/source-server-schema-v5.ts` |
| 行数 | 28（offPeak 22 / schema-v5 6） |
| 基线 | `git HEAD`（`_annot_baseline/ZC-fix-sql-literal/orig/`，用 `git archive` 解出，保证字节一致） |
| 动作 | 删除字符串内部的 `//` 行；等价说明改写成含标识符/前置条件的 `//` 注释，放到 `.prepare(` / `.exec(` 之前 |

**token 口径说明**：相对 HEAD 的 `codeTokenDiff=0`（这 28 行从来不在 HEAD 里，撤回的是我们自己插入的字符串内容，不构成改代码）；相对 A5 / B4 等历史快照的 TemplateLiteral token 会变化，这是**预期**的，因为修复的目标就是把字符串恢复成 HEAD 的样子。

## 2. 修复前后（文件级）

| 文件 | 内文率（前→后） | 内文/代码（后） | 字符串内 `//` | gate |
| --- | --- | --- | ---: | --- |
| `session/offPeakTaskRepo.ts` | 30.82% → **35.77%** | 201 / 562 | 22 → 0 | 0.00% |
| `tasksDatabase/source-server-schema-v5.ts` | 20.97% → 20.97% | 26 / 124 | 6 → 0 | 0.00% |

内文率反而上升：这 28 行原先被算作「代码行」（字符串内容属于 token），移出后才计入注释行，同时 `innerCode` 相应减少。

## 3. `prepare` 实测（node:sqlite，内存库 + 桩表）

工具：`_annot_baseline/zc-sqlprepare-check.mjs`。用 TS AST 取 `prepare()` / `exec()` 的模板字面量，`${...}` 占位为 `NULL`，按语句中出现的标识符建桩表后逐条 `prepare()`。

修复前（offPeak 用 A5 快照，schema-v5 由当前文件回填 6 行重建，见 `_annot_baseline/ZC-fix-sql-literal/before/`）：

```text
# offPeakTaskRepo（A5 快照）
SUMMARY files=1 statements=25 ok=12 failed=13
ERR ...:296 [prepare] near "/": syntax error
ERR ...:519 [prepare] near "/": syntax error
...（共 13 条，全部为 near "/": syntax error）

# source-server-schema-v5（重建修复前）
SUMMARY files=1 statements=3 ok=0 failed=3
ERR ...:223 [exec] near "/": syntax error
ERR ...:246 [exec] near "/": syntax error
ERR ...:270 [prepare] near "/": syntax error
```

修复后（当前工作树）：

```text
SUMMARY files=2 statements=28 ok=28 failed=0
```

## 4. 校验原文

```text
node _annot_baseline/zc-verify.mjs --rewrite ZC-fix-sql-literal
SUMMARY files=2 rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0 headTokenDrift=0
codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node _annot_baseline/zc-gate.mjs --scan _annot_baseline/ZC-fix-sql-literal/_files.txt
SUMMARY files=2 badFiles=0 addedCommentLines=304 waterLines=0 waterRate=0.00%

node _annot_baseline/zc-sqlscan.mjs d:\code\ZCode packages/services/src
SUMMARY files=499 hitFiles=0 hitLines=0
```

## 5. 顺带清掉的 7 行注水

`source-server-schema-v5.ts` 不在 A 档名单，此前从未跑过 gate。本次首扫暴露 7 行更早批次留下的 L/W 注释（文件职责、表名来源、版本分派、结构自检、v2 补列、旧库探测两条）。已改写为带标识符/前置条件的句子（如 `VERIFY_CURRENT_SCHEMA`、`ADD_SESSION_GENERATION_COLUMN`、`ledgerExists`），行数不变。

## 6. 不变量

- **模板字符串内部不得出现 `//` 行**：它既是注水，又会随 SQL 发送到数据库。
- SQL 文本必须与 HEAD 逐 token 一致；注释只能放在 `.prepare(` / `.exec(` 之外。
- 修复批次以 HEAD 为基线验收；历史批次快照的 token 变化不视为回归。
- 后续任何注释批次落盘前必须跑字符串内部扫描（`zc-sqlscan.mjs`），不能只依赖 gate。

## 7. 未执行

- 未执行 `git add` / `git commit`。
