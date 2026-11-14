/**
 * ============================================================================
 * storage/session-store/migrations.ts —— CLI session DB 的迁移清单
 * ============================================================================
 *
 * 【定位】按数组顺序执行、只增不改的 schema 迁移表。每条迁移有：
 *   - id：稳定主键（schema_migration.id），一旦发布不能改名；
 *   - appVersion：引入该迁移的产品版本，供诊断；
 *   - touchedTables：本迁移触及的表，供 schema 合同检查/影响分析；
 *   - sql：幂等 DDL/DML（尽量使用 if not exists）。
 *
 * 【为什么 id 和顺序不能变】
 *   已发布迁移的 checksum 会写入数据库；改动已发布 SQL 或顺序会导致
 *   checksum mismatch，启动直接失败（这是有意的 fail closed）。
 *   新增 migration 必须追加到末尾，并由 `pnpm db:schema:check` 校验基线。
 *
 * 【大表迁移注意】SQLite 的 DDL/回填都在 `begin immediate` 事务内执行，
 *   长时间锁会阻塞其它进程启动；大表回填应拆成独立迁移并考虑分批策略。
 * ============================================================================
 */
// ─────────────────────────────────────────────────────────────────────────────
// 深注释：职责边界 / 不变量（与上方块注释互补，不重复其内容）
// ─────────────────────────────────────────────────────────────────────────────
// 做：以数组形式声明 CLI session DB 的 schema 迁移快照（id / appVersion /
//     touchedTables / sql / apply），供 migration-runner 顺序执行并做 checksum 记账。
// 不做：不打开数据库、不开启事务、不加锁、不做校验和数据修复；事务与锁都在
//       migration-runner，数据读写都在 repositories。本文件只有事实声明，无副作用。
// 依赖：@zcode/shared/sqlite-migrations 的 SqliteMigration 契约；0020–0022 的 SQL
//       片段由 ./migrations/*.js 提供；touchedTables 供 schema 合同检查读取。
//
// 不变量（INV）：
// INV-01 断言：已发布的 id 永不改名也不复用 —— 守住它的位置：每个对象的 id 字段 —— 改错故障：旧库 schema_migration 记账行对不上新清单，启动即 checksum 失败，所有客户端开不了库。
// INV-02 断言：数组顺序就是执行顺序，新迁移只能追加到末尾 —— 守住它的位置：SQLITE_MIGRATIONS 的数组字面量 —— 改错故障：在中间插入会让已执行库把新迁移当成“已跑过”，表结构永久缺失。
// INV-03 断言：已发布迁移的 sql 文本一个字符都不能改 —— 守住它的位置：每条 sql 模板字符串 —— 改错故障：checksum 变化，老用户升级后启动直接失败且无法自救。
// INV-04 断言：sql 必须可重复执行 —— 守住它的位置：create table/index 的 if not exists —— 改错故障：并发启动或崩溃重试时抛 already exists，迁移事务整体回滚。
// INV-05 断言：touchedTables 与实际 SQL 触碰的表一致 —— 守住它的位置：每条迁移的 touchedTables —— 改错故障：schema 合同检查与影响分析漏表，评审时看不见破坏性变更。
// INV-06 断言：SQL 只能写事务内允许的语句 —— 守住它的位置：sql 模板内容 —— 改错故障：VACUUM / PRAGMA 之类进事务会报错，迁移无法提交且库停在半途。
// INV-07 断言：重建表四步（rename→create→insert→drop）同属一条迁移 —— 守住它的位置：0017/0018 的 sql —— 改错故障：拆开后中途崩溃留下双表，重启后数据来源不确定。
// INV-08 断言：重建表时 insert 的显式列清单覆盖旧表全部业务列 —— 守住它的位置：0017/0018 的 insert into ... select —— 改错故障：漏列即不可逆数据丢失，且没有任何报错。
// INV-09 断言：建表列序即物理列序，后续只能 ADD COLUMN —— 守住它的位置：0001 的 create table —— 改错故障：重排列会让按名不符的旧 SQL 报错，按位置读取的代码读错字段。
// INV-10 断言：引用 session(id) 的 on delete 语义不可悄悄改 —— 守住它的位置：0001/0007 的外键子句 —— 改错故障：删会话时要么静默丢子数据，要么留下永远清不掉的孤儿行。
// INV-11 断言：放宽 CHECK 只能整表重建，且旧值必须被新 CHECK 接受 —— 守住它的位置：0017/0018 —— 改错故障：insert select 撞约束，迁移失败；或强改数据导致状态事实被篡改。
// INV-12 断言：索引列序即查询形状 —— 守住它的位置：各 create index 的列顺序 —— 改错故障：热点查询失去索引，退化全表扫，会话列表在大库上卡死。
// INV-13 断言：unique 约束是幂等事实的最后防线 —— 守住它的位置：workflow_activity / workflow_event / session_task_link —— 改错故障：重试写入重复行，统计与因果链翻倍。
// INV-14 断言：apply 与 sql 两条路径的最终 schema 完全一致 —— 守住它的位置：0023 的 apply + sql —— 改错故障：新库与旧库升级后列不同，同一份代码在两类库上行为分叉。
// INV-15 断言：previousIds 只承接历史上的同一条迁移 —— 守住它的位置：0023 的 previousIds —— 改错故障：用它给已发布迁移改名会让记账对不上，checksum 校验失败。
// INV-16 断言：外部导入的 SQL 片段只注册、不就地改写 —— 守住它的位置：0020–0022 —— 改错故障：片段文本变了同样算 checksum 变化，而且改动点分散在别的文件。
// INV-17 断言：时间列一律 integer 毫秒且由调用方写入 —— 守住它的位置：所有 time_created/time_updated —— 改错故障：SQL 内用 datetime('now') 会引入本地时区，跨机器数据不可比。
// INV-18 断言：id 零填充保证字典序等于执行序与展示序 —— 守住它的位置：id 前缀 0001..0023 —— 改错故障：去零后诊断面板与迁移台账顺序错乱，人工排查被误导。
// INV-19 断言：迁移不得引用运行时状态（环境变量、当前时间、随机数） —— 守住它的位置：sql/apply 的实现 —— 改错故障：同一版本在不同机器产生不同 schema，checksum 失去意义。
//
// 阅读提示：下面每条的注释只讲“为什么这个顺序/这个约束不能动”，不复述 SQL 列名。
// ─────────────────────────────────────────────────────────────────────────────
import type { SqliteMigration } from "@zcode/shared/sqlite-migrations";
export type { SqliteMigration } from "@zcode/shared/sqlite-migrations";
import { PROVIDER_MODEL_SELECTION_MIGRATION_SQL } from "./migrations/0020-provider-model-selection.js";
import { SESSION_DATABASE_IDENTITY_MIGRATION } from "@zcode/shared/sqlite-migrations";

import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "./migrations/0021-official-glm-selection.js";
import { BACKFILLED_SESSION_REASONING_MIGRATION_SQL } from "./migrations/0022-backfilled-session-reasoning.js";

// [契约] 这是唯一的迁移清单；runner 只认这里的顺序与 id，不接受其它注册方式。
// 数组被声明为 readonly，但元素内部的 sql 字符串仍是普通字符串——防误改靠评审与
// db:schema:check，不靠类型。新增迁移请追加到数组末尾，并同步基线校验文件。
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    // [契约] appVersion 只用于诊断与发布追溯，不参与执行判定；不要把它当功能开关。
    // 写错版本不会让迁移跳过或重跑，只会让排障时误判“这个库是哪个版本建的”。
    // 真正决定跑不跑的是 id + 记账表，二者不能互相替代。
    appVersion: "0.2.0",
    // [契约] 基线 schema：session / message / part / todo / session_entry /
    // permission / input_history 七张表与索引一次建齐。
    // 后续迁移只能 ADD COLUMN 或追加新表；不许改这里的列序、列名或索引列序，
    // 那会改变已发布库的 checksum，旧库升级时启动直接失败。
    // part.session_id 故意不带外键（只建索引）：它随 message 级联删除，多一条 FK 只会增加写放大。
    id: "0001_base_session_store",
    // [契约] touchedTables 是 schema 合同检查的输入，必须与 sql 实际触碰的表一一对应。
    // 这里用多行数组列出全部七张表；删减会让评审看不到这次迁移的破坏面。
    touchedTables: [
      "input_history",
      "message",
      "part",
      "permission",
      "session",
      "session_entry",
      "todo",
    ],
    sql: `
      create table if not exists session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        summary_additions integer,
        summary_deletions integer,
        summary_files integer,
        summary_diffs text,
        revert text,
        permission text,
        time_created integer not null,
        time_updated integer not null,
        time_compacting integer,
        time_archived integer
      );

      create index if not exists session_project_idx on session(project_id);
      create index if not exists session_workspace_idx on session(workspace_id);
      create index if not exists session_parent_idx on session(parent_id);

      create table if not exists message (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists message_session_time_created_id_idx
        on message(session_id, time_created, id);

      create table if not exists part (
        id text primary key,
        message_id text not null references message(id) on delete cascade,
        session_id text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists part_message_id_id_idx on part(message_id, id);
      create index if not exists part_session_idx on part(session_id);

      create table if not exists todo (
        session_id text not null references session(id) on delete cascade,
        content text not null,
        status text not null,
        priority text not null,
        position integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(session_id, position)
      );

      create index if not exists todo_session_idx on todo(session_id);

      create table if not exists session_entry (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        type text not null,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create index if not exists session_entry_session_idx on session_entry(session_id);
      create index if not exists session_entry_session_type_idx on session_entry(session_id, type);
      create index if not exists session_entry_time_created_idx on session_entry(time_created);

      create table if not exists permission (
        project_id text primary key,
        time_created integer not null,
        time_updated integer not null,
        data text not null
      );

      create table if not exists input_history (
        id text primary key,
        project_id text not null,
        session_id text,
        text text not null,
        kind text not null,
        time_created integer not null
      );

      create index if not exists input_history_project_time_idx
        on input_history(project_id, time_created desc, id desc);
      create index if not exists input_history_time_idx
        on input_history(time_created desc, id desc);
    `,
  },
  {
    // 同一版本号下允许多条迁移（0002/0003 都标 0.2.0），顺序由数组位置而非版本号决定。
    // 不要为了“版本号必须唯一”去合并它们，合并会改变已发布文本。
    appVersion: "0.2.0",
    // local_setting 是通用 KV，复合主键 (scope, scope_id, namespace, key)
    // 同时决定了两条查询路径：按 scope 走 PK 前缀，按 namespace/key 走二级索引。
    // 不要在中间插列或调整主键顺序，否则两个既定查询都会退化成全表扫描。
    // value 存 JSON 文本，schema_version 由写方维护——SQL 层不做结构校验。
    id: "0002_local_setting",
    // 本迁移只动 local_setting；0003 的回填也写这张表，但二者是独立迁移，
    // 中间崩溃时停在“表已建、还没回填”的合法中间态。
    touchedTables: ["local_setting"],
    sql: `
      create table if not exists local_setting (
        scope text not null,
        scope_id text not null,
        namespace text not null,
        key text not null,
        value text not null,
        schema_version integer not null,
        time_created integer not null,
        time_updated integer not null,
        primary key(scope, scope_id, namespace, key)
      );

      create index if not exists local_setting_scope_idx
        on local_setting(scope, scope_id);

      create index if not exists local_setting_namespace_key_idx
        on local_setting(namespace, key);
    `,
  },
  {
    // 回填迁移与建表迁移同版本是刻意的：升级到 0.2.0 的用户必须一次性拿到表 + 数据。
    appVersion: "0.2.0",
    // [事务] 一次性把 permission 表里的项目级 ruleset 灌进 local_setting。
    // insert or ignore 是幂等保证：重复执行（含旧库已部分迁移）不会因主键冲突中断整条迁移，
    // 也不会覆盖用户后来在 local_setting 里改过的值。
    // where data is not null 必须保留：NULL 在旧库表示“没配置过”，插入空串会改变语义。
    id: "0003_backfill_permission_local_setting",
    // 回填只写 local_setting，但语义上依赖 permission 表；touchedTables 只登记被写的表，
    // 所以这里不列 permission——被读的表不属于本次迁移的破坏面。
    touchedTables: ["local_setting"],
    sql: `
      insert or ignore into local_setting (
        scope,
        scope_id,
        namespace,
        key,
        value,
        schema_version,
        time_created,
        time_updated
      )
      select
        'project',
        project_id,
        'permission',
        'ruleset',
        data,
        1,
        time_created,
        time_updated
      from permission
      where data is not null;
    `,
  },
  {
    // 0.7.0 引入 session_target；同版本的 0005 立刻重建它，
    // 两条都必须保留：直接从 0.1.x 升上来的库需要先建后改，不能只留终态那条。
    appVersion: "0.7.0",
    // session_target 的 CHECK 只允许 active / paused / complete 三态。
    // 0005 紧接着整表重建以加入 budget_limited，但本条的 CHECK 不能回改：
    // 已发布迁移的文本是 checksum 的一部分，改一个字老库就升不上来。
    // status 用 text + check 而非枚举表，是为了让查询与诊断直接可读。
    id: "0004_session_target",
    // 本条只碰 session_target；下一 0005 会同时碰旧表与临时新表，
    // 所以那里的 touchedTables 必须多列一项，不能沿用这一行。
    touchedTables: ["session_target"],
    sql: `
      create table if not exists session_target (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'complete')),
        time_created integer not null,
        time_updated integer not null
      );
    `,
  },
  {
    appVersion: "0.7.0",
    // 表重建范式：create 新表 → insert select → drop 旧表 → rename。
    // 四步必须留在同一条迁移里；拆开会在中途崩溃时留下“新表有数据、旧表还在”的双写歧义。
    // 新表新增的 token_budget / tokens_used / time_used_seconds 由默认值补齐历史行，
    // insert 里显式写 null/0 而不是省略列，保证旧行语义可解释。
    // drop 旧表必须在 rename 之前：SQLite 的 rename 不会替你处理旧名占用。
    id: "0005_session_target_accounting",
    // 临时表 session_target_next 也必须登记：它在本迁移内被创建又删除，
    // 但影响分析需要知道这次迁移短暂持有了这张表。
    touchedTables: ["session_target", "session_target_next"],
    sql: `
      create table if not exists session_target_next (
        session_id text primary key references session(id) on delete cascade,
        target_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds integer not null default 0,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_target_next (
        session_id,
        target_id,
        objective,
        status,
        token_budget,
        tokens_used,
        time_used_seconds,
        time_created,
        time_updated
      )
      select
        session_id,
        target_id,
        objective,
        status,
        null,
        0,
        0,
        time_created,
        time_updated
      from session_target;

      drop table session_target;
      alter table session_target_next rename to session_target;
    `,
  },
  {
    // 0.11.0 只加一列附件；版本号是给发布说明看的，改它不会影响任何库的行为。
    appVersion: "0.11.0",
    // alter add column 不带 not null / default：旧行该列为 NULL，
    // 读路径必须把 NULL 解释成“没有附件”，不能假设空数组。
    // 不要为了统一在这里补 default '[]'——SQLite 的 ADD COLUMN 默认值只影响新行，
    // 历史行仍是 NULL，反而制造两种“空”的表示。
    id: "0006_input_history_attachments",
    // 只加一列，touchedTables 仍要登记：合同检查按表粒度判断是否触发回归测试。
    touchedTables: ["input_history"],
    sql: `
      alter table input_history add column attachments text;
    `,
  },
  {
    // 0.13.0 是 workflow 首次落库的版本，0007/0008 共享它；
    // 两者的先后不能对调：0008 给 0007 建出来的表加 scope 列。
    appVersion: "0.13.0",
    // 最大的结构迁移：session.task_type + 五张 workflow_* 表 + session_task_link。
    // 一次建齐是为了让 workflow 功能在同一版本开关内可用，避免跨版本半成品 schema。
    // 表间外键的 on delete 语义是数据保留策略：run 删除级联活动/事件，
    // session 删除只 set null（保留审计痕迹），不能随手统一成 cascade。
    // session.task_type 带 not null default，旧行自动归为 interactive，读侧无需判空。
    id: "0007_workflow_script_runtime",
    // 六张表全部登记，顺序与 sql 内的创建顺序一致，便于人工对照；
    // 新增表时两者必须同步，否则合同检查会漏掉这次迁移的破坏面。
    touchedTables: [
      "session",
      "session_task_link",
      "workflow_activity",
      "workflow_definition",
      "workflow_event",
      "workflow_run",
    ],
    sql: `
      alter table session add column task_type text not null default 'interactive';

      create index if not exists session_task_type_idx on session(task_type);

      create table if not exists workflow_definition (
        id text primary key,
        name text not null,
        source text not null check(source in ('builtin', 'user')),
        trusted integer not null default 0 check(trusted in (0, 1)),
        enabled integer not null default 1 check(enabled in (0, 1)),
        script_path text,
        script_hash text not null,
        meta_json text not null,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists workflow_definition_source_idx
        on workflow_definition(source, enabled);

      create table if not exists workflow_run (
        id text primary key,
        definition_id text,
        name text not null,
        kind text not null default 'script',
        parent_session_id text references session(id) on delete set null,
        cwd text not null,
        script_path text,
        script_hash text not null,
        args_json text,
        args_hash text,
        status text not null check(status in (
          'pending',
          'running',
          'paused',
          'completed',
          'failed',
          'cancelled'
        )),
        current_phase text,
        budget_total integer,
        budget_spent integer not null default 0,
        stats_json text,
        failure_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer
      );

      create index if not exists workflow_run_parent_session_idx
        on workflow_run(parent_session_id);
      create index if not exists workflow_run_cwd_status_idx
        on workflow_run(cwd, status, time_updated desc);
      create index if not exists workflow_run_definition_idx
        on workflow_run(definition_id);

      create table if not exists workflow_activity (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        parent_activity_id text,
        call_index integer not null,
        call_path text not null,
        attempt integer not null default 1,
        type text not null,
        phase text,
        label text,
        input_hash text not null,
        prompt text,
        opts_json text,
        status text not null check(status in (
          'queued',
          'running',
          'completed',
          'failed',
          'skipped',
          'cancelled',
          'cached',
          'lost'
        )),
        child_session_id text references session(id) on delete set null,
        result_json text,
        error_json text,
        time_created integer not null,
        time_started integer,
        time_updated integer not null,
        time_completed integer,
        unique(run_id, call_path, attempt)
      );

      create index if not exists workflow_activity_run_status_idx
        on workflow_activity(run_id, status, call_index);
      create index if not exists workflow_activity_child_session_idx
        on workflow_activity(child_session_id);

      create table if not exists workflow_event (
        id text primary key,
        run_id text not null references workflow_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        phase text,
        activity_id text references workflow_activity(id) on delete set null,
        payload_json text,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists workflow_event_run_sequence_idx
        on workflow_event(run_id, sequence);

      create table if not exists session_task_link (
        id text primary key,
        root_workflow_run_id text references workflow_run(id) on delete cascade,
        parent_link_id text references session_task_link(id) on delete cascade,
        activity_id text references workflow_activity(id) on delete set null,
        parent_session_id text references session(id) on delete set null,
        child_session_id text not null references session(id) on delete cascade,
        role text not null,
        depth integer not null default 0,
        path text not null,
        phase text,
        label text,
        agent_type text,
        model text,
        status text not null,
        time_created integer not null,
        time_updated integer not null,
        unique(child_session_id)
      );

      create index if not exists session_task_link_root_workflow_idx
        on session_task_link(root_workflow_run_id, depth, path);
      create index if not exists session_task_link_parent_idx
        on session_task_link(parent_link_id);
      create index if not exists session_task_link_activity_idx
        on session_task_link(activity_id);
    `,
  },
  {
    appVersion: "0.13.0",
    // scope 用 CHECK 限定四值，与 workflow_definition.source 是两个正交维度：
    // source 表示谁写的（builtin/user），scope 表示在哪可见（builtin/explicit/project/user）。
    // 合并它们会让 builtin 定义失去 project 级覆盖能力，也会让用户脚本无法提升为项目级。
    id: "0008_workflow_definition_scope",
    // 只加 scope 列；但 scope 的取值决定后续查询是否走 definition_source_idx，
    // 改动列类型会让既有索引失效。
    touchedTables: ["workflow_definition"],
    sql: `
      alter table workflow_definition
        add column scope text not null default 'explicit'
        check(scope in ('builtin', 'explicit', 'project', 'user'));
    `,
  },
  {
    appVersion: "0.14.0",
    // 标题元数据三列：来源枚举、被取标题的消息 id、标题最后更新时间。
    // title_source 默认 first_input 是对旧库的语义承诺（历史标题都来自首条输入），
    // 改成 default 会让历史会话在 UI 上被显示成“默认标题”。
    // title_message_id 可为空——手工改名或生成标题不绑定具体消息。
    id: "0009_session_title_metadata",
    // 标题元数据三列都加在 session 上；本条只加列，不重建表，
    // 所以旧库升级是 O(1)、不需要回填。
    touchedTables: ["session"],
    sql: `
      alter table session
        add column title_source text not null default 'first_input'
        check(title_source in ('default', 'first_input', 'generated', 'custom'));

      alter table session
        add column title_message_id text;

      alter table session
        add column time_title_updated integer;
    `,
  },
  {
    // 0.15.0 一次性引入观测表、目标摘要、trace 与序号回填；
    // 版本相同不代表可任意重排：0014 的索引依赖 0010 之后的表结构假设，
    // 插入新迁移时必须追加到 0023 之后，而不是插进这个版本段中间。
    appVersion: "0.15.0",
    // 观测三表：model_usage / turn_usage / tool_usage，只追加流水、不改写业务事实。
    // 列宽与枚举（status、error_type、retryable）是查询契约：新增指标只能加列，
    // 不能改既有列类型或 CHECK，否则历史报表会静默缺数据而不是报错。
    // tool_usage 的 unique(session_id, tool_call_id) 是重试去重的唯一防线。
    // 所有计数列都给 not null default 0：聚合查询不必到处 coalesce。
    id: "0010_usage_observability",
    // 三张表按字母序登记，与本迁移的创建顺序无关；合同检查只比对集合。
    touchedTables: ["model_usage", "tool_usage", "turn_usage"],
    sql: `
      create table if not exists model_usage (
        id text primary key,
        logical_request_id text not null,
        attempt_index integer not null default 0,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        span_id text,
        assistant_message_id text,
        parent_user_message_id text,
        query_source text not null,
        provider_id text not null,
        model_id text not null,
        variant text,
        agent text,
        mode text,
        task_type text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        finish_reason text,
        tool_call_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        provider_total_tokens integer,
        computed_total_tokens integer not null default 0,
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        error_message text,
        raw_usage_json text,
        provider_metadata_json text
      );

      create index if not exists model_usage_started_model_idx
        on model_usage(started_at, provider_id, model_id);
      create index if not exists model_usage_session_turn_idx
        on model_usage(session_id, turn_id);
      create index if not exists model_usage_trace_idx
        on model_usage(trace_id);
      create index if not exists model_usage_query_source_idx
        on model_usage(query_source);

      create table if not exists turn_usage (
        session_id text not null references session(id) on delete cascade,
        turn_id text not null,
        trace_id text,
        user_message_id text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_model_start_at integer,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        model_request_count integer not null default 0,
        model_retry_count integer not null default 0,
        tool_call_count integer not null default 0,
        tool_error_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        computed_total_tokens integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        context_exceeded integer not null default 0 check(context_exceeded in (0, 1)),
        error_type text,
        error_code text,
        primary key(session_id, turn_id)
      );

      create index if not exists turn_usage_started_idx
        on turn_usage(started_at);

      create table if not exists tool_usage (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        tool_call_id text not null,
        tool_name text not null,
        side_effect_scope text,
        read_only integer check(read_only in (0, 1)),
        destructive integer check(destructive in (0, 1)),
        approval_status text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_output_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_output_ms integer,
        exit_code integer,
        output_bytes integer not null default 0,
        stdout_bytes integer not null default 0,
        stderr_bytes integer not null default 0,
        truncated integer not null default 0 check(truncated in (0, 1)),
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0 check(cancelled_by_user in (0, 1)),
        error_type text,
        error_code text,
        error_message text
      );

      create unique index if not exists tool_usage_session_tool_call_idx
        on tool_usage(session_id, tool_call_id);
      create index if not exists tool_usage_started_tool_idx
        on tool_usage(started_at, tool_name);
      create index if not exists tool_usage_session_turn_idx
        on tool_usage(session_id, turn_id);
    `,
  },
  {
    appVersion: "0.15.0",
    // summary_title 是列表用的短标题，与 objective 并存：前者可自动生成，后者是用户原话。
    // 加列不设默认值，读侧必须容忍 NULL（旧 run 没有摘要），不能把它当 objective 的回退。
    id: "0011_session_target_summary_title",
    // 本条与 0011/0013 都只碰 session_target，但各自是独立迁移，
    // 不要合并——已发布迁移的文本不可改，只能继续追加。
    touchedTables: ["session_target"],
    sql: `
      alter table session_target add column summary_title text;
    `,
  },
  {
    appVersion: "0.15.0",
    // trace_id 是跨 session/turn 的链路关联键，索引必须保留：
    // 排障时按 trace 反查一次会话的全部请求，没有索引就是全表扫。
    // 列可空是为了兼容旧会话，读侧不能假设每行都有 trace。
    id: "0012_session_trace_id",
    // 只加列 + 一个索引，不重建表；索引与列在同一条迁移里，
    // 避免出现“列已加、索引还没建”的窗口期导致慢查询。
    touchedTables: ["session"],
    sql: `
      alter table session add column trace_id text;

      create index if not exists session_trace_idx on session(trace_id);
    `,
  },
  {
    appVersion: "0.15.0",
    // 活跃 run 三列（input id / 开始时间 / 最后心跳）用于崩溃后恢复与超时判断。
    // 三列必须一起写、一起清；只更新心跳不清 input 会留下无法回收的“幽灵 run”。
    // 这里不建索引：按 session 主键查 goal 时已经定位到行，再筛三列代价可忽略。
    id: "0013_session_target_active_run_accounting",
    // 本条只给 session_target 加活跃 run 三列，不重建表；
    // 三列一律可空，旧 run 读出 NULL 即表示“没有进行中的运行”。
    touchedTables: ["session_target"],
    sql: `
      alter table session_target add column active_input_id text;
      alter table session_target add column active_run_started_at integer;
      alter table session_target add column active_run_last_seen_at integer;
    `,
  },
  {
    appVersion: "0.15.0",
    // sequence 回填：按 scope 内 (time_created, rowid) 排序生成 0 基序号。
    // rowid 是稳定次序的最后兜底（同毫秒写入），去掉它会让回填结果在重跑时抖动。
    // 这里的 row_number()-1 只适用于“全表都还没有 sequence”的初始状态；
    // 混有非空 sequence 的库必须走 0015，否则会与既有序号撞号。
    // 回填完成后再建索引，避免边写边维护索引放大迁移耗时。
    id: "0014_message_part_sequence",
    // 两张表都要回填并各建索引；只改一张会让消息有序、零件无序。
    touchedTables: ["message", "part"],
    sql: `
      alter table message add column sequence integer;
      alter table part add column sequence integer;

      with ordered_message as (
        select
          id,
          row_number() over (
            partition by session_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from message
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_message
        where ordered_message.id = message.id
      )
      where sequence is null;

      with ordered_part as (
        select
          id,
          row_number() over (
            partition by message_id
            order by time_created, rowid
          ) - 1 as stable_sequence
        from part
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_part
        where ordered_part.id = part.id
      )
      where sequence is null;

      create index if not exists message_session_sequence_idx
        on message(session_id, sequence, time_created, id);

      create index if not exists part_message_sequence_idx
        on part(message_id, sequence, time_created, id);

      create index if not exists part_session_message_sequence_idx
        on part(session_id, message_id, sequence);
    `,
  },
  {
    // 0.15.2 是时间线权威性修复批次：0015 补序号、0016–0018 建输入账本。
    // 四条合起来才构成“输入不丢、顺序不乱”的完整保证，单独回滚其中一条会破坏该保证，
    // 所以它们只能整批前向修复，不能挑一条改。
    appVersion: "0.15.2",
    // [失败路径] 0014 之后仍出现 NULL sequence（旧二进制写入不含该列），
    // 所以本条必须“只补 NULL、从各 scope 的 max+1 起编号”，
    // 与读路径“NULL 排在非空之后”的兜底保持一致，保证回填前后 hydrate 顺序不变。
    // 两个 AFTER INSERT 触发器是防回归护栏：新代码不再触发，删掉它们会让混跑旧版本
    // 的机器重新累积 NULL，顺序再次错乱且无法自动修复。
    // 触发器不能改成 BEFORE INSERT：旧版本语句里没有该列，只在 AFTER 补得到新 rowid。
    id: "0015_message_part_sequence_backfill_and_guard",
    // 0015 与 0014 动同样的两张表，但语义完全不同：0014 全量编号，0015 只补 NULL。
    // 两条都必须保留，不能因为“已经回填过”就删掉后者。
    touchedTables: ["message", "part"],
    // 背景（16-timeline-authority-plan P0）：0014 backfill 之后仍持续出现 NULL sequence
    // （本机观测 message 1,690 / part 5,933 行，跨 331 sessions），主要嫌疑是旧版本二进制
    // 并存写同一 DB（其 INSERT 不含 sequence 列）。本迁移做两件事：
    // 1. 增量 backfill：只补 NULL 行，序号从各 scope 现有 max(sequence)+1 起、按
    //    time_created/rowid 排——与读路径 fallback（sequence is null 排在非空之后）完全
    //    一致，backfill 前后 hydrate 顺序不变。不能复用 0014 的 row_number-1 写法：
    //    它按全量行编号，混排数据下会与既有 sequence 撞号并把 NULL 行重排到前面。
    // 2. AFTER INSERT 触发器兜底：旧二进制再写入 NULL sequence 时自动补当前 scope 队尾，
    //    从源头阻止新的 NULL 产生；新代码路径 sequence 恒非空，触发器不生效。
    sql: `
      with session_max as (
        select session_id, coalesce(max(sequence), -1) as max_sequence
        from message
        group by session_id
      ),
      ordered_null_message as (
        select
          m.id as id,
          sm.max_sequence + row_number() over (
            partition by m.session_id
            order by m.time_created, m.rowid
          ) as stable_sequence
        from message m
        join session_max sm on sm.session_id = m.session_id
        where m.sequence is null
      )
      update message
      set sequence = (
        select stable_sequence
        from ordered_null_message
        where ordered_null_message.id = message.id
      )
      where sequence is null;

      with message_max as (
        select message_id, coalesce(max(sequence), -1) as max_sequence
        from part
        group by message_id
      ),
      ordered_null_part as (
        select
          p.id as id,
          mm.max_sequence + row_number() over (
            partition by p.message_id
            order by p.time_created, p.rowid
          ) as stable_sequence
        from part p
        join message_max mm on mm.message_id = p.message_id
        where p.sequence is null
      )
      update part
      set sequence = (
        select stable_sequence
        from ordered_null_part
        where ordered_null_part.id = part.id
      )
      where sequence is null;

      create trigger if not exists message_sequence_autofill
      after insert on message
      when new.sequence is null
      begin
        update message
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from message
          where session_id = new.session_id
        )
        where id = new.id;
      end;

      create trigger if not exists part_sequence_autofill
      after insert on part
      when new.sequence is null
      begin
        update part
        set sequence = (
          select coalesce(max(sequence), -1) + 1
          from part
          where message_id = new.message_id
        )
        where id = new.id;
      end;
    `,
  },
  {
    appVersion: "0.15.2",
    // session_input 账本是 durable 输入生命周期的唯一事实源。
    // delivery/status 的 CHECK 是状态机契约：admitted 只能走向 promoted / cancelled /
    // discarded，不得回退；放宽 CHECK 前必须确认所有读写路径都适配了新终态。
    // admitted_sequence 是在 session 内排序的单调序号，不能用时间戳替代（同毫秒会乱序）。
    // 索引 (session_id, admitted_sequence) 支撑队列顺序读，删掉它队列会全表扫。
    id: "0016_session_input_ledger",
    // 新建表而非改旧表；touchedTables 只需登记新表，合同检查据此提示下游适配。
    touchedTables: ["session_input"],
    // session_input 账本（16-timeline-authority-plan P3）：输入的 durable 生命周期
    // admitted -> promoted / cancelled / discarded。旧实现里队列/唤醒的存在性只在
    // 进程内存（事件日志也是内存的），崩溃即静默丢；账本让「queue 消失但不进
    // history」不可能静默发生，并为输入类 command 提供 durable 幂等。
    sql: `
      create table if not exists session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index if not exists session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.15.2",
    // [事务] SQLite 不能原地修改 CHECK，只能整表重建：
    // rename → create（含 startNow）→ insert select → drop → 重建索引。
    // 显式列清单必须覆盖旧表全部业务列，漏一列就是不可逆的数据丢失。
    // 索引名沿用旧名是刻意的：改名会让后续迁移的 if not exists 判断失真。
    // 临时表名带 before_start_now 后缀，避免与正式表名冲突导致 rename 失败。
    id: "0017_session_input_start_now_delivery",
    // 临时表也必须登记：它在迁移内被创建又删除，
    // 但影响分析需要知道这次迁移短暂持有了两份账本。
    touchedTables: ["session_input", "session_input_before_start_now"],
    // 05C：所有 input command 都在执行前落 durable admission，startNow 也需要独立
    // delivery，不能伪装成 queue。SQLite 不能原地修改 CHECK，必须重建表并保全账本。
    sql: `
      alter table session_input rename to session_input_before_start_now;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_start_now;

      drop table session_input_before_start_now;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    appVersion: "0.15.2",
    // 同 0017 的重建范式，只为把 failed 加进 status 的 CHECK。
    // failed 不能伪装成 cancelled：parent 的 accepted fact 已经成立，
    // 只是 child runtime 启动失败，两者语义与重试策略都不同。
    // 重建后旧账本逐列复制，终态字段一处都不能少，否则重启后会重复消费。
    id: "0018_session_input_failed_status",
    // 重建期间同时持有新旧两张账本；临时表必须登记，
    // 否则影响分析会以为本次迁移只是原地加了一个枚举值。
    touchedTables: ["session_input", "session_input_before_failed_status"],
    // Bugfix：fork bundle 提交后 child runtime 仍可能同步启动失败。该输入已经被 parent
    // accepted fact 接受，不能伪装成 cancelled/discarded；新增 durable failed 终态，并通过
    // 重建 CHECK 保证旧库升级后也能写入，重启不会再次消费或改写它。
    sql: `
      alter table session_input rename to session_input_before_failed_status;

      create table session_input (
        id text primary key,
        session_id text not null references session(id) on delete cascade,
        kind text not null,
        delivery text not null check(delivery in ('startNow', 'guide', 'queue')),
        payload text not null,
        admitted_sequence integer not null,
        promoted_sequence integer,
        promoted_message_id text,
        status text not null check(status in ('admitted', 'promoted', 'cancelled', 'discarded', 'failed')),
        status_reason text,
        time_created integer not null,
        time_updated integer not null
      );

      insert into session_input (
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      )
      select
        id, session_id, kind, delivery, payload, admitted_sequence,
        promoted_sequence, promoted_message_id, status, status_reason,
        time_created, time_updated
      from session_input_before_failed_status;

      drop table session_input_before_failed_status;

      create index session_input_session_admitted_idx
        on session_input(session_id, admitted_sequence);
      create index session_input_session_status_idx
        on session_input(session_id, status);
    `,
  },
  {
    // 0.16.5 是 dwf 基线冻结版本；同版本下的 0020–0022 通过外部片段注册，
    // 它们与本文件的 dwf 基线共享发布节奏，升级时一起出现。
    // 冻结后的修复一律新开 0024+，不要在本段插入，否则 checksum 与记账顺序同时失效。
    appVersion: "0.16.5",
    // dwf_* 是 dynamic-workflow 引擎自己的 journal，与 legacy workflow_* 无关。
    // 这里被压成单条基线（0019–0030 的终态），beta 后不能再改，只能追加新迁移。
    // parent_session_id / session_id 故意不加外键：子代理会话可能没有 session 行，
    // runner 又开着 foreign_keys，加 FK 会把合法 journal 挡在门外。
    // 索引列序即查询形状（cwd + time_updated 倒序、artifact_id + sequence），
    // 调换列序会让历史列表与看板分页退化为全表扫。
    id: "0019_dwf_journal",
    // 五张表按英文序登记；dwf_artifact 的表名与 dwf_node.artifact_id 列是两回事，
    // 不要因为看不到独立建表语句就把它从清单里删掉。
    touchedTables: ["dwf_run", "dwf_actor", "dwf_artifact", "dwf_node", "dwf_event"],
    // dynamic-workflow 执行引擎的 durable journal（docs/execution-engine.md 的 "Journal & storage"）。
    // legacy 的 workflow_* 表只是模板不是家：dwf_* 自成一套，与既有 workflow 机制彼此独立。
    //
    // 本条是 beta 前把开发期 0019–0030 十二条迁移**压成的单一基线**：四张表一次建齐、形状即
    // 0030 之后的终态。中间态（三次为放宽 CHECK 的整表重建、0028 的删列改名）只存在于
    // 内部预览库里，收敛办法是删掉四张 dwf_* 表并清掉 schema_migration 里的 dwf 记账行，
    // 下次启动由本条重建。beta 之后本条
    // 不可再改：runner 按 checksum 记账，历史迁移只能追加。
    //
    // 只为占住 0019 这个槽位，让
    // staging 后续迁移从 0020 起编号，功能分支合回时 ledger 不会撞号。四张表在功能落地前闲置无害。
    //
    // 几条刻意为之的设计：
    // 1) parent_session_id / session_id 是纯 text，不加 FOREIGN KEY——子代理会话跑在内存
    //    event store 上、没有 session 行，而 runner 开着 pragma foreign_keys = on，真加 FK
    //    会把合法的 journal 记录挡在门外。dwf_* 之外的任何表都不被引用，也不引用它们。
    // 2) dwf_run 没有节点上限 / token 预算列：run 级
    //    token 用量只作观察面，即 spent_tokens。
    // 3) dwf_node 的 unique(run_id, actor_id, actor_seq) 不可实现：putNode 是准入→结算→统计
    //    回填的 upsert，actor 坐标分散在三个可空列上；每子代理的 actor_seq 唯一性由引擎守。
    //    report / artifact 行有行无节点：一次写入、status 恒为 completed、actor 三列全空。
    // 4) 可空列一律「NULL 即缺席」：result_json / name / tool_call_id / args_json /
    //    resumed_from / resolved_model / message_boundary / artifact_id / input_json 都解码成
    //    缺席的键（args_json 解成 `{}`），不存哑值。
    // 5) 索引即查询形状（列序反了就只能全表扫）：
    //    - dwf_run_cwd_idx：按 cwd 枚举历史 run，「cwd 等值 + time_updated 倒序 + limit」。
    //    - dwf_node_artifact_idx：本 run 的产物行与按 id 取带标签的 report 行。
    //    - dwf_event_artifact_idx：看板取数按 journal sequence 分页，取数源是 dwf_event 而不是
    //      dwf_node；表达式索引（SQLite ≥ 3.9）让它不必扫整条 journal。第三列 sequence 不是
    //      装饰——没有它规划器宁可走 unique(run_id, sequence) 的自动索引再逐行筛产物。
    sql: `
      create table if not exists dwf_run (
        id text primary key,
        parent_session_id text,
        cwd text,
        name text,
        script_text text,
        script_hash text,
        args_json text,
        tool_call_id text,
        resumed_from text,
        caps_max_concurrency integer not null,
        spent_tokens integer not null default 0,
        status text not null check(status in (
          'pending',
          'running',
          'completed',
          'failed',
          'cancelled'
        )),
        result_json text,
        failure_json text,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists dwf_run_cwd_idx on dwf_run(cwd, time_updated);

      create table if not exists dwf_actor (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        name text,
        persona_json text,
        resolved_model text,
        session_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_actor_run_idx on dwf_actor(run_id);

      create table if not exists dwf_node (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        kind text not null check(kind in ('ask', 'world-read', 'world-run', 'report', 'artifact')),
        actor_site_id text,
        actor_ordinal integer,
        actor_seq integer,
        input_hash text not null,
        input_json text,
        status text not null check(status in ('running', 'completed', 'failed')),
        result_json text,
        error_json text,
        stats_json text,
        message_boundary integer,
        artifact_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );

      create index if not exists dwf_node_run_idx on dwf_node(run_id);
      create index if not exists dwf_node_artifact_idx on dwf_node(run_id, artifact_id);

      create table if not exists dwf_event (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        sequence integer not null,
        type text not null,
        payload_json text not null,
        time_created integer not null,
        unique(run_id, sequence)
      );

      create index if not exists dwf_event_artifact_idx
        on dwf_event(run_id, json_extract(payload_json, '$.artifactId'), sequence);
    `,
  },
  {
    appVersion: "0.16.5",
    // 0020–0022 的 SQL 不在本文件：它们由 ./migrations/*.js 导出，
    // 文本同样是 checksum 的一部分。这里只做注册，不要就地改写 SQL 内容；
    // 需要修正只能追加新迁移，并在 runner 侧做前向修复。
    // touchedTables 写在 sql 之后是历史顺序，与对象键顺序无关。
    id: "0020_provider_model_selection",
    // 片段以常量形式注入，本文件不持有其文本；改片段等于改 checksum，
    // 必须走新增迁移，而不是在这里改 import 指向一个“修好的”版本。
    sql: PROVIDER_MODEL_SELECTION_MIGRATION_SQL,
    // 片段实际会改写 message / part / session_entry 三类记录，
    // 清单必须覆盖全部，否则影响分析会低估这次迁移的写入面。
    touchedTables: ["message", "part", "session_entry"],
  },
  {
    appVersion: "0.16.5",
    // 官方 GLM 的会话级选择记录，只动 session_entry；SQL 文本同样在独立模块里。
    // 两条 0020/0021 的先后顺序有意义：后者可能读取前者写入的选择结果，不能对调。
    id: "0021_official_glm_selection",
    // 同上：注册顺序（0020 → 0021 → 0022）本身就是依赖关系，不能按字母或版本重排。
    sql: OFFICIAL_GLM_SELECTION_MIGRATION_SQL,
    // 只写 session_entry，但会改变会话级模型选择；下游读取路径必须同步适配。
    touchedTables: ["session_entry"],
  },
  {
    appVersion: "0.16.5",
    // 回填历史会话的 reasoning 配置；只补缺失项，不覆盖用户已显式设置的值。
    // 回填必须幂等：同一会话被重复迁移时结果保持一致，不能追加多条 entry。
    id: "0022_backfilled_session_reasoning",
    // 回填片段必须只读旧值再写缺失项；它跑在 0021 之后，能看到前者写入的选择结果。
    sql: BACKFILLED_SESSION_REASONING_MIGRATION_SQL,
    // 回填 reasoning 同样只碰 session_entry；与 0021 共享表，因此顺序必须固定。
    touchedTables: ["session_entry"],
  },
  {
    // 0.16.9 的软删除迁移是唯一带 apply 的一条；版本号高于 0019 的 0.16.5，
    // 说明它是在 dwf 基线冻结后才补的，不能为了“归拢版本”把它挪到前面。
    appVersion: "0.16.9",
    // [权衡] 软删除两列既要写进 sql（新库直接建），又要用 apply 探测旧库已有列，
    // 避免重复 alter 报 duplicate column。两条路径必须语义等价，
    // 不能只在一边加列——新库与升级库的最终 schema 必须完全一致。
    // previousIds 记录这条迁移历史上用过的旧编号，只用于承接记账，不是改名许可。
    // pragma table_info 的列名集合必须在同一次读取里快照，边查边改会让判断失真。
    id: "0023_session_soft_delete_outcome",
    // [契约] previousIds 承接历史上用过的旧编号，让早期预览库的记账行仍能匹配到本迁移。
    // 它只能指向同一条迁移的旧名，绝不能拿来给已发布迁移“换号”；
    // 换号会让其它分支的库把同一条迁移执行两次，alter 直接报重复列。
    previousIds: ["0020_session_soft_delete_outcome"],
    // 只加两列；登记仍不可省，软删除会影响所有按 session 列表查询的下游。
    touchedTables: ["session"],
    // [权衡] apply 是在 sql 之外额外执行的一次探测式补丁，只在“列可能已存在”的场景成立。
    // 它不能替代 sql：新库没有历史包袱，仍要靠 sql 建列，两边必须收敛到同一 schema。
    // 这里读 pragma 得到列集合再决定是否 alter，是为了兼容被手工加过列的开发库；
    // 不要把它扩展成通用“缺什么补什么”的框架——那会让 schema 事实分散到运行时。
    apply: (db) => {
      const columns = new Set(
        db
          .prepare("pragma table_info(session)")
          .all()
          .map((row) => row.name),
      );
      if (!columns.has("time_deleted"))
        db.exec("alter table session add column time_deleted integer");
      if (!columns.has("last_outcome")) db.exec("alter table session add column last_outcome text");
    },
    sql: `
      alter table session add column time_deleted integer;
      alter table session add column last_outcome text;
    `,
  },
  // [契约] 末尾直接展开共享包里的身份迁移，保证 CLI 与其它进程写入同一个 DB 身份。
  // 不要把它改写成手写 SQL：身份字段一旦分叉，多进程会各自认为库属于自己，
  // 出现互删 journal 或锁争用。
  { ...SESSION_DATABASE_IDENTITY_MIGRATION, touchedTables: ["zcode_database_identity"] },
];
