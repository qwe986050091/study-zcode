import type { ToolPart } from "@zcode/contracts";

// 为历史/模型输入挑选工具 part：同一 callID 只保留最后出现的那条记录。
// 输入 parts 为某条消息的原始 part 列表（可能含重复或迟到更新），不会为空时返回空数组。
// 有 declarationIndex 时按声明序号排序，保证 provider calls/results 顺序与模型声明一致；
// 任一 part 缺该字段（旧记录或混合版本）则整组保持物理顺序，避免把缺失项排到数组头部。
// 返回新数组，元素仍是原 part 引用；不修改入参、无 IO、无副作用。
export function selectToolPartsForHistory(parts: ToolPart[]): ToolPart[] {
  // 提前执行失败或断流恢复会另建 part；同一声明只恢复最后新建的记录，旧 part 迟到更新不影响选择。
  // 保留所选记录的物理顺序，原始 parts 仍供 UI 和文件读取状态恢复使用。
  const latestByCallId = new Map(parts.map((part) => [part.callID, part]));
  const latestParts = parts.filter((part) => latestByCallId.get(part.callID) === part);
  if (latestParts.some((part) => part.declarationIndex === undefined)) {
    // 旧记录或混合版本可能缺少声明序号，整组保留原序。
    return latestParts;
  }
  // 只读工具可能先落盘；provider calls/results 应共用声明顺序，不改 UI 的原始 parts。
  return latestParts.sort((left, right) => left.declarationIndex! - right.declarationIndex!);
}
