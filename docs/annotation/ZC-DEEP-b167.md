# ZC-DEEP-B167（4 文件，+152 行）

> 范围：遥测错误清洗器、TUI 文件提及控制器、macOS 辅助功能授权 IPC 与帧率预测（合计 1,338 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b167\orig`；清单：`ZC-deep-b167-files.txt`。
> 目标密度 31.4%，实际落点 31.29%~31.58%。

## 1. 验收输出

```text
[ok] apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts: 4 blocks, 37 lines
[ok] apps/zcode-cli/packages/tui/src/app-file-mentions.ts: 4 blocks, 38 lines
[ok] packages/desktop/src/main/desktopCuaPermissionIpc.ts: 5 blocks, 41 lines
[ok] packages/stream-animate/src/server/frameForecast.ts: 4 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=152
TOTAL added=152 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.37% code=153 comment=48 apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts
31.29% code=278 comment=87 apps/zcode-cli/packages/tui/src/app-file-mentions.ts
31.48% code=413 comment=130 packages/desktop/src/main/desktopCuaPermissionIpc.ts
31.58% code=114 comment=36 packages/stream-animate/src/server/frameForecast.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/telemetry/src/error-sanitizer.ts` | 异常到可上报描述的清洗与认领 | 标识白名单、原因链长度、弱引用认领、先截断后清洗、URL 与密钥抹除、空正文归一 | 37 |
| `apps/zcode-cli/packages/tui/src/app-file-mentions.ts` | 文件 @ 提及的识别、候选拉取与补全 | 紧贴空白触发、token 无空白、关闭记忆键、中止旧查询、窗口靠底、附件占位符去重 | 38 |
| `packages/desktop/src/main/desktopCuaPermissionIpc.ts` | macOS 授权引导 IPC 与拖拽浮窗 | 图标兜底与缓存、应用级返回判定、监听先于打开、结束一次性与收尾、指纹 TOCTOU、终态销毁浮窗 | 41 |
| `packages/stream-animate/src/server/frameForecast.ts` | 帧字符曲线观测与外推预测 | 窗口帧下限、分位峰值、裁剪后平滑、增量滚动和、近期片段夹取、趋势衰减与限幅 | 36 |

## 3. 说明

- `error-sanitizer.ts` 的块锚定主清洗入口、正文清洗与对象链函数，未进入规则链内部。
- `app-file-mentions.ts` 首行已是文件级说明注释，新增头块整体落在其前方；块锚定 hook 签名、识别函数与补全函数。
- `desktopCuaPermissionIpc.ts` 的块落在图标解析、返回等待、权限归一与频道注册签名，未插入 Promise 内部的事件回调。
- `frameForecast.ts` 的块只锚定三个函数签名，未进入数值循环体。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2054 needLines=32367 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2050 needLines=27775
```

累计 1,174 文件 / 120,269 行。
