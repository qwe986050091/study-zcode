# ZC-DEEP-b1

> 批次：B1（缺口第 1 档）。基线快照：`d:\code\_annot_baseline\ZC-deep-b1\orig`。
> 规范：`DEEP-SPEC.md` v1；本批只新增整行 `//` 注释。

## 校验

```
node zc-verify.mjs ZC-deep-b1
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1175

deep-density --only packages/ui/src/v4/SessionPane.tsx
30.14  7180  5425  1635  1175  packages/ui/src/v4/SessionPane.tsx
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.14 median=30.14 newComments=1175
```

前后对比：comment 460 → 1635（8.5% → 30.14%），code 5425 不变（零删除 / 零 token 改动）。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/v4/SessionPane.tsx` | 单 pane 竖切：会话订阅 → timeline 渲染 → composer 发送 / stop / 队列 / 分享发布的总装点 | 文件头 INV-01~INV-26 不变量表；宿主契约与 `readOnly`/`selectionSideChat` 能力收窄；lease 代次与草稿晋升复用；共享选择草稿 pending/confirmed 状态机；预检缓存 scopeKey 与 turn fingerprint；命令 envelope 与 ACK 账本；队列撤回编辑事务；Highspeed 起点同步冻结；错误指纹与本地/投影错误分离；fileChanges 并发合并与 LRU；Esc 与会话外事件归属；发布幂等 attemptKey 与四道确认门；Dock 两态与挂载顺序 | 1175 |

合计：**1175**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

- INV-01 pane 只渲染 projection，不持有第二份 accepted queue / turn 真值。
- INV-05 lease 换代先收紧 owner，再交给 acquire effect；草稿晋升不重挂 Composer。
- INV-09 预检缓存键 = scopeKey + productTurnId，且必须比对 turn fingerprint 才可复用。
- INV-12 队列撤回先把锁落库，再校验 Composer 绑定代次。
- INV-18 Composer / 分享 Dock 的挂载顺序固定，避免焦点与滚动锚点在两帧之间跳变。
