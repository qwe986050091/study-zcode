# ZC-DEEP-b81

> 批次：B81（6 文件，按 31.4% 口径计算目标 343 行，实际 +343，无补插）。
> 逐文件独立 spec、逐份自检后一次插入；单批控制在 6 个文件以内。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b81\orig`；开工前 6 文件均为 `newComments=0`（30% 口径 needLines=324）。

## 校验

```
node zc-verify.mjs ZC-deep-b81
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=343

node check-batch.mjs ZC-deep-b81 ZC-deep-b81-files.txt
TOTAL added=343 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.33   326   233    73   57  packages/shared/src/telemetry.ts
31.36   332   236    74   57  packages/shared/src/node/atomicFileLock.ts
31.42   355   261    82   57  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugin-reference-catalog.ts
31.55   486   336   106   59  apps/zcode-cli/packages/core/src/errors/error-payload.ts
31.64   243   177    56   56  packages/e2e-report/src/viewer/CoveragePanel.tsx
31.67   245   180    57   57  packages/shared/src/desktopMenu.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.33 median=31.48 newComments=343
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/desktopMenu.ts` | 桌面菜单双语文案字典 | INV-01~18；ID 表为唯一真源；值即字面键；Record 键域约束；语言回退只在入口；占位符全局替换 | 57 |
| `shared/src/node/atomicFileLock.ts` | 跨进程文件锁 | INV-01~18；mkdir 即互斥凭证；owner token 精确释放；等待时长不构成陈旧证据；超时不再回收；双形态兼容 | 57 |
| `shared/src/telemetry.ts` | 埋点维度白名单与清洗 | INV-01~18；清洗只作用于副本；维度枚举；标识长度与字符集；错误原文整体替换；严格模式 schema | 57 |
| `core/src/errors/error-payload.ts` | 错误链投影 | INV-01~18；只认结构化字段归因；主帧选择；十二层展开防环；错误码有序选择；可选字段条件展开 | 59 |
| `e2e-report/src/viewer/CoveragePanel.tsx` | 覆盖率报告面板 | INV-01~18；无数据禁用态；派生排序不改入参；两种口径二选一；表格分支互斥；行键稳定 | 56 |
| `bootstrap/src/zcode-protocol/plugin-reference-catalog.ts` | 插件引用协议 handler | INV-01~18；会话与工作区权威二选一；展示与身份分离；推荐只信官方市场；刷新超时须中止底层请求 | 57 |

合计 **343**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 锁的陈旧判定不能用自己的等待时长

`atomicFileLock.ts` 只回收 owner 已退出、或无进程号且超过宽限的锁。
若按「我等了很久」判定，旧锁释放后会误删后来 writer 的新锁，两个进程同时写同一份文件。

### 2. 超时后不再尝试回收

达到等待上限直接抛结构化超时错误，不再先做一次回收。
旧顺序下，损坏的无主锁可能恰好在这次检查跨过宽限，让超时 waiter 越界删除他人的锁。

### 3. 埋点清洗只作用于上报副本

`sanitizePluginTelemetryDetail` 返回新对象，业务 detail 与错误原文保持原样。
原地删键会让调试面板与业务日志同时失去诊断信息，且排查时无法复现上报前的真实值。

### 4. 错误归因只认结构化字段

`error-payload.ts` 从上下文中读 provider、model、transport、状态码，绝不用文案分类。
文案会本地化、会改措辞，用文本判定会让统计口径与界面分支一起漂移。

### 5. 会话权威与工作区权威不可混流

`plugin-reference-catalog.ts` 带会话标识时只读该会话冻结的目录；会话不存在时按协议错误失败。
静默回退到工作区会让已结束会话的残余请求读到当前目录，引用到并非当初冻结的身份。

### 6. 展示字段不进入身份

图标与本地化名来自商店 listing，只用于选择器与 chip 展示。
把它们并进冻结身份，会让同一会话的插件引用随商店更新而漂移。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 用等待时长判定陈旧 | 误删他人新锁，两个进程同时写同一文件 |
| 超时前仍尝试回收 | 超时 worker 越过上限删除后来者的锁 |
| 无主宽限超过等待上限 | 进程永远等不到回收时机，全部超时 |
| 元数据时间戳放行未来值 | 锁永久达不到陈旧条件，目录泄漏 |
| 把权限错误当竞争重试 | 等到超时才失败，掩盖目录权限问题 |
| 错误链展开不防环 | 自引用错误导致无限循环 |
| 归因用文案分类 | 改措辞后统计与界面分支同时漂移 |
| 埋点清洗原地删键 | 调试信息丢失且无法复盘上报前原值 |
| 会话缺失回退工作区 | 已结束会话读到当前目录，越权引用 |
| 刷新超时不中止底层请求 | 旧操作继续改写目录快照 |
| 展示字段并进身份 | 会话引用随商店更新漂移 |

## 断点报告（续跑基线）

- 最后完成批次：**B81**（6 文件 / +343 行 / 全绿）；`added=343`、硬校验全 0。
- 累计（core+apps）：**758 文件 / 101,140 行**。
- 半插入残留：无（6 份 spec 的插入行数与文件实际增量逐一对齐，无多余临时文件）。
- 剩余缺口：按基线推导 **2,466 个 coreBelow30 / 40,450 行**，完成度 **71.4%**；
  全仓实测 `files=5032 coreBelow30=2477 needLines=50709 median=30.21`（services 已收口）。

> 说明：目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.33%~31.67%，`suspicious=0`。
