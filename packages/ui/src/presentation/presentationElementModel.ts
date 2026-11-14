// INV-01 纯投影不引入副作用：输入相同则输出逐字段相同，不读磁盘、不发请求、不缓存。守住位置：buildPresentationPageElements 与全部内部 helper 的逻辑。改错故障：一旦写入缓存或读取环境，测试与渲染会得到不同结果，问题无法稳定复现。
// INV-02 列坐标必须归一：单元格 x 与 width 先按 columnTotal 求比例，再乘 node.size.w。守住位置：buildTableCellElements 的 bounds 计算。改错故障：直接用像素偏移会让列宽总和与节点宽度不一致的表格整体错位。
// INV-03 行坐标同理归一：y 与 height 先按 rowTotal 求比例，再乘 node.size.h。守住位置：buildTableCellElements 的 bounds 计算。改错故障：行列使用不同口径时，行高总和偏差会逐行累积。
// INV-04 负数一律钳零：宽度与高度的求和都先取非负值。守住位置：内部 sum 函数。改错故障：负值抵消正值会让总宽偏小，归一后的单元格相互重叠。
// INV-05 跨度至少为 1：gridSpan 与 rowSpan 要向下钳到 1，允许调用方传入 0 或负数。守住位置：buildTableCellElements 的单元格循环。改错故障：零跨度不推进列游标，同一行后续单元格全部叠进一列。
// INV-06 合并 continuation 不产出元素：hMerge 或 vMerge 为真时直接返回空数组。守住位置：单元格循环内的早返回。改错故障：为中心格再生成一份元素，文本重复且命中测试出现重影。
// INV-07 横向 continuation 不推进列：它继续占据起始格相同的列区间，视觉上由起始格拉伸覆盖。守住位置：合并分支中只对纵向情形推进游标。改错故障：横向合并后的单元格整体左移一列，边框与文本错位。
// INV-08 纵向 continuation 必须推进列：下一行同一列需要被跳过。守住位置：合并分支中 vMerge 且非 hMerge 的游标推进。改错故障：后续单元格会写进已合并区域，覆盖起始格文本。
// INV-09 索引使用物理下标：rowIndex 与 cellIndex 都是原始数组下标，不是网格坐标。守住位置：单元格对象的字段赋值。改错故障：改成网格坐标会破坏上层按物理格回查的契约，编辑落点错行。
// INV-10 表体先于单元格：table 节点返回表体元素加若干单元格元素，顺序不可颠倒。守住位置：buildPresentationPageElements 的 table 分支。改错故障：同 zIndex 时排序稳定，顺序颠倒会让单元格压过表体，边框层级异常。
// INV-11 group 与 unknown 不产出直接元素：两者在展开时立即返回空数组。守住位置：directElements 的 flatMap 入口。改错故障：空形状参与命中，点击组的空白处会选中错误元素。
// INV-12 zIndex 取 nodes 物理下标：被跳过的 group 仍占一个位置，层级值不连续。守住位置：直接元素 base 的 zIndex 赋值。改错故障：改用过滤后的下标会压缩层级，前后覆盖关系反转。
// INV-13 组内文本必须去重：nodeId 已在直接元素集合中时丢弃该条文本。守住位置：groupTextEntries 展开前的判断。改错故障：同一节点出现两份文本，搜索命中两次且坐标不一致。
// INV-14 去重集合只排除 group：unknown 节点仍计入，防止其组内文本重复。守住位置：directIds 的 filter 条件。改错故障：把 unknown 一并排除后，unknown 节点的文本会与其直接元素重复。
// INV-15 组 id 优先取 nodes 段后一段：找不到 nodes 段时回退路径首段以兼容旧调用方。守住位置：groupId 的解析表达式。改错故障：只取首段会在标准路径下得到 slides，组内文本全部落到 zIndex 0。
// INV-16 组层级缺失时归零：定位不到对应组节点时 zIndex 取 0 而不是 -1。守住位置：组内文本的 zIndex 计算。改错故障：负数层级会让组内文本沉到所有元素之下，看上去被遮挡。
// INV-17 命中边界闭合：四边比较都用包含等号，相邻元素共享边时同时成为候选。守住位置：containsPoint 的四个比较。改错故障：改成开区间会在边框上留下穿透，点击边缘无响应。
// INV-18 命中优先级固定：先判 table-cell 再比 zIndex 降序。守住位置：hitTestPresentationElement 的比较器。改错故障：表格覆盖形状时点击会落到表体而非单元格，编辑目标错误。
//
// 模块职责：把演示文稿页面节点树投影为可命中、可渲染的扁平元素数组，并为表格补齐单元格、为组内文本补齐坐标。
// 状态所有权：无状态纯函数，输入归调用方所有；本模块不缓存、不写回，也不依赖调用顺序。
// 阅读顺序：先看输入类型，再看 buildTableCellElements 的合并与比例逻辑，最后看 buildPresentationPageElements 的过滤和 hitTest 的优先级。
import type {
  PresentationElementBounds,
  PresentationElementNodeType,
  PresentationPageElement,
} from "@/presentation/types.js";

interface PresentationElementCellInput {
  gridSpan: number;
  rowSpan: number;
  hMerge: boolean;
  vMerge: boolean;
  text?: string;
}

interface PresentationElementRowInput {
  height: number;
  cells: readonly PresentationElementCellInput[];
}

// 节点输入是页面元素的唯一来源，包含 id、名称、类型、位置、尺寸以及可选的文本与表格结构。
// nodeType 中的 group 与 unknown 不直接产出元素，前者只提供组内文本的层级归属，后者被整体跳过。
// position/size 使用 x/y/w/h 命名，与输出元素的 bounds 字段不同名，转换只发生在 toBounds 一处。
// columns 与 rows 只在 table 类型上有意义，其他类型携带也不会被读取，不得据此推断类型。
// 改错后果：把 w/h 直接当作 width/height 使用会漏掉命名转换，元素尺寸变成 undefined 并在渲染时塌陷。
export interface PresentationElementNodeInput {
  id: string;
  name: string;
  nodeType: "shape" | "picture" | "table" | "group" | "chart" | "unknown";
  position: { x: number; y: number };
  size: { w: number; h: number };
  text?: string;
  columns?: readonly number[];
  rows?: readonly PresentationElementRowInput[];
}

export interface PresentationGroupTextEntryInput {
  nodeId: string;
  nodePath: string;
  text: string;
  bounds: { x: number; y: number; w: number; h: number };
}

function toBounds(
  node: PresentationElementNodeInput,
): PresentationElementBounds {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.size.w,
    height: node.size.h,
  };
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + Math.max(0, value), 0);
}

// 职责：把 table 节点的行列结构展开为独立单元格元素，供渲染与命中测试按单元格粒度使用。
// 早返回一：缺少 columns 或 rows、或任一长度为 0 时返回空数组，表体仍由调用方单独生成。
// 早返回二：列宽总和或行高总和不为正时同样返回空数组，避免后续除以零得到 Infinity 坐标。
// base 参数已含 slideIndex、slidePart、nodeId 等公共字段，本函数只补齐单元格特有字段与 bounds。
// 函数无副作用且不读外部状态，可对同一节点重复调用；调用方不应依赖其返回数组的引用相等。
function buildTableCellElements(
  node: PresentationElementNodeInput,
  base: Omit<PresentationPageElement, "bounds" | "nodeType">,
): PresentationPageElement[] {
  if (
    !node.columns ||
    !node.rows ||
    node.columns.length === 0 ||
    node.rows.length === 0
  ) {
    return [];
  }
  const columnTotal = sum(node.columns);
  const rowTotal = sum(node.rows.map((row) => row.height));
  if (columnTotal <= 0 || rowTotal <= 0) {
    return [];
  }

  // 偏移量用前缀和表示：第 i 列的起点是前 i 列宽度之和，配合 columnTotal 归一成 0 到 1 的比例。
  // 比例再乘 node.size.w 才得到像素位置，因此列宽总和不等于节点宽度时仍能整体铺满。
  // 行偏移同理依赖行高前缀和，二者都必须使用同一个 sum 口径，否则行列表格会出现累计漂移。
  // 偏移量每次用 `slice` 重算以换取可读性，大表格下 O(n²) 的代价需先确认规模。
  // 易错点：把偏移量当成绝对坐标直接使用会忽略节点自身位置，单元格整体偏移到页面左上。
  const columnOffsets = node.columns.map((_, index) =>
    sum(node.columns?.slice(0, index) ?? []),
  );
  const rowOffsets = node.rows.map((_, index) =>
    sum(node.rows?.slice(0, index).map((row) => row.height) ?? []),
  );

  return node.rows.flatMap((row, rowIndex) => {
    let columnIndex = 0;
    return row.cells.flatMap((cell, cellIndex) => {
      // 列游标 columnIndex 只在成功产出单元格或纵向 continuation 时前进，是整段合并逻辑的唯一状态。
      // 合并 continuation 返回空数组而不生成元素，是因为合并区域由起始单元格一次性覆盖，重复产出会叠影。
      // 横向 continuation 不推进游标：它继续占据与起始格相同的列区间，视觉上由起始格拉伸覆盖。
      // 纵向 continuation 必须推进游标：下一行的同一列需要被跳过，否则后续单元格会写进已合并的列。
      // 改错后果：两种 continuation 处理反了会让同一行的元素整体左移或右移一列，边框与文本对不上网格。
      const gridSpan = Math.max(1, cell.gridSpan || 1);
      if (cell.hMerge || cell.vMerge) {
        // 原因：pptx-renderer 对纵向 merge continuation 仍推进 gridSpan，横向
        // continuation 则不推进；直接使用物理 cellIndex 会把后续 overlay 左移。
        if (cell.vMerge && !cell.hMerge) {
          columnIndex += gridSpan;
        }
        return [];
      }
      const startColumnIndex = columnIndex;
      columnIndex += gridSpan;
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const cellWidth = sum(
        node.columns?.slice(startColumnIndex, startColumnIndex + gridSpan) ??
          [],
      );
      const cellHeight = sum(
        node.rows
          ?.slice(rowIndex, rowIndex + rowSpan)
          .map((item) => item.height) ?? [],
      );
      return [
        {
          ...base,
          nodeType: "table-cell" as const,
          rowIndex,
          cellIndex,
          text: cell.text,
          bounds: {
            x:
              node.position.x +
              ((columnOffsets[startColumnIndex] ?? 0) / columnTotal) *
                node.size.w,
            y:
              node.position.y +
              ((rowOffsets[rowIndex] ?? 0) / rowTotal) * node.size.h,
            width: (cellWidth / columnTotal) * node.size.w,
            height: (cellHeight / rowTotal) * node.size.h,
          },
        },
      ];
    });
  });
}

// 对外主入口：一次调用内完成直接元素、表格单元格与组内文本的合并，返回扁平数组供上层直接消费。
// 输出顺序固定为直接元素在前、组内文本在后，命中测试在 zIndex 相同时依赖该顺序保持稳定。
// zIndex 采用 nodes 的物理下标，被跳过的 group 也占位，因此返回值中的 zIndex 不保证连续。
// table 节点会产出一个表体元素加若干单元格元素，其他类型各产出一个元素，调用方不能假设长度一一对应。
// 函数不修改 options 中的数组与节点对象，只读取字段；传入的只读数组可安全复用。
export function buildPresentationPageElements(options: {
  slideIndex: number;
  slidePart: string;
  nodes: readonly PresentationElementNodeInput[];
  groupTextEntries: readonly PresentationGroupTextEntryInput[];
}): PresentationPageElement[] {
  const directElements = options.nodes.flatMap((node, zIndex) => {
    if (node.nodeType === "group" || node.nodeType === "unknown") {
      return [];
    }
    const nodeType = node.nodeType as Exclude<
      PresentationElementNodeType,
      "table-cell"
    >;
    const base = {
      slideIndex: options.slideIndex,
      slidePart: options.slidePart,
      nodeId: node.id,
      nodeName: node.name,
      nodeType,
      bounds: toBounds(node),
      zIndex,
      ...(node.text ? { text: node.text } : {}),
    } satisfies PresentationPageElement;
    return node.nodeType === "table"
      ? [base, ...buildTableCellElements(node, base)]
      : [base];
  });

  // directIds 用来判断组内文本是否已有对应的直接元素，避免同一节点在结果中出现两份。
  // 集合刻意只排除 group：unknown 节点虽不产出直接元素，但仍计入集合，防止组内文本重复。
  // 这里用 node.id 做键而不是 nodePath，因为直接元素只携带 id，路径无法与之对齐。
  // 去重发生在生成之前而不是生成之后，避免先构造再过滤带来的无用对象与顺序抖动。
  // 改错后果：放宽为包含 group 会让组本身的 id 命中组内文本，整组文本被静默丢弃。
  const directIds = new Set(
    options.nodes
      .filter((node) => node.nodeType !== "group")
      .map((node) => node.id),
  );
  const groupTextElements = options.groupTextEntries.flatMap((entry) => {
    if (directIds.has(entry.nodeId)) {
      return [];
    }
    // 组内文本来自 buildTextIndex，路径形如 slides/{slide}/nodes/{groupId}/children/...，需要从中还原组 id。
    // 优先取 nodes 段之后的一段作为 groupId，兼容嵌套层级；找不到 nodes 段时回退到路径首段。
    // 回退分支是为旧测试与旧调用方保留的兼容面，真实渲染路径不应依赖它。
    // 组 id 用于在 nodes 中定位组节点并取其物理下标作为 zIndex，找不到时归零而不是报错。
    // 改错后果：只取首段会在标准路径下得到 slides，所有组内文本都挤到 zIndex 0 并被其他元素覆盖。
    const pathSegments = entry.nodePath.split("/");
    const nodesSegmentIndex = pathSegments.indexOf("nodes");
    // buildTextIndex 的真实路径是 slides/{slide}/nodes/{groupId}/children/...；
    // 兼容旧测试/调用方的首段 groupId，避免所有组内文本都错误落到 zIndex 0。
    const groupId =
      (nodesSegmentIndex >= 0
        ? pathSegments[nodesSegmentIndex + 1]
        : undefined) ?? pathSegments[0];
    const zIndex = Math.max(
      0,
      options.nodes.findIndex(
        (node) => node.nodeType === "group" && node.id === groupId,
      ),
    );
    return [
      {
        slideIndex: options.slideIndex,
        slidePart: options.slidePart,
        nodeId: entry.nodeId,
        nodePath: entry.nodePath,
        nodeName: "",
        nodeType: "shape" as const,
        text: entry.text,
        bounds: {
          x: entry.bounds.x,
          y: entry.bounds.y,
          width: entry.bounds.w,
          height: entry.bounds.h,
        },
        zIndex,
      },
    ];
  });

  return [...directElements, ...groupTextElements];
}

function containsPoint(
  bounds: PresentationElementBounds,
  point: { x: number; y: number },
) {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height
  );
}

// 命中测试对外契约：给定扁平元素数组与页面坐标，返回最上层命中的元素，未命中返回 null。
// 边界判定是闭区间，左右上下四边都算命中，因此相邻元素共享的边框会同时进入候选集。
// 候选排序先比是否为 table-cell，再比 zIndex 降序；单元格优先是为了让表格内点击落到具体格子。
// 同 zIndex 时依赖稳定排序，直接元素排在组内文本之前，因此命中结果优先取直接元素。
// 函数只读入参，不修改 elements 顺序；调用方传入的数组顺序不会因为排序而改变。
export function hitTestPresentationElement(
  elements: readonly PresentationPageElement[],
  point: { x: number; y: number },
): PresentationPageElement | null {
  const matches = elements.filter((element) =>
    containsPoint(element.bounds, point),
  );
  return (
    matches.sort((left, right) => {
      const cellPriority =
        Number(right.nodeType === "table-cell") -
        Number(left.nodeType === "table-cell");
      return cellPriority || right.zIndex - left.zIndex;
    })[0] ?? null
  );
}
