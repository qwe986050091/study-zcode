import fs from "node:fs";
const data = JSON.parse(fs.readFileSync("d:/code/_annot_baseline/zc-measure-all.json", "utf8"));
const rows = data.rows || data.files || data;
const list = [
"apps/dev-docs/src/capability-map/CapabilityMapView.tsx",
"apps/zcode-cli/packages/adapters/src/browser/index.ts",
"apps/zcode-cli/packages/tui/src/app-sidebar.tsx",
"packages/desktop/scripts/mcp-apps-host-fixture/renderer.ts",
"packages/model-option-map/src/parser.ts",
"apps/zcode-cli/packages/adapters/src/model/failure-provider-business-codes.ts",
"apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts",
"apps/zcode-cli/packages/cli/src/command-center/types.ts",
"packages/desktop/src/main/browserView/browserCommandInteractionHandlers.ts",
"packages/desktop/src/main/desktopRemoteUsageArmsTelemetry.ts",
"packages/desktop/src/scheduler/index.ts",
"packages/ui/src/browser-use/BrowserViewportToolbar.tsx",
"packages/ui/src/components/ai-elements/web-preview.tsx",
"packages/ui/src/lib/zcodeSessionRestore.ts",
"packages/ui/src/project-sidebar/RemoteProjectList.tsx",
"packages/ui/src/store/skillStore.ts",
"packages/ui/src/ToolCallBlocks/renderers/cuaListDetails.tsx",
"packages/ui/src/v4/composer/V4ComposerModeControls.tsx",
"packages/ui/src/v4/windowControllerTaskListRegistry.ts",
"packages/zcode-server-cli/src/contracts.ts",
];
let sum = 0;
for (const p of list) {
  const r = (Array.isArray(rows) ? rows : Object.values(rows)).find((x) => x.path === p || x.path.endsWith(p));
  if (!r) { console.log("MISSING", p); continue; }
  const target = Math.round(r.code * 0.314) - r.comment;
  sum += target;
  console.log(`${target}\t${r.code}\t${r.comment}\t${p}`);
}
console.log("SUM", sum);
