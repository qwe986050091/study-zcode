# ZC-DEEP-B209（4 文件，+120 行）

> 范围：营销触达弹窗装配、Gen UI Tweak 注册表、提交信息会话上下文裁剪、子代理 mention 候选投影（合计 409 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b209\orig`；清单：`ZC-deep-b209-files.txt`。
> 目标密度 31.4%，实际落点 31.00%~31.91%。

## 1. 验收输出

```text
[ok] packages/ui/src/components/marketing-touch/MarketingDialogs.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/gen-ui/app/tweaks.ts: 14 blocks, 30 lines
[ok] packages/ui/src/git-action-menu/commitConversationContext.ts: 14 blocks, 30 lines
[ok] packages/ui/src/mentions/providers/subagentsMentionProvider.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/ui/src/components/marketing-touch/MarketingDialogs.tsx] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/gen-ui/app/tweaks.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/git-action-menu/commitConversationContext.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/mentions/providers/subagentsMentionProvider.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.00% code=100 comment=31 packages/ui/src/gen-ui/app/tweaks.ts
31.58% code=95 comment=30 packages/ui/src/components/marketing-touch/MarketingDialogs.tsx
31.68% code=101 comment=32 packages/ui/src/mentions/providers/subagentsMentionProvider.ts
31.91% code=94 comment=30 packages/ui/src/git-action-menu/commitConversationContext.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/components/marketing-touch/MarketingDialogs.tsx` | 营销弹窗装配 | claim 错误升级为阻断弹窗、投递位选择、两个弹层互斥、四类动作派发、失败必抛 | 30 |
| `ui/src/gen-ui/app/tweaks.ts` | Tweak 注册表 | owners 最新者胜、register/update 代际校验、64 上限、回调名全局唯一、range 映射 slider、diff 收集 | 30 |
| `ui/src/git-action-menu/commitConversationContext.ts` | 提交上下文裁剪 | 三上限、逆序收集后反转、首条免预算、单条截断留标记、三级内容回退、文本归一 | 30 |
| `ui/src/mentions/providers/subagentsMentionProvider.ts` | 子代理候选投影 | workspace 优先、同名去重、空名跳过、id 前缀、两级 memo、关闭只清 items | 30 |

## 3. 说明

- `MarketingDialogs.tsx` 原 0.00%，块锚定 claimError 提取、toast 副作用、投递位三元、载荷适配、两个弹窗互斥条件与四个 handler；
  重点标注「领取失败优先于内容弹窗」，以及动作失败必须抛错以便上层回滚 pending。
- `tweaks.ts` 原 1.00%，块锚定注册表与 selection、owners 覆盖语义、zod 入口、select 前置校验、register/update 三元、回调唯一性、groups 与 annotation 差异收集；
  `import {` 首行按 1-based 指定 `firstNth: 1`，避免多段导入时插错位置。
- `commitConversationContext.ts` 原 0.00%，块锚定三个上限、消息归一、预算累加、逆序循环、单条截断、角色开销、首条免判、反转与 sessionId 处理；
  把「至少保留一条否则永远为 null」写成显式不变量。
- `subagentsMentionProvider.ts` 原 1.98%，块锚定优先级函数、enabled 过滤、去重键、替换条件、标签与模型、id 前缀、hook 两级 memo 与关闭返回；
  `if (agent.scope === "workspace")` 在文件内出现两次，取第一处（优先级函数）`nth: 1`。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1886 needLines=27054 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1882 needLines=22462
```

累计 1,342 文件 / 125,887 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b209 | 提交 a8784b7e | numstat 118 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=25 / 118）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=118 waterLines=25 waterRate=21.19% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=118
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=95 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=3 missing=0
```

- 结论：**六件套未全通过**。waterLines=25 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
