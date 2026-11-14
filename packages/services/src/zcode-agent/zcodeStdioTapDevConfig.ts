import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ZCodeStdioTapDevState } from "@zcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

// 磁盘上的状态文件最小化到只有 enabled：其余字段都是运行时派生，不落盘。
interface ZCodeStdioTapStateFile {
  enabled?: boolean;
}

// [权衡] 可见性只由统一开发态判据决定，不从 NODE_ENV 自行推断；
// 否则打包产物里的调试入口会随环境变量意外暴露。
export function isZCodeStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

export function getZCodeStdioTapDevDir(): string {
// 统一放在应用配置目录的 dev 子目录，便于整体清理且不污染正式配置。
  return join(getAppConfigDir(), "dev");
}

// 抓包日志与状态文件分离：日志目录可能被高频写入，状态文件必须保持小而稳定。
export function getZCodeStdioTapDevLogDir(): string {
  return join(getZCodeStdioTapDevDir(), "stdio-traffic");
}

// 状态文件固定名称：便于用户在 dev 目录里直接查看与手工清理。
export function getZCodeStdioTapDevStatePath(): string {
  return join(getZCodeStdioTapDevDir(), "zcode-stdio-tap.json");
}

// [失败路径] 读取是纯尽力而为：文件缺失、损坏或类型不符都退化为空状态，
// 绝不因为调试开关配置异常阻断协议链路。
function readStateFile(path: string): ZCodeStdioTapStateFile {
// 先判存在再读，避免首次使用时产生无意义的异常与日志。
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
// 只接受对象形态；数组与原始值一律当损坏处理。
    return parsed && typeof parsed === "object" ? (parsed as ZCodeStdioTapStateFile) : {};
// JSON 解析失败按空状态处理，不向上抛错。
  } catch {
    return {};
  }
}

// 对外快照同时给出 enabled 与 visible：前者是用户选择，后者是当前环境是否允许。
// [契约] readZCodeStdioTapDevState 同时给 enabled 与 visible：渲染开关的判定留在本函数，调用方不重复判断环境。
export function readZCodeStdioTapDevState(): ZCodeStdioTapDevState {
  const visible = isZCodeStdioTapDevVisible();
  const statePath = getZCodeStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
// [权衡] 双条件与运算：非开发环境即使磁盘写着 true 也必须视为关闭，
// 这样从开发切到生产后残留状态不会意外开启抓包。
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getZCodeStdioTapDevLogDir(),
    statePath,
  };
}

// 写入同样受可见性约束，并在结束后回读一次，保证返回值与磁盘内容一致。
export function setZCodeStdioTapDevEnabled(enabled: boolean): ZCodeStdioTapDevState {
  const visible = isZCodeStdioTapDevVisible();
  const statePath = getZCodeStdioTapDevStatePath();
// 目录按需创建且允许已存在，避免首次开启开关时因目录缺失失败。
  mkdirSync(getZCodeStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
// 落盘前再与可见性做与运算：非开发环境下即使调用方传 true 也只写 false。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readZCodeStdioTapDevState();
}
