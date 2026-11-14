# ZC-DEEP-B220（4 文件，+120 行）

> 范围：快捷键录制、斜杠命令建议、任务右键菜单与工具卡装配（合计 490 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b220\orig`；清单：`ZC-deep-b220-files.txt`。
> 目标密度 31%~32%，实际落点 31.71%~32.63%。

## 1. 验收输出

```text
[ok] packages/ui/src/settings/useShortcutRecording.ts: 14 blocks, 30 lines
[ok] packages/ui/src/slashCommandHelpers.ts: 14 blocks, 30 lines
[ok] packages/ui/src/TaskListItemContextMenu.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/ToolCallBlocks/ToolPresentation.tsx: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
31.71% code=164 comment=52 packages/ui/src/slashCommandHelpers.ts
31.88% code=138 comment=44 packages/ui/src/settings/useShortcutRecording.ts
32.26% code=93 comment=30 packages/ui/src/TaskListItemContextMenu.tsx
32.63% code=95 comment=31 packages/ui/src/ToolCallBlocks/ToolPresentation.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/settings/useShortcutRecording.ts` | 快捷键录制 | 录制态早退、捕获阶段拦截、Escape/Backspace、pending 清提示、重复与冲突拒绝、落盘分派 | 30 |
| `ui/src/slashCommandHelpers.ts` | 斜杠命令建议 | 去前导斜杠、App 前缀隔离、plan 过滤、关键词去重、token 替换、光标上下文 | 30 |
| `ui/src/TaskListItemContextMenu.tsx` | 任务右键菜单 | 纯装配、组织动作置前、Item/Separator 注入、回调透传、禁用态与文件三态 | 30 |
| `ui/src/ToolCallBlocks/ToolPresentation.tsx` | 工具卡装配 | 无宿主依赖、输出规整与 raw 同步、工作区固定空、todo 默认隐藏、三类 renderer 分支 | 30 |

## 3. 说明

- `useShortcutRecording.ts` 原 0 注释（0.00%），块锚定入口、recording 早退、keydown 处理器、Escape、Backspace、录制结果、pending、invalid、同命令绑定、duplicate、conflict、落盘分支与捕获注册。
- `slashCommandHelpers.ts` 原 4 行（2.50%），首行 `/**` 在文件内出现 4 次，补 `firstNth: 1` 锚定文件头；块锚定 App 建议、值规整、来源判定、side 门禁、规整函数、返回式、CLI 建议、plan 过滤、子代理、技能、替换函数、光标上下文与折叠判断。
- `TaskListItemContextMenu.tsx` 原 0 注释（0.00%），块锚定入口、disabledReason 参数、容器、组织动作、动作清单、Item/Separator、两个可选回调、禁用态、原因、解构结尾与容器闭合。
- `ToolPresentation.tsx` 原 2 行（2.11%），块锚定入口、intl、能力、规整 memo、状态映射、展示模型、render 上下文、嵌套渲染、空工作区、子调用展开、todo 过滤、fallback 与常规返回。
- 本批一次锚点不匹配：`slashCommandHelpers.ts` 首行 `/**` 命中 4 处，补 `firstNth: 1` 后重插；失败文件未落盘，`deletedNonZero=0`。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1842 needLines=25801 min=0.00 median=31.35
本会话范围 files=4562 coreBelow30=1838 needLines=21209
```

累计 1,386 文件 / 127,209 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b220 | 提交 a8784b7e | numstat 117 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=33 / 117）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=117 waterLines=33 waterRate=28.21% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=117
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=112 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=283 missing=0
```

- 结论：**六件套未全通过**。waterLines=33 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
