# ZC-DEEP-B182（4 文件，+138 行）

> 范围：远控 IPC 接线、主进程打开路径助手、截图表面契约、内置浏览器权限闸门（合计 666 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b182\orig`；清单：`ZC-deep-b182-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.50%。

## 1. 验收输出

```text
[ok] packages/desktop/src/main/desktopWebRemoteControlIpc.ts: 5 blocks, 35 lines
[ok] packages/desktop/src/main/desktopMainIpcHelpers.ts: 5 blocks, 34 lines
[ok] packages/desktop/src/main/browserView/browserScreenshotSurfaceContracts.ts: 4 blocks, 33 lines
[ok] packages/desktop/src/main/embeddedBrowserPermissionPolicy.ts: 5 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=138
TOTAL added=138 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.50% code=127 comment=40 packages/desktop/src/main/desktopWebRemoteControlIpc.ts
31.40% code=121 comment=38 packages/desktop/src/main/desktopMainIpcHelpers.ts
31.25% code=112 comment=35 packages/desktop/src/main/browserView/browserScreenshotSurfaceContracts.ts
31.37% code=306 comment=96 packages/desktop/src/main/embeddedBrowserPermissionPolicy.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../main/desktopWebRemoteControlIpc.ts` | 远控 IPC 接线 | 埋点旁路不影响终态、窗口缺失显式报错、授权先于启动、通知不阻塞、状态查询回空闲 | 35 |
| `.../main/desktopMainIpcHelpers.ts` | 打开路径与截图助手 | 空路径直接失败、规范化后回退、失败返回结构、平台差异集中、截图需校验窗口 | 34 |
| `.../main/browserView/browserScreenshotSurfaceContracts.ts` | 截图表面契约 | 一像素容差、释放幂等、可选字段不写键、分组区分准备与就绪、载荷互转 | 33 |
| `.../main/embeddedBrowserPermissionPolicy.ts` | 内置浏览器权限闸门 | 默认拒绝兜底、白名单仅无害权限、站点记录先于会话、同源共享询问、设备选择器全局唯一 | 36 |

## 3. 说明

- `desktopWebRemoteControlIpc.ts` 的块落在管理器接口、埋点包装、启动操作与注册函数前；既有「交互边界」与「Bug 根因」注释保持原样。
- `desktopMainIpcHelpers.ts` 的块落在四个导出/内部函数签名前；两处路径回退的既有注释未动。
- `browserScreenshotSurfaceContracts.ts` 的释放函数签名较长，锚点取整行以避免命中失败；块只落在三个导出函数前。
- `embeddedBrowserPermissionPolicy.ts` 的块落在来源解析、策略应用、请求处理与检查处理前；已有 60 行安全说明保持原样。
- 本批 1 次锚点修正（`releaseBrowserScreenshotResourceOnce` 需整行签名），修正后 check 一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1994 needLines=30361 min=0.00 median=31.32
本会话范围 files=4562 coreBelow30=1990 needLines=25769
```

累计 1,234 文件 / 122,403 行。
