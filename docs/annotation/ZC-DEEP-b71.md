# ZC-DEEP-b71

> 批次：B71（12 文件，按 31.4% 口径计算目标 751 行，实际 +751，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b71\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=718）。

## 校验

```
node zc-verify.mjs ZC-deep-b71
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=751

node check-batch.mjs ZC-deep-b71 ZC-deep-b71-files.txt
TOTAL added=751 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.22   300   221    69   61  apps/zcode-cli/packages/core/src/browser-client/documentation.ts
31.23   353   253    79   62  packages/server/src/remote/zcodeAgentDeploy.ts
31.25   337   240    75   62  packages/desktop/src/main/browserView/browserTabResidencyCoordinator.ts
31.28   271   195    61   61  packages/ui/src/git-graph/GitGraphDialog.tsx
31.29   423   310    97   63  packages/ui/src/project-workflow/WorkflowRunSaveControls.tsx
31.31   275   198    62   61  packages/ui/src/presentation/pptxRendererPreviewEngine.ts
31.33   548   399   125   64  apps/zcode-cli/packages/core/src/runtime/methods/target.ts
31.37   371   271    85   63  packages/ui/src/v4/sessionQuotaBannerState.ts
31.40   496   363   114   65  packages/ui/src/v4/V4ConversationContext.tsx
31.43   290   210    66   62  packages/ui/src/presentation/presentationElementModel.ts
31.44   370   264    83   63  packages/ui/src/UpdateStatusDialogController.tsx
31.50   505   346   109   64  apps/zcode-cli/packages/adapters/src/exec/shell-init-snapshot.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.22 median=31.32 newComments=751
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/git-graph/GitGraphDialog.tsx` | 提交图对话框 | INV-01~18；分页游标只由返回的 next 推进；加载/错误/空/内容四态互斥；选中项按 sha 保存不按索引；关闭即取消在途请求 | 61 |
| `ui/presentation/pptxRendererPreviewEngine.ts` | PPTX 预览引擎适配 | INV-01~18；渲染句柄必须可释放；分页元素一次投影不改源文档；解析失败抛统一错误；释放后不得再取页 | 61 |
| `ui/presentation/presentationElementModel.ts` | 演示文稿元素投影 | INV-01~18；只投影不写回；表格补全单元格但保留原坐标；组内文本坐标累加父偏移；命中区域包含不可见元素 | 62 |
| `core/browser-client/documentation.ts` | 浏览器能力文档加载 | INV-01~18；backend 过滤先于拼装；条件文档按运行时开关取舍；缺文件降级为空串；输出即 Markdown 不含模板逻辑 | 61 |
| `desktop/browserView/browserTabResidencyCoordinator.ts` | 浏览器 tab 驻留协调 | INV-01~18；上限是窗口级而非 tab 级；victim 串行挑选不并行逐出；selected 与 preferred 不参与回收；回调失败不回滚已记账状态 | 62 |
| `server/remote/zcodeAgentDeploy.ts` | 远端 Agent 制品部署 | INV-01~18；SHA 与 live marker 双条件才跳过；写入先临时文件再改名；插件资源缺失不阻断主体；部署结果按制品分别记账 | 62 |
| `ui/UpdateStatusDialogController.tsx` | 更新弹窗控制器 | INV-01~18；模型只由广播状态投影；动作到平台调用一一对应；进度回退不覆盖更高阶段；错误态保留在弹窗内 | 63 |
| `ui/v4/sessionQuotaBannerState.ts` | 配额横幅状态归一 | INV-01~18；四类事实合成唯一横幅；优先级固定为不可用 > 限流 > 配额；同义横幅合并；状态为空即不展示 | 63 |
| `ui/v4/V4ConversationContext.tsx` | v4 会话上下文装配 | INV-01~18；连接租约按 pane 计数；卸载必须归还租约；transport 按 workspace 复用；services 注入只在装配点 | 65 |
| `adapters/exec/shell-init-snapshot.ts` | 登录 shell 环境快照 | INV-01~18；只采集 alias/function/option/PATH 四类；输出必须可被 sh source；非交互 shell 不触发采集；快照失败不阻断命令 | 64 |
| `core/runtime/methods/target.ts` | Goal 续跑与核算 | INV-01~18；入队与执行分离；后台任务活跃时让路；token 与时长按 run 记账；终态只写一次 | 64 |
| `ui/project-workflow/WorkflowRunSaveControls.tsx` | run 保存控件槽位 | INV-01~18；表头只暴露 leading/trailing 两槽；保存态由 run 投影；候选项目去重；弹层开关不写 run | 63 |

合计 **751**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 分页游标只由返回的 next 推进

`GitGraphDialog.tsx` 不在客户端自增页码。
自增会在服务端返回空页或重复页时跳过提交，图形断链。

### 2. 渲染句柄必须可释放

`pptxRendererPreviewEngine.ts` 每次渲染返回句柄并登记，切换页前释放。
不释放会累积 canvas 与图片解码内存，长时间预览后卡死。

### 3. 租约按 pane 计数

`V4ConversationContext.tsx` 用引用计数管理连接租约。
单例式归还会让另一个 pane 的连接被提前断开。

### 4. 引用计数为 0 才释放

租约归零才触发 transport 释放，非零时只减计数。

### 5. 终态只写一次

`target.ts` 在写入 run 终态前检查是否已终态。
重复写入会覆盖用量核算结果，统计翻倍。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 客户端自增页码 | 图形断链、跳提交 |
| 渲染句柄不释放 | 内存累积，预览卡死 |
| 单例式租约归还 | 其他 pane 连接被断开 |
| SHA 或 marker 单条件跳过 | 旧制品未更新却被判成功 |
| 先写正式文件再校验 | 半写文件被加载 |
| 状态优先级颠倒 | 限流横幅被配额横幅盖住 |
| 后台任务不让路 | 前台 Goal 与后台任务争抢额度 |
| 表头槽位外泄 | 保存控件出现第二份事实 |
| 环境快照阻塞命令 | shell 启动变慢甚至挂起 |
| 分页去重按索引 | 选中项指向错误提交 |

## 顺延

B71 复算清单共 20 个候选，本批取 12 个，其余顺延到 B72，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.22%~31.50%，`suspicious=0`；
> 本批三波均一次插入通过，无补插。
