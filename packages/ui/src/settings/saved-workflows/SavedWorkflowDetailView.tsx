// 工作流详情页视图：单个已保存工作流的「定义」（元数据内联编辑 + 只读脚本）与
// 「运行历史」（journal 行）双标签；本文件负责详情拉取、草稿态、脏判定与保存提交。
//
// 边界：列表筛选、运行触发、运行详情跳转、产物面板与实参弹窗都在父层或 launchDialog
// 里；本文件只消费 props，把 target/name 原样透传给 agentService，不自己拼作用域，
// 也不做删除/移动/提升作用域的确认交互（那部分在 Header 与父层）。
//
// 骨架：Header → 「最近产物」条（按需出现）→ 标签行 → 定义/历史分支 → launchDialog。
// 定义区内部再按 loadState 三态（loading / failed / ready）分派，失败态绝不静默成空表单。
//
// 注释口径（38 批）：每条都指向「看起来该改、其实不能改」的点，并写清改错后的线上症状；
// 下面是不变量清单，正文块只对局部易错分支补充，不复述 JSX 表面结构。
//
// INV-01 作用域必须整体透传：getSavedWorkflow 与 updateSavedWorkflowMeta 都用 {...target, name} 合并 —— 守住它的位置：载入 effect 与 save 的请求参数 —— 改错故障：全局档请求打到项目档，读到别的脚本或直接 not_found。
// INV-02 载入 effect 的 cancelled 守卫不可删：每次依赖变化都新建标志，旧请求回写前先判真 —— 守住它的位置：effect 内 then 与 catch 开头 —— 改错故障：快速切换工作流时旧响应覆盖新详情，随后的保存写坏另一份脚本。
// INV-03 effect 依赖里必须保留 target 对象本身：换作用域就是换数据源，不能只依赖 name —— 守住它的位置：useEffect 依赖数组 —— 改错故障：从项目档切到同名全局档仍展示旧详情。
// INV-04 失败原因原样保留：failed 只存服务端 reason，不在本层翻译成通用文案 —— 守住它的位置：loadState 的 failed 分支 —— 改错故障：parse_error 被显示成「未找到」，用户去新建同名文件反而覆盖坏脚本。
// INV-05 baseline 只从 detail.meta 派生，draft 是它的副本 —— 守住它的位置：baseline 的 useMemo 与 draftFromMeta —— 改错故障：脏判定与「放弃修改」同时失效，用户点放弃却回不到服务端值。
// INV-06 脏判定用 JSON.stringify 做结构比较，不允许改成引用比较或浅比较 —— 守住它的位置：dirty 的 useMemo —— 改错故障：输入后没改也亮保存按钮，或改完仍被判为未修改而无法保存。
// INV-07 draftFromMeta 把 whenToUse 用空串归一，禁止保留 undefined —— 守住它的位置：draftFromMeta 的返回值 —— 改错故障：草稿与 baseline 形状不一致，页面一打开就是脏的。
// INV-08 参数行 key 必须全局唯一且单调，新增行前缀加自增序号 —— 守住它的位置：addRow 与 rowKeySeq —— 改错故障：删除后再新增复用旧 key，更新一行会连带改到另一行。
// INV-09 updateRow 顺手清除该行错误，不能只改数据 —— 守住它的位置：updateRow 里的 setRowErrors —— 改错故障：改正后错误提示仍挂着，用户以为保存按钮坏了。
// INV-10 保存前必须本地校验：描述非空且参数行转声明成功，任一失败直接返回 —— 守住它的位置：save 的前置分支 —— 改错故障：非法参数声明被写进 .dwf.ts，下次读取直接 parse_error。
// INV-11 meta 组装用条件展开：空 whenToUse 与 undefined args 要整字段省略 —— 守住它的位置：save 里的 meta 字面量 —— 改错故障：用空值覆盖既有字段，用户在别处写的说明被清空。
// INV-12 保存失败只 toast，不重置草稿 —— 守住它的位置：save 的失败分支 —— 改错故障：失败后草稿被清空，用户刚输入的一整段参数表丢失。
// INV-13 保存成功后既要 bump reloadSeq 又要回调 onMetaSaved —— 守住它的位置：save 的成功分支 —— 改错故障：详情不重取导致 baseline 仍是旧值，页面立刻又变脏；或父层列表标题不刷新。
// INV-14 saving 必须在 finally 复位，不能只在成功路径复位 —— 守住它的位置：save 的 try/finally —— 改错故障：一次异常之后保存按钮永久转圈，只能刷新页面。
// INV-15 「最近产物」取第一个 completed 且有产物的 run，不能取第一个 run —— 守住它的位置：latestArtifactRun 的 find —— 改错故障：最近一次失败运行会让已交付的产物凭空消失。
// INV-16 产物 chip 只有在 parentSessionId 存在时才挂 onOpenArtifact —— 守住它的位置：「最近产物」条里的条件展开 —— 改错故障：没有会话的产物点开后无处跳转，用户以为功能坏了。
// INV-17 path 与 description 用 detail 优先、entry 兜底 —— 守住它的位置：path 与 description 两个 const —— 改错故障：加载中标题与路径整块空白闪烁，列表已有信息没被用上。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import {
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_DETAIL_SCRIPT,
  TID_WORKFLOW_DETAIL_TAB,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowMeta,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsGetResult,
} from "@zcode/shared";
import type { IZCodeAgentService, ZCodeAgentSavedWorkflowTarget } from "@zcode/services";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import {
  argsDeclarationToRows,
  rowsToArgsDeclaration,
  type SavedWorkflowArgRow,
  type SavedWorkflowArgRowError,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";
import { SavedWorkflowArtifactChips } from "@/settings/saved-workflows/SavedWorkflowArtifactChips.js";
import { SavedWorkflowDetailHeader } from "@/settings/saved-workflows/SavedWorkflowDetailHeader.js";
import {
  SavedWorkflowMetaForm,
  type SavedWorkflowMetaDraft,
} from "@/settings/saved-workflows/SavedWorkflowMetaForm.js";
import {
  SavedWorkflowRunHistory,
  type SavedWorkflowRunProject,
} from "@/settings/saved-workflows/SavedWorkflowRunHistoryPanel.js";

type DetailTab = "definition" | "history";

type DetailLoad =
  | { status: "loading" }
  | { status: "ready"; detail: Extract<ZCodeWorkflowsGetResult, { ok: true }> }
  | { status: "failed"; reason: string };

type MetaDraft = SavedWorkflowMetaDraft;

// [契约] draftFromMeta 是「服务端 meta → 表单草稿」的唯一入口，初次填充与 baseline 都走它；另写一份映射会让脏判定从此恒为真。
// [契约] 行对象只保留表单需要的字段，args 的原始声明交给 argsDeclarationToRows 解析，不要在这里反向回写 meta。
// [权衡] whenToUse 归一成空串而不是保留 undefined，是为了让输入框保持受控；别按后端「字段可省略」的语义理解这个值。
function draftFromMeta(meta: ZCodeSavedWorkflowMeta): MetaDraft {
  return {
    description: meta.description,
    whenToUse: meta.whenToUse ?? "",
    rows: argsDeclarationToRows(meta.args),
  };
}

// [并发] rowKeySeq 是模块级自增，跨组件实例共享：即使同时挂载两个详情页，新增行也不会撞 key。
// [契约] 不要把它挪进组件内 useState：面板重新挂载会从 0 重来，与历史行的 key 撞车。
// [失败路径] 也不要用工作流名派生 key：同一份草稿里所有新增行会同 key，删一行会把它们一起删掉。
// [权衡] 该变量不参与渲染，只提供唯一性，放在模块作用域不会引起额外重渲染，是刻意选择。
let rowKeySeq = 0;

interface SavedWorkflowDetailViewProps {
  /** 项目档传 workspace target；全局档传 `{ scope: "global" }`（get/updateMeta 直接透传）。 */
  target: ZCodeAgentSavedWorkflowTarget;
  agentService: IZCodeAgentService;
  name: string;
  /** 标题旁的归属小标：项目名，全局档为「全局」。面包屑不带这一级。 */
  projectLabel: string;
  entry: ZCodeSavedWorkflowEntry | undefined;
  runs: readonly ZCodeSavedWorkflowRun[];
  now: number;
  busy: boolean;
  canOpenRun: boolean;
  onBack: () => void;
  onRun: () => void;
  onRevise: () => void;
  onCopyPath: () => void;
  /** 作用域动作：项目档「提升为全局」（AI 概括）/ 全局档「移到项目…」；仅在传入时出现。 */
  onMove?: () => void;
  onDelete: () => void;
  onOpenRun: (run: ZCodeSavedWorkflowRun) => void;
  /** 产物 chip → `workflow-artifact` tab；缺席即 chips 只读。 */
  onOpenArtifact?: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
  onMetaSaved: () => void;
  /** 传入即在运行历史每行渲染项目列（全局工作流跨项目历史）。 */
  resolveRunProject?: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null;
  /** 实参窗由列表层持有（同一份状态），详情页只负责挂到树上。 */
  launchDialog: ReactNode;
}

/**
 * 工作流详情页：与定时任务编辑页同构——
 * 面包屑、标题、右上动作、分段标签。「定义」= 元数据行内编辑 + 只读脚本；「运行历史」= journal 行。
 */
export function SavedWorkflowDetailView({
  target,
  agentService,
  name,
  projectLabel,
  entry,
  runs,
  now,
  busy,
  canOpenRun,
  onBack,
  onRun,
  onRevise,
  onCopyPath,
  onMove,
  onDelete,
  onOpenRun,
  onOpenArtifact,
  onMetaSaved,
  resolveRunProject,
  launchDialog,
}: SavedWorkflowDetailViewProps) {
  // [契约] 七个 state 各有单一所有：tab 是视图，loadState 是远端事实，draft 是本地草稿，其余是校验与提交态。
  // [权衡] 把 draft 并进 loadState 会省一个 state，但「保存失败仍保留用户输入」就无法实现，别做这个合并。
  // [契约] rowErrors 与 descriptionError 是「保存尝试后」的校验结果，不随输入自动重算，所以 updateRow 必须手动清。
  // [契约] reloadSeq 只是重取触发器：进依赖数组即可重跑 effect，不要在别处手写 setLoadState 模拟刷新。
  // [契约] busy 与 saving 不是一回事：前者代表外部正在运行工作流，后者代表本页正在写元数据，不能互相替代。
  const { intl } = useZCodeIntl();
  const [tab, setTab] = useState<DetailTab>("definition");
  const [loadState, setLoadState] = useState<DetailLoad>({ status: "loading" });
  const [draft, setDraft] = useState<MetaDraft | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, SavedWorkflowArgRowError>>({});
  const [descriptionError, setDescriptionError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);

  // [事务] 一次拉取的完整语义：先置 loading，成功则写入 detail、重建草稿、清空校验态，失败则写入 reason。
  // [契约] 成功分支必须同时 setDraft 与清空 rowErrors/descriptionError，否则重取后仍挂着上一次的红字。
  // [失败路径] then 里对 !result.ok 要单独返回，不能继续走 ready 分支：失败结果上没有 meta，读它会在渲染期抛错。
  // [并发] cancelled 必须在 then 与 catch 两处都判；只判一处，卸载后的 setState 仍会发生。
  // [资源] 清理函数只翻标志、不发取消请求：服务端调用无法中断，翻标志是唯一安全的收尾方式。
  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: "loading" });
    agentService
      .getSavedWorkflow({ ...target, name })
      .then((result) => {
        if (cancelled) return;
        // [失败路径] 协议层把 not_found、invalid_name、parse_error 当正常结果返回，不是异常；这里必须落 failed 而不是抛出。
        // [失败路径] 一旦改成抛错，异常会进 catch 被压成一个字符串，UI 再也分不清「文件不存在」和「脚本语法错」。
        // [契约] reason 原样存进 loadState，文案选择留给渲染层按 reason 决定。
        // [契约] 该分支必须 return，否则控制流继续读 result.meta，而失败结果根本没有这个字段。
        if (!result.ok) {
          setLoadState({ status: "failed", reason: result.reason });
          return;
        }
        setLoadState({ status: "ready", detail: result });
        setDraft(draftFromMeta(result.meta));
        setRowErrors({});
        setDescriptionError(false);
      })
      // [失败路径] catch 覆盖的是 IPC 与网络层异常，与协议内的 !ok 是两类失败，不能合并成一个分支处理。
      // [契约] 这里用 logger.warn 记一条即可：详情读取失败可恢复，用户重试或返回列表就能退出该状态。
      // [契约] 日志只带 name 与 message，禁止把整个 error 或脚本文本打进去，避免泄露用户内容。
      // [并发] 与 then 一样先判 cancelled，否则快速切页时旧请求会把过期失败态写进新页面。
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[SavedWorkflows] 读取工作流详情失败", { name, error: message });
        setLoadState({ status: "failed", reason: message });
      });
    // [资源] 卸载或依赖变化时把 cancelled 置真，这是阻断已发出请求回写的唯一开关。
    // [并发] 不要把 cancelled 换成跨 effect 复用的 ref：新一轮 effect 会读到上一轮遗留的真值，详情永远停在 loading。
    // [权衡] 这里刻意不引入 AbortController：请求即使被取消，resolve 后的结果仍需丢弃，标志位更可靠。
    // [契约] 换 name、换 target、bump reloadSeq 都会先跑本清理再跑新 effect，因此三者语义一致。
    return () => {
      cancelled = true;
    };
  }, [agentService, name, reloadSeq, target]);

  // [契约] detail 只有 ready 时非空，其余状态一律 null，下游因此可以少写一层状态判断。
  // [契约] detail 与 draft 必须同时存在才渲染表单：draft 由成功分支的 setDraft 写入，两者生命周期同进退。
  // [失败路径] 不要改成可选链后兜底空对象：空对象会骗过 detail 与 draft 的联合分支，渲染出全空表单并允许保存。
  const detail = loadState.status === "ready" ? loadState.detail : null;
  const baseline = useMemo(() => (detail ? draftFromMeta(detail.meta) : null), [detail]);
  // [契约] 脏判定是 draft 与 baseline 的字符串结构比较；二者同源（都出自 draftFromMeta），字段顺序天然稳定。
  // [失败路径] 一旦有人手搓一个字段顺序不同的对象塞进 draft，比较立刻恒为真，保存按钮常亮。
  // [权衡] 上深比较库能抗字段乱序，但这里不划算：草稿结构固定且很小，字符串比较已足够。
  // [失败路径] draft 或 baseline 缺一就返回 false 是有意的：加载中与失败态不该出现可保存状态。
  // [契约] 该值同时驱动保存可用性与「放弃修改」可用性，改判定口径要两条路径一起看。
  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseline);
  }, [baseline, draft]);

  const updateDraft = useCallback((patch: Partial<MetaDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);
  // [事务] 先更新行数据、再清该行错误，两个 setState 在同一回调内，React 会合并成一次渲染。
  // [契约] 清错误必须「键存在才拷贝」：无脑新建对象会让每次按键都产生新引用，触发下游无谓重渲染。
  // [契约] 只清被编辑的那一行，不要清全表：没动过的参数行的错误依然有效。
  // [并发] 用 map 按 key 重建数组，禁止按下标改：删行之后下标整体错位，会调到相邻行。
  const updateRow = useCallback((key: string, patch: Partial<SavedWorkflowArgRow>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
          }
        : current,
    );
    setRowErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);
  const addRow = useCallback(() => {
    // [契约] key 必须在本行入列表之前就确定，不能依赖渲染时的随机值或数组下标。
    // [失败路径] 若把自增挪进 setDraft 的 updater，严格模式下二次调用会让序号跳号，key 变得不可预测。
    // [权衡] 用模块级自增而不是随机串：key 只在本页生命周期内比较，短且可读更利于排查。
    // [权衡] 序号永不回收，长时间开页面会缓慢增长，但行数有限，不存在溢出风险。
    rowKeySeq += 1;
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: [
              ...current.rows,
              {
                key: `new:${rowKeySeq}`,
                name: "",
                type: "string",
                required: false,
                defaultText: "",
                description: "",
              },
            ],
          }
        : current,
    );
  }, []);
  // [契约] 删除行只过滤数据，不主动清 rowErrors 里对应键：残留项不可见，且 key 永不复用所以读不到。
  // [权衡] 这个残留是有意的泄漏，比在删除时多写一次 setState 更划算，别当成 bug 去补。
  // [契约] 不要在删除时手算 dirty：脏标记由 useMemo 派生，手动干预会造出两份真相。
  // [契约] 也不重置 descriptionError，描述错误与参数行无关，清了会让用户误以为描述已修好。
  const removeRow = useCallback((key: string) => {
    setDraft((current) =>
      current ? { ...current, rows: current.rows.filter((row) => row.key !== key) } : current,
    );
  }, []);
  // [契约] 放弃修改是把 draft 整体换回 baseline，不是逐字段还原：逐字段会在字段增删时漏掉新键。
  // [失败路径] baseline 为空（未就绪）时什么都不做，否则会把 null 写进 draft，整块表单瞬间消失。
  // [契约] 同时清掉两类校验错误，否则用户点了放弃仍看到「请填写描述」的红字。
  // [契约] `onMetaSaved` 不触发重新拉取：服务端值未变，重取只会白跑一次请求。
  const discard = useCallback(() => {
    if (baseline) setDraft(baseline);
    setRowErrors({});
    setDescriptionError(false);
  }, [baseline]);

  // [事务] 顺序固定：本地校验 → 组装 meta → 置 saving → 提交 → 成功刷新或失败提示 → finally 复位。
  // [契约] 任何提前 return 都必须发生在 setSaving 之前，否则按钮会卡在提交态。
  // [失败路径] 校验失败时不发请求、不动 draft：用户输入原样保留，只需按提示改错。
  // [契约] 成功后用 reloadSeq 触发重取，而不是本地覆盖 detail：服务端可能规范化了字段，本地猜会与文件不一致。
  // [并发] 本回调没有重入锁，防连点靠 saving 禁用保存按钮；若移除该禁用，必须自己补锁。
  const save = useCallback(async () => {
    if (!draft) return;
    const description = draft.description.trim();
    // [契约] 参数行语法校验全部交给 rowsToArgsDeclaration，本层不重复实现类型解析。
    // [失败路径] 返回不 ok 时把 errors 整体写入 rowErrors（按行 key 索引），UI 才能把提示挂到对应行。
    // [失败路径] 不要只提示第一条错误：用户需要一次看到全部坏行，否则要反复提交试错。
    // [权衡] 校验结果不做缓存：每次保存全量重算，行数很少，正确性优先于这点开销。
    const collected = rowsToArgsDeclaration(draft.rows);
    const descriptionMissing = description.length === 0;
    setDescriptionError(descriptionMissing);
    if (!collected.ok) setRowErrors(collected.errors);
    if (descriptionMissing || !collected.ok) return;
    const whenToUse = draft.whenToUse.trim();
    // [契约] 空 whenToUse 用条件展开整字段省略，而不是传空串：省略表达「没有」，空串表达「有但为空」。
    // [契约] args 为 undefined 时同样省略，避免把「没填参数」写成空参数表覆盖已有声明。
    // [失败路径] 反过来，description 必填所以无条件写入；它也做条件展开的话，服务端会删掉描述字段。
    // [契约] 该对象直接落盘到工作流文件，字段增删要同步服务端的解析与回写逻辑。
    // [权衡] 用条件展开而非先赋再删，能让类型收窄生效，也避免产生被就地改写的可变对象。
    const meta: ZCodeSavedWorkflowMeta = {
      description,
      ...(whenToUse.length === 0 ? {} : { whenToUse }),
      ...(collected.args === undefined ? {} : { args: collected.args }),
    };
    // [契约] saving 必须在真正发请求之前置真；放到 await 之后等于没有禁用窗口。
    // [并发] 置真位置可以在 try 内第一行，但绝不能放进 then：请求进行中用户仍能连点保存。
    // [契约] saving 只锁本页元数据保存，不锁运行按钮：两者写的是不同资源，互不阻塞。
    // [契约] 该标志必须由 finally 复位，成功分支不要自行复位，否则异常路径会漏。
    setSaving(true);
    try {
      const result = await agentService.updateSavedWorkflowMeta({ ...target, name, meta });
      if (!result.ok) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.detail.meta.saveFailed" },
            { reason: intl.formatMessage({ id: `workflows.hub.reason.${result.reason}` }) },
          ),
        );
        return;
      }
      toast(intl.formatMessage({ id: "workflows.hub.detail.meta.saved" }));
      setReloadSeq((current) => current + 1);
      onMetaSaved();
    // [失败路径] 这里是调用层异常（IPC 断开、序列化失败），与协议 !ok 分开处理，但对外提示同一条文案。
    // [契约] 异常 message 直接作为 toast 的参数，不再二次包装，方便用户把原文发给支持。
    // [失败路径] 不要在这里把 loadState 打成 failed：详情本身没坏，只是这次写入失败，打成失败态会连带藏掉表单。
    // [失败路径] 捕获后不重新抛出：本层是交互终点，抛出只会变成未处理的 promise rejection。
    } catch (error) {
      toast(
        intl.formatMessage(
          { id: "workflows.hub.detail.meta.saveFailed" },
          { reason: error instanceof Error ? error.message : String(error) },
        ),
      );
    } finally {
      setSaving(false);
    }
  }, [agentService, draft, intl, name, onMetaSaved, target]);

  const copyScript = useCallback(() => {
    if (!detail) return;
    void navigator.clipboard?.writeText(detail.script).catch(() => undefined);
  }, [detail]);

  // 「最近产物」条：**最近一次 completed run** 的
  // 产物。刻意不取「最近一次 run」——一次刚失败的运行往往什么都没交付，用它会让这条已经存在的
  // 交付物凭空消失一阵子。runs 已按 updatedAt 倒序（服务端 time_updated desc），取首个即可。
  const latestArtifactRun = useMemo(
    () => runs.find((run) => run.status === "completed" && (run.artifacts?.length ?? 0) > 0),
    [runs],
  );

  const path = detail?.path ?? entry?.path ?? "";
  const description = detail?.meta.description ?? entry?.description ?? "";

  // [契约] 渲染分派顺序固定：先 history 分支，再 loading，再 failed，最后才是 ready 表单。
  // [权衡] history 优先于加载态是有意的：历史来自父层 runs，不依赖详情请求，切到历史不该被 loading 挡住。
  // [失败路径] 加载失败时若仍渲染表单，用户会在空草稿上编辑并保存，等于用空值覆盖磁盘文件。
  // [契约] launchDialog 挂在最外层且无条件渲染：它由父层持有，切标签或加载失败都不能卸载它，否则弹窗状态丢失。
  // [资源] 脚本用 CodeBlock 只读渲染，不接编辑器：任何「顺手做成可编辑」都会绕过 onRevise 的校验与落盘流程。
  return (
    <div
      data-testid={TID_WORKFLOW_DETAIL}
      className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col gap-6")}
    >
      <SettingsBreadcrumbReporter items={[{ label: name }]} onSectionSelect={onBack} />

      <SavedWorkflowDetailHeader
        name={name}
        projectLabel={projectLabel}
        description={description}
        entry={entry}
        busy={busy}
        onRun={onRun}
        onRevise={onRevise}
        onCopyPath={onCopyPath}
        onMove={onMove}
        onDelete={onDelete}
      />

      {/* ⚠ 术语：这里的「产物」是脚本经 `artifact.*` 交付给用户的产出，不是脚本的顶层返回值。 */}
      {latestArtifactRun?.artifacts === undefined ? null : (
        <div className="flex flex-wrap items-center gap-2" data-testid="workflow-detail-artifacts">
          <span className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "workflows.hub.artifacts.latest" })}
          </span>
          <SavedWorkflowArtifactChips
            artifacts={latestArtifactRun.artifacts}
            size="md"
            {...(onOpenArtifact === undefined || !latestArtifactRun.parentSessionId
              ? {}
              : {
                  onOpenArtifact: (artifactId: string) =>
                    onOpenArtifact(latestArtifactRun, artifactId),
                })}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div data-testid={TID_WORKFLOW_DETAIL_TAB}>
          <SettingsSegmentedTabs
            value={tab}
            items={[
              {
                value: "definition",
                label: intl.formatMessage({ id: "workflows.hub.detail.tab.definition" }),
              },
              {
                value: "history",
                label:
                  `${intl.formatMessage({ id: "workflows.hub.detail.tab.history" })} ${runs.length > 0 ? runs.length : ""}`.trim(),
              },
            ]}
            onValueChange={setTab}
          />
        </div>
        {path ? (
          <div className="flex min-w-0 items-center gap-1 text-foreground-subtle">
            <span className="min-w-0 truncate font-mono text-ui-sm" title={path}>
              {path}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "workflows.hub.detail.copyPath" })}
              onClick={onCopyPath}
            >
              <Copy className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>

      {tab === "history" ? (
        <SavedWorkflowRunHistory
          runs={runs}
          now={now}
          canOpenRun={canOpenRun}
          onOpenRun={onOpenRun}
          onOpenArtifact={onOpenArtifact}
          resolveRunProject={resolveRunProject}
        />
      ) : loadState.status === "loading" ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : loadState.status === "failed" ? (
        <p className="text-ui-base text-destructive">
          {loadState.reason === "not_found"
            ? intl.formatMessage({ id: "workflows.hub.detail.notFound" })
            : intl.formatMessage(
                { id: "workflows.hub.detail.loadError" },
                {
                  reason:
                    loadState.reason === "invalid_name" ||
                    loadState.reason === "parse_error" ||
                    loadState.reason === "read_error"
                      ? intl.formatMessage({ id: `workflows.hub.reason.${loadState.reason}` })
                      : loadState.reason,
                },
              )}
        </p>
      ) : detail && draft ? (
        <>
          <SavedWorkflowMetaForm
            draft={draft}
            rowErrors={rowErrors}
            descriptionError={descriptionError}
            dirty={dirty}
            saving={saving}
            onDescriptionChange={(value) => {
              setDescriptionError(false);
              updateDraft({ description: value });
            }}
            onWhenToUseChange={(value) => updateDraft({ whenToUse: value })}
            onRowChange={updateRow}
            onRowAdd={addRow}
            onRowRemove={removeRow}
            onDiscard={discard}
            onSave={() => void save()}
          />

          <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "workflows.hub.detail.script" })}
              </h2>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "workflows.hub.detail.script.note" })}
              </p>
            </div>
            <div
              data-testid={TID_WORKFLOW_DETAIL_SCRIPT}
              className="overflow-hidden rounded-lg border border-border bg-surface"
            >
              <div className="flex h-8 items-center justify-between border-b border-border px-3">
                <span className="font-mono text-ui-sm text-foreground-subtle">
                  {`${name}.dwf.ts · TypeScript`}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({ id: "workflows.hub.detail.script.copy" })}
                  onClick={copyScript}
                >
                  <Copy className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
              <div className="max-h-[480px] overflow-auto">
                <CodeBlock code={detail.script} language="typescript" />
              </div>
            </div>
          </section>
        </>
      ) : null}
      {launchDialog}
    </div>
  );
}
