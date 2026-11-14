// CommandsSection —— 斜杠命令设置面板：列表投影、Scope 解析、新建与编辑表单、外部导入入口。
// 它只编排「读哪个作用域、写哪个目标、写完是否刷新」，命令文件的落盘格式由服务层决定。
//
// 职责边界
// 做：按 Scope 过滤本地与插件命令、维护分组折叠与搜索、承载表单开关与作用域切换。
// 不做：命令文件序列化、目录创建、插件安装状态变更、命令权限校验。
// 依赖：useCommands 提供列表投影，workspace 服务解析提供路由，pluginManagementStore 提供插件命令。
// 被谁用：设置页命令页签，由资源列表容器挂载并接收可见数量与编辑器状态回调。
// 边界：组件把 target 解析结果当唯一事实；路径与服务组合必须来自同一次解析。
//
// INV 不变量（违反任意一条都会把命令写进错误的工作区，或者打到错误的主机）
// INV-01 列表服务必须由 target 解析得出，不能直接取当前 Provider —— 守住它的位置：listServiceResolution —— 改错故障：B 的路径发往 A 的 host，列表读到别人的命令文件。
// INV-02 表单服务独立解析，规则与列表一致 —— 守住它的位置：formServiceResolution —— 改错故障：切换 Scope 编辑时写入旧工作区。
// INV-03 连接未就绪时不得发起命令 RPC —— 守住它的位置：useCommands 的 enabled 与各提前返回 —— 改错故障：连接中读到空列表，用户误以为命令被删。
// INV-04 工作区 key 使用「身份去空白优先、路径兜底、空串兜底」 —— 守住它的位置：currentWorkspaceKey —— 改错故障：远程与本地同路径连接互相串状态。
// INV-05 当前页签缺失时不得回退到激活工作区 —— 守住它的位置：currentWorkspaceTab 查找结果的使用点 —— 改错故障：向错误 host 读取或写入。
// INV-06 project 层级缺少目标路径必须报错，不能降级 user —— 守住它的位置：handleSave 的层级判断 —— 改错故障：命令写进用户级目录，项目里看不到。
// INV-07 更新必须携带旧文件路径 —— 守住它的位置：handleSave 的编辑分支 —— 改错故障：改名保存后留下孤儿文件，出现两个同名命令。
// INV-08 保存后只在目标等于当前列表工作区时刷新 —— 守住它的位置：条件刷新判断的调用点 —— 改错故障：当前列表被替换成另一个作用域的数据。
// INV-09 表单复位必须同时清新建开关、编辑对象与表单作用域 —— 守住它的位置：保存成功分支与取消回调 —— 改错故障：遗留幽灵编辑器或作用域错位。
// INV-10 失效作用域校正：编辑退出、新建回退 user —— 守住它的位置：作用域恢复 effect —— 改错故障：向已关闭的工作区持续写入。
// INV-11 插件 store 命中需同时比对工作区 key 与配置作用域 —— 守住它的位置：pluginStoreMatchesTarget —— 改错故障：插件命令分组取自别的 target。
// INV-12 插件 store 未命中时投影为空而不是回退现值 —— 守住它的位置：scopedPlugins 的三元分支 —— 改错故障：展示并删除其他 workspace 的插件命令。
// INV-13 插件命令分组键与图标查找键必须完全一致 —— 守住它的位置：分组构建与图标映射的两处拼接 —— 改错故障：分组有标题但图标始终缺失。
// INV-14 删除只允许可编辑的用户命令 —— 守住它的位置：handleDelete 的前置判断 —— 改错故障：插件命令被当成可删除项，请求必然失败。
// INV-15 删除必须先确认后请求 —— 守住它的位置：确认弹窗返回值分支 —— 改错故障：误点即永久删除，没有撤销路径。
// INV-16 编辑作用域由命令自身 scope 决定 —— 守住它的位置：handleEdit 的作用域设置 —— 改错故障：项目命令被保存到用户级。
// INV-17 可见数量上报放在 effect，不得在渲染期触发父级更新 —— 守住它的位置：数量上报 effect —— 改错故障：渲染期更新父状态，触发无限重渲染警告。
// INV-18 编辑器开关与表单目标必须成对上报并在卸载时复位 —— 守住它的位置：表单视图的同步 effect —— 改错故障：父级残留面包屑与禁用状态。
// INV-19 内容区优先级为「连接中、加载中、搜索空、列表」 —— 守住它的位置：返回值的条件链 —— 改错故障：旧 target 的命令在连接期短暂闪现。
// INV-20 导入弹窗的打开状态必须同时受开关与连接就绪约束 —— 守住它的位置：导入弹窗的 open —— 改错故障：未就绪时按钮可点但弹窗空白。
//
// 三处看着啰嗦、其实不能删的保护：
// 1) 列表与表单两套服务解析，删掉任一套都会让切换 Scope 后的写入落到旧目标。
// 2) 保存后的条件刷新，改成无条件刷新会把用户正在浏览的另一个作用域整体替换。
// 3) 插件 store 的 target 比对，删掉后插件贡献的命令分组会短暂取自别的工作区投影。
/* eslint-disable max-lines -- 命令管理面板集中维护列表、表单和外部导入入口，拆分会增加跨状态跳转成本 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { CommandConfig, UserCommand, ZCodeCommand } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { isPluginCommand, isUserCommand, ZCODE_COMMAND_AGENT_SOURCE } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useCommands } from "@/hooks/useCommands.js";
import { useConfigWorkspaceServicesResolution as useWorkspaceServicesResolution } from "@/workspace-config-catalog/index.js";
import { CommandCard, isEditableUserCommand } from "@/settings/CommandCard.js";
import { CommandForm } from "@/settings/CommandForm.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { CommandsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { groupCommandsByPlugin } from "@/settings/pluginManagedResourceGroups.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import { resolvePluginDisplayName } from "@/settings/pluginStoreListing.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import {
  selectCommandsForScope,
  selectPluginsForScope,
} from "@/settings/pluginCapabilityProjection.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import {
  resolveCommandScopeRecovery,
  resolveCommandStorageTarget,
  shouldRefreshCurrentCommandList,
} from "@/settings/commandWorkspaceScope.js";

// [契约] props 区分两种身份：桌面路径用于列表路由，工作区身份用于去重与缓存键。
// [契约] 作用域过滤是「当前页签」的语义，不是编辑器的目标；编辑器目标由表单状态单独维护。
// [契约] 三个回调是向浏览器框架同步的组合：可见数量、编辑器开关、表单目标，缺一个外层就会残留旧状态。
// [权衡] 无作用域服务与缓存权威键成对出现，只在 Source 设置页注入，普通调用方不传。
interface CommandsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

// [契约] 本组件只做命令的浏览与编辑编排，命令文件读写全部委托服务层，不在界面拼路径。
// [契约] 所有服务都来自工作区解析结果，不允许再从当前 Provider 取第二份。
// [契约] 挂载即按可用性拉取列表：连接未就绪时列表 hook 必须保持禁用，避免越界请求。
// [权衡] 列表与编辑器都由 commandsSection 的同一份数据派生，不存本地副本，刷新只走服务端投影。
export function CommandsSection({
  workspacePath,
  workspaceIdentity,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
  unscopedServices,
  cacheAuthorityKey,
}: CommandsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  // [依赖] 确认弹窗是 hook 提供的异步契约，返回布尔值，调用方自己决定取消分支。
  // [契约] 删除是破坏性操作，必须等用户确认后再发请求，不能先删后提示。
  // [权衡] 不复用原生确认框，保持与应用内其他设置页一致的文案与样式。
  const confirmDialog = useConfirmDialog();

  // [契约] 工作区 key 统一为「身份去空白优先、路径兜底、再兜底空串」，与其他模块的 key 规则一致。
  // [契约] 空串是合法的「未选中」值，不要用空值合并把它变成未定义，否则查找与比较会分叉。
  // [权衡] 不在这里做路径归一化：路径格式由上层保证，重复归一化反而让等价值不相等。
  // [失败路径] 若改成路径优先，远程工作区会在同一物理路径的多个连接间串状态。
  // [契约] 这个 key 同时用于列表判断与插件 store 的目标比对，两处必须读同一个变量。
  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath || "";
  // [契约] 用 key 相等找到当前页签，页签数组的来源与 Scope 菜单一致，避免两处筛选口径不同。
  // [契约] 找不到页签是合法状态，例如页签刚关闭；下游必须按「无目标」处理而不是回退到激活工作区。
  // [权衡] 用单个查找取首个即可，页签 key 由上层保证唯一。
  // [失败路径] 若回退到当前激活工作区，远程请求会发到错误 host。
  const currentWorkspaceTab = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === currentWorkspaceKey,
  );
  // 列表按 Scope target 收到 workspacePath，但命令与插件服务仍取自当前
  // ServiceProvider，会把 B 的路径发往 A 的 remote host。两者统一走 target 解析结果，
  // 并在连接就绪前暂停 RPC，不回退到当前激活 workspace 的 service。
  // [契约] 列表服务按 target 解析：路径、远程会话、身份、远程目标四项必须同源传入。
  // [契约] 解析结果自带就绪标志，连接就绪前所有调用点都要检查它，不能只判断服务是否存在。
  // [契约] 无作用域服务只在 Source 设置页注入；普通页面传空表示按 target 正常解析。
  // [契约] 强制无作用域与缓存权威键绑定，权威键存在时不允许落到当前激活工作区的服务。
  // [失败路径] 这四个参数任少一个，就会出现「B 的路径发往 A 的 host」这类越界请求。
  // [权衡] 不再用额外 memo 包住调用，hook 内部已按参数记忆化，外层再包会掩盖依赖变化。
  const listServiceResolution = useWorkspaceServicesResolution(
    currentWorkspaceTab?.workspacePath ?? workspacePath,
    currentWorkspaceTab?.remoteSessionId,
    currentWorkspaceTab?.workspaceIdentity ?? workspaceIdentity,
    currentWorkspaceTab?.remoteTarget,
    { unscopedServices, forceUnscoped: Boolean(cacheAuthorityKey) },
  );
  const { commandsService, pluginManagementService, settingsSyncService } =
    listServiceResolution.services;

  const {
    commands,
    capability,
    loading,
    error,
    operatingCommandId,
    projectionMatchesTarget,
    refresh,
    deleteCommand,
    toggleCommand,
  } = useCommands({
    workspacePath: workspacePath ?? undefined,
    workspaceIdentity,
    commandsService,
    enabled: listServiceResolution.rpcReady,
  });

  // [状态] 新建与编辑共用同一张表单视图，由新建开关与编辑对象两个状态共同表达。
  // [契约] 二者任意为真即进入表单视图，所以关闭时必须同时复位，只清一个会留下幽灵编辑器。
  // [契约] 回到列表不销毁表单草稿以外的数据，提交成功或取消时才统一复位。
  // [权衡] 没有把编辑对象与开关合成联合类型，是为了兼容历史上按布尔判空的调用点。
  const [showForm, setShowForm] = useState(false);
  const [editingCommand, setEditingCommand] = useState<UserCommand | null>(null);
  const [saving, setSaving] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  const formTargetWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === formScopeKey,
  );
  const formServiceTarget = formTargetWorkspace ?? currentWorkspaceTab;
  // [契约] 表单服务按编辑目标单独解析，不能复用列表结果：用户可能把作用域切到另一个工作区。
  // [契约] 目标页签存在时不再使用无作用域服务，避免 Source 页签的旁路服务污染具体工作区写入。
  // [契约] 强制无作用域只在「有缓存权威键且没有目标页签」时为真，语义是用户级写入。
  // [契约] 提交期间目标连接若断开，就绪标志会变假，提交必须由服务层报错而不是静默降级。
  // [失败路径] 若复用列表服务，切换作用域后写入会落到页签 A 的文件而不是用户刚选的 B。
  // [权衡] 两个解析 hook 各持一份订阅，多一次轻量上下文读取，换来路由正确性。
  const formServiceResolution = useWorkspaceServicesResolution(
    formServiceTarget?.workspacePath ?? workspacePath,
    formServiceTarget?.remoteSessionId,
    formServiceTarget?.workspaceIdentity ?? workspaceIdentity,
    formServiceTarget?.remoteTarget,
    {
      unscopedServices: formTargetWorkspace ? undefined : unscopedServices,
      forceUnscoped: Boolean(cacheAuthorityKey && !formTargetWorkspace),
    },
  );
  const formServices = formServiceResolution.services;

  // [契约] 只在页签集合变化时校正作用域：目标工作区关闭后不能继续向失效路径写入。
  // [契约] 编辑态遇失效直接退出编辑器，新建态回退到用户作用域，两者的失败策略不同。
  // [契约] 校正函数是纯函数，返回保持时提前退出，避免无意义的状态写入引发额外渲染。
  // [契约] 依赖带上表单作用域与编辑对象，保证切换后立刻重新评估。
  // [失败路径] 若把关闭的页签保留在作用域里，保存请求会带着不存在的路径发往远端。
  // [权衡] 不做「自动切到下一个可用页签」，用户对写入位置必须可预期。
  useEffect(() => {
    const recovery = resolveCommandScopeRecovery({
      editing: Boolean(editingCommand),
      scopeKey: formScopeKey,
      workspaceTabs,
    });
    if (recovery === "keep") return;
    // 目标 Workspace 关闭后不能继续向失效路径写入；新建回退 User，编辑直接退出。
    if (recovery === "close-editor") {
      setEditingCommand(null);
      setShowForm(false);
      return;
    }
    setFormScopeKey("user");
  }, [editingCommand, formScopeKey, workspaceTabs]);

  // [契约] 插件 store 是全局单例，本组件只读选择器，不在这里初始化第二份状态。
  // [契约] 用逐字段选择器而不是整体订阅，避免无关字段变化引起整页重渲染。
  // [契约] 工作区与身份两个字段单独订阅，正是为了做「store 是否属于当前目标」的比对。
  // [权衡] 选择器返回原始值，不需要额外浅比较，引用相等即可生效。
  const plugins = usePluginManagementStore((state) => state.plugins);
  const pluginStoreWorkspacePath = usePluginManagementStore((state) => state.workspacePath);
  const pluginStoreWorkspaceIdentity = usePluginManagementStore((state) => state.workspaceIdentity);
  const pluginConfigScope = usePluginManagementStore((state) => state.configScope);
  const installedPlugins = usePluginManagementStore((state) => state.installedPlugins);
  const availablePlugins = usePluginManagementStore((state) => state.availablePlugins);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);

  // [并发] 初始化只在有工作区路径且连接就绪后触发，二者缺一就跳过，避免向未就绪的 host 发请求。
  // [契约] 传入插件服务与权威键，让 store 记住数据归属，防止别的 target 覆盖后本页误读。
  // [契约] 配置作用域用当前页签语义，切换用户与工作区会重新初始化插件投影。
  // [失败路径] 若漏掉就绪判断，连接建立前的初始化会以空结果写入，页面显示「没有插件」。
  // [权衡] 依赖数组完整列出初始化函数与权威键，重连时重跑正是期望行为。
  useEffect(() => {
    if (!workspacePath || !listServiceResolution.rpcReady) return;
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
      pluginService: pluginManagementService,
    });
  }, [
    initializePlugins,
    cacheAuthorityKey,
    listServiceResolution.rpcReady,
    pluginManagementService,
    scopeFilter,
    workspaceIdentity,
    workspacePath,
  ]);

  // [事务] 保存是「解析目标、写入、条件刷新、复位表单」四步，顺序不能交换。
  // [契约] 存储层级与目标工作区由同一个解析函数给出，路径只在项目层级才传给服务。
  // [契约] 项目层级缺少可用路径时直接抛错，不允许降级成用户级写入，否则命令会写进错误的文件。
  // [契约] 编辑走更新并带旧文件路径，新建走写入，两条路径不能合并：更新需要旧路径判断是否移动。
  // [契约] 只有目标就是当前列表的工作区时才刷新，否则会覆盖用户正在浏览的另一个作用域。
  // [失败路径] 刷新失败会落到错误分支，此时表单保持打开，用户可重试且不丢失输入。
  // [契约] 依赖数组包含编辑对象与表单服务，闭包读取的必须是当次渲染的值。
  const handleSave = useCallback(
    async (config: CommandConfig, scopeKey: string) => {
      setSaving(true);
      try {
        const { storageLevel, workspace: targetWorkspace } = resolveCommandStorageTarget(
          scopeKey,
          workspaceTabs,
        );
        const targetWorkspacePath =
          storageLevel === "project" ? targetWorkspace?.workspacePath : undefined;
        if (storageLevel === "project" && !targetWorkspacePath) {
          throw new Error("Selected Workspace is no longer available");
        }
        // [契约] 编辑与新建的分支只在服务调用上不同，前置校验与失败处理完全共用。
        // [契约] 更新请求必须携带旧文件路径，服务端据此判断是否需要移动文件。
        // [权衡] 不在界面侧预判重名，重名判定交给服务，避免两处规则不一致。
        // [失败路径] 若省略旧路径，改名保存会留下孤儿文件，列表出现两个同名命令。
        if (editingCommand) {
          await formServices.commandsService.updateCommandFile({
            agentSource: editingCommand.agentSource,
            commandId: editingCommand.id,
            config,
            oldFilePath: editingCommand.filePath,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
        } else {
          await formServices.commandsService.writeCommandFile({
            config,
            agentSource: ZCODE_COMMAND_AGENT_SOURCE,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
        }
        // [契约] 是否刷新由纯函数判定：只有保存目标落在当前列表的工作区才刷新。
        // [契约] 判定输入是作用域键与当前 key，不要在这里展开成路径比较，规则集中在一处。
        // [契约] 刷新是等待完成的，保证表单复位发生在列表更新之后，用户不会看到空窗。
        // [失败路径] 若无条件刷新，保存到别的工作区时会把当前列表替换成另一个作用域的数据。
        // [权衡] 即使不刷新也关闭表单，保存成功以写入为准，不依赖列表回读。
        if (shouldRefreshCurrentCommandList(scopeKey, currentWorkspaceKey)) {
          await refresh();
        }
        setShowForm(false);
        setEditingCommand(null);
        setFormScopeKey("user");
      // [失败路径] 错误文案优先识别「已存在」类提示，换成带文件名的本地化文案。
      // [契约] 文件名由命令名去掉前导斜杠再补扩展名得到，与服务端落盘规则保持一致。
      // [契约] 其他错误原样展示，不做二次包装，避免吞掉服务端可操作的信息。
      // [权衡] 失败时不在这里复位保存中标志，交给 finally 统一收尾，两件事分开处理更清晰。
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError);
        if (message.includes("exists") || message.includes("already")) {
          toast(
            intl.formatMessage(
              { id: "forms.validation.fileExists" },
              { fileName: `${config.name.replace(/^\//, "")}.md` },
            ),
          );
        } else {
          toast(message);
        }
      } finally {
        setSaving(false);
      }
    },
    [
      currentWorkspaceKey,
      editingCommand,
      formServices.commandsService,
      intl,
      refresh,
      workspaceTabs,
    ],
  );

  // [契约] 只有可编辑的用户命令才允许删除，插件命令与只读命令在这里被提前拦截。
  // [契约] 确认弹窗的文案带上命令名，破坏性操作必须让用户看到具体对象。
  // [契约] 取消分支直接返回，不产生任何状态变更。
  // [失败路径] 删除失败仅提示，不关闭编辑器，用户可以重试或改为关闭。
  const handleDelete = useCallback(
    async (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "settings.commands.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.commands.delete.description" },
          { name: command.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      try {
        await deleteCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
        });
        setEditingCommand(null);
        setShowForm(false);
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : String(deleteError);
        toast(message);
      }
    },
    [confirmDialog, deleteCommand, intl],
  );

  const handleToggle = useCallback(
    async (command: ZCodeCommand, enabled: boolean) => {
      if (!isUserCommand(command)) {
        return;
      }
      try {
        await toggleCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
          enabled,
        });
      } catch (toggleError) {
        const message = toggleError instanceof Error ? toggleError.message : String(toggleError);
        toast(message);
      }
    },
    [toggleCommand],
  );

  // [契约] resolveCommandEditTarget 按 command.scope 分流：project 回父级作用域，其余回 user 级。
  // [契约] 先设作用域再设编辑对象，保证表单首帧就拿到正确的存储层级。
  // [契约] 打开编辑时显式关闭新建开关，避免两个状态同时为真导致视图歧义。
  // [权衡] 不改动列表数据，编辑期间列表仍是服务端投影，取消后无需回滚。
  const handleEdit = useCallback(
    (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      setFormScopeKey(command.scope === "project" ? parentScopeKey : "user");
      setEditingCommand(command);
      setShowForm(false);
    },
    [parentScopeKey],
  );

  const handleAddNew = useCallback(() => {
    setFormScopeKey(parentScopeKey);
    setEditingCommand(null);
    setShowForm(true);
  }, [parentScopeKey]);

  const handleCancelForm = useCallback(() => {
    setFormScopeKey("user");
    setShowForm(false);
    setEditingCommand(null);
  }, []);

  const handleFormScopeKeyChange = useCallback(
    (scopeKey: string) => {
      setFormScopeKey(scopeKey);
      onFormScopeKeyChange?.(scopeKey);
    },
    [onFormScopeKeyChange],
  );

  // pluginManagementStore 是全局单例，Plugins tab 的 PluginList 与本页在
  // effectiveCommandScopeKey ≠ selectedScopeKey 时会用不同 target 交替初始化它。
  // PluginList 已用 storeKey!==targetKey 自保护，这里复用同一模式，避免插件贡献的
  // 命令分组短暂取自别的 target 的插件投影。
  // [契约] 插件 store 是全局单例，必须同时比对工作区 key 与配置作用域才算命中。
  // [契约] 身份优先、路径兜底的 key 规则与列表一致，不能在这里另写一套比较。
  // [契约] 命中失败时下游投影为空而不是回退到 store 现值，宁可短时空列表也不展示别人的数据。
  // [失败路径] 若只比路径不比身份，同一路径的本地与远程连接会互相覆盖插件投影。
  // [权衡] 比对在渲染期计算而不是在 effect 里写状态，避免多一次渲染与循环更新。
  const pluginStoreMatchesTarget =
    (pluginStoreWorkspaceIdentity?.trim() || pluginStoreWorkspacePath || "") ===
      currentWorkspaceKey && pluginConfigScope === scopeFilter;
  const scopedPlugins = useMemo(
    () =>
      pluginStoreMatchesTarget ? selectPluginsForScope(plugins, installedPlugins, scopeFilter) : [],
    [installedPlugins, plugins, pluginStoreMatchesTarget, scopeFilter],
  );
  const scopedCommands = useMemo(
    () => selectCommandsForScope(commands, scopedPlugins, scopeFilter),
    [commands, scopeFilter, scopedPlugins],
  );
  const groupedCommands = useMemo(
    () => groupCommandsByPlugin(scopedCommands, searchQuery),
    [scopedCommands, searchQuery],
  );
  const filteredCommandCount = groupedCommands.local.length + groupedCommands.plugin.length;
  // [契约] visibleCount 取 filteredLocalCommands 与 filteredPluginCommands 的长度之和，分组阶段已过滤过搜索词。
  // [契约] 通过回调向父级同步数量，父级用它渲染页签计数，组件自身不持有这个数字。
  // [契约] 依赖是数量与回调，回调引用变化时会重新上报，这比缓存更安全。
  // [权衡] 上报放在 effect 而不是渲染中，避免在渲染期触发父级状态更新。
  useEffect(() => {
    onVisibleCountChange?.(filteredCommandCount);
  }, [filteredCommandCount, onVisibleCountChange]);
  const pluginListingById = useMemo(
    () => new Map(availablePlugins.map((plugin) => [plugin.id, plugin.listing])),
    [availablePlugins],
  );
  // [契约] 插件命令按「插件名 + 市场」组成分组键，同名插件在不同市场不会被合并。
  // [契约] 分组键与图标查找使用同一拼接规则，两处字符串必须完全一致。
  // [契约] 组内追加时生成新数组，不改动分组结果里的原始条目。
  // [契约] 分组之间按 key 本地化比较排序，保证每次渲染顺序稳定。
  // [失败路径] 若分组键去空白而图标查找不去，会出现分组标题有了但图标一直缺失。
  const pluginCommandGroups = useMemo(() => {
    const groups = new Map<string, typeof groupedCommands.plugin>();
    for (const command of groupedCommands.plugin) {
      const key = `${command.pluginName.trim()}@${command.pluginMarketplace.trim()}`;
      groups.set(key, [...(groups.get(key) ?? []), command]);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [groupedCommands.plugin]);
  const hasEmptySearchResult = Boolean(searchQuery.trim()) && filteredCommandCount === 0;
  const directInstalledCommandCount = scopedCommands.filter(isUserCommand).length;
  const hideInstalledGroup = Boolean(searchQuery.trim()) && groupedCommands.local.length === 0;

  const renderCommandList = (items: ZCodeCommand[]) => (
    <SettingsResourceList
      items={items}
      getKey={(command) => command.id}
      renderItem={(command) => (
        <CommandCard
          command={command}
          onEdit={isEditableUserCommand(command) ? handleEdit : undefined}
          onToggle={isUserCommand(command) ? handleToggle : undefined}
          isOperating={operatingCommandId === command.id}
          pluginIconItem={
            isPluginCommand(command)
              ? {
                  name: command.pluginName,
                  listing: pluginListingById.get(
                    `${command.pluginName.trim()}@${command.pluginMarketplace.trim()}`,
                  ),
                }
              : undefined
          }
        />
      )}
    />
  );

  const isFormView = showForm || editingCommand !== null;
  // [契约] 进入或离开表单都要向父级同步编辑器开关与表单目标，两者必须成对更新。
  // [契约] 卸载时主动复位，避免父级以为编辑器仍打开而实际组件已不在树上。
  // [契约] 非表单态上报 onEditingTargetChange(undefined)，父级据此禁用与编辑器相关的入口。
  // [失败路径] 若只在进入时上报、不写清理函数，切换页签后父级头部会残留面包屑。
  // [权衡] 依赖包含表单目标，作用域切换会重新上报，这正是父级需要的同步时机。
  // [契约] 上报本身不修改本地状态，effect 内不写状态，规避额外的渲染循环。
  useEffect(() => {
    onEditorOpenChange?.(isFormView);
    onFormScopeKeyChange?.(isFormView ? formScopeKey : null);
    return () => {
      onEditorOpenChange?.(false);
      onFormScopeKeyChange?.(null);
    };
  }, [formScopeKey, isFormView, onEditorOpenChange, onFormScopeKeyChange]);
  // [契约] 表单视图完全替换列表视图，不保留列表的搜索与分组界面，避免两条交互路径并存。
  // [契约] 面包屑只有一项当前命令名，返回动作等价于取消表单。
  // [契约] 保存中标志与删除入口都由状态决定，表单自身不推断能否提交。
  // [失败路径] 若表单在连接未就绪时也能渲染，提交会打到未解析的服务上。
  // [权衡] 第二次提前返回之前没有新增 hook，两条返回路径的 hook 顺序保持一致。
  if (isFormView) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingCommand?.name ?? intl.formatMessage({ id: "settings.commands.addNew" }),
            },
          ]}
          onSectionSelect={handleCancelForm}
        />
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {editingCommand
                ? intl.formatMessage({ id: "settings.commands.edit" })
                : intl.formatMessage({ id: "settings.commands.addNew" })}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {editingCommand
                ? intl.formatMessage({
                    id: "settings.commands.editDescription",
                  })
                : intl.formatMessage({
                    id: "settings.commands.addDescription",
                  })}
            </p>
          </div>

          <CommandForm
            initial={editingCommand ?? undefined}
            agentSource={editingCommand?.agentSource ?? ZCODE_COMMAND_AGENT_SOURCE}
            scopeKey={formScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={handleFormScopeKeyChange}
            onSave={handleSave}
            onCancel={handleCancelForm}
            onDelete={editingCommand ? handleDelete : undefined}
            saving={saving}
          />
        </div>
      </div>
    );
  }

  const headerActions = (
    <SettingsResourceHeaderActions
      onRefresh={() => void refresh()}
      onImport={() => setImportDialogOpen(true)}
      onNew={handleAddNew}
      importDisabled={!capability?.userScopeAvailable}
    />
  );

  // [契约] 加载与空态优先级是「连接中、加载中、搜索无结果、列表」，顺序不能调换。
  // [契约] 投影未匹配当前 target 时也走加载态，宁可多等一帧也不展示上一个 target 的命令。
  // [契约] searchQuery 无匹配时页签计数仍显示，头部与新增按钮不禁用。
  // [契约] 导入弹窗的打开状态同时受开关与连接就绪控制，未就绪时自动隐藏而不是渲染空弹窗。
  // [权衡] 搜索无本地命中时隐藏整个已安装分组，避免出现「已安装 0」的误导标题。
  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!listServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.commands.searchEmpty",
          })}
        />
      ) : (
        <div className="space-y-6">
          <section className={hideInstalledGroup ? "hidden" : "space-y-4"}>
            <SettingsResourceGroupHeader
              actions={headerActions}
              count={groupedCommands.local.length}
              title={intl.formatMessage({
                id: "settings.plugin.commands.installed",
              })}
            />
            {groupedCommands.local.length > 0 ? (
              renderCommandList(groupedCommands.local)
            ) : directInstalledCommandCount === 0 && !searchQuery.trim() ? (
              <PluginInstallEmptyState
                title={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledTitle",
                })}
                description={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledDescription",
                })}
                actions={
                  <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.create.action" })}
                  </Button>
                }
              />
            ) : null}
          </section>
          {pluginCommandGroups.map(([pluginId, items]) => (
            <section key={pluginId} className="space-y-4">
              <SettingsResourceGroupHeader
                count={items.length}
                title={resolvePluginDisplayName(
                  {
                    name: items[0]?.pluginName ?? pluginId,
                    listing: pluginListingById.get(pluginId),
                  },
                  locale,
                )}
              />
              {renderCommandList(items)}
            </section>
          ))}
        </div>
      )}
      <CommandsImportDialog
        open={importDialogOpen && listServiceResolution.rpcReady}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        settingsSyncService={settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={refresh}
      />
    </div>
  );
}
