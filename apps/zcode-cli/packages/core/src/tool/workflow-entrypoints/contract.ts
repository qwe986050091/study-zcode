import type { ToolEntry } from "../types.js";
// schema 来源口径：三个 InputSchema 统一来自 @zcode/contracts，避免 core 内出现第二份参数定义；
// 执行器 runtimeInputSchema 校验读的是同一份定义，因此这里不重复声明、不派生。
export {
  AmendWorkflowInputSchema,
  FillWorkflowHoleInputSchema,
  ListModelsInputSchema,
} from "@zcode/contracts";

/** 复用原 ToolEntry 与执行器契约，不包装 handler 或复制工具配置。 */
// 接口口径：三个字段都是既有 ToolEntry，不包装 handler、不复制权限/超时/结果预算配置。
// amendWorkflow / fillWorkflowHole 会改工作流草稿并触发端口调用，listModels 只读模型目录。
// 维护不变量：本入口只做注册装配；调用仍进入公共调度 → validation → permission → handler 链，
// 因此这里的类型变化不得改变工具名、schema 或 metadata 中的权限声明。
// 失败语义：字段缺失是装配错误（编译期拦截）；运行期失败由各自 handler 抛出，本层不降级。
export interface WorkflowToolEntrypoints {
  // 修改已有工作流：解析前驱 run、写草稿并调用 port.amend，副作用落在工作流服务侧。
  readonly amendWorkflow: ToolEntry;
  // 只读列出本宿主已配置的模型，供 workflow 的 subagent_model 选择；不改会话模型。
  readonly listModels: ToolEntry;
  // 填补工作流脚本中的留白洞：先写函数体再调 port.fillHole，属于草稿写副作用。
  readonly fillWorkflowHole: ToolEntry;
}
