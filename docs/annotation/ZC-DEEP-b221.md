# ZC-DEEP-B221（4 文件，+120 行）

> 范围：单轮会话行、分屏布局计算、工作流留白通知行与 Web 远控设备信息（合计 455 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b221\orig`；清单：`ZC-deep-b221-files.txt`。
> 目标密度 30% 以上，实际落点 31.58%~32.99%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/ConversationTurnRow.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/v4/workbenchLayout.ts: 14 blocks, 30 lines
[ok] packages/ui/src/v4/WorkflowNotificationHoleRow.tsx: 14 blocks, 30 lines
[ok] packages/web/src/web-remote-control/adapters/webRemoteControlDeviceInfo.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
31.58% code=133 comment=42 packages/ui/src/v4/workbenchLayout.ts
32.09% code=134 comment=43 packages/ui/src/v4/WorkflowNotificationHoleRow.tsx
32.97% code=91 comment=30 packages/web/src/web-remote-control/adapters/webRemoteControlDeviceInfo.ts
32.99% code=97 comment=32 packages/ui/src/v4/ConversationTurnRow.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/v4/ConversationTurnRow.tsx` | 单轮行入口 | 薄壳透传、回调可选、复制文本来源、多段优先、计划正文补入与去重 | 30 |
| `ui/src/v4/workbenchLayout.ts` | 分屏布局计算 | 纯函数、叶子扁平化、占比走 CSS 变量、轴向对称、calc 收口、分割条几何 | 30 |
| `ui/src/v4/WorkflowNotificationHoleRow.tsx` | 留白通知行 | 三态判定、缺表即离开、等待计时与清理、文案映射、展开体可选段落 | 30 |
| `web/src/web-remote-control/adapters/webRemoteControlDeviceInfo.ts` | Web 设备信息 | 全局注入、有限数与空串过滤、时区容错、成对字段、条件展开 | 30 |

## 3. 说明

- `ConversationTurnRow.tsx` 原 2 行（2.06%），块锚定入口、row 参数、解构结尾、行视图、onFork、reasoningContentVariant、复制函数、空文本早退、分段构造、去重集合、计划过滤、空正文跳过与双换行拼接。
- `workbenchLayout.ts` 原有 5 行文件头（3.76%），文件头插在其上方；块锚定变量前缀、三个接口、根矩形、递归签名、叶子分支、占比变量、横向分支、入口函数、两个样式函数与轴向判断。
- `WorkflowNotificationHoleRow.tsx` 原 11 行 JSDoc（8.94%），块锚定两个类型、状态函数、缺表、状态归一、文案映射、图标常量、组件入口、状态推导、时钟、依赖数组、时长计算与展开体回调。
- `webRemoteControlDeviceInfo.ts` 原 0 注释（0.00%），块锚定两个读取工具、返回式、时区函数、catch、入口函数、时钟与 navigator 默认值、像素比、平台字段、语言列表、视口成对与时间戳。
- 四份 spec 全部一次插入成功，无锚点冲突；`deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`。
- 本批文件缺口均为 28 行，按固定 30 行写入，落地后四文件 `need=0`，全仓 `needLines` 减少 112。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1838 needLines=25689 min=0.00 median=31.35
```

累计 1,390 文件 / 127,329 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b221 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=37 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=37 waterRate=30.83% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=164 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=56 missing=0
```

- 结论：**六件套未全通过**。waterLines=37 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
