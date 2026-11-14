# ZC-DEEP-B126（4 文件，+171 行）

> 范围：E2E 报告共享类型、docker 探测、CLI Provider 运行环境与桌面 ARMS 事件环。
> 快照：`d:\code\_annot_baseline\ZC-deep-b126\orig`；清单：`ZC-deep-b126-files.txt`。
> 目标密度 31.4%，实际落点 31.21%~31.65%。

## 1. 验收输出

```text
[ok] packages/e2e-report/src/shared/types.ts: 5 blocks, 44 lines
[ok] packages/server/src/remote/docker-detect.ts: 5 blocks, 44 lines
[ok] apps/zcode-cli/packages/cli/src/provider-runtime-env.ts: 5 blocks, 42 lines
[ok] packages/desktop/src/main/desktopArmsCustomEvent.ts: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=171
TOTAL added=171 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.43% code=140 comment=44 packages/e2e-report/src/shared/types.ts
31.65% code=158 comment=50 packages/server/src/remote/docker-detect.ts
31.51% code=146 comment=46 apps/zcode-cli/packages/cli/src/provider-runtime-env.ts
31.21% code=157 comment=49 packages/desktop/src/main/desktopArmsCustomEvent.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/e2e-report/src/shared/types.ts` | E2E 报告跨进程共享的数据形状 | 统计四件套、标题双层、覆盖率三项与运行标识 | 44 |
| `packages/server/src/remote/docker-detect.ts` | docker 可执行定位与容器列表解析 | PATH 优先、平台回退路径、逐行解析与探测失败口径 | 44 |
| `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` | CLI Provider 配置环境变量准备 | 入口判定、三级路径回退、随包资产定位与日志脱敏 | 42 |
| `packages/desktop/src/main/desktopArmsCustomEvent.ts` | main 进程 ARMS 事件捕获环 | 容量夹取、深拷贝、抑制名单校验与先记录后发送 | 41 |

## 3. 说明

- `types.ts` 首行即 `export interface NumericStats {`，文件头 `//` 块插在其上方；解析块改锚到 `ProcessSampleSummary`，避免与首块下标冲突。
- 其余三个文件首行为 `import`，头部插在模块最前。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
