# ZC-DEEP-B207（4 文件，+120 行）

> 范围：私有文件原子写入与锁队列、套餐身份投影、SSH 远端共享键、会话调试快照契约（合计 416 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b207\orig`；清单：`ZC-deep-b207-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.63%。

## 1. 验收输出

```text
[ok] packages/shared/src/node/privateFilePersistence.ts: 8 blocks, 30 lines
[ok] packages/shared/src/plan-identity.ts: 6 blocks, 30 lines
[ok] packages/shared/src/remoteSshHostKey.ts: 7 blocks, 30 lines
[ok] packages/shared/src/session-debug.ts: 9 blocks, 30 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
[packages/shared/src/node/privateFilePersistence.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/shared/src/plan-identity.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/shared/src/remoteSshHostKey.ts] added=30 nonComment=0 starSlash=0 suspicious=0
[packages/shared/src/session-debug.ts] added=30 nonComment=0 starSlash=0 suspicious=0
TOTAL added=120 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=96 comment=30 packages/shared/src/plan-identity.ts
31.48% code=108 comment=34 packages/shared/src/node/privateFilePersistence.ts
31.58% code=114 comment=36 packages/shared/src/remoteSshHostKey.ts
31.63% code=98 comment=31 packages/shared/src/session-debug.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `shared/src/node/privateFilePersistence.ts` | 原子写入与文件锁 | 进程内 FIFO 再抢 OS 锁、队列节点必释放、尾部按值清理、临时文件 0600、rename 三类重试、失败清临时文件、损坏备份按哈希排他创建 | 30 |
| `shared/src/plan-identity.ts` | 套餐身份投影 | provider 家族前置、coding 优先于 start、active/none/unknown 三态、缓存 TTL、不可用原因映射、产品 id 降级空串 | 30 |
| `shared/src/remoteSshHostKey.ts` | SSH 共享键 | 口令不入键、认证方式参与身份、路径根拆分、盘符大写、分隔符归一、根不可被 .. 弹掉、JSON 数组防撞键 | 30 |
| `shared/src/session-debug.ts` | 调试快照契约 | 三上限、strict 四处、五值网络枚举、可空字段语义、cache 整体可空、TPS 六连判与有限性检查 | 30 |

## 3. 说明

- `privateFilePersistence.ts` 原 3.70%，块锚定锁退避常量、进程内队尾表、可重试错误判定、rename 重试、withFileLock、原子写入与损坏备份；
  把「先还 OS 锁再放队列」的释放顺序写成不变量，避免后续改动引入队头空转。
- `plan-identity.ts` 原 0.00%，块锚定顶层优先级、快照构造、entitlement 三态、no_plan 分支与产品 id 取值；
  重点标注 no_plan 是「确实没有套餐」的唯一来源，其余不可用原因一律 unknown。
- `remoteSshHostKey.ts` 原 5.26%，块锚定路径根拆分、归一化、`..` 处理、结果拼接、认证方式与最终键构造；
  明确口令与私钥口令只用于建连，禁止进入共享键或日志。
- `session-debug.ts` 原 1.02%，块锚定上限常量、参数 schema、计数约束、三张表 schema 与 TPS 计算；
  注释只描述契约与失效后果，未改动任何 zod 校验。
- 首轮落地后 `suspicious=2`（注释里出现 `catch(() => undefined)` 与以 `catch` 开头的行），改写为「rm 的吞错回调」「错误分支里」后复跑归零。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1894 needLines=27286 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1890 needLines=22694
```

累计 1,334 文件 / 125,646 行。

## 提交回填（2026-11-10）

```text
ZC-deep-b207 | 提交 a8784b7e | numstat 120 0 | 门禁 未通过（现行 W/POEM/L 判据：waterLines=11 / 120）
```

口径与边界：

- **提交边界不代表批次边界。** 本批注释在安全快照 `a8784b7e` 里入库，与其余 1,700 余个文件同属一次提交，无法从提交历史还原批次边界。
- 门禁以 `8f7daaf0` 为基线重跑（`--base` / `--diff-base`），以复原落盘时的判据条件；若用 HEAD 作基线会得到 0 行假 PASS。
- 六件套原始 SUMMARY：

```text
deep-gate    SUMMARY files=4 badFiles=4 addedCommentLines=120 waterLines=11 waterRate=9.17% [exit!=1]
zc-verify    SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=120
code-tokens  SUMMARY files=4 codeTokenDiff=0
in-strings   SUMMARY files=4 scanned=4 stringRanges=101 violations=0 addedViolations=0
boilerplate  SUMMARY groups=0 lines=0 files=0 dups=0 dupLines=0 singles=0 mode=diff
upstream     SUMMARY files=4 checked=4 upstreamComments=20 missing=0
```

- 结论：**六件套未全通过**。waterLines=11 说明按现行判据仍有水句，需按 §2.16 逐行改写后重新门禁；本批状态为「已提交、门禁未通过」。
