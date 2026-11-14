# ZC-DEEP-B150（4 文件，+160 行）

> 范围：分屏分隔条、发布包下载、服务器核心启动、能力地图 ELK 布局。
> 快照：`d:\code\_annot_baseline\ZC-deep-b150\orig`；清单：`ZC-deep-b150-files.txt`。
> 目标密度 31.4%，实际落点 31.35%~31.68%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/WorkbenchSplitDivider.tsx: 7 blocks, 40 lines
[ok] packages/zcode-server-cli/src/runtime/releaseDownload.ts: 6 blocks, 39 lines
[ok] packages/zcode-server-cli/src/server-core/core.ts: 7 blocks, 40 lines
[ok] apps/dev-docs/src/capability-map/capabilityMapLayout.ts: 7 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=160
TOTAL added=160 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.68% code=161 comment=51 packages/ui/src/v4/WorkbenchSplitDivider.tsx
31.39% code=137 comment=43 packages/zcode-server-cli/src/runtime/releaseDownload.ts
31.61% code=155 comment=49 packages/zcode-server-cli/src/server-core/core.ts
31.35% code=319 comment=100 apps/dev-docs/src/capability-map/capabilityMapLayout.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/v4/WorkbenchSplitDivider.tsx` | 可拖拽分屏分隔条与占比换算 | 引用持有拖动事实、帧合并写入 CSS 变量、指针身份与收尾提交 | 40 |
| `packages/zcode-server-cli/src/runtime/releaseDownload.ts` | 发布清单与归档下载、大小与校验和校验 | 统一超时、空闲与总时长上限、可重试判定、临时文件与原子改名 | 39 |
| `packages/zcode-server-cli/src/server-core/core.ts` | 服务器核心进程的启动装配与关闭流程 | 内建配置优先级、服务标识回退、心跳串行、关闭顺序与容错 | 40 |
| `apps/dev-docs/src/capability-map/capabilityMapLayout.ts` | ELK 两阶段能力地图布局与坐标拼装 | 必填数值校验、群内边过滤、标签锚点、worker 终止与单例 Promise | 41 |

## 3. 说明

- `WorkbenchSplitDivider.tsx` 的拖动帧合并逻辑已有注释，新块落在引用、状态与回调签名上。
- `releaseDownload.ts` 的分支密集，新块只放在函数签名与常量声明处，未插入条件体内。
- `core.ts` 的关闭与心跳段落已有说明，新块落在变量声明与订阅调用前。
- `capabilityMapLayout.ts` 已有 18.5% 注释，新块全部锚在没有前置注释的代码行上，插入后密度 31.35%。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
