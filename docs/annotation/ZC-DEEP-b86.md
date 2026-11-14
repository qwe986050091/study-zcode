# ZC-DEEP-b86

> 批次：B86（6 文件，按 31.4% 口径计算目标 337 行，实际 +337，无补插）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b86\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b86
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=337

node check-batch.mjs ZC-deep-b86 ZC-deep-b86-files.txt
TOTAL added=337 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   281   202   63   56  packages/ui/src/components/ui/floating-particles.tsx
31.33   335   249   78   56  apps/zcode-cli/packages/office-runtime/ui/i18n.ts
31.40   442   328  103   57  packages/ui/src/settings/saved-workflows/SavedWorkflowLaunchDialog.tsx
31.48   291   216   68   57  packages/ui/src/plugin-ui/adapters/usePluginUiSidePaneModel.tsx
31.52   260   184   58   56  packages/ui/src/chat-input-toolbar/contextQuotaResetOpportunityReminder.tsx
31.52   248   184   58   55  packages/ui/src/components/cloud-content-dialog/CloudDialogDescription.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.19 median=31.44 newComments=337
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/chat-input-toolbar/contextQuotaResetOpportunityReminder.tsx` | 上下文配额重置机会提醒 | INV-01~18；已读快照按窗口隔离；机会键稳定性；阶段合并；外部点击判定 | 56 |
| `ui/src/components/ui/floating-particles.tsx` | 高速粒子背景（单 Canvas） | INV-01~18；静态种子参数；相位错开；精灵缓存；30fps 跳帧；减动效 | 56 |
| `ui/src/plugin-ui/adapters/usePluginUiSidePaneModel.tsx` | 插件面板侧栏模型 | INV-01~18；自申请会话租约；读键与占用键分离；启动屏障；回内联前提 | 57 |
| `office-runtime/ui/i18n.ts` | office 面板双语文案与定位符描述 | INV-01~18；双表同构；格式派生；语言前缀回落；定位解析顺序 | 56 |
| `ui/src/components/cloud-content-dialog/CloudDialogDescription.tsx` | 云端描述受控渲染 | INV-01~18；标签白名单；命名空间与深度上限；链接净化；行内降级 | 55 |
| `ui/src/settings/saved-workflows/SavedWorkflowLaunchDialog.tsx` | 工作流启动窗 | INV-01~18；限高三段式；聚焦首个错误；候选校正；防重复提交 | 57 |

合计 **337**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 已读状态必须按 renderer 窗口隔离且不落盘

`contextQuotaResetOpportunityReminder.tsx` 把已读快照放在模块级 store，键由来源与过期时间拼成。
写进持久化存储会让同一重置机会在重启后仍被当作已读；键随渲染变化则每次挂载都重新弹窗。

### 2. 粒子参数在模块加载时一次性固定

`floating-particles.tsx` 用正弦散列生成 96 组参数，运行期只做插值与绘制。
在 effect 里重新随机会导致每次挂载布局跳变，并且每帧多一次随机分布计算。

### 3. 侧栏的会话租约由适配器自己申请

`usePluginUiSidePaneModel.tsx` 不在会话面板树内，拿不到外层租约，必须自行申请并在清理时释放。
漏释放会让会话引用计数只增不减；提前释放会让投影在面板仍可见时变空。

### 4. 文案表必须由类型系统强制同构

`office-runtime/ui/i18n.ts` 用英文表的类型标注中文表，缺键或多键都编译失败。
只靠人工对齐会让新键在一种语言里出现原始键名。

### 5. 云端 HTML 只在惰性模板里解析后转 React 元素

`CloudDialogDescription.tsx` 不把云端字符串注入宿主 DOM：先入 template，再按白名单递归构造元素。
直接设置内部 HTML 会让脚本与事件属性随描述一起进入渲染进程。

### 6. 启动窗的滚动只发生在中段

`SavedWorkflowLaunchDialog.tsx` 把窗口限高、中段可滚、头尾钉住，并让中段成为隐藏控件的包含块。
不设包含块时 Radix 的隐藏原生控件会把窗口撑出第二条滚动条。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 已读状态落盘 | 重启后不再提醒 |
| 机会键含渲染期变量 | 每次挂载重复弹窗 |
| 秒与毫秒混用 | 紧急态永不触发 |
| 粒子参数每次挂载重算 | 底纹跳变、掉帧 |
| 每帧生成辉光精灵 | 渲染进程长期满载 |
| 侧栏不释放租约 | 会话引用计数泄漏 |
| 读键当占用键 | 主区域与侧栏互相顶掉 |
| 侧栏不等投影就启用宿主 | 首帧空渲染后不再重启 |
| 中文表不标英文表类型 | 缺键只显示原始键名 |
| 选中项失效不校正 | 启动到不存在的项目 |
| 深嵌套不设上限 | 渲染栈溢出 |
| 链接不校验协议 | 脚本协议被点击执行 |
| 窗口不限高 | 实参多时按钮出视口 |
| 错误文案渲染前滚动 | 滚动定位偏移 |
| 启动中不判 pending | 连点发起多次运行 |

## 断点报告（续跑基线）

- 最后完成批次：**B86**（6 文件 / +337 行 / 全绿）；`added=337`、硬校验全 0。
- 累计（core+apps）：**788 文件 / 102,802 行**。
- 半插入残留：无（6 份 spec 的插入行数与文件实际增量逐一对齐）。
- 剩余缺口：按基线推导 **2,436 个 coreBelow30 / 38,788 行**，完成度 **72.6%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.52%，`suspicious=0`。
