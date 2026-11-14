import type { TuiSubmitPromptResult } from "@zcode/tui";
import type {
  CommandCenterDeps,
  CommandCenterSkill,
  CommandCenterSkillListOutcome,
} from "../types.js";

// 处理裸 /skill：列出全部可用技能；未注入 listSkills 时降级为提示，列表失败返回错误文本。
export async function handleSkillListCommand(
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  if (!deps.listSkills) {
    return {
      mode: deps.getMode?.(),
      response: "Skill listing is not available in this client.",
    };
  }

  try {
    const outcome = await deps.listSkills();
    return {
      mode: deps.getMode?.(),
      response: formatCommandCenterSkillList(outcome),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: deps.getMode?.(),
      response: `Unable to list skills: ${message}`,
    };
  }
}

// 技能列表文本：空列表返回固定提示；每项输出名称（含限定名）、作用域/来源、描述与路径，末尾附用法。
function formatCommandCenterSkillList(outcome: CommandCenterSkillListOutcome): string {
  if (outcome.skills.length === 0) {
    return "No skills found.";
  }

  const lines = [`Available skills (${outcome.skills.length})`];
  for (const skill of outcome.skills) {
    const alias = skill.qualifiedName ? `; alias ${skill.name}` : "";
    lines.push(`- ${formatCommandCenterSkillName(skill)} (${skill.scope}/${skill.source}${alias})`);
    lines.push(`  ${formatCommandCenterSkillDescription(skill)}`);
    lines.push(`  ${skill.path}`);
  }
  lines.push("", "Use /skill <name> [task] to load one.");
  return lines.join("\n");
}

// 描述拼接：存在 whenToUse 时把触发条件接在描述后，便于用户判断是否适用。
function formatCommandCenterSkillDescription(skill: CommandCenterSkill): string {
  return skill.whenToUse ? `${skill.description} ${skill.whenToUse}` : skill.description;
}

// 技能展示名：优先限定名（含插件/命名空间前缀），缺省用裸名。
function formatCommandCenterSkillName(skill: CommandCenterSkill): string {
  return skill.qualifiedName ?? skill.name;
}
