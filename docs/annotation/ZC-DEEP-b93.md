# ZC-DEEP-b93

> 批次：B93（6 文件，按 31.4% 口径计算目标 318 行，实际 +318）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b93\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b93
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=318

node check-batch.mjs ZC-deep-b93 ZC-deep-b93-files.txt
TOTAL added=318 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28  334  243   76  52  packages/desktop/src/main/embeddedBrowserPermissionUiBridge.ts
31.28  512  374  117  55  apps/zcode-cli/packages/core/src/tool/handlers/node-repl.ts
31.32  415  281   88  52  apps/zcode-cli/packages/core/src/tool/handlers/bash-semantics.ts
31.54  335  241   76  54  packages/desktop/src/main/crashDumpAnnotations.ts
31.55  293  206   65  53  packages/desktop/src/main/desktopTray.ts
31.60  317  231   73  52  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-git.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.28 median=31.43 newComments=318
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `core/src/tool/handlers/node-repl.ts` | 持久 Node REPL 工具 | INV-01~18；会话复用；代际断言；截图落盘可失败；高风险口径 | 55 |
| `core/src/tool/handlers/bash-readonly-policy-flags-git.ts` | git 只读 flag 表 | INV-01~18；片段只读；表外从严；取值标注；组合顺序 | 52 |
| `core/src/tool/handlers/bash-semantics.ts` | Bash 语义汇总 | INV-01~18；保守判定；写选项即否；匹配器兜底；退出码语义 | 52 |
| `desktop/src/main/crashDumpAnnotations.ts` | 崩溃转储注解解析 | INV-01~18；键白名单；长度先行；首值优先；绝不抛出 | 54 |
| `desktop/src/main/desktopTray.ts` | 桌面托盘与未读角标 | INV-01~18；单实例；双档表示；零值复原；无托盘静默 | 53 |
| `desktop/src/main/embeddedBrowserPermissionUiBridge.ts` | 内置浏览器权限桥 | INV-01~18；结算一次；超时兜底；载荷校验；回调隔离 | 52 |

合计 **318**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 浏览器回调必须重读当前回合

`node-repl.ts` 让传输回调从模块表取最近一次上下文。
持有创建时的信号会让取消对不上新回合，旧回调还能写入已结束的回合。

### 2. 代际断言要做两次

`node-repl.ts` 在 await 前后各断言一次代际。
只在进入时检查，重置期间返回的结果仍会污染新单元格。

### 3. 安全表外的 flag 一律走危险分支

`bash-readonly-policy-flags-git.ts` 只收录输出与筛选选项。
表外默认放行等于给未知写选项开口子。

### 4. 分类不等于授权

`bash-semantics.ts` 的搜索、读取、列举集合只服务界面分类。
把它当成免审批依据，会让带写选项的命令直接跳过审批。

### 5. 坏 dump 不能阻断归档

`crashDumpAnnotations.ts` 的所有失败路径都返回空对象。
一旦抛异常，取证信息缺失会升级成归档流程中断。

### 6. 未读清零必须恢复原图

`desktopTray.ts` 在标签为空时设置基础图。
只跳过合成而不复原，角标会一直留在托盘上。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 每次调用新建会话 | 顶层声明与全局状态丢失 |
| 传输不做代际断言 | 重置后的迟到结果污染新单元格 |
| 回合结束不清上下文 | 回调引用已结束的回合 |
| 截图写入失败即抛 | 已成功的浏览器命令被改判失败 |
| 安全表混入写选项 | 只读判定整体失效 |
| 未知 flag 默认放行 | 新增写选项绕过审批 |
| 命令分类当授权 | 带写选项的命令免审批执行 |
| 复合命令只校验首段 | 后续命令段完全不受约束 |
| 解析失败仍放行 | 半解析命令进入权限链 |
| 注解长度不校验 | 错位读取得到乱码键值 |
| 坏 dump 抛异常 | 归档流程被一份损坏文件中断 |
| 超大 dump 同步读取 | 主进程卡死，界面无响应 |
| 托盘重复创建 | 通知区域出现两个图标 |
| 角标只挂单档 | 高 DPI 下红点发糊 |
| 零未读不复原 | 清零后角标残留 |
| 结算不标记 | 回传与超时重复决议 |
| 发送失败仍等待 | 弹窗目标缺失时挂起到超时 |
| 未知请求进入结算 | 过期决议改写当前弹窗 |

## 断点报告（续跑基线）

- 最后完成批次：**B93**（6 文件 / +318 行 / 全绿）；`added=318`、硬校验全 0。
- 累计（core+apps）：**830 文件 / 105,039 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,394 个 coreBelow30 / 36,551 行**，完成度 **74.2%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.28%~31.60%，`suspicious=0`。
