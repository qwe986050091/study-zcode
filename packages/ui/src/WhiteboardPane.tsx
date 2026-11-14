// WhiteboardPane 是白板浮层的主视图：把 canvas 上的指针手势翻译成笔画，写入白板 store，并提供命名与工具条。
// 本文件只做输入采集与渲染调度：几何换算、撤销重做、按 workspace 分仓都归 store 与 lib/whiteboard 负责。
// 不负责：笔画落盘与跨窗口同步、白板的新建与删除、addToChat 的实际派发、笔画命中判定的实现。
//
// INV 不变量（INV-01 ~ INV-15，任一破坏都会在线上表现为可复现故障）：
// INV-01 断言：未落笔的笔画只存在于 draftStrokeRef，绝不提前写入 store —— 守住它的位置：handlePointerDown 与 handlePointerMove —— 改错故障：撤销一次只回退一个采样点，历史里塞满几十条半成品笔画。
// INV-02 断言：只有 activePointerIdRef 与事件 pointerId 相同才允许追加点 —— 守住它的位置：handlePointerMove 首行守卫 —— 改错故障：双指同时按下时两笔互相串点，画面出现跨屏长线。
// INV-03 断言：落笔必须要求 button 为 0 —— 守住它的位置：handlePointerDown 的 event.button 判断 —— 改错故障：右键或触控笔侧键按下就生成笔画，用户调出菜单时留下杂线。
// INV-04 断言：落笔必须 setPointerCapture，且抬起、取消、丢失捕获三条路径都要释放 —— 守住它的位置：handlePointerDown 与 finishPointerStroke —— 改错故障：指针滑出画布后事件中断，笔画卡在半空且后续手势全部失效。
// INV-05 断言：结束笔画时先清 activePointerIdRef 与 draftStrokeRef 再提交 —— 守住它的位置：finishPointerStroke 的赋值顺序 —— 改错故障：事件重入把同一条笔画提交两次，撤销一步回退两笔。
// INV-06 断言：canvas 位图尺寸等于 board 逻辑尺寸乘 max(1, devicePixelRatio) —— 守住它的位置：renderCanvas 的 targetWidth 与 targetHeight —— 改错故障：高分屏线条发虚，窗口缩放后笔迹与指针位置错开。
// INV-07 断言：只有尺寸真正变化时才写 canvas.width 与 canvas.height —— 守住它的位置：renderCanvas 的比较分支 —— 改错故障：每帧无条件赋值会清空位图，表现为画面闪烁、当前笔画只剩末点。
// INV-08 断言：坐标换算用 getBoundingClientRect 的 CSS 尺寸，不能用位图尺寸 —— 守住它的位置：getCanvasPoint 的除法分母 —— 改错故障：高 DPI 下笔迹整体缩到左上角四分之一区域。
// INV-09 断言：换算结果必须夹在 0 到 board.width 与 board.height 之间 —— 守住它的位置：getCanvasPoint 的两次 Math.min/Math.max —— 改错故障：捕获期间越界点写进笔画，导出图片被拉伸变形。
// INV-10 断言：rect 宽高为 0 时返回 null 而不是 0,0 —— 守住它的位置：getCanvasPoint 的 rect 守卫 —— 改错故障：隐藏状态下的首笔写入未定义坐标，整条笔画不可见且污染历史。
// INV-11 断言：画布一律全量重绘（文档加草稿），不做增量修补 —— 守住它的位置：renderCanvas 调 drawWhiteboardDocument —— 改错故障：撤销或换色后旧像素残留，出现擦不掉的鬼影。
// INV-12 断言：board 变化时必须先清 draftStrokeRef 再重绘 —— 守住它的位置：第一个 useEffect 的两行顺序 —— 改错故障：切板后旧草稿画到新白板上，用户以为刚画的内容丢了。
// INV-13 断言：命名输入框是本地草稿，空字符串不写回 store —— 守住它的位置：onChange 与 onBlur 的 trim 判断 —— 改错故障：用户清空输入时白板名被写成空串，列表里出现无法辨认的条目。
// INV-14 断言：所有 store 写操作都必须同时携带 workspacePath 与 workspaceIdentity —— 守住它的位置：addStroke、renameBoard、undoStroke 等调用参数 —— 改错故障：远程会话的笔画写进同名本地目录，刷新后整板笔迹消失。
// INV-15 断言：board 缺失的早退必须位于全部 hook 之后 —— 守住它的位置：组件尾部 if (!board) 分支 —— 改错故障：白板从无到有时 hooks 数量变化，React 直接抛渲染错误导致整块面板白屏。
//
// 渲染链路总览：指针事件只改 draftStrokeRef，随后 renderCanvas 用 drawWhiteboardDocument 全量重绘，
// 落笔结束时才把草稿交给 addStroke，所以画布上的「当前笔画」始终不是 store 里的权威状态。
// 设备像素比只在 renderCanvas 内换算，组件其余部分一律使用 board 的逻辑坐标，两套坐标系不要混用。
//
import { useCallback, useEffect, useRef, useState, type PointerEventHandler } from "react";
import {
  EraserIcon,
  ImagePlusIcon,
  PaletteIcon,
  PencilIcon,
  Redo2Icon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  WHITEBOARD_DEFAULT_COLOR,
  createWhiteboardStroke,
  dispatchWhiteboardAddToChat,
  drawWhiteboardDocument,
  type WhiteboardPoint,
  type WhiteboardStroke,
  type WhiteboardTool,
} from "@/lib/whiteboard.js";
import { buildWhiteboardWorkspaceKey } from "@/lib/whiteboard.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";

// [契约] 这六个色值是画笔与橡皮共用的调色板，橡皮不换色，擦除效果由 lib 里的合成模式实现
// 数组顺序即界面顺序，sm 断点以下整块隐藏，色板不渲染不影响已选颜色继续生效
// 不要在这里追加透明色或白色：白板底色是纯白，这类笔画导出后与空白无法区分
// 新增色值需同步设计规范里的调色板口径，否则深浅主题下的对比度检查会失败
const WHITEBOARD_SWATCHES = ["#111827", "#2563eb", "#16a34a", "#dc2626", "#ca8a04", "#7c3aed"];

export function WhiteboardPane({
  workspacePath,
  workspaceIdentity,
  boardId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  boardId: string;
}) {
  const { intl } = useZCodeIntl();
  // [契约] 身份 key 必须由 buildWhiteboardWorkspaceKey 生成，组件内不得手写 workspaceIdentity 拼接
  // 远程会话的 identity 与本地路径不同，只按路径取仓会把远程笔迹写进本地同名目录
  // key 变化等价于换了一整个 store 分仓，下面的 selector 会返回 undefined，走缺失分支而不是崩溃
  // 不要用 useMemo 缓存这个 key：函数只是字符串拼接，缓存反而在 identity 切换时留下旧值
  const workspaceKey = buildWhiteboardWorkspaceKey({ workspacePath, workspaceIdentity });
  // [契约] selector 只取当前白板对象，不取整个 workspaces，避免其它白板变动也触发本面板重渲染
  // board 可能为 undefined：分仓尚未初始化或 boardId 已被删除，组件不得在此补建默认白板
  // 拿到的是 store 内引用，每次 addStroke 都会生成新的 strokes 数组，这正是画布重绘的触发信号
  // 不要在 selector 内做 strokes.map 之类的派生，Zustand 会因每次新数组引用而无限重渲染
  const board = useWhiteboardStore((state) => state.workspaces[workspaceKey]?.boardsById[boardId]);
  const renameBoard = useWhiteboardStore((state) => state.renameBoard);
  const addStroke = useWhiteboardStore((state) => state.addStroke);
  const undoStroke = useWhiteboardStore((state) => state.undoStroke);
  const redoStroke = useWhiteboardStore((state) => state.redoStroke);
  const clearBoard = useWhiteboardStore((state) => state.clearBoard);
  // [资源] canvasRef 指向真实 DOM 节点，只在 renderCanvas 与 JSX 绑定处读取，不在渲染期写入
  // draftStrokeRef 与 activePointerIdRef 是高频可变值，放进 state 会让每个采样点触发一次重渲染
  // 三个 ref 的生命周期与组件一致，切板时只清内容不重建节点，所以换板要手动置空草稿
  // 不要把 activePointerIdRef 改成 state：指针移动的闭包必须立刻读到最新值，state 会滞后一帧
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftStrokeRef = useRef<WhiteboardStroke | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const [tool, setTool] = useState<WhiteboardTool>("pen");
  const [color, setColor] = useState(WHITEBOARD_DEFAULT_COLOR);
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [nameDraft, setNameDraft] = useState("");

  // [契约] renderCanvas 是唯一重绘入口，指针移动、切板、落笔收尾都必须走它，不要另加快照贴图快路径
  // 默认参数取 draftStrokeRef.current，调用方显式传 null 才表示「本次明确不要草稿」
  // board 或 canvas 缺失时静默返回：首帧 ref 还没挂载，此时抛错会打断整棵树的挂载流程
  // pixelRatio 最小取 1，防止个别环境 devicePixelRatio 为 0 时算出 0 宽位图
  // 依赖只列 board：canvasRef 是 ref 不参与依赖，加进去会破坏 useCallback 的引用稳定性
  const renderCanvas = useCallback(
    (draftStroke: WhiteboardStroke | null = draftStrokeRef.current) => {
      if (!board) {
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const targetWidth = Math.round(board.width * pixelRatio);
      const targetHeight = Math.round(board.height * pixelRatio);
      // [资源] 给 canvas.width 或 height 赋值会清空位图并重置绘图状态，所以必须先比较再写
      // 不比较而每帧赋值，等于每帧清屏：表现为笔画闪烁、当前草稿只剩最后一个采样点
      // 改完尺寸没有重建上下文，因为 drawWhiteboardDocument 每次都会按 scale 重新设置变换
      // 位图尺寸用 Math.round 取整，避免小数尺寸被浏览器截断后右侧或底部露出一像素白边
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
      }

      // [失败路径] getContext 可能返回 null（上下文耗尽或被浏览器回收），此处静默返回而不是抛错
      // 不要把上下文缓存进 ref：尺寸变化后旧上下文仍可用，缓存反而掩盖了本次获取失败
      // 每次重绘只取一次上下文，循环或逐点调用 getContext 会显著拖慢高频指针移动
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      drawWhiteboardDocument(context, board, {
        draftStroke,
        scale: pixelRatio,
      });
    },
    [board],
  );

  // [契约] 这个 effect 只负责「换板」：先把草稿置空，再重绘，两步顺序不能交换
  // 若先重绘再清 ref，旧白板的草稿会被画到新板上，用户会误以为刚画的内容被吞掉
  // 依赖里同时列 board 与 renderCanvas，后者已含 board，这一项只是显式表达依赖关系
  // 不要在这里顺手清历史或调用 addStroke，切板不等于丢弃数据，历史归 store 管
  useEffect(() => {
    draftStrokeRef.current = null;
    renderCanvas(null);
  }, [board, renderCanvas]);

  useEffect(() => {
    // [契约] 名称是双向的：store 变化同步到本地草稿，本地输入再逐字写回 store
    // 依赖拆成 board?.id 与 board?.name，而不是整个 board 对象，否则每画一笔都会重置输入框
    // 把 board 放进依赖会让用户正在输入的名字在下一笔时被回填成旧值，光标也会跳位
    // 被删除的白板 name 为 undefined，这里落到空串，避免输入框里出现 undefined 字样
    setNameDraft(board?.name ?? "");
  }, [board?.id, board?.name]);

  // [契约] 坐标换算是 CSS 像素到白板逻辑坐标的唯一入口，别处不要重复写这套比例运算
  // 分子用 event.clientX 减 rect.left，改成 offsetX 会在指针捕获后给出错误的相对值
  // 分母除以 rect.width 而不是 canvas.width：前者是布局尺寸，后者是乘过像素比的位图尺寸
  // 先夹取再返回，指针捕获期间指针可能移出画布，放任越界点会让导出图片被拉伸
  // 返回 null 表示本次事件不可用，调用方必须直接放弃，不要用 0,0 兜底
  const getCanvasPoint = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): WhiteboardPoint | null => {
      if (!board) {
        return null;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }

      // 夹取上界用 board.width 与 board.height，白板逻辑坐标与显示尺寸由此彻底解耦
      // Math.max(0, ...) 在内层先保证负值归零，顺序反过来会让越界值在两端都算错
      // 不要在这里四舍五入：lib 的平滑算法按浮点采样，取整会让快速划动出现折线
      // 两轴共用同一个比例基准，分开计算宽高比会把笔画在非 16:10 容器里压扁
      return {
        x: Math.min(
          board.width,
          Math.max(0, ((event.clientX - rect.left) / rect.width) * board.width),
        ),
        y: Math.min(
          board.height,
          Math.max(0, ((event.clientY - rect.top) / rect.height) * board.height),
        ),
      };
    },
    [board],
  );

  const handlePointerDown: PointerEventHandler<HTMLCanvasElement> = useCallback(
    (event) => {
      // [契约] 只响应主键 button 0，触摸与触控笔上报的同样是 0，右键与侧键必须排除
      // 排除右键还依赖这里不提前 preventDefault，否则画布上的右键菜单会被一并吞掉
      // board 为空时直接返回，避免在已删除的白板上生成永远无法提交的草稿
      // 不要在守卫之前 setPointerCapture，否则被拒绝的按键也会绑定指针并吞掉后续手势
      if (!board || event.button !== 0) {
        return;
      }

      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }

      event.preventDefault();
      // [资源] 捕获后所有指针移动都会投递到 canvas，即使指针已经滑出画布边界
      // 必须在 preventDefault 之后调用，否则移动端可能同时触发页面滚动与手势缩放
      // 捕获与释放必须成对：释放点有抬起、取消、丢失捕获三处，漏一处会让后续手势全部失效
      // 这里与 activePointerIdRef 同时写入，后者是判断「这一笔是否属于我」的唯一依据
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointerIdRef.current = event.pointerId;
      // [契约] 橡皮笔宽取画笔宽度的三倍且至少 14，保证小笔宽下仍能一次擦掉明显痕迹
      // 不要给橡皮单独记颜色：擦除靠 lib 的合成模式，改这里会污染历史里已存的颜色
      // 初始 points 只有按下点，后续移动一律替换整个对象，不要 push 进原数组
      // 笔画 id 由 createWhiteboardStroke 生成，组件不参与，避免同毫秒内两笔撞 id
      draftStrokeRef.current = createWhiteboardStroke({
        color,
        points: [point],
        tool,
        width: tool === "eraser" ? Math.max(14, strokeWidth * 3) : strokeWidth,
      });
      renderCanvas();
    },
    [board, color, getCanvasPoint, renderCanvas, strokeWidth, tool],
  );

  // [并发] 只认 activePointerIdRef 命中的指针，第二根手指的移动事件直接丢弃
  // 这里刻意不做节流：每个采样点都要进笔画，抽稀会把快速划动的转折削平
  // 不要在这里调用 addStroke，落笔未结束时写库会让撤销栈里出现半条笔画
  // draftStrokeRef 为空说明这一笔已经结束（例如丢失捕获），静默返回即可
  const handlePointerMove: PointerEventHandler<HTMLCanvasElement> = useCallback(
    (event) => {
      if (!board || activePointerIdRef.current !== event.pointerId || !draftStrokeRef.current) {
        return;
      }

      const point = getCanvasPoint(event);
      if (!point) {
        return;
      }

      event.preventDefault();
      // [权衡] 用对象展开替换整个笔画而不是原地改数组，保证引用变化能被渲染链路观察到
      // points 同样用展开复制，历史里已存的旧引用不会被后续移动污染
      // 复制是线性开销，超长笔画末端会有些卡顿；这是换取不可变语义的代价，不要改成 push
      // 重绘紧跟其后，若把这次重绘挪进 effect，快速划动会出现肉眼可见的延迟
      draftStrokeRef.current = {
        ...draftStrokeRef.current,
        points: [...draftStrokeRef.current.points, point],
      };
      renderCanvas();
    },
    [board, getCanvasPoint, renderCanvas],
  );

  // [资源] 三条结束路径共用本函数：pointerup、pointercancel、lostpointercapture
  // 必须先清 activePointerIdRef 与 draftStrokeRef 再提交，否则事件重入会重复写同一条笔画
  // 三种路径可能连着触发两次，靠开头的 pointerId 判等把第二次挡掉
  // 笔画没有任何采样点时只清屏不提交，避免历史里出现不可见的空笔画
  // 这里不等待 store 写入：addStroke 是同步状态更新，等它会让抬起手感发粘
  const finishPointerStroke = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activePointerIdRef.current !== event.pointerId) {
        return;
      }

      const stroke = draftStrokeRef.current;
      activePointerIdRef.current = null;
      draftStrokeRef.current = null;
      // [失败路径] 先判 hasPointerCapture 再释放：丢失捕获那条路径上捕获已经消失，直接释放会抛错
      // 释放失败不应阻断提交，所以用判断而不是 try/catch，保持这条路径不产生异常
      // 不要在释放之后再读 currentTarget 的尺寸或上下文，节点可能已被切板卸载
      // 取消与丢失捕获同样提交笔画：用户的手势已经表达了完整一笔，丢弃会让画面回跳
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (!stroke || stroke.points.length === 0) {
        renderCanvas(null);
        return;
      }

      // [事务] 笔画的唯一权威写入点是 store 的 addStroke，组件内不保留任何本地历史副本
      // store 写入时会同时清空 undoneStrokes，重做按钮在同一次更新里失效
      // workspacePath 与 workspaceIdentity 必须一起传，否则远程会话的笔画会落到本地仓
      // 写入后不主动调用 renderCanvas：board 引用变化会触发 effect 重绘，此时草稿已清空
      addStroke({
        boardId,
        stroke,
        workspaceIdentity,
        workspacePath,
      });
    },
    [addStroke, boardId, renderCanvas, workspaceIdentity, workspacePath],
  );

  if (!board) {
    return (
      <div className="flex h-full items-center justify-center bg-panel px-4 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "whiteboard.missing" })}
      </div>
    );
  }

  // 清空按钮复用 canUndo：空白板上没有可清内容，语义与撤销一致
  // canRedo 读 undoneStrokes，只有撤销过才可重做，不要用 strokes 是否为空反推
  // 这两个值每次渲染重算即可，不要缓存进 state，多了会与 store 短暂不一致
  const canUndo = board.strokes.length > 0;
  const canRedo = board.undoneStrokes.length > 0;
  const addToChatLabel = intl.formatMessage({ id: "whiteboard.addToChat" });

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel text-foreground">
      <div className="flex min-h-10 items-center gap-2 border-b border-border px-2">
        <Input
          value={nameDraft}
          onBlur={() => {
            if (!nameDraft.trim()) {
              setNameDraft(board.name);
            }
          }}
          onChange={(event) => {
            const nextName = event.target.value;
            setNameDraft(nextName);
            if (!nextName.trim()) {
              return;
            }
            renameBoard({
              boardId,
              name: nextName,
              workspaceIdentity,
              workspacePath,
            });
          }}
          aria-label={intl.formatMessage({ id: "whiteboard.nameLabel" })}
          className="max-w-48"
        />
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <ControlHintTooltip title={addToChatLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              aria-label={addToChatLabel}
              onClick={() =>
                dispatchWhiteboardAddToChat({
                  boardId,
                  workspaceIdentity,
                  workspacePath,
                })
              }
            >
              <ImagePlusIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip title={intl.formatMessage({ id: "whiteboard.tool.pen" })}>
            <Button
              type="button"
              variant={tool === "pen" ? "secondary" : "ghost"}
              size="icon-md"
              aria-pressed={tool === "pen"}
              aria-label={intl.formatMessage({ id: "whiteboard.tool.pen" })}
              onClick={() => setTool("pen")}
            >
              <PencilIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip title={intl.formatMessage({ id: "whiteboard.tool.eraser" })}>
            <Button
              type="button"
              variant={tool === "eraser" ? "secondary" : "ghost"}
              size="icon-md"
              aria-pressed={tool === "eraser"}
              aria-label={intl.formatMessage({ id: "whiteboard.tool.eraser" })}
              onClick={() => setTool("eraser")}
            >
              <EraserIcon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <div className="hidden items-center gap-1 sm:flex">
            {WHITEBOARD_SWATCHES.map((swatch) => (
              <ControlHintTooltip
                key={swatch}
                title={intl.formatMessage({ id: "whiteboard.color" })}
              >
                <button
                  type="button"
                  aria-label={intl.formatMessage({ id: "whiteboard.color" })}
                  aria-pressed={color === swatch}
                  onClick={() => setColor(swatch)}
                  className={cn(
                    "size-5 rounded-full border border-border transition-shadow",
                    color === swatch && "ring-2 ring-brand ring-offset-1 ring-offset-panel",
                  )}
                  style={{ backgroundColor: swatch }}
                />
              </ControlHintTooltip>
            ))}
          </div>
          <ControlHintTooltip title={intl.formatMessage({ id: "whiteboard.strokeWidth" })}>
            <input
              type="range"
              min="2"
              max="18"
              value={strokeWidth}
              aria-label={intl.formatMessage({ id: "whiteboard.strokeWidth" })}
              onChange={(event) => setStrokeWidth(Number(event.target.value))}
              className="hidden h-7 w-20 accent-primary md:block"
            />
          </ControlHintTooltip>
          <ControlHintTooltip title={intl.formatMessage({ id: "whiteboard.undo" })}>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={!canUndo}
              aria-label={intl.formatMessage({ id: "whiteboard.undo" })}
              onClick={() => undoStroke({ boardId, workspaceIdentity, workspacePath })}
            >
              <Undo2Icon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip title={intl.formatMessage({ id: "whiteboard.redo" })}>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={!canRedo}
              aria-label={intl.formatMessage({ id: "whiteboard.redo" })}
              onClick={() => redoStroke({ boardId, workspaceIdentity, workspacePath })}
            >
              <Redo2Icon className="size-4" />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip title={intl.formatMessage({ id: "whiteboard.clear" })}>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              disabled={!canUndo}
              aria-label={intl.formatMessage({ id: "whiteboard.clear" })}
              onClick={() => clearBoard({ boardId, workspaceIdentity, workspacePath })}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background-alt p-3">
        <div className="relative aspect-[16/10] max-h-full w-full overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <canvas
            ref={canvasRef}
            className="h-full w-full touch-none"
            aria-label={intl.formatMessage({ id: "whiteboard.canvasLabel" })}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishPointerStroke}
            onPointerCancel={finishPointerStroke}
            onLostPointerCapture={finishPointerStroke}
          />
          <div className="pointer-events-none absolute left-2 top-2 flex size-6 items-center justify-center rounded-full border border-border bg-surface/90 text-foreground-subtle shadow-sm sm:hidden">
            <PaletteIcon className="size-3.5" />
          </div>
        </div>
      </div>
    </div>
  );
}
