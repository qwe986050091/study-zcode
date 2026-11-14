import type { ScriptLoc } from "../compiler/compile.js";
import type { TaintOcc } from "./domain.js";
import type { OrderTrace } from "./causality-order.js";
import type { NamePattern } from "./types.js";

/**
 * The analysis core: the single, self-contained artifact one interpretation of a
 * workflow script produces. It carries the
 * data-dependency half (the taint facts) AND the temporal half (the ordering trace) in
 * one value, and every graph the analyzer serves — site graph, causality graph, actor
 * graph — is a pure projection of it.
 *
 * The design principle is **no position dependence**: anything that needs raw source
 * offsets or the TypeScript checker is resolved when the core is minted
 * (interpret.ts), never by a projection. That is what "projections never look at the
 * code again" means mechanically, and it is checkable: a projection module must not
 * import `typescript`.
 *
 *  - `within` containment (site lexically inside a promoted fan-out body) is resolved
 *    onto each site entry here — the projection reads a string, not a span;
 *  - fan-out ids are FINAL (`fan-out#N`); the taint pass's provisional `fan-out@order`
 *    vocabulary dies at minting, including inside every occurrence and type key;
 *  - artifact types are materialized strings (the checker's answers), keyed by final id.
 *
 * `ScriptLoc` (line:column) fields remain — they are rendering data, not AST access.
 */

/** An `ask` site, AST-free. `within` is the enclosing promoted fan-out, when any. */
// ask 站点（无 AST 依赖）：id 为最终站点 id，order 是源码顺序，label 是 sink 的展示名，
// labelPattern 是可选的 head/tail 版面约束，loc 是 1 基行列，within 是所属已提升 fan-out。
// 字段契约：所有字段由 mintCore 一次写定，投影只读；within 缺席表示不在任何 fan-out 体内。
export interface CoreAskSite {
  id: string;
  order: number;
  label: string;
  labelPattern?: NamePattern;
  loc: ScriptLoc;
  within?: string;
}

// world-read / join 的公共站点形状：id、order、label、loc、within 口径与 ask 相同，
// 没有 labelPattern（它们不参与名称版面约束）。
/** A world-read or join site, AST-free. */
export interface CoreSimpleSite {
  id: string;
  order: number;
  label: string;
  loc: ScriptLoc;
  within?: string;
}

// agent() 站点：name / namePattern 是可选的展示名与版面约束；actor 无产物类型，
// 因此不参与 types.siteType；within 语义同其他站点。
/** An `agent()` site, AST-free. */
export interface CoreActorSite {
  id: string;
  order: number;
  loc: ScriptLoc;
  name?: string;
  namePattern?: NamePattern;
  within?: string;
}

/**
 * A PROMOTED fan-out, under its final `fan-out#N` id (source order). Non-promoted
 * iteration candidates are not part of the core — they are graph nodes in nothing.
 */
// 已提升的 fan-out：id 已是最终 `fan-out#N`（源码顺序），label 固定为 "fan-out"，
// cardinality 只在"可静态数出元素个数"时出现（无展开数组字面量 / 从未被写过的 const 字面量），
// 其余情况缺席（不是 0）——投影按"未知基数"渲染。within 指外层 fan-out（自身不计）。
export interface CoreFanoutSite {
  id: string;
  order: number;
  label: string;
  loc: ScriptLoc;
  within?: string;
  /**
   * 字面量基数：被迭代的是无展开的数组字面量
   * 或从未被写入的 `const` 字面量绑定时的元素个数；其余缺席。铸造期算好，投影只读。
   */
  cardinality?: number;
}

/**
 * An OPEN `hole<T>()` site, AST-free (docs/analysis.md「Sites」). A filled hole is not a
 * step and is not listed here — it survives only as a phase in the trace.
 */
// 开放的 hole<T>() 站点：已补全的留白不是步骤、不进这张表（只作为 trace 的阶段存在）。
// fill 指"包住本留白"的那个已补全留白（顶层时缺席）；name 是字面名（也是阶段名，规则 9012
// 保证唯一）；type 是作者写的类型实参拼写（不是解析后的类型）；tail 仅尾调用形式。
export interface CoreHoleSite {
  id: string;
  /** The filled hole whose body holds this hole (docs/analysis.md「Sites」); absent at the top level. */
  fill?: string;
  order: number;
  /** The hole's literal name (its phase name; unique by rule 9012). */
  name: string;
  /** The author's spelling of the type argument (`Plan`), the contract the fill is checked against. */
  type: string;
  loc: ScriptLoc;
  /** The call is the (awaited) operand of a top-level `return`: the script's end is open. */
  tail?: true;
  within?: string;
}

// 全部站点按类别分表（每张表内按源码顺序）。holes 只含开放留白；actors 不是产物来源，
// 但仍是图节点（车道/上下文边的锚点）。集合为空时是空数组而非 undefined。
export interface CoreSites {
  asks: CoreAskSite[];
  worldReads: CoreSimpleSite[];
  joins: CoreSimpleSite[];
  actors: CoreActorSite[];
  fanouts: CoreFanoutSite[];
  /** Open holes, source order (see {@link CoreHoleSite}). */
  holes: CoreHoleSite[];
}

/**
 * The edge-bearing taint facts, exactly {@link TaintFacts} minus `promoted` (folded
 * into {@link CoreSites.fanouts}) — with every occurrence site and every `fanoutIn`
 * key already renamed to final ids.
 */
// 带边的 taint 事实：key 是 sink 站点 id（已是最终 id），value 是到达该 sink 的 occurrence
// 列表（保持发射顺序，不排序）。每个 occurrence 的 site 也已重命名；空集合不写 key 时
// 语义是"没有数据流入"，与"key 存在但数组为空"等价（上游不会产生后者）。
export interface CoreFacts {
  askData: Map<string, TaintOcc[]>;
  askActor: Map<string, TaintOcc[]>;
  worldReadData: Map<string, TaintOcc[]>;
  joinIn: Map<string, TaintOcc[]>;
  fanoutIn: Map<string, TaintOcc[]>;
  /** Artifact occurrences reaching each open hole's prompt. */
  holeData: Map<string, TaintOcc[]>;
  returnData: TaintOcc[];
}

/** The checker's answers, materialized. Keys are final site ids. */
// checker 答案的物化：siteType 是"整值产物类型"字符串（无类型时缺 key）；joinPortTypes
// 只对"静态数组字面量的 join"出现，数组下标即端口，元素为 undefined 表示该端口未知。
// 类型文本原样保留（渲染/比较口径与编译期一致），投影不重新推导。
export interface CoreTypes {
  /** Whole-value artifact type per producer site. */
  siteType: Map<string, string>;
  /** Per-element awaited types of a join over a static array literal. */
  joinPortTypes: Map<string, (string | undefined)[]>;
}

// 分析核心：一次解释所得的全部事实。sites/facts/types 无位置依赖、id 已定稿；
// trace 是原始时序内容（不做排序，事件顺序本身就是语义），供因果/控制流/阶段投影消费。
// 不变量：core 一经铸造即不可变（下游只读），且每种图都是 core 的纯函数投影。
export interface AnalysisCore {
  sites: CoreSites;
  facts: CoreFacts;
  /** The raw temporal trace — issue/settle/spawn events, regions, controls, phases. */
  trace: OrderTrace;
  types: CoreTypes;
}

/**
 * Site-id vocabulary: is this label an actor site? (Actor labels never make data edges.)
 *
 * 修复原因：留白函数体里的站点带留白 id 的前缀（`hole#21b40fca/actor#1`，docs/analysis.md「Sites」），
 * 原先的 `startsWith("actor#")` 认不出它们，于是补全体内的 ask 全部解析不到 receiver、落到
 * `unknown` 车道。按**最后一段**判种类。
 */
// 判断站点 id 是否是 actor 站点：按 id 的最后一段匹配 `actor#`，因此留白体里带
// `hole#.../actor#1` 前缀的站点也能认出（docs/analysis.md「Sites」）。
// actor 标签不产生数据边；本函数是纯字符串判定，不访问 checker。
export function isActorSite(site: string): boolean {
  return /(^|\/)actor#/.test(site);
}

/** Quote a string field: embedded `"` escaped as `\"` (same rule as serialize.ts). */
function quote(text: string): string {
  return `"${text.replace(/"/g, '\\"')}"`;
}

function renderPattern(pattern: NamePattern | undefined): string {
  if (pattern === undefined) return "";
  let out = "";
  if (pattern.head !== undefined) out += ` head=${quote(pattern.head)}`;
  if (pattern.tail !== undefined) out += ` tail=${quote(pattern.tail)}`;
  return out;
}

function at(loc: ScriptLoc): string {
  return `@${loc.line}:${loc.column}`;
}

/**
 * Canonical, deterministic text form of the core — its golden and debugging surface,
 * fourth sibling of the three graph serializers. Grammar, by fixed section order:
 *
 *   ask ask#1 "scanner" @3:24 order=1 within=fan-out#1 type="Flaky"
 *   world-read world-read#1 "glob src" @1:20 order=0
 *   join join#1 "join" @4:9 order=3 ports="A",-,"B"
 *   actor actor#1 "planner" @2:17 order=2
 *   fan-out fan-out#1 "fan-out" @5:11 order=4 type="Review[]"
 *   hole hole#1 "决定分组" @7:14 order=5 type="Plan" tail
 *   fact ask-data ask#2 <- ask#1 exact
 *   fact ask-actor ask#2 <- actor#1 exact
 *   fact world-read-data world-read#2 <- ask#1 inexact
 *   fact join-in join#1 <- ask#1 exact port=0
 *   fact fan-out-in fan-out#1 <- ask#1 exact
 *   fact hole-data hole#1 <- ask#1 exact
 *   fact return <- ask#2 exact
 *   region seq#1 seq entered
 *   region loop#1 loop parent=seq#1 @3:1 bound=3 label="helper"
 *   region choice#1 choice parent=loop#1 @5:3 entered exhaustive
 *   region choice#2 choice parent=seq#1 @9:1 entered fallthrough
 *   region branch#1 branch parent=choice#1 @5:12
 *   region branch#4 branch parent=seq#1 @20:1 label="onDone" detached
 *   region call#1 call parent=seq#1 @7:15 entered label="helper"
 *   region fanout#1 fanout parent=seq#1 @9:15 label="map" strand
 *   region try#1 try parent=seq#1 @12:1 entered
 *   region attempt#1 attempt parent=try#1 @12:5 entered
 *   region catch#1 catch parent=try#1 @15:3
 *   region finally#1 finally parent=try#1 @18:3 entered
 *   issue ask#1 in=seq#1>loop#1 phase=unphased
 *   settle ask#1,ask#2 in=seq#1
 *   settle ask#4 in=seq#1 joins=fanout#1
 *   settle in=seq#1 joins=call#1
 *   settle maybe ask#3 in=seq#1
 *   spawn actor#1 in=seq#1
 *   mark phase#1 in=seq#1
 *   jump continue loop#1 in=seq#1>loop#1>choice#1>branch#1 phase=phase#1
 *   jump return call#1 in=seq#1>call#1 phase=unphased
 *   jump throw attempt#1 in=seq#1>try#1>attempt#1 phase=unphased
 *   control branch#1 by=ask#1 maybe=ask#2
 *   phase phase#1 "gate" @2:1
 *   phase hole#21b40fca "决定分组" @7:14
 *
 * A `hole` line is an OPEN hole (a filled one is not a step; `tail` marks the tail form and
 * `type=` is the author's spelling of the type argument); `fill=` on a phase names the filled
 * hole whose body wrote it (docs/analysis.md「Sites」).
 *
 * Sites come first in source (`order`) order, kinds interleaved; `type=` carries the
 * materialized artifact type and `ports=` a join's per-port types (`-` = unknown).
 * Fact lines are grouped by kind in the order above; within a kind, by the sink
 * site's source order, occurrences in stored (emission) order. Trace events are NOT
 * sorted — their sequence IS the temporal content; regions/controls/phases follow in
 * creation order. `issue` always carries its phase (`unphased` outside every marker's
 * extent), and a `settle` line carries `maybe` only when the barrier was a may-claim and
 * `joins=` only when it waited for strands (`strand` on the region line marks those). A
 * settle that ONLY joined strands names no step and prints without the step token.
 *
 * The structural regions (`choice` / `call` / `try` / `attempt` / `catch` / `finally`) and
 * the `mark` / `jump` leaves are the control-flow projection's input; the causality projection looks through
 * them. A `jump` names its resolved target region; `throw` targeting the root is uncaught.
 */
// 把 core 渲染成规范的确定性文本（golden/调试口径），段落顺序固定：sites → facts →
// regions → events → controls → phases。空值一律省略字段而不是写空串；字符串字段统一
// 用 quote。注意 trace 事件不排序（顺序就是语义），只有 sites 按 order 排序。
// 纯函数：不缓存、不依赖环境，同样输入必得逐字节相同输出（快照测试的前提）。
export function serializeCore(core: AnalysisCore): string {
  return `${[
    ...renderSites(core),
    ...renderFacts(core.facts),
    ...core.trace.regions.map(
      (region) =>
        `region ${region.id} ${region.kind}` +
        (region.parent === undefined ? "" : ` parent=${region.parent}`) +
        (region.loc === undefined ? "" : ` ${at(region.loc)}`) +
        (region.entered ? " entered" : "") +
        (region.exhaustive ? " exhaustive" : "") +
        (region.fallthrough ? " fallthrough" : "") +
        (region.recursive ? " recursive" : "") +
        (region.detached ? " detached" : "") +
        (region.bound === undefined ? "" : ` bound=${region.bound}`) +
        (region.label === undefined ? "" : ` label=${quote(region.label)}`) +
        (region.strand ? " strand" : ""),
    ),
    ...core.trace.events.map(renderEvent),
    ...core.trace.controls.map(
      (control) =>
        `control ${control.region}` +
        (control.controllers.length > 0 ? ` by=${control.controllers.join(",")}` : "") +
        (control.maybeControllers.length > 0 ? ` maybe=${control.maybeControllers.join(",")}` : ""),
    ),
    ...core.trace.phases.map(
      (phase) =>
        `phase ${phase.id} ${quote(phase.name)} ${at(phase.loc)}` +
        (phase.fill === undefined ? "" : ` fill=${phase.fill}`),
    ),
  ].join("\n")}\n`;
}

// 站点段：六类站点先按各自形状生成行，再按 order 统一排序（同类内稳定，跨类交错）。
// type/ports/within/count 等可选字段为空时整段省略，保证无该特性脚本的输出逐字节不变。
function renderSites(core: AnalysisCore): string[] {
  const typeOf = (id: string): string => {
    const type = core.types.siteType.get(id);
    return type === undefined ? "" : ` type=${quote(type)}`;
  };
  const withinOf = (within: string | undefined): string =>
    within === undefined ? "" : ` within=${within}`;

  const lines: { order: number; line: string }[] = [
    ...core.sites.asks.map((site) => ({
      line:
        `ask ${site.id} ${quote(site.label)}${renderPattern(site.labelPattern)} ${at(site.loc)}` +
        ` order=${site.order}${withinOf(site.within)}${typeOf(site.id)}`,
      order: site.order,
    })),
    ...core.sites.worldReads.map((site) => ({
      line:
        `world-read ${site.id} ${quote(site.label)} ${at(site.loc)}` +
        ` order=${site.order}${withinOf(site.within)}${typeOf(site.id)}`,
      order: site.order,
    })),
    ...core.sites.joins.map((site) => {
      const ports = core.types.joinPortTypes.get(site.id);
      const portsText =
        ports === undefined
          ? ""
          : ` ports=${ports.map((port) => (port === undefined ? "-" : quote(port))).join(",")}`;
      return {
        line:
          `join ${site.id} ${quote(site.label)} ${at(site.loc)}` +
          ` order=${site.order}${withinOf(site.within)}${typeOf(site.id)}${portsText}`,
        order: site.order,
      };
    }),
    ...core.sites.actors.map((site) => ({
      line:
        `actor ${site.id}${site.name === undefined ? "" : ` ${quote(site.name)}`}` +
        `${renderPattern(site.namePattern)} ${at(site.loc)} order=${site.order}${withinOf(site.within)}`,
      order: site.order,
    })),
    ...core.sites.fanouts.map((site) => ({
      line:
        `fan-out ${site.id} ${quote(site.label)} ${at(site.loc)}` +
        ` order=${site.order}${withinOf(site.within)}` +
        `${site.cardinality === undefined ? "" : ` count=${site.cardinality}`}${typeOf(site.id)}`,
      order: site.order,
    })),
    ...core.sites.holes.map((site) => ({
      line:
        `hole ${site.id} ${quote(site.name)} ${at(site.loc)} order=${site.order}` +
        `${withinOf(site.within)} type=${quote(site.type)}${site.tail ? " tail" : ""}`,
      order: site.order,
    })),
  ];
  return lines.sort((a, b) => a.order - b.order).map((entry) => entry.line);
}

// 事实段：按固定类别顺序输出；同类内按 sink id 字典序稳定排列，occurrence 保持发射顺序。
// return 事实没有 sink key，单独作为一段跟在后面。
function renderFacts(facts: CoreFacts): string[] {
  const occText = (occ: TaintOcc): string =>
    `${occ.site} ${occ.exact ? "exact" : "inexact"}${occ.port === undefined ? "" : ` port=${occ.port}`}`;
  const group = (kind: string, map: Map<string, TaintOcc[]>): string[] => {
    // Emission (state.ts) fills these maps in deterministic evaluation order; sorting
    // by sink id keeps the section readable and independent of that order.
    const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines: string[] = [];
    for (const [sink, occs] of entries) {
      for (const occ of occs) lines.push(`fact ${kind} ${sink} <- ${occText(occ)}`);
    }
    return lines;
  };
  return [
    ...group("ask-data", facts.askData),
    ...group("ask-actor", facts.askActor),
    ...group("world-read-data", facts.worldReadData),
    ...group("join-in", facts.joinIn),
    ...group("fan-out-in", facts.fanoutIn),
    ...group("hole-data", facts.holeData),
    ...facts.returnData.map((occ) => `fact return <- ${occText(occ)}`),
  ];
}

// 事件段：按事件类别分别渲染 issue/settle/mark/jump/spawn；只写非空的连接字段，
// 保持 turn/key 的单空格格式。settle 的 "maybe" 与 "joins=" 只在对应语义出现。
function renderEvent(event: OrderTrace["events"][number]): string {
  const chain = (regions: readonly string[]): string =>
    regions.length === 0 ? "" : ` in=${regions.join(">")}`;
  if (event.at === "issue") {
    return `issue ${event.step}${chain(event.regions)} phase=${event.phase}`;
  }
  if (event.at === "settle") {
    // A join-only barrier carries no steps; the token is omitted rather than written as an
    // empty string, so the line keeps single spaces throughout.
    return (
      "settle" +
      (event.maybe ? " maybe" : "") +
      (event.steps.length === 0 ? "" : ` ${event.steps.join(",")}`) +
      chain(event.regions) +
      (event.joins === undefined || event.joins.length === 0
        ? ""
        : ` joins=${event.joins.join(",")}`)
    );
  }
  if (event.at === "mark") return `mark ${event.phase}${chain(event.regions)}`;
  if (event.at === "jump") {
    return `jump ${event.kind} ${event.target}${chain(event.regions)} phase=${event.phase}`;
  }
  return `spawn ${event.actor}${chain(event.regions)}`;
}
