// 任务组仓储：在旧表上维护「分组树 + 成员归属 + 顶层排序」三份互相约束的事实。
// 三张表没有外键，一致性完全由本文件的写入顺序保证；任何绕过 repository 的 UPDATE 都会造成幽灵成员或重复排序。
//
// INV-01：一个 task 最多属于一个 group（守住：moveInside 的 parent 校验 + 先 DELETE 后 INSERT）。
//   破坏后果：同一任务出现在两个分组下，children 计算出的顶层节点与实际列表不一致。
// INV-02：顶层 order 表只记录未入组节点；入组后由 task_group_members.sort_order 接管（守住：children(null) 的 filter）。
//   破坏后果：同一节点同时存在于两处排序，拖动一次后位置随机跳变。
// INV-03：分组节点必须是空壳，禁止把 group 放进 group（守住：moveInside 对 node.type==='group' 的 groupId 校验）。
//   破坏后果：递归 children 无法收敛，删除父组时子组成员变成孤儿。
// INV-04：user_organized=1 是「用户已表态」的墓碑，任何自动入组都不得覆盖（守住：markOrganized 与 admit 的 user_organized 分支）。
//   破坏后果：每次启动都把用户移出分组的任务重新塞回去。
// INV-05：所有多表写入必须在同一事务内完成，且事务内没有 await（守住：transaction 的 own 判定）。
//   破坏后果：中途失败留下成员已搬、排序未写的状态，下一次拖动基于错误顺序继续写。
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  resolveWorkspaceKey,
} from "@zcode/shared";
import type {
  GroupNode,
  GroupTaskFact,
  GroupTaskRef,
  ITaskGroupService,
  MoveGroupNode,
  TaskGroup,
  TaskGroupStructure,
} from "#src/task-groups/contract.js";

// 排序节点的统一形态：type 决定 key 的解释方式，混用会让 findIndex 比较到不同命名空间的字符串。
// task 的 key 是 JSON 数组（workspaceKey,taskId），group 的 key 是原始 groupId，两者不可能相等。
type OrderedNode = { type: "task" | "group"; key: string };
type Admission = { system_kind: string | null; user_organized: number; creation_id: string | null };
// 任务身份的唯一定义点：workspaceIdentity 优先于 workspacePath（见根规则），改名/搬目录不应产生新 key。
// 导出给上层做 placement 匹配，保证「同一任务」在跨模块比较时口径一致。
export function groupTaskKey(
  task: Pick<GroupTaskRef, "workspacePath" | "workspaceIdentity" | "taskId">,
) {
// [权衡] 用 JSON 数组而不是 `${a}:${b}` 拼接：路径里可能含冒号（Windows 盘符、URL），拼接会撞 key，
// 而 JSON 的引号与转义保证了单射。
  return JSON.stringify([resolveWorkspaceKey(task), task.taskId]);
}
function nodeKey(node: GroupNode): OrderedNode {
  return node.type === "group"
    ? { type: "group", key: node.groupId }
    : { type: "task", key: groupTaskKey(node.task) };
}
// 比较必须同时看 type 与 key：只比 key 会让 groupId 恰好等于任务 key 的极端情况互相误判。
function equalNode(a: OrderedNode, b: OrderedNode) {
  return a.type === b.type && a.key === b.key;
}

/** 复用旧表的控制端组织仓库；同步 SQLite 事务内没有 await，不跨进程改写任务事实。 */
// 复用同一个 DatabaseSync 连接：SQLite 的 isTransaction 只有同连接可见，换连接会丢失嵌套事务语义。
// read 与写方法都接受被外层事务包裹，因此这里的事务实现负责判断「是否已有事务」。
export class TaskGroupRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}
// [事务] 可重入写事务：只有最外层才 BEGIN/COMMIT，内层直接复用外层事务。
// 这样 admit 里调用 moveInside 不会重复取写锁，也保证「入组 + 排序」对外是一个原子步。
  private transaction<T>(run: () => T): T {
    const own = !this.db.isTransaction;
// own 由 isTransaction 推导而非由调用方声明：调用方忘记包事务时也能得到原子性，不需要额外约定。
    if (own) this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      if (own) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
// 一次读回三张表并各自排序：分组按 created_at、成员按 sort_order、顶层节点按 sort_order。
// 调用方（children/move）依赖这些顺序，SQL 里去掉任一 ORDER BY 都会让拖动结果变得不确定。
  read(): TaskGroupStructure {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    try {
      const result = {
        groups: this.db
          .prepare(
            "SELECT group_id AS id,title,coalesce(color,'gray') AS color,created_at AS createdAt,updated_at AS updatedAt FROM task_groups ORDER BY created_at,group_id",
          )
          .all() as unknown as TaskGroup[],
        members: this.db
          .prepare(
// [权衡] sort_order 为空时用 -added_at 顶替：旧版本只写 added_at，取负让「后加入的任务排在前面」，
// 与新建分组时插入顶部的行为一致，避免升级后列表整体倒序。
            "SELECT group_id AS groupId,workspace_key AS workspaceKey,task_id AS taskId,coalesce(sort_order,-added_at) AS sortOrder FROM task_group_members ORDER BY sortOrder,workspace_key,task_id",
          )
          .all() as unknown as TaskGroupStructure["members"],
        order: this.db
          .prepare(
            "SELECT node_type AS type,node_key AS key,sort_order AS sortOrder FROM task_group_view_node_orders ORDER BY sort_order,node_type,node_key",
          )
          .all() as unknown as TaskGroupStructure["order"],
      };
      if (own) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
// 存在性检查不缓存：分组可能被另一窗口删除，缓存会让后续 INSERT 命中已消失的 group_id，
// 留下无主成员行（三张表之间没有外键兜底）。
  private hasGroup(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM task_groups WHERE group_id=?").get(id));
  }
// 归属查询走 (workspace_key,task_id) 唯一键：用 taskId 单独查会跨工作区误命中同名任务。
  private parent(task: GroupTaskRef): string | null {
    return (
      (this.db
        .prepare("SELECT group_id FROM task_group_members WHERE workspace_key=? AND task_id=?")
        .get(resolveWorkspaceKey(task), task.taskId)?.group_id as string | undefined) ?? null
    );
  }
// children 有两种语义：传 groupId 返回组内成员（按成员排序），传 null 返回顶层节点（按 order 表）。
// 两者共用同一个返回类型，但数据源不同；混用会读到另一套排序，表现为拖动后顺序不变。
  private children(groupId: string | null): OrderedNode[] {
// 每次都整份重读而不是增量查询：children 需要同时看三张表才能判断「哪些节点属于顶层」，
// 增量查询会漏掉刚被其它路径搬走的成员。
    const structure = this.read();
// 组内成员按 (workspaceKey,taskId) 重新拼 key 而不是直接用列：key 的编码必须与 groupTaskKey 完全一致，
// 否则 move 传进来的节点永远匹配不上 children 返回的节点。
    if (groupId)
      return structure.members
        .filter((member) => member.groupId === groupId)
        .map((member) => ({
          type: "task",
          key: JSON.stringify([member.workspaceKey, member.taskId]),
        }));
// 顶层只保留未入组的 task：order 表里可能残留已入组节点（历史迁移或删除失败），必须用成员表过滤掉。
    const members = new Set(
      structure.members.map((member) => JSON.stringify([member.workspaceKey, member.taskId])),
    );
// order 表可能残留已删除分组的行：用现存分组集合过滤，避免顶层出现点不开的幽灵分组。
    const groups = new Set(structure.groups.map((group) => group.id));
// [权衡] 这里不清理残留 order 行，只过滤：读路径必须保持只读，否则 render 期就会产生写放大。
    const nodes = structure.order.filter((node) =>
      node.type === "group" ? groups.has(node.key) : !members.has(node.key),
    );
// 已在 order 表里的分组要做一次去重登记，下面只追加「从未写过顺序」的分组。
// [权衡] 追加而非插空：新分组放在末尾可预测，若按 created_at 插到中间，用户会看到列表位置跳变。
    const ordered = new Set(nodes.filter((node) => node.type === "group").map((node) => node.key));
    return [
      ...nodes,
      ...structure.groups
        .filter((group) => !ordered.has(group.id))
        .map((group) => ({ type: "group" as const, key: group.id })),
    ];
  }
// 落排序的唯一入口：入组写 members.sort_order，顶层写 order 表，两条路径互斥。
// 调用方必须传入完整的目标序列，这里不删除未出现的行，残留行由 children 的过滤逻辑兜住。
  private writeOrder(nodes: OrderedNode[], groupId: string | null) {
    const now = this.now();
    nodes.forEach((node, position) => {
      if (groupId) {
        const [workspaceKey, taskId] = JSON.parse(node.key) as [string, string];
        this.db
          .prepare(
// 按三元组精确更新：只按 workspace_key 会一次改到同工作区其它任务，排序整体错乱；
// updated_at 与 sort_order 同步写，方便排查「顺序变了但时间没变」的历史残留。
            "UPDATE task_group_members SET sort_order=?,updated_at=? WHERE group_id=? AND workspace_key=? AND task_id=?",
          )
          .run(position, now, groupId, workspaceKey, taskId);
      } else {
        this.db
          .prepare(`INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at)
          VALUES(?,?,?,?,?) ON CONFLICT(node_type,node_key) DO UPDATE SET sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
          .run(node.type, node.key, position, now, now);
      }
    });
  }
// 新建与改名共用一条路径：有 id 就是更新，无 id 才随机生成。
// createdAt 只在新建时取 now，更新时保留原值，否则列表会因编辑标题而重排。
  save(input: { id?: string; title?: string; color?: TaskGroup["color"] }): TaskGroup {
    return this.transaction(() => {
      const previous = input.id
        ? this.read().groups.find((group) => group.id === input.id)
        : undefined;
// [失败路径] 带 id 却查不到视为已被并发删除：静默 INSERT 会复活用户刚删掉的分组。
      if (input.id && !previous) throw new Error("task-group.not-found");
// 字段全部走「新值 ?? 旧值 ?? 默认值」三级回退：改名请求可能只带 title，
// 若缺省字段取默认值而不是旧值，颜色与创建时间会被悄悄重置。
      const group: TaskGroup = {
        id: previous?.id ?? randomUUID(),
        title: input.title?.trim() ?? previous?.title ?? "New group",
        color: input.color ?? previous?.color ?? "gray",
        createdAt: previous?.createdAt ?? this.now(),
        updatedAt: this.now(),
      };
// [失败路径] 空白标题在写库前拒绝：空标题分组无法在 UI 上被点击/重命名，只能靠手工改库修复。
      if (!group.title) throw new Error("task-group.title-required");
      this.db
        .prepare(`INSERT INTO task_groups(group_id,title,color,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(group_id) DO UPDATE SET title=excluded.title,color=excluded.color,updated_at=excluded.updated_at`)
        .run(group.id, group.title, group.color, group.createdAt, group.updatedAt);
// 只有新建才写顶层顺序：已有分组的顺序是用户资产，保存标题不应改动它。
      if (!previous)
        this.writeOrder(
          [
            { type: "group", key: group.id },
            ...this.children(null).filter((node) => node.key !== group.id),
          ],
          null,
        );
      return group;
    });
  }
// 解散分组要把成员原地提升到顶层，而不是简单删除成员行：成员行是唯一归属记录，删了就丢组织信息。
// 同时把这些任务标记为 user_organized，防止下次 admit 又自动塞回系统分组。
  ungroup(id: string): void {
    this.transaction(() => {
      if (!this.hasGroup(id)) return;
// 先取出组内当前顺序：提升到顶层时要保持相对次序，直接按成员表主键顺序会打乱用户排列。
      const members = this.children(id);
      const root = this.children(null).flatMap((node) =>
        node.type === "group" && node.key === id ? members : [node],
      );
// 每个被提升的成员都要落墓碑：否则下次 admit 发现它们不在任何组内，会按系统类型重新归入默认组。
      for (const member of members) {
        const [workspaceKey, taskId] = JSON.parse(member.key) as [string, string];
        this.markOrganized(workspaceKey, taskId);
      }
// 解散时先搬后删：root 序列已经包含被提升的成员，此时删除成员行不会改变它们的顶层位置。
      this.db.prepare("DELETE FROM task_group_members WHERE group_id=?").run(id);
// [事务] 成员行先删、分组行后删：反序会让 children 短暂读到有分组无成员的中间态。
      this.db.prepare("DELETE FROM task_groups WHERE group_id=?").run(id);
      this.db
        .prepare("DELETE FROM task_group_view_node_orders WHERE node_type='group' AND node_key=?")
        .run(id);
      this.writeOrder(root, null);
    });
  }
// 墓碑写入点：INSERT ... ON CONFLICT 而非 UPDATE，任务从未被登记过时也能建立 user_organized=1。
// 这里是 INV-04 的唯一合法提升路径（另一处是 admit 的 legacy 判定）。
  private markOrganized(workspaceKey: string, taskId: string) {
    this.db
      .prepare(`INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,1)
      ON CONFLICT(workspace_key,task_id) DO UPDATE SET user_organized=1`)
      .run(workspaceKey, taskId);
  }
// 用户拖动一律 manual=true：即使目标与当前相同也要标记已整理，避免自动归属覆盖用户的显式选择。
  move(input: MoveGroupNode): void {
    this.transaction(() => this.moveInside(input, true));
  }
// 移动的全部前置校验都在写入之前完成（来源组、目标组、锚点），失败时事务尚未产生任何写。
// [事务] 校验与落库同事务：并发拖动时 source/anchor 的陈旧判断不会因两次提交而失效。
  private moveInside(input: MoveGroupNode, manual: boolean) {
    const node = nodeKey(input.node);
    const parent = input.node.type === "task" ? this.parent(input.node.task) : null;
// [并发] 用数据库里的当前归属校验客户端声称的来源：两端并发拖动同一任务时，后到者必须失败，
// 否则会基于旧位置计算锚点，把节点插到错误下标。
    if (parent !== input.sourceGroupId) throw new Error("task-group.stale-source");
// [权衡] 只允许分组留在顶层：禁止嵌套让 children 永远只有一层，删除/排序都不需要递归；
// 若放开嵌套，ungroup 必须自底向上重排整棵子树。
    if (input.node.type === "group" && (input.groupId || !this.hasGroup(input.node.groupId)))
      throw new Error("task-group.invalid-group");
// [并发] 目标组在拖动过程中可能被删除：这里重新校验，避免把成员写进已消失的分组。
    if (input.groupId && !this.hasGroup(input.groupId)) throw new Error("task-group.not-found");
    const destination = this.children(input.groupId).filter(
      (candidate) => !equalNode(candidate, node),
    );
// 锚点用 nodeKey 归一后再比较：客户端传来的锚点可能是任务也可能是分组，直接比 key 会跨类型误匹配。
    const anchor = input.anchor && nodeKey(input.anchor.node);
    const index = anchor ? destination.findIndex((candidate) => equalNode(candidate, anchor)) : 0;
// 锚点找不到说明目标列表已变化：失败比猜测位置安全，否则任务会跳到列表头部。
    if (index < 0) throw new Error("task-group.stale-anchor");
// 锚点下标在移除自身之后计算：先删除再 splice 会让「拖到自己后面」的 index 偏移一位。
// [权衡] 不支持 after 之外的取值：未知 side 按 before 处理，宁可少移一位也不抛错中断拖动。
    destination.splice(index + (input.anchor?.side === "after" ? 1 : 0), 0, node);
// 分组节点没有成员行，只有任务需要改归属；对分组执行成员写入会把 groupId 当成 taskId 存进表。
    if (input.node.type === "task") {
      const task = input.node.task;
      const workspaceKey = resolveWorkspaceKey(task);
      if (manual) this.markOrganized(workspaceKey, task.taskId);
      this.db
        .prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey, task.taskId);
// 插入时 sort_order 先写 0，真正的顺序由紧随其后的 writeOrder 覆盖：若在这里算位置，
// 需要先读一次目标组全部成员，与后续写序重复且更容易漏算。
      if (input.groupId) {
        const now = this.now();
        this.db
          .prepare(`INSERT INTO task_group_members(group_id,workspace_key,workspace_path,workspace_identity,task_id,sort_order,added_at,created_at,updated_at)
          VALUES(?,?,?,?,?,0,?,?,?)`)
          .run(
            input.groupId,
            workspaceKey,
            task.workspacePath,
            task.workspaceIdentity ?? null,
            task.taskId,
            now,
            now,
            now,
          );
      }
    }
// 排序写在归属变更之后：writeOrder 对成员的 UPDATE 依赖新行已存在，反序会更新 0 行而静默丢序。
    this.writeOrder(destination, input.groupId);
  }
// admit 是「任务事实 → 分组结构」的唯一入口：只做首次登记与首次归类，之后的列表刷新不得重排。
// 该约束让读路径保持幂等，否则每次拉取任务列表都会改写排序，用户拖动结果无法保留。
  admit(
    tasks: GroupTaskFact[],
    placement?: Parameters<ITaskGroupService["admit"]>[0]["placement"],
  ): void {
    this.transaction(() => {
      // 批量首次发现按创建时间从旧到新写入顶部；以后活动更新不重排已登记节点。
// 排序只影响本批次的插入顺序：旧的先写、新的后写，配合 order 取 min-1 让最新任务落在最顶部。
      for (const task of [...tasks].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
// 与 groupTaskKey 共用同一套 key 解析：若这里改用 workspacePath，搬目录后旧成员行将永远删不掉。
        const workspaceKey = resolveWorkspaceKey(task),
          key = groupTaskKey(task);
// [失败路径] 删除事件可能早于创建事件到达：先清成员与顺序，再写墓碑，保证任何到达顺序都收敛到「已删除」。
        if (task.deleted) {
          this.db
            .prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?")
            .run(workspaceKey, task.taskId);
          this.db
            .prepare(
              "DELETE FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
            )
            .run(key);
          // 删除事实可能晚到；保留登记墓碑，后续缺少 deleted 的投影不能重新入组。
// 墓碑同时承担去重：同 key 的删除事件重复到达时，第二次只会覆盖 user_organized=1，不会重复建行。
          this.markOrganized(workspaceKey, task.taskId);
          continue;
        }
        let admission = this.db
          .prepare("SELECT * FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
          .get(workspaceKey, task.taskId) as unknown as Admission | undefined;
// 只有从未登记过的任务才需要推断 legacy 归属：已有登记行代表历史决策，一律以库里为准。
        if (!admission) {
// 首次登记时判断是否为历史数据：已在分组内或已有顶层顺序的任务视为用户已整理，不能当新任务自动归类。
          const legacy =
            this.parent(task) !== null ||
            Boolean(
              this.db
                .prepare(
                  "SELECT 1 FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
                )
                .get(key),
            );
          this.db
            .prepare(
              "INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,?)",
            )
            .run(workspaceKey, task.taskId, legacy ? 1 : 0);
// 内存里的 admission 必须与刚写入的行一致：下面还要读 system_kind/creation_id，重新查询会多一次往返。
          admission = { system_kind: null, creation_id: null, user_organized: legacy ? 1 : 0 };
          if (!legacy) {
            // 首次发现只写一个顶层位置，避免大库启动时逐条重排造成平方级写放大。
// 取当前最小 order 再减一：一次 SELECT min 即可完成，代价与任务数线性相关。
            const order = Number(
              this.db
                .prepare(
                  "SELECT coalesce(min(sort_order),0)-1 AS n FROM task_group_view_node_orders",
                )
                .get()?.n,
            );
            const now = this.now();
            this.db
              .prepare(
                "INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at) VALUES('task',?,?,?,?)",
              )
              .run(key, order, now, now);
          }
        }
// 系统任务类型由事实字段推导，不信任投影里的标记：投影可能来自旧版本或遗漏字段。
// cron 优先于 off-peak：两者同时存在时按定时任务归类，避免同一任务在两个默认组之间摇摆。
        const systemKind = task.cronAutomationId ? "cron" : task.offPeakTaskId ? "off-peak" : null;
// 只在 system_kind 从 null 变为具体值时入组：这保证自动归类每个任务最多发生一次，
// 用户随后把它移出默认组也不会被下一次 admit 拉回。
        if (systemKind && admission.system_kind === null) {
          this.db
            .prepare(
              "UPDATE task_group_admissions SET system_kind=? WHERE workspace_key=? AND task_id=?",
            )
            .run(systemKind, workspaceKey, task.taskId);
          // 首次类型确认才入组；不能把读列表变成重复覆盖用户整理的“自愈”。
          if (!admission.user_organized && !task.archived && !this.parent(task)) {
// 默认分组 id 是共享常量而非随机生成：多窗口/多次启动必须命中同一行，否则会出现两个「定时任务」组。
            const id = systemKind === "cron" ? CRON_DEFAULT_GROUP_ID : OFF_PEAK_DEFAULT_GROUP_ID;
// 默认分组按需创建：只在首次出现系统任务时建行，避免空库用户看到两个空分组。
            if (!this.hasGroup(id)) {
              const now = this.now();
              this.db
                .prepare("INSERT INTO task_groups VALUES(?,?,?,?,?)")
                .run(id, systemKind, systemKind === "cron" ? "blue" : "purple", now, now);
              this.writeOrder(
                [
                  { type: "group", key: id },
                  ...this.children(null).filter((node) => node.key !== id),
                ],
                null,
              );
            }
            this.moveInside(
              { node: { type: "task", task }, sourceGroupId: null, groupId: id },
              false,
            );
          }
        }
// placement 只对本次新建的那个任务生效：用 key 精确匹配，防止把同批次其它任务的放置意图套错。
// creation_id 保证放置只消费一次，重放同一请求不会再次移动已存在的任务。
        if (placement && groupTaskKey(placement.task) === key && admission.creation_id === null) {
// [失败路径] 用户已整理过则跳过自动放置，但仍继续写 creation_id：否则同一批次会反复尝试放置。
          if (!admission.user_organized)
            this.moveInside(
              {
                node: { type: "task", task },
                sourceGroupId: this.parent(task),
                groupId:
                  placement.groupId && this.hasGroup(placement.groupId) ? placement.groupId : null,
              },
              true,
            );
          this.db
            .prepare(
              "UPDATE task_group_admissions SET creation_id=? WHERE workspace_key=? AND task_id=?",
            )
            .run(placement.creationId, workspaceKey, task.taskId);
        }
      }
    });
  }
}
