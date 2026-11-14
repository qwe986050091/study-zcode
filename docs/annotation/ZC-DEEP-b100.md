# ZC-DEEP-b100

> 批次：B100（6 文件，按 31.4% 口径计算目标 295 行，实际 +295）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按同目录优先选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b100\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b100
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=295

node check-batch.mjs ZC-deep-b100 ZC-deep-b100-files.txt
TOTAL added=295 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.15  259  183  57  50  packages/ui/src/web-remote-control/domain/presentation.ts
31.25  262  192  60  49  packages/provider/src/account-provider-resolution.ts
31.46  252  178  56  48  packages/shared/src/task-realtime.ts
31.51  330  238  75  49  packages/shared/src/zcode-protocol-v4/workflow-observation-display.ts
31.58  290  209  66  50  packages/shared/src/zcode-protocol-v4/wire-codec.ts
31.61  220  155  49  49  packages/shared/src/model-provider-family.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.15 median=31.49 newComments=295
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/model-provider-family.ts` | 供应商家族元数据 | INV-01~18；单表事实；根域无协议；子域边界 | 49 |
| `shared/src/zcode-protocol-v4/wire-codec.ts` | V4 帧计量与分片 | INV-01~18；三层取大；最坏头部；两层独立 | 50 |
| `shared/src/zcode-protocol-v4/workflow-observation-display.ts` | 观察卡 display schema | INV-01~18；两侧同步；新增即可选；限长对齐 | 49 |
| `shared/src/task-realtime.ts` | 任务实时共享合约 | INV-01~18；身份优先；区间连续；命令闭合 | 48 |
| `provider/src/account-provider-resolution.ts` | 账号 Provider 配置解析 | INV-01~18；单次求值；读取母体终态；循环检测 | 49 |
| `ui/src/web-remote-control/domain/presentation.ts` | 远控状态展示派生 | INV-01~18；目标同构；复用有界；失败按值比较 | 50 |

合计 **295**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 物理承载按三层取最大值

`wire-codec.ts` 同时计量 NDJSON 行、channel 二进制与中继 base64 三种承载。
只测逻辑 JSON，会在通道负载恰好贴线时被中继侧拒绝。

### 2. 逻辑预算与物理预算不可互相替代

`assembleTopicWireFrames` 先按逻辑字节判断是否分片，再按物理预算二分分片大小。
用物理预算放行超长逻辑帧，会造成单片重组后仍超限。

### 3. 情势截面五件必须全部可选

`workflow-observation-display.ts` 的 health、concurrency 等字段设为可选。
设为必填会让升级前写入的历史会话卡片整块被剥，退化成纯文本。

### 4. 派生入口只读母体最终状态

`account-provider-resolution.ts` 的派生 Provider 通过 `states` 读取母体本轮已解析状态。
自己再判一次可用性，会在未知态与 current 之间出现同轮分裂。

### 5. 继承链必须有循环检测

配置解析用访问栈检测 A→B→A，命中即抛错。
没有检测时互相继承会无限递归，栈溢出。

### 6. 远控会话复用要求已连接

`isReusableWebRemoteControlSession` 只在手机已连接时允许跨工作区复用。
未连接会话跨工作区复用会把新扫码用户带回旧默认工作区。

### 7. 失败对象按值比较

`isSameWebRemoteControlStatus` 只比较失败的原因与消息，不比较对象引用。
按引用比较会让每次轮询新建的失败对象都触发状态更新。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 家族根域带协议 | 端点反查永不命中 |
| 子域匹配不用点号边界 | evilz.ai 被误认为 z.ai |
| 只测逻辑 JSON 字节 | 中继侧拒绝边界帧 |
| 分片预算估算偏小 | 实际分片仍超物理上限 |
| 分片预算为零仍切片 | 死循环 |
| 两条路径各写一份分析器 | 两侧对同一批次得出不同结果 |
| 观察卡新字段设为必填 | 历史会话卡片退化成纯文本 |
| 列表行携带完整详情 | 大运行列表载荷膨胀 |
| 派生 Provider 自判权益 | 同轮状态分裂 |
| 继承链无循环检测 | 栈溢出 |
| 未知态清空展示事实 | 网络抖动导致权益显示消失 |
| 观望态复用会话 | 跨工作区带回旧默认工作区 |
| 失败按引用比较 | 每次轮询都触发状态更新 |
| 空失败仍渲染提示 | 界面出现空提示框 |

## 断点报告（续跑基线）

- 最后完成批次：**B100**（6 文件 / +295 行 / 全绿）；`added=295`、硬校验全 0。
- 累计（core+apps）：**872 文件 / 107,201 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,352 个 coreBelow30 / 34,389 行**，完成度 **75.7%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.15%~31.61%，`suspicious=0`。
