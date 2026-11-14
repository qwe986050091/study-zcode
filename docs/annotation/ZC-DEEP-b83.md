# ZC-DEEP-b83

> 批次：B83（6 文件，按 31.4% 口径计算目标 328 行，实际 +328，无补插）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b83\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b83
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=328

node check-batch.mjs ZC-deep-b83 ZC-deep-b83-files.txt
TOTAL added=328 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   251   189   59   55  packages/desktop/scripts/gen-ui-fixture/external-links-checks.ts
31.35   267   185   58   54  packages/desktop/src/main/desktopNetworkTelemetry.ts
31.40   256   172   54   54  packages/shared/src/settings-sync.ts
31.43   244   175   55   55  packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts
31.50   298   200   63   55  packages/desktop/src/main/mcpUserDirectory/legacy.ts
31.52   243   184   58   55  packages/desktop/scripts/mcp-apps-host-fixture/interaction-main.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.22 median=31.41 newComments=328
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/src/main/webRemoteControlSharedHostAttachments.ts` | 远程控制 host 附着 | INV-01~18；本地复用既有 host；页面标识换算；错误码契约；端口所有权转移；释放幂等与定向清理 | 55 |
| `desktop/src/main/desktopNetworkTelemetry.ts` | 网络指标聚合上报 | INV-01~18；环境相关间隔；未配置上下文跳发；维度字符串化；零样本不上报；空窗口短路 | 54 |
| `desktop/src/main/mcpUserDirectory/legacy.ts` | 旧版 MCP 配置只读迁移 | INV-01~18；只读不写回；逐层校验；候选优先级与去重；平衡括号扫描；新段优先 | 55 |
| `shared/src/settings-sync.ts` | 设置同步类型契约 | INV-01~18；代理与分类封闭联合；两层作用域；跳过原因封闭；三层发现结构；进度口径一致 | 54 |
| `desktop/scripts/gen-ui-fixture/external-links-checks.ts` | 外链打开与手势校验 | INV-01~18；只替换最终打开；真实聚焦与调试协议注入；成对附加分离；三种目标属性；非法协议拦截 | 55 |
| `desktop/scripts/mcp-apps-host-fixture/interaction-main.ts` | 插件卡片交互夹具 | INV-01~18；独立用户数据目录；就绪前注册特权协议；真实握手超时；隐藏不停帧；恢复后状态不变 | 55 |

合计 **328**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 附着的端口所有权随返回值转移

`webRemoteControlSharedHostAttachments.ts` 登记后才接管端口，唯一允许关闭的入口是释放函数。
调用方另持端口自行关闭，会让释放时二次关闭并在窗口销毁流程中抛错。

### 2. 埋点失败绝不打断主流程

`desktopNetworkTelemetry.ts` 的发送与定时回调都内部捕获异常，只写告警。
一次上报异常若向上冒泡，会让网络主流程与后续定时全部停止。

### 3. 迁移只读旧存储

`legacy.ts` 的全部读取函数都不写文件，解析失败一律归为未找到。
写回旧存储会让回滚后数据不一致，而抛错会让首次启动因缺少旧数据中断。

### 4. 候选顺序即优先级且去重保序

显式目录、旧存储、各运行形态的数据目录依次排列，去重但不打乱首次出现顺序。
顺序被重排会让新格式数据被旧副本抢先，迁移到过期配置。

### 5. 隐藏不等于销毁访客

`interaction-main.ts` 的隐藏态要求块级布局、透明、不可交互，同时访客仍存活并继续推进真实帧。
用显示隐藏会让后台帧断言失去意义，只检查访客存在则无法证明未停帧。

### 6. 类型文件不混入运行期值

`settings-sync.ts` 全部为类型声明，不含常量或函数。
混入运行期代码会把类型包拖进打包结果，破坏只在编译期被引用的约定。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 本地附着另起进程 | 窗口关闭后附件不回收 |
| 用窗口标识查 host | 部分窗口形态误报缺失 |
| 调用方自行关闭端口 | 释放时二次关闭抛错 |
| 生产沿用开发上报间隔 | 指标写入量放大 |
| 配置前发送事件 | 维度缺失、基数被污染 |
| 零样本仍上报均值 | 分位数被零值污染 |
| 迁移写回旧存储 | 回滚后数据不一致 |
| 候选顺序被重排 | 迁移到过期配置 |
| 按正则截取嵌套 JSON | 片段被截断、解析失败 |
| 隐藏访客时销毁 | 恢复后用户输入丢失 |
| 用脚本派发点击 | 覆盖不到真实手势路径 |
| 调试器未成对分离 | 后续用例无法附加 |

## 断点报告（续跑基线）

- 最后完成批次：**B83**（6 文件 / +328 行 / 全绿）；`added=328`、硬校验全 0。
- 累计（core+apps）：**770 文件 / 101,807 行**。
- 半插入残留：无（6 份 spec 的插入行数与文件实际增量逐一对齐）。
- 剩余缺口：按基线推导 **2,454 个 coreBelow30 / 39,783 行**，完成度 **71.9%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.22%~31.52%，`suspicious=0`。
