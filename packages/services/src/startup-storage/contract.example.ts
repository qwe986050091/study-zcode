// 职责边界：示例契约，仅演示 StartupStorageContract 的调用形态，不参与运行时装配。
// INV：本文件不得被任何运行时模块导入，也不得在此处引入副作用或真实存储访问。
// 改错后果：把示例接进装配链会把演示逻辑当作产品实现执行，掩盖真实契约的实现缺失。
import type { StartupStorageContract, AgentStorageMigrationInput } from "./contract.js";
export async function exampleStartupStorage(
  port: StartupStorageContract,
  input: AgentStorageMigrationInput,
) {
  const migration = await port.migrateAgent(input);
  return migration.backupSkipped;
}
