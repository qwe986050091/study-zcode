// INV-01 [边界] 本模块只提供白板纯工具函数，不持有文档状态；守住位置：全部导出函数都没有模块级可变变量；改错故障：UI 与 store 各存一份白板，撤销后两边显示不一致。
// INV-02 [契约] 身份 key 固定让 identity 去空白后优先、缺失才取路径；守住位置：buildWhiteboardWorkspaceKey 的唯一 return；改错故障：远程工作区与本地路径别名分裂成多个白板。
// INV-03 [契约] 文档 id 固定带 whiteboard: 前缀；守住位置：createWhiteboardDocument 的 id 模板串；改错故障：文档与笔迹 id 空间重叠，持久化键冲突。
// INV-04 [契约] 笔迹 id 固定带 stroke: 前缀；守住位置：createWhiteboardStroke 的 id 模板串；改错故障：撤销按 id 定位时命中错误实体，笔迹无法还原。
// INV-05 [失败路径] 命名前缀 trim 后为空时回落 Whiteboard；守住位置：createUniqueWhiteboardName 的 normalizedPrefix；改错故障：文档名叫成一串孤立序号。
// INV-06 [顺序] 序号从 1 单调递增并跳过已占用名称；守住位置：createUniqueWhiteboardName 的 while 条件与 index 自增；改错故障：重名覆盖，或循环无法终止。
// INV-07 [事务] 新建文档只取一次时间戳，createdAt 与 updatedAt 必须同值；守住位置：createWhiteboardDocument 的 now 及其两处赋值；改错故障：刚建好的文档被判为已修改，触发多余保存。
// INV-08 [状态] 当前笔迹栈与撤销栈各自新建空数组，不得共享引用；守住位置：createWhiteboardDocument 的 strokes 与 undoneStrokes 字面量；改错故障：撤销与重做互相污染，笔迹凭空消失或重复。
// INV-09 [契约] 画布固定 1280x800 且宽高取自同一对常量；守住位置：createWhiteboardDocument 的 width 与 height；改错故障：指针坐标与导出像素错位，图像被裁切。
// INV-10 [资源] 每次绘制都必须 save 与 restore 成对出现；守住位置：drawWhiteboardDocument 与 drawWhiteboardStroke 的首尾；改错故障：变换与线宽泄漏到后续绘制，画面整体漂移。
// INV-11 [契约] scale 缺省为 1 且只经 setTransform 施加；守住位置：drawWhiteboardDocument 的 scale 计算与 setTransform 调用；改错故障：缩放被重复叠加，笔迹偏离光标。
// INV-12 [权衡] 草稿笔迹只并入本次绘制序列，绝不写回 board；守住位置：drawWhiteboardDocument 的 for 循环展开；改错故障：草稿被持久化，撤销一次仍然留在画布。
// INV-13 [失败路径] 橡皮擦用背景色覆盖而非删除数据；守住位置：drawWhiteboardStroke 的 strokeStyle 与 fillStyle 三元；改错故障：删除痕迹仍留在 strokes，重绘后复活。
// INV-14 [边界] 单点笔迹画实心圆点并提前返回；守住位置：drawWhiteboardStroke 的 points.length 等于 1 分支；改错故障：点按无可见反馈，像是工具失灵。
// INV-15 [失败路径] 没有首点时立即返回，不得继续取下标；守住位置：drawWhiteboardStroke 的 firstPoint 守卫；改错故障：读取空数组坐标抛错，整块画布空白。
// INV-16 [失败路径] 上下文缺失与 dataUrl 无逗号一律抛错，不产出空文件；守住位置：exportWhiteboardDataUrl 与 createWhiteboardPngFile 的两处 throw；改错故障：保存出损坏 PNG，用户在聊天里看到破图。
// INV-17 [资源] 解出的二进制逐字节写入 Uint8Array，File 类型固定 image/png；守住位置：createWhiteboardPngFile 的字符码循环与 File 构造；改错故障：二进制被按文本编码，图片无法打开。
// INV-18 [契约] 事件判定顺序为 type、CustomEvent 存在、instanceof、detail 形状；守住位置：isWhiteboardAddToChatEvent 的条件排列；改错故障：SSR 环境先抛引用错误，白板无法加入聊天。
//
// 模块职责：把白板文档、笔迹与 PNG 导出、加入聊天事件收敛为一组无副作用的纯工具函数。
// 状态所有权：WhiteboardDocument 由调用方持有，本模块只创建新对象与派生展示数据。
// 阅读顺序：先看类型与常量，再读命名与笔迹构造，最后看绘制、导出与事件校验。
import { createUuid } from "@zcode/shared";

export type WhiteboardTool = "pen" | "eraser";

export interface WhiteboardPoint {
  x: number;
  y: number;
}

// [契约] 笔迹结构固定 id、tool、color、width、points 五个字段，序列化格式即持久化格式。
// [边界] tool 只允许 pen 与 eraser 两值，类型收窄在 WhiteboardTool 上，绘制分支据此选色。
// [契约] points 保存原始坐标数组，本层不做缩放或归一化，缩放只在绘制时施加。
// [权衡] 文档额外保留 undoneStrokes，撤销与重做共用同一笔迹结构，不再定义第二套类型。
// [失败路径] 若把 points 改成相对坐标，历史数据与导入导出同时失真，画笔位置整体偏移。
export interface WhiteboardStroke {
  id: string;
  tool: WhiteboardTool;
  color: string;
  width: number;
  points: WhiteboardPoint[];
}

export interface WhiteboardDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  strokes: WhiteboardStroke[];
  undoneStrokes: WhiteboardStroke[];
  createdAt: number;
  updatedAt: number;
}

export interface WhiteboardAddToChatPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  boardId: string;
}

// [契约] 画布逻辑尺寸固定 1280x800，创建文档与导出 PNG 共用这一对常量。
// [契约] 默认笔色与加聊天事件名由本文件导出，调用方不要另写同义字符串。
// [边界] 背景色单独常量化且不导出，橡皮擦覆盖色与导出底色必须同源。
// [失败路径] 若只改导出用的宽高，画布坐标与 PNG 像素错位，内容被裁切或留白。
const WHITEBOARD_CANVAS_WIDTH = 1280;
const WHITEBOARD_CANVAS_HEIGHT = 800;
export const WHITEBOARD_DEFAULT_COLOR = "#111827";
export const WHITEBOARD_ADD_TO_CHAT_EVENT = "zcode:add-whiteboard-to-chat";
const WHITEBOARD_BACKGROUND_COLOR = "#ffffff";

// [契约] 身份 key 固定取 identity 去空白后的值，缺失时才回落 workspacePath。
// [边界] 空白字符串等同未提供，trim 后为空的 identity 不能进入 key。
// [失败路径] 若改成路径优先，同一远程工作区的本地别名会分裂成多份白板。
// [权衡] 本函数不规范化路径，文件操作仍用 workspacePath，仅身份聚合用这里的结果。
export function buildWhiteboardWorkspaceKey({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return workspaceIdentity?.trim() || workspacePath;
}

// [契约] 新文档 id 固定带 whiteboard: 前缀，与笔迹 id 空间分开，便于持久化定位。
// [事务] now 取一次并同时写入 createdAt 与 updatedAt，新建文档不应被判为已修改。
// [状态] strokes 与 undoneStrokes 各自新建空数组，不共用引用，否则撤销栈会污染当前栈。
// [契约] 名称交给 createUniqueWhiteboardName，existingNames 只读，不得就地改写。
// [失败路径] 命名前缀 trim 后为空时回落 Whiteboard，避免只剩序号的空名。
// [顺序] 序号从 1 递增并跳过已占用名称，集合按 trim 后比较，循环必须单调推进。
export function createWhiteboardDocument(params: {
  existingNames: readonly string[];
  defaultNamePrefix: string;
}): WhiteboardDocument {
  const now = Date.now();
  return {
    id: `whiteboard:${createUuid()}`,
    name: createUniqueWhiteboardName(params.existingNames, params.defaultNamePrefix),
    width: WHITEBOARD_CANVAS_WIDTH,
    height: WHITEBOARD_CANVAS_HEIGHT,
    strokes: [],
    undoneStrokes: [],
    createdAt: now,
    updatedAt: now,
  };
}

function createUniqueWhiteboardName(
  existingNames: readonly string[],
  defaultNamePrefix: string,
): string {
  const normalizedPrefix = defaultNamePrefix.trim() || "Whiteboard";
  const usedNames = new Set(existingNames.map((name) => name.trim()));
  let index = 1;
  while (usedNames.has(`${normalizedPrefix} ${index}`)) {
    index += 1;
  }
  return `${normalizedPrefix} ${index}`;
}

// [契约] 笔迹 id 固定带 stroke: 前缀，撤销与重做按 id 定位，前缀混用会查找失败。
// [边界] points 以引用挂到笔迹上，构造阶段不复制也不改写点数组。
// [状态] 颜色与线宽按传入值原样保存，橡皮擦语义只在绘制阶段解释。
export function createWhiteboardStroke(params: {
  tool: WhiteboardTool;
  color: string;
  width: number;
  points: WhiteboardPoint[];
}): WhiteboardStroke {
  return {
    id: `stroke:${createUuid()}`,
    tool: params.tool,
    color: params.color,
    width: params.width,
    points: params.points,
  };
}

// [资源] drawWhiteboardDocument 先 save 再 setTransform，末尾必须 restore，变换与样式不得泄漏。
// [契约] scale 缺省为 1 并统一由 setTransform 施加，clearRect 与 fillRect 共用逻辑宽高。
// [顺序] 先清空再铺背景，最后才遍历笔迹，顺序颠倒会整块画布只剩底色。
// [权衡] 草稿笔迹只在本次绘制末尾追加，不写回 board，预览态与持久态因此分离。
// [失败路径] 若把 draftStroke 并入 strokes，草稿会被持久化，撤销一次也删不掉。
// [契约] drawWhiteboardStroke 中橡皮擦用背景色覆盖笔色，不改画笔结构，撤销仍可按 id 还原。
// [边界] 空 points 在首点守卫处直接返回，不能继续读下标，否则整块画布因异常空白。
// [边界] 单点笔迹走 arc 画实心圆，半径取线宽一半并提前 restore，点按才能看到反馈。
// [资源] 多点路径先 moveTo 首个点再逐点 lineTo，单分支内完成 stroke 与 restore。
export function drawWhiteboardDocument(
  context: CanvasRenderingContext2D,
  board: Pick<WhiteboardDocument, "height" | "strokes" | "width">,
  options: {
    backgroundColor?: string;
    draftStroke?: WhiteboardStroke | null;
    scale?: number;
  } = {},
) {
  const scale = options.scale ?? 1;
  const backgroundColor = options.backgroundColor ?? WHITEBOARD_BACKGROUND_COLOR;
  context.save();
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, board.width, board.height);
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, board.width, board.height);
  for (const stroke of [...board.strokes, ...(options.draftStroke ? [options.draftStroke] : [])]) {
    drawWhiteboardStroke(context, stroke, backgroundColor);
  }
  context.restore();
}

function drawWhiteboardStroke(
  context: CanvasRenderingContext2D,
  stroke: WhiteboardStroke,
  backgroundColor: string,
) {
  const firstPoint = stroke.points[0];
  if (!firstPoint) {
    return;
  }

  context.save();
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = stroke.tool === "eraser" ? backgroundColor : stroke.color;
  context.fillStyle = stroke.tool === "eraser" ? backgroundColor : stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(firstPoint.x, firstPoint.y, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  context.moveTo(firstPoint.x, firstPoint.y);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.restore();
}

// [失败路径] 取不到 2d 上下文时抛错而不返回空字符串，避免生成损坏的 PNG。
// [失败路径] dataUrl 中没有逗号说明格式异常，在切片前拦截，防止解出空字节。
// [资源] atob 结果按字符码逐字节写入 Uint8Array，二进制不能再走文本编码。
// [契约] File 的类型固定 image/png，文件名由 sanitizeWhiteboardFilename 去掉非法字符。
// [边界] 文件名过滤路径分隔符与通配符，并按码点过滤控制字符，避免跨平台写入失败。
// [失败路径] 名称被清空或只剩点时回落 whiteboard，不能让文件名以点开头或为空。
function exportWhiteboardDataUrl(board: WhiteboardDocument): string {
  const canvas = document.createElement("canvas");
  canvas.width = board.width;
  canvas.height = board.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is unavailable.");
  }
  drawWhiteboardDocument(context, board);
  return canvas.toDataURL("image/png");
}

export function createWhiteboardPngFile(board: WhiteboardDocument): File {
  const dataUrl = exportWhiteboardDataUrl(board);
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Whiteboard image data is invalid.");
  }

  const binary = atob(dataUrl.slice(commaIndex + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], `${sanitizeWhiteboardFilename(board.name)}.png`, {
    type: "image/png",
  });
}

// [顺序] 事件校验先比 type，再确认 CustomEvent 存在，最后才是 instanceof 与 detail 形状。
// [失败路径] 顺序颠倒时 SSR 或测试环境没有 CustomEvent，判定会先抛引用错误。
// [契约] dispatch 在无 window 时返回 false，事件 cancelable 且监听方 preventDefault 才算处理成功。
// [边界] payload 校验要求 workspacePath 与 boardId 为非空字符串，workspaceIdentity 可缺省。
export function isWhiteboardAddToChatEvent(
  event: Event,
): event is CustomEvent<WhiteboardAddToChatPayload> {
  return (
    event.type === WHITEBOARD_ADD_TO_CHAT_EVENT &&
    typeof CustomEvent !== "undefined" &&
    event instanceof CustomEvent &&
    isWhiteboardAddToChatPayload(event.detail)
  );
}

export function dispatchWhiteboardAddToChat(payload: WhiteboardAddToChatPayload): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const event = new CustomEvent(WHITEBOARD_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

function sanitizeWhiteboardFilename(name: string): string {
  const normalizedName = Array.from(name.trim().replace(/[<>:"/\\|?*]+/gu, "-"))
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");
  return normalizedName.replace(/^\.+|\.+$/gu, "") || "whiteboard";
}

function isWhiteboardAddToChatPayload(value: unknown): value is WhiteboardAddToChatPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Partial<WhiteboardAddToChatPayload>;
  return (
    typeof payload.workspacePath === "string" &&
    payload.workspacePath.length > 0 &&
    typeof payload.boardId === "string" &&
    payload.boardId.length > 0 &&
    (payload.workspaceIdentity === undefined || typeof payload.workspaceIdentity === "string")
  );
}
