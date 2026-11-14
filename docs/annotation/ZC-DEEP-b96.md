# ZC-DEEP-b96

> 批次：B96（6 文件，按 31.4% 口径计算目标 302 行，实际 +302）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b96\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b96
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=302

node check-batch.mjs ZC-deep-b96 ZC-deep-b96-files.txt
TOTAL added=302 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.14  223  167   52  49  packages/ui/src/settings/PluginStoreSourcesDialog.tsx
31.23  367  253   79  51  packages/ui/src/store/zcodeSessionStoreSelectors.ts
31.32  242  182   57  50  packages/ui/src/project-sidebar/useProjectSidebarPreferences.ts
31.34  284  201   63  51  packages/ui/src/remote/remoteWorkspaceProjection.ts
31.48  223  162   51  51  packages/ui/src/lib/userActionTraceCatalog.ts
31.58  247  171   54  50  packages/ui/src/terminal/terminalPanelState.ts
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.14 median=31.33 newComments=302
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `store/zcodeSessionStoreSelectors.ts` | 会话状态选择器 | INV-01~18；身份优先；桶不混写；未变即回 | 51 |
| `terminal/terminalPanelState.ts` | 终端面板状态 | INV-01~18；两表分离；最小空位；退出删记录 | 50 |
| `lib/userActionTraceCatalog.ts` | 用户动作目录 | INV-01~18；单一来源；类别判定；键含两段 | 51 |
| `remote/remoteWorkspaceProjection.ts` | 远端工作区投影 | INV-01~18；服务器排除；精确别名；在线非就绪 | 51 |
| `project-sidebar/useProjectSidebarPreferences.ts` | 侧栏偏好 hook | INV-01~18；单键持久化；跨窗只收不写；未变不写 | 50 |
| `settings/PluginStoreSourcesDialog.tsx` | 插件市场源弹窗 | INV-01~18；官方不可删；标识回传；进行中禁用 | 49 |

合计 **302**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 身份桶存在后不再合并路径桶

`zcodeSessionStoreSelectors.ts` 的读取在身份键命中时直接返回该桶。
再动态合并路径任务，会让同路径的 SSH、WSL 与 Docker 窗口互相读到配置。

### 2. 终端编号从现存会话推导

`terminalPanelState.ts` 不保存只增不减的计数。
保存派生计数会让关闭编号二后再新建得到三。

### 3. 最后一个终端退出要删记录

退出路径同时删除会话与工作区记录，重新打开时由确保函数懒创建。
只收起面板会留下空工作区，后续挂载拿到空会话列表。

### 4. 投影不按主机猜测设备

`remoteWorkspaceProjection.ts` 只在历史里恰有一个精确别名时归属设备。
多义时保持待识别，避免把工作区挂到错误设备。

### 5. 跨窗同步只收不写

`useProjectSidebarPreferences.ts` 收到存储事件只更新本地状态。
收到即回写会与另一窗口互相覆盖新顺序。

### 6. 官方市场失败不提示

`PluginStoreSourcesDialog.tsx` 对官方市场的刷新失败保持静默。
与插件管理 store 的处理口径一致，避免每次刷新都弹红字。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 身份桶与路径桶合并 | 同路径多个远程窗口状态串台 |
| 迁移未命中仍复制 | 任务配置泄漏到新身份 |
| 活动任务不回退 | 指向已删除任务 |
| 终端编号另存计数 | 关闭后新建跳号 |
| 最后会话只收起面板 | 空工作区残留，重开无会话 |
| 投影按主机猜设备 | 工作区归到错误设备 |
| 附件缺事实即就绪 | 实际仍在挂接却显示可用 |
| 本地标签进远端集合 | 本地工作区显示为断连设备 |
| 改序不持久化 | 拖拽仅当前窗口可见 |
| 跨窗回写 | 两窗口顺序互相覆盖 |
| 排序依赖用数组引用 | 每次渲染都写盘 |
| 官方市场失败也提示 | 每次刷新都出现红字 |
| 更新与移除前缀相同 | 一个操作误禁用另一个按钮 |
| 时间解析失败原样返回 | 列表出现无效日期文本 |

## 断点报告（续跑基线）

- 最后完成批次：**B96**（6 文件 / +302 行 / 全绿）；`added=302`、硬校验全 0。
- 累计（core+apps）：**848 文件 / 105,972 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,376 个 coreBelow30 / 35,618 行**，完成度 **74.8%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.14%~31.58%，`suspicious=0`。
