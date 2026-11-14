// INV-01 守住位置：catalogRequestIdRef 是目录加载唯一的并发裁决凭据。改错故障：改用对象身份或时间戳比较，陈旧响应会通过校验并覆盖新目录。
// INV-02 守住位置：任何写入 catalogState、workspaces、catalogError 之前先比对请求序号。改错故障：错误分支先行落地，会出现错误提示与旧列表同时显示。
// INV-03 守住位置：记忆关闭或视图不可用时同样自增序号。改错故障：在途响应在清理之后回写，开关已关闭却仍渲染出工作区列表。
// INV-04 守住位置：失败路径必须同时清空 workspaces 与 selectedWorkspaceId。改错故障：残留选中项指向不存在的目录，详情面板读取到上一轮快照。
// INV-05 守住位置：projectMemoryViewerAvailable 是挂载查看器的硬前置。改错故障：不支持项目记忆的环境仍发起目录请求，并显示空白面板。
// INV-06 守住位置：展示名替换只作用于 label 字段。改错故障：把替换结果写回 id 或其他字段，会让工作区身份与选择逻辑错位。
// INV-07 守住位置：同一 slug 对应多个展示名时降级为原始 label。改错故障：让先到者获胜，排序或过滤变化会让同一目录在不同会话显示不同名称。
// INV-08 守住位置：排序主键取调用方给出的顺序，次键取目录下标。改错故障：改按 label 排序后，顺序随语言与返回顺序漂移，选中项视觉位置跳变。
// INV-09 守住位置：选中项由 id 从当前展示列表反查，另有 effect 收敛到合法值。改错故障：缓存 workspace 对象会持有过期引用，刷新后展示旧数据。
// INV-10 守住位置：组件只依赖 listProjectMemories 这一个目录读取能力。改错故障：放宽为完整记忆服务后，本层获得越权写入口，形成第二条写入路径。
// INV-11 守住位置：目录加载是纯读取，不在此写入或删除记忆。改错故障：刷新动作产生副作用，用户点刷新即改变数据，且失败后无法回滚。
// INV-12 守住位置：开关真值完全由 memoryEnabled 与 onMemoryEnabledChange 决定。改错故障：组件内再存一份开关状态，两处会在异步失败后长期不一致。
// INV-13 守住位置：刷新经 runUserActionAsync 包裹并标记失败阶段。改错故障：直接调用加载函数会丢失用户动作埋点，失败无法归因到具体阶段。
// INV-14 守住位置：目录不跨租户或跨工作区复用，列表随 memoryService 变化整体重载。改错故障：沿用旧列表会把 A 工作区目录展示在 B 工作区下。
// INV-15 守住位置：本组件不承担持久化，不读写本地存储。改错故障：在此落盘会与服务端事实分叉，重启后出现无法解释的开关或列表状态。
// INV-16 守住位置：列表为空时选中 id 必须回到 null，状态回到 idle 语义。改错故障：保留旧 id 会让后续新列表误命中同 id，跳过默认选中。
// INV-17 守住位置：所有用户可见文案经 intl.formatMessage 取得。改错故障：硬编码中文会在其他语言下漏翻，且文案长度变化破坏行内布局。
// INV-18 守住位置：本地提示、无内容、查看器三个渲染分支互斥。改错故障：分支重叠会同时渲染提示与查看器，或在不支持环境挂载空组件。
//
// 模块职责：设置页的「工作区记忆」分区，负责开关展示、项目记忆目录的加载与展示投影，以及把查看器回调转发给父层。
// 状态所有权：开关真值与持久化归父层，目录数据、加载状态、错误与选中项是本组件局部状态，不构成第二份业务事实。
// 阅读顺序：先看服务依赖与展示名 slug 工具，再看请求序号与刷新回调，接着看目录生命周期 effect、排序投影、选中收敛，最后看渲染分支。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type IMemoryService, type ProjectMemoryWorkspaceSummary } from "@zcode/services";
import { TID_SETTINGS_MEMORY_SWITCH } from "@zcode/shared/test-ids";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

// 只声明本组件真正用到的目录读取能力，避免把整个记忆服务塞进组件依赖面。
// 依赖收窄后，父层替换实现只需满足同一签名，因此不得在此追加写入、删除或事件订阅方法。
// 若改回完整服务类型，组件会获得越权写入口，目录刷新与父层状态将出现第二条写入路径。
type MemoryCatalogService = Pick<IMemoryService, "listProjectMemories">;

// 展示名 slug 只用于跨来源匹配，不参与持久化或身份判定，因此可以安全地丢失大小写与符号差异。
// 先小写、再把字母数字点划之外的字符折叠为连字符、再裁掉首尾连字符，最后截断到 48 个字符以限制匹配键长度。
// slug 为空时回退固定值 project，保证映射键始终非空，避免空串把多个工作区意外聚合成一项。
// 改错会怎样：若去掉截断或首尾裁剪，仅前 48 位相同或仅符号不同的工作区会被判为同一项，展示名可能张冠李戴。
function normalizeWorkspaceDisplayName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

// 目标是把调用方给出的展示名按 slug 建成查找表，同名 slug 只保留一个确定值。
// 同一 slug 出现两个不同展示名时删除已记录项并标记 ambiguous，而不是让先到者获胜，避免顺序决定展示结果。
// 已被标记 ambiguous 的 slug 后续直接跳过，因此输出映射里缺席即代表不可用，调用方必须回退原始 label。
// 改错会怎样：若保留先到者，工作区排序或过滤变化会让同一目录在不同会话显示不同名称，难以排查。
function buildWorkspaceDisplayNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeWorkspaceDisplayName(displayName);
    if (!displayName || !slug || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryEnabled,
  memoryService,
  onMemoryEnabledChange,
  projectMemoryViewerAvailable,
  workspaceDisplayNames = [],
}: {
  memoryEnabled: boolean;
  memoryService: MemoryCatalogService;
  onMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  projectMemoryViewerAvailable: boolean;
  workspaceDisplayNames?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  // 请求序号是整个目录加载唯一的并发裁决依据，放在 ref 里保证每次渲染读到最新值而不触发重渲染。
  // 每次发起加载先自增并写回，响应回来时与捕获值比较；不相等说明期间已有更新的请求或已关闭视图。
  // 关闭记忆或视图不可用时同样自增，使在途响应立即作废，无需中止信号也能避免旧数据回写。
  // 序号只做单调递增，不得重置为 0，否则新旧请求可能拿到相同编号而互相通过校验。
  // 改错会怎样：把序号放进 state 或用对象身份比较，都会让并发响应通过校验，出现旧目录覆盖新目录的闪烁。
  const catalogRequestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);

  // 该回调只负责一次目录读取与状态收敛，成功置 ready 并返回结果，失败置 error 并返回 null。
  // 捕获阶段先比对序号再落地状态，任何写状态之前都必须通过这道闸门，错误分支也不例外。
  // 失败时清空 workspaces 与 selectedWorkspaceId，防止错误提示与上一轮旧列表同时出现。
  // 返回值供刷新按钮的遥测包装使用，但组件渲染不依赖它，调用方可以安全忽略。
  // 依赖只有 memoryService：它的身份变化会重建回调并触发外层 effect 重新加载，因此不得在此引用其他可变闭包。
  const refreshCatalog = useCallback(async (): Promise<ProjectMemoryWorkspaceSummary[] | null> => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories();
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces(result);
      setCatalogState("ready");
      return result;
    } catch (error) {
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
      return null;
    }
  }, [memoryService]);

  useEffect(() => {
    if (memoryEnabled && projectMemoryViewerAvailable) {
      void refreshCatalog();
      return;
    }

    catalogRequestIdRef.current += 1;
    setCatalogState("idle");
    setCatalogError(null);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
  // 该 effect 是目录生命周期的唯一入口：开启且视图可用就加载，其余情况一律回到 idle 并清空派生数据。
  // 关闭分支先自增序号再清状态，顺序颠倒会让在途响应在清理之后写回，出现关掉开关仍有列表的假象。
  // 依赖包含 refreshCatalog，因此 memoryService 换实例也会触发一次完整重载，这是预期行为而非多余请求。
  // 改错会怎样：漏掉任一依赖会让开关或可用性变化后仍显示旧目录，用户会以为数据没有随设置更新。
  }, [memoryEnabled, projectMemoryViewerAvailable, refreshCatalog]);

  // 这一层只做展示投影：保留原始 workspace 字段，仅替换 label，并把调用方给定的顺序作为主排序键。
  // orderBySlug 记录每个 slug 首次出现的下标，保证同名重复项取最靠前的位置；目录中不存在的 slug 落到正无穷。
  // 排序先比 order 再比 catalogIndex，第二键保证未知项之间仍保持服务返回顺序，避免每次渲染抖动。
  // 改错会怎样：若直接按 label 排序或忽略 catalogIndex，工作区顺序会随语言与返回顺序漂移，选中项视觉位置跳变。
  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  // 选中项是从展示列表按 id 反查的派生值，不另存对象，列表变化后自然失效而不会指向已消失的工作区。
  // 紧随其后的 effect 负责把选中 id 收敛到合法值：列表为空置 null，id 缺失或不在列表内则回退第一项。
  // 改错会怎样：若把 workspace 对象本身存进状态，刷新后仍持有旧引用，详情面板会展示过期数据。
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  // 刷新按钮统一经 runUserActionAsync 包裹，业务实现仍是 refreshCatalog，遥测只观察不改变结果。
  // 失败阶段固定标记为 catalog_refresh，便于按阶段区分读取失败与本地提交失败。
  // 改错会怎样：直接调用加载函数会丢失用户动作埋点，失败也无法归因到具体阶段。
  const handleRefresh = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.memory", action: "refresh_memory", trigger: "button" },
      operation: refreshCatalog,
      completed: { resultSource: "platform_result" },
      failureStage: "catalog_refresh",
    });
  }, [refreshCatalog]);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.memory.workspaceMemory",
          })}
          description={intl.formatMessage({
            id: "settings.memoryDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.memory.workspaceMemory",
              })}
              checked={memoryEnabled}
              data-testid={TID_SETTINGS_MEMORY_SWITCH}
              onCheckedChange={(checked) => {
                void onMemoryEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      {!projectMemoryViewerAvailable ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.localOnly" })}
        </div>
      ) : !memoryEnabled ? null : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          onRefresh={handleRefresh}
          onScopeKeyChange={(workspaceId) =>
            runUserAction({
              input: {
                featureId: "settings.memory",
                action: "change_memory_scope",
                trigger: "select",
              },
              operation: () => setSelectedWorkspaceId(workspaceId),
              completed: { resultSource: "local_commit" },
              failureStage: "local_commit",
            })
          }
        />
      )}
    </div>
  );
}
