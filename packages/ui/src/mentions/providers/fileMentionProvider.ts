// INV-01 只有空或未定义的工作区身份才走本地索引：守住位置 isLocalWorkspaceForFileMentionIndex；改错故障 远程工作区误用本地文件表，结果为空。
// INV-02 mention 值与 markdown 必须用 mentionPath 而非相对路径：守住位置 mapWorkspaceFileToMentionItem；改错故障 多根工作区发出的链接指向错误根。
// INV-03 mention 的 id 必须以绝对路径为键做去重：守住位置 id 拼装与合并 Map；改错故障 同名不同根文件互相覆盖。
// INV-04 markdown 链接文本只用文件名：守住位置 buildFileMentionMarkdown 入参；改错故障 长路径当标题，回显与复制内容退化。
// INV-05 上限优先取查询分组上限，缺省回落显示上限：守住位置 limit 计算；改错故障 各分组条数不一致，列表被截断。
// INV-06 作用域包含连接实例与项目版本，不只是路径：守住位置 scope 依赖数组；改错故障 远程重连后接纳旧宿主结果。
// INV-07 异步结果必须按作用域与查询双匹配才生效：守住位置 current 判定；改错故障 旧查询覆盖新查询的列表。
// INV-08 每次 effect 用 active 标记作废过期响应：守住位置 清理函数；改错故障 快速输入时列表来回跳变。
// INV-09 出错后由作用域重置，不在查询变化时重试：守住位置 effect 首行判断；改错故障 失败重试循环打满宿主。
// INV-10 无命中补扫必须绕过宿主缓存：守住位置 带 refresh 的读取调用；改错故障 缓存期内新文件永远搜不到。
// INV-11 同一规范化查询的补扫只做一次：守住位置 lastMissQuery 记录；改错故障 每次按键都触发全量补扫。
// INV-12 无命中判定必须基于规范化后的非空查询：守住位置 normalizedQuery 条件；改错故障 空查询触发无意义补扫。
// INV-13 项目或会话根读取失败时要抛出明确错误码：守住位置 服务缺失与未找到两处；改错故障 上层无法区分「无根」与「依赖缺失」。
// INV-14 根列表先去重再查询：守住位置 Set 合并；改错故障 同一根被查两次，耗时翻倍。
// INV-15 跨根结果按绝对路径合并，保留首个命中：守住位置 合并 Map；改错故障 同名文件重复出现。
// INV-16 合并后仍要按上限截断：守住位置 末尾 slice；改错故障 多根场景返回条数超过分组上限。
// INV-17 项目变更通过广播事件递增版本，驱动重新查询：守住位置 onMessage 订阅；改错故障 新建项目后根列表不更新。
// INV-18 广播订阅必须在 effect 清理时释放：守住位置 dispose 返回；改错故障 句柄泄漏，重复订阅。
//
// 模块职责：为输入框的文件提及提供跨根工作区文件搜索、去重与展示项映射。
// 状态所有权：查询结果与作用域由本 hook 持有；文件索引与项目数据归宿主服务。
// 阅读顺序：先看本地判定与单条映射，再读 hook 的作用域、上限与两段异步流程，最后看当前结果判定。
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

// 仅当没有工作区身份（本地模式）时才允许使用本地文件索引。
// 远程工作区的文件必须经宿主服务查询，本地索引没有对应内容。
// 空白字符串与未定义一并视为本地，调用方无需先做修剪。
// 返回布尔值而不是抛出，调用方据此在两类提供者之间切换。
// 该判断是纯函数，便于在选择阶段直接复用。
export function isLocalWorkspaceForFileMentionIndex(workspaceIdentity?: string): boolean {
  return !workspaceIdentity?.trim();
}

type ProjectFileEntry = WorkspaceFileEntry & {
  rootPath?: string;
  rootName?: string;
  mentionPath?: string;
};

// 把宿主返回的文件条目补齐为本模块需要的投影。
// mention 路径在多根场景指向完整路径，单根场景退回相对路径。
// 关键字同时收录相对路径与绝对路径，兼容两种输入习惯。
// 数据里保留类型与根名，供输入框渲染文件图标与根标签。
function mapWorkspaceFileToMentionItem(entry: ProjectFileEntry): MentionItem {
  const mentionPath = entry.mentionPath ?? entry.relativePath;
  return {
    id: `file:${entry.path}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: mentionPath,
    // Bugfix: 文件 mention 的标准转译格式需要保持 `[filename](path)`，
    // 之前这里误把整条 relativePath 当成链接文本，导致发送后回显和复制内容都退化成“长路径做标题”。
    // 这里恢复为只用 basename 做 label，路径只放在链接目标里，和输入框 node 样式保持一致。
    markdown: buildFileMentionMarkdown(mentionPath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: entry.relativePath,
      rootName: entry.rootName,
    },
  };
}

function normalizeRefreshQuery(query: string): string {
  return query.trim().toLowerCase();
}

// 参数依次是工作区、工作区身份、查询串、启用开关与展示文案。
// 初始预览上限可由调用方覆盖，用于「显示更多」场景。
// 上下文只带会话与项目标识，用于解析附加根目录。
// 返回结构与其它提及分类保持一致，便于上层统一渲染。
// 结果为空时仍返回加载与错误字段，由面板决定空态文案。
export function useFileMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
  defaultPreviewLimit?: number,
  context?: { sessionId?: string | null; projectId?: string | null },
): MentionCategoryResult {
  const { services } = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const { fileService, projectService } = services;
  const sessionId = context?.sessionId;
  const projectId = context?.projectId;
  const [projectRevision, setProjectRevision] = useState(0);
  useEffect(() => {
    const subscription = services.broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") setProjectRevision((value) => value + 1);
    });
    return () => subscription.dispose();
  }, [services]);
  const limit =
    getMentionGroupLimitForQuery(query, defaultPreviewLimit) ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 连接实例也属于作用域：相同路径的远程重连不能接纳旧 Host 的查询结果。
  // 作用域是「连接 + 工作区 + 项目版本 + 会话」的复合标识。
  // 相同路径的远程重连会得到不同作用域，旧结果随之失效。
  // 错误与最近未命中查询挂在作用域上，随作用域一起重置。
  // 依赖数组必须覆盖所有影响查询结果的输入，否则结果会被误判为当前。
  const scope = useMemo(
    () => ({
      error: null as Error | null,
      lastMissQuery: null as string | null,
    }),
    [
      fileService,
      projectService,
      workspacePath,
      workspaceIdentity,
      enabled,
      sessionId,
      projectId,
      projectRevision,
    ],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: ProjectFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    // 错误态等待面板/工作区/连接生命周期重置，避免 query 变化触发失败重试循环。
    if (!enabled || scope.error) return;
    let active = true;
    setResult({ scope, query, limit, entries: [], loading: true, error: null });
    // 会话优先：sessionId 存在时由 resolveSessionDirectories 返回附加目录，多根场景靠它补齐。
    // 无会话但有 projectId 时读 readProjects 根列表，项目不存在就抛 "project.not-found"，不静默降级。
    // sessionId 与 projectId 都缺失时返回空数组，只保留工作区主根，调用方无需再判空。
    // 根解析在每次查询前执行，因此新建项目下一次查询即可见，不依赖缓存刷新。
    const readRoots = async () => {
      if ((sessionId || projectId) && !projectService)
        throw new Error("project.service-unavailable");
      if (sessionId)
        return (
          await projectService!.resolveSessionDirectories({
            taskId: sessionId,
            workspacePath,
            workspaceIdentity,
          })
        ).additionalDirectories;
      if (projectId) {
        const project = (await projectService!.readProjects()).find(
          (project) => project.id === projectId,
        );
        if (!project) throw new Error("project.not-found");
        return project.roots.map((root) => root.rootPath);
      }
      return [];
    };
    // 主根与附加根合并去重后并发查询，结果顺序由数组保留。
    // 跨根结果按绝对路径去重，先到先得。
    // 查询完成后再检查活跃标记，避免已作废的请求继续写状态。
    const read = async (refresh = false): Promise<ProjectFileEntry[]> => {
      const roots = [...new Set([workspacePath, ...(await readRoots())])];
      if (!active) return [];
      const results = await Promise.all(
        roots.map(async (rootPath) =>
          (
            await fileService.searchWorkspaceFiles({
              rootPath,
              workspaceIdentity,
              query,
              limit,
              ...(refresh ? { refresh: true } : {}),
            })
          ).map((entry) => ({
            ...entry,
            rootPath,
            rootName: rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath,
            mentionPath: rootPath === workspacePath ? entry.relativePath : entry.path,
          })),
        ),
      );
      const unique = new Map<string, ProjectFileEntry>();
      for (const entry of results.flat())
        if (!unique.has(entry.path)) unique.set(entry.path, entry);
      return [...unique.values()].slice(0, limit);
    };
    // 首轮查询未命中且查询非空时，强制绕过缓存补扫一次。
    // 补扫结果同样要检查活跃标记后才写入。
    // 异常统一收敛成 scope.error 交给面板展示，不在此重试，避免与上层重试叠加。
    const search = async () => {
      try {
        let entries = await read();
        if (!active) return;
        const normalizedQuery = normalizeRefreshQuery(query);
        if (entries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          scope.lastMissQuery = normalizedQuery;
          // 无命中补扫必须绕过 Host TTL，否则外部新文件在缓存有效期内永远不可见。
          entries = await read(true);
          if (!active) return;
        }
        setResult({ scope, query, limit, entries, loading: false, error: null });
      } catch (error) {
        if (!active) return;
        scope.error = error instanceof Error ? error : new Error(String(error));
        setResult({ scope, query, limit, entries: [], loading: false, error: scope.error });
      }
    };
    void search();
    // 查询、工作区、连接或面板生命周期变化都使已发出的异步响应失效。
    return () => {
      active = false;
    };
  }, [
    enabled,
    fileService,
    projectService,
    workspacePath,
    workspaceIdentity,
    sessionId,
    projectId,
    query,
    limit,
    scope,
  ]);

  const current =
    enabled && result?.scope === scope && result.query === query && result.limit === limit;
  const items = useMemo(
    () => (current ? result.entries.map(mapWorkspaceFileToMentionItem) : []),
    [current, result],
  );
  return {
    items,
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
    emptyText,
    title,
  };
}
