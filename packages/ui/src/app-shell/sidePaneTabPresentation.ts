// INV-01 搜索面覆盖类型标识：守住位置 分支；改错故障 搜索找不到工作流标签。
// INV-02 会话标识进搜索面：守住位置 演员分支；改错故障 只有会话标识时搜不到。
// INV-03 产物标识进搜索面：守住位置 产物分支；改错故障 按产物标识搜不到。
// INV-04 缺省回退来源路径：守住位置 末尾；改错故障 返回空串。
// INV-05 标题映射缺省用标识：守住位置 空值回退；改错故障 标题空白。
// INV-06 文件管理回退代码查看：守住位置 双字段回退；改错故障 文件标签无标题。
// INV-07 新标签有本地化缺省：守住位置 空值合并；改错故障 显示原始键名。
// INV-08 类型标签覆盖全部种类：守住位置 末尾回退；改错故障 返回未定义。
// INV-09 子代理类型去空白：守住位置 修剪判断；改错故障 标签为空白。
// INV-10 浏览器两类同标题：守住位置 合并判断；改错故障 两处标题不一致。
// INV-11 terminal 与 bash-output 合并：守住位置 分支判断；改错故障 同一标签出现两套文案。
// INV-12 git 复用评审标题：守住位置 映射；改错故障 出现第二套文案。
// INV-13 搜索词包含工具名：守住位置 拼接；改错故障 按工具名检索失败。
// INV-14 搜索词不依赖渲染：守住位置 纯函数；改错故障 折叠时才可搜。
// INV-15 标题本地化交给上层：守住位置 标签入参；改错故障 组件内硬编码语言。
// INV-16 标签接口属性可选：守住位置 可选声明；改错故障 调用方被迫补全所有文案。
// INV-17 映射表不缓存外部状态：守住位置 每次构造；改错故障 语言切换后标题不变。
// INV-18 不改变标签类型：守住位置 返回字符串；改错故障 调用方拿到对象。
//
// 模块职责：侧边栏标签的搜索词、本地化标题与类型标签。
// 状态所有权：文案由调用方注入，本模块只做映射与回退。
// 阅读顺序：先看搜索词，再看标题映射，最后看类型标签。
import { getSidePaneTabTitle } from "@/app-shell/SidePaneTabTrigger.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

export interface SidePaneTabPresentationLabels {
  fileManagerTitle?: string;
  browserTitle: string;
  reviewTitle: string;
  codeViewerTitle: string;
  treemappingTitle: string;
  whiteboardTitle: string;
  modelTrajectoryTitle: string;
  developerToolsTitle: string;
  pluginMarketTitle: string;
  newTabTitle?: string;
  browserPermissionsTitle: string;
  terminalTitle: string;
  subagentTypeLabel: string;
  subagentDirectoryTitle: string;
  selectionChatTitle: string;
  planTitle: string;
  workflowRunTitle: string;
  workflowDirectoryTitle: string;
  workflowActorTitle: string;
  workflowScriptTitle: string;
  workflowArtifactTitle: string;
}

// searchHint 按标签类型拼接可检索词，字段之间用空格分隔。
// workflow-run 等三类拼入工具名，用户可按 CreateWorkflow 检索。
// 产物标签拼入 artifact id，避免同名产物只能靠标题区分。
// 未命中分支回退到 source.path，保证搜索面不为空。
// 函数只读入参不访问 store，折叠前后搜索结果一致。
export function getSidePaneTabSearchHint(tab: WorkspaceSidePaneTab): string {
  if (tab.type === "plan-detail") {
    return `${tab.parentSessionId} ${tab.toolCallId} plan ExitPlanMode`;
  }
  if (tab.type === "plugin-ui") {
    return `${tab.title} ${tab.pluginId} ${tab.toolCallId ?? tab.surfaceId ?? ""} plugin ui`;
  }
  if (tab.type === "workflow-run") {
    return `${tab.workflowName ?? ""} ${tab.runId} ${tab.toolCallId} ${tab.parentSessionId} workflow run CreateWorkflow AmendWorkflow`;
  }
  if (tab.type === "workflow-directory") {
    return `${tab.parentSessionId} workflow runs directory history ended`;
  }
  if (tab.type === "workflow-actor-session") {
    // 会话 id 也进搜索面：排查时手里往往只有它（日志与 journal 都记它）。
    return `${tab.actorName ?? ""} ${tab.siteId}@${tab.ordinal} ${tab.actorSessionId ?? ""} ${tab.runId} ${tab.parentSessionId} workflow subagent actor transcript`;
  }
  if (tab.type === "workflow-workspace") {
    return `${tab.workflowName ?? ""} ${tab.runId} ${tab.toolCallId} ${tab.parentSessionId} workflow script steps workspace transcript files git run`;
  }
  if (tab.type === "workflow-artifact") {
    // 产物 id 是脚本里写死的字面量，用户与排查者手里往往就是它。
    return `${tab.title ?? ""} ${tab.artifactId} ${tab.runId} ${tab.parentSessionId} workflow artifact deliverable`;
  }
  if (tab.type === "selection-side-chat") {
    return `${tab.parentSessionId} ${tab.childSessionId} ${tab.ordinal} selection side chat`;
  }
  if (tab.type === "subagent-session") {
    return `${tab.title ?? ""} ${tab.subagentType} ${tab.parentSessionId} ${tab.childSessionId}`;
  }
  if (tab.type === "subagent-directory") {
    return `${tab.rootSessionId} ${tab.parentSessionId} subagent directory`;
  }
  if (tab.type === "browser-permissions") return `${tab.origin} permissions settings`;
  if (tab.type === "browser") return tab.initialUrl ?? "";
  if (tab.type === "browser-use") {
    return `${tab.title ?? ""} ${tab.sessionId} browser use`;
  }
  if (tab.type === "new-tab") return "new tab launcher";
  if (tab.type === "git") return "git diff";
  if (tab.type === "treemapping") return "file activity diff map treemapping";
  if (tab.type === "whiteboard") return `${tab.title} whiteboard canvas draw sketch`;
  if (tab.type === "model-trajectory") {
    return `${tab.title ?? ""} ${tab.taskId} model trajectory call io`;
  }
  if (tab.type === "plugin-market") return "plugin marketplace store plugins";
  if (tab.type === "developer-tools") {
    return "developer tools token debug network status request response headers";
  }
  if (tab.type === "terminal" || tab.type === "bash-output")
    return `${tab.title} terminal shell command`;
  if (tab.type === "file-manager") return `${tab.target.workspacePath} ${tab.source?.path ?? ""}`;
  return tab.source.path ?? tab.source.title;
}

// getSidePaneTabTitle 是统一入口，所有标签都从这里取标题。
// 描述符 id 查 titleByMessageId，命中即返回本地化文案。
// 表中缺该 id 时回退 descriptor.id，至少不会显示空白。
// file-manager 复用 codeViewerTitle，两个标签保持同一套文案。
// 文案全部由 labels 注入，本模块不内置任何语言字符串。
export function getLocalizedSidePaneTabTitle(
  tab: WorkspaceSidePaneTab,
  labels: SidePaneTabPresentationLabels,
): string {
  return getSidePaneTabTitle(tab, (descriptor) => {
    // 键名与 labels 字段一一对应，新增描述符要同步补行。
    // 可选标题按 labels 字段 ?? 回退，调用方无需补全全部文案。
    // 不在表中的 key 原样返回，避免显示 undefined。
    // 映射表每次由 labels 重新构造，语言切换后立即生效。
    const titleByMessageId: Record<string, string> = {
      "sidePane.newTab": labels.newTabTitle ?? "New tab",
      "fileManager.title": labels.fileManagerTitle ?? labels.codeViewerTitle,
      "browser.title": labels.browserTitle,
      "browser.permission.settings": labels.browserPermissionsTitle,
      "sidePane.review": labels.reviewTitle,
      "codeViewer.title": labels.codeViewerTitle,
      "treemapping.title": labels.treemappingTitle,
      "whiteboard.title": labels.whiteboardTitle,
      "modelTrajectory.title": labels.modelTrajectoryTitle,
      "developerTools.title": labels.developerToolsTitle,
      "workspace.openPluginsSettings": labels.pluginMarketTitle,
      "terminal.title": labels.terminalTitle,
      "sidePane.subagent": labels.subagentTypeLabel,
      "sidePane.subagentDirectory": labels.subagentDirectoryTitle,
      "sidePane.selectionChat": labels.selectionChatTitle,
      "planTool.panel.planTab": labels.planTitle,
      "sidePane.workflowRun": labels.workflowRunTitle,
      "sidePane.workflowActor": labels.workflowActorTitle,
      "sidePane.workflowScript": labels.workflowScriptTitle,
      "sidePane.workflowArtifact": labels.workflowArtifactTitle,
    };
    return titleByMessageId[descriptor.id] ?? descriptor.id;
  });
}

// 先判 subagent 类型，命中即返回子代理标签。
// browser 与 browser-permission 共用 browserTitle，避免两处不一致。
// terminal 与 bash-output 共用 terminalTitle，输出面板不另起文案。
// 末尾回退 codeViewerTitle，未知类型也有可读名称。
export function getSidePaneTabTypeLabel(
  tab: WorkspaceSidePaneTab,
  labels: SidePaneTabPresentationLabels,
): string {
  if (tab.type === "new-tab") return labels.newTabTitle ?? "New tab";
  if (tab.type === "plan-detail") return labels.planTitle;
  if (tab.type === "plugin-ui") return tab.title;
  if (tab.type === "workflow-run") return labels.workflowRunTitle;
  if (tab.type === "workflow-directory") return labels.workflowDirectoryTitle;
  if (tab.type === "workflow-actor-session") return labels.workflowActorTitle;
  if (tab.type === "workflow-workspace") return labels.workflowScriptTitle;
  if (tab.type === "workflow-artifact") return labels.workflowArtifactTitle;
  if (tab.type === "selection-side-chat") return labels.selectionChatTitle;
  if (tab.type === "subagent-session") {
    return tab.subagentType.trim() || labels.subagentTypeLabel;
  }
  if (tab.type === "subagent-directory") return labels.subagentDirectoryTitle;
  if (tab.type === "browser" || tab.type === "browser-use") return labels.browserTitle;
  if (tab.type === "browser-permissions") return labels.browserPermissionsTitle;
  if (tab.type === "file-manager") return labels.fileManagerTitle ?? labels.codeViewerTitle;
  if (tab.type === "git") return labels.reviewTitle;
  if (tab.type === "treemapping") return labels.treemappingTitle;
  if (tab.type === "whiteboard") return labels.whiteboardTitle;
  if (tab.type === "model-trajectory") return labels.modelTrajectoryTitle;
  if (tab.type === "developer-tools") return labels.developerToolsTitle;
  if (tab.type === "terminal" || tab.type === "bash-output") return labels.terminalTitle;
  return labels.codeViewerTitle;
}
