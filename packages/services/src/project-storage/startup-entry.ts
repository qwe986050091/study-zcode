// 启动入口只聚合存储准备与会话依赖的再导出，保持调用方依赖路径稳定。
// INV: 不得在此引入副作用初始化，prepare 与 mark 的调用顺序契约由调用方保证。
export { prepareTasksIndexStorage } from "#src/project-storage/startup.js";
export { markTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";
export { getTasksIndexDatabasePath } from "#src/paths.js";
export { resolveDefaultZCodeAgentCommand } from "#src/zcode-agent/zcodeAgentProcessManager.js";
export { resolveZCodeAgentSpawnCwd } from "#src/zcode-agent/zcodeAgentSpawnCwd.js";

export { createSettingService } from "#src/setting/settingService.js";
