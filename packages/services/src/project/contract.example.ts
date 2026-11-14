// 示例文件：演示 IProjectService 的最小调用顺序（保存 → 回读校验 → 准备会话），非运行时装配代码。
// 不变量：不得被任何入口 import；仅作契约文档与类型参考，删除或改造不影响 Host 启动。
// 边界：示例假定 saveProject 已提交成功，不做重试与鉴权，真实实现需按 contract 的错误语义处理。
// 改错后果：若被生产路径引用，示例逻辑会绕过正式编排，产生重复建项目与会话的不一致状态。
import type { IProjectService } from "#src/project/contract.js";

export async function projectExample(service: IProjectService): Promise<string> {
  const project = await service.saveProject({
    roots: ["/workspace/frontend", "/workspace/backend"],
  });
  const directories = await service.readProjects();
  if (!directories.some((entry) => entry.id === project.id))
    throw new Error("Project not committed");
  const execution = await service.prepareSession({ projectId: project.id });
  return execution.workspacePath;
}
