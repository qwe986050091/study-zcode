/* eslint-disable max-lines -- 远端 MCP 同步弹窗集中维护加载、选择、结果和批量选择状态，拆分会增加跨状态传递复杂度。 */
// ============================================================================
// 职责边界
// 做：远端 MCP 同步弹窗——加载本地候选与远端同名状态、按行选择、preflight 校验、
//     导出与导入、逐项结果展示。
// 不做：不决定远程目标（remoteTarget 由上层传入），不持久化任何选择，
//       不直接读写远端文件（全部经 IMcpSyncService）。
// 依赖：localMcpSyncService / remoteMcpSyncService（IMcpSyncService）、
//       RemoteSyncActions 的 preflight 超时封装、RemoteSkillSyncDialog 的目标文案格式化。
// 边界：rows/selectedIds/step 都是「本次打开」的临时视图状态，关闭即丢弃；
//       远端事实只来自 listRemoteUserMcpStatuses 与 importMcpServers 的返回。
//       覆盖远端配置必须经显式交互，本弹窗默认只新增。
// 观测：每步都有 step 文案与 error 文案，失败不允许静默停留。
//
// INV 不变量表
// INV-01 断言：步骤只能单向推进，失败必须回到 selection —— 守住它的位置：各处 setStep —— 改错故障：失败后停在 syncing，弹窗永久不可操作。
// INV-02 断言：in-flight 期间禁止关闭弹窗 —— 守住它的位置：handleOpenChange 守卫 —— 改错故障：import 已在远端执行而 UI 已卸载，用户重复发起同步。
// INV-03 断言：syncInFlightRef 必须在 finally 复位，不能只在成功路径 —— 守住它的位置：syncSelected 的 finally —— 改错故障：一次失败后按钮永久失效。
// INV-04 断言：selectedIds 只存 id，不存行对象 —— 守住它的位置：state 类型 —— 改错故障：状态刷新后选中项指向过期行，同步错服务器。
// INV-05 断言：默认选择必须是远端不存在的项 —— 守住它的位置：resolveDefaultRemoteMcpSyncSelection —— 改错故障：默认覆盖远端已有配置。
// INV-06 断言：已存在的行必须 disabled 且 selected 永远为 false —— 守住它的位置：SelectionList —— 改错故障：勾选态与可编辑性不一致，误导用户。
// INV-07 断言：可见过滤不能缩小 selectedIds 本身 —— 守住它的位置：filter 与 selectedSyncIds 求交 —— 改错故障：隐藏已存在项时清空用户选择。
// INV-08 断言：selectedSyncIds 必须是 visibleMissingIds 与 selectedIds 的交集 —— 守住它的位置：useMemo —— 改错故障：同步了被过滤掉的项。
// INV-09 断言：overwrite 必须固定为 false —— 守住它的位置：buildRemoteMcpSyncImportParams —— 改错故障：远端同名服务器被静默覆盖。
// INV-10 断言：localHomeDir 必须优先用导出结果里的值 —— 守住它的位置：exported.localHomeDir 的回退表达式 —— 改错故障：远程路径映射错，导入到错误目录。
// INV-11 断言：preflight 必须在 export 与 import 之前完成 —— 守住它的位置：syncSelected 顺序 —— 改错故障：无写权限时仍导出，白做一次读取并可能泄漏路径。
// INV-12 断言：preflight 超时必须走专门的错误文案 —— 守住它的位置：isRemoteSyncPreflightTimeoutError 分支 —— 改错故障：超时被当成普通失败，用户误以为权限不足。
// INV-13 断言：onSynced 必须在 setImportResult 之前 await —— 守住它的位置：try 内顺序 —— 改错故障：父组件刷新后结果列表被重置为空。
// INV-14 断言：打开弹窗时必须重置全部状态 —— 守住它的位置：open effect —— 改错故障：上次同步结果残留，用户以为本次已同步。
// INV-15 断言：异步加载必须用 cancelled 标记丢弃过期响应 —— 守住它的位置：load effect cleanup —— 改错故障：快速开关弹窗时旧响应覆盖新状态。
// INV-16 断言：indeterminate 只能通过 ref 命令式设置 —— 守住它的位置：BulkSelectionCheckbox effect —— 改错故障：React 不支持该属性，checked 与显示不一致。
// INV-17 断言：全选与清空必须基于 visibleMissingIds —— 守住它的位置：onSelectAll/onClearAll —— 改错故障：把已存在项也选进集合。
// INV-18 断言：rows 与 statuses 必须按 name 关联，不能按 index —— 守住它的位置：buildRemoteMcpSyncRows —— 改错故障：状态错位，已存在的被当成缺失。
// INV-19 断言：结果项的 key 必须含 status —— 守住它的位置：结果列表 key —— 改错故障：同名不同状态渲染复用错误节点。
// INV-20 断言：错误文案必须来自 intl，异常 message 之外不得硬编码 —— 守住它的位置：setError 各分支 —— 改错故障：多语言下出现英文原文或空白。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircleIcon, Loader2, Server, UploadCloud } from "lucide-react";
import type {
  McpServerConfig,
  McpSyncCandidate,
  McpSyncExportResult,
  McpSyncImportResult,
  McpSyncRemoteStatus,
  RemoteTarget,
} from "@zcode/shared";
import type { IMcpSyncService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";

// [契约] Step 是五态机：loading → selection → preflighting → syncing → complete。
// preflighting 与 syncing 必须在 UI 上可区分：用户需要知道是在校验权限还是在传输。
//
// [并发] complete 之后仍允许重新打开，但必须经过 open effect 重置回 loading（见 INV-14）；
// 不要复用上一次的 complete 状态，否则会看到旧结果。
// [事务] 失败只能回到 selection，不能回到 loading：loading 会重新拉取列表，
// 掩盖真实的失败原因并放大请求量。
// [失败路径] 任何 setStep 都必须与 error 的写入成对：step 变了而 error 为空时，
// 用户看到「什么都没发生」。
// [边界] RemoteMcpSyncRow 只有 candidate 与 exists 两个字段，
// 不要在这里加 selected 标志——选择态属于 selectedIds 集合，两处存会不一致。
// [资源] 类型是纯编译期约定，运行时没有校验；后端返回结构变化不会在这里报错。
type Step = "loading" | "selection" | "preflighting" | "syncing" | "complete";

export interface RemoteMcpSyncRow {
  candidate: McpSyncCandidate;
  exists: boolean;
}

interface RemoteMcpSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localMcpSyncService: IMcpSyncService;
  remoteMcpSyncService: IMcpSyncService;
  remoteTarget: RemoteTarget;
  workspacePath: string;
  localWorkspacePath?: string;
  onSynced: () => Promise<void> | void;
}

// [契约] rows 由 candidates 决定顺序与数量，statuses 只提供 exists 标记，不能反过来遍历 statuses。
// 按 name 关联而不是按 index：两次调用之间候选集合可能变化，index 对齐会错位（见 INV-18）。
//
// [失败路径] 远端没有同名状态时 exists 必须为 false：
// 否则「远端新增」会被误判为已存在，导致默认不勾选、无法同步。
//
// [边界] 返回新对象数组，不引用 candidate；candidate 本身仍共享，不要原地修改。
// [资源] Map 只在函数内构建一次，调用方每次刷新都会重建，不做缓存。
export function buildRemoteMcpSyncRows(
  candidates: readonly McpSyncCandidate[],
  statuses: readonly McpSyncRemoteStatus[],
): RemoteMcpSyncRow[] {
  const statusByName = new Map(statuses.map((status) => [status.name, status]));
  return candidates.map((candidate) => ({
    candidate,
    exists: statusByName.get(candidate.name)?.exists ?? false,
  }));
}

// [契约] 默认只勾选远端不存在的项：已存在的默认不覆盖（与 overwrite false 对齐）。
//
// [失败路径] rows 为空时返回空 Set 而不是 null：调用方直接用它设置选中集合。
//
// [边界] 返回新 Set，不复用入参集合；调用方随后会在其上做增删。
// [资源] `resolveDefaultRemoteMcpSyncSelection` 每次加载只调一次，规模是 `rows` 的候选数量级。
export function resolveDefaultRemoteMcpSyncSelection(
  rows: readonly RemoteMcpSyncRow[],
): Set<string> {
  return new Set(
    rows.filter((row) => !row.exists).map((row) => row.candidate.id),
  );
}

// [契约] 过滤只影响可见行，不修改 selectedIds：隐藏已存在项不能清空用户的选择（见 INV-07）。
//
// [权衡] 开关为真时返回浅拷贝而不是原数组：
// 调用方可能对结果排序或变更，返回原引用会污染 rows 状态。
// [边界] 过滤条件只看 exists，不看选中态或名称；不要把搜索逻辑塞进这里。
// [资源] 一次线性遍历，memo 依赖 rows 与开关。
export function filterRemoteMcpSyncRows(
  rows: readonly RemoteMcpSyncRow[],
  showExistingRemoteMcp: boolean,
): RemoteMcpSyncRow[] {
  return showExistingRemoteMcp ? [...rows] : rows.filter((row) => !row.exists);
}

// [契约] overwrite 必须固定为 false：远程同名服务器一律不覆盖（见 INV-09）。
// 需要覆盖时必须先做显式交互，不能通过这个参数悄悄打开。
//
// [并发] localHomeDir 优先取导出结果里的值，再回退到本地探测值：
// 导出结果反映本次读取时的真实 home，探测值可能因环境变化过期（见 INV-10）。
// [事务] localWorkspacePath 是可选透传：undefined 表示本地没有工作区上下文，
// 不要用空串代替 `undefined`：服务端据此区分「无工作区」与「工作区为空」。
// [失败路径] servers 直接引用 exported.servers，不复制：导入是只读消费；
// 若未来服务端会修改入参，必须在这里深拷贝。
// [边界] 返回类型用 Parameters 从服务接口提取，不要另建本地类型，
// 否则接口演进时这里不会报错。
// [资源] `buildRemoteMcpSyncImportParams` 只读入参且不复制 `exported.servers`，无副作用。
export function buildRemoteMcpSyncImportParams(params: {
  exported: McpSyncExportResult;
  localHomeDir: string;
  localWorkspacePath?: string;
  remoteWorkspacePath: string;
}): Parameters<IMcpSyncService["importMcpServers"]>[0] {
  return {
    servers: params.exported.servers,
    localHomeDir: params.exported.localHomeDir || params.localHomeDir,
    localWorkspacePath: params.localWorkspacePath,
    remoteWorkspacePath: params.remoteWorkspacePath,
    overwrite: false,
  };
}

// [契约] 优先级是显式 type → command（stdio）→ url（http）→ unknown。
// 顺序不能改：同时带 command 与 url 的配置，必须尊重显式 type。
//
// [失败路径] 空字符串或纯空白视为未设置，走下一级；直接判真值会把空白串当成有效类型。
//
// [权衡] 返回值用于 UI 徽标，不做国际化：type 是配置字面量，翻译反而失真。
// type 值来自配置文件原文，本地化会让 stdio 之类的术语变得不可读。
// [边界] unknown 是兜底展示，不表示配置非法；真正的校验在服务端。
function resolveMcpTypeLabel(config: McpServerConfig): string {
  if (typeof config.type === "string" && config.type.trim()) {
    return config.type.trim();
  }
  if (typeof config.command === "string" && config.command.trim()) {
    return "stdio";
  }
  if (typeof config.url === "string" && config.url.trim()) {
    return "http";
  }
  return "unknown";
}

export function RemoteMcpSyncTitle() {
  const { intl } = useZCodeIntl();
  const [warningTooltipOpen, setWarningTooltipOpen] = useState(false);
  const warningTitle = intl.formatMessage({
    id: "settings.mcp.remoteSync.warningTitle",
  });

  return (
    <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "settings.mcp.remoteSync.title" })}
      </span>
      <ControlHintTooltip
        open={warningTooltipOpen}
        title={warningTitle}
        description={intl.formatMessage({
          id: "settings.mcp.remoteSync.warningDescription",
        })}
        side="right"
        align="center"
      >
        <span
          aria-label={warningTitle}
          className="inline-flex size-5 items-center justify-center rounded-full text-warning transition-colors hover:bg-hover hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onMouseEnter={() => setWarningTooltipOpen(true)}
          onMouseLeave={() => setWarningTooltipOpen(false)}
          role="img"
        >
          <AlertCircleIcon className="size-3.5" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </DialogTitle>
  );
}

export function RemoteMcpSyncExistingFilterCheckbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <label className="inline-flex h-6 cursor-pointer items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle hover:text-foreground">
      <input
        type="checkbox"
        className="size-4"
        checked={checked}
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
      />
      <span>{intl.formatMessage({ id: "settings.mcp.remoteSync.showExisting" })}</span>
    </label>
  );
}

export function RemoteMcpSyncTargetRow({
  targetLabel,
  showExistingRemoteMcp,
  showExistingFilter,
  onShowExistingRemoteMcpChange,
}: {
  targetLabel: string;
  showExistingRemoteMcp: boolean;
  showExistingFilter: boolean;
  onShowExistingRemoteMcpChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage(
          { id: "settings.mcp.remoteSync.target" },
          { target: targetLabel },
        )}
      </p>
      {showExistingFilter ? (
        <div className="shrink-0">
          <RemoteMcpSyncExistingFilterCheckbox
            checked={showExistingRemoteMcp}
            onCheckedChange={onShowExistingRemoteMcpChange}
          />
        </div>
      ) : null}
    </div>
  );
}

// [契约] indeterminate 只能通过 ref 命令式设置：React 没有对应 prop（见 INV-16）。
// aria-checked 必须三态（mixed/true/false），只写 checked 会让读屏软件读到错误状态。
//
// [并发] checked 由 selectedCount 与 totalSelectable 推导，不单独存 state：
// 两处存会在删除行后不同步。
//
// [失败路径] disabled 时仍渲染（半透明）而不是卸载：
// 卸载会让布局跳动，也会让「全部已存在」时缺少解释。
// [边界] 全选只针对 totalSelectable（可见缺失项），不包含已存在项（见 INV-17）。
// [资源] effect 依赖 indeterminate 而不是 checked；依赖写错会漏更新。
export function RemoteMcpSyncBulkSelectionCheckbox({
  selectedCount,
  totalSelectable,
  onSelectAll,
  onClearAll,
}: {
  selectedCount: number;
  totalSelectable: number;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = totalSelectable === 0;
  const checked = totalSelectable > 0 && selectedCount >= totalSelectable;
  const indeterminate =
    totalSelectable > 0 && selectedCount > 0 && selectedCount < totalSelectable;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label
      className={`inline-flex h-6 items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle ${
        disabled ? "opacity-50" : "cursor-pointer hover:text-foreground"
      }`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : checked ? "true" : "false"}
        onChange={(event) => {
          if (event.currentTarget.checked) {
            onSelectAll();
          } else {
            onClearAll();
          }
        }}
      />
      <span>{intl.formatMessage({ id: "settings.mcp.remoteSync.selectAll" })}</span>
    </label>
  );
}

// [契约] selected 必须是「不存在且被勾选」：已存在的项即使 id 在集合里也显示未选（见 INV-06）。
//
// [并发] 已存在的行 disabled 且 cursor-default，但保留展示：
// 隐藏会让用户无法确认「远端已有同名服务器」。
//
// [事务] checkbox 与整行 label 通过 htmlFor/id 绑定，点击行等于点击复选框；
// 去掉 label 包装会导致键盘与触屏行为退化。
// [失败路径] rows 为空时渲染 emptyMessageId 文案，不返回 null：
// 空视图必须有解释，否则弹窗看起来像加载失败。
// [权衡] key 用 candidate.id 而不是 name：同名不同来源的候选必须能同时展示。
// [边界] 这里不改变选择，只回调 onToggle；选择集合的所有权在父组件。
// [资源] 每行新建 checkboxId 字符串，纯渲染期计算，无副作用。
export function RemoteMcpSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.mcp.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemoteMcpSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: emptyMessageId })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const checkboxId = `remote-mcp-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const typeLabel = resolveMcpTypeLabel(row.candidate.config);
        const selected = !row.exists && selectedIds.has(row.candidate.id);
        return (
          <label
            key={row.candidate.id}
            htmlFor={checkboxId}
            className={`grid grid-cols-[auto_auto_minmax(0,1fr)] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base ${
              row.exists
                ? "cursor-default"
                : "cursor-pointer hover:border-border-hover hover:bg-surface-hover"
            }`}
          >
            <input
              id={checkboxId}
              type="checkbox"
              aria-labelledby={labelId}
              className="mt-1 size-4"
              checked={selected}
              disabled={row.exists}
              onChange={(event) =>
                onToggle(row.candidate.id, event.currentTarget.checked)
              }
            />
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Server className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span id={labelId} className="font-medium text-foreground">
                  {row.candidate.name}
                </span>
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {typeLabel}
                </span>
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.source}
                </span>
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.mcp.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                {row.candidate.path}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

// [契约] 结果项可能同时有 error 与 path，error 优先展示：失败时路径存在也不代表导入成功。
// [失败路径] result 为 null 或 results 为空时展示 resultEmpty，不抛错：
// 同步失败会回到 selection，但 complete 也可能收到空结果。
// [边界] status 文案用模板 key 直接拼 settings.mcp.remoteSync 前缀，
// 新增状态必须同步 i18n，否则显示原始 key。
// [资源] 纯展示，无状态。
function RemoteMcpSyncResultList({
  result,
}: {
  result: McpSyncImportResult | null;
}) {
  const { intl } = useZCodeIntl();
  const items = result?.results ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.mcp.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={`${item.name}-${item.status}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">
                {item.name}
              </div>
              {item.error ? (
                <div className="mt-0.5 break-words text-ui-base text-destructive">
                  {item.error}
                </div>
              ) : item.path ? (
                <div className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest">
                  {item.path}
                </div>
              ) : null}
            </div>
            <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle ring-1 ring-border">
              {intl.formatMessage({ id: `settings.mcp.remoteSync.${item.status}` })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RemoteMcpSyncDialog(props: RemoteMcpSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const {
    localMcpSyncService,
    localWorkspacePath,
    onOpenChange,
    onSynced,
    open,
    remoteMcpSyncService,
    remoteTarget,
    workspacePath,
  } = props;
  // [契约] 状态全部是「本次打开」的临时视图：step/rows/selectedIds/filter/result/error/homeDir。
  // 不要把这些提升到 store，关闭弹窗后它们没有任何意义。
  //
  // [并发] syncInFlightRef 用 ref 而不是 state：它只用于同步判定，
  // 写进 state 会多一轮 render，并在闭包里读到旧值（见 INV-03）。
  //
  // [事务] showExistingRemoteMcp 默认 true：默认展示全量，让用户先看到远端现状。
  //
  // [权衡] 七个 useState 保持平铺，不合并成一个对象：
  // 合并后任一字段变化都会重渲染整棵结果列表，且 setState 必须手动展开。
  // [失败路径] error 是字符串而不是 Error 对象：跨组件边界只保留可展示文本。
  // [边界] localWorkspacePath 可选，与 workspacePath（远端）分开；
  // 两者不能合并成一个参数，否则导入路径映射会错。
  // [资源] 所有状态随组件卸载释放，无全局副作用。
  const [step, setStep] = useState<Step>("loading");
  const [rows, setRows] = useState<RemoteMcpSyncRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showExistingRemoteMcp, setShowExistingRemoteMcp] = useState(true);
  const [importResult, setImportResult] = useState<McpSyncImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localHomeDir, setLocalHomeDir] = useState("");
  const syncInFlightRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    // [契约] 打开时必须先把全部状态重置，再发起请求：
    // 重置顺序反了会让上一次的结果在新一轮加载期间闪现（见 INV-14）。
    //
    // [并发] cancelled 标记必须在 cleanup 中置真，且每次 await 后立刻检查：
    // 快速开关弹窗时旧响应会覆盖新状态（见 INV-15）。
    // [事务] 本地与远端两次请求必须串行：远端状态查询需要 names，
    // names 来自本地结果；并行会退化成两次全量拉取。
    // [失败路径] 加载失败也要回到 selection：停在 loading 会让弹窗永久转圈，用户无法重试。
    // [边界] effect 依赖三个 service 引用与 open；把 intl 放进来会在语言切换时重新拉取。
    // [资源] cleanup 只置标记，不取消底层请求——service 层没有取消接口。
    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowExistingRemoteMcp(true);
    setImportResult(null);
    setError(null);
    setLocalHomeDir("");
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const localResult = await localMcpSyncService.listLocalUserMcpCandidates();
        const remoteResult = await remoteMcpSyncService.listRemoteUserMcpStatuses({
          names: localResult.candidates.map((candidate) => candidate.name),
        });
        if (cancelled) {
          return;
        }
        const nextRows = buildRemoteMcpSyncRows(
          localResult.candidates,
          remoteResult.statuses,
        );
        setLocalHomeDir(localResult.localHomeDir);
        setRows(nextRows);
        setSelectedIds(resolveDefaultRemoteMcpSyncSelection(nextRows));
        setStep("selection");
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStep("selection");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [localMcpSyncService, open, remoteMcpSyncService]);

  // [契约] 三个派生集合的层级是 visibleRows → visibleMissingIds → selectedSyncIds，
  // 后一个永远从前一个过滤，不能直接从 rows 计算（见 INV-08）。
  //
  // [并发] selectedSyncIds 必须与 visibleMissingIds 求交：
  // selectedIds 里可能残留被过滤掉的 id，直接用它同步会导入用户看不见的项。
  //
  // [事务] selectedCount 与 totalSelectable 分别取自两个集合：
  // 前者是可见且缺失的已选数量，后者是可见缺失总数；用反了会让计数超过总数。
  // [失败路径] 过滤关闭时 visibleMissingIds 就是全部缺失项，
  // selectedIds 不会自动扩展——这是预期，用户需要显式全选。
  // [权衡] 三个 useMemo 分开而不是合成一个大对象：
  // 合成后任一依赖变化都会重算全部，且引用不稳定会导致子组件重渲染。
  // [边界] targetLabel 每次渲染都重算，属于纯字符串格式化，不做 memo。
  // [资源] 所有 memo 依赖都只含 state 与 rows，不含服务引用。
  const visibleRows = useMemo(
    () => filterRemoteMcpSyncRows(rows, showExistingRemoteMcp),
    [rows, showExistingRemoteMcp],
  );
  const visibleMissingIds = useMemo(
    () => visibleRows.filter((row) => !row.exists).map((row) => row.candidate.id),
    [visibleRows],
  );
  const selectedSyncIds = useMemo(
    () => visibleMissingIds.filter((id) => selectedIds.has(id)),
    [selectedIds, visibleMissingIds],
  );
  const selectedCount = selectedSyncIds.length;
  const targetLabel = formatRemoteSkillSyncTarget(remoteTarget, workspacePath);

  // [契约] preflighting 与 syncing 期间禁止关闭：远端写入已经发出，
  // 关闭会让用户以为没执行从而重复发起（见 INV-02）。
  //
  // [失败路径] 其余状态下关闭一律放行，包括 complete：
  // `complete` 已展示完，用户有权直接关：不要额外拦截。
  // [边界] 这里只决定是否把 openChange 透传给父组件，不改内部 step；
  // 内部状态由 open effect 在下次打开时重置。
  // [资源] 同步判等两个 step 字面量，常数复杂度。
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (step === "preflighting" || step === "syncing")) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const toggleMcp = (serverId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(serverId);
      } else {
        next.delete(serverId);
      }
      return next;
    });
  };

  // [契约] 顺序固定：prestart 检查 → 置 in-flight → preflight → export → import → onSynced → 结果。
  // preflight 必须早于 export（见 INV-11），onSynced 必须早于 setImportResult（见 INV-13）。
  //
  // [并发] syncInFlightRef 必须在 finally 复位；只在成功路径复位会让一次失败后按钮永久失效。
  //
  // [事务] 失败时回到 selection 并保留已选集合，用户可以直接重试；
  // 清空选择会让用户重新勾选，是明显的体验退化。
  // [失败路径] 无选择时只写 error，不改变 step：当前就是 selection，改 step 只是无意义重渲染。
  // [权衡] 错误文案按超时判定分流：超时与权限失败的处置完全不同，
  // 合并成一条会误导用户（见 INV-12）。
  // [边界] 所有写入都经 service，函数本身不接触文件系统与网络细节。
  // [资源] 整个流程没有取消令牌，依赖 in-flight 标志防重入。
  const syncSelected = async () => {
    if (
      !shouldStartRemoteSyncOperation({
        inFlight: syncInFlightRef.current,
        selectedCount: selectedSyncIds.length,
      })
    ) {
      if (selectedSyncIds.length === 0) {
        setError(intl.formatMessage({ id: "settings.mcp.remoteSync.noSelection" }));
      }
      return;
    }

    syncInFlightRef.current = true;
    setError(null);
    setStep("preflighting");
    try {
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remoteMcpSyncService.checkRemoteUserMcpWriteAccess(),
      );
      if (!access.ok) {
        throw new Error(
          intl.formatMessage(
            { id: "settings.remoteSync.preflightFailed" },
            { path: access.path, error: access.error ?? "" },
          ),
        );
      }
      // [事务] preflight 通过后才进入 syncing：提前置 syncing 会让 UI 显示正在同步，
      // 而实际还在校验权限，失败时用户看到状态倒退。
      // [并发] 这一步与 in-flight 标志共同构成互斥：
      // 标志在进入前已置真，按钮 disabled 只是第二道防线，不能替代它。
      // [失败路径] 这里不 catch，异常统一由外层 catch 处理并回退 step；
      // 局部 try 会把错误吞掉，导致弹窗停在 syncing。
      // [边界] 只改 UI 状态，不触发任何 IO；export 发生在下一行。
      // [资源] 切换 step 会让列表卸载，选择状态仍保留在 selectedIds。
      setStep("syncing");
      const exported = await localMcpSyncService.exportMcpServers({
        serverIds: selectedSyncIds,
      });
      const result = await remoteMcpSyncService.importMcpServers(
        buildRemoteMcpSyncImportParams({
          exported,
          localHomeDir,
          localWorkspacePath,
          remoteWorkspacePath: workspacePath,
        }),
      );
      await onSynced();
      setImportResult(result);
      setStep("complete");
    } catch (syncError) {
      setError(
        isRemoteSyncPreflightTimeoutError(syncError)
          ? intl.formatMessage(
              { id: "settings.remoteSync.preflightTimeout" },
              { seconds: String(Math.ceil(syncError.timeoutMs / 1000)) },
            )
          : syncError instanceof Error
            ? syncError.message
            : String(syncError),
      );
      setStep("selection");
    } finally {
      syncInFlightRef.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="h-[min(720px,calc(100dvh-2rem))] max-h-[min(720px,calc(100dvh-2rem))] max-w-2xl flex flex-col overflow-hidden">
        <DialogHeader>
          <RemoteMcpSyncTitle />
          <RemoteMcpSyncTargetRow
            targetLabel={targetLabel}
            showExistingRemoteMcp={showExistingRemoteMcp}
            showExistingFilter={step === "selection" && rows.length > 0}
            onShowExistingRemoteMcpChange={setShowExistingRemoteMcp}
          />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-surface px-3 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          {step === "loading" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.mcp.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemoteMcpSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={
                rows.length > 0
                  ? "settings.mcp.remoteSync.filteredEmpty"
                  : undefined
              }
              onToggle={toggleMcp}
            />
          ) : null}
          {step === "syncing" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.mcp.remoteSync.syncing" })}
            </div>
          ) : null}
          {step === "complete" ? (
            <RemoteMcpSyncResultList result={importResult} />
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.mcp.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleMissingIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemoteMcpSyncBulkSelectionCheckbox
                selectedCount={selectedCount}
                totalSelectable={visibleMissingIds.length}
                onSelectAll={() => setSelectedIds(new Set(visibleMissingIds))}
                onClearAll={() => setSelectedIds(new Set())}
              />
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={step !== "selection" || selectedCount === 0}
              onClick={syncSelected}
            >
              <UploadCloud className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.mcp.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
