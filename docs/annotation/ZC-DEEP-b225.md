# ZC-DEEP-B225（4 文件，+120 行）

> 范围：插件沙箱 relay、模型选项 JSON Merge Patch、Endpoint 作用域内置源与远端连接错误归一（合计 445 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b225\orig`；清单：`ZC-deep-b225-files.txt`。
> 目标密度 30% 以上，实际落点 32.73%~34.09%。

## 1. 验收输出

```text
[ok] packages/desktop/src/renderer/src/plugin-sandbox/relay.ts: 14 blocks, 30 lines
[ok] packages/model-option-map/src/merge-patch.ts: 14 blocks, 30 lines
[ok] packages/provider-node/src/endpoint-scoped-zcode-builtin-source.ts: 14 blocks, 30 lines
[ok] packages/shared/src/source-server/connectionErrors.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
32.73% code=110 comment=36 packages/shared/src/source-server/connectionErrors.ts
32.79% code=122 comment=40 packages/provider-node/src/endpoint-scoped-zcode-builtin-source.ts
32.80% code=125 comment=41 packages/desktop/src/renderer/src/plugin-sandbox/relay.ts
34.09% code=88 comment=30 packages/model-option-map/src/merge-patch.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `renderer/src/plugin-sandbox/relay.ts` | 沙箱转发内核 | 纯转发不解析、allow 白名单与去重、身份必须 64 位十六进制、init 五字段校验、sandboxId 匹配、端口唯一、重复 init 保留首个、销毁幂等 | 30 |
| `model-option-map/src/merge-patch.ts` | JSON Merge Patch | 顺序应用、冲突即失败、前缀重叠、空对象不算写入、克隆后合并、null 删除、数组视为叶子、空原型防污染 | 30 |
| `provider-node/src/endpoint-scoped-zcode-builtin-source.ts` | Endpoint 作用域源 | Endpoint 决定路径、切换不继承缓存、并发只解析一次、in-flight 自清理、路径未变即复用、构造失败回滚、旧实例最后销毁 | 30 |
| `shared/src/source-server/connectionErrors.ts` | 连接错误归一 | 不抛错、seen 防环、确认码优先、阶段码排除、内层优先、系统码表、AbortError、文本猜测优先级、阶段兜底仅顶层 | 30 |

## 3. 说明

- `relay.ts` 原 8 行注释（5.56%），块锚定 allow 白名单常量、sanitize 函数、非字符串早退、去重拼接、身份解析、身份正则、relay 工厂、handleInit、sandboxId 比较、端口唯一、重复 init、iframe 创建与 dispose。
- `merge-patch.ts` 原 0 注释（0.00%），块锚定补丁接口、应用入口、路径收集、冲突查找、合并调用、路径收集函数、空对象判断、重叠判断、mergeObject、null 删除、非对象目标、cloneJson 与空原型构造。
- `endpoint-scoped-zcode-builtin-source.ts` 原 4 行 JSDoc（2.72%），块锚定选项接口、类声明、read、onDidChange、refresh、resolveActiveFilePath、ensureCurrent、在飞复用、resolveCurrent、路径比较、物化 try、旧实例销毁与销毁断言。
- `connectionErrors.ts` 原 4 行注释（3.39%），块锚定两张码表、归一入口、visit、seen 防环、确认码、递归子项、内层优先、码表查找、AbortError、认证失败、host key 变更与顶层兜底。
- 本批一次 spec 行数校验失败（`relay.ts` 31 行，多一条 block），删除该块后重新生成；失败未落盘。最终 `deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`；总账 `4,562 + 555 = 5,117` PASS。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1822 needLines=25256 min=0.00 median=31.36
```

累计 1,406 文件 / 127,809 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b225 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=29 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=29 waterRate=24.17% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=95 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=51 missing=0
```

- 结论：**六件套未全通过**。waterLines=29 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
