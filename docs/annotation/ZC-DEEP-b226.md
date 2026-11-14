# ZC-DEEP-B226（4 文件，+120 行）

> 范围：UI 夹具文件摘要、stream-animate 运行数据仓、输入框附件动作菜单与代码片段复制组件（合计 444 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b226\orig`；清单：`ZC-deep-b226-files.txt`。
> 目标密度 30% 以上，实际落点 32.08%~34.48%。

## 1. 验收输出

```text
[ok] packages/desktop/scripts/gen-ui-fixture/file-summary.tsx: 14 blocks, 30 lines
[ok] packages/stream-animate/src/server/dataStore.ts: 14 blocks, 30 lines
[ok] packages/ui/src/components/ai-elements/prompt-input-actions.tsx: 14 blocks, 30 lines
[ok] packages/ui/src/components/ai-elements/snippet.tsx: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
32.08% code=159 comment=51 packages/ui/src/components/ai-elements/prompt-input-actions.tsx
33.03% code=109 comment=36 packages/ui/src/components/ai-elements/snippet.tsx
33.71% code=89 comment=30 packages/desktop/scripts/gen-ui-fixture/file-summary.tsx
34.48% code=87 comment=30 packages/stream-animate/src/server/dataStore.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/scripts/gen-ui-fixture/file-summary.tsx` | 文件预览与摘要夹具 | rowId/turnId 双侧一致、mode 三态文案、visualize 必带 path、useMemo 依赖完整、变更计数与明细同源、两块 UI 稳定 id、compact 只影响展示 | 30 |
| `stream-animate/src/server/dataStore.ts` | 运行数据落盘与读取 | 目录可反推、前 8 位分片、建目录幂等、追加写、每条一行、关闭等落盘、缺根目录视为空、只认 summary.json、取尾部行、空行过滤 | 30 |
| `ui/.../ai-elements/prompt-input-actions.tsx` | 附件菜单与截图采集 | 无能力即降级、媒体流必释放、视频元素复位、零尺寸即失败、File 包装、时间戳文件名、取消不报错、defaultPrevented 放弃、透传 props | 30 |
| `ui/.../ai-elements/snippet.tsx` | 只读片段与复制按钮 | 代码只由 Provider 注入、value 用 useMemo、输入只读且 Omit value、复制前判能力、复制中不重入、超时复位、卸载清定时器、错误交调用方 | 30 |

## 3. 说明

- `file-summary.tsx` 原 0 注释（0.00%），块锚定夹具入口、row 构造、文本三元、rows 包装、context、远端身份、变更清单、header、fileChanges、预览卡 hook、变更目标、return 与行类型。
- `dataStore.ts` 原 0 注释（0.00%），块锚定 createRunId、时间戳压缩、getRunDir、分片路径、createRawWriter、写流标志、listRuns、倒序比较、readRawLines、拆分取尾、递归收集、readdir 容错与 closeStream。
- `prompt-input-actions.tsx` 原 21 行注释（13.21%），块锚定 captureScreenshot、能力探测、getDisplayMedia、Promise 桥接、canvas、toBlob、File 构造、两个动作项、openFileDialog、add、DOMException 分支与菜单触发器。
- `snippet.tsx` 原 6 行版权注释（5.50%），块锚定上下文、Snippet 外壳、contextValue、SnippetInput、CopyButton、状态量、timeoutRef、复制回调、能力探测、writeText、setTimeout、useEffect 与图标三元。
- 本批四文件均为 TSX/TS 语句级锚点，刻意避开 JSX 子节点区域，避免 `//` 行被当作文本节点渲染。最终 `deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`；总账 `4,562 + 555 = 5,117` PASS。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1818 needLines=25148 min=0.00 median=31.36
```

本会话范围（排除 services 与 4 个 L0 字典）：`files=4562 coreBelow30=1814 needLines=20556`。

累计 1,410 文件 / 127,929 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b226 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=26 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=26 waterRate=21.67% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=149 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=293 missing=0
```

- 结论：**六件套未全通过**。waterLines=26 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
