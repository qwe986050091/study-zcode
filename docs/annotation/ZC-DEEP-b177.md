# ZC-DEEP-B177（4 文件，+139 行）

> 范围：Open Collective 月度汇总脚本、闲时任务展示映射、ACK 激活屏障与工作区钩子评审 store（合计 598 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b177\orig`；清单：`ZC-deep-b177-files.txt`。
> 目标密度 31.4%，实际落点 30.97%~31.55%。

## 1. 验收输出

```text
[ok] docs/knip/docs/scripts/get-monthly-sponsorships-opencollective.ts: 5 blocks, 35 lines
[ok] packages/ui/src/settings/offPeakUiPresentation.ts: 5 blocks, 35 lines
[ok] packages/ui/src/v4/ackActivationBarrier.ts: 5 blocks, 34 lines
[ok] packages/ui/src/store/workspaceHookReviewStore.ts: 5 blocks, 35 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=139
TOTAL added=139 hardBad=0 suspicious=0
```

逐文件密度：

```text
30.97% code=113 comment=35 docs/knip/docs/scripts/get-monthly-sponsorships-opencollective.ts
31.33% code=166 comment=52 packages/ui/src/settings/offPeakUiPresentation.ts
31.06% code=132 comment=41 packages/ui/src/v4/ackActivationBarrier.ts
31.55% code=187 comment=59 packages/ui/src/store/workspaceHookReviewStore.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `docs/knip/docs/scripts/get-monthly-sponsorships-opencollective.ts` | 赞助与支出月度净额汇总 | 令牌只读环境、按月建零、月末不溢出、贡献类型过滤、固定汇率与分转元、闭区间裁剪 | 35 |
| `packages/ui/src/settings/offPeakUiPresentation.ts` | 闲时任务展示映射 | 三类禁用原因 fail-closed、分钟向上取整、标题仅随语言默认值变化、状态映射单一来源 | 35 |
| `packages/ui/src/v4/ackActivationBarrier.ts` | ACK 前有界暂存订阅帧 | 主题分组双索引、条数与字节双上限、越界整批清空、激活只投递本订阅、代次失效全清 | 34 |
| `packages/ui/src/store/workspaceHookReviewStore.ts` | 评审请求与命令通道绑定 | 会话隔离、发送函数身份保护、单调性裁决单一来源、授权三项匹配、等待结算一次 | 35 |

## 3. 说明

- 脚本文件的块落在汇总函数、建零循环、支出分支与对外入口前，GraphQL 查询文本未改动。
- `offPeakUiPresentation.ts` 的块落在提示样式常量、禁用原因、剩余时长与状态页脚函数前，switch 分支体未插入。
- `ackActivationBarrier.ts` 的块落在上限常量、接口、工厂与清理函数前，接收循环体保持零改动。
- `workspaceHookReviewStore.ts` 的块落在命令绑定接口、store 创建、授权查找与工作区匹配函数前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2014 needLines=31022 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2010 needLines=26430
```

累计 1,214 文件 / 121,713 行。
