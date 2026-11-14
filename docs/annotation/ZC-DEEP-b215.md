# ZC-DEEP-B215（4 文件，+120 行）

> 范围：文件树吸顶行、runtime 命令队列、GitHub 赞助月度聚合、MCP 托管页迟到回调用例（合计 738 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b215\orig`；清单：`ZC-deep-b215-files.txt`。
> 目标密度 31%~32%，实际落点 30.43%~32.61%。

## 1. 验收输出

```text
[ok] packages/ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx: 14 blocks, 30 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts: 14 blocks, 30 lines
[ok] docs/knip/docs/scripts/get-monthly-sponsorships-github.ts: 14 blocks, 30 lines
[ok] packages/desktop/scripts/mcp-apps-host-fixture/managed-late-checks.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[docs/knip/docs/scripts/get-monthly-sponsorships-github.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/desktop/scripts/mcp-apps-host-fixture/managed-late-checks.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
30.43% code=460 comment=140 apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts
31.91% code=94 comment=30 packages/ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx
32.61% code=92 comment=30 docs/knip/docs/scripts/get-monthly-sponsorships-github.ts
32.61% code=92 comment=30 packages/desktop/scripts/mcp-apps-host-fixture/managed-late-checks.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx` | 吸顶文件夹行 | 空列表早退、零高度容器、点击分层、静态布局、选中判空、git 与忽略兜底、目录状态、下一帧揭示 | 30 |
| `core/src/runtime/methods/runtime-command-queue.ts` | 命令队列 | 排空单飞、临界区复位、批量通知、混合批报错、代际校验、租约出队、前台槽、busy 六项、Stop 幂等 | 30 |
| `docs/knip/docs/scripts/get-monthly-sponsorships-github.ts` | 赞助聚合 | 环境密钥、全量取数、时间升序、月份铺零、一次性与订阅分流、取消移除非负数、区间出口裁剪 | 30 |
| `desktop/scripts/mcp-apps-host-fixture/managed-late-checks.ts` | 迟到回调用例 | 用例命名、事件偏移、单方法 gate、新 token、旧句柄拒绝、游客与端口恒一、迟到授权不生效 | 30 |

## 3. 说明

- `WorkspaceFileTreeStickyFolders.tsx` 原 0 注释（0.00%），块锚定空列表、两层容器 div、row 取值、toggle 包装、`requestAnimationFrame`、key、layout、选中判空、git 兜底两行、目录状态、空样式。
- `runtime-command-queue.ts` 原 110 行（23.91%），新增 INV 表插在既有文件头 JSDoc 之前；块锚定 enqueue 入口、取消早退、批次回填、`void this.drainRuntimeCommandQueue();`（`nth: 1` 为入队后触发）、单飞早退、置位、混合批抛错、非通知批抛错、复位、无租约递归、预留项缺失、`this.foregroundPromotionLease = undefined;`（`nth: 1` 为出队消费）、空闲报告。
- `get-monthly-sponsorships-github.ts` 原 0 注释（0.00%），块锚定环境 token、聚合入口、GraphQL 全量、时间排序、活跃表、月份铺零、recurringOnly 跳过、一次性入账、取消移除、总额重算、向后覆盖、缺 token 抛错、出口裁剪。
- `managed-late-checks.ts` 原 0 注释（0.00%），块锚定 checkLate 入口、ui 包装、首条用例名、`history.length`（`nth: 1`）、gate 设置与删除、旧句柄、新 token 断言、`assert.rejects`（`nth: 1`）、游客数（`nth: 1`）、端口数（`nth: 1`）、待授权、executed 过滤。
- 本批首个文件的两个容器锚点首轮漏写 `<div ` 前缀，命中 0 次；失败文件未落盘，修正锚点后重插。其余三个文件一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1862 needLines=26361 min=0.00 median=31.35
本会话范围 files=4562 coreBelow30=1858 needLines=21769
```

累计 1,366 文件 / 126,609 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b215 | 提交 a8784b7e | numstat 119 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=35 / 119）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=119 waterLines=35 waterRate=29.41% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=119
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=149 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=568 missing=0
```

- 结论：**六件套未全通过**。waterLines=35 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
