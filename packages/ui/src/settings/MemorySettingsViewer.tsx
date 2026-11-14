// INV-01 展示投影：本组件只消费父级下发的 workspaces 与 selectedWorkspace，不自行拉取数据。守住位置：组件入参与渲染体。改错故障：组件内再取一次目录会形成第二份事实，刷新后列表与设置页状态分叉。
// INV-02 状态所有权：catalogState 与 catalogError 都由 MemorySettingsSection 写入。守住位置：禁止在组件内改写这两个值。改错故障：本地覆盖会让错误提示与真实请求生命周期脱钩。
// INV-03 搜索纯前端：visibleFiles 只由 selectedWorkspace 与归一化查询串推导。守住位置：useMemo 的两个依赖。改错故障：漏依赖会让输入后仍显示旧结果，多依赖会重复过滤。
// INV-04 归一化一致：查询串与文件名都用 toLocaleLowerCase 折叠。守住位置：normalizedSearchQuery 与 filter 回调。改错故障：只折叠一侧会出现大小写永远不匹配的条目。
// INV-05 空查询不全空：只有查询非空且过滤结果为空才展示搜索空态。守住位置：列表区三元条件。改错故障：空目录会被误报为无匹配，刷新入口一起消失。
// INV-06 早返回有序：catalogError 先于 loading，loading 先于缺省 workspace。守住位置：三个提前返回的排列。改错故障：顺序调整会让错误态不可达，用户只看到空列表。
// INV-07 首次加载才占位：loading 分支额外要求 workspaces 为空。守住位置：该分支的 length 判断。改错故障：刷新时整块闪白，搜索词与滚动位置丢失。
// INV-08 搜索受控：value、clear、change 全部回写同一份 searchQuery。守住位置：SettingsSearchInput 的三处绑定。改错故障：受控值缺失后清空按钮与实际过滤条件不一致。
// INV-09 计数用全量：头部计数取 files.length，不取过滤后的数量。守住位置：formatMemoryCount 的实参。改错故障：计数随输入变化，用户误以为记忆文件被删除。
// INV-10 单复数分叉：count 为 1 时走 one 文案，其余走 other。守住位置：文案 id 内的三元选择。改错故障：英文界面出现 1 memories，国际化校验也会失败。
// INV-11 缺失回落：selectedWorkspace 不存在时 filter 结果回落为空数组。守住位置：useMemo 内的空数组兜底。改错故障：继续读取 length 会抛错，整个记忆页白屏。
// INV-12 时间自走：now 由六十秒定时器推进，卸载时必须清理。守住位置：useEffect 的返回函数。改错故障：泄漏的 interval 在卸载后继续写状态，触发警告。
// INV-13 时间格式化外置：相对时间交给 formatMemoryUpdatedAt，并复用同一个 now。守住位置：该调用的四个实参。改错故障：各处重新取当前时间会让同一行文案在相邻渲染间跳变。
// INV-14 图标契约：resolveFileDisplayDescriptor 的 fileIconSrc 永不为空，可直接渲染。守住位置：文件图标槽的 src 取值。改错故障：自行拼图标地址会绕开兜底，素材缺失时图标裂开。
// INV-15 行标识稳定：列表 key 与各测试 id 后缀都用 file.name。守住位置：Fragment 的 key 与 testId 调用。改错故障：改用索引后过滤会复用错行 DOM，图标与时间错位。
// INV-16 编辑器入口针对文件：WorkspaceEditorButtonGroup 收到的是 file.path。守住位置：行尾操作区。改错故障：传 workspace 目录会让编辑器打开目录，保存不落到该记忆文件。
// INV-17 作用域只回传 id：onScopeKeyChange 交出 workspace.id，选中态由父级派生。守住位置：PluginScopeMenu 的 selectedScopeKey 与回调。改错故障：组件内缓存选中对象会与刷新后的列表分叉，出现已删除项目。
// INV-18 测试 id 分层：作用域、计数、搜索、文件四组 id 各有独立常量。守住位置：data-testid 的绑定。改错故障：复用同一 id 会让 E2E 选中多个节点，断言变得不稳定。
//
// 模块职责：把 Project Memory 目录投影成可搜索、可切换作用域、可唤起编辑器的只读列表。
// 状态所有权：目录数据与选中项属于 MemorySettingsSection，本文件只保留搜索词与 now。
// 阅读顺序：先看三个早返回，再看搜索过滤与列表行，最后看刷新与作用域回调。
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ProjectMemoryWorkspaceSummary } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_WORKSPACE,
  testId,
} from "@zcode/shared/test-ids";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

// 对外契约：四种状态由父级驱动，本文件只读不写。
// 状态所有权：catalogState 描述目录请求，searchQuery 描述本地过滤，两者不能合并。
// 易错点：在组件内推导新的状态枚举会形成第二套真相，父级无法同步。
// 改错故障：状态收敛后 loading 与 error 互相吞掉，失败只能表现为空列表。
export type MemoryViewerLoadingState = "idle" | "loading" | "ready" | "error";

export function MemorySettingsViewer({
  catalogError,
  catalogState,
  selectedWorkspace,
  workspaces,
  onRefresh,
  onScopeKeyChange,
}: {
  catalogError: string | null;
  catalogState: MemoryViewerLoadingState;
  selectedWorkspace: ProjectMemoryWorkspaceSummary | undefined;
  workspaces: ProjectMemoryWorkspaceSummary[];
  onRefresh: () => Promise<void>;
  onScopeKeyChange: (workspaceId: string) => void;
}) {
  // 依赖边界：intl 与 locale 都来自 Provider，组件不自行解析系统语言。
  // 同时取出的原因：文案走 intl，时间格式化走 locale，二者必须同源。
  // 失败路径：Provider 缺失时 hook 直接抛错，组件不应吞掉这个错误。
  // 改错故障：改用 navigator.language 后语言切换不生效，界面中英混排。
  const { intl, locale } = useZCodeIntl();
  const [searchQuery, setSearchQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const formatMemoryCount = (count: number) =>
    intl.formatMessage(
      {
        id: `settings.memory.viewer.memoryCount.${count === 1 ? "one" : "other"}`,
      },
      { count },
    );
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  // 派生数据：visibleFiles 是 selectedWorkspace 的过滤视图，不复制文件对象。
  // 失败路径：selectedWorkspace 未定义时回落空数组，后续 length 读取才安全。
  // 并发边界：目录刷新会换掉 selectedWorkspace 引用，useMemo 随之重算而非增量更新。
  // 易错点：把 filter 结果写回 state 会多出一份可能与目录不一致的副本。
  const visibleFiles = useMemo(
    () =>
      selectedWorkspace?.files.filter((file) =>
        file.name.toLocaleLowerCase().includes(normalizedSearchQuery),
      ) ?? [],
    [normalizedSearchQuery, selectedWorkspace],
  );

  // 早返回顺序：错误优先于加载与缺省态，失败原因必须最先可见。
  // 失败路径：父级在请求异常时清空 workspaces 并写入 catalogError。
  // 为什么整体替换：目录不可信时继续渲染旧列表会误导用户。
  // 易错点：把错误塞进列表内联展示会让刷新按钮仍可点，空目录与失败难以区分。
  if (catalogError) {
    return (
      <Alert>
        <AlertDescription>{catalogError}</AlertDescription>
      </Alert>
    );
  }

  // 分支契约：只有首次加载才允许用占位替换整个列表。
  // 并发边界：父级刷新保留旧 workspaces，此分支因此不会抢走已渲染内容。
  // 为什么带长度判断：去掉后每次刷新整块闪白，搜索词与滚动位置一起丢失。
  // 改错故障：只判断 catalogState 会把刷新中误当成无数据。
  if (catalogState === "loading" && workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
      </div>
    );
  }

  // 早返回契约：没有选中 workspace 时只展示空态，不假设列表首项可用。
  // 状态所有权：选中项由父级按 id 计算，本组件不缓存 workspace 对象。
  // 为什么不能取首项：父级会重排与过滤，首项不等于用户选择。
  // 改错故障：此处回落首项会与 scope 菜单选中态形成两个来源。
  if (!selectedWorkspace) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.empty" })}
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginScopeMenu
            // 作用域契约：记忆只有项目维度，includeUser 必须关闭，不能混入用户级选项。
            // 选项来源：workspaceOptions 由父级把 workspaces 映射成 key 与 label。
            // 回传约定：选择结果只交出 workspace.id，由父级决定如何保存选中态。
            // 改错故障：打开用户级选项后会出现没有 files 的伪工作区，列表直接空白。
            includeUser={false}
            selectedScopeKey={selectedWorkspace.id}
            workspaceOptions={workspaces.map((workspace) => ({
              key: workspace.id,
              label: workspace.label,
            }))}
            onScopeKeyChange={onScopeKeyChange}
            triggerIconTestId={TID_SETTINGS_MEMORY_SCOPE_ICON}
            triggerTestId={TID_SETTINGS_MEMORY_SCOPE_TRIGGER}
            workspaceOptionTestIdPrefix={TID_SETTINGS_MEMORY_WORKSPACE}
          />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <span
            data-testid={TID_SETTINGS_MEMORY_COUNT}
            className="shrink-0 text-ui-sm text-foreground-subtle"
          >
            {formatMemoryCount(selectedWorkspace.files.length)}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <SettingsSearchInput
            containerClassName="w-full sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={TID_SETTINGS_MEMORY_SEARCH_CLEAR}
            data-testid={TID_SETTINGS_MEMORY_SEARCH_INPUT}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.memory.viewer.searchPlaceholder",
            })}
          />
        </div>
      </div>

      {normalizedSearchQuery && visibleFiles.length === 0 ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.memory.viewer.searchEmpty",
          })}
        />
      ) : (
        <>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.memory.viewer.files" })}
            </h3>
            <SettingsResourceHeaderActions
              // 刷新契约：组件只触发一次回调，不等待 Promise，也不自行维护刷新中状态。
              // 并发边界：refreshing 由 catalogState 派生，连续点击由父级请求编号去重。
              // 为什么用 void：父级已包装错误处理，组件内 await 只会制造第二个生命周期。
              // 改错故障：本地再置一份 loading 会与父级竞争，按钮可能永远转圈。
              onRefresh={() => void onRefresh()}
              refreshing={catalogState === "loading"}
              refreshTestId={TID_SETTINGS_MEMORY_REFRESH}
              refreshLabel={intl.formatMessage({
                id: "settings.memory.viewer.refresh",
              })}
            />
          </div>
          <div className="overflow-hidden rounded-xl bg-surface">
            {visibleFiles.map((file, index) => (
              <Fragment key={file.name}>
                {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                <div className="flex min-w-0 items-center hover:bg-hover">
                  <div
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE, file.name)}
                    className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                  >
                    <span
                      data-testid={testId(TID_SETTINGS_MEMORY_FILE_ICON, file.name)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background"
                    >
                      <FileDisplayIcon
                        src={resolveFileDisplayDescriptor(file.path).fileIconSrc}
                        size={16}
                        className="size-4 shrink-0"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_NAME, file.name)}
                        className="block truncate text-ui-base font-medium text-foreground"
                      >
                        {file.name}
                      </span>
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, file.name)}
                        className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
                      >
                        {formatMemoryUpdatedAt({
                          formatMessage: intl.formatMessage,
                          locale,
                          now,
                          updatedAt: file.updatedAt,
                        })}
                      </span>
                    </span>
                  </div>
                  <span
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, file.name)}
                    className="mr-3 shrink-0"
                  >
                    <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} />
                  </span>
                </div>
              </Fragment>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
