// 任务事实层：把 CLI/session 索引投影进本地任务库，是任务列表的唯一写入路径。
// INV-01：同一 (workspace 身份, taskId) 任一时刻只有一个有效刷新代际；旧代际的结果
//         既不落库也不通知（守住：refreshes 的 Symbol 引用比较）。
// INV-02：每个 await 之后都必须重新校验 current()/stillCurrent()，否则切换工作区后
//         旧事实会被写到新目标上（守住：mirror 与 reconcile 里的每处校验）。
// INV-03：标题归属、状态继承、删除优先级只在 store.applyCliFacts 内裁决，本文件只搬运。
// INV-04：changed 只在 title/updatedAt/status/deleted 实际变化且落库成功后触发。
// INV-05：handoffPending 低两位是跨进程交接位，只能由 source.execute 的确认回执清除。
import {
  generateTraceId,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { SessionsIndexReconcileResult } from "@zcode/shared/zcode-protocol-v4";
import type {
  TaskFactChange,
  TaskFactSource,
  TaskFactStore,
  TaskFactsContract,
  TaskWorkspace,
  TaskFactTarget,
} from "#src/task-facts/contract.js";
export type {
  TaskFactsContract,
  TaskFactStore,
  TaskFactSource,
  TaskFactTarget,
  TaskFactMutation,
} from "#src/task-facts/contract.js";

// 工厂而非单例：每个窗口/Host 一份，store 与 source 的实例由调用方持有，
// 避免本模块变成跨窗口共享状态（共享会破坏 INV-01 的代际隔离）。
export function createTaskFacts(options: {
  store: TaskFactStore;
  source: TaskFactSource;
  changed(change: TaskFactChange): void;
}): TaskFactsContract {
  const { store, source, changed } = options;
  // 仅保留在途请求的代际，不缓存会话状态。新帧到达即撤销旧请求的落库资格。
// [并发] refreshes 只保存写入资格令牌，不保存进度：代际被替换即表示新帧已到达，
// 旧请求即使读到旧索引也必须放弃，防止迟到快照覆盖新事实。
  const refreshes = new Map<string, symbol>();
  const key = (target: TaskFactTarget) =>
// [权衡] 用 JSON 数组编码而不是拼接字符串：路径里可能含冒号或斜杠，
// 拼接键会产生别名冲突（两个任务映射到同一代际槽位，互相撤销资格）。
    JSON.stringify([resolveWorkspaceKey(target), target.taskId]);
  const mirror = async (
    target: TaskWorkspace,
    result: SessionsIndexReconcileResult,
    current: () => boolean,
    publish = true,
// 逐条投影：store 每次写入自带幂等键，部分失败不会污染后续条目；每轮先校验 current()，
// 中途放弃只留下半批已写入事实，下一轮 reconcile 补齐——这比写错工作区便宜（INV-02）。
  ) => {
    for (const fact of result.sessions) {
      if (!current()) return;
      const task = {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        taskId: fact.sessionId,
      };
// [失败路径] 索引里不存在不等于应立即删除（CLI 可能只是暂时读不到磁盘）：
// 标记 orphan 保留行数据，等确认 deleted 才真正清库，避免误删可恢复任务。
      if (!fact.exists) {
        await store.markCliOrphan(task);
        continue;
      }
// [权衡] refresh 路径（publish=false）不读旧值：它不负责通知，多一次读只会放大锁竞争。
      const before = publish ? await store.getTaskMeta(task) : null;
      if (!current()) return;
// 派生字段在这里重算而不是从 before 继承：traceId 由 sessionId 决定（可重放），
// mode/provider 是本地常量，时间戳以 CLI 事实为准——本地时钟只代表写入时刻。
      const meta = await store.applyCliFacts({
        meta: {
          ...task,
          traceId: generateTraceId(fact.sessionId),
          title: fact.title,
          createdAt: fact.createdAt,
          updatedAt: fact.updatedAt,
          mode: "default",
          provider: ZCODE_AGENT_PROVIDER,
        },
// titleSource/lastOutcome/deleted 原样下传：归属与删除优先级由 store 统一裁决，在此判断会形成第二套真相。
        titleSource: fact.titleSource,
        lastOutcome: fact.lastOutcome,
        deleted: fact.deleted,
      });
// 变更判定只比较 title/updatedAt/status 三个可观察字段（外加 deleted）：
// 反向同步只关心这些；比较整个 meta 会因 traceId 等派生字段抖动而误报。
      if (
        publish &&
        current() &&
        (fact.deleted ||
          !before ||
          before.title !== meta.title ||
          before.updatedAt !== meta.updatedAt ||
          before.status !== meta.status)
      )
        changed({
          target: task,
          meta,
// 删除优先于改名：一条事实同时 deleted 且标题变化时，UI 应移除行而不是刷新标题。
          reason: fact.deleted ? "task_deleted" : "task_title_changed",
        });
    }
  };
  const port: TaskFactsContract = {
// ingest 来自 CLI 实时帧，是最高优先级事实源：先作废旧代际，保证随后落库的
// 一定是这帧，而不是更早 reconcile 迟到的结果（INV-01）。
    async ingest(target, summary) {
      refreshes.delete(key({ ...target, taskId: summary.sessionId }));
      const lastOutcome = summary.lastOutcome;
// 摘要到元数据的显式映射：sessionId 改名为 taskId（存储层主键），可选字段用条件展开。
      const meta: ZCodeTaskMeta = {
        taskId: summary.sessionId,
        traceId: generateTraceId(summary.sessionId),
        title: summary.title,
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        createdAt: summary.createdAt,
        updatedAt: summary.lastActivityAt,
        mode: "default",
        provider: ZCODE_AGENT_PROVIDER,
        ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
// [权衡] lastOutcome 缺省时不写 status，交由 store 保留原状态：默认 completed 会洗白正在失败的任务。
        ...(lastOutcome ? { status: lastOutcome === "error" ? "error" : "completed" } : {}),
      };
      return store.applyCliFacts({ meta, titleSource: summary.titleSource, lastOutcome });
    },
// 显式删除同样先撤销代际，防止在途 reconcile 把刚删的行写回来；
// 通知必须在 applyCliDeletion 成功后发，否则 UI 会先移除再复现（INV-04）。
    async removed(target) {
      refreshes.delete(key(target));
      await store.applyCliDeletion(target);
      changed({ target, reason: "task_deleted" });
    },
// refresh 是重读单任务：写代际、核对、投影、回读。回读而不是直接返回投影结果，
// 是因为 store 可能做了合并（标题归属/状态继承），只有回读才是真值。
    async refresh(target) {
      const id = key(target);
// Symbol 作代际令牌：每次调用新分配、永不相等，省去计数器与溢出处理，比较即引用相等。
      const generation = Symbol();
      refreshes.set(id, generation);
      try {
// [并发] reconcile 是异步 IO，期间可能有更新帧替换 refreshes；
// 所以下面投影时以是否仍是本代际为判据，而不是相信这次 result。
        const result = await source.reconcile(target, [target.taskId]);
        await mirror(target, result, () => refreshes.get(id) === generation, false);
        return await store.getTaskMeta(target);
      } finally {
// [资源] 只清理自己那一代：若已被更新调用覆盖，删除会抹掉对方的令牌，
// 使其后续投影永久判定为过期（槽位泄漏且静默不再更新）。
        if (refreshes.get(id) === generation) refreshes.delete(id);
      }
    },
// [事务] 写操作先执行源命令、再 refresh 回读：源是唯一事实；写成功但读失败时
// 返回旧值也比返回乐观构造的新值安全——后者会与源分叉且无法自愈。
    async mutate(target, intent) {
      await source.execute(target, intent);
      const meta = await port.refresh(target);
      changed({
        target,
        ...(meta ? { meta } : {}),
        reason: intent.type === "delete" ? "task_deleted" : "task_title_changed",
      });
      return meta;
    },
// reconcile 是启动/重连时的对账入口：presentSessionIds 是确实存在的集合，
// 只对缺席或有交接标记的行逐条核对，避免全量调用让大工作区卡住启动。
    async reconcile(target, presentSessionIds, stillCurrent) {
      const rows = (await store.listReconciliationRows(target)).filter(
// [事务] handoffPending 低两位是交接位（1=待删、2=待改名）：位未清即上次交接未确认，必须重核。
        (row) => !presentSessionIds.has(row.meta.taskId) || (row.handoffPending & 3) !== 0,
      );
// [权衡] 每批 256：单次 reconcile 的载荷与 CLI 侧内存都可控；批间重新校验
// stillCurrent，窗口切换时能在 256 条内退出，而不是跑完整个工作区。
      for (let offset = 0; offset < rows.length && stillCurrent(); offset += 256) {
        const batch = rows.slice(offset, offset + 256);
        let result = await source.reconcile(
          target,
          batch.map((row) => row.meta.taskId),
        );
        if (!stillCurrent()) return;
        const changedIds: string[] = [];
        for (const fact of result.sessions) {
          if (!stillCurrent()) return;
// 已消失或已删除的事实不参与交接：对它执行 delete/rename 只会制造无主写入。
          if (!fact.exists || fact.deleted) continue;
// [失败路径] 非空断言成立：id 列表就来自 batch，查不到只可能是 store 在两次调用间删了行。
          const pending = batch.find((row) => row.meta.taskId === fact.sessionId)!;
// 复查位图：result 可能来自更早快照，期间交接位已被清掉；此时再执行会重放已完成的删除/改名。
          if ((pending.handoffPending & 3) === 0) continue;
// 位 1 表示待删除，否则按待改名处理：两者互斥由写入方保证，这里只按位读取，不看时间戳。
          await source.execute(
            { ...target, taskId: fact.sessionId },
            (pending.handoffPending & 1) !== 0
              ? { type: "delete" }
              : { type: "rename", title: pending.meta.title },
          );
          changedIds.push(fact.sessionId);
        }
// [事务] 交接成功后必须二次核对：execute 改的是 CLI 侧事实，只有重新 reconcile
// 才能拿到已确认的标题与时间；直接复用旧 result 会把交接前快照再投影一次。
        if (changedIds.length && stillCurrent()) {
          const confirmed = await source.reconcile(target, changedIds);
          result = {
            sessions: [
              ...result.sessions.filter((fact) => !changedIds.includes(fact.sessionId)),
              ...confirmed.sessions,
            ],
          };
        }
// 投影放在本轮末尾：前面所有 await 都可能被取消，这样取消只会落在零写或整批写之后。
        await mirror(target, result, stillCurrent);
      }
    },
  };
  return port;
}
