# ZC-DEEP-b92

> 批次：B92（6 文件，按 31.4% 口径计算目标 314 行，实际 +314）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b92\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b92
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=314

node check-batch.mjs ZC-deep-b92 ZC-deep-b92-files.txt
TOTAL added=314 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.18  227  170   53  52  packages/ui/src/components/marketing-touch/marketingResources.ts
31.33  222  166   52  52  packages/ui/src/DeleteAllArchivedTasksButton.tsx
31.40  228  172   54  52  packages/ui/src/resource-manager/NetworkSection.tsx
31.58  232  171   54  52  packages/ui/src/hooks/useSubagents.ts
31.61  250  174   55  52  packages/ui/src/mentions/nodes/PromptMentionNode.ts
32.11  267  190   61  54  packages/ui/src/previewPaneOfficeLegacyDocContent.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.18 median=31.49 newComments=314
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `components/marketing-touch/marketingResources.ts` | 营销触达资源目录 | INV-01~18；静态清单；类别归一；路径拼接；只读导出 | 52 |
| `DeleteAllArchivedTasksButton.tsx` | 归档任务批量删除入口 | INV-01~18；双保险防重；必先清结果；取消无副作用；必定收尾 | 52 |
| `hooks/useSubagents.ts` | 子智能体上下文解析 hook | INV-01~18；显式身份优先；RPC 门控；键含服务；旧店兼容 | 52 |
| `mentions/nodes/PromptMentionNode.ts` | 提示词提及行内节点 | INV-01~18；展示与规范分离；文本链不断；克隆保键；序列化闭环 | 52 |
| `previewPaneOfficeLegacyDocContent.tsx` | 只读 DOCX 预览 | INV-01~18；WASM 先行；渲染键稳定；虚拟列表同步；三态渲染 | 54 |
| `resource-manager/NetworkSection.tsx` | 网络采集快照页 | INV-01~18；有界投影；代际防旧；失败可恢复；页号收敛 | 52 |

合计 **314**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 渲染键必须与模型绑定

`previewPaneOfficeLegacyDocContent.tsx` 用弱映射把模型映射到递增整数。
每次渲染新键会让编辑器实例被重建，滚动位置与选区全部丢失。

### 2. 虚拟列表要跟随外层缩放

`previewPaneOfficeLegacyDocContent.tsx` 把适配比例同步传给 `pageVirtualization`。
只做变换而不传比例时，滚动坐标按未缩放页高计算，出现闪白与末页不挂载。

### 3. 清空必须先递增代际

`NetworkSection.tsx` 在清空前自增代际计数。
顺序反了会让清空前的在途快照返回后把旧列表写回来。

### 4. 文本链不能被图标截断

`PromptMentionNode.ts` 保留父类创建的文本节点，图标只作外层装饰。
截断首子节点会破坏选区与输入，编辑器行为整体失效。

### 5. 显式身份优先于标签推断

`useSubagents.ts` 先取显式身份，未指定时才回落到匹配标签。
反序会让调用方锁定的身份被同路径的其它窗口覆盖。

### 6. 删除按钮必须双保险防重

`DeleteAllArchivedTasksButton.tsx` 同时使用引用与忙碌态。
只有其一，界面更新前的连点会触发两轮批量删除。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 渲染键每次重算 | 同一模型反复重建编辑器 |
| 适配比例不同步 | 滚动到底部闪白 |
| 清空后不递增代际 | 旧快照覆盖已清空的列表 |
| 失败不复位 | 一次失败后永久显示不可用 |
| 筛选后不回首页 | 过滤结果页号越界显示空表 |
| 清空不解除忙碌 | 按钮永久禁用 |
| 图标替换首子节点 | 提及无法选中与输入 |
| 克隆不传原键 | 行内移动后选中态丢失 |
| 序列化漏字段 | 复制粘贴后提及信息丢失 |
| 显式身份被覆盖 | 多开同路径工作区读错会话 |
| 上下文键不含服务 | 替换服务后仍读旧上下文 |
| 空工作区仍建键 | 新窗口命中上一条上下文 |
| 删除无防重 | 连点触发两轮批量删除 |
| 取消后仍执行 | 确认框点取消也会删除任务 |
| 异常不 finally | 删除失败后按钮再也点不动 |

## 断点报告（续跑基线）

- 最后完成批次：**B92**（6 文件 / +314 行 / 全绿）；`added=314`、硬校验全 0。
- 累计（core+apps）：**824 文件 / 104,721 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,400 个 coreBelow30 / 36,869 行**，完成度 **74.0%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.18%~32.11%，`suspicious=0`。
