# ZC-DEEP-B165（4 文件，+146 行）

> 范围：桌面端夹具（统一风格检查、托管式 MCP 应用夹具、存储清理检查）与 Source Server 发行包解析器（合计 840 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b165\orig`；清单：`ZC-deep-b165-files.txt`。
> 目标密度 31.4%，实际落点 31.15%~31.58%。

## 1. 验收输出

```text
[ok] packages/desktop/scripts/gen-ui-fixture/style-checks.ts: 4 blocks, 36 lines
[ok] packages/desktop/scripts/mcp-apps-host-fixture/managed-main.ts: 4 blocks, 36 lines
[ok] packages/desktop/scripts/mcp-apps-host-fixture/storage-checks.ts: 4 blocks, 36 lines
[ok] packages/desktop/src/host/sourceServerReleaseResolver.ts: 4 blocks, 38 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=146
TOTAL added=146 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.15% code=122 comment=38 packages/desktop/scripts/gen-ui-fixture/style-checks.ts
31.58% code=114 comment=36 packages/desktop/scripts/mcp-apps-host-fixture/managed-main.ts
31.40% code=121 comment=38 packages/desktop/scripts/mcp-apps-host-fixture/storage-checks.ts
31.46% code=267 comment=84 packages/desktop/src/host/sourceServerReleaseResolver.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/scripts/gen-ui-fixture/style-checks.ts` | 真实 guest 中的统一风格令牌校验 | 强制伪类测焦点、探针每轮重建、收敛轮询与三秒截止、控件尺寸契约、探针与宿主令牌互证、收尾清理 | 36 |
| `packages/desktop/scripts/mcp-apps-host-fixture/managed-main.ts` | 托管式 MCP 应用端到端夹具 | 参数与目录隔离、就绪前注册协议、检查超时分级、失败现场落盘、通过逐个打印、退出码区分成败 | 36 |
| `packages/desktop/scripts/mcp-apps-host-fixture/storage-checks.ts` | 插件沙箱清理存储的时序与拒绝语义校验 | 分区去重、哨兵基线、清理钩子包装仍调原生、未完成前拒绝注册与重开、释放信号幂等 | 36 |
| `packages/desktop/src/host/sourceServerReleaseResolver.ts` | Source Server 发行包解析器 | 平台白名单、开发态不回退 CDN、本地候选仍校验、远端候选按序尝试、原子写与临时文件清理、错误归一化保留原型 | 38 |

## 3. 说明

- `style-checks.ts` 的块锚定函数签名、调试附着与统一命令出口，未进入内联的读数脚本字符串。
- `managed-main.ts` 的块落在参数解构、检查包装器与通用检查调用处，未插入事件等待回调内部。
- `storage-checks.ts` 的块落在分区集合、主入口签名与完成标志处，未插入页面内执行字符串。
- `sourceServerReleaseResolver.ts` 首行已是文件级说明注释，新增头块整体落在其前方；其余块锚定结构体、校验函数与原子写函数签名。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2062 needLines=32647 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2058 needLines=28055
```

累计 1,166 文件 / 119,970 行。
