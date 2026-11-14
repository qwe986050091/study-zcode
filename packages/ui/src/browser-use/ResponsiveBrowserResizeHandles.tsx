// INV-01 守住位置：视口上下限只从共享常量透出，本文件不写字面数字。改错故障：就地写死数字后上调阈值漏改，拖拽停在旧边界
// INV-02 守住位置：方向只取 -1、0、1，0 表示该轴不参与本次缩放。改错故障：把 0 当 -1 使用，上边缘拖拽方向反转，尺寸朝反方向跳
// INV-03 守住位置：左边缘取 -1、右边缘取 +1、上边缘取 -1、下边缘取 +1，另一轴恒为 0。改错故障：左右方向写反，尺寸随鼠标移动而缩小
// INV-04 守住位置：角把手同时改宽高，方向由两条边缘方向合成。改错故障：角只改一轴，斜向拖拽出现台阶式卡顿
// INV-05 守住位置：角把手层级高于边缘把手，重叠处优先命中角。改错故障：层级颠倒后角区域被边缘抢走，无法斜向缩放
// INV-06 守住位置：按下、移动、抬起、取消、丢失捕获必须成对绑定。改错故障：漏绑取消或丢失捕获，指针离开后仍持续放大
// INV-07 守住位置：所有结束路径都收敛到同一收尾回调，不做重复提交。改错故障：抬起与丢失捕获各提交一次，尺寸被写两遍
// INV-08 守住位置：组件不持有尺寸与拖拽会话，全部状态归父级。改错故障：组件内自存副本，父级重置后界面停留在旧尺寸
// INV-09 守住位置：边缘把手可聚焦并响应方向键，键盘与指针共用同一份方向。改错故障：键盘重算方向，两种输入出现不一致步进
// INV-10 守住位置：标签、最小值、最大值、当前值必须按维度成套切换。改错故障：只换标签不换值域，读屏播报错误的上下限
// INV-11 守住位置：把手命中区窄且向容器外偏移，避免遮挡内容。改错故障：命中区扩大后压住内容点击，两种交互互相抢事件
// INV-12 守住位置：把手必须禁用触摸滚动，否则移动端先滚动。改错故障：移除触摸约束后拖拽变成页面滚动，尺寸完全不响应
// INV-13 守住位置：分隔条图标仅作视觉提示，必须不接收指针事件。改错故障：图标可命中后，拖拽在图标区域出现空档
// INV-14 守住位置：把手身份的数据属性与测试标识来自同一份表。改错故障：两处分别硬编码，改名后测试选择器静默失效
// INV-15 守住位置：新增把手只改表，不在渲染分支里追加条件。改错故障：绕过表加特例，方向与光标在两条路径分叉
// INV-16 守住位置：图标样式集中为单一常量，不在渲染处拼装。改错故障：各处自拼类名，悬停与焦点态表现不一致
// INV-17 守住位置：结束回调对未开始的拖拽必须安全返回。改错故障：缺少守卫时，意外抬起把尺寸提交成零
// INV-18 守住位置：本文件只做展示与意图转发，不改尺寸计算规则。改错故障：在此处补算增量，与父级逻辑重复叠加
//
// 模块职责：渲染浏览器视口的边缘与角缩放把手，把指针与键盘意图转发给父级
// 状态所有权：尺寸、拖拽会话与阈值判定都归父级，本组件只消费入参与回调
// 阅读顺序：先看方向取值与两张把手表，再看组件签名，最后看两段渲染与无障碍属性
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { BROWSER_VIEWPORT_LIMITS } from "@zcode/shared";
import {
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER,
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT,
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT,
  TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT,
  TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT,
  TID_BROWSER_RESPONSIVE_RESIZE_LEFT,
  TID_BROWSER_RESPONSIVE_RESIZE_TOP,
  TID_BROWSER_RESPONSIVE_RESIZE_WIDTH,
} from "@zcode/shared/test-ids";
import { GripHorizontalIcon, GripVerticalIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

// 视口上下限的唯一定义来自共享常量，本处只做一次对外透传，不新增第二套数值
// 父级用同一组上下限裁剪拖拽增量，避免界面允许而落盘拒绝的错位
// 若在此就地硬编码数字，上限调整会漏改一处，拖拽停在旧边界
// 因此新的边界诉求应回到共享常量修改，而不是在本文件补分支
export const RESPONSIVE_BROWSER_VIEWPORT_LIMITS = BROWSER_VIEWPORT_LIMITS;

// 方向值只允许 -1、0、1 三档，分别表示反向、不参与、正向增长
// 0 是禁用轴而非缺省回调，边缘把手借此表达只改单轴
// 把 0 误当成 -1 会让上边缘拖拽翻转，尺寸朝反方向跳变
// 合成位移时按方向相乘累加，方向语义一旦漂移，全部把手同时出错
export type ResizeDirection = -1 | 0 | 1;

export interface ResizeHandleDirections {
  heightDirection: ResizeDirection;
  widthDirection: ResizeDirection;
}

// 边缘把手以表驱动描述：方向、尺寸轴、光标与测试标识同源，避免散落判断
// 左边缘取 -1、右边缘取 +1，上下边缘的横向方向固定为 0
// 左右把手命中区只有 4 像素并向外偏移，窄是有意取舍，用时序换遮挡
// 拖拽期间由同一组指针回调维持连续性，抬手、取消与丢失捕获都要收敛到结束
const EDGE_RESIZE_HANDLES = [
  {
    className: "top-0 -left-2 h-full w-4 cursor-ew-resize",
    dimension: "width",
    heightDirection: 0,
    key: "left",
    orientation: "vertical",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_LEFT,
    widthDirection: -1,
  },
  {
    className: "top-0 -right-2 h-full w-4 cursor-ew-resize",
    dimension: "width",
    heightDirection: 0,
    key: "right",
    orientation: "vertical",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_WIDTH,
    widthDirection: 1,
  },
  {
    className: "-top-2 left-0 h-4 w-full cursor-ns-resize",
    dimension: "height",
    heightDirection: -1,
    key: "top",
    orientation: "horizontal",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_TOP,
    widthDirection: 0,
  },
  {
    className: "-bottom-2 left-0 h-4 w-full cursor-ns-resize",
    dimension: "height",
    heightDirection: 1,
    key: "bottom",
    orientation: "horizontal",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT,
    widthDirection: 0,
  },
] as const;

// 角把手把两个方向打包，永远同时改宽高，不允许退化为单轴
// 角落层级高于边缘把手，重叠区域优先命中角，避免意图被边缘抢走
// 四个角按对角分布光标形状，形状与方向不一致会让用户误判可拖方向
// 角把手不暴露键盘语义，键盘用户走边缘把手，这是可访问性的明确让步
const CORNER_RESIZE_HANDLES = [
  {
    className: "-top-2 -left-2 cursor-nwse-resize",
    heightDirection: -1,
    key: "top-left",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT,
    widthDirection: -1,
  },
  {
    className: "-top-2 -right-2 cursor-nesw-resize",
    heightDirection: -1,
    key: "top-right",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT,
    widthDirection: 1,
  },
  {
    className: "-bottom-2 -left-2 cursor-nesw-resize",
    heightDirection: 1,
    key: "bottom-left",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT,
    widthDirection: -1,
  },
  {
    className: "-right-2 -bottom-2 cursor-nwse-resize",
    heightDirection: 1,
    key: "bottom-right",
    testId: TID_BROWSER_RESPONSIVE_RESIZE_CORNER,
    widthDirection: 1,
  },
] as const;

// 分隔条图标仅作视觉提示，必须不接收指针事件，否则会截断把手自身的拖拽
// 图标靠分组悬停与键盘焦点切换透明度，与把手命中区完全解耦
// 若图标恢复可命中，父级的指针序列出现空档，拖拽表现为中途卡顿
// 故样式集中为一个常量，避免各处分别拼装导致行为漂移
const RESIZE_SEPARATOR_ICON_CLASS =
  "pointer-events-none absolute top-1/2 left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-foreground-subtlest opacity-0 transition-[color,opacity] group-hover/resize-edge:text-foreground-subtle group-hover/resize-edge:opacity-100 group-focus-visible/resize-edge:text-foreground-subtle group-focus-visible/resize-edge:opacity-100";

// 本组件是受控视图，只负责渲染把手与转发意图，不持有尺寸与拖拽状态
// 开始、结束、移动、键盘四条回调由父级实现，组件不推断何时提交尺寸
// 把状态收进组件会让父级无法在拖拽结束后统一落盘与校验
// 代价是调用方需提供全部回调，收益是单一状态源与可测试的纯视图
export function ResponsiveBrowserResizeHandles({
  height,
  heightLabel,
  onBeginResize,
  onEndResize,
  onPointerMove,
  onResizeKeyDown,
  width,
  widthLabel,
}: {
  height: number;
  heightLabel: string;
  onBeginResize: (
    directions: ResizeHandleDirections,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onEndResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (
    directions: ResizeHandleDirections,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  width: number;
  widthLabel: string;
}): React.JSX.Element {
  return (
    <>
      {EDGE_RESIZE_HANDLES.map((handle) => {
        // 宽度把手与高度把手共用同一段渲染，靠布尔分支选择标签、值域与当前值
        // 标签、最小、最大、当前值必须成套切换，混用会让读屏播报错误的维度
        // 方向对象在渲染前一次性组装，保证指针回调与键盘回调拿到同一份方向
        // 若在回调内部再推导方向，两处判断容易分叉，出现键盘与指针行为不一致
        const isWidthHandle = handle.dimension === "width";
        const directions = {
          heightDirection: handle.heightDirection,
          widthDirection: handle.widthDirection,
        };
        return (
          <div
            aria-label={isWidthHandle ? widthLabel : heightLabel}
            aria-orientation={handle.orientation}
            aria-valuemax={
              isWidthHandle
                ? RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxWidth
                : RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxHeight
            }
            aria-valuemin={
              isWidthHandle
                ? RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minWidth
                : RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minHeight
            }
            aria-valuenow={isWidthHandle ? width : height}
            className={cn(
              "group/resize-edge absolute z-30 touch-none outline-none",
              handle.className,
            )}
            // 把手身份通过数据属性外露，端到端测试据此定位，不依赖类名顺序
            // 键值必须与表中 key 完全一致，改名会静默打断测试选择器
            // 测试标识与数据属性重复标注是有意冗余，前者面向测试框架，后者面向样式与调试
            // 若只保留其一，重构类名时定位失效，故障从断言层滑到人工排查
            data-resize-edge={handle.key}
            data-testid={handle.testId}
            key={handle.key}
            onKeyDown={(event) => onResizeKeyDown(directions, event)}
            onLostPointerCapture={onEndResize}
            onPointerCancel={onEndResize}
            onPointerDown={(event) => onBeginResize(directions, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onEndResize}
            role="separator"
            tabIndex={0}
          >
            {handle.orientation === "vertical" ? (
              <GripVerticalIcon className={RESIZE_SEPARATOR_ICON_CLASS} />
            ) : (
              <GripHorizontalIcon className={RESIZE_SEPARATOR_ICON_CLASS} />
            )}
          </div>
        );
      })}
      {CORNER_RESIZE_HANDLES.map((handle) => {
        const directions = {
          heightDirection: handle.heightDirection,
          widthDirection: handle.widthDirection,
        };
        return (
          <div
            aria-hidden="true"
            // 角把手没有角色与键盘入口，纯靠指针命中，因此必须阻止触摸时页面滚动
            // 缺少触摸约束时移动端拖拽先触发滚动，尺寸完全不响应
            // 无键盘路径的代价可接受：边缘把手已覆盖同等的宽高调整能力
            // 若将来要求键盘调角，需要补角色与值域，不能只加事件监听
            className={cn("absolute z-40 size-5 touch-none", handle.className)}
            data-resize-corner={handle.key}
            data-testid={handle.testId}
            key={handle.key}
            onLostPointerCapture={onEndResize}
            onPointerCancel={onEndResize}
            onPointerDown={(event) => onBeginResize(directions, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onEndResize}
          />
        );
      })}
    </>
  );
}
