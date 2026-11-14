// ============================================================
// 文件定位：exec 适配器的公开入口，把五段实现（base/lifecycle/process/results/run）组装成 ExecutionPort。
// 输入输出：输入 NodeExecutionAdapterOptions，输出 ExecutionPort 实例（run/startBackground/getBackground/cancel/close）。
// 副作用：构造时会创建快照清理 promise 与目录路径（无进程/文件写入）。
// 失败语义：构造不抛错；运行期失败由各方法以 ExecutionResult.error/status 表达。
// 不变量：同一 options 只实例化一个对象；所有能力均继承自 NodeExecutionAdapterLifecycle。
// 导出面：只暴露 NodeExecutionAdapter 与 createNodeExecutionAdapter，内部 mixin 链不对外可见。
// 依赖方向：仅依赖 @zcode/contracts 的 ExecutionPort，替换实现时调用方无需改动。
// ============================================================
import { NodeExecutionAdapterLifecycle } from "./node-execution-adapter-lifecycle.js";
import type { NodeExecutionAdapterOptions } from "./execution-adapter-types.js";
import type { ExecutionPort } from "@zcode/contracts";

// 具体适配器：继承生命周期层，仅以 implements 声明对外契约，不新增行为。
// 实例持有背景任务表与输出路径映射等可变状态，应长期复用，不要按请求新建。
// 取消幂等、超时转后台、输出落盘上限等语义全部来自父类，此处不得覆写。
export class NodeExecutionAdapter extends NodeExecutionAdapterLifecycle implements ExecutionPort {}

// 工厂：core 侧统一通过该函数获取执行端口，便于后续替换实现而不改调用点。
// options 缺省为空对象，字段为空时各自回落到平台默认值（process.platform/env、默认输出根目录与上限）。
// 返回 ExecutionPort 接口而非具体类，调用方拿不到 backgroundTasks 等内部可变状态。
export function createNodeExecutionAdapter(
  options: NodeExecutionAdapterOptions = {},
): ExecutionPort {
  return new NodeExecutionAdapter(options);
}
