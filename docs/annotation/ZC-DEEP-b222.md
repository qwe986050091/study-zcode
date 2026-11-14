# ZC-DEEP-B222（4 文件，+120 行）

> 范围：分组件归档打包、按行范围读文本、node_repl 浏览器 broker 与启动埋点（合计 715 代码行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b222\orig`；清单：`ZC-deep-b222-files.txt`。
> 目标密度 30% 以上，实际落点 31.44%~32.32%。

## 1. 验收输出

```text
[ok] packages/zcode-server-cli/src/packaging/stageArchives.ts: 14 blocks, 30 lines
[ok] apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts: 14 blocks, 30 lines
[ok] apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts: 14 blocks, 30 lines
[ok] apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts: 14 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
```

逐文件密度（`codeRatio` = 注释 ÷ 代码）：

```text
31.44% code=229 comment=72 apps/zcode-cli/packages/adapters/src/fs/text-range-reader.ts
31.46% code=213 comment=67 apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts
32.11% code=109 comment=35 packages/zcode-server-cli/src/packaging/stageArchives.ts
32.32% code=164 comment=53 apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `zcode-server-cli/src/packaging/stageArchives.ts` | 分组件归档 | 宿主 tar/zip 改写、参数数组、macOS 禁 xattr、退出码、遍历确定性、缺失跳过、临时目录清理 | 30 |
| `adapters/src/fs/text-range-reader.ts` | 范围读文本 | 行号从 0 起、快慢双路径、大小门禁、取消、carry 残行、末行不丢、编码探测补齐、revision | 30 |
| `bootstrap/src/app/node-repl-browser-broker.ts` | 浏览器 IPC broker | 仅本机 socket、令牌常量比较、请求体上限、schema 校验、失败回 id、EPIPE 收敛、close 幂等、unref | 30 |
| `bootstrap/src/app/startup-marks.ts` | 启动埋点 | 插件事实唯一、抑制集合与默认名单必传、技能门顺序、只记计数与来源、stage 语义、计时器注入 | 30 |

## 3. 说明

- `stageArchives.ts` 原 0 注释（0.00%），块锚定命令入口、Windows zip 改写、参数改写、env、macOS 参数、spawn、exit 回调、目录展开、hashPaths、路径入摘要、归档入口、扩展名与格式分支。
- `text-range-reader.ts` 原 54 行 JSDoc（16.67%），首行 `/**` 在文件内出现 4 次，补 `firstNth: 1` 锚定文件头；块锚定入口、分流阈值、大小门禁、快路径、换行归一、空文件分行、流式路径、流创建、逐块循环、编码探测、样本补齐、行选择与 revision。
- `node-repl-browser-broker.ts` 原 31 行 JSDoc（9.45%），块锚定句柄接口、工厂、连接处理、unref、close、注入函数、无 broker 早退、socket 路径、连接主流程、socket 错误监听、鉴权、请求执行与 readLine。
- `startup-marks.ts` 原 21 行 JSDoc（7.42%），块锚定插件发现入口、存储根、默认名单、技能门、计时事件、首事件、配置/存储/MCP/runtime 四个阶段标记、启动完成、调试摘要与 debug 调用。
- 四份 spec 全部一次插入成功，无锚点冲突；`deletedNonZero=0`、`nonCommentAdded=0`、`starSlash=0`、`syntaxErrorFiles=0`；总账 `4,562 + 555 = 5,117` PASS。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1834 needLines=25580 min=0.00 median=31.35
```

累计 1,394 文件 / 127,449 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b222 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=35 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=35 waterRate=29.17% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=168 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=580 missing=0
```

- 结论：**六件套未全通过**。waterLines=35 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
