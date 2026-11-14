# ZC-DEEP-B139（4 文件，+191 行）

> 范围：渲染进程动作追踪 IPC、Provider 注册服务、注册表视图与 stream-animate 演示页。
> 快照：`d:\code\_annot_baseline\ZC-deep-b139\orig`；清单：`ZC-deep-b139-files.txt`。
> 目标密度 31.4%，实际落点 31.21%~31.54%。

## 1. 验收输出

```text
[ok] packages/desktop/src/main/rendererActionTraceIpc.ts: 5 blocks, 40 lines
[ok] packages/provider/src/registry-service.ts: 8 blocks, 64 lines
[ok] packages/provider/src/registry.ts: 5 blocks, 46 lines
[ok] packages/stream-animate/src/App.tsx: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=191
TOTAL added=191 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.30% code=131 comment=41 packages/desktop/src/main/rendererActionTraceIpc.ts
31.52% code=276 comment=87 packages/provider/src/registry-service.ts
31.21% code=157 comment=49 packages/provider/src/registry.ts
31.54% code=130 comment=41 packages/stream-animate/src/App.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/main/rendererActionTraceIpc.ts` | 渲染进程动作追踪的 IPC 注册与实例绑定 | 实例生命周期、过期拒收、定时刷新与清理对称 | 40 |
| `packages/provider/src/registry-service.ts` | 三层 Provider 配置的汇总裁剪与热刷新 | 代际合并、发布条件、失败语义与等待者结算 | 64 |
| `packages/provider/src/registry.ts` | 供应商与模型的冻结视图与选择校验 | 索引重建、重复检测、错误编码与逐层冻结 | 46 |
| `packages/stream-animate/src/App.tsx` | 演示页的状态编排与页面装配 | 并行加载、轮询开关、提交去重与详情回写 | 41 |

## 3. 说明

- `registry-service.ts` 体量较大（334 行），采用 7 个正文块覆盖类字段、启动、刷新、销毁、请求合并与结算。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
