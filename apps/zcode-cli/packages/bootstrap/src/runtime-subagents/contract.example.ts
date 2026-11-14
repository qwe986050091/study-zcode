import type { RuntimeSubagentConfiguration } from "./contract.js";
/** 参考样例：project 来源 + namespace 前缀，外加一份干净的 runtime state 快照。 */
export const exampleSubagentConfiguration: RuntimeSubagentConfiguration = {
  documents: [
    {
      path: "/project/.zcode/agents/review.md",
      source: "project",
      namespace: "tools",
      content: "---\nname: review\ndescription: Review\n---\nReview the code",
    },
  ],
  state: {
    disabledAgentIds: [],
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
  },
};
