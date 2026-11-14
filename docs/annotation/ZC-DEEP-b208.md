# ZC-DEEP-B208（4 文件，+121 行）

> 范围：API 重试状态归一、计划详情侧栏、套餐用量入口三态、会话滚动与导出组件（合计 441 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b208\orig`；清单：`ZC-deep-b208-files.txt`。
> 目标密度 31.4%，实际落点 31.34%~31.82%。

## 1. 验收输出

```text
[ok] packages/shared/src/zcode-api-retry-status.ts: 12 blocks, 31 lines
[ok] packages/ui/src/app-shell/PlanDetailSidePane.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/components/ai-elements/conversation.tsx: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=121
[packages/shared/src/zcode-api-retry-status.ts] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/app-shell/PlanDetailSidePane.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/components/ai-elements/conversation.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=121 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.34% code=134 comment=42 packages/ui/src/components/ai-elements/conversation.tsx
31.37% code=102 comment=32 packages/ui/src/app-shell/PlanDetailSidePane.tsx
31.58% code=95 comment=30 packages/ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx
31.82% code=110 comment=35 packages/shared/src/zcode-api-retry-status.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/zcode-api-retry-status.ts` | 重试状态归一 | null/空对象三态语义、attempt 由 nextAttempt 反推、maxAttempts 减一、多级文案回退、stream recovery 优先、未识别事件返回 undefined | 31 |
| `ui/src/app-shell/PlanDetailSidePane.tsx` | 计划详情侧栏 | 租约获取与释放、父会话切换重建、仅认 toolCall 行、实时优先于快照、scope 条件展开、memo 隔离 | 30 |
| `ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx` | 用量入口三态 | loading 早退、下降沿判成功、错误不给勾、1s 自动回落、定时器清理、阻断冒泡 | 30 |
| `ui/src/components/ai-elements/conversation.tsx` | 会话滚动与导出 | instant 吸底、停止按钮按需隐藏、空态可整体覆盖、parts 取文本、blob URL 回收、保留上游许可 | 30 |

## 3. 说明

- `zcode-api-retry-status.ts` 原 3.64%，块锚定 record 折叠、attempt/maxRetries 推导、kind 常量、事件分派、恢复进展判定、stream recovery 与两个取值助手；
  重点写明 `null` 是「已恢复」、`undefined` 是「无信息」，二者不可互替。
- `PlanDetailSidePane.tsx` 原 1.96%，块锚定缓存初值、store 默认值、租约获取、窗口内查找、两处 effect、合并顺序与 scope 构造；
  把「实时优先、缓存兜底」写成不变量，避免后续把合并顺序写反。
- `CodingPlanUsageHeaderAction.tsx` 原 0.00%，块锚定两态 state、previousLoadingRef、下降沿判断、1s 回落、三处渲染分支与警告/入口组装；
  注释只描述状态机与渲染优先级，未改动任何条件。
- `conversation.tsx` 原 8.96%，块锚定滚动容器属性、内容层、空态、回底按钮、文本提取、markdown 拼装与下载链路；
  明确 `initial`/`resize` 都用 instant 是为消除切换任务时的双层缓动。
- 本轮无 suspicious 命中；`role="log"` 一行原先误写成带逗号版本导致 anchor 0 命中，修正锚点后重跑即通过（该文件未落盘，无残留）。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1890 needLines=27170 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1886 needLines=22578
```

累计 1,338 文件 / 125,767 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b208 | 提交 a8784b7e | numstat 114 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=19 / 114）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=114 waterLines=19 waterRate=16.67% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=114
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=138 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=151 missing=0
```

- 结论：**六件套未全通过**。waterLines=19 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
