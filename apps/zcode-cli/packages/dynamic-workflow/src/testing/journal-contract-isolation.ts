/**
 * 修复原因：journal-contract.ts 顶到 oxlint max-lines 上限（400 行），把存储边界隔离与按 runId 作用域的收尾用例拆到本文件；
 * 公开面仍从 journal-contract.ts 导出（`runJournalStoreContract` 按原顺序调用各主题的注册函数）。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe——套件的分组与用例顺序必须与拆分前逐字相同。
 */

import { expect, it } from "vitest";
import type { JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

// 注册"存储边界隔离"与"按 runId 作用域"两条契约用例（不另开 describe，保持分组与顺序
// 与拆分前逐字相同）。口径：putNode 之后调用方继续改自己的对象，读回值必须仍是写入时的
// 快照（嵌套对象也要隔离，实现需深拷贝）；所有读写按 runId 分区，跨 run 读不得串数据，
// 不存在的记录返回 undefined 而不是抛错。factory 每次须返回全新空 store，用例间不共享。
// 无返回值、无持久化副作用；失败由 vitest 的 expect 直接归因。
export function registerIsolationCases(factory: () => JournalStorePort): void {
  it("isolates stored records from later mutation of the caller's object", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "abc",
      status: "completed",
      result: { nested: { value: 1 } },
    };
    store.putNode(node);
    // 改动调用方持有的对象不应影响已存记录（存储边界隔离）。
    (node.result as { nested: { value: number } }).nested.value = 999;
    const stored = store.getNode("r1", "ask#1", 1);
    expect(stored).toBeDefined();
    const result = stored!.result as { nested: { value: number } };
    expect(result.nested.value).toBe(1);
  });

  it("scopes records per runId", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.createRun(baseRun("r2"));
    store.putNode({
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "completed",
    });
    expect(store.listNodes("r1", { kinds: "all", withResult: true })).toHaveLength(1);
    expect(store.listNodes("r2", { kinds: "all", withResult: true })).toHaveLength(0);
    expect(store.getNode("r2", "ask#1", 1)).toBeUndefined();
  });
}
