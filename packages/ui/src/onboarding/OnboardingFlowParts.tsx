// OnboardingFlowParts —— 引导流程「会话迁移 / Agent 设置 / 外部 Agent 导入 / 迁移进度 / 完成汇总」五段视图的唯一实现处。
// 职责边界：本文件只做 props → JSX 的投影与分支呈现；扫描、选择、导入、计数累加、跳步与幂等判定由
// useClaudeSessionMigration、useSettingsSync 及上层 finish 编排拥有，本文件不发起任何写操作。
// 不拥有：会话与 settings 的真实状态、selection 增删规则、finishExecution 累加与完成标记、持久化。
// 不负责：步骤切换、返回、跳过校验（上层 OnboardingFlow 决定），也不负责平台差异（统一经 hooks 注入）。
// 阅读顺序：接口与初始态 → 会话步骤 → Agent 设置步骤 → 外部导入步骤 → 迁移进度 → 完成汇总。
// 组件清单：OnboardingSessionsStep、OnboardingAgentSettingsStep、OnboardingExternalAgentImportStep、OnboardingMigrationStep、OnboardingFinishStep。
// 状态来源：migration 提供 range/limitInput/supportState/isScanning/scanError；settingsSync 提供 state 与 actions。
// 跳过语义：跳过只体现在计数里，不写脏状态，也不回滚已导入项；已导入项重复执行必须幂等。
// 完成态幂等：FinishStep 允许重复渲染与重放，同一组 props 必须得到同一组数字与同一文案。
// 外部链接：导入面板内的链接保持浏览器默认行为，本文件不注册点击拦截、不改 target 与 rel。
// 失败路径：扫描失败只渲染 scanError 提示，不清空已选工作区，用户修好后可原地重试。
// 可回退：步骤内交互全部交给父层回调，撤回只需父层改 props，组件不缓存决策结果。
// 并发：同一时刻只允许一次 scan；isScanning 期间按钮禁用并以旋转图标作为唯一进行中信号。
// 术语：workspacePath 是路径事实，workspaceIdentity 只用于身份隔离；本文件展示与回调只用 workspacePath。
// 不变量表（INV）：任一改动若违反下列断言，必须先改这里再改代码，并在评审中说明。
// INV-01 断言：计数展示只读 props.finishExecution，组件内不累加 —— 守住它的位置：FinishStep 三个汇总卡片 —— 改错故障：重渲染翻倍计数，完成页数字虚高。
// INV-02 断言：createInitialFinishExecutionState 每次返回新对象且三态位皆 false —— 守住它的位置：started/running/finished —— 改错故障：复用旧对象把上一轮完成态泄漏进新一轮。
// INV-03 断言：imported、skipped、failed 三类互斥且失败必须显式呈现 —— 守住它的位置：会话、agentsFile、settings 三组计数 —— 改错故障：失败被吞进 skipped，用户误判导入成功。
// INV-04 断言：扫描按钮仅在不支持或正在扫描时禁用 —— 守住它的位置：SessionsStep 的 scan Button disabled —— 改错故障：并发扫描覆盖候选列表，选中集与列表错位。
// INV-05 断言：勾选态按 workspacePath 从 selectedWorkspacePaths 派生，不留本地副本 —— 守住它的位置：列表 map 内 checked —— 改错故障：副本与父级真相分叉，全选与单项不一致。
// INV-06 断言：选中数、总数、全选三者同帧由同一组 props 计算 —— 守住它的位置：selectedCount/totalCount/allSelected —— 改错故障：按钮文案与实际选择不一致。
// INV-07 断言：候选为空时全选按钮禁用且空态优先于列表 —— 守住它的位置：totalCount === 0 分支 —— 改错故障：空列表仍可点全选，产生无意义写操作。
// INV-08 断言：sessionCount 只做展示，不参与选择语义 —— 守住它的位置：Badge 文案 —— 改错故障：把会话条数当权重影响勾选或统计。
// INV-09 断言：设置步骤四分支优先级为 discovery 优先于 loading、loading 优先于 error、error 优先于空态 —— 守住它的位置：三元链顺序 —— 改错故障：错误态被空态遮挡，用户看不到失败原因。
// INV-10 断言：外部 Agent 导入步骤不复制 state、不拦截链接 —— 守住它的位置：ExternalAgentImportStep 转发 —— 改错故障：双写分类状态或劫持外链，父层刷新后丢失导入结果。
// INV-11 断言：迁移进度只读 overallProgress 与 currentTaskLabel，不自行计时 —— 守住它的位置：MigrationStep —— 改错故障：本地模拟进度与真实进度跳变。
// INV-12 断言：只有 currentTaskLabel 为空才回退 ready 文案 —— 守住它的位置：MigrationStep 当前任务行 —— 改错故障：空串被当成有值，出现空白任务名。
// INV-13 断言：FinishStep 的 error 只提示、不翻转成功标记 —— 守住它的位置：finishExecution.error 分支 —— 改错故障：部分失败被渲染成全成功或全失败。
// INV-14 断言：所有文案经 intl.formatMessage，变量参数以字符串传值 —— 守住它的位置：各步骤文案调用 —— 改错故障：切换语言后残留硬编码或格式化异常。
// 维护约定：新增步骤保持 props 进、JSX 出，不在本文件内用 effect 发请求或写 store。
// 维护约定：TSX 注释只放在顶层语句、函数体语句或表达式内语句位置，不放进 JSX 子节点与开标签属性行之间。
// 维护约定：语义只写在整行注释里，不依赖行内注释，避免被格式化工具吞掉。
// 维护约定：调整步骤顺序（先扫描后选择、先导入后完成）时，同步更新上方 INV 与对应步骤块注释。
import { CheckIcon, FolderIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Progress } from "@/components/ui/progress.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ClaudeMigrationRange,
  useClaudeSessionMigration,
} from "@/hooks/useClaudeSessionMigration.js";
// [契约] UNLIMITED_SCAN_LIMIT_INPUT 与 hook 同模块导出，限流下拉的「不限」哨兵值只能引用这里。
// 理由：扫描上限属 hook 的协议常量，本地写不限字面量会在 hook 改名时静默失配。
// [契约] 类型导入与值导入分列两行，避免打包器把类型依赖带进运行时。
// 边界：本文件只消费常量，不定义上限枚举，也不校验上限合法性。
// 改这里时：先确认 hook 仍导出该常量，再看下拉选项是否覆盖全部允许值。
import { UNLIMITED_SCAN_LIMIT_INPUT } from "@/hooks/useClaudeSessionMigration.js";
import { SettingsSyncSelectionStep } from "@/settings-sync/SettingsSyncSelectionStep.js";
import type { useSettingsSync } from "@/hooks/useSettingsSync.js";
import { Badge } from "@/components/ui/badge.js";
import {
  ExternalAgentImportSelectionPanel,
  type ExternalAgentImportCategoryState,
  type ImportResourceCategory,
} from "@/settings/ExternalAgentImportDialog.js";

// [权衡] 欢迎页实现放在独立文件，这里只做再导出，保证引导入口的导入路径不随文件拆分而变。
// 副作用：再导出不参与本文件的渲染树，改欢迎页不会波及步骤组件的 props 契约。
// 边界：不要把欢迎页 JSX 迁回本文件，否则欢迎页与步骤集合耦合，拆包粒度变粗。
// 校验点：删除本行会同时打断外部对引导入口的引用，属破坏性改动。
export { OnboardingWelcomeView } from "@/onboarding/OnboardingWelcomeView.js";

// [契约] 候选工作区三字段：workspacePath 是唯一键与回调参数，label 只用于展示，sessionCount 只用于计数徽标。
// [契约] sessionCount 是展示快照，允许与真实导入数不同，不要用它反推待导入数量。
// 边界：不在这里放 selected 字段，选择态归属父层 selectedWorkspacePaths，避免两份真相。
// [失败路径] label 允许为空串，UI 走 truncate，不做兜底拼接路径。
export interface OnboardingWorkspaceCandidate {
  workspacePath: string;
  label: string;
  sessionCount: number;
}

// [契约] 完成态的五个维度：三态位（started/running/finished）、当前任务、错误、三组计数。
// [事务] 三态位由上层按 started → running → finished 单向前进，组件只读，不自行翻转。
// [契约] 每组计数拆 completed/total 与 imported/skipped/failed，total 表示范围，不参与求和展示。
// [失败路径] error 非空表示本轮存在不可继续的失败，但已完成的导入不回滚，仅用于提示。
// 边界：新增计数维度必须同时补 createInitialFinishExecutionState 与完成页三卡片，否则初值为空。
export interface FinishExecutionState {
  started: boolean;
  running: boolean;
  finished: boolean;
  sessionCompletedCount: number;
  sessionTotalCount: number;
  sessionImportedCount: number;
  sessionSkippedCount: number;
  sessionFailedCount: number;
  agentsFileCompletedCount: number;
  agentsFileTotalCount: number;
  agentsFileImportedCount: number;
  agentsFileSkippedCount: number;
  agentsFileFailedCount: number;
  currentTaskLabel: string | null;
  error: string | null;
}

// [事务] 工厂每次返回全新对象，三态位全 false、三组计数全零、error 为 null。
// 理由：引导可能被重新进入，复用上一轮对象会把 finished=true 带进新一轮，导致完成页闪现。
// [契约] 返回值即 FinishExecutionState 的初值契约，新增字段必须在此给零值而不是留空。
// 可回退：重置只需再次调用本函数，不依赖组件卸载或 store 清理。
// 边界：本函数不做校验、不发请求、不读环境，纯数据构造。
export function createInitialFinishExecutionState(): FinishExecutionState {
  return {
    started: false,
    running: false,
    finished: false,
    sessionCompletedCount: 0,
    sessionTotalCount: 0,
    sessionImportedCount: 0,
    sessionSkippedCount: 0,
    sessionFailedCount: 0,
    agentsFileCompletedCount: 0,
    agentsFileTotalCount: 0,
    agentsFileImportedCount: 0,
    agentsFileSkippedCount: 0,
    agentsFileFailedCount: 0,
    currentTaskLabel: null,
    error: null,
  };
}

// [契约] 会话步骤的输入：migration（能力与扫描结果）、候选列表、选中路径、三个选择回调，全部只读。
// 步骤顺序：先看 supportState.supported，再选 range 与 limit，最后 scan；未扫描时列表可能是空态。
// [并发] 扫描进行中只认 migration.isScanning，本组件不维护第二份进行中标志。
// [失败路径] scanError 只在扫描失败后出现，提示层独立于列表，失败不清空已选路径，可原地重试。
// 可回退：toggle、全选、清空都以回调交给父层，撤回靠父层改 props，组件不留决策。
export function OnboardingSessionsStep(props: {
  migration: ReturnType<typeof useClaudeSessionMigration>;
  workspaceCandidates: OnboardingWorkspaceCandidate[];
  selectedWorkspacePaths: string[];
  onToggleWorkspace: (workspacePath: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
}) {
  // [契约] 文案统一走 intl.formatMessage，键缺失时由 i18n 层兜底，本组件不写中文或英文字面量。
  // 边界：带变量的文案用第二参数对象传值，计数类统一字符串化，避免各语言复数规则差异。
  // 权衡：intl 实例按组件获取、不跨组件传递，保证语言切换后整棵树同步重渲染。
  const { intl } = useZCodeIntl();
  // [契约] 选中数直接取数组长度，selectedWorkspacePaths 是选择的唯一事实来源。
  // 边界：不去重、不过滤不存在的路径；去重与校验属父层职责，重复路径会如实反映在计数上。
  // [权衡] 用 length 而非集合大小，保持与全选判定同口径。
  const selectedCount = props.selectedWorkspacePaths.length;
  // [契约] 分母是当前候选列表长度，随扫描结果变化，不缓存上一次扫描的数量。
  // 边界：未扫描或扫描失败时可能为 0，此时全选判定必须为 false。
  // [权衡] 不把 sessionCount 求和当分母，会话条数与工作区条数是两个维度。
  const totalCount = props.workspaceCandidates.length;
  // [契约] 空列表不算全选，totalCount 大于 0 是必要条件，避免空态下按钮显示清空。
  // [权衡] 用严格相等而不做包含判断，父层若传入列表外的路径会显示为未全选，属可接受的保守表现。
  // 边界：本值只驱动按钮文案与回调选择，不写回父层状态。
  const allSelected = totalCount > 0 && selectedCount === totalCount;

  // [契约] 返回体是纯投影：range 与 limit 下拉、扫描按钮、错误提示、候选列表四块，顺序固定。
  // [并发] 扫描按钮在「不支持」或「正在扫描」时禁用，进行中用旋转图标表达唯一进行中信号，防重复触发。
  // [失败路径] scanError 存在时在列表上方插入警示条，列表与已选项保留，便于修好后重试。
  // [契约] 每个候选项是 button，点击即 toggle；勾选框仅展示派生出的 checked，不自行改状态。
  // 边界：长路径用 min-w-0 加 truncate 兜住，避免连续无空格文本把卡片撑出容器。
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={props.migration.range}
          onValueChange={(value) => props.migration.setRange(value as ClaudeMigrationRange)}
        >
          <SelectTrigger size="lg" className="h-9 justify-between text-ui-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">
              {intl.formatMessage({ id: "settings.migration.range.7d" })}
            </SelectItem>
            <SelectItem value="30d">
              {intl.formatMessage({ id: "settings.migration.range.30d" })}
            </SelectItem>
            <SelectItem value="90d">
              {intl.formatMessage({ id: "settings.migration.range.90d" })}
            </SelectItem>
            <SelectItem value="all">
              {intl.formatMessage({ id: "settings.migration.range.all" })}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={props.migration.limitInput}
          onValueChange={(value) => {
            props.migration.setLimitInput(value);
          }}
        >
          <SelectTrigger size="lg" className="h-9 justify-between text-ui-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["30", "50", "100", UNLIMITED_SCAN_LIMIT_INPUT].map((value) => (
              <SelectItem key={value} value={value}>
                {value === UNLIMITED_SCAN_LIMIT_INPUT
                  ? intl.formatMessage({ id: "onboarding.sessions.unlimited" })
                  : intl.formatMessage({ id: "onboarding.sessions.count" }, { count: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-9 min-w-0 px-4 text-ui-base"
          disabled={!props.migration.supportState.supported || props.migration.isScanning}
          onClick={() => {
            void props.migration.scan();
          }}
        >
          {props.migration.isScanning ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "settings.migration.scan" })}
        </Button>
      </div>

      {props.migration.scanError ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
          {intl.formatMessage(
            { id: "settings.migration.scanFailedDescription" },
            { error: props.migration.scanError },
          )}
        </div>
      ) : null}

      <div className="min-h-0 flex w-full flex-col flex-1 rounded-xl border border-border bg-background">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface/50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
            <div className="flex min-w-0 items-center gap-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({
                  id: "onboarding.sessions.chooseWorkspace",
                })}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={totalCount === 0}
            onClick={allSelected ? props.onClearSelection : props.onSelectAll}
          >
            {allSelected
              ? intl.formatMessage({ id: "settingsSync.selection.clearAll" })
              : intl.formatMessage({ id: "settingsSync.selection.selectAll" })}
          </Button>
        </div>
        {props.workspaceCandidates.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "onboarding.sessions.empty" })}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col gap-1 p-2 overflow-y-auto">
            {props.workspaceCandidates.map((workspace) => {
              // [契约] checked 每次渲染都从 props.selectedWorkspacePaths 重新派生，拒绝本地 state 副本。
              // 理由：全选、清空与单项点击都改父层数组，本地副本会滞后一帧，出现点了没反应。
              // 边界：includes 是线性查找，候选规模属引导级列表可接受；大列表应在父层上提为集合。
              // [权衡] 派生而非记忆化，换来一致性；性能若成为问题，应在父层传集合而不是在此加缓存。
              const checked = props.selectedWorkspacePaths.includes(workspace.workspacePath);

              return (
                <button
                  key={workspace.workspacePath}
                  type="button"
                  onClick={() => props.onToggleWorkspace(workspace.workspacePath)}
                  className="flex min-w-0 w-full items-start gap-3 rounded-lg bg-background p-3 pl-3 text-left transition-colors hover:bg-surface-hover/50"
                >
                  <div className="flex size-5 shrink-0 items-center justify-center">
                    <div
                      className={`flex size-4 items-center justify-center rounded-sm border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-transparent"}`}
                    >
                      <CheckIcon className="size-3.5" />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 flex flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0 truncate text-ui-base font-medium text-foreground">
                        {workspace.label}
                      </div>
                      <Badge variant="outline">
                        {intl.formatMessage(
                          { id: "onboarding.sessions.count" },
                          { count: String(workspace.sessionCount) },
                        )}
                      </Badge>
                    </div>
                    {/* 长路径是连续文本，父级 flex 子项如果不允许收缩，会把整张卡片横向撑出容器，所以这里补齐 min-w-0 让 truncate 真正生效。 */}
                    <div className="w-full truncate text-ui-base text-foreground-subtlest">
                      {workspace.workspacePath}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// [契约] 设置步骤只接收 settingsSync 一个入口，状态与动作都从它读取，本组件不注入服务。
// [契约] 勾选结果由 settingsSync.state.selectedKeys 拥有，勾选动作是 actions.toggleSelection。
// 边界：本组件不判断哪些类目可导入，可导入性由 discovery 数据与选择组件决定。
// 可回退：类目全选或清空同样走 actions，组件只转发意图，保证撤销与重放一致。
export function OnboardingAgentSettingsStep(props: {
  settingsSync: ReturnType<typeof useSettingsSync>;
}) {
  const { intl } = useZCodeIntl();

  // [契约] 四分支优先级固定：有 discovery 先渲染选择面板，其次 loading，其次 error，最后空态。
  // 理由：loading 与 error 可能同时为真（重试中带上次错误），优先展示数据可用态，避免闪烁空态。
  // [失败路径] error 分支只渲染提示文本，不阻塞关闭或下一步，保证引导可继续。
  // [事务] discovery 到达即视为可交互，选择面板内部自行处理类目全选，本层不复制分类状态。
  // 边界：本层不解构 discovery 的字段，字段变化不影响本文件。
  const { discovery, loading, error } = props.settingsSync.state;

  // [契约] 容器只负责滚动与分隔线，内容分支的书写顺序即用户可见优先级。
  // [权衡] 选择面板在 flex-1 槽位内滚动，加载态与错误提示共用同一槽位，避免页面高度跳动。
  // [失败路径] loading 用旋转图标加文案，error 用警示样式；两者都不写进全局错误态。
  // 边界：空态用虚线框表达无内容可选，与失败态在视觉上明确区分。
  // 可回退：分支切换完全由 props 驱动，重新打开引导会重新走一遍状态机。
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col rounded-xl bg-background border border-border overflow-y-auto">
      <div className="flex min-h-0 flex-1 flex-col gap-1 border-b border-border p-2">
        {discovery ? (
          <SettingsSyncSelectionStep
            discovery={discovery}
            selectedKeys={props.settingsSync.state.selectedKeys}
            onToggleSelection={props.settingsSync.actions.toggleSelection}
            onSetCategorySelectionAllAgents={
              props.settingsSync.actions.setCategorySelectionAllAgents
            }
          />
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-ui-base text-foreground-subtle">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "common.loading" })}</span>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
            {error}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background-alt px-4 py-8 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "onboarding.agentSettings.empty" })}
          </div>
        )}
      </div>
    </div>
  );
}

// [契约] 外部 Agent 导入步骤是纯转发：category、state、workspacePath 原样交给选择面板。
// 理由：选中集合、分类展开、冲突处理都归选择面板与父层，复制会双写。
// [契约] workspacePath 允许空值，表示尚未确定落盘工作区，由面板决定是否禁用提交。
// [权衡] 不在本层做空路径兜底或默认工作区推断，避免把错误路径写进导入事务。
// 边界：本组件不拦截面板内链接点击，保持浏览器默认行为，也不改 target 与 rel。
export function OnboardingExternalAgentImportStep(props: {
  category: ImportResourceCategory;
  state: ExternalAgentImportCategoryState;
  workspacePath: string | null | undefined;
}) {
  return (
    <ExternalAgentImportSelectionPanel
      category={props.category}
      state={props.state}
      workspacePath={props.workspacePath}
    />
  );
}

// [契约] 迁移步骤只读两个值：overallProgress 与 finishExecution.currentTaskLabel。
// [资源] 进度由上层按已完成任务累计，本组件不计时、不插值、不发起轮询。
// [契约] 进度条与百分比文本共用同一个值，保证视觉与数字同帧一致。
// [失败路径] 任务标签为空时回退 ready 文案，不渲染空白行。
// 边界：本步骤不提供取消或重试按钮，中断语义由上层决定并体现在 finishExecution.error。
export function OnboardingMigrationStep(props: {
  overallProgress: number;
  finishExecution: FinishExecutionState;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex h-full min-h-0 flex-col justify-center">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-xl bg-background border border-border px-6 py-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
            <span>
              {intl.formatMessage({
                id: "settingsSync.importing.progressLabel",
              })}
            </span>
            <span>{props.overallProgress}%</span>
          </div>
          <Progress value={props.overallProgress} className="h-2 rounded-full bg-card" />
        </div>

        <div className="flex gap-3">
          <Loader2Icon className="size-5 animate-spin" />
          <div>
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage(
                { id: "onboarding.migration.progress" },
                { progress: String(props.overallProgress) },
              )}
            </div>
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {props.finishExecution.currentTaskLabel ??
                intl.formatMessage({ id: "onboarding.migration.ready" })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// [契约] 完成步骤接收 overallProgress、finishExecution 与 settings 三组计数，全部只读。
// [事务] 完成态幂等：同一组 props 重复渲染得到同一组数字，渲染期不做累加或去重。
// [契约] 三个汇总卡片固定为会话、agentsFile、设置，每组都展示 imported/skipped/failed。
// [失败路径] finishExecution.error 存在时在标题下方提示，但不改写成功图标与文案，表示部分失败。
// 边界：不在此处触发跳转或关闭引导，收尾动作由上层按钮完成。
export function OnboardingFinishStep(props: {
  overallProgress: number;
  finishExecution: FinishExecutionState;
  settingsImportedCount: number;
  settingsSkippedCount: number;
  settingsFailedCount: number;
}) {
  const { intl } = useZCodeIntl();

  // [契约] 返回体自顶向下：成功图标、完成标题、就绪文案、可选错误条、三列汇总网格。
  // [权衡] 汇总用 md 三列网格，窄屏自动堆叠为单列，保证手机 Web 下三组数字仍可读。
  // [契约] `md:grid-cols-3` 汇总内层再用两列网格：标签在左，数字在右。
  // 边界：错误条只在有 error 时出现，位置在标题区内部，不打断下方汇总布局。
  // 可回退：本层不持有展开或收起状态，内容常显，重复渲染无副作用。
  return (
    <div className="flex h-full min-h-0 flex-col gap-8 pt-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-success text-success-foreground">
          <CheckIcon className="size-7" />
        </div>
        <div className="text-2xl font-medium text-foreground">
          {intl.formatMessage({ id: "onboarding.finish.done" })}
        </div>
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "onboarding.finish.ready" })}
        </div>
        {props.finishExecution.error ? (
          <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
            {props.finishExecution.error}
          </div>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.sessions" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.finishExecution.sessionImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.finishExecution.sessionSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.finishExecution.sessionFailedCount}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.agentsFile" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.finishExecution.agentsFileImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.finishExecution.agentsFileSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.finishExecution.agentsFileFailedCount}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.settings" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.settingsImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.settingsSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.settingsFailedCount}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
