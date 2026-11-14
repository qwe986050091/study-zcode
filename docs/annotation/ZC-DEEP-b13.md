# ZC-DEEP-b13

> 批次：B13。基线快照：`d:\code\_annot_baseline\ZC-deep-b13a\orig`、`ZC-deep-b13b\orig`（两个子批并行，合并校验见下）。

## 校验

```
node zc-verify.mjs ZC-deep-b13a
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=735

node zc-verify.mjs ZC-deep-b13b
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1063

deep-density --only b13a
30.60  1899  1405  430  352  packages/ui/src/app-shell/AnimatedSidePanePanel.tsx
33.02  1700  1266  418  383  apps/dev-docs/src/data/protocolDocs.ts
SUMMARY files=2 coreBelow30=0 needLines=0 min=30.60 median=31.81 newComments=735
PASS: all 2 file(s) >= 30% (mode=code)

deep-density --only b13b
30.45  2012  1501  457  349  packages/ui/src/v4/ConversationTurnGroup.tsx
30.58  2555  1877  574  348  packages/ui/src/v4/ConversationTimeline.tsx
31.65  2036  1422  450  366  packages/ui/src/components/ai-elements/message.tsx
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.45 median=30.58 newComments=1063
PASS: all 3 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/dev-docs/src/data/protocolDocs.ts` | 协议文档数据表：概念、结构、字段与时序示例 | INV-1~12；concept.id 全文件唯一且为唯一解引用目标；结构/流程 id 发布后不得改名；协议 schema 变更必须同步本文件；FieldDoc.required 只三态；legacy 表示可读不可写；source 只是核对线索不是 import 路径；示例帧 raw 不参与解析；linkedId 指向已存在帧且不成环；timestamp 不参与排序；数组顺序即阅读顺序；kind 只影响分组配色；fields 必须覆盖 title 声称的结构 | 383 |
| `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` | 侧栏面板：展开/收起动画、宽度锁定与 tab 拖拽重排 | INV-1~12；hasRenderedSidePane 单向不回退；锁宽只活在 200ms 过渡窗口；锁宽只在首次展开与开始收起两个时刻写入；收起记录 panel 实际宽度而非内容宽；拖拽中不提交重排与切换；重排需 over 且 id 不同；快速开关必须清上一轮解锁定时器；收起态同时 collapsible=false、disabled=true；隐藏用 opacity + pointer-events 不用 display:none；截图期强制 opacity-100；aria-hidden 跟随可见性但 DOM 保留；tab 激活统一走 activateSidePaneTab | 352 |
| `packages/ui/src/components/ai-elements/message.tsx` | 消息渲染：markdown 管线、公式/引用归一与文件链接改写 | INV-1~12；role 只决定视觉不参与内容分支；正文只有 children 拍平一条来源；管线顺序 citation → 图片归一 → 单美元公式 → artifact 重写不可交换；公式归一跳过 fenced/inline code；归一化只转义不删字符；紧凑价格区间的第二个 $ 不作闭合；singleTilde 两处同时关闭；显式 remarkPlugins 需带默认插件；Windows 文件链接插件无条件启用；链接改写必须在 harden 之前；越界路径在改写前词法拦截；盘符补前缀只为过安全层且打开前还原 | 366 |
| `packages/ui/src/v4/ConversationTurnGroup.tsx` | 一轮对话容器：flow items 分组、work 段折叠与后台结果分支 | INV-1~12；分组边界只由 conversationTurnRenderUnits 决定；flowItems 顺序即屏幕顺序禁止再排序；多段 work 各自持有折叠态、单段才沿用默认；segment.key 稳定且唯一；首块 chunk key 固定后续带 :chunk-N；默认展开段受控且不可折叠；historyOpen 随默认值与 segment.key 重置；stageTailIsRunning 只对最后一项生效；空段整轮返回 null；timelineOnly 不渲染气泡与操作栏；backgroundResult 走独立分支；后台标题只认白名单 | 349 |
| `packages/ui/src/v4/ConversationTimeline.tsx` | 会话时间线：虚拟列表、贴底跟随与历史补拉锚定 | INV-1~12；分区顺序固定且 live tail 在最后；liveUnit 只能排在虚拟列表末尾；虚拟项 key 必须来自 unit.key；estimateSize 先查高度缓存；measureElement 依赖 data-index 反查最新列表；scrollMargin 必须等于 headerSlotHeight；following 存 ref、仅 backToBottomVisible 走 state；程序化贴底必须 instant；贴底判定与 lastObservedScrollTop 对账；滚动意图 TTL 1200ms 但拖拽期间不过期；awayFromBottom 必须先 commitFollowing(false)；prepend 锚定基线由首行 rowId + 上次 totalSize 组成 | 348 |

合计 **1798**（735 + 1063），与两次 `added` 之和一致。

## 关键不变量（抽取）

- 侧栏：`hasRenderedSidePane` 单向不回退，否则收起瞬间卸载 browser guest，动画中途白屏。
- 侧栏：锁宽只在过渡窗口生效并在 200ms 后解除，快速开关必须清掉上一轮定时器。
- 消息：正文只有 children 拍平的一条来源；管线顺序不可交换，否则 citation 会被二次转义。
- 轮分组：多段 work 的折叠态各自独立，共享一个 Collapsible 会连带展开全部。
- 时间线：贴底判定必须与 lastObservedScrollTop 对账，否则用户被自动拽回底部。

## 进度

本批前：5 文件全部 below30（needLines=1713）。
本批后：5 文件全部 ≥30%（min 30.45%、needLines=0）。
