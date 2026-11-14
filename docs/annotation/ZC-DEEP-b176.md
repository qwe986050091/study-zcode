# ZC-DEEP-B176（4 文件，+139 行）

> 范围：轨迹搜索高亮、MCP 存储迁移、browser-use 共享 schema 与 RPC 网络遥测中间件（合计 506 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b176\orig`；清单：`ZC-deep-b176-files.txt`。
> 目标密度 31.4%，实际落点 31.09%~31.62%。

## 1. 验收输出

```text
[ok] packages/ui/src/ModelTrajectorySearchHighlight.ts: 5 blocks, 35 lines
[ok] packages/ui/src/store/mcpStoreMigration.ts: 5 blocks, 35 lines
[ok] packages/shared/src/browser-use/command-metadata.ts: 5 blocks, 35 lines
[ok] packages/rpc/src/network-telemetry-middleware.ts: 5 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=139
TOTAL added=139 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.09% code=119 comment=37 packages/ui/src/ModelTrajectorySearchHighlight.ts
31.62% code=117 comment=37 packages/ui/src/store/mcpStoreMigration.ts
31.51% code=146 comment=46 packages/shared/src/browser-use/command-metadata.ts
31.45% code=124 comment=39 packages/rpc/src/network-telemetry-middleware.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/ModelTrajectorySearchHighlight.ts` | 搜索命中转浏览器高亮 | 能力探测、样式单次注入、当前项独立注册、展开态字段优先、中心差滚动 | 35 |
| `packages/ui/src/store/mcpStoreMigration.ts` | 旧通用 MCP 配置迁移 | 来源三条件、同名跳过、失败停写保留计数、仅完成才清旧数据、有变更才重读 | 35 |
| `packages/shared/src/browser-use/command-metadata.ts` | 命令与页面状态共享 schema | 边界单点、代理视口与人类偏好分离、严格结构、方法名即契约、错误码不兜底 | 35 |
| `packages/rpc/src/network-telemetry-middleware.ts` | RPC 调用遥测装饰 | 单一上报出口、耗时归一、接口名拼接、错误分类降级、异常原样重抛 | 34 |

## 3. 说明

- `ModelTrajectorySearchHighlight.ts` 的块落在名称常量、应用入口、滚动函数与区间收集函数前，tree walker 循环体未插入。
- `mcpStoreMigration.ts` 的块落在来源判定、导入入口、迁移入口与条目循环前，循环内异常分支保持零改动。
- `command-metadata.ts` 的块落在边界常量与三个 schema 声明前，枚举列表与字段列表未插入。
- `network-telemetry-middleware.ts` 首行 `/**` 在文件内重复（三个类各有一处），规格加 `firstNth: 1`。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2018 needLines=31155 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2014 needLines=26563
```

累计 1,210 文件 / 121,574 行。
