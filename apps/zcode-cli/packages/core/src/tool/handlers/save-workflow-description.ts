// SaveWorkflow 的常驻描述（docs/dynamic-workflow/launch.md「`SaveWorkflow`」）。
//
// 2026-09-21 起收短：文件格式、实参声明与写作规则都在 `dynamic-workflows` 技能的「Tool
// reference」里，由技能门保证读过。留在这里的是唯一一条**在决定调不调之前**就必须看见的
// 规则——绝不主动保存。保存会在用户仓库里留下文件，而模型对「看起来挺通用」的判断远比用户
// 宽松；这条门槛必须常驻，不能等到技能加载之后。
//
// 定位：`metadata.description` 的静态来源，被 save-workflow.ts 直接引用；只出现在 provider
// 的每轮工具声明里，不参与执行、权限、序列化或降级。
// 口径：一个多段字符串（以空行分隔），字节成本是常驻的——每加一句都会在每次模型请求里重发。
// 不变量：第一段必须自足说明 `scope` 决定项目内/全局；第二段「NEVER call ... unsolicited」
// 必须留在本文件，它是"决定调不调之前"的约束，不能迁进只有读过技能才可见的正文。
// 反直觉：2026-09-21 收短是为了省 token，但收短的对象是"怎么写"，不是"能不能不打招呼就写"。

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";

/**
 * SaveWorkflow 的 provider 可见描述（4 段，空行分隔）。
 *
 * 消费方：仅 `saveWorkflowToolEntry.metadata.description`，随每次模型请求重发；执行链不读它。
 * 失败语义：常量本身无失败；风险在于删句——删掉"先加载技能"会让技能门的拒绝看起来像
 *   无理取闹，删掉"绝不主动保存"则给模型留下一条对"看起来很通用"更宽容的合理化路径。
 * 修改口径：文案可以随时改，但改完要意识到它同时是技能门与确认窗之外的第三道行为约束。
 */
export const SAVE_WORKFLOW_TOOL_DESCRIPTION = [
  "Save a dynamic-workflow script with its metadata so it can be run again later by name (CreateWorkflow's `saved` source; ListSavedWorkflows lists them). The required `scope` decides whether it lives in this project or globally.",
  "",
  "NEVER call this tool unsolicited: saving writes a file into the user's repository, and that is their decision. When a workflow you just built looks reusable, suggest saving it in one sentence and wait; call SaveWorkflow only after the user agrees, or when the user asks directly.",
  "",
  `Load the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill with the Skill tool first: it carries the file format, the argument declarations and the authoring rules. The call is refused until that skill has been loaded in this session. Pass \`script\` (the body only) or \`script_path\` (a draft file, saved without re-emitting it), never both.`,
].join("\n");
