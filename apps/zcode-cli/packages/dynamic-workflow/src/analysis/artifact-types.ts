import ts from "typescript";
import type { WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";
import { provisionalFanoutId } from "./domain.js";

/**
 * Producer-side artifact types for data edges. Every data edge's `from` is a producer
 * site (ask / world-read / join / fan-out) with a statically known artifact type; this
 * module computes that type as a human-readable string, plus per-port types for joins
 * over a static array literal. Semantics is PROVENANCE: an edge means "a value computed
 * from A's output feeds B", so the label is A's artifact type — not a claim about the
 * concrete wire value.
 *
 * The type names come from the live checker's {@link ts.TypeChecker.typeToString} today;
 * schema synthesis will later upgrade these to synthesized-schema names.
 * Uninformative labels (`any`/`unknown`/`never`/`void`) are omitted so a meaningless
 * string is never drawn.
 */

/** Per-site artifact types and per-port join element types. */
// 产物类型表：只描述「生产方产出的类型」，不描述边上的实际值。两张 Map 的键域不同，
// 消费方必须按站点种类选表（fan-out 用 siteType 的临时键，join 端口额外查 joinPortTypes）。
export interface ArtifactTypes {
  /**
   * Whole-value artifact type per site, keyed by site id. Ask/world-read/join sites use
   * their final ids (`ask#1`); fan-out candidates are keyed by their PROVISIONAL id
   * (`fan-out@order`, see {@link provisionalFanoutId}) — the same key the taint pass
   * stamps into occurrences, so graph assembly looks them up before the `fan-out#N`
   * rename.
   */
  siteType: Map<string, string>;
  // 值语义：缺失即「无可展示类型」（无类型参数、类型不可知或已被判为无信息），不存在空串条目；
  // 因此查找失败与「无标签」等价，渲染层无需再判空字符串。
  /**
   * Per-element awaited types of a join over a static array literal, keyed by join id.
   * Index i is the type of array element i (the join input at port i), or `undefined`
   * when that element's type is unknowable/uninformative. Absent for joins whose
   * argument is not a static array literal (no ports exist).
   */
  joinPortTypes: Map<string, (string | undefined)[]>;
  // 端口数组按字面量元素顺序一一对应端口下标，长度等于字面量元素个数；数组内元素可为
  // undefined（该端口不可知），但数组本身缺席表示「无端口概念」，两者不可混用。
}

/** typeToString flags: a named interface prints as its name (`Flaky`), no `…` truncation. */
const FORMAT_FLAGS = ts.TypeFormatFlags.NoTruncation;

/** Rendered type names that carry no information and must not be drawn as a label. */
const UNINFORMATIVE = new Set<string>(["any", "unknown", "never", "void"]);

/**
 * Cap on fan-out array-level unwrapping. Nested maps (`map` of `map`) nest arrays
 * arbitrarily; a fixed bound keeps the peel finite against pathological/cyclic generic
 * types, matching the taint domain's `VALUE_DEPTH_CAP` discipline.
 */
const FANOUT_UNWRAP_CAP = 8;

/**
 * Compute artifact types for every producer site in the table. Pure over the checker and
 * the AST refs the site table already resolved.
 */
// 职责：为站点表里所有生产方站点算出可展示的产物类型，并给出 join 的逐端口类型。
// 输入：workflow 提供已编译的 program/checker；table 是已解析好 AST 引用的站点表
// （asks/worldReads/holes/joins/iterations）。两者都不得为空，但各类站点集合可以为空。
// 输出：两张新建 Map，只读返回；没有任何可展示类型的站点不会出现在 siteType 中。
// 纯函数语义：只读 AST/checker 与表，不写任何状态、无 IO、无日志；可重复调用且结果稳定。
// 失败与降级：类型不可知或无信息（any/unknown/never/void）时静默省略该条目，绝不写入
// 占位字符串；fan-out 展开有上限（FANOUT_UNWRAP_CAP），到上限即按当前层级渲染。
// 维护不变量：fan-out 的键必须与 taint 阶段写入 occurrence 的临时 id 完全一致，
// 否则图装配在 `fan-out#N` 重命名之前查不到类型。
export function computeArtifactTypes(workflow: WorkflowProgram, table: SiteTable): ArtifactTypes {
  const checker = workflow.program.getTypeChecker();
  const siteType = new Map<string, string>();
  const joinPortTypes = new Map<string, (string | undefined)[]>();

  const renderRaw = (type: ts.Type): string => checker.typeToString(type, undefined, FORMAT_FLAGS);
  const render = (type: ts.Type | undefined): string | undefined => {
    if (type === undefined) return undefined;
    const text = renderRaw(type);
    return UNINFORMATIVE.has(text) ? undefined : text;
  };
  const set = (id: string, type: ts.Type | undefined): void => {
    const text = render(type);
    if (text !== undefined) siteType.set(id, text);
  };
  // The awaited (resolved) type of a call's own type — `Node<T>`/`Promise<T>` -> `T`.
  const awaitedOf = (node: ts.Node): ts.Type | undefined =>
    checker.getAwaitedType(checker.getTypeAtLocation(node));

  // The element type of a genuine `Array<T>`/`ReadonlyArray<T>`, else undefined. We test
  // the reference target's symbol rather than `getNumberIndexType`, because a `string`
  // (and a string-literal union) is number-indexable too — indexing one would wrongly
  // "peel" `("yes" | "no")[]` into `string[][]`.
  const arrayElement = (type: ts.Type): ts.Type | undefined => {
    const name = (type as ts.TypeReference).target?.symbol?.name;
    if (name !== "Array" && name !== "ReadonlyArray") return undefined;
    const args = checker.getTypeArguments(type as ts.TypeReference);
    return args.length > 0 ? args[0] : undefined;
  };

  // A fan-out's collected artifact type. The awaited whole call type of a `.map` is the
  // mapped array (`Node<Review>[]`, or `Node<string>[][]` for nested maps); that leaks the
  // facade promise wrapper into a user-facing label, so we peel array levels to a fixed
  // point — awaiting the element at each level (`Node<Review>` -> `Review`) — and rebuild
  // the `[]` suffixes, so `Node<Review>[]` -> `Review[]` and `Node<string>[][]` ->
  // `string[][]`. A top-level union/intersection innermost element is parenthesized
  // (`(A | B)[]`) to stay well-formed. Falls back to the whole-type rendering when the
  // type is not array-like or the peeled element is uninformative. Joins need no such
  // unwrap: `Promise.all`'s `Awaited<>` already resolves recursively.
  const fanoutType = (call: ts.Node): string | undefined => {
    const whole = awaitedOf(call);
    if (whole === undefined) return undefined;
    const wholeText = render(whole);
    let type = whole;
    let depth = 0;
    while (depth < FANOUT_UNWRAP_CAP) {
      const element = arrayElement(type);
      // 非数组或已到不可再剥的层级就停：边界固定，避免病态/递归泛型导致无限剥离。
      if (element === undefined) break;
      type = checker.getAwaitedType(element) ?? element;
      depth += 1;
    }
    if (depth === 0) return wholeText; // not array-like: keep the whole rendering
    const elementText = render(type);
    if (elementText === undefined) return wholeText; // uninformative element: fall back
    const base = /\s[|&]\s/.test(elementText) ? `(${elementText})` : elementText;
    return `${base}${"[]".repeat(depth)}`;
  };

  // ask: an explicit `ask<Flaky>` type argument is the artifact type directly; otherwise
  // the awaited return type (`Node<T>` -> `T`, default `T = string`).
  for (const site of table.asks) {
    const typeArg = site.call.typeArguments?.[0];
    const type = typeArg !== undefined ? checker.getTypeFromTypeNode(typeArg) : awaitedOf(site.call);
    set(site.id, type);
  }

  // world-read: the awaited call type (`string` for read, `string[]` for glob).
  for (const site of table.worldReads) set(site.id, awaitedOf(site.call));

  // open hole: the explicit type argument is the contract (9012 requires it); a filled hole is
  // not a producer site, its body's own sites are.
  for (const site of table.holes) {
    // 已填充的 hole 不再是生产方：其内部站点自己会产出类型；这里只给「未填充的开放洞」
    // 用显式类型参数当作契约类型，否则整条洞链会丢标签。
    if (site.body === undefined && site.typeArg !== undefined) {
      set(site.id, checker.getTypeFromTypeNode(site.typeArg));
    }
  }

  // join: the awaited whole type (a tuple for a static array literal, an array otherwise),
  // plus per-element awaited types when the argument is a static array literal.
  for (const site of table.joins) {
    set(site.id, awaitedOf(site.call));
    if (site.arg !== undefined && ts.isArrayLiteralExpression(site.arg)) {
      joinPortTypes.set(
        site.id,
        site.arg.elements.map((element) => render(awaitedOf(element))),
      );
    }
  }

  // fan-out: array-method candidates take the collected artifact type of the whole call
  // expression (the callback's parent), with the facade promise wrapper unwrapped off the
  // element (see {@link fanoutType}). `for...of` candidates have no call expression, and
  // `void` results (e.g. `forEach`) fall out via the uninformative filter.
  for (const cand of table.iterations) {
    // 仅 array-method 形态有 call 表达式；for...of 没有调用点，无法确定收集类型，故不产出标签。
    if (cand.form !== "array-method" || cand.call === undefined) continue;
    const text = fanoutType(cand.call);
    if (text !== undefined) siteType.set(provisionalFanoutId(cand.order), text);
  }

  return { joinPortTypes, siteType };
}
