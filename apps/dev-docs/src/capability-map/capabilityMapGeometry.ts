// 能力地图的几何常量：单位一律为画布像素（zoom=1 时的 CSS px），
// 由 ELK 布局、React Flow 节点 style 与 SVG 连线路径三处共享，改动需三者同步。
// 能力节点盒的固定尺寸：宽 264 容纳两行标题，高 60 保证两行省略文案不被裁切；
// React Flow 直接按该尺寸设置节点 style，ELK 也按同尺寸排布，二者不可分叉。
export const CAPABILITY_NODE_WIDTH = 264;
export const CAPABILITY_NODE_HEIGHT = 60;

// 修复原因：双语标题、owner 与 LOC/入出度徽标的真实高度超过旧版 ELK 顶部留白，
// 因此标题盒与子元素起点必须共享常量，并额外扣除父框边线后保留稳定净空。
// 标题盒与首个内容元素之间保留的净空像素，避免标题底边线与子节点边框视觉粘连。
// 群框与系统框的 padding 计算都引用它，改值会同时改变两种框的内边距。
export const CAPABILITY_HEADER_CONTENT_GAP = 12;
// 群框边线宽度参与内容起点累加：边线 + 头部高度 + 净空，三者在同一公式内推导。
// 若改成 2px，需同步复核 CAPABILITY_GROUP_CONTENT_TOP 的取值。
export const CAPABILITY_GROUP_FRAME_BORDER_WIDTH = 1;
// 群头高度需容纳群名、owner 与代码/入出度徽标两行，低于 112 会截断徽标。
// 与系统头的差值固定为 24px，调整时保持二者比例以免两行区域高低失衡。
export const CAPABILITY_GROUP_HEADER_HEIGHT = 112;
// 群内子节点相对群框顶边的起点 y，直接作为 ELK padding.top 使用。
// 取值 = 边线宽度 + 群头高度 + 净空；三者任一改动都必须重算，不能另行写死数字。
export const CAPABILITY_GROUP_CONTENT_TOP =
  CAPABILITY_GROUP_FRAME_BORDER_WIDTH +
  CAPABILITY_GROUP_HEADER_HEIGHT +
  CAPABILITY_HEADER_CONTENT_GAP;
// 系统框使用 2px 虚线边，因此比群框多扣 1px，保证内容起点仍落在虚线内侧。
// 该值只参与内容起点计算，不改变区域外框的实际占位尺寸。
export const CAPABILITY_SYSTEM_FRAME_BORDER_WIDTH = 2;
// 系统头高度含区域名与描述一行，比群头矮 24px 以压缩顶部留白。
// 若区域描述改为多行，需同步调高该值，否则头部文本会被内容区覆盖。
export const CAPABILITY_SYSTEM_HEADER_HEIGHT = 88;
// 区域内群框相对区域顶边的起点 y，与 CAPABILITY_GROUP_CONTENT_TOP 同构但基于系统框参数。
// 同样由系统框边线/头部/净空推导，改用 ELK padding.top 时需保持同一口径。
export const CAPABILITY_SYSTEM_CONTENT_TOP =
  CAPABILITY_SYSTEM_FRAME_BORDER_WIDTH +
  CAPABILITY_SYSTEM_HEADER_HEIGHT +
  CAPABILITY_HEADER_CONTENT_GAP;
