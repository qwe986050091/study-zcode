# ZC-DEEP-B224（4 文件，+120 行）

> 范围：Desktop 主进程的 ARMS 遥测引导、浏览器命令分派、Windows 右键菜单注册与启动工作区解析（合计 549 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b224\orig`；清单：`ZC-deep-b224-files.txt`。
> 目标密度 30% 以上，实际落点 31.43%~33.33%。

## 1. 验收输出

```text
[ok] packages/desktop/src/main/appARMSBootstrap.ts: 14 blocks, 30 lines
[ok] packages/desktop/src/main/browserView/browserCommandExecutor.ts: 14 blocks, 30 lines
[ok] packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts: 14 blocks, 30 lines
[ok] packages/desktop/src/main/startupWorkspace.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
31.43% code=210 comment=66 packages/desktop/src/main/appARMSBootstrap.ts
32.79% code=122 comment=40 packages/desktop/src/main/startupWorkspace.ts
33.06% code=121 comment=40 packages/desktop/src/main/browserView/browserCommandExecutor.ts
33.33% code=96 comment=32 packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `main/appARMSBootstrap.ts` | ARMS 遥测引导 | 上报前闸门、环境按运行形态、device_mid 走 user.name、采样率、单页模式、crash 可执行文件与角色分级、脱敏顺序、init 必须 await | 30 |
| `main/browserView/browserCommandExecutor.ts` | 浏览器命令分派 | 结构化返回、永不 throw、耗时统一、取消优先、双源识别、未实现显式声明、信号透传、类型出口集中 | 30 |
| `main/desktopWindowsOpenFolderContextMenu.ts` | Windows 右键菜单 | HKCU 作用域、双挂载点、键名固定、文案回退、参数转义、占位符保留、入口绝对化、失败只告警 | 30 |
| `main/startupWorkspace.ts` | 启动工作区解析 | 读取永不抛错、预热上限 1、只预热本地、可用性三重校验、cwd 兜底、新字段优先、索引夹取 | 30 |

## 3. 说明

- `appARMSBootstrap.ts` 原 20 行注释（8.70%），块锚定长任务归因入口、非长任务早退、properties 合并、崩溃判定、可执行文件校验、全等比较、角色读取、崩溃过滤入口、crash_scope、环境常量、device_mid 常量、useReporter 包装与 beforeReport。
- `browserCommandExecutor.ts` 原 8 行 JSDoc（6.20%），块锚定分派入口、done 包装、navigate/back/evaluate/playwright 四个分支、Playwright 调用、default、不支持错误码、取消与超时判定、错误码三元与类型出口。
- `desktopWindowsOpenFolderContextMenu.ts` 原 4 行注释（4.00%），块锚定键名常量、文案表、取文案、参数转义、命令构造、动作参数、条目构造、MUIVerb 条目、runRegAdd、退出码错误、安装入口、平台守卫与开发态入口绝对化。
- `startupWorkspace.ts` 原 12 行注释（8.96%），块锚定设置读取、非法结构分支、预热上限常量、引导接口、可用性校验、access 权限、活动会话解析、索引夹取、打开工作区入口、启动解析入口、sessions 构造、不可用路径分支与本地会话索引。
- 四份 spec 全部一次插入成功；`deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`；总账 `4,562 + 555 = 5,117` PASS。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1826 needLines=25364 min=0.00 median=31.35
```

累计 1,402 文件 / 127,689 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b224 | 提交 b34d5ba5 | numstat 120 0 | 门禁 PASS
```

口径与边界：

- **提交边界不代表批次边界。** 本批由 `b34d5ba5` 单独提交（numstat 120 0），与快照提交 `a8784b7e` 无关。
- 门禁以 `b34d5ba5^` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=0 addedCommentLines=120 waterLines=0 waterRate=0.00%
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=189 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=261 missing=0
```

- 结论：六件套全部通过，本批可标「已提交、已验证」。
