# ZC-DEEP-b16

> 批次：B16（计划 7 文件 / 缺口 1,951 行）。
> 覆盖三条链路：桌面主进程实时总线、UI 设置页编排层、开发者文档站单入口。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b16\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b16
SUMMARY files=7 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=2194

deep-density --baseline ZC-deep-b16/orig --ext .ts,.tsx --threshold 30 --mode code
30.00  1176   920  276  276  packages/desktop/src/main/taskRealtimeBus.ts
30.16  1318   928  280  280  packages/ui/src/ElicitationDialog.tsx
35.34  1472  1030  364  334  packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx
33.13  1508   926  307  307  packages/ui/src/settings/SkillsSection.tsx
34.74  1472   965  335  335  packages/ui/src/LexicalChatInput.tsx
36.81  1561  1103  406  348  packages/ui/src/settings/ModelProviderSection.tsx
31.53  2075  1497  472  314  apps/dev-docs/src/App.tsx
SUMMARY files=7 coreBelow30=0 needLines=0 min=30.00 median=33.13 newComments=2194
PASS: all 7 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/main/taskRealtimeBus.ts` | 主进程任务实时事件总线：按窗口/订阅者分发、缓冲与背压 | INV-01~16；订阅者集合只在主线程增删；窗口销毁必须解绑；事件缓冲有上限且按到达序；重放不重排；无订阅者时不丢弃终态；序列化失败降级为最小载荷 | 276 |
| `packages/ui/src/ElicitationDialog.tsx` | 交互式追问弹窗：表单状态、提交幂等、关闭路径 | INV-01~16；提交中禁止重复提交；关闭只走一条路径；草稿在提交成功后才清；受控字段与外部更新不同步回写；Esc 与按钮同源；失败保留输入 | 280 |
| `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx` | 套餐用量面板：额度卡、趋势图、健康度 | INV-01~18；权益来源三分支；resetUi 与权益刷新绑定；卡片过滤只影响展示；趋势系列 1~3 条；懒加载图表不阻塞首屏；空态与错误态互斥 | 334 |
| `packages/ui/src/settings/SkillsSection.tsx` | Skills 设置区：列表投影、删除、插件商店同步 | INV-01~16；请求代次 latestRequestIdRef 防串；投影与目标匹配后才收敛；删除四步顺序；插件商店匹配不看瞬时 loading；失败回滚到上一份投影 | 307 |
| `packages/ui/src/LexicalChatInput.tsx` | 基于 Lexical 的聊天输入框：键位、IME、mention、历史 | INV-01~22；IME 组合态 Enter 不拦截；disabled 吞掉 Enter；submitDisabled 放行换行；清空只由 onSubmit 返回值决定；mention 原子节点；历史回填专用 tag；粘贴被接管后阻断传播 | 335 |
| `packages/ui/src/settings/ModelProviderSection.tsx` | 模型供应商设置页编排层：导航、连接、权益、OAuth | INV-01~22；同步身份 key 只含稳定事实；失败态不删除 map 条目；pending 只消费一次；连接方式切换三段顺序；解绑清 webview 存储；营销导航不触发模式写入 | 348 |
| `apps/dev-docs/src/App.tsx` | 开发者文档站单入口：四视图、静态协议、stdio 抓包 | INV-01~23；view 白名单与 replaceState；real/mock 双源互斥；轮询清理；帧 id 稳定；配对只按 messageId；选中帧四级回退；配对帧取全量；mock 48 条截断；格式化函数不抛错 | 314 |

合计 **2,194**，与 `zc-verify` 的 `added` 一致。

> 后续补厚（B17 开工前）：`packages/desktop/src/main/taskRealtimeBus.ts` 由 30.00% 补到 31.03%（+10 行），
> 快照 `ZC-deep-b16` 重跑 `zc-verify` 得 `added=2204`。为避免贴线抖动，本批累计按 **2,204** 计入总表。

## 关键不变量（抽取）

### 1. 双数据源必须单点互斥

`App.tsx` 的 stdio 视图同时存在 real 轮询与 mock 合成两套写入路径，唯一的分流开关是
`trafficSourceMode`。两个 real effect 顶部都以 `trafficSourceMode !== "real"` 早退，
mock 定时器则以 `isMockReplayEnabled` 早退。把早退改成「先拉一次再返回」或省略清理函数，
会让两套数据源交替覆盖同一份 `trafficFrames`，表现为列表每秒闪一次、选中帧反复跳。

帧 id 的稳定性同样是硬约束：`real-${workspaceHash}-${index}-${ts}` 让同一文件重复轮询时
id 不变，选中态才能跨刷新保留；换成数组下标或随机数，每秒都会重置详情面板。

### 2. 设置页的「身份 key」只放稳定事实

`ModelProviderSection.tsx` 的同步尝试 key 只由 `providerId + activeOAuthProvider` 组成。
把 `checking` 之类的展示状态放进 key，状态抖动就会产生新 key，自动水合反复触发同步，
形成请求风暴；而失败时删除 map 条目等价于「从未尝试」，会让自动水合进入失败循环。
这两条是本批最容易「看起来可以简化」、实际一改就出故障的位置。

### 3. 输入框的清空权只属于业务层

`LexicalChatInput.tsx` 里是否清空编辑器只由 `onSubmit` 的返回值决定：
`result === false` 表示业务层拒收（附件未就绪、会话忙碌），草稿必须原样保留。
同时 IME 组合态的 Enter 一律不拦截，`disabled` 时吞掉 Enter 而不是放行换行。
三者任意一条写反，用户都会丢输入或发出半截句子。

### 4. 文档站的「详情区永不消失」

`App.tsx` 的选中帧走四级回退链：过滤结果内 → 未过滤列表内 → 过滤结果第一帧 → 全部第一帧。
配对帧则必须从完整 `trafficFrames` 里取，不能从 `filteredFrames` 取。
只保留前两环或改用过滤列表，会出现「列表有帧但右侧空白」以及「按上行筛选后配对区永远空」。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| stdio 轮询 effect 漏 `clearInterval` | 切到 mock 后真实计时器仍在跑，帧列表每秒闪烁 |
| real effect 不早退 | mock 列表被真实数据整体替换 |
| 帧 id 用下标/随机数 | 每秒轮询重置选中帧，详情面板反复跳动 |
| 配对帧从 filteredFrames 取 | 方向筛选后配对区永远不显示 |
| 同步身份 key 混入 checking | 自动水合请求风暴 |
| 同步失败时删除 map 条目 | 失败自动重试循环，provider 列表被反复刷新 |
| 连接方式先落盘后写 pending | 选中项来回闪，套餐连接方式错配 |
| `onSubmit` 返回 false 仍清空编辑器 | 附件未就绪时用户输入被吃掉 |
| disabled 时 Enter 放行换行 | 恢复后可提交草稿里堆满空行 |
| Skills 请求不做代次校验 | 旧响应覆盖新列表，删除后又「复活」 |
| 任务总线窗口销毁不解绑 | 主进程向已销毁窗口 send，抛异常并中断分发 |

## 顺延

无。B16 计划内 7 个文件全部达标；下一批按 `ZC-DEEP-CORE-PLAN.md` 复算清单推进。
