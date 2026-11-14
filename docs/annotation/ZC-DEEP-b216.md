# ZC-DEEP-B216（4 文件，+120 行）

> 范围：v4 delta 应用语义、v4 行 schema、浏览器区域尺寸提示、命令中心搜索历史（合计 772 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b216\orig`；清单：`ZC-deep-b216-files.txt`。
> 目标密度 31%~32%，实际落点 30.66%~32.29%。

## 1. 验收输出

```text
[ok] packages/shared/src/zcode-protocol-v4/apply.ts: 14 blocks, 30 lines
[ok] packages/shared/src/zcode-protocol-v4/rows.ts: 14 blocks, 30 lines
[ok] packages/ui/src/browser-use/useBrowserResizeOperationWarning.ts: 14 blocks, 30 lines
[ok] packages/ui/src/command-center/commandCenterSearchHistory.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/shared/src/zcode-protocol-v4/apply.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/shared/src/zcode-protocol-v4/rows.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/browser-use/useBrowserResizeOperationWarning.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/command-center/commandCenterSearchHistory.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
30.66% code=349 comment=107 packages/shared/src/zcode-protocol-v4/rows.ts
31.31% code=198 comment=62 packages/shared/src/zcode-protocol-v4/apply.ts
31.78% code=129 comment=41 packages/ui/src/browser-use/useBrowserResizeOperationWarning.ts
32.29% code=96 comment=31 packages/ui/src/command-center/commandCenterSearchHistory.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/zcode-protocol-v4/apply.ts` | delta 应用语义 | 不可变入口、累加器边界、双实现一致、未加载 no-op、字段分派、删除边界、键级替换、通知不改快照、批量按序 | 30 |
| `shared/src/zcode-protocol-v4/rows.ts` | 行 schema | 行自包含、rowId 单调、换行与追加分工、turn 标签、兼容 optional、闭集偏斜、actions 只发 true、分享 ref 替换 | 30 |
| `ui/src/browser-use/useBrowserResizeOperationWarning.ts` | 区域尺寸提示 | 弱提示、单周期一次、三秒消失、零尺寸、首帧基线、稳定期三段、只认模型 marker、卸载清理 | 30 |
| `ui/src/command-center/commandCenterSearchHistory.ts` | 搜索历史 | 按 workspace 分键、20 条上限、存储降级、形状校验、前缀符号、忽略大小写去重、置顶、清除落盘 | 30 |

## 3. 说明

- `apply.ts` 原 32 行（13.91%），新增 INV 表插在既有首行注释之前；块锚定累加器接口、`const window = [...snapshot.rows.window];`（`nth: 1`，三处同名）、appendToRow、toolCall 输出分支、`case "row.appended":`（`nth: 1`）、未加载 no-op、`const removesEntireActiveBranch =`（`nth: 1`）、计数归零、`case "state.updated":`（`nth: 1`）、pluginUi 分支、workflowRuns 两处。
- `rows.ts` 原 77 行（18.08%），块锚定 rowBaseFields、rowId、entityId、轮头、`origin: z.enum([`（`nth: 1`）、executionKind、assistantText、display catch、artifact 类型、ref、hook 描述、lane、判别联合。
- `useBrowserResizeOperationWarning.ts` 原 11 行（7.86%），块锚定四个时长常量中的三个（最小、静默、上限）与三秒常量、提示前置条件、单周期标记、稳定期入口、layout effect、marker 判定、active 早退、无观察器、零尺寸、变化与稳定期判断。
- `commandCenterSearchHistory.ts` 原 1 行（1.03%），块锚定上限、键前缀、getStorage、localStorage 返回、形状校验、类型判断、首处 `const storage`（`nth: 1`）、`const parsed = ...`、`? parsed.filter(...)`、JSON.stringify、前缀符号、去重键、末尾 slice。
- 本批两次锚点不匹配：`const window = [...]` 命中 3 次（补 `nth: 1`）；`JSON.parse(...)` 与 `parsed.filter(...)` 两行分别漏了 `const parsed = ` 与行首 `? `。失败文件均未落盘，修正后重插。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1858 needLines=26249 min=0.00 median=31.35
本会话范围 files=4562 coreBelow30=1854 needLines=21657
```

累计 1,370 文件 / 126,729 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b216 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=27 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=27 waterRate=22.50% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=191 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=370 missing=0
```

- 结论：**六件套未全通过**。waterLines=27 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
