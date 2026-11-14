// INV-01 [并发] workspace 键的唯一来源是 buildWhiteboardWorkspaceKey（workspaceIdentity 去空白优先，否则 workspacePath）；守住它：updateBoard 与 getBoard 各自算出的 workspaceKey。任一路径改用 workspacePath 直取，远程会话与本地同路径白板会互相覆盖文档。
// INV-02 [事务] boardIds 与 boardsById 是同一集合的两种视图，必须在同一次 set 内一起更新；守住它：createBoard 的 set 回调。只写 boardsById 时列表不出现新块、existingNames 也读不到它，默认名可能与既有块撞名。
// INV-03 [并发] createBoard 先以 get() 快照算名，再以 set 回调里的最新 state 追加；守住它：第 97 行与第 105-119 行的两次读取。改成 get() 后直接 set 整份 workspaces，同一 tick 连续创建会彼此覆盖，前一块从 boardIds 消失。
// INV-04 createBoard 返回的必须是与落库为同一份的 board 引用；守住它：末尾 return board 与 set 内写入的同一变量。若把构造移进 set 回调而返回外层对象，调用方按返回 id 立即 rename 会命中缺失分支，改名静默失效。
// INV-05 getWorkspaceState 的兜底对象（空 boardIds 加空 boardsById）每次新建且只读；守住它：?? 后的字面量。往兜底对象里 push 或赋值不会进入 store，下一次调用即丢失。
// INV-06 [失败路径] updateBoard 在目标 board 缺失时返回原 workspaces 引用；守住它：if (!board) 分支的返回值。改成新建空对象会让未知 boardId 凭空留下空工作区，并让每次无匹配更新都更换引用。
// INV-07 [事务] updateBoard 对 workspaces、目标 workspace、boardsById 三层做浅拷贝，只替换 updater 的结果；守住它：return 里的三层展开。任一层就地赋值会破坏 selector 的引用比较，画布拿到旧引用不重绘。
// INV-08 [权衡] updateBoard 不维护 boardIds，只改已存在的文档；守住它：写回对象里没有 boardIds 字段。在这里补列表维护会让创建与更新出现两条写入规则，块顺序取决于哪条路径先跑。
// INV-09 [失败路径] renameBoard 先 trim 再判空，空名直接返回不 set；守住它：第 124-127 行。空串落库会让侧栏与画布标题同时失去可读文本，该白板再也无法按名字辨认。
// INV-10 renameBoard 写回的是 trim 后的 name；守住它：updater 里引用的局部 name。写回原始入参会让首尾空白进入名称集合，唯一命名比对与显示宽度都失真。
// INV-11 [事务] addStroke 追加笔画的同时清空 undoneStrokes；守住它：第 146-147 行的两个字段。保留重做栈会让新笔画之后还能重做更早的笔画，层叠顺序与视觉结果错乱。
// INV-12 [并发] addStroke 用展开生成新的 strokes 数组；守住它：updater 返回对象里的 strokes 字段。就地 push 让数组引用不变，订阅 strokes 的画布收不到变更，用户以为笔没画上。
// INV-13 [失败路径] undoStroke 与 redoStroke 在对应栈为空时返回原 board；守住它：两个 if (!stroke) 分支。改成返回浅拷贝后，空点击也会产出新 board 引用，单块 selector 误判变更并重绘。
// INV-14 [事务] 撤销取 strokes 末尾移入 undoneStrokes，重做取 undoneStrokes 末尾移回 strokes；守住它：两处 at(-1) 与两处 slice。任一侧改成取头部，重做得到的是最早的笔画，撤销序列整体反转。
// INV-15 [事务] clearBoard 同时清空 strokes 与 undoneStrokes；守住它：第 199-200 行。只清 strokes 时，一次重做就能把已清空的画布重新填满，用户会认为清空没有生效。
// INV-16 [资源] getBoard 是纯读入口，只用 get() 与可选链，缺失返回 null，不补建工作区；守住它：第 206-209 行。只读路径若写 state，会沿订阅链触发全局重渲染，并把访问过的键永久留在 workspaces。
// INV-17 [失败路径] E2E 桥只在 shouldExposeE2EStoreBridge 为真时挂到 window；守住它：第 220-222 行的 if 与其中的赋值。该判定要求 VITE_ZCODE_E2E_STORE_BRIDGE 为 1 且存在 window，放宽条件等于把可写全局 store 交给产品测试环境的任意脚本。
// INV-18 [权衡] store 只持内存文档，不接持久化与异步写回；守住它：全部动作都只调用同步 set。若在此处插入落盘，createBoard 的同步返回与写入顺序会分叉，加载失败也没有回滚点。
//
// 模块职责：白板 UI 的唯一内存状态源——按 workspace 键维护 boardIds 顺序与 boardsById 文档，并提供创建、改名、增笔、撤销、重做、清空与只读查询。
// 状态所有权：workspace 键由 workspaceIdentity 或 workspacePath 决定，boardIds 顺序与文档内容都归本 store，组件只通过 selector 读取，不持有第二份。
// 阅读顺序：WhiteboardWorkspaceState → getWorkspaceState 与 updateBoard → store 工厂的七个动作 → 末尾的 E2E 桥接开关。
import { create } from "zustand";
import {
  buildWhiteboardWorkspaceKey,
  createWhiteboardDocument,
  type WhiteboardDocument,
  type WhiteboardStroke,
} from "@/lib/whiteboard.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";

// 单个 workspace 的内存投影：boardIds 负责顺序与存在性，boardsById 负责文档内容，两者是同一集合的两种视图。
// [事务] 两者必须在同一次 set 里一起变更；只写 boardsById 会让 existingNames 读到空串，默认名可能与既有块撞名。
// boardIds 的顺序即创建顺序，读取方按它渲染列表；不要按 boardsById 的键序替代，否则排序口径出现两份。
// 文档字段全部归 WhiteboardDocument 定义，本类型不额外派生 strokes 或名称缓存，避免与库内结构分叉。
interface WhiteboardWorkspaceState {
  boardIds: string[];
  boardsById: Record<string, WhiteboardDocument>;
}

interface WhiteboardStoreState {
  workspaces: Record<string, WhiteboardWorkspaceState>;
  createBoard: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    defaultNamePrefix: string;
  }) => WhiteboardDocument;
  renameBoard: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    boardId: string;
    name: string;
  }) => void;
  addStroke: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    boardId: string;
    stroke: WhiteboardStroke;
  }) => void;
  undoStroke: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    boardId: string;
  }) => void;
  redoStroke: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    boardId: string;
  }) => void;
  clearBoard: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    boardId: string;
  }) => void;
  getBoard: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    boardId: string;
  }) => WhiteboardDocument | null;
}

// 按 workspace 键取子状态，缺失时给出空 boardIds 与空 boardsById；键由 buildWhiteboardWorkspaceKey 统一计算，调用方不要自己拼。
// [权衡] 兜底对象每次调用新建，不是缓存；它只服务读路径，写入必须经 set 重建 workspaces，往兜底对象里 push 会随调用一起丢弃。
// 返回的是 state 内的原引用，调用方只能读；在外部改 boardIds 会绕过 set，订阅者收不到通知。
// 缺失与空工作区在这里不可区分，这是刻意的：新建工作区由 createBoard 显式落库，读路径不产生副作用。
function getWorkspaceState(
  state: WhiteboardStoreState,
  workspaceKey: string,
): WhiteboardWorkspaceState {
  return state.workspaces[workspaceKey] ?? { boardIds: [], boardsById: {} };
}

// 所有改已存在文档的动作共用的纯更新器：算键、取目标 board、交给 updater，再逐层浅拷贝写回。
// [失败路径] board 缺失时返回原 workspaces 引用；守住第 76 行。改成新建空对象会让未知 boardId 凭空留下空工作区，并让无匹配更新每次更换引用。
// [事务] workspaces、目标 workspace 与 boardsById 三层展开复制，只替换 updater 的结果；任一层就地赋值会破坏 selector 的引用比较。
// [并发] 依赖 set 的函数式写法读取最新 state，同一 tick 内连续两次更新不会基于同一份旧快照互相覆盖。
// [权衡] 这里不碰 boardIds：更新只改内容，不新增或删除块；在更新路径补列表维护会让创建与更新出现两条写入规则。
// updater 返回原 board 时三层外壳仍会重建——单块 selector 不受影响，订阅整个 workspaces 的组件会重渲染。
// boardId 只作 boardsById 的键，不参与 workspace 键计算；混用两者会让同一块在切换身份后查不到文档。
function updateBoard(
  state: WhiteboardStoreState,
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    boardId: string;
    updater: (board: WhiteboardDocument) => WhiteboardDocument;
  },
): Pick<WhiteboardStoreState, "workspaces"> {
  const workspaceKey = buildWhiteboardWorkspaceKey(params);
  const workspaceState = getWorkspaceState(state, workspaceKey);
  const board = workspaceState.boardsById[params.boardId];
  if (!board) {
    return { workspaces: state.workspaces };
  }

  return {
    workspaces: {
      ...state.workspaces,
      [workspaceKey]: {
        ...workspaceState,
        boardsById: {
          ...workspaceState.boardsById,
          [params.boardId]: params.updater(board),
        },
      },
    },
  };
}

// 工厂同时拿到 set 与 get：写走函数式 set，读走 get，动作内部不缓存外部 state 引用。
// 初始 workspaces 为空对象；空态由读取方的兜底与 null 表达，不预置演示白板。
// 七个动作即全部对外能力：创建、改名、增笔、撤销、重做、清空与只读查询，新增能力应扩展接口而不是旁路写 state。
// 所有动作的首个参数都带 workspacePath 与可选 workspaceIdentity，原样转交键构造函数，动作层不做路径规范化。
// [权衡] 动作全部同步返回：createBoard 直接给出文档，其余无返回值；异步写回不属于本 store 的职责。
export const useWhiteboardStore = create<WhiteboardStoreState>()((set, get) => ({
  workspaces: {},
  // 两次读取的分工：先用 get() 快照收集现有名称生成文档，再在 set 回调里用最新 state 追加。
  // [并发] 不能在 get() 之后直接 set 整份 workspaces：同一 tick 连续创建会以旧快照覆盖，前一块从 boardIds 消失而 boardsById 仍残留。
  // existingNames 按 boardIds 顺序映射文档名，缺文档时退回空串；默认名唯一性依赖这条映射不跳过任何已存在块。
  // 文档 id 由 createWhiteboardDocument 生成，本动作不校验重复；boardIds 与 boardsById 在同一次 set 内一起写入。
  // 返回写入 store 的同一份 board 引用；若把构造挪进 set 回调再返回外层对象，调用方手里的 id 与落库 id 不一致，随后改名会静默无效。
  createBoard: (params) => {
    const workspaceKey = buildWhiteboardWorkspaceKey(params);
    const workspaceState = getWorkspaceState(get(), workspaceKey);
    const board = createWhiteboardDocument({
      defaultNamePrefix: params.defaultNamePrefix,
      existingNames: workspaceState.boardIds.map(
        (boardId) => workspaceState.boardsById[boardId]?.name ?? "",
      ),
    });

    set((state) => {
      const currentWorkspaceState = getWorkspaceState(state, workspaceKey);
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceKey]: {
            boardIds: [...currentWorkspaceState.boardIds, board.id],
            boardsById: {
              ...currentWorkspaceState.boardsById,
              [board.id]: board,
            },
          },
        },
      };
    });

    return board;
  },
  // 先 trim 再判空：只有空白字符的输入视为取消，直接返回且不触发 set。
  // [失败路径] 空名若落库，侧栏与画布标题同时失去可读文本，用户无法再从列表辨认这块白板。
  // 写回 trim 后的 name 而非原始入参；调用方不必预处理，也不应在别处再存一份未裁剪的名字。
  // 改名经 updateBoard 的 updater，只改 name 与 updatedAt；strokes 与 undoneStrokes 原样保留，不因改名丢失撤销栈。
  renameBoard: (params) => {
    const name = params.name.trim();
    if (!name) {
      return;
    }

    set((state) =>
      updateBoard(state, {
        ...params,
        updater: (board) => ({
          ...board,
          name,
          updatedAt: Date.now(),
        }),
      }),
    );
  },
  // `commitStroke` 追加并清空 `redoStack`；撤销与重做只在两条栈之间搬移最后一项。
  // [事务] 新笔画必须清空 undoneStrokes；守住第 147 行。保留重做栈会让更早的旧笔画在新笔画之后被重做，层叠顺序与视觉结果错乱。
  // [并发] strokes 用展开生成新数组；守住 updater 返回对象里的 strokes 字段。就地 push 让引用不变，订阅 strokes 的画布收不到变更。
  // [失败路径] 两条栈都从末尾取值；守住两处 at(-1) 与空栈时返回原 board 的分支。空点击因此不产生新 board 引用。
  // [事务] 撤销把末尾笔画从 strokes 移到 undoneStrokes，重做反向搬回；任一侧改成取头部，重做会得到最早的笔画。
  // 撤销与重做都更新 updatedAt：内容虽回到旧状态，修改时间仍应反映最近一次操作，供列表排序使用。
  // 一次拖拽只提交一条 WhiteboardStroke，动作层不合并点集；点集由调用方在提交时定稿。
  addStroke: (params) => {
    set((state) =>
      updateBoard(state, {
        ...params,
        updater: (board) => ({
          ...board,
          strokes: [...board.strokes, params.stroke],
          undoneStrokes: [],
          updatedAt: Date.now(),
        }),
      }),
    );
  },
  undoStroke: (params) => {
    set((state) =>
      updateBoard(state, {
        ...params,
        updater: (board) => {
          const stroke = board.strokes.at(-1);
          if (!stroke) {
            return board;
          }

          return {
            ...board,
            strokes: board.strokes.slice(0, -1),
            undoneStrokes: [...board.undoneStrokes, stroke],
            updatedAt: Date.now(),
          };
        },
      }),
    );
  },
  redoStroke: (params) => {
    set((state) =>
      updateBoard(state, {
        ...params,
        updater: (board) => {
          const stroke = board.undoneStrokes.at(-1);
          if (!stroke) {
            return board;
          }

          return {
            ...board,
            strokes: [...board.strokes, stroke],
            undoneStrokes: board.undoneStrokes.slice(0, -1),
            updatedAt: Date.now(),
          };
        },
      }),
    );
  },
  // 清空同时重置 strokes 与 undoneStrokes；守住第 199-200 行。只清前者时，一次重做就能把已清空的画布重新填满。
  // getBoard 是纯读入口：get() 加可选链取目标文档，缺失返回 null，不补建工作区也不写 state。
  // [资源] 只读路径一旦写 state，会沿订阅链触发全局重渲染，并把访问过的键永久留在 workspaces，内存随访问路径增长。
  // 查询键与写入键同源，都由 buildWhiteboardWorkspaceKey 计算；任一侧改用 workspacePath 直取，远程与本地同路径会读到彼此的文档。
  // [失败路径] 末尾 E2E 桥只在 shouldExposeE2EStoreBridge 为真时挂到 window；守住第 220-222 行。判定要求 VITE_ZCODE_E2E_STORE_BRIDGE 为 1 且存在 window，放宽后产品测试环境会暴露可写全局 store。
  // [权衡] store 只持内存文档，不接持久化与异步写回；若在此处加落盘，createBoard 的同步返回与写入顺序会分叉，加载失败也没有回滚点。
  clearBoard: (params) => {
    set((state) =>
      updateBoard(state, {
        ...params,
        updater: (board) => ({
          ...board,
          strokes: [],
          undoneStrokes: [],
          updatedAt: Date.now(),
        }),
      }),
    );
  },
  getBoard: (params) => {
    const workspaceKey = buildWhiteboardWorkspaceKey(params);
    return get().workspaces[workspaceKey]?.boardsById[params.boardId] ?? null;
  },
}));

type WhiteboardStoreE2EBridge = typeof useWhiteboardStore;

declare global {
  interface Window {
    __whiteboardStoreE2E?: WhiteboardStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // E2E 诊断入口必须由 WDIO 显式打开，不能复用 ZCODE_ENV=test，避免产品测试环境暴露可变全局 store。
  window.__whiteboardStoreE2E = useWhiteboardStore;
}
