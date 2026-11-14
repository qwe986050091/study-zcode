# ZC-DEEP-B193（4 文件，+132 行）

> 范围：共享运行环境键与清洗、Source Server 兼容性清单、终端面板动画与拖拽、人类浏览器视图偏好（合计 841 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b193\orig`；清单：`ZC-deep-b193-files.txt`。
> 目标密度 31.4%，实际落点 31.07%~31.78%。

## 1. 验收输出

```text
[ok] packages/shared/src/runtimeEnv.ts: 4 blocks, 34 lines
[ok] packages/shared/src/source-server/compatibility.ts: 4 blocks, 32 lines
[ok] packages/ui/src/app-shell/AnimatedTerminalPanel.tsx: 4 blocks, 34 lines
[ok] packages/ui/src/browser-use/HumanBrowserView.tsx: 4 blocks, 32 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=132
TOTAL added=132 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.40% code=242 comment=76 packages/shared/src/runtimeEnv.ts
31.07% code=103 comment=32 packages/shared/src/source-server/compatibility.ts
31.62% code=136 comment=43 packages/ui/src/app-shell/AnimatedTerminalPanel.tsx
31.78% code=107 comment=34 packages/ui/src/browser-use/HumanBrowserView.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/runtimeEnv.ts` | 运行环境键 | 键集中声明、真值归一、默认开启、清洗名单、凭据成组捕获、遥测单提、透传增量合并 | 34 |
| `shared/src/source-server/compatibility.ts` | 版本兼容性 | 严格清单模式、编译期注入、版本正则、预发布分段比较、缺段更早、升级目标条件展开 | 32 |
| `ui/src/app-shell/AnimatedTerminalPanel.tsx` | 终端面板 | 首次展开才建会话、拖拽降频、松手与失焦收尾、隐藏禁用热区、折叠仅显式关闭 | 34 |
| `ui/src/browser-use/HumanBrowserView.tsx` | 人类浏览器视图 | 弹窗独立初值、初次偏好只算一次、视口写入合并、取走再清空、卸载冲刷、深拷贝保存 | 32 |

## 3. 说明

- `runtimeEnv.ts` 已有 42 行注释，块落在开发模式判断、环境名归一与清洗入口前；既有键数组与凭据注释未动。
- `compatibility.ts` 原为零注释，块落在清单模式、版本解析与版本比较前；正则与比较表达式保持原样。
- `AnimatedTerminalPanel.tsx` 的块落在组件签名、拖拽结束回调与 JSX 返回语句前；既有副作用与 JSX 内注释未动。
- `HumanBrowserView.tsx` 的块落在组件签名、保存回调与清理回调前，均为语句层；`return (` 出现两次故未作锚点。
- 本批 4 份 spec 均一次 check 通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1950 needLines=28966 min=0.00 median=31.33
本会话范围 files=4562 coreBelow30=1946 needLines=24374
```

累计 1,278 文件 / 123,869 行。
