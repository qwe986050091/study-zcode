// ============================================================
// Project local settings (permission / mode)
// ============================================================
// 定位：项目级权限规则与协作模式的读写，落在通用 local_setting 表的
// (scope, scope_id, namespace, key) 复合主键下；permission 表仅为兼容旧数据的回退源。
// 输入输出：get 返回 PermissionRuleset / CollaborationMode；不存在或内容无法解析
// 时返回 null（null = “未设置”，不是“空规则”）。save 返回写入后的值。
// 副作用：insert/update local_setting（upsert 覆盖 value/schema_version/time_updated）。
// 失败语义：saveProjectPermission 写入后读不到 → throw，防止静默丢配置；
// 非法的 mode 字符串读取时返回 null，绝不猜测默认模式。
// 不变量：同一 (project, "permission", key) 唯一；写入 value 为 JSON 文本；
// time_created 保留首次写入，只有 time_updated 更新。

import type { DatabaseSync } from "node:sqlite";
import type { CollaborationMode, PermissionRuleset, ProjectId } from "@zcode/contracts";
import { isCollaborationMode } from "../codecs.js";
import { decodeJson } from "../json.js";
import type { LocalSettingRow, PermissionRow } from "../rows.js";

/**
 * 读取项目权限规则：优先新位置 local_setting(permission/ruleset)，读不到再回退
 * 旧 permission 表（迁移兼容）。两处都没有/JSON 损坏 → null。
 */
export async function getProjectPermission(
  db: DatabaseSync,
  projectID: ProjectId,
): Promise<PermissionRuleset | null> {
  const setting = readLocalSetting(db, {
    key: "ruleset",
    namespace: "permission",
    scope: "project",
    scopeID: projectID,
  });
  if (setting) {
    return decodeJson<PermissionRuleset>(setting.value) ?? null;
  }

  const row = db.prepare("select * from permission where project_id = ?").get(projectID) as
    | PermissionRow
    | undefined;
  return row ? (decodeJson<PermissionRuleset>(row.data) ?? null) : null;
}

/**
 * 保存项目权限规则（upsert local_setting），返回写入后读回的值。
 * 读回失败直接 throw：调用方拿到的返回必须与磁盘一致。
 */
export async function saveProjectPermission(
  db: DatabaseSync,
  input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  },
): Promise<PermissionRuleset> {
  const now = Date.now();
  writeLocalSetting(db, {
    key: "ruleset",
    namespace: "permission",
    schemaVersion: 1,
    scope: "project",
    scopeID: input.projectID,
    time: now,
    value: JSON.stringify(input.permission),
  });

  const saved = await getProjectPermission(db, input.projectID);
  if (!saved) {
    throw new Error(`Project permission not found after write: ${input.projectID}`);
  }
  return saved;
}

// 读取项目协作模式：未设置返回 null；存了非法枚举同样返回 null（不做默认猜测）。
export function getProjectPermissionMode(
  db: DatabaseSync,
  projectID: ProjectId,
): CollaborationMode | null {
  const setting = readLocalSetting(db, {
    key: "mode",
    namespace: "permission",
    scope: "project",
    scopeID: projectID,
  });
  if (!setting) return null;

  const value = decodeJson<{ mode?: unknown }>(setting.value);
  return isCollaborationMode(value?.mode) ? value.mode : null;
}

// 保存项目协作模式，返回入参 mode；写入失败会让上层感知（异常），不会假报成功。
export function saveProjectPermissionMode(
  db: DatabaseSync,
  input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  },
): CollaborationMode {
  const now = Date.now();
  writeLocalSetting(db, {
    key: "mode",
    namespace: "permission",
    schemaVersion: 1,
    scope: "project",
    scopeID: input.projectID,
    time: now,
    value: JSON.stringify({ mode: input.mode }),
  });
  return input.mode;
}

// 精确四元组查询；未命中返回 undefined（不含默认值）。
function readLocalSetting(
  db: DatabaseSync,
  input: {
    key: string;
    namespace: string;
    scope: string;
    scopeID: string;
  },
): LocalSettingRow | undefined {
  return db
    .prepare(
      `
      select value from local_setting
      where scope = ? and scope_id = ? and namespace = ? and key = ?
      `,
    )
    .get(input.scope, input.scopeID, input.namespace, input.key) as LocalSettingRow | undefined;
}

// upsert：冲突时只改 value/schema_version/time_updated，保留首次 time_created。
function writeLocalSetting(
  db: DatabaseSync,
  input: {
    key: string;
    namespace: string;
    schemaVersion: number;
    scope: string;
    scopeID: string;
    time: number;
    value: string;
  },
): void {
  db.prepare(
    `
      insert into local_setting (
        scope, scope_id, namespace, key, value, schema_version, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope, scope_id, namespace, key) do update set
        value = excluded.value,
        schema_version = excluded.schema_version,
        time_updated = excluded.time_updated
      `,
  ).run(
    input.scope,
    input.scopeID,
    input.namespace,
    input.key,
    input.value,
    input.schemaVersion,
    input.time,
    input.time,
  );
}
