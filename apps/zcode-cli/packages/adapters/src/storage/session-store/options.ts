// ============================================================
// Session store options
// ============================================================
// 定位：sqlite session store 的构造选项与调试计数类型定义。
// 输入输出：dbPath 缺省时由调用方/工厂使用默认路径；fault 与 timeout 仅测试用。
// 副作用：无（纯类型）。
// 失败语义：非法 dbPath 在 open 阶段报错，此处不做校验。
// 不变量：forkCommitFaultAt 是事务原子性测试钩子，生产代码绝不能设置。

export type ForkCommitFaultStage =
  // fork 事务各阶段注入失败的测试点；生产环境应恒为 undefined。
  | "afterChild"
  | "afterMessages"
  | "afterGoal"
  | "afterEntries"
  | "afterInput"
  | "afterCommandFact"
  | "beforeCommit";

export interface SqliteSessionStoreOptions {
  /** SQLite 文件路径；缺省走 getDefaultSessionDbPath()。 */
  dbPath?: string;
  /** 仅供事务原子性测试；生产调用不得设置。 */
  forkCommitFaultAt?: ForkCommitFaultStage;
  /** 仅供启动锁等待边界测试；生产调用使用默认值。 */
  startupLockTimeoutMs?: number;
}

export interface SessionStoreDebugCounts {
  // 各表当前行数（只读统计，诊断/测试用，不影响业务数据）。
  sessions: number;
  messages: number;
  parts: number;
  todos: number;
  targets: number;
  sessionEntries: number;
  permissions: number;
  localSettings: number;
  schemaMigrations: number;
  inputHistory: number;
  modelUsage: number;
  toolUsage: number;
  turnUsage: number;
}
