// INV-01 [状态所有权] 展开态 open 与名册门 listed 都是本组件局部集合，宿主只读不写；守住位置：两处 useState 与 toggle、toggleListed；改错故障：宿主另存一份展开态后，落点滚不到节头。
// INV-02 [并发] runningKey 用空字符拼接运行站 id，runningIds 只依赖该串；守住位置：runningKey 的 filter、map、join 与 useMemo 依赖；改错故障：每轮投影都重建数组，effect 反复并入，用户折叠被不断覆盖。
// INV-03 [事务] 自动展开只做并集且命中时返回原引用；守住位置：setOpen 回调里的 every 判定与三元返回；改错故障：每次返回新 Set 会多一轮渲染，折叠正在跑的站被立即弹开。
// INV-04 [事务] 一次落点只落一次，键含 openedAt；守住位置：landing effect 首行对 landedOnceRef 的比较与提前返回；改错故障：父级每次重渲染都重新展开并滚顶，用户滚走会被拽回。
// INV-05 [资源] 落点高亮定时器必须在 cleanup 清除；守住位置：LANDING_MS 的 setTimeout 与返回的 clearTimeout；改错故障：连续点两个站时旧定时器提前撤掉新落点的亮色。
// INV-06 [并发] 定时器回调只在键仍匹配时清空 landed；守住位置：setLanded 回调里的键比较；改错故障：快速连点时后一个落点被前一次的回调误清，亮色闪一下就消失。
// INV-07 [事务] 滚动必须等展开提交后再执行；守住位置：依赖 landed 的第二个 effect 与按 data-phase-id 找节；改错故障：合并进 landing effect 同帧找不到节头，落点静默失效。
// INV-08 [失败路径] 滚前对根、节、节头三层判空并检查能力；守住位置：滚动 effect 的三个提前返回；改错故障：无 DOM 或节点缺失时抛错，打断同批状态提交。
// INV-09 [无障碍] 减少动效偏好下滚动改为 auto；守住位置：reduced 判定与 scrollIntoView 的 behavior 三元；改错故障：强制平滑滚动违背系统偏好，也让落点定位更慢。
// INV-10 [资源] 等待计时只在有人等时存在；守住位置：hasQuestions 与 QUESTION_TICK_MS 的 interval effect 及其清理；改错故障：空闲会话被无谓唤醒，或等待中停表让时长冻住。
// INV-11 [契约] 计时条件同时覆盖提问与补全留白；守住位置：hasQuestions 里的长度判定与 hole 状态判定；改错故障：只判提问时，等待补全的节体时长停在打开那一刻。
// INV-12 [契约] 问题键在站点或序号缺一时返回 undefined；守住位置：questionKey 的三元；改错故障：拼出带 undefined 的键，问题被挂到不存在的药丸，永远不显示。
// INV-13 [契约] 药丸键必须与药丸侧同源；守住位置：pillKey 对 pillInstanceKey 的别名；改错故障：本地另写键格式会让 attachedKeys 全部对不上，所有问题误判成孤儿。
// INV-14 [契约] 孤儿问题是键缺失或键未被任何站药丸接住；守住位置：attachedKeys 汇总与 orphanQuestions 过滤；改错故障：判据放宽会把已挂载问题重复显示在末尾板块。
// INV-15 [契约] 落点同时展开并开门；守住位置：landing effect 中 setOpen 与 setListed 两个并集分支；改错故障：只展开不开门时，名册站落点是空的，名单要点两下才出现。
// INV-16 [契约] 展开状态下右列不画头像串；守住位置：节头里 expanded 为真返回 null 的分支与 RosterMeter、AvatarCluster 的二选一；改错故障：折叠提示与体内药丸重复，还把分数和轮次挤掉。
// INV-17 [契约] 落点换 key 重挂节头以重放动画；守住位置：节头 button 的 key 三元与 wf-landed 类；改错故障：固定 key 时同一站再落不重播，只有底色变化。
// INV-18 [失败路径] 节在脊线布局中缺位时回落到空轨道；守住位置：section 取值的三元与默认 rails 空数组；改错故障：直接下标取 undefined 会让整列在渲染期抛错，后面所有站都不显示。
//
// 模块职责：运行详情页阶段脊线的唯一渲染入口，把 WorkflowTimelineModel 的站投影成可展开的竖直列表，聚合名册、留白、补全框与待答问题。
// 状态所有权：展开态与名册门态是本组件局部 useState；模型、问题与落点由宿主传入，本组件不写回任何运行事实。
// 阅读顺序：先看键与常量，再看待展开、落点、计时三个 effect，接着问题分组与脊线布局，最后是节头、名册分支与孤儿问题板块。
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CircleHelpIcon } from "lucide-react";
import type { WorkflowRunPendingQuestion, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { phaseDisplayName } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import {
  ROSTER_PINS_PANE,
  pillInstanceKey,
  rosterMore,
  rosterRestCounts,
  rosterRoll,
  stationRosterOf,
} from "@/components/workflow-timeline/roster-model.js";
import { WorkflowAgentPill } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { WorkflowMoreRow } from "@/components/workflow-timeline/WorkflowMoreRow.js";
import { WorkflowRoll } from "@/components/workflow-timeline/WorkflowRoll.js";
import { RosterMeter } from "@/components/workflow-timeline/WorkflowRosterParts.js";
import { WorkflowRunQuestionRow } from "@/app-shell/WorkflowRunQuestionRow.js";
import {
  AvatarCluster,
  Rounds,
  SpineJointRow,
  SpineLamp,
  SpinePieces,
  useWorkflowActorModelLabels,
} from "@/app-shell/WorkflowRunSpineParts.js";
import { phasePillRenderers } from "@/app-shell/WorkflowRunPhasePills.js";
import { spineLayout } from "@/app-shell/workflowRunSpine.js";
import {
  FillHeadingRow,
  HoleWaitingBody,
  SpineHoleLamp,
} from "@/app-shell/WorkflowRunHoleParts.js";
import { useSpineFillFrames } from "@/app-shell/WorkflowRunFillFrames.js";
import { HoleFillMark } from "@/components/workflow-timeline/WorkflowHoleParts.js";
import type { WorkflowActorInstance } from "@/app-shell/workflowRunPanel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 运行详情页的脊线：卡上的横向时间线在
 * 这里竖着读。一根轨道从上到下贴着左缘，阶段是轨道上的灯，轨道的墨迹随控制流经过而变深、在进入
 * 正在运行的阶段那一段行进；子代理是挂在灯右侧、拉满本列的药丸（与卡上同一枚），升级问题挂在
 * 提问者那一行下面，再退一步。**不画回边**：那是卡的事，节头上的 `⟳ n` 已经说了这站跑过几轮。
 *
 * 轨道段与灯的墨迹、状态都读 `buildWorkflowTimeline` 的同一个模型（不变式 1：一个模型，三处
 * 消费）。轨道段只在模型有 `rails` 的相邻两站之间画——与卡同一条规则，相邻无边留空。
 *
 * 并行的阶段（模型的**带**）在这里读作提交图：分支轨道在主轨右边，灯落在自己的轨道上，而节头、
 * 药丸与问题一律从同一条文字列起（`39 + gutter`）——轨道与文字不共用一列。分叉与汇合各占两节
 * 之间的一行接头，只在前驱 / 汇合站存在时才有。每一节要画哪些竖轨、哪里挂接头由
 * `workflowRunSpine.ts` 算好，这里只照着摆。**不画回边**（同上）。
 *
 * 折起的阶段在节头带一串头像（至多 3 枚 + `+n`）：折叠不能让「谁在这一站」不可见。
 * 正在运行的阶段自己展开：**每一个**正在跑的站都开（带里两条轨道可以同时在跑），已展开的不动。
 *
 * 参与者过了阈值的站是名册（追记「阶段名册」、「一扇门与一卷名单」）：钉 5 枚药丸（asking → running →
 * failed → 补位），第六枚是门（关着带其余人的计数行），门后是其余人的名单——每人一次、按状态分组、
 * 两列 `row` 药丸；折叠节头上头像串换成迷你量条。界上列不出来的子代理（`station.unlisted`）进门的
 * 人数、计数行与量条，却没有行可落，所以名单末尾用一行淡字交代这个差额。
 *
 * 落点：卡上「还有 n 个」那一行或站头把站 id 交给宿主，tab 带着
 * `focusPhaseId` 到这里——展开这一站、把门打开、节头滚到顶、底色亮一下再退回。一次打开只落一次
 * （键含 openedAt，同一站再点一次会再落）；之后用户滚走不追。
 */
// [资源] 两个常量只服务本文件的时序：等待计时 30 s 一跳，落点高亮总时长 1200 ms（400 亮 + 800 退）。
// [权衡] 30 s 足够让「等了多久」保持可读，又不至于在长跑里制造每秒重渲染。
// [资源] LANDING_MS 与样式表 .wf-landed 的时长必须同源，改一处就要改另一处。
// [失败路径] 若 LANDING_MS 短于退场动画，定时器会在动画未完时卸载亮色，表现成硬切。
const QUESTION_TICK_MS = 30_000;
/** 落点亮一下的时长：持 400 ms 再用 800 ms 退回（`.wf-landed`）。 */
const LANDING_MS = 1200;

function questionKey(question: WorkflowRunPendingQuestion): string | undefined {
  return question.actorSiteId === undefined || question.actorOrdinal === undefined
    ? undefined
    : `${question.actorSiteId}@${question.actorOrdinal}`;
}

const pillKey = pillInstanceKey;

export const WorkflowRunPhaseList = memo(function WorkflowRunPhaseList({
  graph,
  landing,
  model,
  onOpenActor,
  onOpenWorkspace,
  pendingQuestions,
  run,
  subagentModelProviderName,
}: {
  graph: WorkflowCausalityGraphData;
  model: WorkflowTimelineModel;
  run: WorkflowRunState | undefined;
  pendingQuestions: readonly WorkflowRunPendingQuestion[];
  /** 开 actor transcript tab（没有会话的槽位开占位）。缺席即行不可点——回调的存在本身就是门控。 */
  onOpenActor?: (instance: WorkflowActorInstance) => void;
  /** 开脚本 transcript tab、落到这一站；缺席即脚本行不可点。 */
  onOpenWorkspace?: (phaseId: string) => void;
  /** 落点：`key` 每次打开都不同（`phaseId@openedAt`），同一站再点一次也再落。 */
  landing?: { phaseId: string; key: string };
  /** providerId → 模型清单里的 provider 名（子代理自己的模型取名用，与摘要行同一个来源）。 */
  subagentModelProviderName?: (providerId: string) => string | undefined;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  // persona 点名了模型的子代理：行尾说模型名，tooltip 带规范串（presentation.md「The spine」）。
  const actorModels = useWorkflowActorModelLabels(run?.actors, subagentModelProviderName);
  // 正在运行的站自己展开——带里两条轨道可以同时在跑，**每一个**都要开，不只最右那个。
  // 用一个稳定的键记住这一组 id：投影每动一次模型都换身份，但这一组通常不变。
  // [状态所有权] 展开集合 open 只在本组件持有，初值取首帧正在运行的站，宿主无法直接改写。
  // [并发] runningKey 以空字符拼接运行站 id，把每轮新投影收敛成同一个字符串。
  // [并发] runningIds 依赖 runningKey 而非 model，模型身份每换一次都不会重建数组。
  // [契约] 自动展开取并集：已含全部运行站时返回原集合引用，React 据此跳过重渲染。
  // [权衡] 并集意味着用户折叠运行中的站不会被立即弹开，只有运行集合变化才重新并入。
  // [失败路径] 若把 every 判定写成 some，任一站在集合里就整体跳过，新起的并行站不会自动展开。
  const runningKey = model.stations
    .filter((station) => station.status === "running")
    .map((station) => station.id)
    .join("\u0000");
  const runningIds = useMemo(
    () => (runningKey === "" ? [] : runningKey.split("\u0000")),
    [runningKey],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(runningIds));
  useEffect(() => {
    setOpen((previous) =>
      runningIds.every((id) => previous.has(id)) ? previous : new Set([...previous, ...runningIds]),
    );
  }, [runningIds]);
  const toggle = useCallback((id: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // 名册站的门：开着即列出名单，清单的局部状态，按站记。
  // [状态所有权] 名册门 listed 与展开 open 是两份独立集合：开门不等于展开，展开也不自动开门。
  // [契约] 只有落点 effect 会同时写入两者，用户操作分别走 toggle 与 toggleListed。
  // [资源] 两个切换都复制旧集合再增删，绝不原地修改，保证引用变化能被 React 看见。
  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleListed = useCallback((id: string) => {
    setListed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 落点：展开 + 开门 + 亮一下；滚动在下一次提交之后（那一节得先展开才有节头可滚）。
  // `landed` 按落点的键记（不是按站）：同一站再落一次，键变了、滚动与亮一下就都再来一遍。
  // [事务] 落点去重靠 landedOnceRef 与 landing.key 比较，提前返回保证一次打开只落一次。
  // [契约] 键含 openedAt，同一站再次点击时键不同，展开、开门、滚动与亮色会整套重来。
  // [状态所有权] landed 只保存当前落点，滚动 effect 以它为唯一触发源。
  // [资源] 高亮定时器在 cleanup 中清除，组件卸载或键变化都不会留下悬挂回调。
  // [并发] 定时器回调只在 current 仍是本次键时清空 landed，旧定时器不会撤掉新落点。
  // [事务] 滚动放在依赖 landed 的第二个 effect，等展开提交、节头进 DOM 之后再找节点。
  // [失败路径] 找节头前对根、节、按钮三层判空，折叠容器与无 DOM 环境下静默放弃滚动。
  // [无障碍] 系统偏好减少动效时滚动改为 auto，其余情况才用 smooth。
  // [权衡] 只滚到节头 block 取 start，不滚体内药丸，避免一次落点把长名单拉进视口。
  const rootRef = useRef<HTMLDivElement>(null);
  const landedOnceRef = useRef<string | undefined>(undefined);
  const [landed, setLanded] = useState<{ phaseId: string; key: string } | undefined>(undefined);
  useEffect(() => {
    if (landing === undefined || landedOnceRef.current === landing.key) return undefined;
    landedOnceRef.current = landing.key;
    const { phaseId } = landing;
    setOpen((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setListed((previous) => (previous.has(phaseId) ? previous : new Set([...previous, phaseId])));
    setLanded(landing);
    const timer = setTimeout(
      () => setLanded((current) => (current?.key === landing.key ? undefined : current)),
      LANDING_MS,
    );
    return () => clearTimeout(timer);
  }, [landing]);
  useEffect(() => {
    if (landed === undefined) return;
    const root = rootRef.current;
    if (root === null) return;
    const section = [...root.querySelectorAll<HTMLElement>("[data-phase-id]")].find(
      (candidate) => candidate.getAttribute("data-phase-id") === landed.phaseId,
    );
    const head = section?.querySelector<HTMLElement>('[data-testid="workflow-run-phase-toggle"]');
    if (head === undefined || head === null || typeof head.scrollIntoView !== "function") return;
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    head.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, [landed]);

  // 等待时长要自己走：一个在等答案（或等补全）的 run **恰恰不发事件**。定时器只在有人在等时存在。
  // [资源] now 只为等待时长服务，定时器只在 hasQuestions 为真时创建。
  // [并发] 一个在等答案或等补全的 run 恰恰不发事件，必须靠 30 s 一跳自行推进。
  // [契约] hasQuestions 同时看提问数与留白的 waiting 状态，任一成立都要走表。
  // [失败路径] 只判提问会让等待补全的节体停在打开那一刻的时长上。
  // [资源] effect 返回 clearInterval，条件转假时立刻停表，不在空闲会话里空转。
  // [事务] 进入等待时先立刻刷新一次 now 再交给定时器，首帧不显示旧时间。
  // [契约] 等待中的留白与运行中的站同一条规则：自己展开，用户不必先点开才看到计时。
  // [并发] waitingHoleKey 与 runningKey 同样用拼接串收敛，避免每轮投影重复并入。
  const [now, setNow] = useState(() => Date.now());
  const hasQuestions =
    pendingQuestions.length > 0 ||
    model.stations.some((station) => station.hole?.state === "waiting");
  useEffect(() => {
    if (!hasQuestions) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), QUESTION_TICK_MS);
    return () => clearInterval(timer);
  }, [hasQuestions]);
  // 正在等补全的留白自己展开（与正在运行的站同一条规则：它是当前站）。
  const waitingHoleKey = model.stations
    .filter((station) => station.hole?.state === "waiting")
    .map((station) => station.id)
    .join("\u0000");
  useEffect(() => {
    if (waitingHoleKey === "") return;
    const ids = waitingHoleKey.split("\u0000");
    setOpen((previous) =>
      ids.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ids]),
    );
  }, [waitingHoleKey]);

  // [契约] 问题按 questionKey 分组进 Map，缺站点或序号的项直接跳过，不落进任何药丸。
  // [契约] attachedKeys 由所有站的药丸键汇总，是「这枚问题有人接」的唯一判据。
  // [契约] 孤儿问题是键缺失或键不在 attachedKeys 中，两条件缺一都会漏显示。
  // [权衡] 分组走 memo 而孤儿过滤每次重算，前者结构重、后者只做一次集合判定。
  // [失败路径] 若把已挂载判据写成「该站有提问」，被名册收起的药丸会让问题误判成孤儿。
  // [失败路径] 孤儿板块在数量为零时不渲染，条件写反会留下一条没有内容的标题行。
  // [契约] 孤儿行用 showAsker 标出提问者，它们的药丸不在任何一节里，必须自带归属。
  const questionsByInstance = useMemo(() => {
    const byKey = new Map<string, WorkflowRunPendingQuestion[]>();
    for (const question of pendingQuestions) {
      const key = questionKey(question);
      if (key === undefined) continue;
      const list = byKey.get(key) ?? [];
      list.push(question);
      byKey.set(key, list);
    }
    return byKey;
  }, [pendingQuestions]);
  const attachedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const station of model.stations) {
      for (const pill of station.pills) {
        const key = pillKey(pill);
        if (key !== undefined) keys.add(key);
      }
    }
    return keys;
  }, [model]);
  const orphanQuestions = pendingQuestions.filter((question) => {
    const key = questionKey(question);
    return key === undefined || !attachedKeys.has(key);
  });
  // 每一节要画的竖轨与节间的接头行（`workflowRunSpine.ts`）；文字列整根脊线共用一个左缘。
  // [契约] 竖轨与节间接头全部由 spineLayout 一次算好，JSX 只按下标取，渲染期不再推导位置。
  // [契约] 文字列左缘固定为 39 加 gutter，整根脊线共用一个值，轨道与文字不共用列。
  // [权衡] gutter 为零时不写 paddingLeft 而不是写 0，省掉一条无意义的内联样式。
  // [失败路径] 某节在 spine.sections 中缺位时回落到空轨道，宁可少画一段也不抛错中断整列。
  const spine = spineLayout(model);
  // 补全的框（WorkflowRunFillFrames.tsx）：头（标题行 / 笔标）上悬停或键盘焦点时画出那一个。
  const fillFrames = useSpineFillFrames(rootRef, model);
  const textColumn = spine.gutter === 0 ? undefined : { paddingLeft: 39 + spine.gutter };
  // 药丸的命名、打开与尾槽（WorkflowRunPhasePills.tsx）。
  // [资源] 补全框由 useSpineFillFrames 挂在根引用上，悬停与键盘焦点共用同一套处理。
  // [契约] 药丸的命名、打开与尾槽统一由 phasePillRenderers 产出，本文件不重复实现。
  // [契约] 两个可选回调用条件展开传入，缺席时对应行不可点，回调存在本身就是门控。
  const { nameOf, pillProps, renderPill } = phasePillRenderers({
    actorModels,
    format,
    graph,
    model,
    now,
    questionsByInstance,
    run,
    ...(onOpenActor === undefined ? {} : { onOpenActor }),
    ...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace }),
  });

  return (
    <div
      className="wf-motion relative flex min-h-0 flex-1 flex-col overflow-auto pb-3 pt-2.5"
      data-testid="workflow-run-phases"
      ref={rootRef}
      {...fillFrames.handlers}
    >
      {fillFrames.frames}
      {model.stations.map((station, index) => {
        const expanded = open.has(station.id);
        const name = phaseDisplayName(station.naming, format);
        const status = station.status ?? "pending";
        const pending = status === "pending";
        const section = spine.sections[index] ?? { rails: [] };
        const roster = stationRosterOf(station, ROSTER_PINS_PANE);
        // 留白（docs/dynamic-workflow/presentation.md「Holes on the timeline」的「The pane」）：节头换虚线灯；
        // 等待时节体说等了多久。有阶段的补全在它写下的第一节前多一行标题；那几节不缩进（嵌套由框说出）。
        const hole = station.hole;
        // 同起于这一节的补全各有一行标题，外层在前（模型的次序）：内层的框从它自己的标题量起。
        const headings = (model.fills ?? []).filter((fill) => fill.from === index);
        const column = textColumn;
        return (
          <Fragment key={station.id}>
            <SpineJointRow joint={section.fork} kind="fork" pitch={spine.pitch} />
            {headings.map((heading) => (
              <FillHeadingRow
                fill={heading}
                fresh={fillFrames.fresh.has(heading.holeId)}
                key={heading.holeId}
                on={fillFrames.active === heading.holeId}
                onSelect={() => toggle(station.id)}
                textColumn={textColumn}
              />
            ))}
            <section
              className="relative"
              data-phase-fill={station.fill}
              data-phase-hole={hole?.state}
              data-phase-id={station.id}
              data-phase-landed={landed?.phaseId === station.id ? "true" : undefined}
              data-phase-open={expanded ? "true" : "false"}
              data-phase-status={status}
              data-phase-track={station.track}
              data-testid="workflow-run-phase"
            >
              <SpinePieces pitch={spine.pitch} section={section} />
              <button
                aria-expanded={expanded}
                aria-label={intl.formatMessage(
                  {
                    id: expanded
                      ? "chat.toolCall.workflow.run.phase.collapse"
                      : "chat.toolCall.workflow.run.phase.expand",
                  },
                  { name },
                )}
                className={cn(
                  "wf-station-open relative flex h-9 w-full items-center gap-2 pl-[39px] pr-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40",
                  landed?.phaseId === station.id && "wf-landed",
                )}
                data-testid="workflow-run-phase-toggle"
                // 再落时换 key 重挂节头：同一个类名不会让 CSS 动画重来。
                key={landed?.phaseId === station.id ? landed.key : "head"}
                onClick={() => toggle(station.id)}
                style={column}
                type="button"
              >
                {hole !== undefined && hole.state !== "filled" ? (
                  <SpineHoleLamp hole={hole} pitch={spine.pitch} track={station.track} />
                ) : (
                  <SpineLamp pitch={spine.pitch} status={status} track={station.track} />
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-ui-base",
                    pending ? "text-foreground-subtle" : "font-medium text-foreground",
                  )}
                >
                  {name}
                </span>
                {hole?.state === "filled" ? <HoleFillMark holeId={hole.siteId} /> : null}
                <span className="flex shrink-0 items-center gap-2.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
                  {expanded ? null : roster !== undefined ? (
                    <RosterMeter counts={roster.counts} mini />
                  ) : (
                    <AvatarCluster nameOf={nameOf} pills={station.pills} />
                  )}
                  {station.fraction === undefined ? null : (
                    <span data-testid="workflow-run-phase-fraction">
                      {station.fraction.settled}/{station.fraction.observed}
                    </span>
                  )}
                  <Rounds station={station} />
                  <ChevronRightIcon
                    aria-hidden
                    className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                  />
                </span>
              </button>
              {expanded ? (
                <div
                  className="wf-unfold flex flex-col gap-1.5 pb-3 pl-[39px] pr-3 pt-0.5"
                  data-testid="workflow-run-phase-body"
                  style={column}
                >
                  {hole?.state === "waiting" ? <HoleWaitingBody hole={hole} now={now} /> : null}
                  {roster === undefined ? (
                    station.pills.map(renderPill)
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5" data-testid="workflow-roster-pins">
                        {roster.pinned.map(renderPill)}
                      </div>
                      <WorkflowMoreRow
                        door={{
                          open: listed.has(station.id),
                          tally: rosterRestCounts(roster),
                        }}
                        more={rosterMore(roster)}
                        onOpen={() => toggleListed(station.id)}
                      />
                      {listed.has(station.id) ? (
                        <WorkflowRoll
                          groups={rosterRoll(roster)}
                          unlisted={roster.unlisted.actors}
                          renderRow={(pill, enterDelayMs) => (
                            <WorkflowAgentPill
                              enterDelayMs={enterDelayMs}
                              key={pill.key}
                              size="row"
                              {...pillProps(pill)}
                            >
                              {/* 第六个及以后的提问者落在名单里：尾槽前一枚 ?，问题本身不在这里重复。 */}
                              {pill.asking === true ? (
                                <CircleHelpIcon
                                  aria-hidden
                                  className="size-3 shrink-0 text-warning"
                                  data-testid="workflow-roll-asking"
                                />
                              ) : null}
                            </WorkflowAgentPill>
                          )}
                        />
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </section>
            <SpineJointRow joint={section.merge} kind="merge" pitch={spine.pitch} />
          </Fragment>
        );
      })}
      {orphanQuestions.length === 0 ? null : (
        <div
          className="flex flex-col gap-1 pl-[39px] pr-3 pt-2"
          data-testid="workflow-run-orphan-questions"
          style={textColumn}
        >
          <span className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.questions.title" })}
          </span>
          {orphanQuestions.map((question) => (
            <WorkflowRunQuestionRow key={question.qid} now={now} question={question} showAsker />
          ))}
        </div>
      )}
    </div>
  );
});
