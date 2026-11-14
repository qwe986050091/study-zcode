// 任务库 0001 基线 schema：任务索引、自动化、错峰任务三组表的建表语句原文。
// 文件内的 SQL 是 migration checksum 的组成部分，任何字符改动都会让已发布库校验失败。
// 因此本文件只允许追加注释，不允许调整缩进、换行或语句顺序。
//
// 不变量：
// - tasks 的主键是 (workspace_key, task_id)，同一任务在不同 workspace 下是不同行。
// - 所有时间列均为毫秒整数，写入方负责取整，schema 不做单位转换。
// - deleted 为软删除标记，索引一律带 WHERE deleted = 0 以保持部分索引体积。
// - 软删除后行仍保留，外键与历史记录因此不会悬空。
// - model_selection 为 JSON 文本，旧列 model/provider 仅为兼容旧读路径保留。
// - 新增列必须走 migrations.ts 的 columns 清单，不能回改这里的 CREATE TABLE。
// 阅读顺序建议：先看各表的列语义，再看 migrations.ts 的补列与索引。
// 0001 接管已有分散建表；发布后保持声明不变，后续变更新增 migration。
// 任务索引表组：任务本体、任务分组、分组成员、视图节点排序与工作区引导记录。
// 分组表与任务表之间没有强外键，删除任务不会级联清理分组成员，由业务层负责。
// 两个部分索引分别服务“已归档列表”和“置顶列表”，排序键固定为 updated_at 降序。
// task_group_members 的主键与 tasks 一致，保证一个任务最多属于一个分组。
export const TASK_INDEX_SCHEMA = `
      CREATE TABLE IF NOT EXISTS tasks (
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        task_status TEXT,
        provider TEXT,
        mode TEXT NOT NULL DEFAULT 'build',
        model TEXT,
        migration_source TEXT,
        forked_from_task_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        unread_at INTEGER,
        last_unread_at INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        title_overridden INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (workspace_key, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_archived_updated
      ON tasks (workspace_key, archived, updated_at DESC)
      WHERE deleted = 0;

      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_pinned_updated
      ON tasks (workspace_key, pinned, updated_at DESC)
      WHERE deleted = 0;

      CREATE TABLE IF NOT EXISTS task_groups (
        group_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'gray',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_group_members (
        group_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        task_id TEXT NOT NULL,
        sort_order INTEGER,
        added_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_key, task_id),
        FOREIGN KEY (group_id) REFERENCES task_groups(group_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS task_group_view_node_orders (
        node_type TEXT NOT NULL,
        node_key TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (node_type, node_key)
      );

      CREATE TABLE IF NOT EXISTS task_group_workspace_bootstraps (
        workspace_key TEXT PRIMARY KEY,
        group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_group_members_group_order
      ON task_group_members (group_id, sort_order, added_at);

      CREATE INDEX IF NOT EXISTS idx_task_group_view_node_orders_order
      ON task_group_view_node_orders (sort_order, created_at);
    `;

// 自动化表组：`AUTOMATION_SCHEMA` 里先建调度定义表，再建运行记录表。
// automations 一行代表一条计划任务，cron_expr 与 schedule_rule 至少有一个可用；
// enabled/next_run_at 是调度器挑选到期任务的唯一入口，retry_at 单独服务失败重试。
// running/claimed_at/dispatch_status/attempts 构成租约字段：只有成功 claim 的执行者能推进。
// lifecycle_status 与 enabled 正交：前者表达归档/删除意图，后者表达是否参与调度。
// scheduled_run_count 与 run_count 分开统计，前者只计按计划触发的次数。
// automation_runs 记录每次触发的最终结果，session_id 指向实际执行会话。
// run 的 dispatch_status 默认 claimed，outcome 在终态时写入，二者不可互相替代。
// idx_automations_due / retry / workspace 三个索引分别服务轮询、重试与列表查询。
// 索引列顺序即查询前缀顺序，不能随意调整。
// 表内不保存 prompt 渲染结果，模板变量在触发时按当时配置展开。
// bot_delivery_target 为渠道投递目标，空值表示只在应用内展示。
// location_kind 区分本地与远端执行位置，远端任务由 server 侧调度。
// max_runs/end_at 是软上限：达到后由调度器停用而不是删除记录。
// schedule_edited_by_user 用于区分系统推断的计划与用户显式设置的计划。
// 所有时间列均为毫秒整数，可空表示尚未发生。
// `AUTOMATION_SCHEMA` 的列按「定义 / 调度 / 租约 / 统计 / 终态」五组理解。
export const AUTOMATION_SCHEMA = `
      CREATE TABLE IF NOT EXISTS automations (
        automation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT,
        provider TEXT,
        mode TEXT,
        thought_level TEXT,
        model_selection TEXT,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        target_task_id TEXT,
        bot_delivery_target TEXT,
        location_kind TEXT NOT NULL DEFAULT 'local',
        recurring INTEGER NOT NULL DEFAULT 1,
        max_runs INTEGER,
        end_at INTEGER,
        schedule_rule TEXT,
        schedule_edited_by_user INTEGER NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0,
        scheduled_run_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        next_run_at INTEGER,
        last_run_at INTEGER,
        running INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        dispatch_status TEXT NOT NULL DEFAULT 'idle',
        dispatch_attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automations_due
      ON automations (enabled, next_run_at);

      CREATE INDEX IF NOT EXISTS idx_automations_retry
      ON automations (enabled, retry_at);

      CREATE INDEX IF NOT EXISTS idx_automations_workspace
      ON automations (workspace_key);

      CREATE TABLE IF NOT EXISTS automation_runs (
        run_id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        scheduled_at INTEGER,
        trigger TEXT NOT NULL DEFAULT 'schedule',
        model_selection TEXT,
        dispatch_status TEXT NOT NULL DEFAULT 'claimed',
        outcome TEXT,
        session_id TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_automation_runs_by_automation
      ON automation_runs (automation_id, created_at DESC);
    `;

// 错峰任务表组：一条记录对应一次提交到错峰服务的执行请求。
// off_peak_task_id 是本地主键，server_ticket_id 是服务端票据，两者不保证同时存在。
// status 是状态机核心：queued/running/settled 等取值由服务层约束，schema 不做 CHECK。
// queue_position/next_poll_at 服务排队轮询，claim_running/claimed_at 防止多进程重复认领。
// schedulable 表示该任务是否可被本地调度器拉起，与服务端状态独立。
// history_deleted_at 是软删除时间，删除历史不删除任务行。
// files_changed 只记录数量，不保存文件清单，避免大 JSON 占用索引页。
// idx_off_peak_pick 服务“按状态取最早排队”，idx_off_peak_ws 服务工作区列表。
// 两个索引都以前缀列开头，查询必须带上对应前缀才能命中。
// attempt_count 与 last_error 共同表达失败重试状态，不在本表保存完整错误栈。
// 所有时间列一律毫秒整数（`next_run_at`、`claimed_at`），可空表示尚未发生。
// 本表不存 workspace 身份快照，身份变化由 session 层的身份迁移逻辑负责。
// 表之间没有外键：错峰任务可以脱离本地任务独立存在。
// model/thought_level 为旧字段，新写入统一使用 model_selection。
// settled_at 只在拿到服务端终态后写入，本地取消不会写该列。
// 新增列走 migrations.ts，不能回改本条 CREATE TABLE。
// 语句顺序与空白同样是 checksum 的一部分。
export const OFF_PEAK_SCHEMA = `
      CREATE TABLE IF NOT EXISTS off_peak_tasks (
        off_peak_task_id   TEXT PRIMARY KEY,
        server_ticket_id   TEXT,
        title              TEXT NOT NULL DEFAULT '',
        conversation_id    TEXT,
        session_id         TEXT,
        prompt             TEXT NOT NULL,
        permission_mode    TEXT NOT NULL,
        model              TEXT,
        thought_level      TEXT,
        model_selection    TEXT,
        workspace_key      TEXT NOT NULL,
        workspace_path     TEXT NOT NULL,
        workspace_identity TEXT,
        status             TEXT NOT NULL,
        queued_at          INTEGER NOT NULL,
        started_at         INTEGER,
        ended_at           INTEGER,
        failure_reason     TEXT,
        files_changed      INTEGER,
        settled_at         INTEGER,
        history_deleted_at INTEGER,
        registered_at      INTEGER,
        schedulable        INTEGER NOT NULL DEFAULT 0,
        queue_position     INTEGER,
        next_poll_at       INTEGER,
        claim_running      INTEGER NOT NULL DEFAULT 0,
        claimed_at         INTEGER,
        attempt_count      INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_off_peak_pick
      ON off_peak_tasks (status, queued_at);

      CREATE INDEX IF NOT EXISTS idx_off_peak_ws
      ON off_peak_tasks (workspace_key, status);
    `;
