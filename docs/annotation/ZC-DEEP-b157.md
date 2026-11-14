# ZC-DEEP-B157（4 文件，+163 行）

> 范围：标题生成旁路、后台任务追踪、推文正文改写与 sampling 夹具检查（合计 1,700 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b157\orig`；清单：`ZC-deep-b157-files.txt`。
> 目标密度 31.4%，实际落点 31.36%~31.62%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts: 7 blocks, 40 lines
[ok] apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts: 8 blocks, 49 lines
[ok] docs/knip/docs/src/util/post.ts: 6 blocks, 37 lines
[ok] packages/desktop/scripts/mcp-apps-host-fixture/sampling-extra-checks.ts: 6 blocks, 37 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=163
TOTAL added=163 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.41% code=312 comment=98 apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts
31.36% code=982 comment=308 apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts
31.62% code=117 comment=37 docs/knip/docs/src/util/post.ts
31.62% code=117 comment=37 packages/desktop/scripts/mcp-apps-host-fixture/sampling-extra-checks.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts` | 以独立无工具请求生成会话标题并单独上报用量 | 上下文冻结与借票、独立超时与 abortSignal 绑定、先落 ModelRequest、失败也记 usage、工具调用即违约、标题清洗顺序 | 40 |
| `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts` | 跟踪后台任务、轮询或等待终态并发事件与通知 | 双口径 taskId 与幂等、注册与 started 顺序、回滚、lost 收敛、签名去重、通知认领与释放、报告与产物分段 | 49 |
| `docs/knip/docs/src/util/post.ts` | 把推文短链、媒体与外链改写成 HTML 片段 | 倒序替换避免截断、媒体分支、长文媒体追加、原地改写、固定 UTC 格式化、实体类型声明 | 37 |
| `packages/desktop/scripts/mcp-apps-host-fixture/sampling-extra-checks.ts` | 验证 sampling 的权限、错误、并发与关闭语义 | 公共请求体、独立作用域、授权历史不增、会话不被写入、错误只到 SDK 一次、并发与取消隔离、订阅释放 | 37 |

## 3. 说明

- `background-tasks.ts` 的 header 严格保持 22 行（18 条 INV + 分隔 + 3 行职责），块合计 27 行，总计 49。
- `title-generation-sidecar.ts` 与 `background-tasks.ts` 首行均为重复出现的 `import {` 或分隔线，文件头使用 `nth: 1`。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
