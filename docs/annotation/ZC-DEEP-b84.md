# ZC-DEEP-b84

> 批次：B84（6 文件，按 31.4% 口径计算目标 331 行，实际 +331，无补插）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b84\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b84
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=331

node check-batch.mjs ZC-deep-b84 ZC-deep-b84-files.txt
TOTAL added=331 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.37   277   204   64   55  packages/ui/src/lib/codingPlanUsageSources.ts
31.25   251   176   55   54  packages/ui/src/lib/assistantCodeComment.ts
31.43   439   315   99   56  packages/ui/src/lib/taskListMembershipSets.ts
31.25   344   256   80   55  packages/ui/src/components/workflow-timeline/WorkflowAskSettingsLines.tsx
31.51   323   238   75   55  packages/ui/src/components/workflow-timeline/WorkflowRunSettingsPopover.tsx
31.53   285   203   64   56  packages/ui/src/settings/model-provider-section/constants.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.25 median=31.40 newComments=331
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/lib/codingPlanUsageSources.ts` | 侧栏用量来源归一与解析 | INV-01~18；个人来源 id 复用 providerId；团队来源五段编码键去重；家族推导出 providerId；团队匹配不回退个人；品牌前缀按家族 | 55 |
| `ui/src/lib/assistantCodeComment.ts` | 助手 code-comment 指令提取与卡片 | INV-01~18；代码块内不算指令；三项字段去空白非空；整行删除与单空格替换；流式尾部未闭合裁剪；工作区相对路径与稳定 id | 54 |
| `ui/src/lib/taskListMembershipSets.ts` | tasks-index 归属集合读取与合并 | INV-01~18；三分区行并集；辅助集合失败降级；行分区失败即抛错；E2E 快照暂停；按版本与实例身份缓存、失败不缓存、有界淘汰 | 56 |
| `ui/src/components/workflow-timeline/WorkflowAskSettingsLines.tsx` | 确认窗可调运行设置两行 | INV-01~18；初始草稿只取一次；不可选时不给控件但照实说模型；memo 入参与回调必须稳定；唯一效果回报不可用；重置尾巴 | 55 |
| `ui/src/components/workflow-timeline/WorkflowRunSettingsPopover.tsx` | 运行设置弹层与 Apply | INV-01~18；开关与锚点成对；内部点击与按键不冒泡；点触发点不算外部；打开时定初始草稿；拒绝停在弹层；成功后回调并关闭 | 55 |
| `ui/src/settings/model-provider-section/constants.ts` | 厂商设置常量与展示名 | INV-01~18；预置厂商两家与索引；六个编码套餐标识；规格表按 id 唯一；购买链接缺失即不支持；展示名回落与导航项五形态 | 56 |

合计 **331**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 团队来源的 id 是编码后的复合键

`codingPlanUsageSources.ts` 的 sourceId 由团队标记、家族、产品、组织、项目五段各自 URI 编码后以冒号连接。
直接拼接会让含冒号的字段产生键碰撞，去重与偏好持久化都会认错来源。

### 2. 行分区失败不发布权威空集

`taskListMembershipSets.ts` 只让辅助集合按空集降级，三类任务行任一分区不可用就抛错。
把降级空集当权威发布，会把旧缓存整组清空，侧栏任务瞬间消失。

### 3. 流式尾部必须裁掉未闭合指令

`assistantCodeComment.ts` 在流式投影时把未闭合指令裁到文本末尾，非流式则原样保留。
不裁会让内部协议原文在闭合前闪给用户，裁剪又会让已完成的文本凭空少一截。

### 4. 不可选也要说真话

`WorkflowAskSettingsLines.tsx` 在宿主没有模型目录时不渲染下拉，但入参里有模型就照实说它。
一律说「沿用会话模型」会让确认窗说一句与将要发生的事相反的话。

### 5. 弹层内部交互不向 run 卡冒泡

`WorkflowRunSettingsPopover.tsx` 阻止内部点击、回车与空格的冒泡，并判定触发点本身不算外部点击。
不拦会让卡身折叠、弹层消失；不排除锚点会在一次点击里关了又开。

### 6. 缓存键必须带服务实例身份

`taskListMembershipSets.ts` 的缓存键在版本签名之后再拼各服务实例 id，失败不入缓存，超过八个键淘汰最旧。
不同服务共享缓存会让测试 mock 与真实代理串数据，缓存失败会让一次短暂异常粘住整个版本。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 团队 sourceId 直接拼接 | 键碰撞、去重丢错来源 |
| 团队匹配不到回退个人 | 团队额度显示成个人额度 |
| 代码块内文本当指令 | 展示文本被误删 |
| 只删指令不删行 | 留下只含空白的空行 |
| 流式不裁未闭合指令 | 协议原文闪给用户 |
| 行分区降级当权威 | 旧缓存被整组清空 |
| 缓存失败也写入 | 一次异常粘住整个版本 |
| 不可用时隐藏控件 | 用户无法纠正模型 |
| 内联数组/函数传给 memo 下拉 | 每帧重渲染 |
| 弹层内部点击冒泡 | 卡身折叠、弹层消失 |
| 触发点算外部点击 | 关了又开 |
| 展示名不回落 | 侧栏出现无名项 |

## 断点报告（续跑基线）

- 最后完成批次：**B84**（6 文件 / +331 行 / 全绿）；`added=331`、硬校验全 0。
- 累计（core+apps）：**776 文件 / 102,138 行**。
- 半插入残留：无（6 份 spec 的插入行数与文件实际增量逐一对齐）。
- 剩余缺口：按基线推导 **2,448 个 coreBelow30 / 39,452 行**，完成度 **72.1%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.25%~31.53%，`suspicious=0`。
