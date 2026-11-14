# ZC-DEEP-b95

> 批次：B95（6 文件，按 31.4% 口径计算目标 317 行，实际 +317）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b95\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b95
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=317

node check-batch.mjs ZC-deep-b95 ZC-deep-b95-files.txt
TOTAL added=317 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.20  341  234   73  51  packages/desktop/src/main/mcpUserDirectory/toml.ts
31.23  368  269   84  53  apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-results.ts
31.30  691  492  154  56  apps/zcode-cli/packages/adapters/src/model/runner-diagnostics.ts
31.35  338  252   79  51  apps/zcode-cli/packages/adapters/src/browser/playwright-command.ts
31.35  434  303   95  52  apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts
31.44  645  458  144  54  apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.20 median=31.33 newComments=317
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `exec/node-execution-adapter-results.ts` | 执行结果装配 | INV-01~18；状态优先级；诊断有门；artifact 结算 | 53 |
| `exec/bash-shell-provider.ts` | Bash 执行器探测 | INV-01~18；直接执行；快照优先；候选去重；失败降级 | 52 |
| `model/runner-diagnostics.ts` | 模型调用诊断 | INV-01~18；只汇总不改写；头值不落盘；空完成判定 | 56 |
| `browser/playwright-command.ts` | Playwright 动作执行 | INV-01~18；超时有界；会话必断；标记必清 | 51 |
| `plugins/zip-source.ts` | 远程 zip 插件源 | INV-01~18；先校验后下载；跨源去头；类型白名单 | 54 |
| `mcpUserDirectory/toml.ts` | TOML 读写 | INV-01~18；逐字符扫描；子表隔离；顺序稳定 | 51 |

合计 **317**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 结果状态有固定优先级

`node-execution-adapter-results.ts` 先看启动错误，再看超时、取消与输出限额。
顺序一旦颠倒，启动失败会被退出码分支描述成普通失败。

### 2. 诊断只汇总不改写

`runner-diagnostics.ts` 的累积函数只读 chunk 并写自家计数。
任何字段改写都会让后续消费者拿到脏数据。

### 3. 出站请求头只记键名

摘要函数永不输出头值，只保留键名与验证摘要。
把值写进日志等于把凭据落到磁盘。

### 4. 调试会话必须断

`playwright-command.ts` 在收尾断开临时会话，并吞掉断开失败。
缺这一步，每次求值都泄漏一个会话。

### 5. 跨源跳转丢弃自定义头

`zip-source.ts` 比较来源后清空自定义头再继续。
否则内部元数据会被带到第三方 CDN。

### 6. 解压路径必须双重校验

归一化阶段拒绝空字节、反斜杠与点段；解析阶段再做相对路径复核。
少任何一道，越界写入都可能落到临时目录之外。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 状态判断顺序颠倒 | 启动错误被描述成普通退出 |
| 空输出不区分退出码 | 正常无输出命令报输出丢失 |
| 诊断改写 chunk | 下游拿到被改写的流片段 |
| 头值写入日志 | 凭据落盘泄露 |
| 预览不截断 | 超大响应写满日志 |
| 求值不断会话 | 会话持续泄漏 |
| 断开异常上抛 | 清理失败覆盖真实结果 |
| 超时归零 | 所有动作立即超时失败 |
| 截图后不清标记 | 页面残留红色覆盖层 |
| 未支持动作不抛 | 错误被误判成页面问题 |
| 解压失败不清理 | 临时目录持续堆积 |
| 重定向不设上限 | 恶意跳转造成无限请求 |
| 跨源仍带头 | 内部元数据泄露给第三方 |
| 路径不做相对复核 | 越界文件写到临时目录外 |
| 符号链接放行 | 解压产生指向外部的链接 |
| 明文协议放行 | 请求发往任意主机 |
| TOML 引号不跟踪 | 字符串内逗号被切分 |
| 子表未隔离 | 环境变量平铺到服务顶层 |
| 剥离状态不结束 | 服务表之后的行被整段删除 |

## 断点报告（续跑基线）

- 最后完成批次：**B95**（6 文件 / +317 行 / 全绿）；`added=317`、硬校验全 0。
- 累计（core+apps）：**842 文件 / 105,670 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,382 个 coreBelow30 / 35,920 行**，完成度 **74.6%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.20%~31.44%，`suspicious=0`。
