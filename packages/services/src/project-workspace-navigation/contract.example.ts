// 契约示例，不参与运行时装配；仅演示 prepare 的入参形态与返回类型。
// INV: 示例中的 hostId/projectId 均为占位值，不得作为真实路由或身份匹配依据。
import type { ProjectWorkspaceNavigation } from "#src/project-workspace-navigation/contract.js";
export async function openProjectExample(navigation: ProjectWorkspaceNavigation) {
  return navigation.prepare({ hostId: "remote:server:example", projectId: "project" });
}
