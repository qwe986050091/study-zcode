# 语义抽检 01：done 3,394 行的 N/P 双读（10 行）

> 抽检对象：b270–b289 已写入的释义行
> 方法：遮罩抽样 + N（反事实）/ P（代码重建）双路径独立判定
> 结果：**10 行里 1 行错，尚未观察到系统性偏差**——`done` 可继续当交付量用，口径标注「经抽样语义验证」；
> 另经定向检索定位并修正 3 处「取值来源」断言（含 S08）
> 注释修正单独提交（`12b1a23b`，3 文件 `+3/−3`），本文件只落抽检与检索结果

## 0. 为什么做

机械门禁（`weak`/`substance`/`filler`/`judgeEntries`/`SAME`/`indent`/`eol`）只查词法与结构，
没有一条能判断「注释主张是否与代码一致」。valkey 线的抽检结果是机械全绿、语义 8/10 不达标，
返工后 8/8 通过——说明这是判据盲区，不是个别笔误。ZCode 的 3,394 行此前从未做过语义读。

### 0.1 与 valkey 的 `8/10` 不可并排读

两者总体不同：

| | ZCode（本线） | valkey S3 |
| --- | --- | --- |
| 对象 | **已有中文注释的 1→1 改写**，原文在，改写受 token 与既有语义约束 | **新写的 counter 句**，无原文可依 |
| 失败形态 | 改写时换错标识符 / 写反顺序（如 S08 的 `sequence`→`index`） | 整句主张不成立、后果缺失 |
| 本次抽检 | 1/10 | 8/10 |

- 这不是「同一方法在两边不稳」，而是**对象风险本来就不同**：改写是在既有事实上做局部替换，
  新写是从零构造主张。把两个数字并排会得出错误结论，台账里必须保留这条差异。
- 也因此，本线的抽检重点不是「句子是否有内容」，而是「改写有没有把原来的事实换错」。

## 1. 抽样规则（可复跑）

```text
批次：b270–b289 共 20 批，等距取偶数批 10 个：b270 b272 … b288
行号：每批内 idx = (批号 × 13) mod 该批登记行数（0 基），取 1 行
校验：取出的当前行必须是 // 注释且与登记表旧文不同（确保是改写后的行）
遮罩：给判定者的输入只有「目标行注释 + 上下各 45 行代码」，去掉路径、行号、批次、
      以及窗口内其它注释与 import 行
```

- 20 批只抽 10 行，故「每批 1 行」只能覆盖一半批次；选偶数批是为了让样本均匀铺满 b270–b289。
- 判定时的输入文件：`_annot_baseline/b290-semantic-masked.json`（不入库）；
  映射（id→批次/文件/行号）单独保存，判定完成前不参与。
- 窗口外的事实（常量定义、`wf-land` 的落点行）在判定后按「off-window 事实核验」单独记录，
  避免把「窗口截断」误判成语义错误。

## 2. N 路径（反事实）

对每条注释写出它的否定命题，再看该否定是否**能成立**或**与可见代码矛盾**；
否定成立 = 注释可被反例推翻 = FAIL。

## 3. P 路径（代码重建）

遮住注释，只从代码重建「这段在做什么」，再比对注释的主张是否**能从代码推出**；
推不出或推出相反结论 = FAIL。

## 4. 逐条结果

| id | 批次 | 位置 | 注释（摘） | N | P | 已定位 | 已修 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | b270 | `packages/ui/src/components/workflow-timeline/WorkflowTimelineStation.tsx:151` | landing 判定 draft 或 fill 落在 fresh 集合，命中时加 wf-land | PASS | PASS | — | — |
| S02 | b272 | `apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx:170` | startIndex 让选中项尽量靠底部 | PASS | PASS | — | — |
| S03 | b274 | `packages/ui/src/lib/modelConfigSync.ts:48` | custom:* 前缀命中的 key，冒号之后整段就是 provider id | PASS | PASS | — | — |
| S04 | b276 | `packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx:91` | default 分支回退到 copy.stages.other | PASS | PASS | — | — |
| S05 | b278 | `packages/ui/src/ToolCallBlocks/renderers/plan-guidance.tsx:57` | extractGuidanceMarkdown 先试 output 再试 input | PASS | PASS | — | — |
| S06 | b280 | `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts:876` | newVariants 为空表示没有冻结集合外的并发写入 | PASS | PASS | — | — |
| S07 | b282 | `packages/desktop/src/host/sourceServerReleaseResolver.ts:132` | mkdir recursive 先建父目录 | PASS | PASS | — | — |
| **S08** | **b284** | `packages/ui/src/app-shell/workflow-artifacts/presets/apply.ts:213` | **x 非数值时退化为到达序号 sequence** | **FAIL** | **FAIL** | **✓** | **✓** |
| S09 | b286 | `apps/zcode-cli/packages/adapters/src/browser/snapshot.ts:324` | 坐标取 rect 中心并用 Math.round 取整 | PASS | PASS | — | — |
| S10 | b288 | `packages/provider-node/src/provider-config-file-codec.ts:130` | normalizeLegacyManualRules 对非对象与非数组原样返回 | PASS | PASS | — | — |

### 4.1 S08 的失败证据

注释（b284 写入）：

```ts
// x 非数值时退化为到达序号 sequence。
```

代码（`presets/apply.ts:259-268`）：

```ts
const ordered = numericX
  ? [...raws].sort((left, right) => {
      const delta = toFiniteNumber(left.x)! - toFiniteNumber(right.x)!;
      return delta !== 0 ? delta : left.sequence - right.sequence;
    })
  : raws;

const points: ChartPointModel[] = ordered.map((raw, index) => {
  const x = numericX ? toFiniteNumber(raw.x)! : index;
```

- 非数值分支用的是 `index`（有序数组下标），不是 `raw.sequence`；
  `sequence` 只在数值分支排序时作为同值 tie-break。
- 两者在「条目按到达顺序塞入」时数值接近，但不是同一个量：`sequence` 是条目自带字段，
  `index` 是当前 `ordered` 的下标；一旦上游重排或跳号，注释就会给出错误的坐标来源。
- N：否定命题「非数值时退化为下标 index」与代码一致 → 成立 → FAIL。
- P：从代码只能推出 `index`，推不出 `sequence` → FAIL。
- 偏差级别：**标识符级**。方向（非数值 → 用到达位置）没写反，错在把实际取值来源
  `index` 写成了 `raw.sequence`；同一函数里 `sequence` 另有用途（数值分支排序 tie-break），
  读者按注释去查 `sequence` 会得到错误结论。不是「后果没写出来」那类整句空转。

## 5. 按批分列

| 批次 | 抽样数 | N fail | P fail | 判 fail 的样本 |
| --- | ---: | ---: | ---: | --- |
| b270 | 1 | 0 | 0 | — |
| b272 | 1 | 0 | 0 | — |
| b274 | 1 | 0 | 0 | — |
| b276 | 1 | 0 | 0 | — |
| b278 | 1 | 0 | 0 | — |
| b280 | 1 | 0 | 0 | — |
| b282 | 1 | 0 | 0 | — |
| b284 | 1 | 1 | 1 | S08 |
| b286 | 1 | 0 | 0 | — |
| b288 | 1 | 0 | 0 | — |
| **合计** | **10** | **1** | **1** | **10 行里 1 行错** |

- 每批只抽 1 行，所以单批 fail 率只有 0% 或 100% 两种取值；跨批看的是**合计**。
- N 与 P 在 S08 上同时失败，说明它不是「窗口不够」造成的伪失败，而是注释与代码的实质偏差。
- `1/10` 的 95% 精确区间（Clopper–Pearson）约 **0.25%–44%**；既不能写成「10% 错误率」，
  也不能据此说「质量已验证」。正确表述：**10 行里 1 行错，尚未观察到系统性偏差**。

### 5.1 定向检索（取值来源类断言）

抽样只覆盖 10 行，不足以回答「这类错误还有多少」。为此按同一失败形态对已写入行做定向检索：

```text
检索面（注释正文）：退化为 | 回退到 | 默认取 | 默认是 | 取…作为 | 回落到 | 否则取
                   首个 | 第一个 | 优先 | 最早
扫描对象：60 份 ZC-deep-b*-rewrite.tsv → 4,012 行可定位的已改写行
逐条核对：注释点名的来源标识符，是否出现在同一函数附近的取值表达式
         （三元 else / ?? / || / default / [0] / find / sort）里
```

- **负控（先做）**：把 S08 修前原文 `x 非数值时退化为到达序号 sequence。` 喂进判据 →
  `AUTO-HIT`（`claim=sequence`，附近取值表达式只有 `index`）；修后文本 →
  `PASS`（`overlap=index`）。两条都符合预期，才继续扫全量。
- 结果：**候选 90 条**（触发词命中）：55 条标识符层标 `AUTO-HIT`、10 条无 ASCII 标识符转人工、
  25 条直接 `PASS`。逐条对照后**确认实质错误 2 条**（X01/X02，均已修）；
  加上抽样命中的 S08，本次共定位 3 条。55 条 `AUTO-HIT` 里大部分是
  「注释讲条件、取值表达式在别处」的误报，不能按自动命中数当错误率。
- 新增 2 条（均已修）：

| id | 位置 | 原注释 | 实际代码 | 问题 | 已定位 | 已修 |
| --- | --- | --- | --- | --- | --- | --- |
| X01 | `packages/ui/src/lib/automationTelemetry.ts:40` | decodeCustomModelValue 优先解析自定义编码，失败再走斜杠与显式提供方 | `explicitProvider \|\| custom?.providerId \|\| slash` | 优先级写反：显式提供方实际最高，不是最后 | ✓ | ✓ |
| X02 | `apps/zcode-cli/packages/adapters/src/exec/outputEncoding.ts:317` | 覆盖变量存在时先校验 chcp 是否支持，不支持则回落到活动代码页 | `return iconv.encodingExists(override) ? override : null` | 后果写反：非法覆盖返回 null，不回落到活动代码页 | ✓ | ✓ |

- 扫描的**盲区**：208 行登记行在当前实盘里已定位不到对应注释（早期批次行号漂移或文件已改动），
  未纳入候选面；`退化为` 这类词也可能出现在与取值无关的叙述里，故 90 条里有大量误报。
  这两点都只影响召回，不影响已确认的 3 条。

## 6. 结论与后续

1. **`done 3,394` 继续当交付量用**，台账口径统一写成
   「**已写入 3,394 行，其中 10 行经 N/P 双读，fail 1**」，不加百分比。
2. 正确表述是「**10 行里 1 行错，尚未观察到系统性偏差**」：
   - 不写「10% 错误率」（n=10，95% 精确区间 0.25%–44%，点估计没有精度）；
   - 不写「质量已验证」（只读了 0.3% 的行）；
   - 不据此外推行数（`3,394 × 10% ≈ 339` 这种算法把区间下界 0.25% 和上界 44% 都抹掉了）。
3. **定向检索确认了同类错误的真实存在**：抽样命中 1 条（S08）+ 检索新增 2 条（X01/X02），
   已全部修正并在 `12b1a23b` 落库；这证明「改写把原事实换错」是实际形态，不是理论风险。
4. **口径约束：抽检 fail 率永不参与 `remain` 计算。** 它只回答「`done` 这个数可信到什么程度」，
   不改变剩余行数、不改变排期、不产生回修工作量；回修只在具体行被定位后按 1→1 处理。
5. 后续固定动作：每完成 10 批做一次 10 行 N/P 双读 + 一次取值来源定向检索；
   判据侧不加词法规则（词法再加也抓不到 S08），若要自动化，只能把
   「注释点名的标识符必须出现在附近取值表达式里」做成 `--scope` 的只读报告，不进门禁。

## 7. 局限

- n=10，每批 1 行，不是随机抽样而是确定性等距抽样；只能回答「是否存在系统性语义偏差」，
  不能给单批精度，也不能估计总体错误率。
- 遮罩窗口为 ±45 行代码，常量与跨函数事实需 off-window 核验（本次 S03 的 `custom:` 前缀、
  S01 的 `wf-land` 落点均按此核验，均成立）。
- 定向检索的召回不完整：208 行登记行在当前实盘定位不到（早期批次行号漂移或文件已改动），
  90 条候选里含大量「条件句被当成取值句」的误报；3 条确认错误是下界，不是全量。
- N/P 由同一模型两条独立路径完成，不是两个人；对「注释与代码是否一致」的判断仍可能共享盲点，
  但 S08 这类标识符级偏差不依赖外部知识即可证伪。
