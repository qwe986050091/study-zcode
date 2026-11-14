# SVC-B27 深度注释索引（跨口径补齐：project-storage 测试夹具）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/project-storage/test-fixture.ts`（1 文件）。
> 触发：另一会话以 `zc-measure.mjs` 口径复测 services，得到 466 文件 / 1 个 <30% / 缺口 17 行。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `project-storage/test-fixture.ts` | 55 | 0 → 17 | 30.91% | 17 |
| **合计** | **55** | — | — | **17** |

## 2. 分段

b27a（8 处锚点，共 17 行）：文件头 4 行、契约透传 2 行、模块级资源栈 2 行、`afterEach` 1 行、`fixture` 入口 2 行、建表 `exec` 2 行、`add` 辅助 2 行、`return` 上下文 2 行。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b27
SUMMARY files=1 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=17
```

逐文件密度复测（`--baseline ZC-deep-svc-b27\orig --only ...`，`--exclude` 仅 `.test/.spec`）：

```text
30.91	72	55	17	17	packages/services/src/project-storage/test-fixture.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.91 median=30.91 newComments=17
PASS: all 1 file(s) >= 30% (mode=code)
```

全 services 既有验收口径复测（排除 `test-fixture.ts`，467 个生产文件）：

```text
EXCLUDED 34 file(s) by --exclude
SUMMARY files=467 coreBelow30=0 needLines=0 min=30.05 median=32.00 newComments=29676
PASS: all 467 file(s) >= 30% (mode=code)
```

`zc-measure.mjs` 口径复测（排除 `.d.ts`、不排除 `test-fixture.ts`，services 子集）：

```text
services files=466 below=0 need=0
```

## 4. 467 与 466 的差异来源

结论：**没有任何文件被删除、移动或新增**，差异全部来自两套测量器的排除清单不同。

| 项 | 我方验收（deep-density） | 另一会话（zc-measure） |
| --- | --- | --- |
| 排除 `*.test.ts` / `*.spec.ts` | 是 | 是 |
| 排除 `test-fixture.ts` | 是 | 否 |
| 排除 `.d.ts` | 否 | 是 |
| services 文件数 | 467 | 467 + 1 − 2 = 466 |

实测集合：当前 `packages/services/src` 共 501 个 `.ts/.tsx`，其中 33 个 `*.test.ts`；非测试文件 468 个（含 `test-fixture.ts` 与 2 个 `.d.ts`）。

- 我方 467 = 468 − 1（`test-fixture.ts`，位于基线 `_files.txt` 之外，从未进入验收分母）。
- 对方 466 = 468 − 2（`runtime-tools/node-forge.d.ts`、`types/yazl.d.ts`）。
- 差值 −1 = −2 个 `.d.ts` + 1 个 `test-fixture.ts`。

该文件在基线快照 `ZC-deep-svc-base` 中确实不存在（基线与当前文件集合比对：`base not in cur = 0`，`curAll not in base` 仅 33 个测试文件与 `test-fixture.ts`），因此它不是「被删除或被排除的历史文件」，而是从 B1 起就被验收口径排除、因而未被注释的测试支撑文件。

## 5. 本批锚定的不变量

- 该文件仅被 Vitest 用例导入，不进入生产构建图；注释不得改变这一点。
- `afterEach` 必须以 `splice(0)` 一次性取走资源队列，避免重复关闭同一数据库句柄。
- `context.now` 固定为 `10`，时间相关断言依赖该常量。
- 多语句 `exec` 的模板字符串属于被测语义（迁移表结构），注释只允许写在语句之外。

## 6. 看似该改、其实不能改

- 不能把 `test-fixture.ts` 改成生产实现或加业务逻辑：它只是夹具。
- 不能在模板字符串内部插入注释：会直接改变 SQL 文本，破坏迁移用例。
- 不能把 `now` 改成 `Date.now()`：会让时间断言变得不可复现。
- 不能把资源回收改成 `afterAll`：单个用例失败时残留目录会污染后续用例。
