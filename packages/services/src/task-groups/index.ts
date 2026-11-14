// 【定位】task-groups 门面：仓储 TaskGroupRepository 持全部 SQL，本文件只做入参校验、
// 跨表事实解析与「写入后通知」编排，不缓存任何组状态。
// INV-01：hostId 必须等于 workspaceIdentity 反推的主机（taskSchema.refine），否则同一
//   路径的远端任务会被当成 local，读写落到错库。
// INV-02：move/admit 只接受未删除任务，漏检会把已删/已归档任务挂回组里，组树出现幽灵节点。
// INV-03：afterChange 仅在写入生效后调用；多调放大刷新，少调让 UI 读到陈旧列表。
import { z } from "zod";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import type { GroupTaskFact, GroupTaskRef, ITaskGroupService } from "#src/task-groups/contract.js";
import { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { TaskGroupRepository, groupTaskKey } from "#src/task-groups/repository.js";
export { ITaskGroupService } from "#src/task-groups/contract.js";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  GroupTaskFact,
} from "#src/task-groups/contract.js";

// 三元组 hostId + workspacePath + taskId 是仓储定位行的键；identity 只用于反推 host。
// [失败路径] strict() 与 refine 双重收口：未知字段报错而非忽略，identity/host 不一致
// 直接拒绝，避免 resolveTasks 返回错主机的事实；identity 可选以兼容只有路径的旧数据。
const taskSchema = z
  .object({
    hostId: z.string().min(1),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    taskId: z.string().min(1),
  })
  .strict()
  .refine(
    (task) =>
      (remoteHostIdFromWorkspaceIdentity(task.workspaceIdentity ?? "") ?? "local") === task.hostId,
    "task-group.host-identity-mismatch",
  );
// 组节点判别联合：group 仅 groupId，task 带完整 taskSchema。
// [权衡] 若改成可空字段二选一，anchor 的类型错误会推迟到仓储运行期才发现，
// 且仓储要重复写「group 不能带 task」的防御分支。
const nodeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("group"), groupId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("task"), task: taskSchema }).strict(),
]);
// [并发] 每次调用新建仓储与连接，不在闭包缓存 database()：SQLite 连接由调用方按
// session 持有，缓存会让已 close 的连接被复用，写入直接失败。
// [事务] 本层不开事务：save/move/ungroup/admit 自带写事务；把 afterChange 塞进
// 事务内会让 UI 在提交失败前就看到新状态。
export function createTaskGroupService(options: {
  database(): Promise<DatabaseSync>;
  resolveTasks(tasks: GroupTaskRef[]): Promise<GroupTaskFact[]>;
  afterChange(): Promise<void>;
}): ITaskGroupService {
// 惰性取库并集中 await，保证 read/changed 拿到当时最新连接；不要在模块级解析成
// 常量，否则测试无法替换成内存库。
  const repository = async () => new TaskGroupRepository(await options.database());
// [失败路径] 顺序固定：取库 → 同步写 → 通知；run 抛错则跳过 afterChange。
// 先通知后写会让订阅者读到旧数据，回滚掉 UI 的乐观更新。
// run 必须是同步函数：仓储的异步写在此时会变成未 await 的 Promise，异常被吞。
  const changed = async (run: (repo: TaskGroupRepository) => void) => {
    const repo = await repository();
    run(repo);
    await options.afterChange();
  };
  return {
    read: async () => (await repository()).read(),
// save 是 upsert：无 id 新建，有 id 只改 title/color，两者皆可省略以支持「只改颜色」。
// title 先 trim 再限长 200，避免前后空格导致 UI 分组重复。
// [权衡] 不复用 contract 的 TaskGroup 校验：复用会把 createdAt 等只读字段泄漏成可写。
    async save(input) {
      const parsed = z
        .object({
          id: z.string().min(1).optional(),
          title: z.string().trim().min(1).max(200).optional(),
          color: z.enum(["gray", "red", "orange", "yellow", "green", "blue", "purple"]).optional(),
        })
        .strict()
        .parse(input);
      const result = (await repository()).save(parsed);
      await options.afterChange();
      return result;
    },
// 空串会让仓储 DELETE 命中 0 行却仍触发 afterChange，故先 min(1) 校验。
    async ungroup(id) {
      await changed((repo) => repo.ungroup(z.string().min(1).parse(id)));
    },
// move 入参固定为 node + sourceGroupId + 目标 groupId + 可选 anchor。
// [事务] 两处 node 先在仓储外校验存活性再一次性交给仓储，避免仓储反向回调宿主。
// [失败路径] facts.length !== refs.length 覆盖「引用了不存在的任务」；下方的 some
// 覆盖「存在但属于别的 workspace / 已删除 / 已归档」，两种情况都整次拒绝。
// 不做部分移动，否则 anchor 与 node 分属不同组，组树悬挂且 ungroup 无法回收。
    async move(input) {
      const parsed = z
        .object({
          node: nodeSchema,
          sourceGroupId: z.string().min(1).nullable(),
          groupId: z.string().min(1).nullable(),
          anchor: z
            .object({ node: nodeSchema, side: z.enum(["before", "after"]) })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
// 只把 task 节点拿去 resolve：group 的存在性由仓储在同一事务内校验，省一次往返。
// 结果顺序仅供计数，下面的匹配靠 groupTaskKey，不依赖下标。
      const refs = [parsed.node, parsed.anchor?.node].flatMap((node) =>
        node?.type === "task" ? [node.task] : [],
      );
// [失败路径] resolveTasks 由宿主实现，可能少返回（不可见/已删），因此不能按下标
// 一一比对，必须按 key 重新匹配；数量不等说明有引用彻底找不到。
      const facts = await options.resolveTasks(refs);
      if (
        facts.length !== refs.length ||
        refs.some(
          (ref) =>
            !facts.some(
              (task) =>
                groupTaskKey(task) === groupTaskKey(ref) &&
                task.hostId === ref.hostId &&
                task.workspacePath === ref.workspacePath &&
                !task.deleted &&
                !task.archived,
            ),
        )
      )
        throw new Error("task-group.task-unavailable");
      await changed((repo) => repo.move(parsed));
    },
// admit 是「批量登记 + 可选放置」：任务已在别处创建，这里只写组成员关系。
// tasks 上限 10000：单事务行数过多会长时间持有写锁，超出直接拒绝而不是截断。
// [事务] placement 必须与 facts 中某条完全匹配且未删除；不校验归档，因为归档任务
// 无法被创建。creationId 是仓储幂等键，用 taskId 去重会误判「重建同名任务」。
    async admit(input) {
      const parsed = z
        .object({
          tasks: z.array(taskSchema).max(10000),
          placement: z
            .object({
              task: taskSchema,
              groupId: z.string().min(1).nullable(),
              creationId: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(input);
// facts 可能短于 parsed.tasks（不可见任务），仓储按 key 匹配并跳过缺失项。
      const facts = await options.resolveTasks(parsed.tasks);
      if (
        parsed.placement &&
        !facts.some(
          (task) =>
            groupTaskKey(task) === groupTaskKey(parsed.placement!.task) &&
            task.hostId === parsed.placement!.task.hostId &&
            task.workspacePath === parsed.placement!.task.workspacePath &&
            !task.deleted,
        )
      )
        throw new Error("task-group.created-task-unavailable");
      const db = await options.database();
// total_changes() 是连接级累计值：写前快照、写后比对，区分真正落行与全部幂等跳过。
      const before = db.prepare("SELECT total_changes() AS n").get()?.n;
// [事务] admit 自带事务，facts 与 placement 要么一起生效要么一起回滚，本层无需 try/finally。
      new TaskGroupRepository(db).admit(facts, parsed.placement);
// 计数不变说明全部被幂等跳过，不广播，避免 UI 无意义刷新。
      if (db.prepare("SELECT total_changes() AS n").get()?.n !== before)
        await options.afterChange();
    },
  };
}
