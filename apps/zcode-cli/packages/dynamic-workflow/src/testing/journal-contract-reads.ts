// INV-01 两个实现共用同一份读面断言。守住位置：registerReadCases 的 factory 形参与每条用例首行的 factory() 调用。改错故障：一侧悄悄退回读全表或换了排序，冷回放与 GetWorkflowRun 在内存部署与 SQLite 部署上归约出不同状态。
// INV-02 [事务] 每条用例独占一个 store。守住位置：各 it 内第一句 factory() 与随后的 seedNodes 调用。改错故障：共用单例后前一条用例写入的节点污染后一条的顺序、计数与字节和，失败信息还会指向错误的用例。
// INV-03 kinds 过滤后必须保持插入序。守住位置：kinds 用例第一条 expect 期望 report#1、report#2、report#3。改错故障：存储层补了按 kind 或 id 排序，快照顺序与写入顺序分叉，回放出的状态序列随之改变。
// INV-04 kinds 的两端语义。守住位置：kinds 用例中 kinds 为 all 与为空数组的两条断言。改错故障：空数组被当成不限而返回全表，调用方用空选择做短路时反而把整表读出来。
// INV-05 未知 run 一律返回空。守住位置：kinds 用例末尾、countNodes 用例与 sumResultBytes 用例中三处 runId 为 nope 的断言。改错故障：空 run 回落到默认 run，跨 run 串数据且很难被发现。
// INV-06 [事务] 二次 upsert 不挪行位。守住位置：upsert 用例对 rows[0] 的 siteId 与 status 两次断言。改错故障：结算写成追加行，按插入顺序对每个已结算节点都是假话。
// INV-07 withResult 为假只摘 result 列。守住位置：withResult 用例的 rest 对比与 toHaveProperty 否定断言。改错故障：连带丢掉 stats 或 messageBoundary，恢复统计归零，而只盯 result 的断言仍会放过。
// INV-08 getNode 缺省读整行。守住位置：withResult 用例末尾两次 getNode，一次不带选项、一次显式传真。改错故障：点查也套瘦身投影，单节点恢复拿不到结果。
// INV-09 null 结果是合法值而非缺失。守住位置：null 结果用例对 result 的 toHaveProperty 断言。改错故障：null 被当成缺字段剔除，快照少一条已完成的空结果。
// INV-10 limit 作用在 kind 过滤之后。守住位置：分页用例 limit 为 2 时期望 report#1 与 report#2，以及 limit 为 0 时的空数组。改错故障：先截断再过滤，后面几页恒空。
// INV-11 countNodes 不列举行。守住位置：计数用例四条断言，含未知 kind 与未知 run 都回 0。改错故障：退化成先列举再取长度，长 run 上多一次全表读并使字节预算失真。
// INV-12 sumResultBytes 与 countNodes 用同一把尺。守住位置：字节和用例的 bytes 辅助函数与三个加数。改错故障：一侧按字符数计，中文只记两个单位，预算提前放行导致快照超限。
// INV-13 [资源] null 计四字节、无结果计零。守住位置：字节和用例把 bytes(null) 计入总和，并断言 ask 行为 0。改错故障：null 当零或对 undefined 抛错，两种实现的 run 级预算差出固定字节数。
// INV-14 [资源] 预算不足时至少保留首行。守住位置：maxResultBytes 用例中 sites(1) 仍返回 report#1。改错故障：返回空页，冷回放丢失报告上下文，看起来像根本没有报告。
// INV-15 [事务] 恰好等于预算不截断。守住位置：maxResultBytes 用例中 sites(one * 2) 仍返回两条。改错故障：判定写成大于等于，副整行被裁掉，实际额度比设计值少一行。
// INV-16 actor 名单按 name 过滤并可选剥离 persona。守住位置：actor 用例中 withPersona 为假与为真的两组断言。改错故障：投影漏摘 persona，大段 system 文本随名单进入快照，或反过来把应当保留的 persona 一并删掉。
// INV-17 listEvents 的 types 过滤先于 cursor 与 limit。守住位置：事件用例中 limit 为 2 时期望序号 0 与 2，以及空数组与 all 两条端点断言。改错故障：先取页再过滤，第二页开始丢事件。
// INV-18 [失败路径] reportItems 排名跨整 run。守住位置：排名用例从 afterSequence 1 读两页，两次 has 均为假。改错故障：按页内计数，翻页后第 3 条报告又把 item 带回快照。
//
// 模块职责：为 journal 读面选项提供一份双实现共用的契约用例，覆盖 kinds、withResult、limit、maxResultBytes、countNodes、sumResultBytes、actor 名单、事件类型与报告 item 排名。
// 状态所有权：store 由调用方工厂注入、在每个 it 内独占，本模块不持有跨用例状态，只提供 node、seedNodes、report、reportItemOf 四个哑夹具。
// 阅读顺序：先看四个夹具与固定种子，再看节点读面的各项断言，最后看事件类型过滤与报告 item 的排名收尾。
/**
 * 读面选项的契约用例（docs/execution-engine.md「Reading the journal」）：kinds / withResult /
 * limit / maxResultBytes / countNodes / sumResultBytes / types / reportItems / 按名取子代理。两个实现（内存、SQLite）必须逐字同
 * 语义——读者按这些选项把过滤下推到存储层，任何一侧偷偷退回「读全表」或给出不同的顺序，
 * 冷回放与 GetWorkflowRun 就会在两种部署上归约出不同的状态。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe（与兄弟模块同规）。
 */

import { expect, it } from "vitest";
import type { JournalStorePort, NodeRecord, RunEvent } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

// [契约] node 辅助函数只填 NodeRecord 的最小必填面，结果固定为 of 加 siteId，便于用例用 siteId 反查归属。
// [契约] 第三个参数是浅覆盖入口，调用方按需补 actorSiteId、artifactId、input、status 或 result。
// [顺序] 覆盖展开放在末尾，后写的字段稳定压过默认值，用例不必重复列全部字段。
// [事务] 默认 status 为 completed、ordinal 为 1，让计数与排序用例只聚焦 kind 与插入次序。
// [失败路径] 若把默认 result 换成 undefined，withResult 的字节和用例会少算一行，预算断言随之漂移。
// [权衡] 该辅助函数不校验 kind 与 result 的一致性，故意保持哑结构，避免测试夹具重复实现领域规则。
function node(
  siteId: string,
  kind: NodeRecord["kind"],
  extra: Partial<NodeRecord> = {},
): NodeRecord {
  return {
    runId: "r1",
    siteId,
    ordinal: 1,
    kind,
    inputHash: `h-${siteId}`,
    status: "completed",
    result: { of: siteId },
    ...extra,
  };
}

/** 一条 run：ask、report×3（第二条带标签）、world-read、artifact，按这个顺序落库。 */
// [契约] seedNodes 固定 r1 的六行顺序：ask#1、report#1、带 chart 的 report#2、files.grep#1、report#3、artifact#1。
// [顺序] 先建 run 再逐条写节点，所有顺序断言都以这份种子为基准，改动一行就要同步多条例子的期望。
// [事务] 中间插入 world-read 行，专门检验 kind 过滤后仍保持原插入序，而不是把同类行聚到一起。
// [资源] 第二条 report 带 artifactId chart，用于验证 withResult 之外的列在投影后仍完整保留。
// [失败路径] 若把 report#2 挪到末尾，kinds 与分页用例的期望数组会同时失真，却可能仍被宽松断言放过。
// [契约] 六行共用 baseRun 构造的 runId r1，任何一条漏写 runId 都会落到别的 run 且静默不可见。
function seedNodes(store: JournalStorePort): void {
  store.createRun(baseRun("r1"));
  store.putNode(node("ask#1", "ask", { actorSiteId: "actor#1", actorOrdinal: 1, actorSeq: 0 }));
  store.putNode(node("report#1", "report"));
  store.putNode(node("report#2", "report", { artifactId: "chart" }));
  store.putNode(node("files.grep#1", "world-read", { input: { op: "grep", args: ["x"] } }));
  store.putNode(node("report#3", "report"));
  store.putNode(node("artifact#1", "artifact", { artifactId: "chart" }));
}

// [契约] report 辅助函数只造 run 级 report 事件，instance 固定 ordinal 为 1，siteId 由调用方给出。
// [契约] item 是 unknown，null 与字符串、对象都算合法载荷，不能用真值判断来区分有无。
// [顺序] artifactId 用条件展开追加，undefined 时字段完全不出现，避免与显式空标签混淆。
// [失败路径] 若无条件写入 artifactId，报告过滤用例里那条无标签事件会多出一个 undefined 字段，对比断言全部失败。
function report(siteId: string, item: unknown, artifactId?: string): RunEvent {
  return {
    type: "report",
    instance: { siteId, ordinal: 1 },
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

// [契约] reportItemOf 把「有没有 item」与「item 是什么」拆成两个可断言维度，null 也能被区分出来。
// [失败路径] 非 report 事件直接抛错，防止把 log 事件误当成被摘掉 item 的报告。
// [契约] 用 in 运算符探测字段存在性，不做真值判断，因此 item 为 null 时仍返回 has 为真。
// [权衡] 返回包装对象而非直接返回 item，是为了让空 item 与缺字段在断言里都可读且不产生歧义。
function reportItemOf(event: RunEvent): { has: boolean; item?: unknown } {
  if (event.type !== "report") throw new Error(`not a report: ${event.type}`);
  return "item" in event ? { has: true, item: event.item } : { has: false };
}

// [契约] 本模块只导出 registerReadCases，由两个实现各自的契约测试文件注入工厂，用例正文完全共用。
// [状态] 工厂在每条用例内部调用一次，store 的所有权归该用例，用例结束即丢弃。
// [契约] 不另开 describe，与本目录兄弟模块保持同一收集层级，便于按文件名与用例名定位失败。
// [顺序] 用例排列从节点读面到事件读面：kind、upsert、投影、分页、计数、字节、actor、事件、报告排名。
// [失败路径] 新增读选项时若只改一个实现，共用用例会一侧红、一侧绿，这正是契约测试要暴露的偏差。
export function registerReadCases(factory: () => JournalStorePort): void {
  // [契约] 三条断言分别锁住保序、跨 kind 组合，以及 all 与空数组的两端语义。
  // [顺序] 期望数组与 seedNodes 的落库顺序逐项对应，出现重排就是存储层私自加了排序。
  // [失败路径] 空数组必须返回空而不能回落成全部，否则调用方用空选择做短路反而读全表。
  // [契约] 未知 run 的查询返回空数组，而不是抛错，也不是返回最近一次 run 的数据。
  // [权衡] 用例只断言 siteId 列表，不断言行内容，把顺序契约与投影契约分开验证。
  it('filters nodes by kind in insertion order, and "all" / [] mean everything / nothing', () => {
    const store = factory();
    seedNodes(store);
    const sites = (rows: NodeRecord[]): string[] => rows.map((row) => row.siteId);
    expect(sites(store.listNodes("r1", { kinds: ["report"], withResult: true }))).toEqual([
      "report#1",
      "report#2",
      "report#3",
    ]);
    expect(
      sites(store.listNodes("r1", { kinds: ["ask", "world-read"], withResult: true })),
    ).toEqual(["ask#1", "files.grep#1"]);
    expect(sites(store.listNodes("r1", { kinds: "all", withResult: true }))).toEqual([
      "ask#1",
      "report#1",
      "report#2",
      "files.grep#1",
      "report#3",
      "artifact#1",
    ]);
    expect(store.listNodes("r1", { kinds: [], withResult: true })).toEqual([]);
    expect(store.listNodes("nope", { kinds: "all", withResult: true })).toEqual([]);
  });

  it("keeps a row's place when it is upserted again", () => {
    // 准入 running → 结算 completed 是同一条 upsert：行的顺序（id）不能因为第二次写而挪到末尾，
    // 否则「按插入顺序」对每个结算过的节点都是假话。
    const store = factory();
    seedNodes(store);
    store.putNode(
      node("ask#1", "ask", { status: "failed", actorSiteId: "actor#1", actorOrdinal: 1 }),
    );
    const rows = store.listNodes("r1", { kinds: "all", withResult: false });
    expect(rows[0]?.siteId).toBe("ask#1");
    expect(rows[0]?.status).toBe("failed");
  });

  it("leaves result out without touching any other column when withResult is false", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const full: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "h",
      status: "completed",
      result: { big: "x".repeat(100) },
      stats: { tokens: 12, toolCalls: 3, turns: 2 },
      messageBoundary: 4,
    };
    store.putNode(full);
    const { result: _result, ...rest } = full;
    void _result;
    const [slim] = store.listNodes("r1", { kinds: "all", withResult: false });
    expect(slim).toEqual(rest);
    expect(slim).not.toHaveProperty("result");
    expect(store.getNode("r1", "ask#1", 1, { withResult: false })).toEqual(rest);
    // 点查缺省读整行。
    expect(store.getNode("r1", "ask#1", 1)).toEqual(full);
    expect(store.getNode("r1", "ask#1", 1, { withResult: true })).toEqual(full);
  });

  it("keeps a null result as null when results are read", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putNode(node("report#1", "report", { result: null }));
    const [row] = store.listNodes("r1", { kinds: ["report"], withResult: true });
    expect(row).toHaveProperty("result", null);
  });

  it("pages nodes with limit after the kind filter, in insertion order", () => {
    const store = factory();
    seedNodes(store);
    const rows = store.listNodes("r1", { kinds: ["report"], withResult: true, limit: 2 });
    expect(rows.map((row) => row.siteId)).toEqual(["report#1", "report#2"]);
    expect(rows[1]?.result).toEqual({ of: "report#2" });
    expect(store.listNodes("r1", { kinds: ["report"], withResult: true, limit: 0 })).toEqual([]);
  });

  it("counts nodes of one kind without listing them", () => {
    const store = factory();
    seedNodes(store);
    expect(store.countNodes("r1", "report")).toBe(3);
    expect(store.countNodes("r1", "ask")).toBe(1);
    expect(store.countNodes("r1", "world-run")).toBe(0);
    expect(store.countNodes("nope", "report")).toBe(0);
  });

  it("sums the UTF-8 bytes of one kind's results without listing them", () => {
    // resume 靠它恢复报告的 run 级字节计数：两个实现必须用同一把尺——`JSON.stringify(result)`
    // 的 UTF-8 字节（SQLite 侧就是 result_json 的长度），多字节字符按字节算，没有结果的行计 0。
    const store = factory();
    store.createRun(baseRun("r1"));
    const bytes = (value: unknown): number =>
      new TextEncoder().encode(JSON.stringify(value)).length;
    store.putNode(node("report#1", "report", { result: { text: "abc" } }));
    store.putNode(node("report#2", "report", { result: "中文" }));
    store.putNode(node("report#3", "report", { result: null }));
    store.putNode(node("ask#1", "ask", { status: "running", result: undefined }));
    expect(store.sumResultBytes("r1", "report")).toBe(
      bytes({ text: "abc" }) + bytes("中文") + bytes(null),
    );
    expect(store.sumResultBytes("r1", "ask")).toBe(0);
    expect(store.sumResultBytes("r1", "world-run")).toBe(0);
    expect(store.sumResultBytes("nope", "report")).toBe(0);
  });

  // [资源] maxResultBytes 是软预算：按插入序累加，遇到会超出的那一行就停，不再继续试探后面的小行。
  // [事务] 预算与 limit 同时生效，谁先到谁收尾，用例用 sites(one * 10, 3) 锁住这条。
  // [权衡] 恰好等于预算不收尾，只有严格超出才停，因此 sites(one * 2) 仍回两条。
  // [失败路径] 一行都放不下时仍返回首行，快照不会因为一条超大报告而变成空页。
  // [契约] 四条期望共用同一份 pad 载荷，单行字节数由 one 表达，改动载荷要同步改预算表达式。
  // [资源] 返回值仍是完整行对象列表，withResult 为真时结果原样带出，预算只决定截断点。
  it("stops a node read before the row that would pass maxResultBytes, but always keeps the first", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const pad = "x".repeat(100);
    for (let index = 1; index <= 4; index += 1) {
      store.putNode(node(`report#${index}`, "report", { result: { index, pad } }));
    }
    const one = new TextEncoder().encode(JSON.stringify({ index: 1, pad })).length;
    const sites = (maxResultBytes: number, limit?: number): string[] =>
      store
        .listNodes("r1", {
          kinds: ["report"],
          withResult: true,
          maxResultBytes,
          ...(limit === undefined ? {} : { limit }),
        })
        .map((row) => row.siteId);
    // 两行半的预算放得下两行。
    expect(sites(one * 2 + one / 2)).toEqual(["report#1", "report#2"]);
    // 恰好两行也放得下（超过才收尾，等于不收）。
    expect(sites(one * 2)).toEqual(["report#1", "report#2"]);
    // 一行都放不下时第一行照样在：快照不会因为一条大报告而一条都不带。
    expect(sites(1)).toEqual(["report#1"]);
    // limit 与字节界同时生效，先到先停。
    expect(sites(one * 10, 3)).toEqual(["report#1", "report#2", "report#3"]);
    expect(
      store
        .listNodes("r1", { kinds: ["report"], withResult: true, maxResultBytes: one * 2 })
        .map((row) => row.result),
    ).toEqual([
      { index: 1, pad },
      { index: 2, pad },
    ]);
  });

  it("filters actors by name and leaves the persona out when asked", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const persona = { name: "judge", system: "You judge." };
    store.putActor({
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "judge",
      persona,
      sessionId: "s1",
    });
    store.putActor({ runId: "r1", siteId: "actor#2", ordinal: 1, name: "scout", persona });
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 2, name: "judge", persona });

    const judges = store.listActors("r1", { name: "judge", withPersona: false });
    expect(judges.map((actor) => `${actor.siteId}@${actor.ordinal}`)).toEqual([
      "actor#1@1",
      "actor#1@2",
    ]);
    expect(judges[0]).toEqual({
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "judge",
      sessionId: "s1",
    });
    expect(judges[0]).not.toHaveProperty("persona");
    expect(store.listActors("r1", { name: "nobody", withPersona: true })).toEqual([]);
    const all = store.listActors("r1", { withPersona: true });
    expect(all).toHaveLength(3);
    expect(all[1]?.persona).toEqual(persona);
  });

  it("filters events by type in sequence order, before the cursor and the limit", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "a" }); // 0
    store.appendEvent("r1", { type: "usage-updated", spentTokens: 1 }); // 1
    store.appendEvent("r1", { type: "log", message: "b" }); // 2
    store.appendEvent("r1", {
      type: "import-cache-closed",
      instance: { siteId: "ask#1", ordinal: 1 },
      cause: "world-run",
    }); // 3
    store.appendEvent("r1", { type: "log", message: "c" }); // 4
    const seqs = (opts: Parameters<JournalStorePort["listEvents"]>[1]): number[] =>
      store.listEvents("r1", opts).map((stored) => stored.sequence);

    expect(seqs({ types: ["log"], reportItems: "all" })).toEqual([0, 2, 4]);
    expect(seqs({ types: ["import-cache-closed", "log"], reportItems: "all" })).toEqual([
      0, 2, 3, 4,
    ]);
    // limit 作用在过滤之后：前两条 log，而不是「前两条事件里的 log」。
    expect(seqs({ types: ["log"], reportItems: "all", limit: 2 })).toEqual([0, 2]);
    expect(seqs({ types: ["log"], reportItems: "all", afterSequence: 0, limit: 1 })).toEqual([2]);
    expect(seqs({ types: [], reportItems: "all" })).toEqual([]);
    expect(seqs({ types: "all", reportItems: "all" })).toEqual([0, 1, 2, 3, 4]);
  });

  // [契约] reportItems 的 limit 是 run 级排名，不是页内计数：第 N 条之后的报告事件摘掉 item，其余字段原样保留。
  // [顺序] 序号期望为 0 到 4，说明摘 item 不改事件条数，也不改 sequence 的连续性。
  // [契约] 第 2 条报告的 item 为 null 仍算「有」，摘除只针对排名越界。
  // [契约] 被摘的事件只剩 type、instance 与 artifactId，时间戳照旧保留。
  // [失败路径] limit 为 0 时四条报告全部无 item，设为「all」时全部保留，两端都要成立。
  // [事务] 排名跨整 run 计算，从 afterSequence 1 读起的用例里第 3、4 条依旧无 item。
  // [权衡] 用例统一经 reportItemOf 读 item，避免直接摸字段，null 与缺失因此不会混淆。
  it("strips the item from every report event after the Nth, keeping every other field", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", report("report#1", { n: 1 })); // 0: rank 1
    store.appendEvent("r1", { type: "log", message: "between" }); // 1
    store.appendEvent("r1", report("report#1", null)); // 2: rank 2 — null 是合法 item
    store.appendEvent("r1", report("report#2", { n: 3 }, "chart")); // 3: rank 3
    store.appendEvent("r1", report("report#1", "four")); // 4: rank 4

    const events = store.listEvents("r1", { types: "all", reportItems: { limit: 2 } });
    expect(events.map((stored) => stored.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(reportItemOf(events[0]!.event)).toEqual({ has: true, item: { n: 1 } });
    expect(events[1]!.event).toEqual({ type: "log", message: "between" });
    expect(reportItemOf(events[2]!.event)).toEqual({ has: true, item: null });
    expect(reportItemOf(events[3]!.event)).toEqual({ has: false });
    expect(events[3]!.event).toEqual({
      type: "report",
      instance: { siteId: "report#2", ordinal: 1 },
      artifactId: "chart",
    });
    expect(reportItemOf(events[4]!.event)).toEqual({ has: false });
    expect(events[4]!.timeCreated).toBeTypeOf("number");

    const none = store.listEvents("r1", { types: ["report"], reportItems: { limit: 0 } });
    expect(none.map((stored) => reportItemOf(stored.event).has)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const every = store.listEvents("r1", { types: ["report"], reportItems: "all" });
    expect(every.map((stored) => reportItemOf(stored.event).has)).toEqual([true, true, true, true]);
  });

  it("ranks report events over the whole run, not over the page being read", () => {
    // 「第几条报告」是 run 的事实：从 cursor 3 开始读，第 3 条报告仍然是第 3 条，
    // 不会因为它是这一页的第一条就把 item 带回来。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", report("report#1", 1)); // 0
    store.appendEvent("r1", report("report#1", 2)); // 1
    store.appendEvent("r1", { type: "log", message: "x" }); // 2
    store.appendEvent("r1", report("report#1", 3)); // 3
    store.appendEvent("r1", report("report#1", 4)); // 4

    const page = store.listEvents("r1", {
      types: ["report"],
      reportItems: { limit: 2 },
      afterSequence: 1,
    });
    expect(page.map((stored) => stored.sequence)).toEqual([3, 4]);
    expect(page.map((stored) => reportItemOf(stored.event).has)).toEqual([false, false]);
    const head = store.listEvents("r1", { types: ["report"], reportItems: { limit: 3 }, limit: 1 });
    expect(head.map((stored) => reportItemOf(stored.event))).toEqual([{ has: true, item: 1 }]);
  });
}
