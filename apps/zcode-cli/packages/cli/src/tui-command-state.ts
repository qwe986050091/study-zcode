// TUI 运行期状态适配：定义 TUI 与 CLI 之间的 prompt handler 契约，以及权限/运行时模式的读取口径。
// 这里只做类型与纯函数，不持有任何全局状态，便于 TUI 与 headless 入口共用。
import type {
  TuiEffortOption,
  TuiListMcpServers,
  TuiGetMainSessionId,
  TuiListWorkflowRuns,
  TuiReplayWorkflowRuns,
  TuiModelOption,
  TuiRecallPreviousInput,
  TuiSendInput,
  TuiSetMode,
  TuiSessionMetadata,
  TuiSubmitPrompt,
  TuiSubscribeSessionEvents,
} from "@zcode/tui";
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import type { CliModeState, CliPermissionMode, CliRuntimeMode } from "./cli-types.js";

// CLI 提供给 TUI 的 prompt 处理器：submit 为必需能力，其余为可选扩展。
// 所有可选方法缺席都表示"该能力未实现"，TUI 侧需按能力缺失降级，而不是当作空数据。
export type TuiPromptHandler = TuiSubmitPrompt & {
  // 关闭当前会话并释放资源；重复调用应幂等，失败上抛由 TUI 决定展示。
  close?: () => Promise<void>;
  // 读取会话元数据（标题/模式等）；未实现时 TUI 不展示对应区域。
  getSessionMetadata?: () => Promise<TuiSessionMetadata>;
  // 可选的推理强度列表；空数组表示"该模型无可选档位"，不是加载失败。
  listEffortOptions?: () => Promise<readonly TuiEffortOption[]>;
  // MCP server 列表：只读快照，不触发连接。
  listMcpServers?: TuiListMcpServers;
  // 读取子 agent 列表（按当前 session 过滤）。
  readSubagents?: import("@zcode/tui").TuiReadSubagents;
  // 读取单个子 agent 的对话记录；id 不存在时按接口约定返回空集合/错误。
  readSubagentTranscript?: import("@zcode/tui").TuiReadSubagentTranscript;
  // 工作流运行记录列表；服务端已按最近更新排序，读侧不重排。
  listWorkflowRuns?: TuiListWorkflowRuns;
  // 回放工作流运行记录。
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  // 主会话 id；多会话场景下用于把 workflow/子 agent 归属到正确会话。
  getMainSessionId?: TuiGetMainSessionId;
  // 可选模型清单（已按可用性过滤，disabled 项由 TUI 自行标注）。
  listModelOptions?: () => Promise<readonly TuiModelOption[]>;
  // 召回上一次输入，用于上下键补全历史。
  recallPreviousInput?: TuiRecallPreviousInput;
  // 直接注入用户输入（不经 prompt 提交流程）。
  sendInput?: TuiSendInput;
  // 切换权限/运行时模式；非法模式由实现侧抛错。
  setMode?: TuiSetMode;
  // 订阅会话事件流；返回值应为取消订阅函数。
  subscribeSessionEvents?: TuiSubscribeSessionEvents;
};

// TUI 使用的标题生成配置：空对象即"全部沿用默认值"，此处显式给出以固定该依赖点。
export const TUI_TITLE_GENERATION_CONFIG: NonNullable<
  NonNullable<ZCodeAppOptions["runtimeConfig"]>["titleGeneration"]
> = {};

// 构造初始模式状态：current 与 override 同源，避免启动时二者不一致导致首轮权限判定错位。
export const createCliModeState = (mode?: CliPermissionMode): CliModeState => ({
  current: mode,
  override: mode,
});

// 取当前生效的运行时模式；优先级 current > override > "build"，保证任何状态下都有确定值。
export const currentCliMode = (state: CliModeState): CliRuntimeMode =>
  state.current ?? state.override ?? "build";

// 读取 TUI 应展示的模式。
// 输入：app 允许只提供 getMode，runtime.getPlanEnabled 为可选增强。
// 输出：plan 标志为真时强制返回 "plan"（即使 getMode 报别的值）；否则用 getMode，最后回落 fallback。
// 副作用：无，只读调用；不修改 app 状态。
// 不变量：plan 与其它模式互斥 —— plan 开启期间不允许对外表现为 build。
/** The TUI's Plan entry projects the runtime's independent planning flag. */
export function readTuiMode(
  app: {
    getMode?: () => CliRuntimeMode;
    readonly runtime?: { getPlanEnabled?: () => boolean };
  },
  fallback: CliRuntimeMode,
): CliRuntimeMode {
  return app.runtime?.getPlanEnabled?.() ? "plan" : (app.getMode?.() ?? fallback);
}
