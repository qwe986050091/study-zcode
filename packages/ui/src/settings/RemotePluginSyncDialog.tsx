/* eslint-disable max-lines -- 远端 plugin 同步弹窗集中维护加载、选择、风险提示、逐项进度和结果状态，保持与 Skill/MCP 同步弹窗一致。 */
// =============================================================================
// RemotePluginSyncDialog —— 远端插件同步弹窗。
//
// 定位：Settings / 设备卡上的「同步插件到远端」入口。数据方向永远是 本地 → 远端：
// 本文件从不把远端插件写回本地，也不做双向合并，因此不存在"哪一侧覆盖哪一侧"的歧义。
//
// 阶段机：loading（并行拉取本地候选与远端现状）→ selection（勾选）→ preflighting
// （一次性写权限探测）→ syncing（逐项串行 RPC）→ complete（结果列表）。
// 回退只有两条：preflight 失败回 selection；整个 run 抛错回 selection。
//
// 为什么逐项串行而不是并发：每一项都可能触碰远端插件存储锁（install / configure 落
// 同一 user scope），并发会让后到的写覆盖先到的，也会让"停止"退化成"部分取消"；
// 串行还让进度日志天然有序，用户能看到第 N 项此刻在做什么。
//
// 为什么不与 Skill/MCP 同步共用一个 hook：三者的候选来源与冲突判定完全不同（skill 按
// 目录、mcp 按 server 名、plugin 按 pluginId + marketplace），强行抽象只会把差异堆进
// 参数；本文件只与它们共享 RemoteSyncActions 的 preflight / timeout 合同。
//
// 不变量表（编号本文件内唯一；跨文件引用写作 INV-<文件名>#nn）：
// INV-01：step 只能 loading→selection→preflighting→syncing→complete，或回退到
//         selection；完成态不得再回到 syncing（守住：step 的全部 setStep 调用点）。
// INV-02：同步中（preflighting / syncing）拒绝关闭弹窗，唯一判据是
//         shouldAllowRemotePluginSyncDialogOpenChange；关闭按钮的门禁必须与它同源。
//         （守住：handleOpenChange 与 DialogContent.showCloseButton）
// INV-03：同一时刻至多一个 sync run 拥有 syncAbortControllerRef；旧 run 的迟到结果
//         不得写回 UI（守住：finishSyncRun / shouldFinishRemotePluginSyncRun）。
// INV-04：每条 row 的结果恰好进入 results 一次（synced / failed / stopped 三选一），
//         不允许缺失，也不允许重复（守住：syncSelectedRemotePlugins 的两个 for 循环）。
// INV-05：row.exists 的行永远不可选中；选中集合只对"远端不存在"的项生效，因此全选
//         计数、开始按钮、批量勾选框必须都基于 visibleMissingIds（守住：四处派生）。
// INV-06：stop 的语义是"停止继续等待"，不是"保证远端回滚"：已在执行中的远端 RPC
//         仍可能成功，故 stopped 结果的 error 文案必须显式告知这一点（守住：
//         buildStoppedRemotePluginResult）。
// INV-07：operationId 的 `remote-plugin-sync-` 前缀是取消的安全边界：只对本流程生成
//         的 operationId 发 cancelPluginOperation，避免误伤插件页的普通安装/启停。
//         （守住：createRemotePluginSyncOperationId 与 cancelOperation 回调）
// INV-08：每个远端 RPC 之前都要重验停止状态（signal.aborted / stopRequested），停止
//         后不得再发起新的 RPC（守住：awaitRemotePluginSyncStep 首行）。
// INV-09：awaitRemotePluginSyncStep 不得吞掉业务失败：race 里 run 的 reject 必须原样
//         抛给调用方，由调用方决定转成 failed 还是继续（守住：Promise.race 的 promise 分支）。
// INV-10：inline 插件同步固定为「本地导出归档 → 远端导入（overwrite:false）」两步，
//         顺序不可交换；远端导入不允许覆盖，冲突必须暴露给用户而不是静默替换。
// INV-11：marketplace 插件必须先准备 marketplace source 再 install；同一 marketplace
//         在一次 run 内只准备一次（守住：preparedMarketplaceSources 集合）。
// INV-12：marketplace source 的序列化有优先级：github / git / url 走可重放的
//         sourceInput 字符串，只有 file / directory / settings 才回退到归档镜像；
//         顺序反了会把可重放源降级成一次性字节流（守住：buildMarketplaceSourceSyncInfo）。
// INV-13：插件选项只传输"可移植"值：sensitive、file、directory 一律跳过，避免把凭据
//         与本地绝对路径带过网；跳过数量必须回报给用户（守住：isPortablePluginOptionValue）。
// INV-14：选项合并是「远端已有 ⊕ 本地可移植」，不是整体覆盖；合并结果与远端现状相等
//         时不得再发 configure RPC，以保证重试幂等（守住：mergedOptions / arePluginOptionsEqual）。
// INV-15：单项结果表达的是整条流水线（export→import→enable→configure）是否全部成功，
//         而不是 install 是否成功；选项同步失败同样会把该项标为 failed。
// INV-16：results 的顺序与 rows 顺序一致；结果列表以 pluginId + directoryName + status
//         组 key，这是 INV-04 的可视化推论，重复结果会静默合并。
// INV-17：遥测失败绝不影响同步结果：reportResult 整段 try/catch 且 Promise 链上挂空
//         catch，观测是旁路（守住：reportResult）。
// INV-18：组件卸载或远端目标切换必须 abort 当前 run；abort 之后每一个 await 之后都要
//         先判 aborted 再 setState，否则会向已失效的 UI 写入旧目标的结果（守住：
//         useEffect cleanup 与 syncSelected 中的全部 aborted 分支）。
// INV-19：syncProgressById 是只增不改身份的映射：result 一旦写入，后续进度事件不得
//         把它清空（守住：onItemProgress 的合并分支）。
// INV-20：每次打开弹窗都要清空 stop 表（stopRequestedRef / stopWaitersRef），上一轮
//         的 stop 标记不得泄漏到下一轮（守住：open effect 的重置段）。
// INV-21：preflight 必须先于任何远端写操作成功，否则不进入 syncing；preflight 失败
//         属于"拦在门外"，不产生任何 results（守住：syncSelected 的 try 段）。
// INV-22：本文件不解释 RemoteTarget，只透传；目标展示文案由外部格式化函数决定
//         （守住：targetLabel 的唯一来源）。
// INV-23：失败不得中断整批：inline 项与 marketplace 项各自捕获异常并产出单项结果，
//         后续项继续执行（守住：两个 per-row try/catch）。
// =============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckCircle2,
  CircleStop,
  CircleX,
  Loader2,
  Cable,
  UploadCloud,
} from "lucide-react";
import type {
  RendererTelemetryEventPayload,
  PluginSyncCandidate,
  PluginSyncImportResult,
  PluginSyncRemoteStatus,
  RemoteTarget,
  ZCodePluginOptionValue,
  ZCodePluginInfo,
  ZCodePluginMarketplaceSummary,
  ZCodePluginUserConfigOption,
  ZCodePluginsOverviewResult,
} from "@zcode/shared";
import { collectTelemetryRendererContext } from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { IPluginSyncService, IZCodeAgentService } from "@zcode/services";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteSkillSyncTarget } from "@/settings/RemoteSkillSyncDialog.js";
import {
  isRemoteSyncPreflightTimeoutError,
  runRemoteSyncPreflightWithTimeout,
  shouldStartRemoteSyncOperation,
} from "@/settings/RemoteSyncActions.js";

// 阶段机的外部可见类型：UI 之外也用它对 step 做断言，因此必须是导出类型而非内部枚举。
// 刻意不做成数字枚举：字符串在日志、测试与 React DevTools 中可读，且新增阶段不会
// 因为数值错位影响持久化（本类型不进任何落盘结构）。
export type RemotePluginSyncDialogStep =
  | "loading"
  | "selection"
  | "preflighting"
  | "syncing"
  | "complete";
// 内部别名只为让组件内的 useState 读起来更短；不引入第二套语义。
type Step = RemotePluginSyncDialogStep;
// 两类候选共享同一行模型，但同步链路完全不同：
// inline 走"导出归档 → 远端导入"，marketplace 走"准备来源 → install → setEnabled"。
// 用 kind 而不是 optional 字段区分，是为了让两个分支在类型层互斥、避免漏判。
type RemotePluginSyncKind = "inline" | "marketplace";

// 选项快照在候选构造时一次性拍下，之后不再回读本地插件配置：
// 同步期间用户若在插件页改配置，本次 run 仍按点击"开始"那一刻的值执行，
// 保证一次运行内部的输入自洽（也避免每一项读到不同版本的配置）。
interface RemotePluginSyncPluginOptions {
  configuredOptions: Record<string, ZCodePluginOptionValue>;
  userConfig: Record<string, ZCodePluginUserConfigOption>;
}

// 用 Pick 而不是整份 IZCodeAgentService：同步链路只应触碰这 7 个方法。
// 收窄不仅让测试可以传入轻量 stub，也在编译期阻止后续维护者顺手在本文件里调用
// 其它会改变远端状态的接口（例如 uninstall），把"写面"钉死在白名单内。
type RemotePluginSyncAgentService = Pick<
  IZCodeAgentService,
  | "addPluginMarketplace"
  | "cancelPluginOperation"
  | "configurePlugin"
  | "getPluginsOverview"
  | "installPlugin"
  | "listPlugins"
  | "setPluginEnabled"
>;

// 固定写 user scope：插件要"跟着设备走"而不是跟着某个远端项目走。
// 若改成 project scope，切换远端目录后插件会集体消失，且同一插件可能被安装两份
// （user 一份 + project 一份），install 幂等判断（按 pluginId）会直接失效。
const REMOTE_PLUGIN_SYNC_CONFIG_SCOPE = "user" as const;

// 候选是"本地插件"在同步弹窗里的投影，不是远端事实：
//   - id：本地复合主键（inline 前缀 / marketplace 前缀），仅用于本弹窗内的选择与进度映射；
//   - pluginId：真正的业务主键，用于远端冲突判定（同一 pluginId 视为同一插件）；
//   - marketplace：inline 项固定填 "inline"，marketplace 项填来源市场 id；
//   - componentTypes：仅用于展示"该插件含哪些能力"，不参与任何判定；
//   - inlineCandidate / marketplacePlugin：两条链路的原始载荷，分支内必须重判非空。
export interface RemotePluginSyncCandidate {
  id: string;
  kind: RemotePluginSyncKind;
  name: string;
  pluginId: string;
  marketplace: string;
  description?: string;
  version?: string;
  path?: string;
  enabled: boolean;
  componentTypes: string[];
  inlineCandidate?: PluginSyncCandidate;
  pluginOptions?: RemotePluginSyncPluginOptions;
  marketplacePlugin?: {
    marketplaceSourceArchive?: {
      marketplaceId: string;
      source: Record<string, unknown>;
    };
    marketplaceSourceInput?: string;
    pluginName: string;
  };
}

// 远端现状的最小快照。reason 只区分两种冲突来源：
//   samePluginId：远端已装同名插件（按 pluginId 判定，不看目录名）；
//   targetExists：远端目标路径被占用（按目录/安装路径判定）。
// 两者都等价于"不可再选"，但文案不同，所以保留原因而不是压成一个布尔。
interface RemotePluginSyncCandidateStatus {
  candidateId: string;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  // 只有 marketplace 项会填：远端是否已有同一 marketplace 源。
  // 它与 exists 正交——市场在不在，决定要不要先搬来源；插件装没装，决定这一项跳不跳。
  remoteMarketplaceExists?: boolean;
}

// Row 是 UI 的唯一行模型：候选 + 远端现状。所有列表（选择、进度、结果）都从它派生，
// 避免在渲染层再做一次 cross-join。
export interface RemotePluginSyncRow {
  candidate: RemotePluginSyncCandidate;
  exists: boolean;
  path?: string;
  reason?: "samePluginId" | "targetExists";
  remoteMarketplaceExists?: boolean;
}

// 复用服务层的结果状态，只额外补一个 "stopped"：
// 服务层不认识"用户主动停止"，它只会返回 synced / skipped / failed 等，
// 因此停止态是本弹窗独有的第四种终态，必须在类型层显式扩张，
// 否则调用方只能用 failed 表达"用户取消"，监控口径会把主动取消算成故障。
type RemotePluginSyncResultStatus = PluginSyncImportResult["results"][number]["status"] | "stopped";

interface RemotePluginSyncResultItem extends Omit<
  PluginSyncImportResult["results"][number],
  "status"
> {
  status: RemotePluginSyncResultStatus;
}

// 一次 run 的输出：只有结果数组，不含"是否全部成功"的聚合布尔。
// 刻意不给 ok 汇总：部分成功是常态（某项已在远端、某项网络失败），
// 一旦提供 ok，调用方就会用它替代逐项判断，从而丢掉 skipped 与 stopped 的区别。
export interface RemotePluginSyncRunResult {
  results: RemotePluginSyncResultItem[];
}

// 判断题而不是直接比较 ref：这个判断是 INV-03 的唯一实现点，
// 抽成纯函数后可单测，也避免在多处内联 `syncAbortControllerRef.current !== run`
// 出现一处写反就导致旧 run 覆盖新 run 的 UI 状态。
export function shouldFinishRemotePluginSyncRun(
  currentRun: AbortController | null,
  run: AbortController,
): boolean {
  return currentRun === run;
}

// 进度状态 = 两个前置态（queued / syncing）+ 四个终态。
// queued 与 syncing 的区别对用户有意义：queued 表示"还没轮到"，syncing 才显示
// 日志悬浮卡与停止按钮；若合并成一个状态，用户会在排队项上看到"正在同步"，误以为卡住。
type RemotePluginSyncProgressStatus = "queued" | "syncing" | RemotePluginSyncResultStatus;

// 进度事件是唯一 UI 输入：日志文本由生产者拼好（含 operationId、失败原因），
// UI 只做追加与美化，不再二次解释。这样"用户看到的日志"与"排查用的日志"是同一份，
// 避免两套格式化逻辑随时间漂移。
export interface RemotePluginSyncProgressEvent {
  candidateId: string;
  log: string;
  pluginId: string;
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

// 停止控制面：三个能力必须分开，因为它们对应不同的"停止时机"。
//   isStopped：轮询式判定，用在每个 await 之前，防止停止后又发起下一步；
//   waitForStop：让正在 await 的项立刻醒来（否则要等当前 RPC 自然返回才响应停止）；
//   cancelOperation：仅对"可取消的远端操作"发取消，尽力而为，不保证远端已回滚。
// 把三者合成一个 stop() 会让"停止等待"与"取消远端"混为一谈，违背 INV-06。
interface RemotePluginSyncStopControl {
  cancelOperation?: (operationId: string) => Promise<void>;
  isStopped: (candidateId: string) => boolean;
  waitForStop?: (candidateId: string) => Promise<void>;
}

// 进度视图额外要求 logs 是数组：事件是一条一条来的，UI 侧累积成行，
// 这样 HoverCard 可以整体展示，也方便未来做"复制日志"。
interface RemotePluginSyncProgressView {
  logs: string[];
  result?: RemotePluginSyncResultItem;
  status: RemotePluginSyncProgressStatus;
}

// 用专门的错误类型而不是普通 Error 表达"用户停止"，因为在 catch 里必须把停止与
// 真实失败区分开：停止要产出 stopped（不计入故障告警、不显示为红色错误），
// 失败要产出 failed。用 message 字符串匹配会把 i18n 文案变成协议，一改就断。
// 同时把 row 带在错误上，保证停止结果仍能拿到 name / directoryName 等展示字段。
class RemotePluginSyncStoppedError extends Error {
  constructor(readonly row: RemotePluginSyncRow) {
    super(`Stopped sync for ${row.candidate.pluginId}`);
    this.name = "RemotePluginSyncStoppedError";
  }
}

// 单调递增的进程内计数器。刻意不用 crypto 随机数：
// operationId 只需在"本窗口、本会话"内可区分，而可读的序号能在日志里直接看出
// "这是本次打开的第三次操作"，便于用户与支持人员对齐；
// 跨进程唯一性由 pluginId 后缀与远端按 operationId 精确匹配共同保证。
let remotePluginSyncOperationCounter = 0;

// 生成形如 `remote-plugin-sync-3-@scope/pkg` 的 id。
// 安全清洗：pluginId 可能含 `@`、`/`、空格甚至非 ASCII，直接拼进 id 会被远端当作
// 路径/键名解析；这里只保留 [a-z0-9._-]，其余折叠成单个 `-`。
// 注意清洗是有损的：不同 pluginId 可能折叠成同一串——因此前缀计数才是唯一性来源，
// 清洗段只用于人读与日志定位（若反过来只靠清洗段做去重，会发生跨插件误取消）。
function createRemotePluginSyncOperationId(row: RemotePluginSyncRow): string {
  remotePluginSyncOperationCounter += 1;
  const safePluginId = row.candidate.pluginId.replace(/[^a-z0-9._-]+/giu, "-");
  return `remote-plugin-sync-${remotePluginSyncOperationCounter}-${safePluginId}`;
}

// 组件入参把"本地侧"与"远端侧"成对传入，而不是传一个带 kind 的联合：
// 两侧的 service 实例必须来自不同的 Host（本地 Host / 远端 attachment），
// 一旦在内部按 kind 去挑，就可能把本地 service 误当远端用，从而"同步到自己"。
// workspacePath / workspaceIdentity 成对出现，遵循 INV-19（workspaceKey 规则）：
// identity 用于身份隔离，path 用于执行，远端链路不得只按路径匹配。
interface RemotePluginSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localPluginSyncService: IPluginSyncService;
  remotePluginSyncService: IPluginSyncService;
  localZCodeAgentService?: RemotePluginSyncAgentService | null;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
  remoteTarget: RemoteTarget;
  localWorkspacePath?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  onSynced: () => Promise<void> | void;
}

// inline 候选的投影：id 加 `inline:` 前缀，避免与 marketplace 的 `marketplace:` 主键
// 撞车（两侧原始 id 空间独立，同一字符串可能在两边同时出现）。
// 可选字段用条件展开而不是赋 undefined：候选项会被 JSON 化进日志/测试快照，
// 显式的 undefined 键会让快照出现噪声差异，条件展开保证"没有就没有这个键"。
function toInlineRemotePluginSyncCandidate(
  candidate: PluginSyncCandidate,
): RemotePluginSyncCandidate {
  return {
    id: `inline:${candidate.id}`,
    kind: "inline",
    name: candidate.name,
    pluginId: candidate.pluginId,
    marketplace: "inline",
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
    path: candidate.path,
    enabled: candidate.enabled,
    componentTypes: candidate.componentTypes,
    inlineCandidate: candidate,
  };
}

// 远端 inline 状态的匹配键：pluginId 大小写不敏感 + 目录名大小写敏感，用 \u0000 分隔。
// 为什么 pluginId 要 toLowerCase：远端安装目录由 package.json 的 name 决定，
// 不同 Provider 报告的大小写可能不一致（`@Scope/Pkg` vs `@scope/pkg`），
// 不折叠会把"已存在"误判成"可安装"，随后 install 直接失败。
// 为什么目录名不折叠：Windows 本地目录大小写不敏感、远端可能是 Linux；目录名代表
// 真实的磁盘条目，折叠后会让两个真实存在的不同目录共享一个状态。
// \u0000 作分隔符是因为它不可能出现在两个字段里，比 ":" / "/" 更安全（后者是合法插件名片段）。
function createInlineStatusKey(pluginId: string, directoryName: string): string {
  return `${pluginId.toLowerCase()}\u0000${directoryName}`;
}

// 把"本地 inline 候选 + 远端状态"合并成行。
// 这里先把候选转成统一模型、再用 candidateId 关联，是为了让 inline 与 marketplace
// 复用同一个 buildRemotePluginSyncRowsForCandidates；两条链路的差别只留在"怎么查状态"。
// [失败路径] 远端没返回某项状态时不报错，按 exists=false 处理：
// 远端列表可能因权限/瞬时错误缺项，此时让用户仍能勾选并看到后续的真实失败，
// 比在加载阶段整体失败更可恢复。
export function buildRemotePluginSyncRows(
  candidates: readonly PluginSyncCandidate[],
  statuses: readonly PluginSyncRemoteStatus[],
): RemotePluginSyncRow[] {
  const statusByKey = new Map(
    statuses.map((status) => [
      createInlineStatusKey(status.pluginId, status.directoryName),
      status,
    ]),
  );
  return buildRemotePluginSyncRowsForCandidates(
    candidates.map(toInlineRemotePluginSyncCandidate),
    candidates.map((candidate) => {
      const status = statusByKey.get(
        createInlineStatusKey(candidate.pluginId, candidate.directoryName),
      );
      return {
        candidateId: `inline:${candidate.id}`,
        exists: status?.exists ?? false,
        ...(status?.path ? { path: status.path } : {}),
        ...(status?.reason ? { reason: status.reason } : {}),
      };
    }),
  );
}

// 通用合并：以候选为主表（candidates.map），状态为查找表。
// 方向很重要——若反过来以 statuses 为主表，远端存在但本地已删除的插件会出现在
// "可同步"列表里，而它根本没有本地来源，点开始只会得到一串"缺少归档"的失败。
// [事务] remoteMarketplaceExists 用 !== undefined 判断而不是真值判断：
// 远端明确返回 false 与"未查询"在语义上不同，前者要参与"市场是否存在"的决策，
// 用真值判断会把 false 当成"未查询"，导致每次都重复准备 market source。
export function buildRemotePluginSyncRowsForCandidates(
  candidates: readonly RemotePluginSyncCandidate[],
  statuses: readonly RemotePluginSyncCandidateStatus[],
): RemotePluginSyncRow[] {
  const statusById = new Map(statuses.map((status) => [status.candidateId, status]));
  return candidates.map((candidate) => {
    const status = statusById.get(candidate.id);
    return {
      candidate,
      exists: status?.exists ?? false,
      ...(status?.path ? { path: status.path } : {}),
      ...(status?.reason ? { reason: status.reason } : {}),
      ...(status?.remoteMarketplaceExists !== undefined
        ? { remoteMarketplaceExists: status.remoteMarketplaceExists }
        : {}),
    };
  });
}

// 默认全选 exists 为假的项，已存在的项一律不选。
// 这是 INV-05 的起点：存在性只在这里被翻译成选择语义，后续 UI 不再各自判断。
// 为什么不默认全选（含已存在项）再让用户取消：已存在项一旦被选中，唯一结果就是
// skipped，会让"开始"按钮看起来生效了但实际什么都没做，属于伪反馈。
export function resolveDefaultRemotePluginSyncSelection(
  rows: readonly RemotePluginSyncRow[],
): Set<string> {
  return new Set(rows.filter((row) => !row.exists).map((row) => row.candidate.id));
}

// 过滤只影响展示，不影响选择集合本身：隐藏已存在项后，用户此前选中的其它项
// 仍保留在 selectedIds 中；重新显示时状态不丢。若把过滤写回 selectedIds，
// 多次切换"显示已存在"会静默清空用户的选择。
export function filterRemotePluginSyncRows(
  rows: readonly RemotePluginSyncRow[],
  showExistingRemotePlugins: boolean,
): RemotePluginSyncRow[] {
  return showExistingRemotePlugins ? [...rows] : rows.filter((row) => !row.exists);
}

// INV-02 的唯一判据：只在"打开"方向无条件放行，关闭方向被两个进行中的阶段拦截。
// 为什么只拦关闭不拦打开：打开是幂等的（已经开着就保持开着），而关闭会触发
// reset + abort，把正在进行的远端写截断成"无主的 RPC"——其结果没有任何 UI 承接，
// 用户下次打开会看到全新的候选列表，误以为上次同步没发生。
// 为什么 complete 允许关闭：结果已经落定，关闭只是收起视图；此时再拦会变成"关不掉的弹窗"。
export function shouldAllowRemotePluginSyncDialogOpenChange(
  step: RemotePluginSyncDialogStep,
  nextOpen: boolean,
): boolean {
  return nextOpen || (step !== "preflighting" && step !== "syncing");
}

// marketplace 候选 = 本地已安装的 marketplace 插件。
// 为什么以 installedPlugins 为主表、而不是 marketplace 的清单：
// 用户能同步的只能是"自己确实装了的"，市场里未安装的条目没有本地归档可供远端复刻。
// 两张侧表各自解决一个问题：
//   plugins（listPlugins）补 description / version / 安装路径等展示与选项元数据；
//   overview.marketplaces 提供"来源如何重放"（sourceInput 或归档镜像）。
// 找不到对应 marketplace 时会退化成空 source 信息，此时上游会报"source 无法同步"，
// 而不是静默安装一个来源不明的插件。
export function buildMarketplaceRemotePluginSyncCandidates(
  overview: ZCodePluginsOverviewResult,
  plugins: readonly ZCodePluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const marketplaceSourceById = new Map(
    overview.marketplaces.map((marketplace) => [
      marketplace.id,
      buildMarketplaceSourceSyncInfo(marketplace),
    ]),
  );
  return overview.installedPlugins.map((plugin) => {
    const info = pluginInfoById.get(plugin.id);
    const componentTypes = plugin.componentTypes ?? componentTypesFromPluginInfo(info);
    const marketplaceSource = marketplaceSourceById.get(plugin.marketplace);
    const pluginOptions = buildRemotePluginSyncPluginOptions(info);
    return {
      id: `marketplace:${plugin.id}`,
      kind: "marketplace",
      name: plugin.name,
      pluginId: plugin.id,
      marketplace: plugin.marketplace,
      ...((plugin.description ?? info?.description)
        ? { description: plugin.description ?? info?.description }
        : {}),
      ...((plugin.version ?? info?.version) ? { version: plugin.version ?? info?.version } : {}),
      ...((plugin.installPath ?? info?.rootPath)
        ? { path: plugin.installPath ?? info?.rootPath }
        : {}),
      enabled: plugin.enabled,
      componentTypes,
      ...(pluginOptions ? { pluginOptions } : {}),
      marketplacePlugin: {
        ...marketplaceSource,
        pluginName: plugin.name,
      },
    };
  });
}

// 远端冲突判定只看 pluginId：同一插件换 marketplace 重装也被视为"已存在"。
// 这是刻意的保守选择——若按 (marketplace, pluginId) 判定，用户会看到同一插件
// 在两个市场下都能选，实际安装时第二个会覆盖第一个的安装目录，形成"看起来成功、
// 实际只剩一份"的假象。
// remoteMarketplaceExists 只对 marketplace 项有意义，用来决定是否需要先搬市场来源；
// 它不影响 exists（插件是否已装），两者在后续判断中分别使用。
export function buildMarketplaceRemotePluginStatuses(
  candidates: readonly RemotePluginSyncCandidate[],
  remoteOverview: ZCodePluginsOverviewResult,
): RemotePluginSyncCandidateStatus[] {
  const installedById = new Map(
    remoteOverview.installedPlugins.map((plugin) => [plugin.id, plugin]),
  );
  const remoteMarketplaceIds = new Set(
    remoteOverview.marketplaces.map((marketplace) => marketplace.id),
  );
  return candidates.map((candidate) => {
    const installed = installedById.get(candidate.pluginId);
    return {
      candidateId: candidate.id,
      exists: Boolean(installed),
      ...(installed?.installPath ? { path: installed.installPath } : {}),
      ...(installed ? { reason: "samePluginId" as const } : {}),
      remoteMarketplaceExists: remoteMarketplaceIds.has(candidate.marketplace),
    };
  });
}

// componentTypes 是纯展示字段（"这个插件含哪些能力"），缺失时返回空数组而不是 undefined：
// 渲染层直接 map，省掉一次空值分支；也让"信息缺失"和"确实没有组件"在 UI 上一致，
// 因为对用户而言这两种情况没有可区分的动作。
function componentTypesFromPluginInfo(plugin: ZCodePluginInfo | undefined): string[] {
  return plugin?.components?.map((component) => component.kind) ?? [];
}

// 没有配置项时返回 undefined 而不是空对象：undefined 在下游代表"这个插件没有可同步项"，
// 空对象则会被当成"有配置但全被过滤"，两者在进度日志里应显示不同文案。
// 两个 map 都做浅拷贝，切断与插件信息服务返回值的引用共享——同步过程中用户改配置，
// 不能偶发地影响已经开始的那一次 run（隐性数据竞争）。
function buildRemotePluginSyncPluginOptions(
  plugin: ZCodePluginInfo | undefined,
): RemotePluginSyncPluginOptions | undefined {
  const configuredOptions = plugin?.configuredOptions ?? {};
  if (Object.keys(configuredOptions).length === 0) {
    return undefined;
  }
  return {
    configuredOptions: { ...configuredOptions },
    userConfig: { ...(plugin?.userConfig ?? {}) },
  };
}

// 只在确实拿到选项时才生成新对象：没有选项时直接返回原引用，
// 让 React 的 memo 依赖比较可以命中（也避免一次性批处理里产生大量无意义的新对象）。
// 注意这里不覆盖 candidate 上已存在的 pluginOptions——inline 候选来自另一条查询链，
// 若它已经带值，说明服务层已经给过更权威的数据，不该被本地 overview 的空结果抹掉。
function applyPluginInfoToRemoteSyncCandidate(
  candidate: RemotePluginSyncCandidate,
  plugin: ZCodePluginInfo | undefined,
): RemotePluginSyncCandidate {
  const pluginOptions = buildRemotePluginSyncPluginOptions(plugin);
  return pluginOptions ? { ...candidate, pluginOptions } : candidate;
}

// inline 候选在 listLocalUserPluginCandidates 阶段拿不到完整插件信息
// （那条接口只返回目录级候选），所以这里用 listPlugins 的结果按 pluginId 回填选项。
// 回填发生在合并行之前：一旦成行，Row 就被当成不可变快照，后续阶段不再修改它。
function enrichRemotePluginSyncCandidatesWithPluginInfo(
  candidates: readonly RemotePluginSyncCandidate[],
  plugins: readonly ZCodePluginInfo[],
): RemotePluginSyncCandidate[] {
  const pluginInfoById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return candidates.map((candidate) =>
    applyPluginInfoToRemoteSyncCandidate(candidate, pluginInfoById.get(candidate.pluginId)),
  );
}

// 展示用摘要："可自动带过去 N 项 / 需手动填写 M 项"。
// 这里复用与真实同步完全相同的可移植性判定（isPortablePluginOptionValue），
// 且左右两侧都传同一个 option——因为此刻还没有远端 schema 可比。
// 若为展示另写一套更宽松的规则，用户会看到"可同步 5 项"，实际只过去 2 项，
// 属于最坏的误导：数字对不上又无法自查。
// 返回 null（而不是 0/0）表示"这个插件没有配置项"，UI 据此整段不渲染。
function summarizeLocalPluginOptionsForDisplay(
  pluginOptions: RemotePluginSyncPluginOptions | undefined,
): { manualCount: number; syncableCount: number } | null {
  if (!pluginOptions || Object.keys(pluginOptions.configuredOptions).length === 0) {
    return null;
  }
  let syncableCount = 0;
  let manualCount = 0;
  for (const [key, value] of Object.entries(pluginOptions.configuredOptions)) {
    const option = pluginOptions.userConfig[key];
    if (isPortablePluginOptionValue(value, option, option)) {
      syncableCount += 1;
    } else {
      manualCount += 1;
    }
  }
  return { manualCount, syncableCount };
}

// marketplace source 的"可重放字符串"序列化，是 INV-12 的前半段。
// 远端只需要一条能自己在网络上取到同一份市场的 URI，因此：
//   github → `<repo>#<ref>`；git → `<url>#<ref>`；url → 原样。
// ref 只对 github/git 生效：url 类型若带 #fragment，那通常是页面锚点，拼上去会取错内容。
// 任一字段 trim 后为空都视为"不可重放"，返回 undefined 让调用方走归档镜像分支，
// 而不是发出一条残缺 URI 让远端报一个难以理解的 git 错误。
function serializeMarketplaceSourceInput(
  marketplace: ZCodePluginMarketplaceSummary,
): string | undefined {
  const source = marketplace.source;
  const sourceKind = typeof source.source === "string" ? source.source : "";
  const refSuffix =
    typeof source.ref === "string" && source.ref.trim() ? `#${source.ref.trim()}` : "";
  if (sourceKind === "github" && typeof source.repo === "string" && source.repo.trim()) {
    return `${source.repo.trim()}${refSuffix}`;
  }
  if (sourceKind === "git" && typeof source.url === "string" && source.url.trim()) {
    return `${source.url.trim()}${refSuffix}`;
  }
  if (sourceKind === "url" && typeof source.url === "string" && source.url.trim()) {
    return source.url.trim();
  }
  return undefined;
}

// 决定"这个市场怎么搬到远端"，二选一，且必须优先可重放来源：
//   1) 能序列化出 URI → sourceInput，远端自行 clone/fetch（体积小、可增量、版本一致）；
//   2) 本地来源是 file/directory/settings → 打成归档镜像（远端没有对应文件系统）。
// 为什么 file/directory 不能走 sourceInput：那些路径只在本机存在，远端拿到同一字符串
// 会解析成远端自己的路径，运气好是"目录不存在"，运气不好会装上一个同名但内容不同的市场。
// 其余未知类型返回空对象：宁可让上游显式报"source 无法同步"，也不猜。
function buildMarketplaceSourceSyncInfo(
  marketplace: ZCodePluginMarketplaceSummary,
): Pick<
  NonNullable<RemotePluginSyncCandidate["marketplacePlugin"]>,
  "marketplaceSourceArchive" | "marketplaceSourceInput"
> {
  const sourceInput = serializeMarketplaceSourceInput(marketplace);
  if (sourceInput) {
    return { marketplaceSourceInput: sourceInput };
  }
  const sourceKind = typeof marketplace.source.source === "string" ? marketplace.source.source : "";
  if (["file", "directory", "settings"].includes(sourceKind)) {
    return {
      marketplaceSourceArchive: {
        marketplaceId: marketplace.id,
        source: marketplace.source,
      },
    };
  }
  return {};
}

// 加载阶段：先串行拿 inline（本地候选 → 远端状态一一对应），再并发拿三份 overview。
// 这里刻意分两段而不是一把 Promise.all：
//   inline 的远端查询需要本地候选的 pluginId/directoryName 作为入参，天然有依赖；
//   后三份彼此独立，才值得并发。
// marketplace 段整体是可选的：两个 agent service 任一缺失（例如远端 Host 版本较旧、
// 只提供 pluginSyncService）就只返回 inline 结果，让弹窗仍可用；
// 若把这条降级写成抛错，用户在旧远端上会连 inline 同步都做不了。
// [资源] 所有请求都在同一个 abort 语义之外——加载阶段不接收 signal，
// 由调用方通过 `cancelled` 标志丢弃结果；这是因为加载只是读操作，允许自然完成。
async function loadRemotePluginSyncCandidates(params: {
  localPluginSyncService: IPluginSyncService;
  localWorkspacePath: string;
  localZCodeAgentService?: RemotePluginSyncAgentService | null;
  remotePluginSyncService: IPluginSyncService;
  remoteWorkspaceIdentity?: string;
  remoteWorkspacePath: string;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
}): Promise<{
  candidates: RemotePluginSyncCandidate[];
  statuses: RemotePluginSyncCandidateStatus[];
}> {
  const localInlineResult = await params.localPluginSyncService.listLocalUserPluginCandidates();
  const inlineCandidates = localInlineResult.candidates.map(toInlineRemotePluginSyncCandidate);
  const remoteInlineResult = await params.remotePluginSyncService.listRemoteUserPluginStatuses({
    plugins: localInlineResult.candidates.map((candidate) => ({
      pluginId: candidate.pluginId,
      directoryName: candidate.directoryName,
    })),
  });
  const inlineStatuses = buildRemotePluginSyncRows(
    localInlineResult.candidates,
    remoteInlineResult.statuses,
  ).map(
    (row): RemotePluginSyncCandidateStatus => ({
      candidateId: row.candidate.id,
      exists: row.exists,
      ...(row.path ? { path: row.path } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    }),
  );

  if (!params.localZCodeAgentService || !params.remoteZCodeAgentService) {
    return { candidates: inlineCandidates, statuses: inlineStatuses };
  }

  const [localOverview, localPluginsResult, remoteOverview] = await Promise.all([
    params.localZCodeAgentService.getPluginsOverview({
      workspacePath: params.localWorkspacePath,
    }),
    params.localZCodeAgentService.listPlugins({
      workspacePath: params.localWorkspacePath,
    }),
    params.remoteZCodeAgentService.getPluginsOverview({
      workspacePath: params.remoteWorkspacePath,
      ...(params.remoteWorkspaceIdentity
        ? { workspaceIdentity: params.remoteWorkspaceIdentity }
        : {}),
    }),
  ]);
  const marketplaceCandidates = buildMarketplaceRemotePluginSyncCandidates(
    localOverview,
    localPluginsResult.plugins,
  );
  return {
    candidates: [
      ...enrichRemotePluginSyncCandidatesWithPluginInfo(
        inlineCandidates,
        localPluginsResult.plugins,
      ),
      ...marketplaceCandidates,
    ],
    statuses: [
      ...inlineStatuses,
      ...buildMarketplaceRemotePluginStatuses(marketplaceCandidates, remoteOverview),
    ],
  };
}

// instanceof 守卫必须是 type predicate，调用点才能在同一分支里收窄到带 row 的类型，
// 否则 catch 里还要再断言一次类型，Assertion 一旦写错就会在运行时读到 undefined.row。
// 为什么不做 duck typing（检查 name 字段）：错误可能跨 realm（iframe / worker polyfill），
// 但本文件内该错误永远由本模块构造，instanceof 足够且更严格。
function isRemotePluginSyncStoppedError(error: unknown): error is RemotePluginSyncStoppedError {
  return error instanceof RemotePluginSyncStoppedError;
}

// stopped 结果的构造：directoryName 需要按 kind 分别取，因为两条链路对"目录名"的定义不同
// （inline 用本地目录名，marketplace 用 `marketplace/name`）。
// error 文案是 INV-06 的对外承诺：明确告知"已发出的远端 RPC 仍可能完成"，
// 避免用户以为点停止就等于远端状态回滚，从而在远端留下半装插件却不自知。
function buildStoppedRemotePluginResult(row: RemotePluginSyncRow): RemotePluginSyncResultItem {
  return {
    name: row.candidate.name,
    pluginId: row.candidate.pluginId,
    directoryName:
      row.candidate.kind === "inline"
        ? (row.candidate.inlineCandidate?.directoryName ?? row.candidate.name)
        : `${row.candidate.marketplace}/${row.candidate.name}`,
    status: "stopped",
    error:
      "stop requested; stopped waiting for this plugin sync. Any remote RPC that already started may still finish on the remote target.",
  };
}

// 进度发射器：onItemProgress 是可选的（纯函数测试/无 UI 场景不传）。
// 这里不做任何去重或节流——顺序与次数本身就是信息（用户能看到每一步）；
// 去重应由消费方按 (candidateId, status, log) 自行决定，若在这里合并，
// "同一 operationId 的重试"就会被静默吞掉，排查时看不到重试发生过。
function emitRemotePluginSyncProgress(
  params: {
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
  },
  row: RemotePluginSyncRow,
  status: RemotePluginSyncProgressStatus,
  log: string,
  result?: RemotePluginSyncResultItem,
) {
  params.onItemProgress?.({
    candidateId: row.candidate.id,
    log,
    pluginId: row.candidate.pluginId,
    ...(result ? { result } : {}),
    status,
  });
}

// INV-08 的检查点：两个来源都要看。
//   signal：整批中止（关闭弹窗、切换远端目标、新一轮 run 覆盖旧 run）；
//   isStopped：单项停止（用户在进度行点"停止"）。
// 二者不能互相替代：signal 是批级撤销，单个 candidateId 的停止不影响其它项继续；
// 只检查其中一个，就会出现"停止后仍发下一个 RPC"或"关窗后仍在跑"的漏洞。
function throwIfRemotePluginSyncStopped(
  params: {
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
) {
  if (params.signal?.aborted || params.stopControl?.isStopped(row.candidate.id)) {
    throw new RemotePluginSyncStoppedError(row);
  }
}

// 单步执行器：把"一次远端 RPC"包装成可停止、可记录、可取消的单元。
// 关键设计：run 一被调用就立即开始，停止只能"抢在结果之前返回"，不能阻止 RPC 本身。
// 这是远端调用的物理限制（没有通用的中途 abort 协议），也是 INV-06 的由来。
// 竞态顺序：
//   1. 先判停止（throwIf）→ 已停止则本条根本不发 RPC；
//   2. 再分配 operationId 并 emit syncing → 用户立刻看到"正在做什么 + 编号"；
//   3. 同时挂起 stopPromise / abortPromise 与 run 赛跑；
//   4. 中断分支若允许取消，才发 cancelOperation（尽力而为，失败只记日志）。
// 为什么 operationId 在这里生成而不是由调用方传入：id 必须与本次 RPC 一一对应，
// 放在唯一的发起点上，才能保证"取消的一定是正在跑的那一个"。
async function awaitRemotePluginSyncStep<T>(
  params: {
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
  log: string,
  run: (operationId: string) => Promise<T>,
  options: { cancellableRemoteOperation?: boolean } = {},
): Promise<T> {
  throwIfRemotePluginSyncStopped(params, row);
  const operationId = createRemotePluginSyncOperationId(row);
  // 先发 syncing 再 await：进度必须反映"已发出"，而不是"已返回"。
  // 若放到 await 之后，长 RPC 期间该行会一直停在 queued，用户会认为卡死。
  emitRemotePluginSyncProgress(params, row, "syncing", `${log} (${operationId})`);
  const promise = run(operationId);
  // waitForStop 可能同步返回已 resolve 的 Promise（停止已发生），也可能返回一个
  // 永不 resolve 的 Promise（没有停止）——两种情况都在下面的 race 中统一处理。
  const stopPromise = params.stopControl?.waitForStop?.(row.candidate.id);
  let removeAbortListener: (() => void) | undefined;
  const abortPromise = params.signal
    ? new Promise<void>((resolve) => {
        if (params.signal?.aborted) {
          resolve();
          return;
        }
        const handleAbort = () => resolve();
        params.signal?.addEventListener("abort", handleAbort, { once: true });
        removeAbortListener = () => params.signal?.removeEventListener("abort", handleAbort);
      })
    : undefined;
  // 过滤掉未启用的一方（没有 signal 或没有 stopControl），只保留真实存在的中断源。
  // 类型守卫写法是为了在 filter 之后仍保留 Promise<void>[] 的类型，避免使用非空断言。
  const interruptionPromises = [stopPromise, abortPromise].filter(
    (candidate): candidate is Promise<void> => Boolean(candidate),
  );
  // 没有任何中断源时直接 await：少一层 race、少一次微任务，也让调用栈更直观。
  // 这条捷径不影响正确性，abortRef 为空就意味着没有中断源。
  if (interruptionPromises.length === 0) {
    return await promise;
  }
  try {
    // 两个 race 的嵌套不是为了省变量，而是为了区分"谁赢"：
    // 外层 race 决定"结果 vs 中断"，内层 race 只负责"第一个中断信号"。
    // 若只写一层 Promise.race([promise, stopPromise, abortPromise])，
    // 中断分支就无法再执行 cancelOperation（它拿到的是 void，不知道是哪种中断）。
    return await Promise.race([
      promise,
      Promise.race(interruptionPromises).then(async () => {
        // 只有显式标记为 cancellable 的操作才发远端取消：
        // install / marketplace add 支持 operationId 取消，而 list / configure 这类
        // 短事务没有取消协议，发过去只会得到一个"未知 operationId"的错误。
        if (options.cancellableRemoteOperation === true && params.stopControl?.cancelOperation) {
          emitRemotePluginSyncProgress(
            params,
            row,
            "stopped",
            `request cancel plugin sync operation ${operationId}`,
          );
          // 取消请求本身允许失败：远端可能已经把该操作跑完（本地还没来得及停止），
          // 此时返回"找不到 operationId"是正常竞态，不是故障。
          // 因此只记录到进度日志，不向上抛——真正决定 UI 终态的是下面的 StoppedError。
          try {
            await params.stopControl.cancelOperation(operationId);
            emitRemotePluginSyncProgress(
              params,
              row,
              "stopped",
              `cancel request sent for ${operationId}`,
            );
          } catch (error) {
            emitRemotePluginSyncProgress(
              params,
              row,
              "stopped",
              `cancel request failed for ${operationId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        // 无论取消请求成功与否，本步都以 StoppedError 结束：
        // 调用方据此产出 stopped 结果并继续处理下一项（而不是整批失败）。
        throw new RemotePluginSyncStoppedError(row);
      }),
    ]);
  } finally {
    // [资源] 移除 abort 监听，避免长批次里每个 RPC 都往同一个 signal 上挂监听，
    // 造成监听器累积（AbortSignal 的 listener 不会因为 once 触发而清理未触发的那部分）。
    removeAbortListener?.();
  }
}

// file / directory 两类选项承载的是"本机路径"，天生不可移植，单独抽出来是因为
// 判定入口有两处（选项同步与展示摘要），必须共用同一个定义，否则会出现
// "摘要说可同步、实际被跳过"的口径分裂。
function isPathPluginOption(option: ZCodePluginUserConfigOption | undefined): boolean {
  return option?.type === "file" || option?.type === "directory";
}

// INV-13 的核心判定：一个已配置值能否跨机器搬运。四道闸门按顺序：
//   1) 两侧 schema 都要有：任一缺失说明远端不认识这个键，硬写进去会被拒绝或丢弃；
//   2) sensitive 一律跳过：这是凭据/令牌，跨设备复制等于把本机秘密搬到远端并落盘；
//   3) 路径类跳过：远端路径语义不同，复制过去只会得到一个不存在的路径；
//   4) 类型必须匹配远端期望（远端优先，缺失才回退本地），防止 number 变成 string。
// 第 4 条用"远端 expectedType 优先"而不是取交集：远端 schema 才是接收方的真实契约，
// 用本地契约判断会出现"本地认为合法、远端反序列化失败"的脏写。
function isPortablePluginOptionValue(
  value: ZCodePluginOptionValue,
  localOption: ZCodePluginUserConfigOption | undefined,
  remoteOption: ZCodePluginUserConfigOption | undefined,
): boolean {
  if (!localOption || !remoteOption) {
    return false;
  }
  if (localOption.sensitive === true || remoteOption.sensitive === true) {
    return false;
  }
  if (isPathPluginOption(localOption) || isPathPluginOption(remoteOption)) {
    return false;
  }
  const expectedType = remoteOption.type ?? localOption.type;
  if (expectedType === "boolean") return typeof value === "boolean";
  if (expectedType === "number") return typeof value === "number";
  if (expectedType === "string") return typeof value === "string";
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// 把本地配置投影成"本次要写过去的键值 + 被跳过的数量"。
// skippedCount 是面向用户的透明度指标：不告诉用户跳过了什么，用户会以为配置已经全部
// 跟着走了，然后在远端排查一个"看起来没生效"的配置项。
// 这里逐项判定而不是整插件跳过：一个插件通常既有可移植的开关，也有敏感 token，
// 整插件跳过等于让绝大多数插件都无法同步配置。
function buildPortablePluginOptionsSyncPlan(
  localOptions: RemotePluginSyncPluginOptions,
  remotePlugin: ZCodePluginInfo,
): { options: Record<string, ZCodePluginOptionValue>; skippedCount: number } {
  const options: Record<string, ZCodePluginOptionValue> = {};
  let skippedCount = 0;
  for (const [key, value] of Object.entries(localOptions.configuredOptions)) {
    if (
      isPortablePluginOptionValue(
        value,
        localOptions.userConfig[key],
        remotePlugin.userConfig?.[key],
      )
    ) {
      options[key] = value;
    } else {
      skippedCount += 1;
    }
  }
  return { options, skippedCount };
}

// INV-14 的幂等判定：键集合与值全等才算相等。
// 先比 length 再逐键比，是为了避免 Object.keys(right) 在每次迭代里重算（小优化），
// 更重要的是它天然覆盖"右侧多了一个键"的情况——只做 every 会把右侧多余键忽略，
// 从而把"远端有额外配置"误判为已同步，跳过本该发生的合并。
// 用 === 而不是深比较：插件选项值的类型被约束为字符串/数字/布尔，不存在嵌套结构；
// 若未来引入对象型选项，这里必须改成结构化比较，否则永远判定为不相等（无限重发）。
function arePluginOptionsEqual(
  left: Record<string, ZCodePluginOptionValue>,
  right: Record<string, ZCodePluginOptionValue>,
): boolean {
  const leftEntries = Object.entries(left);
  if (leftEntries.length !== Object.keys(right).length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

// 插件选项同步：主安装流程之后的"附加一步"，但失败会影响该项最终状态（INV-15）。
// 顺序固定为 list → plan → configure：
//   必须先 list，因为可移植性判定要求远端 schema（远端可能多/少字段、改过类型）；
//   先算 plan 再决定是否 configure，才能在"无需变更"时完全跳过写操作。
// 每个提前 return 都配一条进度日志——静默跳过是最难排查的行为，
// 用户只看到"同步成功"却不知道配置没过去。
async function syncPortablePluginOptions(
  params: {
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    remoteWorkspaceIdentity?: string;
    remoteWorkspacePath: string;
    remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
): Promise<void> {
  // 没有本地配置就没有可同步项：直接返回，不产生任何 RPC，也不改变主结果。
  const localOptions = row.candidate.pluginOptions;
  if (!localOptions || Object.keys(localOptions.configuredOptions).length === 0) {
    return;
  }
  const remoteZCodeAgentService = params.remoteZCodeAgentService;
  // 远端没有 agent service（旧 Host / 只读 attachment）时降级为"跳过配置"，
  // 而不是让整项失败：插件本体已经装上了，配置缺失属于可用性降级。
  if (!remoteZCodeAgentService) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      "skip plugin options: remote plugin service is not available",
    );
    return;
  }
  // workspace 每次都重建：identity 可选，path 必填。
  // 条件展开而不是写 undefined，保证请求载荷里不会出现 identity: undefined 这种
  // 会被远端严格校验拒绝的字段。
  const workspace = {
    workspacePath: params.remoteWorkspacePath,
    ...(params.remoteWorkspaceIdentity
      ? { workspaceIdentity: params.remoteWorkspaceIdentity }
      : {}),
  };
  const remotePlugins = await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/list for options ${row.candidate.pluginId}`,
    () => remoteZCodeAgentService.listPlugins(workspace),
  );
  // 必须重新 list：远端安装完成后的 schema 可能与本地不同（版本差异、平台差异）。
  // 找不到同名插件时跳过配置——这意味着安装结果与预期不一致，但主流程已经成功，
  // 把它升级成失败会把"插件可用"误报成"同步失败"，代价更大。
  const remotePlugin = remotePlugins.plugins.find((plugin) => plugin.id === row.candidate.pluginId);
  if (!remotePlugin) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `skip plugin options: remote plugin schema not found for ${row.candidate.pluginId}`,
    );
    return;
  }
  const plan = buildPortablePluginOptionsSyncPlan(localOptions, remotePlugin);
  if (plan.skippedCount > 0) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `skipped ${plan.skippedCount} non-portable plugin option(s)`,
    );
  }
  // 全部选项都被判定为不可移植时提前结束：没有可写内容，configure 只会产生
  // 一次无意义的远端写与一条噪声日志。
  const portableCount = Object.keys(plan.options).length;
  if (portableCount === 0) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      "skip plugin options: no portable configured option values",
    );
    return;
  }
  // 合并方向（INV-14）：远端已有值在前、本地可移植值在后，即"增量覆盖"。
  // 为什么不能反过来只发 plan.options：configure 的语义通常是"整体替换"，
  // 只发可移植子集会把远端独有的配置（例如远端平台专属项）整体清空。
  const mergedOptions = {
    ...(remotePlugin.configuredOptions ?? {}),
    ...plan.options,
  };
  // 幂等短路：合并结果与远端现状一模一样时不再发 RPC。
  // 这让"重复点击开始 / 重试整批"不会产生额外的远端写，也让进度日志里出现
  // 明确的 "already synced"，用户能确认上次确实生效了。
  if (arePluginOptionsEqual(remotePlugin.configuredOptions ?? {}, mergedOptions)) {
    emitRemotePluginSyncProgress(
      params,
      row,
      "syncing",
      `plugin options already synced (${portableCount} portable option(s))`,
    );
    return;
  }
  await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/configure ${portableCount} portable option(s) for ${row.candidate.pluginId}`,
    () =>
      remoteZCodeAgentService.configurePlugin({
        ...workspace,
        options: mergedOptions,
        pluginId: row.candidate.pluginId,
        scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
      }),
  );
}

// 批量同步主循环：两趟独立循环（inline 全部 → marketplace 全部），不是按 rows 原序混跑。
// 为什么分两趟：inline 的 export/import 不依赖远端 marketplace 源，先跑完能让用户在
// 进度列表里先看到"本地目录插件"全部落定；marketplace 项之间还共享 preparedMarketplaceSources，
// 集中处理可以保证同一市场的准备动作相邻，不会被他类项打断。
// 代价：最终 results 的顺序与 rows 顺序不一致（inline 在前）。这被 UI 接受，因为
// 结果列表本身按"项"展示，不承诺与选择列表同序。
// 每一趟都逐项 try/catch（INV-23）：单点失败不影响后续项，用户可只重试失败项。
export async function syncSelectedRemotePlugins(params: {
  localPluginSyncService: IPluginSyncService;
  reportTelemetryEvent?: (event: RendererTelemetryEventPayload) => void | Promise<void>;
  onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
  remotePluginSyncService: IPluginSyncService;
  remoteWorkspaceIdentity?: string;
  remoteWorkspacePath: string;
  remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
  rows: readonly RemotePluginSyncRow[];
  signal?: AbortSignal;
  stopControl?: RemotePluginSyncStopControl;
}): Promise<RemotePluginSyncRunResult> {
  const results: RemotePluginSyncRunResult["results"] = [];
  // 每项从实际执行起计时；只记录目标端最终结果，不上传归档、配置或路径。
  const reportResult = (
    row: RemotePluginSyncRow,
    item: RemotePluginSyncResultItem,
    startedAt: number,
  ) => {
    if (!params.reportTelemetryEvent) return;
    try {
      void Promise.resolve(
        params.reportTelemetryEvent({
          elementName: "plugin_lifecycle",
          eventRegion: "app",
          eventType: "result",
          context: collectTelemetryRendererContext(),
          eventExtraDetail: {
            schema_version: "1",
            action: "sync",
            trigger: "sync",
            scope: "user",
            plugin_id: row.candidate.pluginId,
            marketplace: row.candidate.marketplace,
            workspace_kind: "remote",
            result:
              item.status === "synced"
                ? "success"
                : item.status === "skipped"
                  ? "noop"
                  : item.status === "stopped"
                    ? "cancelled"
                    : "failure",
            duration_ms: String(Math.max(0, Date.now() - startedAt)),
          },
        }),
      ).catch(() => {});
    } catch {
      /* 观测失败不影响远端同步结果。 */
    }
  };
  // 先整体广播 queued，再开始执行：
  // 这样"同步"页一出现就包含所有被选中行的初始状态，用户能看到总项数与排队顺序，
  // 而不是随着执行一条条冒出来（后者会让用户误以为漏选了）。
  for (const row of params.rows) {
    emitRemotePluginSyncProgress(params, row, "queued", "Queued plugin sync");
  }

  // 第一趟：inline。`continue` 而不是 filter，是为了保留 rows 原序作为执行顺序。
  for (const row of params.rows) {
    if (row.candidate.kind !== "inline") {
      continue;
    }
    // startedAt 放在"真正开始执行"处而不是批开始处，否则 duration_ms 会把排队时间
    // 算进去，长批次里第 N 项的性能指标会失真。
    const startedAt = Date.now();
    try {
      // 逐项再查一次 stopRequested，上一项耗时长时用户可能刚点过停止。
      throwIfRemotePluginSyncStopped(params, row);
      // 类型上 inlineCandidate 是可选的，运行时必须再判：
      // 这一行可能是外部构造的（测试/其它入口），缺载荷时给出明确错误，
      // 而不是让下面的 `inlineCandidate.id` 抛 TypeError（错误信息对用户无意义）。
      const inlineCandidate = row.candidate.inlineCandidate;
      if (!inlineCandidate) {
        throw new Error("inline plugin metadata is not available");
      }
      // 第 1 步：本地打包。这一步不联网，但同样走 awaitRemotePluginSyncStep，
      // 因为它可能是耗时 IO（读盘 + 压缩），停止语义应当一致。
      // 只传单个 id：一个候选对应一个目录，批量打包会让失败归因变模糊。
      const exported = await awaitRemotePluginSyncStep(
        params,
        row,
        `export inline plugin ${row.candidate.pluginId}`,
        () =>
          params.localPluginSyncService.exportPluginsArchive({
            pluginIds: [inlineCandidate.id],
          }),
      );
      // 第 2 步：远端导入。overwrite:false 是 INV-10 的硬约束——
      // 覆盖会静默替换远端已有插件（可能是用户手改的版本），必须让冲突暴露为失败。
      const result = await awaitRemotePluginSyncStep(
        params,
        row,
        `import inline plugin ${row.candidate.pluginId} on remote`,
        () =>
          params.remotePluginSyncService.importPluginsArchive({
            archive: exported.archive,
            overwrite: false,
          }),
      );
      // 一次导入只应产生一条结果。取 [0] 并显式判空：
      // 空数组意味着远端回包结构异常，继续读 item.status 会抛 TypeError。
      const item = result.results[0];
      if (!item) {
        throw new Error(`remote import did not return ${row.candidate.pluginId}`);
      }
      // 只有真正 synced 才继续配置：skipped（远端已存在）与 failed 都不应再发写操作，
      // 否则会出现"结果说跳过、远端却被改了配置"的不一致。
      // 这里的 await 在 try 内，选项同步失败会把整项降级为 failed（INV-15）。
      if (item.status === "synced") {
        await syncPortablePluginOptions(params, row);
      }
      results.push(item);
      reportResult(row, item, startedAt);
      emitRemotePluginSyncProgress(params, row, item.status, `inline plugin ${item.status}`, item);
    } catch (error) {
      // 停止与失败走同一个出口，但结果状态不同（stopped vs failed）：
      // 前者是用户意图，后者是执行异常，二者在结果列表里颜色与文案都不同。
      // directoryName 用可选链回退到 name：即使候选载荷不完整，也要给出可读的行标识，
      // 否则结果会出现一条 name 为空、无法定位的失败项。
      const item = isRemotePluginSyncStoppedError(error)
        ? buildStoppedRemotePluginResult(row)
        : {
            name: row.candidate.name,
            pluginId: row.candidate.pluginId,
            directoryName: row.candidate.inlineCandidate?.directoryName ?? row.candidate.name,
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          };
      // 即使在 catch 里也必须入 results：INV-04 要求每条被选中的 row 恰好一条结果，
      // 漏加会让结果列表少一项，用户会以为该项"根本没执行"。
      results.push(item);
      reportResult(row, item, startedAt);
      emitRemotePluginSyncProgress(params, row, item.status, item.error ?? item.status, item);
    }
  }

  // 第二趟：marketplace。
  // 先把"每个市场下本次选中的插件名"整体算出来：准备 market source 时需要一个市场的
  // 全部选中插件名（导出归档要按名单裁剪），但执行是逐项的，所以必须预先聚合。
  // preparedMarketplaceSources 是本次 run 的去重集合（INV-11），作用域必须限定在
  // 一次 run 内——跨 run 复用会让"第二次同步时市场已变更"被误判为已准备。
  const selectedMarketplacePluginNames = buildSelectedMarketplacePluginNames(params.rows);
  const preparedMarketplaceSources = new Set<string>();
  for (const row of params.rows) {
    if (row.candidate.kind !== "marketplace") {
      continue;
    }
    const startedAt = Date.now();
    const item = await syncMarketplaceRemotePlugin(
      {
        ...params,
        preparedMarketplaceSources,
        selectedMarketplacePluginNames,
      },
      row,
    );
    results.push(item);
    reportResult(row, item, startedAt);
  }
  // 不抛错、不短路：返回值永远是"逐项结果"，调用方用 step 与结果列表表达成功与失败。
  // 这是为了让部分成功可被完整呈现（若在这里 throw，已经成功的项会从 UI 消失）。
  return { results };
}

// marketplace 单链路：准备市场来源 → install → setEnabled → 同步选项。
// 四步的顺序是强约束：
//   1) 来源未就绪时 install 会因"marketplace not found"失败；
//   2) setEnabled 必须在 install 之后（插件先存在才谈启停）；
//   3) 选项同步在最后，因为它依赖远端已有插件 schema。
// 任何一步抛错都由本函数内 catch 转成单项 failed，不向外传播（INV-23）。
async function syncMarketplaceRemotePlugin(
  params: {
    localPluginSyncService: IPluginSyncService;
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    preparedMarketplaceSources: Set<string>;
    remotePluginSyncService: IPluginSyncService;
    remoteWorkspaceIdentity?: string;
    remoteWorkspacePath: string;
    remoteZCodeAgentService?: RemotePluginSyncAgentService | null;
    selectedMarketplacePluginNames: ReadonlyMap<string, string[]>;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
): Promise<RemotePluginSyncResultItem> {
  const candidate = row.candidate;
  const marketplacePlugin = candidate.marketplacePlugin;
  const directoryName = `${candidate.marketplace}/${candidate.name}`;
  try {
    throwIfRemotePluginSyncStopped(params, row);
    if (!params.remoteZCodeAgentService || !marketplacePlugin) {
      throw new Error("remote plugin install service is not available");
    }
    const remoteZCodeAgentService = params.remoteZCodeAgentService;
    const workspace = {
      workspacePath: params.remoteWorkspacePath,
      ...(params.remoteWorkspaceIdentity
        ? { workspaceIdentity: params.remoteWorkspaceIdentity }
        : {}),
    };
    if (
      !row.remoteMarketplaceExists &&
      !params.preparedMarketplaceSources.has(candidate.marketplace)
    ) {
      await prepareRemoteMarketplaceSource(
        {
          localPluginSyncService: params.localPluginSyncService,
          onItemProgress: params.onItemProgress,
          remotePluginSyncService: params.remotePluginSyncService,
          remoteZCodeAgentService,
          selectedMarketplacePluginNames: params.selectedMarketplacePluginNames,
          signal: params.signal,
          stopControl: params.stopControl,
        },
        row,
        workspace,
      );
      params.preparedMarketplaceSources.add(candidate.marketplace);
    }
    // install 是本链路里唯一"可取消"的远端操作：它会下载/解包，可能持续数秒，
    // 因此把 operationId 透传给远端并允许 cancel（INV-07 的安全边界）。
    // 注意 operationId 由 awaitRemotePluginSyncStep 现场生成，而不是复用 candidate.id：
    // 同一 pluginId 的重试两次不该经 abortController 互相取消。
    const installResult = await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/install ${candidate.pluginId}`,
      (operationId) =>
        remoteZCodeAgentService.installPlugin({
          ...workspace,
          marketplace: candidate.marketplace,
          operationId,
          pluginName: marketplacePlugin.pluginName,
          scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
        }),
      { cancellableRemoteOperation: true },
    );
    // 安装结果要先看 diagnostics 再看 installedPlugins：
    // 远端可能"安装成功但带 error 级诊断"（例如某个组件不支持该平台），
    // 此时把插件标成 synced 会掩盖问题。warning 级诊断被 formatInstallError 忽略，
    // 因为 warning 通常是"可选组件跳过"，不影响可用性。
    const installError = formatInstallError(installResult, candidate.pluginId);
    if (installError) {
      throw new Error(installError);
    }
    const installedPlugin = installResult.installedPlugins.find(
      (plugin) => plugin.id === candidate.pluginId,
    );
    // 没有回传安装记录说明远端内部状态与响应不一致：宁可报失败，也不要把一个
    // 不确定是否存在的插件继续 setEnabled（那会产生二次错误，掩盖真正的根因）。
    if (!installedPlugin) {
      throw new Error(`remote install did not return ${candidate.pluginId}`);
    }
    // 启停状态按本地意图同步到远端。单独一步而不是塞进 install 参数：
    // 远端 install 不保证接受 enabled 字段，拆开后失败可以精确定位到"启用"这一步。
    // 日志里显式带 enabled=true/false，便于用户判断是"装上了但没启用"还是"没装上"。
    await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/setEnabled enabled=${String(candidate.enabled)} for ${candidate.pluginId}`,
      () =>
        remoteZCodeAgentService.setPluginEnabled({
          ...workspace,
          enabled: candidate.enabled,
          pluginId: candidate.pluginId,
          scope: REMOTE_PLUGIN_SYNC_CONFIG_SCOPE,
        }),
    );
    await syncPortablePluginOptions(params, row);
    const result = {
      name: candidate.name,
      pluginId: candidate.pluginId,
      directoryName,
      status: "synced",
      ...(installedPlugin.installPath ? { path: installedPlugin.installPath } : {}),
    } satisfies RemotePluginSyncResultItem;
    emitRemotePluginSyncProgress(params, row, "synced", "marketplace plugin synced", result);
    return result;
  } catch (error) {
    // 与 inline 分支同构：停止/失败都转成单项结果返回而不是抛出。
    // 这里不改写已产出的 progress：结果事件本身携带 result，
    // UI 会用最后一条事件的 result 覆盖展示（INV-19 保证不回退）。
    const result = isRemotePluginSyncStoppedError(error)
      ? buildStoppedRemotePluginResult(row)
      : {
          name: candidate.name,
          pluginId: candidate.pluginId,
          directoryName,
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        };
    emitRemotePluginSyncProgress(params, row, result.status, result.error ?? result.status, result);
    return result;
  }
}

// 按 marketplace 聚合"本次要同步的插件名"。
// 用途：当本地市场来源是 file/directory 时，导出归档需要知道"只带哪些插件"，
// 否则会把整个市场（可能上百个插件）打成归档，既慢又可能把未选中的插件泄到远端。
// 同一市场下的插件必须一次性带走：远端市场一旦绑定，成员清单是其完整性的一部分，
// 分批导入会导致"市场存在但插件不全"的中间态。
function buildSelectedMarketplacePluginNames(
  rows: readonly RemotePluginSyncRow[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const marketplacePlugin = row.candidate.marketplacePlugin;
    if (row.candidate.kind !== "marketplace" || !marketplacePlugin) {
      continue;
    }
    const names = result.get(row.candidate.marketplace) ?? [];
    names.push(marketplacePlugin.pluginName);
    result.set(row.candidate.marketplace, names);
  }
  return result;
}

async function prepareRemoteMarketplaceSource(
  params: {
    localPluginSyncService: IPluginSyncService;
    onItemProgress?: (event: RemotePluginSyncProgressEvent) => void;
    remotePluginSyncService: IPluginSyncService;
    remoteZCodeAgentService: RemotePluginSyncAgentService;
    selectedMarketplacePluginNames: ReadonlyMap<string, string[]>;
    signal?: AbortSignal;
    stopControl?: RemotePluginSyncStopControl;
  },
  row: RemotePluginSyncRow,
  workspace: { workspaceIdentity?: string; workspacePath: string },
): Promise<void> {
  const candidate = row.candidate;
  const marketplacePlugin = candidate.marketplacePlugin;
  if (!marketplacePlugin) {
    throw new Error("marketplace plugin metadata is not available");
  }
  // 分支一（优先）：可重放来源。远端自己 clone/fetch，天然保持一致。
  // 这条路径不传插件名单——市场源拉下来就是完整市场，裁剪反而会破坏其索引。
  const marketplaceSourceInput = marketplacePlugin.marketplaceSourceInput;
  if (marketplaceSourceInput) {
    await awaitRemotePluginSyncStep(
      params,
      row,
      `RPC plugins/marketplace/add ${candidate.marketplace} from ${marketplaceSourceInput}`,
      (operationId) =>
        params.remoteZCodeAgentService.addPluginMarketplace({
          ...workspace,
          operationId,
          source: marketplaceSourceInput,
        }),
      { cancellableRemoteOperation: true },
    );
    return;
  }
  // 分支二：归档镜像。这是"最后手段"，只用于 file/directory/settings 这类
  // 远端无法自行解析的本地来源。
  // 两者都没有时明确失败：绝不发一条空 source 的 add 请求——那会让远端创建一个
  // 指向空目录的市场，后续所有 install 都会以更难理解的方式失败。
  const marketplaceSourceArchive = marketplacePlugin.marketplaceSourceArchive;
  if (!marketplaceSourceArchive) {
    throw new Error(`marketplace source cannot be synchronized: ${candidate.marketplace}`);
  }
  // 导出时带上本次选中的插件名单（见 buildSelectedMarketplacePluginNames）。
  // 回退值 [marketplacePlugin.pluginName] 是防御性的：正常情况下 Map 里必然有该市场，
  // 只有调用方绕过聚合直接构造 params 时才会走到这里。
  const exported = await awaitRemotePluginSyncStep(
    params,
    row,
    `export marketplace source ${candidate.marketplace}`,
    () =>
      params.localPluginSyncService.exportMarketplaceSourceArchive({
        marketplaceId: marketplaceSourceArchive.marketplaceId,
        pluginNames: params.selectedMarketplacePluginNames.get(candidate.marketplace) ?? [
          marketplacePlugin.pluginName,
        ],
        source: marketplaceSourceArchive.source,
      }),
  );
  // 导入同样 overwrite:false：远端可能已有同名市场（可能来自用户自己添加），
  // 静默覆盖会替换掉远端用户的配置。
  // [事务] 导入后必须用 imported.path（远端镜像落盘路径）作为 add 的 source，
  // 而不是原 archive 的本地路径——后者只在本地有效，发过去远端会解析成自己的路径。
  const imported = await awaitRemotePluginSyncStep(
    params,
    row,
    `import marketplace source ${candidate.marketplace} on remote`,
    () =>
      params.remotePluginSyncService.importMarketplaceSourceArchive({
        archive: exported.archive,
        overwrite: false,
      }),
  );
  // 最后把镜像登记为远端市场。这一步失败时，镜像文件已落在远端但不被任何市场引用，
  // 属于"孤儿文件"；不做自动清理是刻意取舍：清理可能误删用户已引用的同名目录。
  await awaitRemotePluginSyncStep(
    params,
    row,
    `RPC plugins/marketplace/add mirrored ${candidate.marketplace} from ${imported.path}`,
    (operationId) =>
      params.remoteZCodeAgentService.addPluginMarketplace({
        ...workspace,
        operationId,
        source: imported.path,
      }),
    { cancellableRemoteOperation: true },
  );
}

// 把安装诊断压成一句可读的错误；只取非 warning 项。
// 为什么 warning 不算失败：远端常见的 warning 是"某可选组件在当前平台不可用"，
// 插件主体仍然装好了；把它当失败会让一大批本来可用的插件永远无法同步。
// diagnostics 可能指向同批安装的其它插件（pluginId 字段），所以优先用诊断自带的
// pluginId 而不是入参，避免错误信息张冠李戴。
function formatInstallError(
  result: Awaited<ReturnType<RemotePluginSyncAgentService["installPlugin"]>>,
  pluginId: string,
): string | null {
  const diagnostics = result.diagnostics.filter((diagnostic) => diagnostic.severity !== "warning");
  if (diagnostics.length === 0) {
    return null;
  }
  return diagnostics
    .map((diagnostic) => {
      const target = diagnostic.pluginId ?? pluginId;
      return `${target}: ${diagnostic.message}`;
    })
    .join("; ");
}

// 标题里的警告气泡单独抽成组件：hover 状态只影响这一小块，
// 放在主组件里会让整个弹窗在鼠标进出时重渲染（主组件的 state 很大，重渲染成本高）。
// 用 click/hover 之外的显式 open 状态而不是 Tooltip 默认行为，是为了让触屏也能点开。
function RemotePluginSyncTitle() {
  const { intl } = useZCodeIntl();
  const [warningTooltipOpen, setWarningTooltipOpen] = useState(false);
  const warningTitle = intl.formatMessage({
    id: "settings.plugins.remoteSync.warningTitle",
  });

  return (
    <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.title" })}
      </span>
      <ControlHintTooltip
        open={warningTooltipOpen}
        title={warningTitle}
        description={intl.formatMessage({
          id: "settings.plugins.remoteSync.warningDescription",
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

// "显示远端已存在的插件"开关。默认开着（showExistingRemotePlugins 初值 true）：
// 用户需要先看到冲突项才能理解为什么某些项不可选；默认隐藏会造成"我的插件怎么不在列表里"。
function RemotePluginSyncExistingFilterCheckbox({
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
      <span>{intl.formatMessage({ id: "settings.plugins.remoteSync.showExisting" })}</span>
    </label>
  );
}

// RemotePluginSyncTargetRow 把 targetLabel 与过滤开关合成一行。
// showExistingFilter 只在 selection 阶段且确实有行时打开：其它阶段切换过滤没有对象，
// 显示一个无效开关会让用户误操作。targetLabel 由外部格式化，组件不自行拼接目标名。
function RemotePluginSyncTargetRow({
  targetLabel,
  showExistingRemotePlugins,
  showExistingFilter,
  onShowExistingRemotePluginsChange,
}: {
  targetLabel: string;
  showExistingRemotePlugins: boolean;
  showExistingFilter: boolean;
  onShowExistingRemotePluginsChange: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 break-words font-mono text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.target" }, { target: targetLabel })}
      </p>
      {showExistingFilter ? (
        <div className="shrink-0">
          <RemotePluginSyncExistingFilterCheckbox
            checked={showExistingRemotePlugins}
            onCheckedChange={onShowExistingRemotePluginsChange}
          />
        </div>
      ) : null}
    </div>
  );
}

// RemotePluginSyncSelectAll 的三态复选框驱动 checked 与 indeterminate。
// checked / indeterminate 都由"已选数 vs 可选项数"派生，组件内部不存选择状态，
// 保证与父组件的 selectedIds 永远同步（否则快速连点会出现两个真相）。
// 两个回调都接收的是"当前可见且不存在"的集合（由父组件闭包提供），
// 因此"隐藏已存在项后全选"只会选中可见项，符合 INV-05。
// DOM 的 indeterminate 只能通过属性赋值设置，不能写成 JSX 属性，
// 所以用 ref + effect 同步——这是这一块唯一的命令式代码。
function RemotePluginSyncBulkSelectionCheckbox({
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
  const indeterminate = totalSelectable > 0 && selectedCount > 0 && selectedCount < totalSelectable;

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
      <span>{intl.formatMessage({ id: "settings.plugins.remoteSync.selectAll" })}</span>
    </label>
  );
}

// 选择列表。三条渲染规则在这里集中实现，避免各处重复判断：
//   1) row.exists 的行 disabled 且不展示勾选状态（INV-05 的 UI 落地）；
//   2) key 用 candidate.id（复合主键），不用 pluginId——inline 与 marketplace 可能同 id；
//   3) 选项摘要来自 summarizeLocalPluginOptionsForDisplay，与真实同步共用判定。
// checkbox 的 aria-labelledby 指向名称文本而不是整行：整行包含版本、来源、路径，
// 读屏会读出一大串与选择无关的信息。
function RemotePluginSyncSelectionList({
  rows,
  selectedIds,
  emptyMessageId = "settings.plugins.remoteSync.empty",
  onToggle,
}: {
  rows: readonly RemotePluginSyncRow[];
  selectedIds: ReadonlySet<string>;
  emptyMessageId?: string;
  onToggle: (pluginId: string, checked: boolean) => void;
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
        const checkboxId = `remote-plugin-sync-${row.candidate.id}`;
        const labelId = `${checkboxId}-label`;
        const selected = !row.exists && selectedIds.has(row.candidate.id);
        const optionSummary = summarizeLocalPluginOptionsForDisplay(row.candidate.pluginOptions);
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
              onChange={(event) => onToggle(row.candidate.id, event.currentTarget.checked)}
            />
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Cable className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span id={labelId} className="font-medium text-foreground">
                  {row.candidate.name}
                </span>
                {row.candidate.version ? (
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                    {row.candidate.version}
                  </span>
                ) : null}
                {row.candidate.componentTypes.map((type) => (
                  <span
                    key={type}
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle"
                  >
                    {type}
                  </span>
                ))}
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.kind === "inline" ? "inline" : row.candidate.marketplace}
                </span>
                {row.exists ? (
                  <span className="text-ui-base text-foreground-subtlest">
                    {intl.formatMessage({ id: "settings.plugins.remoteSync.existing" })}
                  </span>
                ) : null}
              </span>
              {row.candidate.description ? (
                <span className="mt-1 block text-ui-base text-foreground-subtle">
                  {row.candidate.description}
                </span>
              ) : null}
              {row.candidate.path ? (
                <span className="mt-1 block break-all font-mono text-ui-base text-foreground-subtlest">
                  {row.candidate.path}
                </span>
              ) : null}
              {optionSummary ? (
                <span className="mt-1 block text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.remoteSync.optionsSummary" },
                    {
                      manual: String(optionSummary.manualCount),
                      syncable: String(optionSummary.syncableCount),
                    },
                  )}
                </span>
              ) : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}

// 状态徽标：文案 key 由状态名直接拼出（settings.plugins.remoteSync.<status>）。
// 这种"约定式 i18n"要求新增状态时必须同步新增文案，否则会显示原始 key；
// 换来的是无需维护一张映射表，状态集合在类型层已经受 RemotePluginSyncProgressStatus 约束。
// stopped 用 warning 色而非 destructive：用户主动停止不是错误（INV-06 的视觉表达）。
function RemotePluginSyncStatusBadge({ status }: { status: RemotePluginSyncProgressStatus }) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: `settings.plugins.remoteSync.${status}` });
  const icon =
    status === "synced" ? (
      <CheckCircle2 className="size-3" aria-hidden="true" />
    ) : status === "failed" ? (
      <CircleX className="size-3" aria-hidden="true" />
    ) : status === "stopped" ? (
      <CircleStop className="size-3" aria-hidden="true" />
    ) : null;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-ui-xs font-medium",
        status === "synced" && "border-success/30 bg-success/10 text-success dark:bg-success/14",
        status === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
        status === "stopped" && "border-warning/30 bg-warning/10 text-warning",
        status === "skipped" && "border-border bg-secondary text-foreground-subtle",
        (status === "queued" || status === "syncing") &&
          "border-border bg-secondary text-foreground-subtle",
      )}
    >
      {icon}
      {label}
    </span>
  );
}

// 同步中的日志悬浮卡。<pre> + join("\n") 而不是逐行 <div>：
// 日志里可能带缩进/多行错误栈，保留空白才有排查价值。
// 空日志回退到一句 Queued，避免卡片弹出一个完全空白的框（会让用户以为组件坏了）。
function RemotePluginSyncLogHoverCard({ logs }: { logs: readonly string[] }) {
  const { intl } = useZCodeIntl();
  // 回退文案不参与 i18n：它是内部兜底，正常路径永远有日志；
  // 若为它加文案，用户反而会把英文占位符当成正式提示。
  const shownLogs = logs.length > 0 ? logs : ["Queued plugin sync"];

  return (
    <HoverCard closeDelay={160} openDelay={120}>
      <HoverCardTrigger asChild>
        <span
          aria-label={intl.formatMessage({ id: "settings.plugins.remoteSync.logTooltip" })}
          className="inline-flex size-6 cursor-help items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground"
          role="img"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        side="left"
        sideOffset={6}
        className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 bg-popover p-3 text-left"
      >
        <div className="text-ui-base font-medium text-popover-foreground">
          {intl.formatMessage({ id: "settings.plugins.remoteSync.logTooltip" })}
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-2 font-mono text-ui-xs/relaxed text-popover-foreground">
          {shownLogs.join("\n")}
        </pre>
      </HoverCardContent>
    </HoverCard>
  );
}

// 进度列表：rows 来自"开始同步那一刻的选中行快照"（syncRows），
// 而不是实时重算——同步过程中用户切回选择页勾选其它项，不能影响本轮进度列表的成员。
// 每条进度都从 progressById 取，缺失时回退 queued：事件是异步到达的，
// 首帧可能还没有任何进度，没有回退会渲染出 undefined.status 崩溃。
// canStop 覆盖 queued 与 syncing：排队中的项也允许"不跑了"，
// 否则用户只能等前面几项跑完才能取消它。
function RemotePluginSyncProgressList({
  progressById,
  rows,
  onStop,
}: {
  progressById: ReadonlyMap<string, RemotePluginSyncProgressView>;
  rows: readonly RemotePluginSyncRow[];
  onStop: (candidateId: string) => void;
}) {
  const { intl } = useZCodeIntl();

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {rows.map((row) => {
        const progress = progressById.get(row.candidate.id) ?? {
          logs: ["Queued plugin sync"],
          status: "queued" as const,
        };
        const optionSummary = summarizeLocalPluginOptionsForDisplay(row.candidate.pluginOptions);
        const canStop = progress.status === "queued" || progress.status === "syncing";
        return (
          <div
            key={row.candidate.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base"
          >
            <span
              className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-foreground-subtle"
              aria-hidden="true"
            >
              <Cable className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="font-medium text-foreground">{row.candidate.name}</span>
                {row.candidate.version ? (
                  <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                    {row.candidate.version}
                  </span>
                ) : null}
                {row.candidate.componentTypes.map((type) => (
                  <span
                    key={type}
                    className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle"
                  >
                    {type}
                  </span>
                ))}
                <span className="rounded-md bg-secondary px-1.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                  {row.candidate.kind === "inline" ? "inline" : row.candidate.marketplace}
                </span>
              </div>
              {progress.result?.error ? (
                <div className="mt-1 break-words text-ui-base text-destructive">
                  {progress.result.error}
                </div>
              ) : row.candidate.path ? (
                <div className="mt-1 break-all font-mono text-ui-base text-foreground-subtlest">
                  {row.candidate.path}
                </div>
              ) : null}
              {optionSummary && !progress.result?.error ? (
                <div className="mt-1 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage(
                    { id: "settings.plugins.remoteSync.optionsSummary" },
                    {
                      manual: String(optionSummary.manualCount),
                      syncable: String(optionSummary.syncableCount),
                    },
                  )}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-start gap-1">
              {progress.status === "syncing" ? (
                <RemotePluginSyncLogHoverCard logs={progress.logs} />
              ) : null}
              <RemotePluginSyncStatusBadge status={progress.status} />
              {canStop ? (
                <ControlHintTooltip
                  title={intl.formatMessage({ id: "settings.plugins.remoteSync.stop" })}
                  side="left"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={intl.formatMessage({
                      id: "settings.plugins.remoteSync.stop",
                    })}
                    className="text-foreground-subtle hover:text-warning"
                    onClick={() => onStop(row.candidate.id)}
                  >
                    <CircleStop className="size-3.5" aria-hidden="true" />
                  </Button>
                </ControlHintTooltip>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 结果列表。key 由 pluginId + directoryName + status 组成（INV-16）：
// 同一插件在不同目录下是两条真实结果，不能合并；同目录同状态的重复项理论上不存在，
// 若出现（违反 INV-04），React 会用同一个 key 渲染并覆盖，属于可观测的"变少"，
// 比用下标作 key 造成的错位渲染更容易定位。
function RemotePluginSyncResultList({ result }: { result: RemotePluginSyncRunResult | null }) {
  const { intl } = useZCodeIntl();
  const items = result?.results ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.remoteSync.resultEmpty" })}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={`${item.pluginId}-${item.directoryName}-${item.status}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="truncate text-ui-base font-medium text-foreground">{item.name}</div>
              {item.error ? (
                <div className="mt-0.5 break-words text-ui-base text-destructive">{item.error}</div>
              ) : item.path ? (
                <div className="mt-0.5 truncate font-mono text-ui-xs text-foreground-subtlest">
                  {item.path}
                </div>
              ) : null}
            </div>
            <RemotePluginSyncStatusBadge status={item.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

// 主组件：只做状态编排与展示，业务逻辑全部下沉到上面的纯函数/独立流程函数。
// 这样本组件可以被要求"渲染正确"，而执行语义由 syncSelectedRemotePlugins 单测覆盖。
// 本地与远端成对传入（见 props 注释），组件内不做任何 kind 推断。
export function RemotePluginSyncDialog(props: RemotePluginSyncDialogProps) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const {
    localPluginSyncService,
    localWorkspacePath,
    localZCodeAgentService,
    onOpenChange,
    onSynced,
    open,
    remotePluginSyncService,
    remoteZCodeAgentService,
    remoteTarget,
    workspacePath,
    workspaceIdentity,
  } = props;
  // step 初始为 loading：即使 open=false，DialogContent 也可能被预渲染，
  // 用 selection 会让第一帧闪一下空列表。
  const [step, setStep] = useState<Step>("loading");
  // rows 是候选 × 远端现状的合并结果；选择、过滤、计数都从它派生。
  const [rows, setRows] = useState<RemotePluginSyncRow[]>([]);
  // 选择集合用 Set 而非数组：勾选/取消是 O(1)，且 id 天然去重。
  // 注意它存的是 candidate.id（复合键），不是 pluginId（INV-05 的落地前提）。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 默认显示已存在项：让用户先看到冲突，理解"为什么这项不能选"。
  const [showExistingRemotePlugins, setShowExistingRemotePlugins] = useState(true);
  // 结果只在 complete 阶段写入；null 表示"还没有结果"，与空数组（跑了但没结果）不同。
  const [importResult, setImportResult] = useState<RemotePluginSyncRunResult | null>(null);
  // 进度映射以 candidateId 为键；每项独立累积日志与最终 result（INV-19）。
  // 用 Map 而不是对象：candidateId 含 `:` 等字符，对象键在极端情况下会被原型链干扰。
  const [syncProgressById, setSyncProgressById] = useState<
    Map<string, RemotePluginSyncProgressView>
  >(new Map());
  // 本轮参与的 rows 快照。与 rows 分开存，保证同步中改动选择不影响本轮列表。
  const [syncRows, setSyncRows] = useState<RemotePluginSyncRow[]>([]);
  // 单一错误槽：加载失败、preflight 失败、整批异常都写这里。
  // 不区分错误来源是因为它们的处理动作完全一致（留在 selection 页重试）。
  const [error, setError] = useState<string | null>(null);
  // 下面四个 ref 承载"跨 await 的可变执行状态"，刻意不用 state：
  // 它们只被同步流程读写，不驱动渲染；用 state 会引入额外的渲染与陈旧闭包问题。
  // stopRequested：已点过停止的 candidateId 集合，被 isStopped 轮询；
  // stopWaiters：每项的"叫醒函数"，用于把正在 await 的项立即打断（否则要等 RPC 返回）；
  // syncInFlight：防重入标志，挡住"双击开始"产生的两个并发 run（INV-03 的前置）；
  // syncAbortController：当前 run 的中止器，也是判断"我是不是最新 run"的身份凭据。
  const stopRequestedRef = useRef<Set<string>>(new Set());
  const stopWaitersRef = useRef<Map<string, () => void>>(new Map());
  const syncInFlightRef = useRef(false);
  const syncAbortControllerRef = useRef<AbortController | null>(null);

  // open 转真时重新 load 并整体重置，转假时不动。
  // 依赖里包含两个 workspace 参数与四个 service：远端目标切换、attachment 重连
  // 都会换掉 service 实例，此时必须重新拉取候选，否则列表还停留在旧目标上。
  // [并发] cancelled 标志负责"卸载/重开"的结果丢弃；注意它只保护加载阶段，
  // 同步阶段用的是 AbortController（见下）。
  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setStep("loading");
    setRows([]);
    setSelectedIds(new Set());
    setShowExistingRemotePlugins(true);
    setImportResult(null);
    setSyncProgressById(new Map());
    setSyncRows([]);
    setError(null);
    // [事务] 重置顺序很重要：先 abort 上一轮 run，再清 ref。
    // 如果先清 ref 再 abort，上一轮的 finally 会看到 null（认为"我不是最新 run"）
    // 而跳过收尾，导致 abort 后仍有 setState 落进新会话。
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = null;
    // 清空 stop 表（INV-20）：上一轮的停止标记如果留着，新加载的项可能"一打开就是已停止"。
    // 因为它们共用同一套 candidateId，跨轮次复用 id 是常态。
    stopRequestedRef.current = new Set();
    stopWaitersRef.current = new Map();
    syncInFlightRef.current = false;

    void (async () => {
      try {
        const { candidates, statuses } = await loadRemotePluginSyncCandidates({
          localPluginSyncService,
          localWorkspacePath: localWorkspacePath ?? workspacePath,
          localZCodeAgentService,
          remotePluginSyncService,
          remoteWorkspaceIdentity: workspaceIdentity,
          remoteWorkspacePath: workspacePath,
          remoteZCodeAgentService,
        });
        // 每个 await 之后都要重判 cancelled（INV-18 的加载侧）：
        // 弹窗可能在请求期间被关闭或切换目标，此时写入会把旧目标的候选带到新会话。
        if (cancelled) {
          return;
        }
        const nextRows = buildRemotePluginSyncRowsForCandidates(candidates, statuses);
        setRows(nextRows);
        // 默认选择只在加载完成时算一次（INV-05）：用户之后的勾选不会被重新计算覆盖。
        setSelectedIds(resolveDefaultRemotePluginSyncSelection(nextRows));
        setStep("selection");
      } catch (loadError) {
        // 加载失败也进 selection 阶段而不是停在 loading：
        // 停在 loading 会得到一个永远转圈、无法关闭重试的弹窗；
        // 进 selection 后用户可以点"开始"（会重新触发 preflight 与真实错误）或关闭。
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStep("selection");
      }
    })();

    return () => {
      cancelled = true;
      // 远端目标失效会直接卸载 Dialog，绕过“同步中禁止关闭”的交互保护。
      // 主动终止当前 run，避免旧目标上的后续步骤和结果继续落回已失效的 UI。
      syncAbortControllerRef.current?.abort();
      syncAbortControllerRef.current = null;
    };
  }, [
    localPluginSyncService,
    localWorkspacePath,
    localZCodeAgentService,
    open,
    remotePluginSyncService,
    remoteZCodeAgentService,
    workspaceIdentity,
    workspacePath,
  ]);

  // 派生链：rows → visibleRows（过滤展示）→ visibleMissingIds（可选项）→ selectedSyncIds
  // （已选且仍可见/可选）。三级 useMemo 的依赖都是上一级的引用，
  // 保证只在真正变化时重算——这个列表可能出现上百项，逐帧 filter 会拖慢输入响应。
  const visibleRows = useMemo(
    () => filterRemotePluginSyncRows(rows, showExistingRemotePlugins),
    [rows, showExistingRemotePlugins],
  );
  // 可选项 = 可见且远端不存在。所有"计数 / 全选 / 开始"都必须走它（INV-05），
  // 否则隐藏已存在项后，selectedSyncIds 会把隐藏项也算进来，出现"0 项可见却显示已选 3"。
  const visibleMissingIds = useMemo(
    () => visibleRows.filter((row) => !row.exists).map((row) => row.candidate.id),
    [visibleRows],
  );
  // 取交集而不是直接用 selectedIds：selectedIds 可能包含"曾经可见、现在被过滤掉"的项，
  // 这些项仍在集合里（不丢用户意图），但不参与本轮开始的计数与执行。
  const selectedSyncIds = useMemo(
    () => visibleMissingIds.filter((id) => selectedIds.has(id)),
    [selectedIds, visibleMissingIds],
  );
  const selectedCount = selectedSyncIds.length;
  // 目标名只由外部格式化函数决定（INV-22）：本组件不理解 remoteTarget 的结构。
  const targetLabel = formatRemoteSkillSyncTarget(remoteTarget, workspacePath);

  const handleOpenChange = (nextOpen: boolean) => {
    // plugin 同步是逐项远端 RPC；同步中关闭弹窗会让下次打开时重置为 loading/0 项，
    // 但后台 RPC 仍在跑。同步中只拦截关闭请求，避免丢失进度状态。
    if (!shouldAllowRemotePluginSyncDialogOpenChange(step, nextOpen)) {
      return;
    }
    onOpenChange(nextOpen);
  };

  // 勾选切换用函数式更新并复制一份 Set：React 依赖引用比较，
  // 原地 mutate 后返回同一个 Set 会导致不重渲染（看起来点了没反应）。
  // 参数名沿用 pluginId 但实际传入的是 candidate.id——由 SelectionList 的 onToggle 约定，
  // 改名需要同步改子组件类型，此处保持现状以免引入无关 diff。
  const togglePlugin = (pluginId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(pluginId);
      } else {
        next.delete(pluginId);
      }
      return next;
    });
  };

  // 单项停止：三个动作必须按顺序完成。
  //   1) 写入停止标记 → 之后每个 await 前的 throwIf 都能看到；
  //   2) 叫醒正在等待的 waiter → 让已发出的 RPC 立刻"输掉"race；
  //   3) 本地先把该行状态改成 stopped → UI 即时反馈，不等下一个事件回来。
  // 第 3 步只是乐观展示：真正的终态仍由 syncSelectedRemotePlugins 产出的结果覆盖，
  // 因此这里不需要（也不能）直接往 importResult 里塞东西。
  const stopPluginSync = (candidateId: string) => {
    stopRequestedRef.current.add(candidateId);
    stopWaitersRef.current.get(candidateId)?.();
    // 远端 marketplace install/add 会占用插件存储锁；只在远程同步生成的
    // operationId 上发送取消，避免误伤本地插件页的常规安装、启停和市场管理操作。
    setSyncProgressById((current) => {
      const next = new Map(current);
      const previous = next.get(candidateId) ?? { logs: [], status: "queued" as const };
      next.set(candidateId, {
        ...previous,
        logs: [
          ...previous.logs,
          "stop requested; cancelling the active remote plugin operation when possible",
        ],
        status: "stopped",
      });
      return next;
    });
  };

  // 开始同步的编排函数。结构是"三段式"：
  //   A. 门禁（in-flight / 空选择）→ B. preflight（写权限探测）→ C. 逐项执行。
  // 三段之间各有一个 abort 检查点，保证每一步都能被"关窗 / 切目标"立即打断。
  // 为什么要单独做 preflight 而不是直接在首项上报错（INV-21）：
  // 权限问题会让每一项都失败，用户看到 N 条相同错误却不知道根因；
  // preflight 把「整批不可写」提前变成一条清晰提示，且不产生任何远端写。
  const syncSelected = async () => {
    // 门禁：inFlight 挡住双击/连点；selectedCount 为 0 时给出明确提示。
    // 注意这里用 selectedSyncIds（可见且可选的交集），不是 selectedIds：
    // 被过滤隐藏但仍在 selectedIds 里的项不应触发一次空同步。
    if (
      !shouldStartRemoteSyncOperation({
        inFlight: syncInFlightRef.current,
        selectedCount: selectedSyncIds.length,
      })
    ) {
      if (selectedSyncIds.length === 0) {
        setError(intl.formatMessage({ id: "settings.plugins.remoteSync.noSelection" }));
      }
      return;
    }

    // 先置 inFlight 再创建 controller：两步之间没有 await，
    // 但顺序仍重要——若先创建再置标志，极端重入下会短暂出现"两个 controller 都有效"。
    syncInFlightRef.current = true;
    const syncAbortController = new AbortController();
    // abort 上一轮是防御性的：正常流程下上一轮已结束，但"停止后立刻再次开始"
    // 可能让上一轮的收尾还没跑完；先取消它，保证任何时刻只有一个有效 signal。
    syncAbortControllerRef.current?.abort();
    syncAbortControllerRef.current = syncAbortController;
    // 收尾函数：只有"我仍是当前 run"时才释放标志（INV-03）。
    // 旧 run 的 finally 可能在新 run 启动之后才执行（例如它正卡在一个已 abort 的
    // RPC 上），此时如果把 inFlight 清成 false，新 run 就会失去防重入保护，
    // 用户可以再次点击开始，产生第三个 run。
    const finishSyncRun = () => {
      if (!shouldFinishRemotePluginSyncRun(syncAbortControllerRef.current, syncAbortController)) {
        return;
      }
      syncAbortControllerRef.current = null;
      syncInFlightRef.current = false;
    };
    setError(null);
    setStep("preflighting");
    // selectedRows 来自 rows（完整集合）而不是 visibleRows：
    // 过滤只影响 visibleRows，不改变 selectedIds 的内容；
    // 但条件里同时要求 !exists 与 selectedIds.has（双保险），
    // 防止非法状态（exists 被选中）在数据层泄漏进执行层（INV-05）。
    const selectedRows = rows.filter((row) => !row.exists && selectedIds.has(row.candidate.id));
    try {
      // preflight 带超时（runRemoteSyncPreflightWithTimeout）：
      // 权限探测本身也可能挂住（远端 agent 无响应），无超时会让弹窗永远停在 preflighting
      // 且关闭按钮被 INV-02 拦住，形成死锁。
      const access = await runRemoteSyncPreflightWithTimeout(() =>
        remotePluginSyncService.checkRemoteUserPluginWriteAccess(),
      );
      if (!access.ok) {
        throw new Error(
          intl.formatMessage(
            { id: "settings.remoteSync.preflightFailed" },
            { path: access.path, error: access.error ?? "" },
          ),
        );
      }
    } catch (syncError) {
      // abort 分支不写 error：用户主动关窗/切目标不是故障，写错误会闪一下红字。
      if (syncAbortController.signal.aborted) {
        finishSyncRun();
        return;
      }
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
      // 失败回到 selection 而不是 complete：没有产生任何结果，
      // 让用户可以立刻改选择或重试，不用先关窗再打开。
      setStep("selection");
      finishSyncRun();
      return;
    }

    // preflight 与执行之间再判一次 abort：探测可能耗几十毫秒，
    // 这期间用户完全可能已经关掉弹窗。
    if (syncAbortController.signal.aborted) {
      finishSyncRun();
      return;
    }

    setStep("syncing");
    setSyncRows(selectedRows);
    setSyncProgressById(
      new Map(
        selectedRows.map((row) => [
          row.candidate.id,
          {
            logs: ["Queued plugin sync"],
            status: "queued" as const,
          },
        ]),
      ),
    );
    // 进入执行前再清空一次 stop 表：上一轮点过停止的 candidateId 可能与本轮重叠，
    // 不清会让本轮同类项"一开始就是停止状态"（INV-20 的执行侧保险）。
    stopRequestedRef.current = new Set();
    stopWaitersRef.current = new Map();
    try {
      // 传入 rows: selectedRows 而非 rows：执行集合必须是"开始那一刻"的快照，
      // 之后 rows 因加载或外部刷新变化也不影响本轮。
      const result = await syncSelectedRemotePlugins({
        localPluginSyncService,
        reportTelemetryEvent: (event) =>
          reportAppTelemetryEvent(
            platform,
            {
              ...event,
              eventExtraDetail: {
                ...event.eventExtraDetail,
                client_kind: "desktop",
                remote_kind: remoteTarget.kind,
              },
            },
            "RemotePluginSync",
          ),
        onItemProgress: (event) => {
          // 事件可能在本轮被 abort 之后才到达（远端回包晚于关窗），
          // 必须丢弃，否则会往已重置的 map 里写旧 run 的状态（INV-18）。
          if (syncAbortController.signal.aborted) {
            return;
          }
          // 日志追加、result 保序、status 覆盖，三者的更新规则不同：
          //   logs：只追加，保留完整轨迹；
          //   result：有则覆盖、无则沿用旧的（INV-19 的"只增不改身份"）；
          //   status：永远取最新事件（queued→syncing→终态是单向推进）。
          setSyncProgressById((current) => {
            const next = new Map(current);
            const previous = next.get(event.candidateId) ?? {
              logs: [],
              status: "queued" as const,
            };
            next.set(event.candidateId, {
              logs: [...previous.logs, event.log],
              ...(event.result
                ? { result: event.result }
                : previous.result
                  ? { result: previous.result }
                  : {}),
              status: event.status,
            });
            return next;
          });
        },
        remotePluginSyncService,
        remoteWorkspaceIdentity: workspaceIdentity,
        remoteWorkspacePath: workspacePath,
        remoteZCodeAgentService,
        rows: selectedRows,
        signal: syncAbortController.signal,
        // stopControl 把 React 侧的停止状态注入到纯同步逻辑，保持后者无 React 依赖。
        // 三个回调各有边界条件：
        //   cancelOperation：远端不支持取消时静默返回（旧版本兼容），不能抛错打断流程；
        //   isStopped：读 ref 而非 state，保证在 await 中读到的永远是最新值
        //     （闭包里的 state 会停留在渲染时刻）；
        //   waitForStop：已停止则立刻 resolve；否则挂一个 waiter，等待 stopPluginSync 叫醒。
        // 注意 waiter 不做清理：若该项在被停止前就自然结束，这个 Promise 会一直悬着，
        // 但它只被 race 使用，不再 resolve 也不会泄漏（闭包随本轮 run 一起被回收）。
        stopControl: {
          cancelOperation: async (operationId) => {
            if (!remoteZCodeAgentService?.cancelPluginOperation) {
              return;
            }
            await remoteZCodeAgentService.cancelPluginOperation({ operationId });
          },
          isStopped: (candidateId) => stopRequestedRef.current.has(candidateId),
          waitForStop: (candidateId) => {
            if (stopRequestedRef.current.has(candidateId)) {
              return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
              stopWaitersRef.current.set(candidateId, resolve);
            });
          },
        },
      });
      // 执行结束后的第一个检查点：abort 后不调用 onSynced——
      // 它会让父组件刷新远端插件列表，属于"对外可见的副作用"，旧目标不该触发。
      if (syncAbortController.signal.aborted) {
        return;
      }
      // onSynced 在写结果之前：父组件刷新失败会抛错，此时应表现为"整批失败"
      // 而不是"结果已展示但列表是旧的"。代价是刷新慢时结果页出现略晚。
      await onSynced();
      if (syncAbortController.signal.aborted) {
        return;
      }
      setImportResult(result);
      setStep("complete");
    } catch (syncError) {
      // 走到这里说明 syncSelectedRemotePlugins 整体抛错（例如 onSynced 失败），
      // 单项失败已在内部转成结果，不会到这里。
      if (syncAbortController.signal.aborted) {
        return;
      }
      setError(syncError instanceof Error ? syncError.message : String(syncError));
      setStep("selection");
    } finally {
      // finishSyncRun 内部会做"我是不是最新 run"的判断（INV-03）：
      // 旧 run 结束时不得把新 run 的 controller / inFlight 清掉。
      finishSyncRun();
    }
  };

  // 渲染结构：Header（标题 + 目标行）→ 可滚动主体（按 step 五选一）→ 固定页脚（计数 + 开始）。
  // 页脚固定在滚动区外，是因为"开始"按钮在长列表下必须始终可点；
  // 主体给 min-h-0 才能让 flex 子项正确收缩并出现内部滚动（否则会撑破弹窗高度）。
  // showCloseButton 与 handleOpenChange 同源（INV-02）：两处任一漏判都会留下绕过路径，
  // 例如只剩 X 按钮能关，用户照样能在同步中关掉弹窗。
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={step !== "preflighting" && step !== "syncing"}
        className="h-[min(720px,calc(100dvh-2rem))] max-h-[min(720px,calc(100dvh-2rem))] max-w-2xl flex flex-col overflow-hidden"
      >
        <DialogHeader>
          <RemotePluginSyncTitle />
          <RemotePluginSyncTargetRow
            targetLabel={targetLabel}
            showExistingRemotePlugins={showExistingRemotePlugins}
            showExistingFilter={step === "selection" && rows.length > 0}
            onShowExistingRemotePluginsChange={setShowExistingRemotePlugins}
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
              {intl.formatMessage({ id: "settings.plugins.remoteSync.loading" })}
            </div>
          ) : null}
          {step === "preflighting" ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.remoteSync.preflighting" })}
            </div>
          ) : null}
          {step === "selection" ? (
            <RemotePluginSyncSelectionList
              rows={visibleRows}
              selectedIds={selectedIds}
              emptyMessageId={
                rows.length > 0 ? "settings.plugins.remoteSync.filteredEmpty" : undefined
              }
              onToggle={togglePlugin}
            />
          ) : null}
          {step === "syncing" ? (
            <RemotePluginSyncProgressList
              progressById={syncProgressById}
              rows={syncRows}
              onStop={stopPluginSync}
            />
          ) : null}
          {step === "complete" ? <RemotePluginSyncResultList result={importResult} /> : null}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteSync.selectionCount" },
              { selected: String(selectedCount), total: String(visibleMissingIds.length) },
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {step === "selection" ? (
              <RemotePluginSyncBulkSelectionCheckbox
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
              {intl.formatMessage({ id: "settings.plugins.remoteSync.start" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
