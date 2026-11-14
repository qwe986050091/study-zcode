# ZC-DEEP-b98

> 批次：B98（6 文件，按 31.4% 口径计算目标 306 行，实际 +306）。
> 逐文件独立 spec、逐份自检后一次插入；单批 6 个文件，按同目录优先选批。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b98\orig`；开工前 6 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b98
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=306

node check-batch.mjs ZC-deep-b98 ZC-deep-b98-files.txt
TOTAL added=306 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.20  321  234   73  49  packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.tsx
31.28  532  390  122  52  packages/ui/src/components/workflow-timeline/WorkflowTimeline.tsx
31.40  228  172   54  50  packages/ui/src/components/workflow-timeline/workflow-face-motion.ts
31.52  222  165   52  50  packages/ui/src/conversation-share-interaction/ConversationSharePreflightStatus.tsx
31.56  350  263   83  51  packages/ui/src/components/workflow-timeline/WorkflowTimelineStation.tsx
33.14  241  169   56  54  packages/ui/src/components/ui/lightweight-diff-preview.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.20 median=31.46 newComments=306
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `components/ui/lightweight-diff-preview.tsx` | 轻量 diff 行解析与预览 | INV-01~18；原文保留；配色同源；行号粘性 | 54 |
| `workflow-timeline/workflow-face-motion.ts` | 站脸表情与微动效 | INV-01~18；单计时器；偶发有界；位移归零 | 50 |
| `workflow-timeline/WorkflowTimeline.tsx` | 横向时间线主组件 | INV-01~18；量不到不折；飞行不折；滚动结算 | 52 |
| `workflow-timeline/WorkflowTimelineStation.tsx` | 站头与轨道行 | INV-01~18；不可点用 span；虚线语义；折叠一致 | 51 |
| `workflow-artifacts/WorkflowArtifactTilePreview.tsx` | 产物缩略预览 | INV-01~18；类别优先；解码有界；请求门控 | 49 |
| `conversation-share-interaction/ConversationSharePreflightStatus.tsx` | 分享预检诊断入口 | INV-01~18；优先级摘要；全空不渲染；列表有界 | 50 |

合计 **306**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 动效只走定时器链，不进 React 渲染

`workflow-face-motion.ts` 的全部动画由 `setTimeout` 链驱动，状态写在 `dataset` 上。
若把表情放进 React state，每帧都会触发重渲染，工作流站列表在滚动时明显掉帧。

### 2. 视口量不到时不折叠

`WorkflowTimeline.tsx` 的折叠依赖三个量测宽度，任一为空即不折叠。
无布局环境（离屏、测试、首帧）把值当零会让所有站折到边檐，内容凭空消失。

### 3. 飞行中的目标站不折

镜头飞向某个站时，该站必须在折叠集合之外。
否则飞行终点是一块被折起的空白，用户看不到落点。

### 4. 站头可点性决定语义元素

`WorkflowTimelineStation.tsx` 在 `onSelectStation` 缺席时渲染 `span`，存在时渲染 `button`。
统一用 `button` 会在整块开关关闭时吞掉点击，破坏时间线的冒泡行为。

### 5. 预览形态判定优先按 kind

`WorkflowArtifactTilePreview.tsx` 先按产物 kind 判定 markdown，再回退 mime。
只按 mime 判定时，`text/plain` 的 markdown 产物会走纯文本路径，丢掉渲染。

### 6. 字节解码有界

`decodeHead` 只解码开头固定字节数，配合上限判定。
整份解码大文档会占满主线程，缩略图滚动期间明显卡顿。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 行类型按任意位置判定 | 正文中的加号把上下文行标成新增 |
| 内容不剥离前缀 | 界面把统一 diff 标记当代码显示 |
| 行号列非粘性 | 横向滚动后行号被推出视野 |
| 动效写入 React state | 站列表滚动掉帧 |
| 多轮动画不清计时器 | 表情叠加，画面抖动 |
| 恢复重建不清态 | 上一轮朝向残留 |
| 量不到宽度按零折叠 | 离屏与首帧内容全部消失 |
| 飞行中目标站被折 | 镜头落到空白处 |
| 站头统一用按钮 | 不可点时吞掉点击 |
| 站台行与轨道行不同列 | 灯与名字错位 |
| 预览只按 mime 判定 | markdown 产物降级为纯文本 |
| 图片按文本上限拒绝 | 大图预览空白 |
| 不可预览仍发请求 | 白拉字节并闪错误字形 |
| 问题过多不截断 | 浮窗撑爆视口 |

## 断点报告（续跑基线）

- 最后完成批次：**B98**（6 文件 / +306 行 / 全绿）；`added=306`、硬校验全 0。
- 累计（core+apps）：**860 文件 / 106,603 行**。
- 半插入残留：无（6 份 spec 均补足到目标行后一次插入）。
- 剩余缺口：按基线推导 **2,364 个 coreBelow30 / 34,987 行**，完成度 **75.3%**。

> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.20%~33.14%，`suspicious=0`。
