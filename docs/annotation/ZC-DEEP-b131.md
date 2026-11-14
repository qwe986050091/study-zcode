# ZC-DEEP-B131（4 文件，+174 行）

> 范围：模型 Provider 反馈条、模型顺序拖拽、来源服务器更新活动与独立登录态 Provider 运行时桥。
> 快照：`d:\code\_annot_baseline\ZC-deep-b131\orig`；清单：`ZC-deep-b131-files.txt`。
> 目标密度 31.4%，实际落点 31.33%~31.65%。

## 1. 验收输出

```text
[ok] packages/ui/src/settings/model-provider-section/ProviderDetailFeedback.tsx: 5 blocks, 43 lines
[ok] packages/ui/src/settings/model-provider-section/SortableProviderModelList.tsx: 5 blocks, 43 lines
[ok] packages/ui/src/settings/SourceServerUpdateActivity.tsx: 5 blocks, 43 lines
[ok] apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts: 5 blocks, 45 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=174
TOTAL added=174 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.65% code=139 comment=44 packages/ui/src/settings/model-provider-section/ProviderDetailFeedback.tsx
31.33% code=150 comment=47 packages/ui/src/settings/model-provider-section/SortableProviderModelList.tsx
31.43% code=140 comment=44 packages/ui/src/settings/SourceServerUpdateActivity.tsx
31.39% code=309 comment=97 apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/settings/model-provider-section/ProviderDetailFeedback.tsx` | Provider 详情页页内反馈条的上下文与定时收起 | 同键原位更新、计时器清理、角色与指针事件隔离 | 43 |
| `packages/ui/src/settings/model-provider-section/SortableProviderModelList.tsx` | 模型顺序拖拽列表与纯函数重排 | 索引边界、交互目标排除、拖动样式与键稳定 | 43 |
| `packages/ui/src/settings/SourceServerUpdateActivity.tsx` | 来源服务器更新的阶段进度与操作日志 | 阶段文案穷举、进度语义切换、日志分级与键构造 | 43 |
| `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts` | 独立登录态 Provider 的目录投影、离线快照与请求期令牌桥 | 目录不缓存、键口径、显式离线与迟到签发复核 | 45 |

## 3. 说明

- `SortableProviderModelList.tsx` 首行 `import {` 出现两次，文件头按 `nth=1` 命中首个。
- `standalone-account-provider-runtime.ts` 首行 `/**` 出现多次，文件头按 `nth=1` 命中首个。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
