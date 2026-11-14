# ZC-DEEP-b91

> 批次：B91（6 文件，按 31.4% 口径计算目标 322 行，实际 +322）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b91\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b91
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=322

node check-batch.mjs ZC-deep-b91 ZC-deep-b91-files.txt
TOTAL added=322 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.18  225  170   53  52  packages/desktop/scripts/mcp-apps-host-fixture/rows-renderer.tsx
31.36  222  169   53  52  packages/desktop/scripts/mcp-apps-host-fixture/model.ts
31.38  583  427  134  56  apps/zcode-cli/packages/office-runtime/ui/viewers/XlsxView.tsx
31.40  325  242   76  54  apps/zcode-cli/packages/tui/src/app-transcript-components.tsx
31.45  336  248   78  54  apps/zcode-cli/packages/tui/src/app-components.tsx
31.48  440  324  102  54  apps/zcode-cli/packages/office-runtime/ui/shell/panes.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.18 median=31.39 newComments=322
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `tui/src/app-components.tsx` | TUI 主布局与命令面板 | INV-01~18；停靠覆盖互斥；可见窗口收敛；宽度反推与归一 | 54 |
| `tui/src/app-transcript-components.tsx` | 会话内容渲染 | INV-01~18；parts 优先；镜像卡优先；timeline 早退；状态六分支 | 54 |
| `office-runtime/ui/viewers/XlsxView.tsx` | 只读 Excel 查看器 | INV-01~18；共享 WASM；1-based 边界；取数上限；高亮优先级 | 56 |
| `office-runtime/ui/shell/panes.tsx` | 面板抽屉与状态界面 | INV-01~18；意图回传；单次取图；标签回退；骨架不虚构页数 | 54 |
| `desktop/scripts/.../model.ts` | 本地模型夹具 | INV-01~18；计划消费；延迟应答；中止事件；配置同源 | 52 |
| `desktop/scripts/.../rows-renderer.tsx` | 行渲染夹具 | INV-01~18；复用真实路径；稳定行键；终态取消；强制同帧 | 52 |

合计 **322**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 停靠与覆盖必须互斥

`app-components.tsx` 用两个互斥分支产出同一侧边栏。
同时渲染会让侧边栏出现两份，宽度计算与实际显示不一致。

### 2. 空命令面板不能占位

`app-components.tsx` 在命令为空时直接返回空值。
返回空盒子会留下六行空白，挤压会话区。

### 3. 片段优先于整段正文

`app-transcript-components.tsx` 有 parts 时不再渲染 content。
两者同渲会让同一条回复出现两份文本。

### 4. 缩略图只取一次

`panes.tsx` 首次可见后立即断开观察器。
不断开会随滚动反复请求同一页，长文档下请求量线性增长。

### 5. WASM 加载必须共享

`XlsxView.tsx` 用模块级 Promise 复用加载结果。
每个查看器各建 worker 会成倍占用内存，并让首屏明显变慢。

### 6. 1-based 转换只有一处边界

`XlsxView.tsx` 在生成对外定位器时统一加一。
在多个位置各自加减，会让 shell 与查看器出现行列差一。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 停靠与覆盖同时渲染 | 侧边栏出现两份 |
| 空命令返回空盒子 | 面板留下六行空白 |
| 可见窗口不收敛 | 选中项越界后窗口为空 |
| 命令名允许换行 | 长命令名挤掉摘要行 |
| 宽度不做归一 | NaN 或负宽度传入布局层 |
| 有 parts 仍渲染 content | 同一条回复出现两份文本 |
| timeline 不早退 | 分隔行位置出现空行 |
| 未知片段不回落 | 新片段类型直接消失 |
| 缩略图不清理观察器 | 同一页被反复取图 |
| 标签不回退 | 切到无内容标签后抽屉全空 |
| 骨架按真实页数生成 | 加载期间布局卡顿 |
| 文件输入不清空 | 第二次选择同一文件无反应 |
| WASM 不共享 | 多实例重复建 worker |
| 反向选区不归一 | 生成非法锚点 |
| 大区域不夹紧 | 复制操作卡死主线程 |
| 高亮不校验表名 | 同名区域在另一张表也染色 |
| 选区条不补偿滚动 | 滚动后条与手指分离 |
| 夹具固定端口 | 并行用例互相抢占 |
| 关闭不彻底 | 用例结束后进程不退出 |
| 夹具不初始化就绪 | 测试在命令挂载前开始驱动 |

## 断点报告（续跑基线）

- 最后完成批次：**B91**（6 文件 / +322 行 / 全绿）；`added=322`、硬校验全 0。
- 累计（core+apps）：**818 文件 / 104,407 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,406 个 coreBelow30 / 37,183 行**，完成度 **73.7%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.18%~31.48%，`suspicious=0`。
