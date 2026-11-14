// 启动期存储迁移：以子进程方式调用已解析的 Agent 命令执行迁移子命令。
// INV：必须在 app-server/agent-server 之前插入迁移子命令，否则迁移参数会被上游吞掉。
// 迁移完成后输出必须匹配 storageMigrationReportSchema，解析失败一律视为失败。
// 本文件只负责调用与校验，不直接打开数据库。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  STORAGE_MIGRATION_COMMAND,
  storageMigrationReportSchema,
} from "@zcode/shared/sqlite-migrations";
import type { StartupStorageContract } from "./contract.js";
export type { StartupStorageContract, AgentStorageMigrationInput } from "./contract.js";
// promisify 后只使用 stdout；stderr 交给子进程日志，避免把警告当失败。
const execute = promisify(execFile);
// 输出上限 256KiB：迁移报告是结构化 JSON，超过这个量说明输出异常，直接失败而不是截断。
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
// 实现 StartupStorageContract；env 合并顺序为 process.env、传入 env、command.env，
// 后者优先级最高，保证 Agent 命令自带的环境变量不被覆盖。
export const startupStorage: StartupStorageContract = {
  async migrateAgent({ command, env }) {
// 参数缺省视为空数组；后续找不到子命令时会明确报错。
    const args = command.args ?? [];
// 迁移子命令必须插在 app-server/agent-server 之前，保持与 Agent 命令解析约定一致。
    const subcommand = args.findIndex((arg) => arg === "app-server" || arg === "agent-server");
    if (subcommand < 0) throw new Error("Storage migration requires a resolved Agent command");
// windowsHide 避免弹出控制台窗口；maxBuffer 与上面的输出上限配套。
    const { stdout } = await execute(
      command.command,
      [...args.slice(0, subcommand), STORAGE_MIGRATION_COMMAND],
      {
        cwd: command.cwd,
        env: { ...(env ?? process.env), ...command.env },
        windowsHide: true,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      },
    );
// 报告里可能带 version/kind 等内部字段，解构丢弃后只把业务字段返回给调用方。
    try {
      const {
        version: _version,
        kind: _kind,
        ...result
      } = storageMigrationReportSchema.parse(JSON.parse(stdout));
      return result;
    } catch (cause) {
      throw new Error("Invalid storage migration completion report", { cause });
    }
  },
};
