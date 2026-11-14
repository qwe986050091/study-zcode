# ZC-DEEP-b47

> 批次：B47（12 文件，缺口 1,051 行；按当前工作树复算，优先同类/同目录：`desktop/src/main` 4 个、`ui/src` 5 个、`ai-elements` 与 `marketing-touch` 各 1 个、`core/tool/handlers` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b47\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b47
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1102

node check-batch.mjs ZC-deep-b47 ZC-deep-b47-files.txt
TOTAL added=1102 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   419   304   95   90  packages/ui/src/CodingPlanBillingDiscount.tsx
31.29   432   326  102   92  packages/ui/src/prompt-editor/ChatPromptActionMenu.tsx
31.29   415   310   97   94  packages/desktop/src/main/fileApplications.ts
31.34   473   351  110   92  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-text.ts
31.35   435   319  100   91  packages/ui/src/settings/model-provider-section/CodingPlanStatusMeta.tsx
31.39   482   360  113   91  packages/desktop/src/main/desktopApplicationMenu.ts
31.39   428   309   97   93  packages/desktop/src/main/browserView/browserVirtualClipboard.ts
31.43   483   350  110   92  packages/ui/src/components/ai-elements/markdown-image.tsx
31.44   494   353  111   91  packages/desktop/src/main/windowsCuaOperationIndicator.ts
31.46   425   321  101   92  packages/ui/src/highspeed/HighspeedShareNoticeCard.tsx
31.48   413   305   96   92  packages/ui/src/previewPaneImageContent.tsx
31.52   437   330  104   92  packages/ui/src/components/marketing-touch/marketingTouchController.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.25 median=31.39 newComments=1102
PASS: all 12 file(s) >= 30%
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/src/main/fileApplications.ts` | 文件关联应用清单与路径探测 | INV-01~20；appPath 恒非空且为候选首项；Windows 根目录顺序与去重决定 x64/x86；WPS 版本目录按数值降序；reg.exe 查询带 2s 超时且仅 win32 兜底；命中需 stat 与 isFile 双确认 | 94 |
| `desktop/src/main/browserView/browserVirtualClipboard.ts` | 浏览器视图虚拟剪贴板 | INV-01~20；经 CDP Runtime.evaluate 写入焦点元素，不走系统剪贴板；递归 shadow DOM/同进程 iframe/OOPIF；attach 的 session 统一释放；1s 有界轮询；objectId 释放；失败即抛禁止回落顶层 | 93 |
| `desktop/src/main/desktopApplicationMenu.ts` | 主进程原生菜单装配 | INV-01~20；点击统一回流 executeDesktopCommand，菜单层零副作用；文案只走 locale 表；禁止聚合 role；accelerator 四态语义；条件展开仅 production/darwin/未打包/test；重建原子替换 | 91 |
| `desktop/src/main/windowsCuaOperationIndicator.ts` | Windows CUA 操作浮层 | INV-01~20；单例窗口；聚合键 workspace+session+turn；计数式显隐；隐藏动画可撤销；windowShown 与 windowReady 同步；hide 失败降级销毁；重试令牌一次性；dispose 幂等 | 91 |
| `ui/components/ai-elements/markdown-image.tsx` | Markdown 图片渲染适配 | INV-01~20；来源三分（artifact/本地/远程）与优先级；合并图片行与代码围栏状态机隔离；按 source 归属加载状态；disposed 卸载短路与 Blob URL 撤销；焦点恢复定时器清理 | 92 |
| `ui/components/marketing-touch/marketingTouchController.ts` | 营销投放控制器 | INV-01~20；disposed 与 generation 双版本号丢弃迟到快照；pending 期间写 deferredBanner；release 按引用相等判定资源归属；弹窗单飞出队；finally 必复位；dispose 释放五类持有 | 92 |
| `ui/highspeed/HighspeedShareNoticeCard.tsx` | 分享通知卡与详情弹窗 | INV-01~20；毫秒事实不得用秒级字段重建倍率；渲染复检与发布门禁同精度；复制图片与文本为独立失败路径；Radix 遮罩滞留；reduced-motion 与进度条同源表达式 | 92 |
| `ui/previewPaneImageContent.tsx` | 位图/SVG 预览面板 | INV-01~20；剪贴板能力三要素校验；必须已解码并按自然尺寸转 PNG；Safari 用户激活需在点击栈内同步写入；actionPendingRef 与 state 成对维护；尺寸缓存按 source 同源；Retina 倍率只从文件名解析 | 92 |
| `ui/prompt-editor/ChatPromptActionMenu.tsx` | 提示词编辑器动作菜单 | INV-01~20；可见性为 open 且未 disabled；下标以 attachmentCount 补偿；快捷命令仅限严格空草稿并受 catalog 与排除名单约束；打开瞬间快照选区并复位高亮；越界下标静默兜底 | 92 |
| `ui/CodingPlanBillingDiscount.tsx` | 套餐优惠展示 | INV-01~20；1 小时 TTL 缓存与单例在途去重；失败不写缓存并回落空态；文案缺失整块隐藏；首帧复用缓存；store 由调用方注入；活动变更最长 1 小时生效 | 90 |
| `ui/settings/model-provider-section/CodingPlanStatusMeta.tsx` | 套餐状态元信息 | INV-01~20；renew 优先 expire；订阅日期按 UTC、Start Plan 到期按本地时区并补时分；非法日期原样回显；状态机 pending 高于 refreshable 高于 settled；Epoch 哨兵排除；定时器截断并清理 | 91 |
| `core/tool/handlers/bash-readonly-policy-flags-text.ts` | 只读命令 flag 白名单 | INV-01~20；as const satisfies 类型守卫；none/number/char/花括号/EOF 取值形态与 argv 消费长度；短 flag 簇仅允许全 none；-- 与 --flag=value 处理；-o/--pre/-i/-f 四项核心排除 | 92 |

合计 **1,102**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 虚拟剪贴板失败必须抛错，不得回落顶层文档

`browserVirtualClipboard.ts` 只有在目标焦点元素所在 frame 写入成功才算成功；attach 失败或元素不可聚焦时直接抛错。
若静默回落到顶层 document，文本会被写到当前页面而非用户正在编辑的输入框，用户以为已复制但实际丢失。

### 2. 菜单只装配，不执行副作用

`desktopApplicationMenu.ts` 的每个点击项都回流 `executeDesktopCommand`，菜单层不直接改状态。
加速键四种状态（覆盖、空数组、录制态、未设置）语义不同，若把空数组当成「未设置」，
用户清空的快捷键会被恢复成默认值，表现为「怎么删都删不掉」。

### 3. 套餐优惠失败不写缓存

`CodingPlanBillingDiscount.tsx` 在请求失败时保持空态且不落缓存，避免把一次网络错误固化成一小时的「无优惠」。
若失败也写缓存，用户在网络恢复后仍看不到活动入口，且没有任何重试路径。

### 4. 状态元信息的时间口径分两套

`CodingPlanStatusMeta.tsx` 中订阅日期按 UTC 解释，Start Plan 到期按本地时区并补时分，非法日期原样回显。
混用口径会让到期时间整体偏移一个时区，用户看到的时间与实际扣费时间不一致。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 虚拟剪贴板失败回落顶层 | 文本写进当前页面，用户输入框没有内容 |
| OOPIF attach 不登记 session | CDP 连接泄漏，长时间使用后 attach 失败 |
| 菜单空加速键当成未设置 | 用户清空的快捷键被恢复默认 |
| 浮层 hide 失败不降级销毁 | 隐藏动画卡住，浮层永久留在屏幕上 |
| 营销控制器不校验 generation | 迟到快照覆盖新投放状态，弹窗重复出现 |
| 分享卡用秒级字段重建毫秒 | 倍率显示为 0 或无穷，指标失去意义 |
| 剪贴板写入不在用户激活栈内 | Safari 静默拒绝写入，没有任何报错 |
| 动作菜单下标不按附件数补偿 | 插入到错误位置，快捷命令改写用户正文 |
| 优惠请求失败写入缓存 | 网络恢复后一小时无活动入口 |
| 只读 flag 表把 -i 收进白名单 | 交互式命令被当成只读自动放行 |

## 顺延

B47 复算清单共 20 个候选，本批取 12 个，其余 8 个顺延到 B48，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.25%~31.52%。
