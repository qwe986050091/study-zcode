# ZC-DEEP-B223（4 文件，+120 行）

> 范围：/goal 命令处理、媒体附件解析、用量事实旁路写入与话题档案检索（合计 1,128 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b223\orig`；清单：`ZC-deep-b223-files.txt`。
> 目标密度 30% 以上，实际落点 30.65%~33.00%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts: 14 blocks, 30 lines
[ok] apps/zcode-cli/packages/core/src/runtime/helpers/attachment-media-resolver.ts: 14 blocks, 30 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts: 14 blocks, 30 lines
[ok] apps/zcode-cli/packages/core/src/session-context/topic-archive.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
30.65% code=496 comment=152 apps/zcode-cli/packages/core/src/runtime/helpers/attachment-media-resolver.ts
30.79% code=406 comment=125 apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts
32.54% code=126 comment=41 apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts
33.00% code=100 comment=33 apps/zcode-cli/packages/core/src/session-context/topic-archive.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `cli/src/command-center/handlers/goal.ts` | /goal 命令 | 能力探测、无参摘要、四个子命令、replace 剥离、覆盖二次确认、统一续跑出口、Plan 模式说明 | 30 |
| `core/src/runtime/helpers/attachment-media-resolver.ts` | 媒体附件解析 | 三分派、降级不抛错、PDF 不解码、视频转路径、id 稳定、artifact 复用 mime、cwd 解析、读端二次限流 | 30 |
| `core/src/runtime/methods/usage-observability.ts` | 用量旁路写入 | 旁路 try/catch、权威用量优先、能力探测、主键含 attempt、TTFT 口径、工具状态机、取消单列、错误归因 | 30 |
| `core/src/session-context/topic-archive.ts` | 话题档案检索 | 可信输入来源、schema 校验、作用域收敛、id 去重、hasGap 传递、预算双封顶、超长预览收缩 | 30 |

## 3. 说明

- `goal.ts` 原 5 行注释（3.27%），块锚定入口、trim、能力探测、无参分支、action 拆分、pause/resume/clear、forceReplace、已有目标分支、setTarget、续跑出口与格式化函数。
- `attachment-media-resolver.ts` 原 149 行 JSDoc（30.04%），块锚定 inline 入口、图片分支、缩放调用、落盘调用、artifact mime 三元、PDF 分支、PDF 大小检查、video 兜底返回、视频超限、本地入口、stat.kind、PDF 子链路与图片子链路。
- `usage-observability.ts` 原 96 行 JSDoc（18.32%），首行 `/**` 在文件内出现 8 次，补 `firstNth: 1` 锚定文件头；块锚定 model 事实入口、usage 取值、写库、turn 入口、汇总、upsert、工具入口、toolCallId、调度阶段、结果阶段、取消判定、能力探测与主键函数。
- `topic-archive.ts` 原 1 行注释（0.95%），块锚定入口、用户消息过滤、intent 读取、schema 校验、作用域、去重表、needle、预算、下限、分页循环、超预算、预览收缩与游标。
- 本批两次锚点冲突：`persistAttachmentDataUrl(prepared.dataUrl, ...)` 在 inline 与本地图片各一次，补 `nth: 1`；`ToolCallScheduled` 分支在 turn 汇总与工具状态机各一次，补 `nth: 2`。另有一次 spec 行数 31 的本地校验失败（多一条 block），删掉冗余块后重新生成。失败均未落盘，最终 `deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`；总账 `4,562 + 555 = 5,117` PASS。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1830 needLines=25472 min=0.00 median=31.35
```

累计 1,398 文件 / 127,569 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b223 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=29 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=29 waterRate=24.17% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=221 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=1087 missing=0
```

- 结论：**六件套未全通过**。waterLines=29 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
