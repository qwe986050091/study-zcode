# ZC-DEEP-B212（4 文件，+120 行）

> 范围：存储分类列表、存储扫描数据源、定时任务表单选项构造、Start Plan 预览读取（合计 468 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b212\orig`；清单：`ZC-deep-b212-files.txt`。
> 目标密度 31%~32%，实际落点 30.92%~31.58%。

## 1. 验收输出

```text
[ok] packages/ui/src/resource-manager/storage/StorageCategoryList.tsx: 13 blocks, 30 lines
[ok] packages/ui/src/resource-manager/storage/useStorageUsage.ts: 13 blocks, 30 lines
[ok] packages/ui/src/settings/automationAgentConfigOptions.ts: 14 blocks, 30 lines
[ok] packages/ui/src/settings/model-provider-section/useStartPlanPreview.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/ui/src/resource-manager/storage/StorageCategoryList.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/resource-manager/storage/useStorageUsage.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/settings/automationAgentConfigOptions.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/settings/model-provider-section/useStartPlanPreview.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
30.92% code=152 comment=47 packages/ui/src/settings/automationAgentConfigOptions.ts
31.13% code=106 comment=33 packages/ui/src/settings/model-provider-section/useStartPlanPreview.ts
31.30% code=115 comment=36 packages/ui/src/resource-manager/storage/useStorageUsage.ts
31.58% code=95 comment=30 packages/ui/src/resource-manager/storage/StorageCategoryList.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/resource-manager/storage/StorageCategoryList.tsx` | 分类列表渲染 | 受控组件、可清理双条件、清理中按 id、两个打开入口、标题/描述 id、图标表、formatBytes、测试 id、禁用范围、文案切换 | 30 |
| `ui/src/resource-manager/storage/useStorageUsage.ts` | 扫描数据源 | 生命周期绑 enabled、只认当前 jobId、旧快照回填、终态清 id、取消幂等、清理后重扫、失焦 60s、聚焦条件重启、缺桥降级 | 30 |
| `ui/src/settings/automationAgentConfigOptions.ts` | 定时任务选项构造 | 纯本地草稿、默认 build、首选模型固化、先精确后回退、跨 provider 不猜、展示复用会话规则、失效档位置空、null 与 undefined 语义 | 30 |
| `ui/src/settings/model-provider-section/useStartPlanPreview.ts` | 预览读取 | 一天 TTL、请求合并、命中短路、finally 清在飞、禁用不请求、service_unavailable、错误归一化、刷新留旧值、失败清空 | 30 |

## 3. 说明

- `StorageCategoryList.tsx` 原 0 注释（0.00%），块锚定可清理判定、清理中判定、整行测试 id、尺寸文本、清理按钮分支、转圈图标、文案切换、箭头入口；
  两个 `onClick={() => onOpen(category.id)}` 未分别锚定，只锚定整行按钮的测试 id 与箭头图标，避免重复锚点。
- `useStorageUsage.ts` 原 6 行（5.22%），块锚定 jobId ref、start 成功/失败两路、cancel 先置空、进度 id 过滤、终态清理、快照回填、两处 `void start();`（`nth: 1` 挂载、`nth: 2` 聚焦重启）、卸载标记、失焦定时器、清理后重扫、缺桥抛错；
  文件头的既有 JSDoc 保留不动，新增 INV 表插在其前。
- `automationAgentConfigOptions.ts` 原 17 行（11.18%），首行 `import {` 与第 9 行同名，用 `firstNth: 1` 锚定文件头；
  块锚定默认模式、首选模型、分组构建、精确命中、分隔符、跨 provider 收集、provider 唯一、全局唯一回填、展示回退、会话侧标签、失效档位置空、null/undefined、options 组装。
- `useStartPlanPreview.ts` 原 3 行（2.83%），块锚定 TTL、两份模块级变量、初始 loading、服务缺失、刷新留旧预览、错误归一化、effect、两处 `previewCache = {`（`nth: 1` 测试钩子、`nth: 2` 成功缓存）、缓存命中、在飞复用、`previewRequest = null;`（`nth: 3` 为 finally）。
- 四个文件均按「新增 30 行」写入，未使用 `round(code×0.314)` 估算；密度落在 30.92%~31.58%，全部 ≥30% 且不贴线。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1874 needLines=26706 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1870 needLines=22114
```

累计 1,354 文件 / 126,249 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b212 | 提交 a8784b7e | numstat 116 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=27 / 116）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=116 waterLines=27 waterRate=23.28% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=116
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=92 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=156 missing=0
```

- 结论：**六件套未全通过**。waterLines=27 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
