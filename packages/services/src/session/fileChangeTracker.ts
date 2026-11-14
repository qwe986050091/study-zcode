/**
 * Session 文件变更追踪器
 *
 * 记录 agent runtime 文件写入产生的 before/after 内容。
 * 同一文件在同一轮中被多次修改时，只保留首次 before 和最末 after（合并首尾）。
 *
 * 用途：
 * - Rewind：回滚到某一轮时，逆序还原 beforeContent
 * - 汇聚：获取整个 session 所有文件操作的最终结果
 */

// ---- 类型定义 ----

/** 单个文件在一轮中的变更快照（合并首尾） */
interface FileSnapshot {
  path: string;
  /** 该轮首次修改前的文件内容，null 表示新文件 */
  beforeContent: string | null;
  /** 该轮最后一次写入的内容 */
  afterContent: string;
  /** 该轮内被写入的次数 */
  writeCount: number;
}

/** 一轮对话的文件变更 */
interface TurnFileChanges {
  turnIndex: number;
  /** 该轮涉及的文件快照，key = path */
  snapshots: Map<string, FileSnapshot>;
  /** 该轮文件变更当前是否已应用在 workspace */
  fileState: "applied" | "reverted";
}

/** 可序列化的文件快照（用于持久化） */
interface SerializedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
}

/** 可序列化的轮次文件变更（用于持久化） */
interface SerializedTurnFileChanges {
  turnIndex: number;
  snapshots: SerializedFileSnapshot[];
  fileState?: "applied" | "reverted";
}

// ---- 追踪器 ----

export class SessionFileChangeTracker {
  private turns: TurnFileChanges[] = [];
  private currentTurnIndex = -1;

  /** 开始新一轮对话，推进 turnIndex */
  newTurn(): number {
    // 游标先自增再建记录：turnIndex 从 0 开始，与会话消息的轮次编号共用同一套口径。
    this.currentTurnIndex++;
    // push 而不是按索引赋值：turns 保持追加顺序，getRewindOperations 依赖数组顺序做倒序扫描。
    this.turns.push({
      turnIndex: this.currentTurnIndex,
      // 每个新轮次用独立 Map：同一文件跨轮出现必须分成两条记录，
      // 否则 rewind 找不到中间轮的 beforeContent，只能一步跳回会话起点。
      snapshots: new Map(),
      fileState: "applied",
    });
    return this.currentTurnIndex;
  }

  /**
   * 记录一次文件写入操作。
   * 应在 writeTextFile 执行前读取原文件内容，写入后调用此方法。
   *
   * @param path 文件路径
   * @param beforeContent 写入前的文件内容，null 表示新文件
   * @param afterContent 写入后的文件内容
   */
  record(path: string, beforeContent: string | null, afterContent: string): void {
    // 顺序约束：beforeContent 必须在实际写盘前读取。若调用方在写盘后才回调，before 会等于 after，
    // rewind 退化成空操作且不报错——回滚「成功」但文件没变，是最难发现的一类静默数据问题。
    if (this.currentTurnIndex < 0) {
      // 如果还没有 newTurn，自动创建第一轮
      // 自动补一轮是为了兼容「先写文件后开轮次」的调用顺序，
      // 缺了它 record 会写入 undefined 的 turn 并抛 TypeError。
      this.newTurn();
    }

    // 取数组末项而不是按 currentTurnIndex 查找：newTurn 永远 push 到末尾，
    // 查找失败会让记录静默丢失，取末项能保证落点正确。
    const currentTurn = this.turns[this.turns.length - 1]!;
    const existing = currentTurn.snapshots.get(path);

    if (existing) {
      // 同一文件同一轮：保留首次 before，更新 after
      // 只更新 after 与计数，beforeContent 保持首次值：首尾合并后 rewind 才能一步回到
      // 该轮开始前的状态，中间态对回滚没有意义。
      existing.afterContent = afterContent;
      existing.writeCount++;
    } else {
      currentTurn.snapshots.set(path, {
        path,
        // 首次记录必须存入调用方给的 beforeContent：写成空串会把「新文件」与「空文件」混为一谈，
        // rewind 时按 null 删文件还是按空串清空内容会得到两种结果，必须区分。
        beforeContent,
        afterContent,
        writeCount: 1,
      });
    }
  }

  /** 获取指定轮次的文件变更 */
  getChangesForTurn(turnIndex: number): FileSnapshot[] {
    const turn = this.turns.find((t) => t.turnIndex === turnIndex);
    // 找不到轮次返回空数组而不是抛错：恢复会话时可能请求已被 truncate 掉的轮次。
    if (!turn) return [];
    // 返回副本数组而不是 Map 本身：调用方遍历期间若触发 record 会修改 Map 结构。
    return Array.from(turn.snapshots.values());
  }

  /** 获取指定轮次文件状态 */
  getFileStateForTurn(turnIndex: number): "applied" | "reverted" {
    return this.turns.find((turn) => turn.turnIndex === turnIndex)?.fileState ?? "applied";
  }

  /** 更新指定轮次文件状态 */
  setFileStateForTurn(turnIndex: number, fileState: "applied" | "reverted"): void {
    const turn = this.turns.find((item) => item.turnIndex === turnIndex);
    // 未知轮次静默返回：文件状态只是 rewind 的旁路信息，
    // 抛错会让主流程因为一个已被截断的轮次而整体失败。
    if (!turn) {
      return;
    }
    // 原地改写轮次对象：turns 里保存的是引用，序列化时才能读到最新状态。
    turn.fileState = fileState;
  }

  /** 获取指定轮次之后（不含该轮）的所有文件变更，按轮次正序 */
  getChangesAfterTurn(turnIndex: number): FileSnapshot[] {
    // 跨轮聚合用一个数组：调用方按返回顺序依次应用变更，顺序即轮次顺序。
    const result: FileSnapshot[] = [];
    for (const turn of this.turns) {
      // 严格大于才收集：语义是「该轮之后」，包含当前轮会把已回滚的内容重复上报。
      if (turn.turnIndex > turnIndex) {
        // 同一文件在多轮出现会 push 多次，这里不去重是为了保留每轮的独立快照序列。
        result.push(...turn.snapshots.values());
      }
    }
    return result;
  }

  /**
   * 计算回滚到指定轮次所需的文件还原操作。
   * 返回每个文件应还原到的内容（null 表示应删除该文件）。
   * 逻辑：收集 toTurnIndex 之后所有轮次中每个文件最早的 beforeContent。
   * 如果该文件在 toTurnIndex 或之前也被修改过，则用那一轮的 afterContent。
   */
  getRewindOperations(toTurnIndex: number): Map<string, string | null> {
    // Map 的 value 允许 null：null 表示该文件在回滚范围内是新建的，还原动作应当是删除。
    const rewindOps = new Map<string, string | null>();

    // 从最新轮次往回遍历到 toTurnIndex（不含），每个文件持续覆写，
    // 最终留下的是该文件在回滚范围内最早出现的 beforeContent
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]!;
      // 倒序遍历遇到目标轮即 break：turns 按 turnIndex 升序，再往前不可能是要回滚的区间。
      if (turn.turnIndex <= toTurnIndex) break;

      for (const snapshot of turn.snapshots.values()) {
        rewindOps.set(snapshot.path, snapshot.beforeContent);
      }
    }

    // 如果文件在 toTurnIndex 或之前也被修改过，应该用那一轮的 afterContent
    for (const turn of this.turns) {
      if (turn.turnIndex > toTurnIndex) break;
      for (const snapshot of turn.snapshots.values()) {
        // 只覆盖回滚集合里已有的文件：区间没碰过的文件不该被旧内容重写，
        // 否则一次 rewind 会顺带改动用户根本没编辑过的文件。
        if (rewindOps.has(snapshot.path)) {
          rewindOps.set(snapshot.path, snapshot.afterContent);
        }
      }
    }

    return rewindOps;
  }

  /** 获取整个 session 中所有被修改过的文件及其最终内容 */
  getAllChangedFiles(): Map<string, { originalContent: string | null; finalContent: string }> {
    // key 用 path 去重，同一文件跨轮只保留一条，originalContent 会保留最早的值。
    const result = new Map<string, { originalContent: string | null; finalContent: string }>();

    // 按轮次顺序遍历：后面的 afterContent 覆盖前面的，finalContent 因此就是最终磁盘状态。
    for (const turn of this.turns) {
      for (const snapshot of turn.snapshots.values()) {
        const existing = result.get(snapshot.path);
        if (existing) {
          // 更新 finalContent，保留 originalContent
          // 后续轮次只刷新 finalContent：originalContent 已是最初内容，再写会把会话起点覆盖掉。
          existing.finalContent = snapshot.afterContent;
        } else {
          result.set(snapshot.path, {
            // 首次出现即定稿 originalContent：它来自该文件第一次被写入前的磁盘内容，
            // 之后任何轮次都拿不到比 beforeContent 更早的版本。
            originalContent: snapshot.beforeContent,
            finalContent: snapshot.afterContent,
          });
        }
      }
    }

    return result;
  }

  /** 获取当前轮次索引 */
  getCurrentTurnIndex(): number {
    return this.currentTurnIndex;
  }

  /** 对仅有消息历史、没有 fileChanges 的旧任务，补齐当前轮次游标 */
  restoreCurrentTurnIndex(turnIndex: number): void {
    if (!Number.isFinite(turnIndex)) {
      return;
    }

    // Bugfix: external import 这类历史任务往往只有 messages.turnIndex，没有 fileChanges。
    // 如果恢复时不把游标补到最后一轮，下一次 sendPrompt 会从 0 重新开始编号，
    // 让续聊消息和导入历史落到同一 turn，进一步把 fork/retry 的边界判断带歪。
    this.currentTurnIndex = Math.max(this.currentTurnIndex, Math.trunc(turnIndex));
  }

  /** 获取总轮次数 */
  getTurnCount(): number {
    return this.turns.length;
  }

  // ---- 序列化/反序列化（持久化用） ----

  /** 序列化为可 JSON 化的结构 */
  serialize(): SerializedTurnFileChanges[] {
    // 序列化保留轮次顺序与 turnIndex：恢复后 getRewindOperations 依赖升序这个假设。
    return this.turns.map((turn) => ({
      turnIndex: turn.turnIndex,
      // Map 必须转数组才能 JSON 化：直接序列化 Map 得到的是 {}，恢复后所有变更记录消失。
      snapshots: Array.from(turn.snapshots.values()),
      // fileState 一并写盘：恢复后若把已回滚的轮次当成 applied，再次 rewind 会重复还原。
      fileState: turn.fileState,
    }));
  }

  /** 从序列化数据恢复 */
  static deserialize(data: SerializedTurnFileChanges[]): SessionFileChangeTracker {
    // 走构造函数而不是 Object.create：turns 与 currentTurnIndex 的初始值必须齐全。
    // 失败后果：这里不做 schema 校验，损坏的 fileChanges 会原样进入追踪器；
    // rewind 时可能拿 undefined 当 beforeContent 写回文件，调用方必须在反序列化前自己校验。
    const tracker = new SessionFileChangeTracker();
    for (const turn of data) {
      const snapshots = new Map<string, FileSnapshot>();
      for (const s of turn.snapshots) {
        // 每条快照浅拷贝一份：序列化数据可能被调用方继续持有，共享引用会让后续修改互相污染。
        snapshots.set(s.path, { ...s });
      }
      tracker.turns.push({
        turnIndex: turn.turnIndex,
        snapshots,
        // 缺 fileState 的旧数据按 applied 处理：早期版本没有该字段，语义等价于文件已在 workspace。
        fileState: turn.fileState ?? "applied",
      });
    }
    // 游标取最后一轮的 turnIndex 而不是数组长度：轮次可能被 truncate 过，编号并不连续。
    tracker.currentTurnIndex = data.length > 0 ? data[data.length - 1]!.turnIndex : -1;
    return tracker;
  }

  /** 截断到指定轮次（含），删除之后的所有记录 */
  truncateAfterTurn(turnIndex: number): void {
    // 保留 turnIndex 不大于目标的轮次：fork 或 retry 会砍掉分叉点之后的记录，
    // 残留的轮次会让 rewind 把已丢弃分支的文件变更又算进来。
    this.turns = this.turns.filter((t) => t.turnIndex <= turnIndex);
    // 游标回退到新的末轮：不回退会让下一次 newTurn 从旧编号继续，产生编号空洞。
    // 截断只作用于内存数组：持久化副本必须由调用方在同一事务里重写，只截内存不落盘，重启后分叉记录会复活。
    this.currentTurnIndex = this.turns.length > 0 ? this.turns[this.turns.length - 1]!.turnIndex : -1;
  }
}
