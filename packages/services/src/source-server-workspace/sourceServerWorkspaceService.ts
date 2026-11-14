import {
  sourceServerResolveWorkspaceRequestSchema,
  sourceServerResolveWorkspaceResultSchema,
  sourceServerMigrationPathActionSchema,
  sourceServerMigrationReportSchema,
} from "@zcode/shared";
import { SourceServerWorkspaceAliasRepo } from "../session/sourceServerWorkspaceAliasRepo.js";
import type { ISourceServerWorkspaceService } from "./sourceServerWorkspace.js";

// Source Server 工作区解析服务：把客户端传入的 workspace 路径/身份归一为规范 key，
// 并暴露迁移报告的查询、放弃与重试入口。所有出入参都经 shared schema 校验，
// 使远端调用与本地调用共享同一套边界约束。
export function createSourceServerWorkspaceService(
  repo: Pick<
    SourceServerWorkspaceAliasRepo,
    | "resolveCanonicalWorkspaceKey"
    | "getFailedPathCount"
    | "getAbandonedPathCount"
    | "listMigrationReports"
    | "abandonFailedWorkspace"
    | "retryFailedWorkspace"
  > = new SourceServerWorkspaceAliasRepo(),
  options: {
    defaultWorkspaceIdentity?: (workspacePath: string) => string;
    onResolved?: (mapping: {
      workspacePath: string;
      canonicalWorkspaceKey: string;
    }) => void | Promise<void>;
  } = {},
): ISourceServerWorkspaceService {
// repo 默认实例化真实仓库，测试可注入 Pick 视图，避免依赖磁盘上的别名数据；
// 服务对象无内部状态，所有持久化都交给 repo，便于迁移逻辑集中演进。
  return {
// 解析并登记一次工作区访问：先归一化请求，再交给 repo 计算规范 key，
// 成功回调先于结果返回执行，调用方拿到响应时旁路索引已经落盘。
    async resolveWorkspace(rawRequest) {
// 入参在服务边界做一次严格解析，拒绝缺字段或类型不符的请求，防止脏数据写入别名表。
      const request = sourceServerResolveWorkspaceRequestSchema.parse(rawRequest);
// legacyRouteHint 允许老客户端只带路径：缺省时用配置的默认身份推导，
// 从而与历史别名记录对齐，而不是新建一条重复的规范 key。
      const result = await repo.resolveCanonicalWorkspaceKey({
        ...request,
        legacyRouteHint:
          request.legacyRouteHint ?? options.defaultWorkspaceIdentity?.(request.workspacePath),
      });
// 回调按契约等待完成；失败会向上抛出，避免调用方以为索引已同步。
      await options.onResolved?.({
        workspacePath: request.workspacePath,
        canonicalWorkspaceKey: result.canonicalKey,
      });
// 出口同样走 schema，只放行约定字段，避免 repo 内部结构（如迁移细节）泄漏到 RPC。
      return sourceServerResolveWorkspaceResultSchema.parse({
        canonicalWorkspaceKey: result.canonicalKey,
        mergedKeys: result.mergedKeys,
        ...(result.migrationId ? { migrationId: result.migrationId } : {}),
      });
    },
// 失败计数用于前端提示迁移遗留项，只读且不触发任何修复动作。
    async getFailedPathCount() {
      return await repo.getFailedPathCount();
    },
// 已放弃计数与失败计数分开暴露，让用户能区分「待重试」与「已确认跳过」。
    async getAbandonedPathCount() {
      return await repo.getAbandonedPathCount();
    },
// 报告列表在出口重新校验，保证数组元素结构稳定，便于 UI 直接渲染。
    async listMigrationReports() {
      return sourceServerMigrationReportSchema.parse(await repo.listMigrationReports());
    },
// 放弃迁移：校验动作入参后按 path + migrationId 精确定位，避免误伤同路径的新迁移。
// 操作完成后返回最新报告，调用方无需再发一次查询，也避免两次读取之间的状态漂移。
    async abandonFailedWorkspace(rawRequest) {
      const request = sourceServerMigrationPathActionSchema.parse(rawRequest);
// 迁移 ID 必填，确保放弃的是当前这一轮迁移而不是该路径的所有历史记录。
      await repo.abandonFailedWorkspace(request.workspacePath, request.migrationId);
      return sourceServerMigrationReportSchema.parse(await repo.listMigrationReports());
    },
// 重试与放弃共用同一动作 schema，语义上只改变 repo 的调用，
// 同样返回最新报告，让按钮点击后可以直接刷新列表。
    async retryWorkspaceMigration(rawRequest) {
      const request = sourceServerMigrationPathActionSchema.parse(rawRequest);
// 重试只重新排队失败项；重复点击由调用方节流，服务层不在此做去重。
      await repo.retryFailedWorkspace(request.workspacePath, request.migrationId);
      return sourceServerMigrationReportSchema.parse(await repo.listMigrationReports());
    },
  };
}
