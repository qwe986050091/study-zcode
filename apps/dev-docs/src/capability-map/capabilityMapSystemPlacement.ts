import type { ElkPoint } from "elkjs/lib/elk-api.js";

// 顶层区域在根画布上的摆放：运行时区域首行横排，工程基础设施单独置底并按首行宽度居中。
// 纯计算、无副作用，不修改入参；坐标单位为画布像素。
// 工程基础设施的 id 与数据层保持一致，用于把它从首行拆出，改动需同步数据源。
export const ENGINEERING_INFRASTRUCTURE_SYSTEM_ID =
  "engineering-infrastructure";
// 画布根内边距：所有区域左上角至少偏移 16px，避免贴边。
// 首行与第二行的 x 起点都使用它，保持两行左边界视觉对齐。
export const CAPABILITY_MAP_ROOT_PADDING = 16;
// 相邻区域的横向间距，同时复用为第二行与首行的纵向间距。
// 调整该值只影响区域摆放，不影响区域内部的 ELK 布局结果。
export const CAPABILITY_MAP_SYSTEM_GAP = 48;

export interface CapabilitySystemPlacementInput {
  // 区域 id，须能在 capabilitySystems 中命中，作为返回 Map 的键。
  id: string;
  // ELK 算出的区域外框宽度（含头部与内边距），单位 px。
  width: number;
  // ELK 算出的区域外框高度，单位 px；用于计算第二行的纵向起点。
  height: number;
}

// 计算各顶层区域的全局左上角坐标（相对根画布原点），纯函数。
// 输入为 ELK 计算后的区域尺寸数组，顺序即首行从左到右的排列顺序。
// 输出 Map<区域 id, 坐标>；未找到工程基础设施时不生成第二行条目，属正常数据形态而非错误。
// 维护不变量：同一 id 只写入一次；第二行 y 恒大于首行最大高度，两行区域不会重叠。
export function buildCapabilitySystemPositions(
  systemLayouts: CapabilitySystemPlacementInput[],
) {
  const engineeringInfrastructure = systemLayouts.find(
    (systemLayout) =>
      systemLayout.id === ENGINEERING_INFRASTRUCTURE_SYSTEM_ID,
  );
  const runtimeSystems = systemLayouts.filter(
    (systemLayout) =>
      systemLayout.id !== ENGINEERING_INFRASTRUCTURE_SYSTEM_ID,
  );
  const positions = new Map<string, ElkPoint>();
  let x = CAPABILITY_MAP_ROOT_PADDING;
  let runtimeRowHeight = 0;

  for (const systemLayout of runtimeSystems) {
    positions.set(systemLayout.id, {
      x,
      y: CAPABILITY_MAP_ROOT_PADDING,
    });
    x += systemLayout.width + CAPABILITY_MAP_SYSTEM_GAP;
    runtimeRowHeight = Math.max(runtimeRowHeight, systemLayout.height);
  }

  if (engineeringInfrastructure) {
    // 仅当数据中存在该区域时才排第二行，否则不产生悬空坐标。
    const runtimeRowRight =
      runtimeSystems.length > 0
        ? x - CAPABILITY_MAP_SYSTEM_GAP
        : CAPABILITY_MAP_ROOT_PADDING;
    const runtimeRowWidth =
      runtimeRowRight - CAPABILITY_MAP_ROOT_PADDING;
    positions.set(engineeringInfrastructure.id, {
      x:
        CAPABILITY_MAP_ROOT_PADDING +
        Math.max(
          0,
          // 居中偏移取首行可用宽度与自身宽度差的一半；首行比它窄时夹到 0，避免负坐标。
          (runtimeRowWidth - engineeringInfrastructure.width) / 2,
        ),
      y:
        CAPABILITY_MAP_ROOT_PADDING +
        runtimeRowHeight +
        CAPABILITY_MAP_SYSTEM_GAP,
    });
  }

  return positions;
}
