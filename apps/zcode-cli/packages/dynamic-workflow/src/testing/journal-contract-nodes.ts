// INV-01 用例顺序与拆分前逐字一致：守住位置 注册函数排列；改错故障 失败定位整体偏移。
// INV-02 只登记用例不另开分组：守住位置 文件内容形态；改错故障 套件层级与旧报告不符。
// INV-03 公开面仍由原文件导出：守住位置 调用关系；改错故障 契约套件漏跑本文件。
// INV-04 存储实例按用例新建：守住位置 用例首行工厂调用；改错故障 用例之间互相污染。
// INV-05 运行前先建运行记录：守住位置 建运行调用；改错故障 外键约束先失败。
// INV-06 同键重写是覆盖：守住位置 两次写入与长度断言；改错故障 出现重复行。
// INV-07 冻结身份与宿主事实分列：守住位置 记录字段；改错故障 身份被模型选择覆盖。
// INV-08 缺席字段必须保持缺席：守住位置 整条相等断言；改错故障 升级后旧行比对全线失败。
// INV-09 节点按站点与序号取：守住位置 键参数；改错故障 读到相邻序号的行。
// INV-10 列表过滤同时覆盖种类与结果：守住位置 查询参数；改错故障 结果字段被静默丢弃。
// INV-11 结算整条替换带回输入：守住位置 展开写入；改错故障 输入在结算后消失。
// INV-12 截断输入仍原样回读：守住位置 独立记录；改错故障 截断标记丢失。
// INV-13 报告节点只写一次：守住位置 单次写入；改错故障 出现准入占位行。
// INV-14 报告节点不带执行者坐标：守住位置 字段缺席断言；改错故障 面板显示伪造归属。
// INV-15 空结果与缺席可区分：守住位置 两种记录对照；改错故障 真结果被当成未完成。
// INV-16 边界零值合法：守住位置 相等比较；改错故障 零被当成未记录。
// INV-17 回填是读改写：守住位置 先读后铺开；改错故障 其他列被清空。
// INV-18 边界用于修订截断：守住位置 契约注释与用例；改错故障 前驱失去唯一截断依据。
//
// 模块职责：节点与执行者记录的存储契约用例，从主契约文件拆出以控制单文件行数。
// 状态所有权：无状态；每个用例自建存储实例并自建运行记录。
// 阅读顺序：先看执行者用例，再看节点用例，最后看边界回填与整条替换。
/**
 * 修复原因：journal-contract.ts 顶到 oxlint max-lines 上限（400 行），把actor 记录与节点记录（ask / world / report 行、缺席键、messageBoundary 回填）的用例拆到本文件；
 * 公开面仍从 journal-contract.ts 导出（`runJournalStoreContract` 按原顺序调用各主题的注册函数）。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe——套件的分组与用例顺序必须与拆分前逐字相同。
 */

import { expect, it } from "vitest";
import type { ActorRecord, JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

// registerNodeCases() 只登记 it(...)，不新建 describe 分组。
// 用例顺序必须与拆分前逐字一致，由 runJournalStoreContract() 保证。
// 主契约入口 runJournalStoreContract() 按原顺序调用各注册函数。
// 每个用例都用 factory() 自建 store，不共享状态。
export function registerNodeCases(factory: () => JournalStorePort): void {
  it("puts, gets and lists actors keyed by (siteId, ordinal)", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "planner" });
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 2, name: "planner" });
    expect(store.getActor("r1", "actor#1", 1)?.name).toBe("planner");
    expect(store.getActor("r1", "actor#1", 3)).toBeUndefined();
    expect(store.listActors("r1", { withPersona: true })).toHaveLength(2);
    // 幂等覆盖：同键再写更新 sessionId。
    store.putActor({
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "planner",
      sessionId: "s1",
    });
    expect(store.getActor("r1", "actor#1", 1)?.sessionId).toBe("s1");
    expect(store.listActors("r1", { withPersona: true })).toHaveLength(2);
  });

  it("round-trips the frozen persona and the driver-resolved model on an actor", () => {
    // persona 是冻结身份，resolvedModel 是宿主事实（子代理实际跑在哪个模型上）。两者分列存放：
    // persona 是引擎在 createActor 时同步写下的，那一刻宿主还没造出会话、也就没有模型可记。
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ActorRecord = {
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "judge",
      persona: { name: "judge", system: "You judge." },
      sessionId: "s1",
      resolvedModel: "provider/small-model",
    };
    store.putActor(record);
    expect(store.getActor("r1", "actor#1", 1)).toEqual(record);
  });

  it("keeps an absent resolvedModel absent (not a null / undefined key)", () => {
    // 0021 之前的历史行与「宿主还没解析过」的行都走这条路径：缺席必须解成缺席的键，
    // 否则对整条记录做 toEqual 的调用方（与上一条用例）在升级后全线失败。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "judge" });
    const record = store.getActor("r1", "actor#1", 1)!;
    expect(record.resolvedModel).toBeUndefined();
    expect(record).toEqual({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "judge" });
  });

  // NodeRecord 按 (siteId, ordinal) 两字段定位。
  // getNode() 未命中时必须返回 undefined。
  // listNodes() 结果按 kinds 与 withResult 裁剪。
  it("puts, gets and lists nodes", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "abc",
      status: "completed",
      result: { ok: true },
    };
    store.putNode(node);
    expect(store.getNode("r1", "ask#1", 1)).toEqual(node);
    expect(store.getNode("r1", "ask#1", 2)).toBeUndefined();
    expect(store.listNodes("r1", { kinds: "all", withResult: true })).toHaveLength(1);
  });

  // input 与 inputHash 由同一次 putNode() 写入。
  // 结算写入的整条替换必须原样带回 input。
  // 截断 input 只保留 bounded 标记与片段。
  it("round-trips a world-read node's bounded input and keeps it absent elsewhere", () => {
    // 工作区 transcript 要说 *what ran*（docs/dynamic-workflow/transcript-and-notifications.md）：
    // `{op, args}` 与 inputHash 同一次准入写下，结算的整条替换必须原样带回；ask 行没有它，
    // 而且是**缺席的键**（不是 undefined 值），否则 toEqual 与读面的 `"input" in row` 都会说谎。
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-run",
      inputHash: "wh",
      input: { op: "run", args: ["pnpm", ["vitest", "run"], { timeoutMs: 60_000 }] },
      status: "running",
    };
    store.putNode(node);
    expect(store.getNode("r1", "world-read#1", 1)).toEqual(node);
    const settled: NodeRecord = {
      ...node,
      status: "completed",
      result: { exitCode: 1, stdout: "", stderr: "boom" },
    };
    store.putNode(settled);
    expect(store.getNode("r1", "world-read#1", 1)).toEqual(settled);
    const truncated: NodeRecord = {
      ...node,
      siteId: "world-read#2",
      input: { op: "run", args: ["node", "-e …"], truncated: true },
    };
    store.putNode(truncated);
    expect(store.getNode("r1", "world-read#2", 1)?.input).toEqual(truncated.input);
    const ask = store.getNode("r1", "ask#1", 1);
    expect(ask === undefined || !("input" in ask)).toBe(true);
  });

  it("stores a report node: one write, already completed, no actor coordinates", () => {
    // report 节点是「准入 running → 结算」两次写规则唯一的例外（准入与结算之间没有 driver
    // 调用）。落库形状因此是可断言的：单次 putNode、status 恒 completed、actor 三列缺席、
    // result 即被报告的 item。两个实现都必须原样回读，否则 Results 面板与完成通知
    // 会显示存储层的加工品。
    const store = factory();
    store.createRun(baseRun("r1"));
    const report: NodeRecord = {
      runId: "r1",
      siteId: "report#1",
      ordinal: 2,
      kind: "report",
      inputHash: "rh",
      status: "completed",
      result: { finding: "duplicate impl", paths: ["a.ts", "b.ts"] },
    };
    store.putNode(report);

    const stored = store.getNode("r1", "report#1", 2);
    expect(stored).toEqual(report);
    expect(stored !== undefined && "actorSeq" in stored).toBe(false);
    expect(stored !== undefined && "actorSiteId" in stored).toBe(false);
    expect(
      store.listNodes("r1", { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(1);
  });

  // null 结果与 undefined 空值是两件事。
  // 存储层不得把 null 与 undefined 压成同一种空。
  // 缺席的可选键必须原样缺席，不能写成 undefined。
  it("keeps a null node result distinguishable from an absent one", () => {
    // result 的类型是 unknown：`ask<T | null>` 返回的 null 是真结果，不是"还没有结果"。
    // 落库实现若把 undefined 和 null 一起压成 SQL NULL，这个区别会在 round-trip 里消失。
    const store = factory();
    store.createRun(baseRun("r1"));
    const nulled: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "completed",
      result: null,
    };
    const absent: NodeRecord = {
      runId: "r1",
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "running",
    };
    store.putNode(nulled);
    store.putNode(absent);

    expect(store.getNode("r1", "ask#1", 1)).toEqual(nulled);
    const stored = store.getNode("r1", "ask#2", 1);
    expect(stored).toEqual(absent);
    // 缺席的可选字段要原样缺席地回来（而不是变成 result: null / result: undefined）。
    expect(stored !== undefined && "result" in stored).toBe(false);
  });

  // messageBoundary 是 ask 结算后 actor 会话消息 log 的长度（count offset），driver 在
  // settle 之后补写（docs/execution-engine.md「Amend-resume」）。属于契约：
  // 它是修订续跑做全保真转录截断时唯一的截断依据，SQLite 若漏写这一列，前驱就成了
  // 「无 marker 前驱」——整个 amend 被结构化拒绝。
  it("round-trips an ask node's messageBoundary and keeps it absent when unrecorded", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const bounded: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "h1",
      status: "completed",
      result: "done",
      stats: { tokens: 120, toolCalls: 2, turns: 3 },
      messageBoundary: 9,
    };
    // 0 是合法边界（复制零条消息），必须与「没记过边界」可分辨——这正是缺席键语义
    // 在这一列上的实际用处。
    const zero: NodeRecord = {
      ...bounded,
      siteId: "ask#2",
      actorSeq: 1,
      inputHash: "h2",
      messageBoundary: 0,
    };
    const unrecorded: NodeRecord = {
      runId: "r1",
      siteId: "ask#3",
      ordinal: 1,
      kind: "ask",
      inputHash: "h3",
      status: "running",
    };
    store.putNode(bounded);
    store.putNode(zero);
    store.putNode(unrecorded);

    expect(store.getNode("r1", "ask#1", 1)).toEqual(bounded);
    expect(store.getNode("r1", "ask#2", 1)?.messageBoundary).toBe(0);
    const bare = store.getNode("r1", "ask#3", 1);
    expect(bare).toEqual(unrecorded);
    expect(bare !== undefined && "messageBoundary" in bare).toBe(false);
  });

  // driver 的补写形状：getNode 读回引擎刚落的结算行，原样铺开再补边界列。与 stats 回填
  // 同族，所以同一条风险——putNode 是整条替换，实现若在 round-trip 里丢掉任何一列
  // （result / stats / actor 三列 / inputHash），这次补写就会把它抹掉。
  it("preserves every other field when backfilling messageBoundary read-modify-write", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const settled: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 2,
      kind: "ask",
      actorSiteId: "actor#3",
      actorOrdinal: 1,
      actorSeq: 4,
      inputHash: "abc",
      status: "completed",
      result: { verdict: "ship it", notes: [1, 2, 3] },
      stats: { tokens: 512, toolCalls: 7, turns: 5 },
    };
    store.putNode(settled);

    const recorded = store.getNode("r1", "ask#1", 2)!;
    store.putNode({ ...recorded, messageBoundary: 14 });

    expect(store.getNode("r1", "ask#1", 2)).toEqual({ ...settled, messageBoundary: 14 });
  });
}
