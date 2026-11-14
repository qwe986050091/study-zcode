# ZC-fix-B126 ~ B128：注水清理第 1 批（4 文件）

> 口径：`zc-para.mjs`（段落级真实待修）+ `deep-boilerplate`（DUP / W-L-B）+ `deep-quality`（语句/分支/实质/注水）。
> 门禁：`zc-verify.mjs --rewrite`（ZCode 侧的 `rewrite-check`）+ `zc-gate.mjs --scan`。

## 1. 批次范围与分类

| 文件 | 段落级命中 | 分类 | 处理 |
| --- | ---: | --- | --- |
| `packages/desktop/src/main/mcpUserDirectory/toml.ts` | 15（poem 4 + W/L 11） | 真注水：1 组 4 行扫描规则堆叠；可增强：8 组缺锚点 | 10 段改写，删除 22 行 |
| `apps/zcode-cli/packages/adapters/src/model/runner-diagnostics.ts` | 12 | 早期批次遗留：内容与上方 JSDoc 逐句重复 | 6 组删除，共 23 行 |
| `packages/ui/src/hooks/useClaudeSessionMigration.ts` | 12 | 可增强：有谓词与后果，缺真实标识符 | 6 组改写，删除 13 行 |
| `packages/ui/src/components/ai-elements/code-block.tsx` | 17 | 结构性标记：`[契约]/[权衡]/[失败路径]` 条款，语义完整 | 保留，不改写 |

未处理的命中同属两类：折行续句（同一句被硬折成多行，拼接后主语/条件/后果齐全）与枚举 + 后果长句。
逐行补锚点会拆散完整论证，按「度量误判」保留。

## 2. 门禁结果

```
B126 rewrittenSegments=10 deletedOwnCommentLines=22 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 nonCommentAdded=0 syntaxErrorFiles=0
B127 rewrittenSegments=10 deletedOwnCommentLines=23 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 nonCommentAdded=0 syntaxErrorFiles=0
B128 rewrittenSegments=6  deletedOwnCommentLines=13 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 nonCommentAdded=0 syntaxErrorFiles=0
```

## 3. 前后对比

| 指标 | 清理前 | 清理后 |
| --- | ---: | ---: |
| 真实注水行（段落级） | 7,420 | **7,381** |
| 注水率 | 5.87% | **5.84%** |
| 本批删除注释行 | — | 58 |
| 本批改写段数 | — | 26 |

## 4. 四项现值（本批 4 文件）

`deep-quality`（`--diff`）+ `zc-inner`：

| 指标 | 现值 |
| --- | ---: |
| 语句覆盖 coverage | 17.5% |
| 分支覆盖 branch | 13.8% |
| 内文率 | 11.44%（124/1,084） |
| 实质率 substance | 50.9% |
| 注水率 filler（v2 同源判据） | **0.0%** |

逐文件内文率：toml 6.52%、runner-diagnostics 1.32%、useClaudeSessionMigration 19.63%、code-block 23.74%。

## 5. 遗留判断

- `runner-diagnostics.ts` 内文率 1.32%，但它承担「请求头脱敏」这一安全边界，按关键文件规则应补深；
  本批只做去重，补深列入后续批。**状态收口（FIX-B129 回填）**：已在 B129 补至 30.69%（116/378），
  状态由「只去重、待补深」改为「已补深」，不再列入待补清单。
- `code-block.tsx` 的 17 条结构性条款保留后仍会出现在真实队列，后续不再重复处理（分类已记档）。

## 6. 下一批

`zc-work-queue-true.txt` 头部：`apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`（23）、
`packages/desktop/src/main/index.ts`（19）、`packages/ui/src/components/ai-elements/code-block.tsx`（17，已判结构性，跳过）。
取 4~6 个文件：`edit.ts`、`desktop/main/index.ts`、`ModelTrajectoryExpandedContent.tsx`、
`taskNotificationOrchestrator.ts`、`chatErrorBannerTelemetry.ts`（`runner-diagnostics.ts` 已由 B129 收口，从本清单移除）。

> 状态口径（自 B129 起）：一个文件在任一时刻只挂一档 —— **已清（去重完结）** /
> **已补深** / **待补深**；去重批次与补深批次分开记账，但以最后收口的那批为准，
> 不允许同一文件同时出现在「已完成」与「待补深」两个列表。
