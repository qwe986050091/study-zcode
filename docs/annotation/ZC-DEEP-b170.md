# ZC-DEEP-B170（4 文件，+142 行）

> 范围：简化反馈提交、插件引用目录 hook、任务侧栏内存与时间线身份键（合计 715 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b170\orig`；清单：`ZC-deep-b170-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.53%。

## 1. 验收输出

```text
[ok] packages/ui/src/feedback/feedbackSubmitSubmission.ts: 4 blocks, 35 lines
[ok] packages/ui/src/hooks/usePluginReferenceCatalog.ts: 4 blocks, 36 lines
[ok] packages/ui/src/lib/taskSidePaneMemory.ts: 4 blocks, 36 lines
[ok] packages/ui/src/lib/zcodeTimelineIdentity.ts: 4 blocks, 35 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=142
TOTAL added=142 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.53% code=111 comment=35 packages/ui/src/feedback/feedbackSubmitSubmission.ts
31.35% code=185 comment=58 packages/ui/src/hooks/usePluginReferenceCatalog.ts
31.52% code=165 comment=52 packages/ui/src/lib/taskSidePaneMemory.ts
31.25% code=112 comment=35 packages/ui/src/lib/zcodeTimelineIdentity.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/feedback/feedbackSubmitSubmission.ts` | 简化反馈到工单与提交任务 | 描述必填、标题派生、分类默认、联系偏好不阻塞提交、截图剔除本地句柄、设备快照只读一次 | 35 |
| `packages/ui/src/hooks/usePluginReferenceCatalog.ts` | 插件引用目录的权威读取 | 作用域绑定、键覆盖工作区与会话与代次、重启推进代次、序号丢弃过期回包、失败不回退数据源 | 36 |
| `packages/ui/src/lib/taskSidePaneMemory.ts` | 工作区级侧栏内存与 LRU | 工作区隔离、阅读即访问、固定容量、完整视图整块替换、自动打开一次性消费 | 36 |
| `packages/ui/src/lib/zcodeTimelineIdentity.ts` | 合成时间线段的身份键与合并 | 类型分组、缺字段不生成键、四维压缩身份、分叉键含检查点、同类型字段级合并 | 35 |
| 合计 | — | — | **142** |

## 3. 说明

- `feedbackSubmitSubmission.ts` 首行是 `import {`，在文件内多次出现，头部锚点用 `firstNth: 1` 定位首行。
- `usePluginReferenceCatalog.ts` 的块落在 hook 签名、作用域 memo 与序号自增处，未进入请求体与事件回调。
- `taskSidePaneMemory.ts` 的块落在内存表、读取函数与写入函数签名，未插入分支体内。
- `zcodeTimelineIdentity.ts` 的块只锚定三个导出函数签名，未进入键拼接的模板字符串。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2042 needLines=31958 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2038 needLines=27366
```

累计 1,186 文件 / 120,720 行。
