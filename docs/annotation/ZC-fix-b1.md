# ZC-FIX-B1（工具验证批：1 文件）

> 目的：先用一个真实文件跑通 `zc-verify.mjs --rewrite`，确认「删注释行三条约束」可被机检，
> 再按命中量从 B29 起批量改写。本批不并入原批次合计，单独记账。
> 基线：`d:\code\_annot_baseline\ZC-fix-b1\orig`；清单：`ZC-fix-b1-files.txt`。

## 1. 工具能力（新增 `--rewrite` 模式）

| 断言 | 实现 | 失败计数 |
| --- | --- | --- |
| 删的必须是注释行 | `git diff -U0` 逐条检查 `-` 行 trim 后以 `//` 开头 | `codeDeletion`（恒 0） |
| 只能删自己加的注释 | 以 `git show HEAD:<rel>` 与基线做插入对齐，得到「自有注释行」多重集，被删行必须命中 | `upstreamCommentDeleted`（恒 0） |
| 代码 token 流与 HEAD 一致 | 剔除整行 `//` 后逐行比对（EOL 归一），等价于 token 流不变，且规避 TS scanner 在 `${}` 后的模板误切 | `codeTokenDiff`（恒 0） |
| 不删字符串/模板里的 `//` 行 | 解析基线的 `StringLiteral` / `TemplateExpression` / `NoSubstitutionTemplateLiteral` 区段，被删行定位回区段即失败 | `literalCommentDeletion`（恒 0） |
| 其余沿用 | 新增非注释行、注释内 `*/`、语法诊断 | `nonCommentAdded` / `starSlash` / `syntaxErrorFiles` |

负向自测（`_neg_test.mjs`）：

```text
NEG code-change: exit=1  SUMMARY codeTokenDiff=1 nonCommentAdded=1
NEG upstream-comment: exit=1  SUMMARY upstreamCommentDeleted=1
RESTORED: exit=0  SUMMARY deletedOwnCommentLines=21 codeTokenDiff=0 ...
```

## 2. 本批改写

```text
[ok] packages/ui/src/lib/chatPrepareError.ts
SUMMARY files=1 rewrittenSegments=4 deletedOwnCommentLines=21 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

| 文件 | 改写段 | 删自有注释行 | 说明 |
| --- | ---: | ---: | --- |
| `packages/ui/src/lib/chatPrepareError.ts` | 4 | 21 | 四处「短句三连/五连」合并为含标识符的单行说明 |

改写示例：

- 原 `// 字符串原样返回。/ 空值单独成词。/ 原始类型直接转字符串。/ 对象尝试序列化。/ 失败回退字符串化。/ 不抛出二次错误。`
  → `// stringifyUnknownValue 不允许抛错：JSON.stringify 遇到循环引用会抛，必须 catch 后回退 String(value)，否则二次异常会覆盖原始错误；null 与 undefined 分别固定返回 "null"、"undefined"，不能返回空串。`
- 原 `// 实例优先消息。/ 空消息退名称。/ 对象消息仅取有效值。/ 其余统一字符串化。/ 结果始终为字符串。`
  → `// getChatErrorMessage 的三级顺序不可反转：Error 实例先取 err.message，为空再退 err.name，最后 String(err)；普通对象只有 message 经 stringifyUnknownValue 后既非 "undefined" 也非空串才采用，其余一律走 stringifyUnknownValue。`

## 3. 能力基线变化

本批净删 17 行注释（21 删 / 4 增），`packages/ui/src/lib/chatPrepareError.ts` 由 6 条空话合并为 4 条实义行。
密度按下限不再作为门槛；后续改写只记录净值，不追求 30%。
