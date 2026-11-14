// packages/formal-proof/src/main.ts —— 会话状态空间可视化入口（浏览器侧）
//
// 职责边界：
//   - 唯一职责是把 model.ts 产出的 TraceNode 树投影成可交互 DAG：裁剪渲染预算、
//     合并等价节点、布局列带、绘制边与节点、维护本地 review 标记、导出 JSON 快照。
//   - 不承载产品规则：allow/reject/enqueue/choice 的判定全部留在 model.ts 的 evaluate()；
//     本文件一旦出现按 runPhase 决定行为的 if，就说明规则被复制到了视图层。
//   - 不承载服务端事实：review 只写 localStorage，导出只是用户点击瞬间的快照。
//   - 画布每次全量重建，没有增量 diff；改渲染要接受这个成本，而不是先加缓存。
//
// 不变量（INV）：
//   INV-01 GraphNodeDatum.id 只由 kind/parentId/contextKey 派生（graphNodeId）——改用 title 派生会让等价节点无法合并，members 与边去重同时失真。
//   INV-02 visitGraph 命中同 id 时只向 members 追加，绝不替换 representative（同函数）——替换会让详情面板与 caseId 指向另一条 trace。
//   INV-03 边去重依赖 edgeIds 集合（buildStateSpaceGraph）——去掉后并发分支会产生重复边，SVG 层数与命中数一起翻倍。
//   INV-04 viewState.root 永远保存未裁剪的完整树（rebuildRoot）——用 renderRoot 回填会让统计与导出丢节点。
//   INV-05 语义统计取自 viewState.root，只有「图节点」取自 renderRoot（renderMetrics）——混用会让两张口径的数字互相矛盾。
//   INV-06 cloneForRender 返回新对象 {...node, children}——原地 push 到 node.children 会永久污染 root 与导出。
//   INV-07 渲染预算按节点递减，remaining<=0 才折叠（cloneForRender）——把判断改成 < 会多画一个节点，预算不再可预测。
//   INV-08 summaryNode 的 id 必须带 hidden 计数——固定 id 会让同层多个折叠点在 nodesById 中冲突。
//   INV-09 列号由 columnFor 的 round=floor(depth/4)、slot=depth%4 决定——与 model 的四段结构耦合，改段数必须同步 graphNodeId。
//   INV-10 列间距 304 在同文件出现两处（buildStateSpaceGraph / renderColumnBands）——只改一处会让节点列与列带错位。
//   INV-11 isGraphDimmed 用 members.some——改成 every 会让部分命中规则的节点被整列淡出。
//   INV-12 isEdgeDimmed 仅当两端都淡出才淡出——改成 or 会切断仍然有效的连边。
//   INV-13 selectedId 只接受图中存在的 id（selectedGraphNode）——写入临时 id 会让详情面板静默空白。
//   INV-14 review 的持久化 key 带 .v1 版本后缀（reviewKey）——改 key 等于丢弃用户已标注的 case。
//   INV-15 readReview 的 JSON.parse 必须被 try/catch 包住——坏数据会让首屏渲染直接抛错白屏。
//   INV-16 exportCases 只导出 kind 为 case 的节点——把 summary 也导出会产生没有 caseId 的伪用例。
//   INV-17 findPath 找不到目标时返回 [root]——返回空数组会让「代表路径」区域空白且无提示。
//   INV-18 applyTransform/zoomBy 先判 zoomBehavior 再调用——首帧前触发会因 null 抛 TypeError。
//   INV-19 事件监听只在模块初始化时绑定一次——挪进 renderAll 会随每次渲染叠加监听。
//   INV-20 renderAll 的顺序是 metrics→rules→graph→detail——renderDetail 依赖 renderGraph 重建的索引，提前调用查不到节点。
//   INV-21 所有 DOM 查询在初始化时一次完成（elements）——重写 innerHTML 后未重新查询会拿到游离节点。
//   INV-22 mustQuery 找不到元素必须抛错——静默返回 null 会把错误推迟到渲染中间，丢失定位信息。
//   INV-23 slug 的白名单是 id 稳定性的一部分（slug）——放宽字符集会破坏 id 作为 Map key 的稳定性。
import * as d3 from "d3";
import {
  buildTraceTree,
  collectStats,
  contextKey,
  contextLabel,
  decisionLabel,
  flatten,
  profiles,
  type Candidate,
  type Decision,
  type DecisionKind,
  type NodeKind,
  type ProductContext,
  type TraceNode,
} from "./model.js";
import "./styles.css";

// review 状态是持久化到 localStorage 的枚举值，新增值必须同时兼容旧快照。
// 按钮顺序由 statusOptions 决定而不是对象键顺序，调换会改动用户肌肉记忆。
// status 只用于人工标注，不参与规则判定，也不影响导出的 decision 字段。
// [契约] 未知字符串读回时按原样保留，不做归一化，避免下次保存抹掉别人写入的新值。
type ReviewStatus = "accepted" | "undefined" | "invalid" | "ignored" | "bug";

// 预算对象按引用在递归中共享，cloneForRender 每层就地递减，不做复制。
// [资源] 预算是节点数上限而不是深度上限：宽树会被均摊折叠，而不是整枝丢弃。
// 预算耗尽只影响画布，不影响 collectStats 与 exportCases 的完整性。
// 新增渲染路径若忘记扣减，会绕过预算并在大轮次下卡住主线程。
interface RenderBudget {
  remaining: number;
}

interface GraphNodeDatum {
  readonly id: string;
  readonly kind: NodeKind;
  // representative 是首次遇到该 id 的节点，合并之后不再更新。
  // 详情面板、review caseId、E2E 断言都读它，而不是 members 里的任意一个。
  // [权衡] 同 id 的后续节点标题可能不同，保留首个可换来渲染确定性。
  // 若要展示差异应扩展 detail 文案，不要改 representative 的选择策略。
  readonly representative: TraceNode;
  // members 记录所有落到同一语义 key 的 trace 节点，长度即节点右上角的命中数。
  // 只追加不删除；改成分组重算会让增量渲染时的计数抖动。
  // 规则高亮与 decision 过滤都用 members.some 扫描，成员越多单次渲染越慢。
  // [失败路径] members 为空意味着 id 生成与节点 kind 不匹配，应视为不变量破坏。
  readonly members: TraceNode[];
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly context: ProductContext;
  readonly candidate?: Candidate;
  readonly decision?: Decision;
  readonly caseId?: string;
  readonly e2e?: string;
  readonly column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GraphEdgeDatum {
  readonly id: string;
  readonly source: GraphNodeDatum;
  readonly target: GraphNodeDatum;
  readonly decision?: Decision;
}

interface StateSpaceGraph {
  readonly nodes: GraphNodeDatum[];
  readonly edges: GraphEdgeDatum[];
  readonly columns: number[];
  readonly width: number;
  readonly height: number;
}

// 视图状态的唯一副本：树、选中项、两个过滤器与 review 表，没有全局 store。
// 所有变更后都显式调用 renderAll 或局部更新函数，没有订阅机制。
// [权衡] 全量重渲染换来状态简单，规模由渲染预算兜底。
// 新增字段必须同步初始化和 rebuildRoot 分支，否则首次渲染读到 undefined。
interface TreeViewState {
  // root 是语义完整树，统计与导出都以它为准。
  // rebuildRoot 在参数变化时整体替换，旧节点引用立即失效。
  // 失效引用仍可能留在 graphNodeIndex 中，直到下次 renderGraph 重建。
  root: TraceNode;
  // renderRoot 是按预算裁剪后的副本，只服务画布。
  // 它由 cloneForRender 生成，可能含 kind 为 summary 的聚合节点。
  // [契约] 任何统计或导出路径都不得读 renderRoot，否则数字会与画布一起缩水。
  // 更新 root 后必须同时更新 renderRoot，两者不同步会让画布停留在旧树。
  renderRoot: TraceNode;
  nodes: TraceNode[];
  selectedId: string;
  activeRule: string;
  activeDecision: DecisionKind | "all";
  // review 以 caseId 为键，值是人工标注状态。
  // 内存表与 localStorage 是同一份事实，写内存后必须立刻落盘。
  // caseId 由 model 每次重建重新编号，参数变化后旧标注不会自动对齐。
  review: Record<string, ReviewStatus>;
}

// key 带版本后缀，结构变更时升版本而不是就地迁移。
// 升版本等于放弃旧标注，属于需要写进变更说明的破坏性动作。
// [契约] 写入点只有 review 按钮回调，读取点只有 readReview。
const reviewKey = "zcode.conversation-state-space.review.v1";
const statusOptions: ReviewStatus[] = ["accepted", "undefined", "invalid", "ignored", "bug"];
const numberFormat = new Intl.NumberFormat("zh-CN");
// 根容器在初始化阶段一次性查询，并作为 innerHTML 的宿主。
// [失败路径] 缺失时 mustQuery 直接抛错，避免后续在空引用上继续渲染。
// 重写 innerHTML 会让此前查询到的子节点全部游离，因此 elements 必须在之后建立。
const app = mustQuery<HTMLDivElement>("#app");

// zoom 行为绑定在单个 svg 上，是模块级单例。
// 每次 renderGraph 都会重建：清空 svg 后旧行为的节点目标已经不存在。
// [资源] 旧监听随元素移除失去目标，不显式 off 也不会重复触发。
// 在 renderGraph 之前调用 applyTransform/zoomBy 会因 null 直接返回。
let zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
let fitTransform: d3.ZoomTransform | null = null;
let defaultTransform: d3.ZoomTransform | null = null;
// 节点索引在 renderGraph 中重建，供点击与详情查找。
// [契约] 索引只包含当前渲染图的节点；选中已折叠节点时查询失败并回落为无详情。
// 不要在 renderGraph 之前依赖它，初始化时它是空 Map。
// 它与 viewState.nodes 不同：后者是全量语义节点，包含被折叠的部分。
let graphNodeIndex = new Map<string, GraphNodeDatum>();
// 用 let 声明并在模块顶层赋值，保证事件回调注册前已经初始化。
// [失败路径] 把赋值挪进函数后，首个 change 事件可能读到 undefined。
// 严格模式下读取未赋值的 let 会抛 ReferenceError，而不是静默 undefined。
// [契约] 这是全局唯一的视图状态实例，不要再开第二份副本。
let viewState: TreeViewState;

app.innerHTML = `
  <main class="app">
    <aside class="side-panel panel">
      <div class="brand">
        <h1>Conversation State Space</h1>
        <p class="subtitle">
          从 GUI 用户视角枚举 compact、fork、goal、消息队列和 query 编辑的组合。每个候选动作先进入笛卡尔积，再由产品 guard 剪枝；未定义路径会保留下来供人工 review，并最终导出为 E2E case。
        </p>
      </div>

      <section class="side-section">
        <div class="panel-header"><h2>参数枚举</h2></div>
        <div class="panel-body controls">
          <div class="control">
            <label for="profileSelect">初始上下文</label>
            <select id="profileSelect">
              ${profiles.map((profile) => `<option value="${profile.id}">${profile.label}</option>`).join("")}
            </select>
          </div>
          <div class="control">
            <label for="roundSelect">递归轮次</label>
            <select id="roundSelect">
              <option value="1">1 轮：只看下一步</option>
              <option value="2">2 轮：动作后继续枚举</option>
              <option value="3" selected>3 轮：推荐</option>
              <option value="4">4 轮：更大状态空间</option>
            </select>
          </div>
          <div class="control">
            <label for="budgetSelect">画布渲染预算</label>
            <select id="budgetSelect">
              <option value="350">350 节点</option>
              <option value="800" selected>800 节点</option>
              <option value="1600">1,600 节点</option>
              <option value="3200">3,200 节点</option>
            </select>
          </div>
          <div class="control">
            <label for="decisionSelect">结果过滤</label>
            <select id="decisionSelect">
              <option value="all">全部结果</option>
              <option value="reject">只看 reject 剪枝</option>
              <option value="undefined">只看 undefined</option>
              <option value="enqueue">只看 queue</option>
              <option value="allow">只看 allow</option>
              <option value="system">只看 system</option>
            </select>
          </div>
        </div>
      </section>

      <section class="side-section">
        <div class="panel-header"><h2>语义统计</h2></div>
        <div class="metrics" aria-label="状态空间统计">
          <div class="metric"><strong id="metricNodes">0</strong><span>语义节点</span></div>
          <div class="metric"><strong id="metricCases">0</strong><span>Review cases</span></div>
          <div class="metric"><strong id="metricRejects">0</strong><span>Reject 剪枝</span></div>
          <div class="metric"><strong id="metricUndefined">0</strong><span>Undefined</span></div>
          <div class="metric"><strong id="metricQueue">0</strong><span>Queue</span></div>
          <div class="metric"><strong id="metricRendered">0</strong><span>图节点</span></div>
        </div>
      </section>

      <section class="side-section rule-section">
        <div class="panel-header"><h2>规则命中</h2></div>
        <div class="panel-body rule-body">
          <p class="hint">点击规则会高亮对应语义节点。reject 是产品规则剪枝，undefined 是还没定义的产品逻辑。</p>
          <div id="ruleList" class="rule-list"></div>
        </div>
      </section>
    </aside>

    <section class="canvas-panel panel">
      <div class="toolbar">
        <div>
          <strong>State-Space DAG</strong>
          <p class="hint">横向按 State、Action、Guard、Effect、Case 展开；等价节点会合并并显示命中次数。拖拽移动，滚轮缩放，点击节点查看详情。</p>
        </div>
        <div class="toolbar-actions">
          <button id="zoomOut" class="toolbar-button" type="button" aria-label="缩小">-</button>
          <button id="zoomIn" class="toolbar-button" type="button" aria-label="放大">+</button>
          <button id="fitTree" class="toolbar-button" type="button">适配</button>
          <button id="resetTree" class="toolbar-button" type="button">重置</button>
          <button id="exportCases" class="toolbar-button" type="button">导出 JSON</button>
        </div>
      </div>
      <div class="graph-shell">
        <svg id="tree" role="img" aria-label="Conversation behavior state-space DAG"></svg>
        <aside id="nodePopover" class="node-popover" hidden>
          <div class="popover-header">
            <div>
              <b id="detailTitle">-</b>
              <span id="detailKind">-</span>
            </div>
            <button id="closeDetail" class="icon-button" type="button" aria-label="关闭节点详情">x</button>
          </div>
          <div class="popover-body detail-grid">
            <div class="detail-row"><b>上下文</b><code id="detailContext">-</code></div>
            <div class="detail-row"><b>产品语义</b><span id="detailText">-</span></div>
            <div class="detail-row"><b>E2E 断言</b><span id="detailE2e">-</span></div>
            <div class="detail-row">
              <b>Review</b>
              <div id="reviewButtons" class="review-buttons"></div>
            </div>
            <div class="detail-row"><b>代表路径</b><ul id="detailPath" class="path-list"></ul></div>
          </div>
        </aside>
      </div>
    </section>
  </main>
`;

// 所有 DOM 引用在这里一次性解析，后续渲染只操作引用。
// 必须在 app.innerHTML 赋值之后建立，否则查询到的是旧 DOM。
// 新增控件要同时改模板、引用与事件绑定三处，漏一处就是静默死按钮。
const elements = {
  profileSelect: mustQuery<HTMLSelectElement>("#profileSelect"),
  roundSelect: mustQuery<HTMLSelectElement>("#roundSelect"),
  budgetSelect: mustQuery<HTMLSelectElement>("#budgetSelect"),
  decisionSelect: mustQuery<HTMLSelectElement>("#decisionSelect"),
  metricNodes: mustQuery<HTMLElement>("#metricNodes"),
  metricCases: mustQuery<HTMLElement>("#metricCases"),
  metricRejects: mustQuery<HTMLElement>("#metricRejects"),
  metricUndefined: mustQuery<HTMLElement>("#metricUndefined"),
  metricQueue: mustQuery<HTMLElement>("#metricQueue"),
  metricRendered: mustQuery<HTMLElement>("#metricRendered"),
  ruleList: mustQuery<HTMLElement>("#ruleList"),
  tree: mustQuery<SVGSVGElement>("#tree"),
  nodePopover: mustQuery<HTMLElement>("#nodePopover"),
  detailTitle: mustQuery<HTMLElement>("#detailTitle"),
  detailKind: mustQuery<HTMLElement>("#detailKind"),
  detailContext: mustQuery<HTMLElement>("#detailContext"),
  detailText: mustQuery<HTMLElement>("#detailText"),
  detailE2e: mustQuery<HTMLElement>("#detailE2e"),
  detailPath: mustQuery<HTMLElement>("#detailPath"),
  reviewButtons: mustQuery<HTMLElement>("#reviewButtons"),
  closeDetail: mustQuery<HTMLButtonElement>("#closeDetail"),
  zoomIn: mustQuery<HTMLButtonElement>("#zoomIn"),
  zoomOut: mustQuery<HTMLButtonElement>("#zoomOut"),
  fitTree: mustQuery<HTMLButtonElement>("#fitTree"),
  resetTree: mustQuery<HTMLButtonElement>("#resetTree"),
  exportCases: mustQuery<HTMLButtonElement>("#exportCases"),
};

// 首次构建树发生在 elements 建立之后，因为 rebuildRoot 依赖 select 的当前值。
// [失败路径] profiles 为空时 rebuildRoot 抛错，页面停在空壳。
// 初始树只构建一次，后续参数变化统一走 change 监听。
const initialRoot = rebuildRoot();
viewState = {
  root: initialRoot,
  renderRoot: initialRoot,
  nodes: [],
  selectedId: "",
  activeRule: "all",
  activeDecision: "all",
  review: readReview(),
};

// 无参调用走默认参数 selectedGraphNode()，此时选中为空，全部按钮禁用。
// 这一步保证详情面板打开前按钮区已存在且状态自洽。
// 若改为首次在 renderDetail 中创建，关闭面板后会残留上一节点的按钮。
renderReviewButtons();
renderAll();

// 三个参数选择共用同一回调：清空选中并重建整棵树。
// decisionSelect 刻意不在其中，它只改过滤器，不需要重建树。
// [并发] rebuildRoot() 与 renderAll() 同步执行，不存在两次重建交错。
// 把 budgetSelect 之外再加别的 select 会重复构建同一棵树，纯浪费。
// 重建后 renderRoot 也随之更新，画布不会保留旧拓扑。
for (const select of [elements.profileSelect, elements.roundSelect, elements.budgetSelect]) {
  select.addEventListener("change", () => {
    viewState.selectedId = "";
    viewState.root = rebuildRoot();
    renderAll();
  });
}

elements.decisionSelect.addEventListener("change", () => {
  viewState.activeDecision = elements.decisionSelect.value as DecisionKind | "all";
  renderAll();
});
elements.zoomIn.addEventListener("click", () => zoomBy(1.25));
elements.zoomOut.addEventListener("click", () => zoomBy(0.8));
elements.fitTree.addEventListener("click", () => applyTransform(fitTransform));
elements.resetTree.addEventListener("click", () => applyTransform(defaultTransform));
elements.exportCases.addEventListener("click", exportCases);
elements.closeDetail.addEventListener("click", () => {
  viewState.selectedId = "";
  updateSelectedNodeClasses();
  renderDetail();
});

// 唯一的重渲染入口，顺序固定：指标→规则→图→详情。
// renderDetail 依赖 renderGraph 重建的 graphNodeIndex，两者顺序不可交换。
// [权衡] 每次全量重渲染，规模由渲染预算限制，不做局部 diff。
// 事件监听不在此绑定，因此重复调用不会叠加监听。
function renderAll(): void {
  // 预算来自下拉框的字符串，Number 转换在这里一次性完成。
  // [失败路径] 下拉值非法会得到 NaN，remaining<=0 为 false，递归将不收敛。
  // 因此模板里的 option value 必须保持纯数字字符串，不能带千分位。
  // budget 只约束 cloneForRender()，不影响 viewState.root 与统计。
  const budget = { remaining: Number(elements.budgetSelect.value) };
  viewState.renderRoot = cloneForRender(viewState.root, budget);
  viewState.nodes = flatten(viewState.root);
  renderMetrics();
  renderRules();
  renderGraph();
  renderDetail(selectedGraphNode());
}

// 按当前 profile 与轮次重建树，profile 缺省取第一个。
// [失败路径] profiles 为空时抛错而不是返回空树，避免下游 split 或 undefined。
// buildTraceTree 内部会 resetIds，保证每次重建的节点 id 与 case 编号可复现。
// 重建后旧节点引用全部失效，包括 graphNodeIndex 里缓存的条目。
function rebuildRoot(): TraceNode {
  const profile = profiles.find((item) => item.id === elements.profileSelect.value) ?? profiles[0];
  if (!profile) {
    throw new Error("No model profiles defined");
  }
  return buildTraceTree(profile.context, Number(elements.roundSelect.value));
}

// 语义统计来自完整 root，图节点数来自裁剪后的 renderRoot。
// 并列展示是刻意的：让读者看到 budget 折叠掉多少节点。
// buildStateSpaceGraph 在这里被再调用一次，仅取 nodes.length。
// [权衡] 多算一遍图是为了不把布局对象挂到 viewState 上造成生命周期纠缠。
function renderMetrics(): void {
  const stats = collectStats(viewState.root);
  elements.metricNodes.textContent = numberFormat.format(stats.nodes);
  elements.metricCases.textContent = numberFormat.format(stats.cases);
  elements.metricRejects.textContent = numberFormat.format(stats.rejects);
  elements.metricUndefined.textContent = numberFormat.format(stats.undefined);
  elements.metricQueue.textContent = numberFormat.format(stats.enqueued);
  elements.metricRendered.textContent = numberFormat.format(
    buildStateSpaceGraph(viewState.renderRoot).nodes.length,
  );
}

function renderRules(): void {
  const counts = new Map<string, number>();
  for (const node of viewState.nodes) {
    const rule = node.decision?.ruleId;
    if (rule) {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
  }

  const all = document.createElement("button");
  all.type = "button";
  all.className = `rule-button${viewState.activeRule === "all" ? " active" : ""}`;
  all.innerHTML = "<b>全部规则</b><span>取消规则高亮</span>";
  all.addEventListener("click", () => {
    viewState.activeRule = "all";
    renderAll();
  });

  // 按命中数降序排列；数字相同时顺序取决于 Map 的插入序，也就是节点遍历序。
  // [权衡] 没有二级排序键，规则 id 的显示顺序在等计数时不完全确定，但视觉上无影响。
  // 每个按钮的说明文案取该规则首个命中节点的 reason。
  // 数量多时这里是 O(n) 创建 DOM 节点，受枚举轮次影响。
  const buttons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `rule-button${viewState.activeRule === rule ? " active" : ""}`;
      button.innerHTML = `<b>${rule} · ${numberFormat.format(count)}</b><span>${sampleRuleText(rule)}</span>`;
      button.addEventListener("click", () => {
        viewState.activeRule = rule;
        renderAll();
      });
      return button;
    });

  elements.ruleList.replaceChildren(all, ...buttons);
}

// 每次渲染都清空 svg 全量重绘，包括列带、边、节点三层。
// zoom 行为随之重建，缩放与平移回到 defaultTransform。
// [权衡] 保留缩放需要额外状态，当前选择简单且可预期。
// 清空使用通配选择器，新增图层必须挂在同一个 group 下，否则下次会被一起清掉。
function renderGraph(): void {
  const svg = d3.select(elements.tree);
  svg.selectAll("*").remove();

  // 用 viewState.renderRoot 构图，直接决定画布规模。
  // 图对象是一次性的，不缓存；每次渲染都重新计算布局。
  // graphNodeIndex 紧随其后重建，两者必须成对更新。
  const graph = buildStateSpaceGraph(viewState.renderRoot);
  graphNodeIndex = new Map(graph.nodes.map((node) => [node.id, node]));

  const viewportWidth = elements.tree.clientWidth || 1120;
  const viewportHeight = elements.tree.clientHeight || 820;
  elements.tree.setAttribute("viewBox", `0 0 ${viewportWidth} ${viewportHeight}`);

  const group = svg.append("g");
  zoomBehavior = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.06, 3])
    .on("zoom", (event) => group.attr("transform", event.transform));

  // 适配缩放被夹在 0.06 到 1 之间：不放大超过原始比例，也不缩到看不见。
  // 上下限与 zoom 的 scaleExtent 保持一致，避免 fit 之后滚轮跳变。
  // [权衡] fitScale 上限固定为 1，图很小时不做放大。
  // 计算依赖 graph.width/height，布局必须先完成。
  const fitScale = Math.max(
    0.06,
    Math.min(1, viewportWidth / graph.width, viewportHeight / graph.height),
  );
  defaultTransform = d3.zoomIdentity.translate(40, 34).scale(0.92);
  fitTransform = d3.zoomIdentity.translate(26, 28).scale(fitScale);
  svg.call(zoomBehavior).call(zoomBehavior.transform, defaultTransform);

  // renderColumnBands() 先画，作为最底层的背景层。
  // 它必须在边与节点之前 append，否则会盖住节点。
  // 列带数量由 graph.columns 决定，空图时不绘制任何列。
  renderColumnBands(group, graph);

  group
    .append("g")
    .attr("class", "edge-layer")
    .selectAll<SVGPathElement, GraphEdgeDatum>("path")
    .data(graph.edges)
    .join("path")
    .attr("class", (edge) => `graph-edge${isEdgeDimmed(edge) ? " dimmed" : ""}`)
    .attr("d", edgePath);

  const node = group
    .append("g")
    .attr("class", "node-layer")
    .selectAll("g.graph-node")
    .data(graph.nodes)
    .join("g")
    .attr("class", (item) => graphNodeClass(item))
    .attr("transform", (item) => `translate(${item.x},${item.y})`)
    .on("click", (event, item) => {
      event.stopPropagation();
      viewState.selectedId = item.id;
      updateSelectedNodeClasses();
      renderDetail(item);
    });

  node
    .append("rect")
    .attr("width", (item) => item.width)
    .attr("height", (item) => item.height)
    .attr("rx", 8);

  node
    .append("text")
    .attr("class", "type")
    .attr("x", 12)
    .attr("y", 17)
    .text((item) => nodeTypeLabel(item));

  node
    .append("text")
    .attr("class", "count")
    .attr("x", (item) => item.width - 12)
    .attr("y", 17)
    .attr("text-anchor", "end")
    .text((item) =>
      item.members.length > 1 ? `x${numberFormat.format(item.members.length)}` : "",
    );

  node
    .append("text")
    .attr("class", "title")
    .attr("x", 12)
    .attr("y", 39)
    .text((item) => shortText(item.title, 30));

  node
    .append("text")
    .attr("class", "subtitle")
    .attr("x", 12)
    .attr("y", 58)
    .text((item) => shortText(item.subtitle, 34));
}

// 构图：输入树，输出节点、边、列与画布尺寸。
// buildStateSpaceGraph() 内部先递归收集，再布局，最后解析 edgeRefs。
// [契约] 返回的节点对象被 graphNodeIndex 与画布共享，调用方不得修改。
// 列数可能为 0（空树），Math.max(...columns, 0) 负责兜底。
function buildStateSpaceGraph(root: TraceNode): StateSpaceGraph {
  const nodesById = new Map<string, GraphNodeDatum>();
  const edgeIds = new Set<string>();
  // 边先以 id 形式暂存，等所有节点布局完成后再解析成对象引用。
  // [并发] 这样避免了「目标节点尚未创建」时的悬空引用。
  // decision 取子节点优先、父节点兜底，用于边的语义着色。
  // 解析阶段过滤掉任一端缺失的边，属于容错而非正常路径。
  const edgeRefs: Array<{ sourceId: string; targetId: string; decision?: Decision }> = [];

  // 深度从 0 开始，round 由 floor(depth/4)+1 推导。
  // 根节点没有 parent，因此不会产生入边。
  // 递归顺序即 DFS 前序，决定同列内的初始顺序（随后再按 key 排序）。
  // 调用前 nodesById 与 edgeIds 必须为空，复用会让两张图串数据。
  visitGraph(root, undefined, 0);

  const nodes = [...nodesById.values()];
  const columns = [...new Set(nodes.map((node) => node.column))].sort((a, b) => a - b);
  // 列间距 304 是布局与列带共享的常量。
  // [契约] renderColumnBands 里有同值副本，修改必须两处同步。
  // 节点最大宽度 268，剩余空间作为列内边距。
  const columnWidth = 304;
  const rowGap = 14;
  const headerHeight = 56;
  const left = 28;
  const top = 58;
  let graphHeight = 600;

  // 逐列布局：列内先排序再按节点高度累加 y。
  // graphHeight 取所有列的最大值，保证画布容纳最高的一列。
  // 排序键含决策等级与标题，保证同一输入每次得到相同布局。
  // 列内 y 从表头下方开始，表头高度固定 56。
  for (const column of columns) {
    const columnNodes = nodes
      .filter((node) => node.column === column)
      .sort((a, b) => graphSortKey(a).localeCompare(graphSortKey(b), "zh-CN"));

    columnNodes.forEach((node, index) => {
      node.x = left + column * columnWidth;
      node.y = top + headerHeight + index * (node.height + rowGap);
    });
    const height = top + headerHeight + columnNodes.length * (76 + rowGap) + 80;
    graphHeight = Math.max(graphHeight, height);
  }

  const graphWidth = left + (Math.max(...columns, 0) + 1) * columnWidth + 280;
  const edges: GraphEdgeDatum[] = edgeRefs
    .map((edge): GraphEdgeDatum | undefined => {
      const source = nodesById.get(edge.sourceId);
      const target = nodesById.get(edge.targetId);
      if (!source || !target) {
        return undefined;
      }
      const id = `${edge.sourceId}->${edge.targetId}`;
      return edge.decision
        ? { id, source, target, decision: edge.decision }
        : { id, source, target };
    })
    .filter((edge): edge is GraphEdgeDatum => Boolean(edge));

  return {
    nodes,
    edges,
    columns,
    width: graphWidth,
    height: graphHeight,
  };

  // 建图递归，闭包持有 nodesById、edgeIds 与 edgeRefs。
  // 同 id 命中即视为等价节点，合并进 members 并复用已有边。
  // 子节点的 decision 优先于父节点，用于边的着色语义。
  // [失败路径] 若 graphNodeId 不稳定，这里会把不同语义的节点错误合并。
  // 先建边还是先建子节点不影响结果，因为边按 id 去重。
  function visitGraph(
    node: TraceNode,
    parent: GraphNodeDatum | undefined,
    depth: number,
  ): GraphNodeDatum {
    // id 是合并与去重的唯一键，必须在同一深度下稳定。
    // parent?.id 参与构成，避免不同父节点下的同名动作被合并。
    // [契约] 修改 id 组成会改变画布拓扑，也会让已保存的 selectedId 失效。
    const id = graphNodeId(node, parent?.id, depth);
    let datum = nodesById.get(id);
    // 命中已有 id：只累加 members，保留首个代表节点。
    // 不更新标题与详情，保证渲染确定性，也避免详情在重绘之间跳动。
    // members 顺序是 DFS 到达顺序，右上角命中数依赖它的长度。
    if (datum) {
      datum.members.push(node);
    } else {
      datum = {
        id,
        kind: node.kind,
        representative: node,
        members: [node],
        title: node.title,
        subtitle: node.subtitle,
        detail: node.detail,
        context: node.context,
        candidate: node.candidate,
        decision: node.decision,
        caseId: node.caseId,
        e2e: node.e2e,
        column: columnFor(node, depth),
        x: 0,
        y: 0,
        width: widthFor(node),
        height: 76,
      };
      nodesById.set(id, datum);
    }

    if (parent) {
      const edgeId = `${parent.id}->${datum.id}`;
      if (!edgeIds.has(edgeId)) {
        edgeIds.add(edgeId);
        edgeRefs.push({
          sourceId: parent.id,
          targetId: datum.id,
          decision: node.decision ?? parent.decision,
        });
      }
    }

    for (const child of node.children) {
      visitGraph(child, datum, depth + 1);
    }
    return datum;
  }
}

// renderColumnBands() 画的是纯装饰层，不参与命中测试。
// bandWidth 282 与 columnWidth 304 的差值形成列间空隙。
// 标签高度固定 18，跨轮次复用同一套列名。
// 高度用 graph.height - 24，避免底边溢出画布。
function renderColumnBands(
  group: d3.Selection<SVGGElement, unknown, null, undefined>,
  graph: StateSpaceGraph,
): void {
  const bandWidth = 282;
  const left = 18;
  const labelTop = 18;
  const columnWidth = 304;

  const bands = group.append("g").attr("class", "column-bands");
  const column = bands
    .selectAll("g.column-band")
    .data(graph.columns)
    .join("g")
    .attr("class", "column-band")
    .attr("transform", (item) => `translate(${left + item * columnWidth},0)`);

  column
    .append("rect")
    .attr("x", 0)
    .attr("y", 8)
    .attr("width", bandWidth)
    .attr("height", graph.height - 24)
    .attr("rx", 8);

  column
    .append("text")
    .attr("x", 10)
    .attr("y", labelTop)
    .text((item) => columnLabel(item));
}

// 按 kind 分支生成 id：state 用 contextKey，其余用 parentId 前缀。
// [契约] state 不带 parentId，所以不同父路径下的相同上下文会合并，这是刻意的等价类语义。
// candidate/guard/effect 用 parentId 保证动作在各自分支内唯一。
// summary 只用标题 slug，因为折叠点是渲染期的产物。
// case 用 caseId，缺省回落到节点 id，避免 undefined 进入 Map。
function graphNodeId(node: TraceNode, parentId: string | undefined, depth: number): string {
  const round = Math.floor(depth / 4) + 1;
  if (node.kind === "state") {
    return `state:${round}:${contextKey(node.context)}`;
  }
  if (node.kind === "candidate") {
    return `${parentId ?? "root"}:action:${node.candidate?.id ?? slug(node.title)}`;
  }
  if (node.kind === "guard") {
    return `${parentId ?? "root"}:guard:${node.decision?.kind ?? "none"}:${node.decision?.ruleId ?? slug(node.title)}`;
  }
  if (node.kind === "effect") {
    return `${parentId ?? "root"}:effect:${node.decision?.kind ?? "none"}:${node.decision?.ruleId ?? slug(node.title)}:${contextKey(node.context)}`;
  }
  if (node.kind === "summary") {
    return `${parentId ?? "root"}:summary:${slug(node.title)}`;
  }
  return `case:${node.caseId ?? node.id}`;
}

// 列 = 轮次乘 5 加槽位；case 与 summary 固定落在第 5 槽。
// depth 取模 4 与 model 的固定四段结构耦合。
// 列号只增不减，保证从左到右的阅读顺序。
// [失败路径] 若 model 增加节点层级，这里会出现两列重叠。
function columnFor(node: TraceNode, depth: number): number {
  const round = Math.floor(depth / 4);
  if (node.kind === "case" || node.kind === "summary") {
    return round * 5 + 4;
  }
  return round * 5 + (depth % 4);
}

function widthFor(node: TraceNode): number {
  if (node.kind === "case") {
    return 264;
  }
  if (node.kind === "state") {
    return 268;
  }
  return 252;
}

function columnLabel(column: number): string {
  const round = Math.floor(column / 5) + 1;
  const slot = column % 5;
  if (slot === 0) {
    return `R${round} · State`;
  }
  if (slot === 1) {
    return "Action";
  }
  if (slot === 2) {
    return "Guard";
  }
  if (slot === 3) {
    return "Effect";
  }
  return "Case / Review";
}

// 排序键把决策等级放在首位，让 reject 与 undefined 优先聚集。
// 用 localeCompare 的中文排序保证标题顺序可读。
// [契约] 键必须稳定且不依赖 Map 迭代序，否则布局会在重绘间抖动。
// 加入时间戳或随机量会让每次渲染重排，属于禁止改动。
function graphSortKey(node: GraphNodeDatum): string {
  return [
    String(node.decision ? decisionRank(node.decision.kind) : 0),
    node.kind,
    node.decision?.ruleId ?? "",
    node.title,
    node.subtitle,
  ].join("|");
}

function decisionRank(kind: DecisionKind): number {
  if (kind === "reject") {
    return 1;
  }
  if (kind === "undefined") {
    return 2;
  }
  if (kind === "enqueue") {
    return 3;
  }
  if (kind === "allow") {
    return 4;
  }
  return 5;
}

// 三次贝塞尔：起点在源节点右缘中点，终点在目标节点左缘中点。
// 控制点水平偏移取 36 与半程的较大值，短边不会塌成直线。
// 路径只依赖布局坐标，不读取任何语义字段。
function edgePath(edge: GraphEdgeDatum): string {
  const sx = edge.source.x + edge.source.width;
  const sy = edge.source.y + edge.source.height / 2;
  const tx = edge.target.x;
  const ty = edge.target.y + edge.target.height / 2;
  const mid = sx + Math.max(36, (tx - sx) * 0.5);
  return `M${sx},${sy} C${mid},${sy} ${mid},${ty} ${tx},${ty}`;
}

// 详情面板的唯一渲染入口，传空即关闭。
// 关闭时同时移除 review 按钮与路径列表，避免残留上一节点信息。
// 标题、kind、上下文、E2E 与路径分块更新，失败只影响对应区块。
// representative 决定显示内容，members 只提供命中数。
function renderDetail(graphNode?: GraphNodeDatum): void {
  // 无选中是常态：初始渲染、关闭面板、选中节点被折叠后都会走到这里。
  // 隐藏 popover 并清空两个动态容器，而不是留空字符串。
  // [失败路径] 只设置 hidden 而不清空，会让下次打开瞬间闪出旧内容。
  if (!graphNode) {
    elements.nodePopover.hidden = true;
    elements.reviewButtons.replaceChildren();
    elements.detailPath.replaceChildren();
    return;
  }

  const node = graphNode.representative;
  elements.nodePopover.hidden = false;
  elements.detailTitle.textContent = graphNode.title;
  elements.detailKind.textContent = [
    graphNode.kind,
    graphNode.members.length > 1
      ? `命中 ${numberFormat.format(graphNode.members.length)} 条 trace`
      : "",
    node.decision ? decisionLabel(node.decision) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  elements.detailContext.textContent = contextLabel(graphNode.context);
  elements.detailText.textContent = graphNode.detail;
  elements.detailE2e.textContent = node.e2e ?? node.decision?.assertion ?? "-";
  renderReviewButtons(graphNode);

  // 代表路径从完整 root 查找，而不是 renderRoot。
  // 折叠节点在 renderRoot 中不存在，必须回语义树找。
  // findPath 找不到时返回 [root]，面板至少显示根节点。
  const path = findPath(viewState.root, node.id);
  elements.detailPath.replaceChildren(
    ...path.map((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.kind}: ${item.title}`;
      return li;
    }),
  );
}

// 默认参数让初始渲染与显式调用共用一条路径。
// 按钮状态来自 viewState.review[caseId]，caseId 缺失时全部禁用。
// 点击写内存后立刻序列化到 localStorage，不做防抖。
// [权衡] 同步写 localStorage 在大表下会有轻微卡顿，但保证标注不丢。
function renderReviewButtons(graphNode = selectedGraphNode()): void {
  const node = graphNode?.representative;
  elements.reviewButtons.replaceChildren(
    ...statusOptions.map((status) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `review-button${node?.caseId && viewState.review[node.caseId] === status ? " active" : ""}`;
      button.textContent = status;
      button.disabled = !node?.caseId;
      button.addEventListener("click", () => {
        // 回调里再判一次 caseId：按钮虽已禁用，但禁用不阻止程序化 click。
        // 提前 return 避免把 undefined 写进 review 表污染持久化数据。
        // 这是 caseId 的防御性检查，不是可删的冗余分支。
        if (!node?.caseId) {
          return;
        }
        viewState.review[node.caseId] = status;
        localStorage.setItem(reviewKey, JSON.stringify(viewState.review));
        renderReviewButtons(graphNode);
      });
      return button;
    }),
  );
}

function updateSelectedNodeClasses(): void {
  d3.select(elements.tree)
    .selectAll<SVGGElement, GraphNodeDatum>("g.graph-node")
    .attr("class", (item) => graphNodeClass(item));
}

// 只复制节点与 children 数组，其余字段按引用共享。
// 返回新对象，绝不修改入参；root 必须保持不可变。
// [资源] 每次渲染都新建整棵渲染树，深树会产生大量短命对象。
// 预算耗尽时用 summaryNode 折叠整枝，但计数仍按真实节点数。
function cloneForRender(node: TraceNode, budget: RenderBudget): TraceNode {
  // 预算用尽立刻折叠，不再展开子节点。
  // 判断必须是小于等于：写成小于会让 remaining 为 0 时仍多展开一层。
  // 折叠节点的 hidden 为 1，表示「这里至少还有一个节点」，不是精确数。
  if (budget.remaining <= 0) {
    return summaryNode(node, 1);
  }
  budget.remaining -= 1;
  // 先决定保留哪些子节点，再决定是否追加聚合节点。
  // hidden 累加被跳过的子树节点数，用于聚合文案。
  // 聚合节点追加在末尾，保证列内顺序稳定。
  // [契约] children 是新数组，不与原节点共享引用。
  const children: TraceNode[] = [];
  let hidden = 0;

  for (const child of node.children) {
    if (budget.remaining <= 0) {
      hidden += countNodes(child);
      continue;
    }
    children.push(cloneForRender(child, budget));
  }

  if (hidden > 0) {
    children.push(summaryNode(node, hidden));
  }

  return { ...node, children };
}

// 折叠节点携带父上下文，保证列归属正确。
// id 内含 hidden 计数，同层多个折叠点不会撞 key。
// subtitle 与 detail 明确告知完整语义仍在统计与导出中。
// 聚合节点没有 candidate 与 decision，因此不参与规则命中。
function summaryNode(parent: TraceNode, hidden: number): TraceNode {
  return {
    id: `${parent.id}-summary-${hidden}`,
    kind: "summary",
    title: `聚合 ${numberFormat.format(hidden)} 个节点`,
    subtitle: "超过当前渲染预算",
    detail: "完整语义仍然参与统计和 JSON 导出，只是画布里折叠显示。",
    context: parent.context,
    children: [],
  };
}

function countNodes(node: TraceNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}

// 规则与决策两个过滤器是 AND：任一不匹配即淡出。
// 匹配语义是 members.some，任一成员命中即保留。
// activeRule 与 activeDecision 为 all 时视为全部匹配。
// 淡出只改样式不移除节点，因此仍可点击查看详情。
function isGraphDimmed(node: GraphNodeDatum): boolean {
  // 规则命中判定只看 decision.ruleId，不看标题文案。
  // 没有 decision 的节点在非 all 规则下必然淡出。
  // 这是刻意的：undefined 路径应当被突出，而不是被隐藏。
  const ruleMatched =
    viewState.activeRule === "all" ||
    node.members.some((member) => member.decision?.ruleId === viewState.activeRule);
  const decisionMatched =
    viewState.activeDecision === "all" ||
    node.members.some((member) => member.decision?.kind === viewState.activeDecision);
  return !ruleMatched || !decisionMatched;
}

// isEdgeDimmed() 仅在 source 与 target 都淡出时返回 true。
// 改判 || 会切断裂路径，图会看起来断成孤岛。
// 边没有独立过滤条件，语义完全由 source/target 的端点状态决定。
function isEdgeDimmed(edge: GraphEdgeDatum): boolean {
  return isGraphDimmed(edge.source) && isGraphDimmed(edge.target);
}

// class 列表是 CSS 契约：graph-node + kind + decision.kind + 修饰态。
// long-task、dimmed、selected 三个修饰可以叠加。
// kind 与 decision.kind 同名时会重复，CSS 层面无副作用。
// 新增修饰态必须同步样式表，否则是死代码。
function graphNodeClass(node: GraphNodeDatum): string {
  const classes = ["graph-node", node.kind];
  if (node.decision) {
    classes.push(node.decision.kind);
  }
  if (isLongRunningState(node)) {
    classes.push("long-task");
  }
  if (isGraphDimmed(node)) {
    classes.push("dimmed");
  }
  if (viewState.selectedId === node.id) {
    classes.push("selected");
  }
  return classes.join(" ");
}

// 类型标签按 kind 与长任务状态生成，是纯展示文案。
// state 且处于 running/compacting/goalVerifying 时标注 long task。
// system 候选单独标为 System event，便于与用户动作区分。
// 新增 kind 必须补分支，否则落到兜底的 State。
function nodeTypeLabel(node: GraphNodeDatum): string {
  if (node.kind === "state" && isLongRunningState(node)) {
    return "State · long task";
  }
  if (node.kind === "candidate" && node.candidate?.kind === "system") {
    return "System event";
  }
  if (node.kind === "candidate") {
    return "User action";
  }
  if (node.kind === "guard") {
    return "Guard";
  }
  if (node.kind === "effect") {
    return "Effect";
  }
  if (node.kind === "case") {
    return "Case";
  }
  if (node.kind === "summary") {
    return "Folded";
  }
  return "State";
}

// 只有 state 节点才可能是长任务。
// running、compacting、goalVerifying 三个 phase 属于长任务。
// 判定影响节点文案与 long-task 样式，不影响过滤器。
function isLongRunningState(node: GraphNodeDatum): boolean {
  return (
    node.kind === "state" &&
    (node.context.runPhase === "running" ||
      node.context.runPhase === "compacting" ||
      node.context.runPhase === "goalVerifying")
  );
}

// 选中 id 为空直接返回 undefined，避免空串查表。
// 查询失败同样返回 undefined，详情面板据此关闭。
// [失败路径] 选中节点被折叠后这里查不到，属于预期降级。
function selectedGraphNode(): GraphNodeDatum | undefined {
  if (!viewState.selectedId) {
    return undefined;
  }
  return graphNodeIndex.get(viewState.selectedId);
}

// DFS 前序查找目标 id，路径在递归中维护。
// 命中即返回 true，回溯后闭包数组保留根到目标的链。
// 未命中时数组已经弹空，返回 [root] 作为兜底展示。
// 路径基于完整 root，折叠节点也能追踪到。
function findPath(root: TraceNode, id: string): TraceNode[] {
  const path: TraceNode[] = [];
  const found = walk(root);
  return found ? path : [root];

  function walk(node: TraceNode): boolean {
    path.push(node);
    if (node.id === id) {
      return true;
    }
    for (const child of node.children) {
      if (walk(child)) {
        return true;
      }
    }
    path.pop();
    return false;
  }
}

// 读取失败一律回落空对象，页面必须能起来。
// [失败路径] localStorage 可能被隐私模式禁用，内容也可能被手工改坏。
// 不做 schema 校验：未知状态值原样保留，避免抹掉新版本写入的值。
// 返回值直接作为 viewState.review 的初始值，不做深拷贝。
function readReview(): Record<string, ReviewStatus> {
  try {
    return JSON.parse(localStorage.getItem(reviewKey) || "{}") as Record<string, ReviewStatus>;
  } catch {
    return {};
  }
}

// 导出全量 case，不受当前过滤与渲染预算影响。
// status 缺省为 unreviewed，用于区分未标注与标注过的值。
// path 使用标题序列而非 id，便于人工阅读。
// [契约] 字段名是下游 E2E 的消费契约，改名需同步消费方。
function exportCases(): void {
  // 从 viewState.nodes 过滤，而不是遍历树，避免二次遍历。
  // 只有 kind 为 case 的节点带 caseId。
  // summary 节点被排除，因为它不代表真实用例。
  const cases = viewState.nodes
    .filter((node) => node.kind === "case")
    .map((node) => ({
      id: node.caseId,
      status: node.caseId ? (viewState.review[node.caseId] ?? "unreviewed") : "unreviewed",
      title: node.subtitle,
      context: contextLabel(node.context),
      decision: node.decision?.kind,
      ruleId: node.decision?.ruleId,
      action: node.candidate?.label,
      e2e: node.e2e,
      path: findPath(viewState.root, node.id).map((item) => item.title),
    }));
  const blob = new Blob([JSON.stringify(cases, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "conversation-state-space-cases.json";
  link.click();
  URL.revokeObjectURL(url);
}

// applyTransform() 是适配与重置的统一入口。
// [失败路径] zoomBehavior 或 transform 为空时静默返回，首帧前点击不会报错。
// transition 180ms 只影响视觉，不改变最终矩阵。
// 传入的 transform 不会被修改。
function applyTransform(transform: d3.ZoomTransform | null): void {
  if (!zoomBehavior || !transform) {
    return;
  }
  d3.select(elements.tree).transition().duration(180).call(zoomBehavior.transform, transform);
}

function zoomBy(factor: number): void {
  if (!zoomBehavior) {
    return;
  }
  d3.select(elements.tree).transition().duration(180).call(zoomBehavior.scaleBy, factor);
}

function sampleRuleText(ruleId: string): string {
  const node = viewState.nodes.find((item) => item.decision?.ruleId === ruleId);
  return node?.decision?.reason ?? "规则命中路径";
}

function shortText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

// 把标题压成 id 片段：转小写，非字母数字中文替换为连字符。
// [契约] 正则白名单是 id 稳定性的一部分，放宽会导致旧 id 失效。
// 首尾连字符被去掉，避免 id 中出现双分隔符。
// 中文被保留，因此 id 仍可能是非 ASCII。
function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "");
}

// 查询失败直接抛错，错误信息带选择器，便于定位模板缺项。
// 泛型只用于调用方类型收窄，不做运行时校验。
// [失败路径] 抛错发生在模块初始化阶段，页面整体白屏而不是局部异常。
function mustQuery<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}
