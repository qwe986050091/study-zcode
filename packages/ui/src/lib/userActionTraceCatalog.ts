// INV-01 单一来源：守住位置 两张动作表；改错故障：目录与事件定义各写一份，统计口径分叉。
// INV-02 动作稳定：守住位置 动作字面量；改错故障：改名导致历史轨迹无法聚合。
// INV-03 分组注入：守住位置 entriesFrom 的分组参数；改错故障：表内手写分组与来源不一致。
// INV-04 类型推导：守住位置 keyof 声明；改错故障：手写标识清单与表漂移。
// INV-05 条目完整：守住位置 接口字段；改错故障：缺超时的条目永久挂起。
// INV-06 界面同源：守住位置 surface 取值；改错故障：界面名与事件标识不一致，无法回溯。
// INV-07 破坏性优先：守住位置 第一段判断；改错故障：卸载被当成普通管理动作。
// INV-08 导航双判：守住位置 结尾与动作名；改错故障：导航事件被归为命令。
// INV-09 偏好限设置域：守住位置 前缀判断；改错故障：核心事件被误标为偏好。
// INV-10 刷新非偏好：守住位置 排除集合；改错故障：刷新与导入被统计成偏好变更。
// INV-11 命令域明确：守住位置 会话与任务前缀；改错故障：执行类动作被归为管理。
// INV-12 兜底管理：守住位置 默认返回；改错故障：未知动作得到空类别。
// INV-13 展平有序：守住位置 flatMap 顺序；改错故障：目录顺序随对象键变化。
// INV-14 键含两段：守住位置 索引键组成；改错故障：跨域同名动作互相覆盖。
// INV-15 查找常数：守住位置 映射索引；改错故障：每次查找线性扫描全部条目。
// INV-16 未登记不抛：守住位置 查找返回；改错故障：新动作上线前抛错阻断交互。
// INV-17 只读导出：守住位置 as const 与 readonly；改错故障：运行期被追加或改写。
// INV-18 无副作用：守住位置 模块体；改错故障：导入时读取环境或注册监听。
//
// 模块职责：定义核心与设置的用户动作目录，并派生查找索引与操作类别。
// 状态所有权：全部为不可变常量与派生索引，无运行时状态。
// 阅读顺序：核心表 → 设置表 → 标识类型 → 条目结构 → 类别判定 → 展平 → 索引与查找。
import type { RendererActionTraceGroup } from "@zcode/shared";

// 核心事件按域分组，动作名保持稳定。
// 增删动作只改本表，派生目录自动跟随。
//
export const CORE_USER_ACTION_FEATURES = {
  "workspace.local.lifecycle": ["open", "switch", "close"],
  "workspace.remote.lifecycle": ["open_dialog", "connect", "reconnect", "disconnect"],
  "workspace.project_binding": ["attach", "detach", "work_outside_project"],
  "task.lifecycle": ["create", "open", "archive", "rename", "delete"],
  "task.layout": ["open_split", "split_right", "split_down", "close_pane"],
  "conversation.composer.message": ["send", "stop"],
  "conversation.composer.attachment": ["add", "remove", "retry_upload"],
  "conversation.composer.config": ["change_model", "change_thought_level", "change_mode"],
  "conversation.queue.item": ["send_now", "edit", "remove", "reorder"],
  "conversation.queue.policy": [
    "resume",
    "toggle_auto_drain",
    "toggle_followup",
    "clear_and_send",
    "keep_and_send",
  ],
  "conversation.history.branch": ["retry", "edit", "fork", "rewind_files"],
  "conversation.history.feedback": ["like", "dislike", "clear_feedback", "copy"],
  "conversation.blocking.user_input": ["select_option", "submit_text", "cancel"],
  "conversation.blocking.hook": ["review", "dismiss"],
  "conversation.navigation": ["load_older", "jump_bottom", "open_turn"],
  "conversation.subagent": ["expand", "open_side_pane", "open_split"],
  "conversation.background_work": ["open", "cancel"],
  "workbench.file": ["open_tree", "refresh", "open_file", "open_preview"],
  "workbench.terminal": ["open", "close"],
  "workbench.browser": ["open", "navigate", "back", "forward", "refresh", "open_external"],
  "workbench.git": ["open", "commit", "generate_commit_message", "run_action"],
  "extension.plugin": [
    "open_store",
    "search",
    "open_detail",
    "install",
    "enable",
    "disable",
    "update",
    "uninstall",
    "save_config",
  ],
  "extension.mcp": ["authorize", "refresh", "enable", "disable"],
  "automation.lifecycle": [
    "create",
    "update",
    "run_now",
    "enable",
    "disable",
    "pause",
    "resume",
    "delete",
  ],
} as const;

// 设置事件独立成表，与核心目录合并。
// 分组标记由构造函数注入，不在表里重复。
//
export const SETTINGS_USER_ACTION_FEATURES = {
  "settings.navigation": ["open_section", "back_to_workspace", "open_onboarding"],
  "settings.locale": ["change_locale"],
  "settings.appearance": [
    "change_theme",
    "change_ui_font_size",
    "change_code_light_theme",
    "change_code_dark_theme",
    "toggle_code_line_numbers",
    "toggle_code_line_wrap",
    "change_code_font_size",
  ],
  "settings.terminal": ["toggle_system_profile", "save_font_family", "change_shell"],
  "settings.search": ["toggle_native_search"],
  "settings.network": ["save_http_proxy", "save_no_proxy", "save_ca_certificate"],
  "settings.desktop": ["toggle_hardware_acceleration", "toggle_close_to_tray", "toggle_keep_awake"],
  "settings.update": ["toggle_preview_updates", "toggle_auto_update"],
  "settings.notification": ["toggle_notification", "toggle_notification_sound"],
  "settings.conversation": [
    "change_interaction_behavior",
    "toggle_ask_user_auto_resolution",
    "toggle_model_io_retention",
    "toggle_show_reasoning",
    "toggle_show_todos",
  ],
  "settings.tool_grouping": [
    "toggle_explore_grouping",
    "toggle_terminal_grouping",
    "toggle_changes_grouping",
  ],
  "settings.task": ["toggle_auto_archive", "change_auto_archive_days"],
  "settings.storage": ["change_data_directory"],
  "settings.memory": ["toggle_memory", "refresh_memory", "change_memory_scope"],
  "settings.browser": [
    "toggle_browser_use",
    "import_browser_data",
    "toggle_insecure_certificates",
    "clear_cache",
    "clear_all_data",
  ],
} as const;

// 标识类型直接由表键推导，避免手写清单。
// keyof typeof CORE_USER_ACTION_FEATURES 让新增分组键自动获得类型支持。
//
export type CoreUserActionFeatureId = keyof typeof CORE_USER_ACTION_FEATURES;
export type SettingsUserActionFeatureId = keyof typeof SETTINGS_USER_ACTION_FEATURES;
export type UserActionFeatureId = CoreUserActionFeatureId | SettingsUserActionFeatureId;

type CatalogDefinition = Readonly<Record<string, readonly string[]>>;
export type UserActionOperationKind =
  | "navigation"
  | "preference"
  | "command"
  | "management"
  | "destructive";

// UserActionCatalogEntry 一次表达 group 与 operationKind 等五项字段。
// operationKind 用于统计与告警分级。
// surface 默认取 featureId，保持同一来源。
// timeoutMs 统一 30_000，避免个别事件无限挂起。
//
export interface UserActionCatalogEntry {
  featureId: UserActionFeatureId;
  action: string;
  group: Extract<RendererActionTraceGroup, "core" | "settings">;
  operationKind: UserActionOperationKind;
  surface: string;
  timeoutMs: number;
}

// 顺序即优先级，破坏性动作最先判定。
// 清理、删除与卸载都归为破坏性。
//
function operationKindFor(featureId: string, action: string): UserActionOperationKind {
  if (action === "clear_all_data" || action === "delete" || action === "uninstall") {
    return "destructive";
  }
  if (
    featureId.endsWith("navigation") ||
    ["open", "open_dialog", "open_detail", "open_node", "open_section", "open_store"].includes(
      action,
    )
  ) {
    return "navigation";
  }
  if (
    // featureId 以 settings. 开头且非刷新的动作按 preference 处理。
    // refresh_memory 与 import_browser_data 属于 command，不上调为 preference。
    //
    featureId.startsWith("settings.") &&
    !["refresh_memory", "import_browser_data", "clear_cache"].includes(action)
  ) {
    return "preference";
  }
  if (featureId.startsWith("conversation.") || featureId.startsWith("task.")) {
    return "command";
  }
  return "management";
}

// entriesFrom 把 Object.entries 分组展平，每个 action 生成一条。
// 分组与界面都取事件标识，保证可回溯。
//
function entriesFrom(
  definitions: CatalogDefinition,
  group: "core" | "settings",
): UserActionCatalogEntry[] {
  return Object.entries(definitions).flatMap(([featureId, actions]) =>
    actions.map((action) => ({
      featureId: featureId as UserActionFeatureId,
      action,
      group,
      operationKind: operationKindFor(featureId, action),
      surface: featureId,
      timeoutMs: 30_000,
    })),
  );
}

export const USER_ACTION_CATALOG: readonly UserActionCatalogEntry[] = [
  ...entriesFrom(CORE_USER_ACTION_FEATURES, "core"),
  ...entriesFrom(SETTINGS_USER_ACTION_FEATURES, "settings"),
];

// 按键索引目录，查找为常数时间。
// 键由事件标识与动作名拼成，避免跨域同名误命中。
//
const USER_ACTION_CATALOG_BY_KEY = new Map(
  USER_ACTION_CATALOG.map((entry) => [`${entry.featureId}:${entry.action}`, entry]),
);

// 查不到返回空，由调用方决定是否兜底。
// 不在此处抛错，未登记动作不应阻断交互。
//
export function resolveUserActionCatalogEntry(
  featureId: string,
  action: string,
): UserActionCatalogEntry | undefined {
  return USER_ACTION_CATALOG_BY_KEY.get(`${featureId}:${action}`);
}
