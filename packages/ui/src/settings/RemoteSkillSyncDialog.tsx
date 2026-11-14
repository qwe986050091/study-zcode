// RemoteSkillSyncDialog —— 把本地用户级 Skill 同步到远端目标的弹窗，覆盖加载、选择、预检、
// 同步与结果五个阶段，并把服务错误翻译成可操作的中文提示。
//
// 职责边界
// 做：拉取本地候选与远端存在性、维护选择集与筛选、串行执行预检与导入、展示逐条结果。
// 不做：连接管理、远端目录创建、归档格式定义、宿主技能列表刷新。
// 依赖：ISkillSyncService 的本地与远端两个实例，以及远端同步工具里的超时与守卫函数。
// 被谁用：技能设置页的远端同步入口，宿主在同步成功后负责刷新技能列表。
// 边界：所有网络动作都由注入的服务执行，弹窗只负责编排与状态呈现。
//
// INV 不变量（违反任意一条都可能覆盖远端技能，或让弹窗卡在中间态）
// INV-01 默认只勾选远端不存在的技能 —— 守住它的位置：默认选择函数 —— 改错故障：一次点击就覆盖远端已有目录。
// INV-02 已存在项必须用户显式勾选才可覆盖 —— 守住它的位置：默认选择与筛选的配合 —— 改错故障：用户以为只是补充，实际覆盖了远端修改。
// INV-03 行数据按目录名匹配远端状态 —— 守住它的位置：行构建函数的索引 —— 改错故障：改过显示名的技能被误判为不存在并覆盖。
// INV-04 远端状态缺失按不存在处理，不得留未知态 —— 守住它的位置：行构建的空值合并 —— 改错故障：行进入未知态，默认勾选判断失效。
// INV-05 最终同步集合是可见缺失项与选择集的交集 —— 守住它的位置：selectedSyncIds —— 改错故障：筛选隐藏后仍同步用户看不到的条目。
// INV-06 筛选不修改原始行数组 —— 守住它的位置：filterRemoteSkillSyncRows —— 改错故障：React 跳过重渲染，勾选看起来没有响应。
// INV-07 预检与同步阶段禁止关闭弹窗 —— 守住它的位置：handleOpenChange —— 改错故障：归档只写入一半，远端目录不完整。
// INV-08 阶段迁移只能向前或回到选择 —— 守住它的位置：全部阶段设置调用点 —— 改错故障：出现「同步中且完成」的不可能界面。
// INV-09 在途标记必须是同步可读的 ref —— 守住它的位置：syncInFlightRef —— 改错故障：双击触发两次导出与导入。
// INV-10 在途标记必须在 finally 中复位 —— 守住它的位置：同步流程的收尾块 —— 改错故障：一次失败后开始按钮永久失效。
// INV-11 本地候选先取、远端状态后查 —— 守住它的位置：加载 effect 的两次等待 —— 改错故障：远端查询缺少目录清单，返回全量或直接报错。
// INV-12 迟到的加载结果必须被取消标志丢弃 —— 守住它的位置：两个等待之后的取消判断 —— 改错故障：关闭重开后旧列表覆盖新结果。
// INV-13 打开时必须重置全部状态与在途标记 —— 守住它的位置：加载 effect 开头 —— 改错故障：第二次打开继承上次的完成态与错误。
// INV-14 导入成功后先通知宿主刷新再切完成态 —— 守住它的位置：同步流程的后半段 —— 改错故障：完成态展示的列表与宿主数据不一致。
// INV-15 容量超限只识别稳定错误码与三个阶段字段 —— 守住它的位置：错误格式化函数 —— 改错故障：内部字节常量暴露给用户，或文案查不到词条。
// INV-16 不确定态只能通过 ref 写原生属性 —— 守住它的位置：批量选择复选框的 effect —— 改错故障：部分勾选显示成全选。
// INV-17 全选态的三个返回值互斥且完备 —— 守住它的位置：批量选择状态函数 —— 改错故障：全选按钮永久不亮或永远可点。
// INV-18 目标展示中空端口必须省略冒号 —— 守住它的位置：目标格式化函数的 SSH 分支 —— 改错故障：界面出现悬空分隔符。
// INV-19 失败后保留原勾选并回到选择态 —— 守住它的位置：同步流程的错误分支 —— 改错故障：重试需要重新勾选全部条目。
// INV-20 预检通过后才允许进入同步态 —— 守住它的位置：预检之后的阶段切换 —— 改错故障：权限不足表现为导入中途失败，无法定位。
//
// 三处看着可以简化、其实不能动的保护：
// 1) 在途标记用 ref，换成 state 会让双击在同一个渲染批次里双发导入。
// 2) 两个等待之后的取消检查，删掉后关闭弹窗仍会被迟到结果写状态。
// 3) 预检与同步阶段拒绝关闭，删掉后归档可能只写入一半。
/* eslint-disable max-lines -- 远端 Skill 同步弹窗集中维护加载、选择、预检和结果状态，拆分会增加跨状态传递复杂度。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, UploadCloud } from "lucide-react";
import {
  normalizeUnknownError,
  SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
  type RemoteTarget,
  type SkillSyncCandidate,
  type SkillSyncImportResult,
  type SkillSyncRemoteStatus,
  type SkillSyncSizeLimitErrorData,
} from "@zcode/shared";
import type { ISkillSyncService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
} from "@/components/ui/dialog.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import {
  RemoteSkillSyncSelectionList,
  type RemoteSkillSyncRow,
} from "@/settings/RemoteSkillSyncSelectionList.js";
import { RemoteSkillSyncResultList } from "@/settings/RemoteSkillSyncResultList.js";
import { RemoteSkillSyncTitle } from "@/settings/RemoteSkillSyncTitle.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";

export {
  RemoteSkillSyncSelectionList,
  shouldToggleRemoteSkillSyncCardSelection,
} from "@/settings/RemoteSkillSyncSelectionList.js";
export type { RemoteSkillSyncRow } from "@/settings/RemoteSkillSyncSelectionList.js";

// [契约] 五步状态机固定为「加载、选择、预检、同步、完成」，迁移只能向前或回到选择。
// [契约] 预检与同步阶段禁止关闭弹窗，关闭守卫依据的正是这两个状态。
// [权衡] 用字符串联合而不是枚举，便于日志与测试直接比对字面量。
// [失败路径] 若新增中间态却漏改关闭守卫，用户可在写入途中关闭弹窗留下半完成的归档。
type Step = "loading" | "selection" | "preflighting" | "syncing" | "complete";

// [契约] 本地与远端是两个独立的同步服务，不能用一个服务承担双向职责。
// [契约] 远端目标与工作区路径只用于展示与错误说明，实际请求由服务自身携带的连接决定。
// [契约] 同步完成回调由宿主注入，必须等待它完成再切完成态，刷新顺序不能反。
// [权衡] 弹窗不持有连接，挂载期间服务由父级提供，关闭后不做额外清理。
interface RemoteSkillSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localSkillSyncService: ISkillSyncService;
  remoteSkillSyncService: ISkillSyncService;
  remoteTarget: RemoteTarget;
  workspacePath: string;
  workspaceIdentity?: string;
  onSynced: () => Promise<void> | void;
}

// [契约] 行数据等于本地候选加远端存在性，远端状态按目录名建索引，一个目录一条。
// [契约] 远端缺失的状态必须按「不存在」处理，不能用空值让行进入未知态。
// [契约] exists 只影响 resolveDefaultRemoteSkillSyncSelection 与筛选，不阻止用户显式选择覆盖。
// [失败路径] 若按显示名而不是目录名匹配，重命名过的技能会被误判为不存在并被覆盖。
// [权衡] 用映射建索引避免每行线性扫描，候选规模是几十到几百级。
export function buildRemoteSkillSyncRows(
  candidates: readonly SkillSyncCandidate[],
  statuses: readonly SkillSyncRemoteStatus[],
): RemoteSkillSyncRow[] {
  const statusByDirectory = new Map(statuses.map((status) => [status.directoryName, status]));
  return candidates.map((candidate) => ({
    candidate,
    exists: statusByDirectory.get(candidate.directoryName)?.exists ?? false,
  }));
}

// [契约] 默认只勾选远端不存在的条目，已存在的必须用户主动选择才覆盖。
// [契约] 返回值是 id 集合，调用方只读，不应在这个集合上增删后复用。
// [失败路径] 若把已存在项也默认勾选，一次点击就会静默覆盖远端技能目录。
// [权衡] 选择态用集合而不是布尔数组，勾选与取消都是常数时间。
export function resolveDefaultRemoteSkillSyncSelection(
  rows: readonly RemoteSkillSyncRow[],
): Set<string> {
  return new Set(
    rows.filter((row) => !row.exists).map((row) => row.candidate.id),
  );
}

// [契约] 关闭「显示已存在」时过滤掉已存在项，不改变原始行数组。
// [契约] 开启时返回浅拷贝，保证下游不会拿到同一引用后误以为未变化。
// [失败路径] 若直接返回原数组，React 可能跳过重渲染，勾选状态看起来没有响应。
// [权衡] 过滤只影响可见行，已勾选但被隐藏的 id 仍保留在集合里，切回时恢复。
export function filterRemoteSkillSyncRows(
  rows: readonly RemoteSkillSyncRow[],
  showExistingRemoteSkills: boolean,
): RemoteSkillSyncRow[] {
  return showExistingRemoteSkills ? [...rows] : rows.filter((row) => !row.exists);
}

// [契约] 目标展示按传输类型分支：SSH 拼用户、主机、端口，WSL 拼发行版与用户。
// [契约] 端口为空时必须省略冒号，不能输出结尾的悬空分隔符。
// [契约] 工作区路径可选，空路径只展示连接目标，避免出现孤立的分隔点。
// [权衡] 这是纯展示函数，不做地址校验也不做转义，输入由上层协议保证。
// [失败路径] 若给未知传输类型返回空串，用户就看不到自己正在往哪里同步。
export function formatRemoteSkillSyncTarget(
  remoteTarget: RemoteTarget,
  workspacePath: string,
): string {
  const target =
    remoteTarget.kind === "ssh"
      ? `${remoteTarget.username}@${remoteTarget.host}${remoteTarget.port ? `:${remoteTarget.port}` : ""}`
      : remoteTarget.kind === "wsl"
        ? ["WSL", remoteTarget.distro, remoteTarget.user?.trim()].filter(Boolean).join(" · ")
        : remoteTarget.kind;
  return workspacePath ? `${target} · ${workspacePath}` : target;
}

// [契约] 只识别稳定的容量超限错误码，其余错误保留原始信息交给上层展示。
// [契约] 超限文案按阶段选择词条：选中内容、归档、解压内容三个阶段各有上限。
// [契约] 字节数统一格式化为 MiB，整数值不补小数位，避免出现多余的小数噪音。
// [失败路径] 若直接把原始错误透传给用户，会暴露内部阶段名与字节常量。
// [权衡] 错误数据结构解析失败时退回原始消息，宁可信息粗糙也不能吞掉错误。
export function formatRemoteSkillSyncError(
  error: unknown,
  intl: Pick<IntlInstance, "formatMessage">,
): string {
  // RPC 原始错误中的字节数和阶段信息不能直接作为用户文案；
  // 这里只识别稳定错误码，按阶段和当前语言生成可操作提示，其他错误保留原始信息。
  const normalizedError = normalizeUnknownError(error);
  if (normalizedError.code !== SKILL_SYNC_SIZE_LIMIT_ERROR_CODE) {
    return normalizedError.message;
  }

  const data = readSkillSyncSizeLimitErrorData(error);
  if (!data) {
    return normalizedError.message;
  }

  const messageId = {
    "selected-content": "settings.skills.remoteSync.sizeLimit.selectedContent",
    archive: "settings.skills.remoteSync.sizeLimit.archive",
    "extracted-content": "settings.skills.remoteSync.sizeLimit.extractedContent",
  }[data.phase];
  return intl.formatMessage(
    { id: messageId },
    {
      actualSize: formatSkillSyncBytes(data.actualBytes),
      maxSize: formatSkillSyncBytes(data.maxBytes),
    },
  );
}

// [契约] 先校验外层是对象、再校验数据字段是对象，逐层收窄后才断言类型。
// [契约] 三个数值与阶段字段必须同时合法，缺一个就视为结构不符并放弃定制文案。
// [契约] data.phase 只能取 selected-content 等三个字面量，其余值视为结构不符。
// [失败路径] 若只判断数据存在就强转，阶段未知时文案查表会得到未定义词条。
// [权衡] 不做完整结构校验，边界只到「能否安全生成提示」为止。
function readSkillSyncSizeLimitErrorData(error: unknown): SkillSyncSizeLimitErrorData | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    return null;
  }
  const candidate = data as Partial<SkillSyncSizeLimitErrorData>;
  if (
    typeof candidate.actualBytes !== "number" ||
    typeof candidate.maxBytes !== "number" ||
    (candidate.phase !== "selected-content" &&
      candidate.phase !== "archive" &&
      candidate.phase !== "extracted-content")
  ) {
    return null;
  }
  return candidate as SkillSyncSizeLimitErrorData;
}

function formatSkillSyncBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return `${Number.isInteger(mebibytes) ? mebibytes : mebibytes.toFixed(1)} MiB`;
}

// [契约] 全选态由总数与已选数推导：0 个可选项时禁用且不勾选。
// [契约] 只有部分选中才算不确定态，已选满不算不确定。
// [契约] 三个返回值互斥且完备，调用方直接用它们驱动复选框。
// [失败路径] 若总数与已选数的比较方向写反，全选按钮会永远不亮。
export function getRemoteSkillSyncBulkSelectionState({
  selectedCount,
  totalSelectable,
}: {
  selectedCount: number;
  totalSelectable: number;
}) {
  const disabled = totalSelectable === 0;
  const checked = totalSelectable > 0 && selectedCount >= totalSelectable;
  const indeterminate = totalSelectable > 0 && selectedCount > 0 && selectedCount < totalSelectable;
  return { checked, disabled, indeterminate };
}

export function RemoteSkillSyncExistingFilterCheckbox({
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
      <span>{intl.formatMessage({ id: "settings.skills.remoteSync.showExisting" })}</span>
    </label>
  );
}

export function RemoteSkillSyncTargetRow({
  targetLabel,
  showExistingRemoteSkills,
  showExistingFilter,
  onShowExistingRemoteSkillsChange,
}: {
  targetLabel: string;
  showExistingRemoteSkills: boolean;
  showExistingFilter: boolean;
  onShowExistingRemoteSkillsChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage(
          { id: "settings.skills.remoteSync.target" },
          { target: targetLabel },
        )}
      </p>
      {showExistingFilter ? (
        <div className="shrink-0">
          <RemoteSkillSyncExistingFilterCheckbox
            checked={showExistingRemoteSkills}
            onCheckedChange={onShowExistingRemoteSkillsChange}
          />
        </div>
      ) : null}
    </div>
  );
}

export function RemoteSkillSyncBulkSelectionCheckbox({
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
  // [契约] 不确定态是原生复选框属性，React 没有对应受控属性，只能通过 ref 写入。
  // [契约] 这个 ref 只在复选框挂载期间有效，写入前必须先判空。
  // [权衡] 不自绘 checkbox，保留原生 input 以维持键盘与读屏行为。
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionState = getRemoteSkillSyncBulkSelectionState({
    selectedCount,
    totalSelectable,
  });

  // [契约] 不确定态变化时同步到原生属性，依赖只取这个布尔值而不是整个选择状态。
  // [契约] checked 由 React 受控属性接管，effect 只写 indeterminate。
  // [失败路径] 若把整个状态对象放进依赖，每次勾选都会重写不确定态，产生多余写入。
  // [契约] 写入前必须判空，卸载瞬间 effect 仍可能被调度。
  // [权衡] 不用布局 effect，视觉上晚一帧可接受，优先保持渲染路径简单。
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = selectionState.indeterminate;
    }
  }, [selectionState.indeterminate]);

  return (
    <label
      className={`inline-flex h-6 items-center gap-2 rounded-md px-1 text-ui-base text-foreground-subtle ${
        selectionState.disabled ? "opacity-50" : "cursor-pointer hover:text-foreground"
      }`}
    >
      <input
        ref={inputRef}
        type="checkbox"
        className="size-4"
        checked={selectionState.checked}
        disabled={selectionState.disabled}
        aria-checked={selectionState.indeterminate ? "mixed" : selectionState.checked ? "true" : "false"}
        onChange={(event) => {
          if (event.currentTarget.checked) {
            onSelectAll();
          } else {
            onClearAll();
          }
        }}
      />
      <span>{intl.formatMessage({ id: "settings.skills.remoteSync.selectAll" })}</span>
    </label>
  );
}

// [契约] 组件是状态机的唯一所有者：步骤、行数据、选择集、错误与导入结果都在这里。
// [契约] 服务与目标从 props 读取，组件不解析路径，也不自己建第二份连接。
// [契约] 关闭后重新打开必须回到初始状态，重置逻辑集中在加载 effect 的开头。
// [失败路径] 若把状态提升到父级，宿主每次打开都要手动清空五份状态，极易漏项。
// [权衡] 单个组件承载全部步骤，避免跨组件传递进行中的异步结果。
export function RemoteSkillSyncDialog(props: RemoteSkillSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const {
    open,
    onOpenChange,
    localSkillSyncService,
    remoteSkillSyncService,
    remoteTarget,
    workspacePath,
    onSynced,
  } = props;
  // [状态] 初始步骤是加载，即使弹窗未打开也保持该值，打开后由 effect 重置。
  // [契约] 完成态只能由同步成功路径进入，取消或失败一律回到选择态。
  // [失败路径] 若初始值设为选择，弹窗首帧会先闪一帧空列表再进入加载。
  // [权衡] 不把步骤拆成多个布尔值，单一状态避免出现「预检中且同步中」这种不可能组合。
  const [step, setStep] = useState<Step>("loading");
  const [rows, setRows] = useState<RemoteSkillSyncRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showExistingRemoteSkills, setShowExistingRemoteSkills] = useState(true);
  const [importResult, setImportResult] = useState<SkillSyncImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // [并发] 用 ref 而不是 state 做在途标记：它需要在同一次事件里同步读取，状态更新是异步的。
  // [契约] 置位与复位必须在 try 与 finally 里成对完成，任何提前返回都要先复位。
  // [契约] 双击开始按钮时第二次调用读到在途标记后直接返回，不会重复导出归档。
  // [失败路径] 若改用 state，两次快速点击会在同一批渲染中读到同一个旧值，形成双发。
  // [权衡] ref 不参与渲染，因此在途状态不影响按钮文案，按钮禁用仍由步骤驱动。
  const syncInFlightRef = useRef(false);
  // 加载请求可能跨越语言切换，effect 闭包中的 intl 会过期；错误提示必须读取最近一次渲染的实例。
  const latestIntlRef = useRef(intl);
  latestIntlRef.current = intl;

  // [并发] 加载 effect 以「打开」为唯一触发条件，服务引用变化也重新加载，避免连到旧服务。
  // [契约] 每次打开先重置全部状态并清掉在途标记，保证不继承上一次的结果。
  // [契约] 本地候选先取，再用候选目录名查远端状态，顺序不能反：远端查询需要目录清单。
  // [契约] 用局部取消标志丢弃迟到结果，关闭后返回的数据不得写入状态。
  // [失败路径] 若省掉取消检查，快速开关会看到上一次的旧列表覆盖新结果。
  // [契约] 本地与远端任一步失败都进入选择态并展示错误，不能停在加载中。
  // [权衡] 依赖只列服务与打开状态，目标与回调变化由宿主重新挂载解决。
  useEffect(() => {
    if (!open) {
      return;
    }

    // [契约] 取消标志在清理函数里置真，effect 重跑或卸载都会触发。
    // [契约] 两个等待之后都要检查它，中间任何一步都可能跨越关闭动作。
    // [失败路径] 若只在第一个等待后检查，远端状态查询迟到仍会写入已关闭的弹窗。
    // [权衡] 不用中止控制器：服务接口不接受信号，取消只能靠丢弃结果实现。
    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowExistingRemoteSkills(true);
    setImportResult(null);
    setError(null);
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const localResult = await localSkillSyncService.listLocalUserSkillCandidates();
        const remoteResult = await remoteSkillSyncService.listRemoteUserSkillStatuses({
          directoryNames: localResult.candidates.map((candidate) => candidate.directoryName),
          skills: localResult.candidates.map((candidate) => ({
            directoryName: candidate.directoryName,
            name: candidate.name,
          })),
        });
        if (cancelled) {
          return;
        }
        const nextRows = buildRemoteSkillSyncRows(
          localResult.candidates,
          remoteResult.statuses,
        );
        setRows(nextRows);
        setSelectedIds(resolveDefaultRemoteSkillSyncSelection(nextRows));
        setStep("selection");
      } catch (loadError) {
        if (cancelled) {
          return;
        }
        setError(formatRemoteSkillSyncError(loadError, latestIntlRef.current));
        setStep("selection");
      }
    })();

    // [契约] cleanup 只把 cancelled 置 true，不调取消接口，请求由服务端超时兜底。
    // [契约] 不在这里复位状态：下一次打开会重新初始化，清理期写状态会触发已卸载警告。
    // [失败路径] 若在清理里把步骤设回加载，关闭动画期间会看到内容突然切换。
    // [权衡] 取消是协作式的：请求仍会完成，只是结果被丢弃，换取实现简单。
    // [契约] cleanup 只丢弃结果，open 分支负责初始化，两段职责不重叠。
    return () => {
      cancelled = true;
    };
  }, [localSkillSyncService, open, remoteSkillSyncService]);

  const visibleRows = useMemo(
    () => filterRemoteSkillSyncRows(rows, showExistingRemoteSkills),
    [rows, showExistingRemoteSkills],
  );
  const visibleMissingIds = useMemo(
    () => visibleRows.filter((row) => !row.exists).map((row) => row.candidate.id),
    [visibleRows],
  );
  // [契约] 最终同步集合是可见缺失项与当前选择的交集，隐藏的已存在项不会混入。
  // [契约] 交集按可见顺序生成，保证归档内条目顺序稳定、便于比对结果。
  // [失败路径] 若直接用选择集，筛选隐藏后仍会同步用户看不到的条目。
  // [权衡] selectedSyncIds 每次渲染重算 visibleMissingIds 与 selectedIds 的交集，规模很小。
  const selectedSyncIds = useMemo(
    () => visibleMissingIds.filter((id) => selectedIds.has(id)),
    [selectedIds, visibleMissingIds],
  );
  const selectedCount = selectedSyncIds.length;
  const targetLabel = formatRemoteSkillSyncTarget(remoteTarget, workspacePath);

  // [契约] 预检与同步阶段拒绝关闭，其他阶段透传给宿主。
  // [契约] 拒绝是静默的：不弹提示也不改状态，路径上不存在可回滚的中间结果。
  // [失败路径] 若允许中途关闭，已导出的归档会留在本地而远端可能只写入一半。
  // [权衡] 用「忽略关闭请求」而不是禁用关闭按钮，避免不同弹窗实现对禁用态支持不一致。
  // [契约] 关闭后才允许宿主销毁组件，因此组件内不需要处理「已关闭但仍在写入」的分支。
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (step === "preflighting" || step === "syncing")) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const toggleSkill = (skillId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(skillId);
      } else {
        next.delete(skillId);
      }
      return next;
    });
  };

  // [事务] 流程固定为「守卫、置在途、预检、导出、导入、通知宿主、完成」，顺序不能换。
  // [契约] 守卫同时检查在途与选择数：空选择给出提示，在途则静默返回。
  // [契约] 错误统一收敛到错误状态并回到选择态，用户可以直接重试。
  // [失败路径] 若把通知宿主放在导入之前，宿主会先刷新列表再收到结果，顺序错乱。
  // [权衡] 函数不做记忆化，它只被按钮引用，闭包读取的是当次渲染的状态。
  const syncSelected = async () => {
    if (
      !shouldStartRemoteSyncOperation({
        inFlight: syncInFlightRef.current,
        selectedCount: selectedSyncIds.length,
      })
    ) {
      if (selectedSyncIds.length === 0) {
        setError(intl.formatMessage({ id: "settings.skills.remoteSync.noSelection" }));
      }
      return;
    }

    syncInFlightRef.current = true;
    setError(null);
    setStep("preflighting");
    try {
      // [契约] 预检带超时包装，超时是独立错误类型，文案与普通失败不同。
      // [契约] 预检失败用路径与错误拼文案，路径来自预检返回值而不是本地猜测。
      // [契约] 预检通过后才切到同步态，保证界面文案与实际阶段一致。
      // [失败路径] 若跳过预检直接导入，权限不足会表现为导入中途失败，难以定位。
      // [权衡] 超时秒数由错误对象携带，文案向上取整到秒，避免出现小数秒。
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remoteSkillSyncService.checkRemoteUserSkillWriteAccess(),
      );
      if (!access.ok) {
        throw new Error(
          intl.formatMessage(
            { id: "settings.remoteSync.preflightFailed" },
            { path: access.path, error: access.error ?? "" },
          ),
        );
      }
      setStep("syncing");
      const archive = await localSkillSyncService.exportSkillsArchive({
        skillIds: selectedSyncIds,
      });
      const result = await remoteSkillSyncService.importSkillsArchive({
        archive: archive.archive,
        overwrite: false,
      });
      // [事务] importSkillsArchive 成功后必须先 await onSynced() 再 setStep("complete")，三步严格串行。
      // [契约] 必须等待宿主刷新完成，否则完成态列表可能仍是旧数据。
      // [契约] 若宿主刷新抛错会进入失败分支，此时远端已写入，提示需要说明结果部分成功。
      // [失败路径] 若先切完成态再刷新，用户会看到结果列表而宿主数据尚未更新。
      // [权衡] onSynced 由宿主决定是否真的请求网络，弹窗按异步 await 处理。
      await onSynced();
      setImportResult(result);
      setStep("complete");
    // [失败路径] 超时错误优先识别，用专门的超时文案说明需要重试。
    // [契约] 其他错误走统一格式化，容量超限会按阶段给出可操作提示。
    // [契约] 失败后回到选择态而不是完成态，保留原来的勾选，用户可直接重试。
    // [失败路径] 若失败时清空选择集，用户需要重新逐个勾选，重试成本陡增。
    // [权衡] 错误信息留在弹窗内展示，不用全局提示，避免与宿主其他提示抢占焦点。
    } catch (syncError) {
      setError(
        isRemoteSyncPreflightTimeoutError(syncError)
          ? intl.formatMessage(
              { id: "settings.remoteSync.preflightTimeout" },
              { seconds: String(Math.ceil(syncError.timeoutMs / 1000)) },
            )
          : formatRemoteSkillSyncError(syncError, intl),
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
          <RemoteSkillSyncTitle />
          <RemoteSkillSyncTargetRow
            targetLabel={targetLabel}
            showExistingRemoteSkills={showExistingRemoteSkills}
            showExistingFilter={step === "selection" && rows.length > 0}
            onShowExistingRemoteSkillsChange={setShowExistingRemoteSkills}
          />
        </DialogHeader>

        {/* 修复原因：筛选会改变可见 rows 数量，DialogContent 固定高度后由列表区内部滚动；
            否则空态按内容收缩会造成弹窗跳动，长列表也会把底部操作栏挤出窗口。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-surface px-3 py-2 text-ui-base text-destructive">
              {error}
            </div>
          ) : null}
          {step === "loading" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.skills.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemoteSkillSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={
                rows.length > 0
                  ? "settings.skills.remoteSync.filteredEmpty"
                  : undefined
              }
              onToggle={toggleSkill}
            />
          ) : null}
          {step === "syncing" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.skills.remoteSync.syncing" })}
            </div>
          ) : null}
          {step === "complete" ? (
            <RemoteSkillSyncResultList result={importResult} />
          ) : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.skills.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleMissingIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemoteSkillSyncBulkSelectionCheckbox
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
              {intl.formatMessage({ id: "settings.skills.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
