// 契约示例，不参与运行时装配；仅演示 save 的最小字段集。
// INV: 示例不承担校验逻辑，缺省字段与冲突语义以真实契约实现为准。
import type { ITaskGroupService } from "#src/task-groups/contract.js";
export async function createGroupExample(service: ITaskGroupService) {
  return service.save({ title: "Research", color: "blue" });
}
