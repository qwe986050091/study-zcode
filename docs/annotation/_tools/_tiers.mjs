import fs from 'node:fs';

const ROOT = 'd:/code/ZCode/';
const read = (f) => JSON.parse(fs.readFileSync(`d:/code/_annot_baseline/${f}`, 'utf8')).rows;
const rows = [...read('_scan-main.json'), ...read('_scan-rest2.json'), ...read('_scan-ui.json')];

// ── 判档规则（全部可检索；表里的「判据」直接引用规则编号）──
const R = {
  'R1.1': {
    re: /packages\/desktop\/src\/main\/(browserView|pluginSandbox|mcpUserDirectory|web-remote-relay|embedded-browser-permission-contract)\//,
    why: '路径属 guest/沙箱/权限契约面（main↔guest 跨进程）',
  },
  'R1.2': { re: /packages\/rpc\//, why: '路径属 RPC 传输层（main↔renderer 协议）' },
  'R1.3': { re: /packages\/server\//, why: '路径属 server 网络入口（请求解析/SSH 远程执行/鉴权）' },
  'R1.4': {
    re: /\/(oauth|auth|authentication|authorization|permission|permissions|credential|credentials|cookie|cookies|secure|security|sandbox|keychain|safe-storage|safeStorage)(\/|\.|-)/i,
    why: '路径名含鉴权/凭据/沙箱域',
  },
};

const API = [
  ['R1.5', 'ipcMain', /\bipcMain\s*\.\s*(handle|handleOnce|on|once|emit)\s*\(/g],
  ['R1.5', 'ipcRenderer', /\bipcRenderer\s*\.\s*(invoke|send|sendSync|on|once)\s*\(/g],
  ['R1.5', 'contextBridge', /\bcontextBridge\s*\.\s*exposeInMainWorld\s*\(/g],
  ['R1.6', '权限处理器', /\bsetPermission(Request|Check)Handler\s*\(/g],
  ['R1.6', 'setWindowOpenHandler', /\bsetWindowOpenHandler\s*\(/g],
  ['R1.6', 'will-attach-webview', /\bwill-attach-webview\b/g],
  ['R1.7', 'BrowserView/WebContentsView', /\bnew\s+(BrowserView|WebContentsView)\s*\(/g],
  ['R1.7', 'session.fromPartition', /\bsession\s*\.\s*fromPartition\s*\(/g],
  ['R1.8', 'protocol.handle/register', /\bprotocol\s*\.\s*(handle|registerSchemesAsPrivileged|intercept\w*)\s*\(/g],
  ['R1.9', 'safeStorage/keytar', /\bsafeStorage\s*\.\s*(isEncryptionAvailable|encryptString|decryptString)\s*\(|\bkeytar\s*\./g],
  ['R1.10', 'MessageChannelMain/PortMain', /\b(MessageChannelMain|MessagePortMain)\b/g],
  ['R1.11', 'child_process', /\bfrom\s+['"](?:node:)?child_process['"]|\brequire\s*\(\s*['"](?:node:)?child_process['"]/g],
  ['R1.11', 'execFile/spawnSync/execSync', /\b(execFileSync|execFile|spawnSync|execSync)\s*\(/g],
  ['R1.12', '路径穿越校验', /\b(isPathInside|resolveUserPath|assertWithin\w*|pathTraversal)\b/gi],
];

const STATE = /(session|queue|scheduler|lock|mutex|semaphore|retry|backoff|persist|repository|database|sqlite|transaction|cache|recovery|migration|snapshot|store|storage|updater|download|checkpoint|journal|lease|heartbeat|reconnect)/gi;
const T3_PATH = /\/(i18n|locales?|translations?|messages?|copy|theme|themes|styles?|colors?|icons?|assets|fonts|constants?|consts?)\//i;
const PRESENT = /(pane|layout|viewer?|style|theme|icon|badge|tooltip|animation|transition|format|formatter|label|text|copy|caption|placeholder|color|size|geometry|position|scroll|zoom|focus|keyboard|shortcut|markdown|render|display|visual|skeleton|loading|empty|toast|dialog|modal|popover|menu|button|input|editor|toolbar|panel|sidebar|header|footer|list|row|table|chart|graph|timeline|bubble|card|avatar|image|video|audio)/i;

function countG(src, re) {
  const m = src.match(re);
  return m ? m.length : 0;
}

// 只在真实代码里搜 API：注释/字符串/模板里的同名文字不算证据
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}

function classify(rel) {
  for (const [id, r] of Object.entries(R)) {
    // UI 下的 sandbox/auth 多指展示组件，不是安全边界；安全实现应在 main/services
    if (id === 'R1.4' && rel.startsWith('packages/ui/')) continue;
    if (r.re.test(rel)) return { tier: 1, rule: id, why: r.why };
  }

  let src = '';
  try { src = fs.readFileSync(ROOT + rel, 'utf8'); } catch {}
  const code = codeOnly(src);
  const head = src.slice(0, 60000);
  const apiHits = [];
  for (const [id, name, re] of API) {
    const n = countG(code, re);
    if (n) apiHits.push({ id, name, n });
  }
  if (apiHits.length) {
    const ids = [...new Set(apiHits.map((h) => h.id))];
    const desc = apiHits.map((h) => `${h.name}×${h.n}`).join('、');
    return { tier: 1, rule: ids.join('/'), why: `源码命中跨进程/安全 API：${desc}` };
  }

  const isUI = rel.startsWith('packages/ui/');
  const base = rel.split('/').pop();
  if (isUI) {
    if (rel.endsWith('.tsx')) return { tier: 3, rule: 'R3.1', why: 'UI 组件（React 渲染）' };
    const st = base.match(STATE);
    if (st) return { tier: 2, rule: 'R2.1', why: `UI 层有状态逻辑（文件名含 ${[...new Set(st)].slice(0, 3).join('/')}）` };
    if (T3_PATH.test(rel)) return { tier: 3, rule: 'R3.3', why: '文案/常量/样式资源' };
    if (PRESENT.test(base)) return { tier: 3, rule: 'R3.2', why: `纯呈现辅助（文件名含 ${base.match(PRESENT)[0]}）` };
    return { tier: 2, rule: 'R2.2', why: 'UI 非组件模块，未命中纯呈现特征，保守归二档' };
  }
  if (T3_PATH.test(rel)) return { tier: 3, rule: 'R3.3', why: '文案/常量/样式资源' };

  const st = (base + ' ' + head).match(STATE);
  if (st) return { tier: 2, rule: 'R2.1', why: `有状态核心（命中 ${[...new Set(st)].slice(0, 3).join('/')}）` };
  return { tier: 2, rule: 'R2.2', why: '无安全/跨进程特征，按普通生产逻辑归二档（保守默认）' };
}

const out = rows.map((r) => {
  const c = classify(r.path);
  const units = r.units;
  const covered = r.covered;
  return { file: r.path, units, covered, uncovered: Math.max(0, units - covered), cov: units ? (covered / units) * 100 : 0, ...c };
});

const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
const tierOf = (t) => out.filter((r) => r.tier === t).sort((a, b) => b.uncovered - a.uncovered);
const stat = (a) => {
  const units = sum(a, 'units');
  const covered = sum(a, 'covered');
  return { files: a.length, units, covered, uncovered: units - covered, cov: units ? (covered / units) * 100 : 0 };
};
const tiers = [1, 2, 3].map((t) => ({ tier: t, ...stat(tierOf(t)) }));

const fmt = (n) => n.toLocaleString('en-US');
const pct = (n) => `${n.toFixed(1)}%`;
const row = (r) => `| \`${r.file}\` | ${fmt(r.units)} | ${fmt(r.uncovered)} | ${pct(r.cov)} | ${['一', '二', '三'][r.tier - 1]}档 | ${r.rule}：${r.why}${DONE.has(r.file) ? '（已定格，v2.4 复核）' : ''} |`;

const ts = [['file', 'tier', 'rule', 'reason', 'units', 'covered', 'uncovered', 'coverage'].join('\t')];
for (const r of out) ts.push([r.file, r.tier, r.rule, r.why, r.units, r.covered, r.uncovered, r.cov.toFixed(1)].join('\t'));
fs.writeFileSync('d:/code/ZCode/docs/annotation/ZC-SCOPE-TIERS.tsv', ts.join('\n') + '\n');

// ── 文档 ──
const t1 = tierOf(1);
const t2 = tierOf(2);
const t3 = tierOf(3);
const s1 = tiers[0], s2 = tiers[1], s3 = tiers[2];
const total = stat(out);
// b228 已按 §5.3 两轮抽样定格，不重做；工作量估算扣除它
const DONE = new Set(['packages/desktop/src/main/browserView/browserGuestManager.ts']);
const open1 = t1.filter((r) => !DONE.has(r.file));
const s1o = stat(open1);
// §5.3 取小者（v2.4）：R≤120 全读；R>120 首轮 60 条。后续轮次不计入最低成本。
const FULL_MAX = 120;
const fullSet = open1.filter((r) => r.uncovered <= FULL_MAX);
const sampSet = open1.filter((r) => r.uncovered > FULL_MAX);
const fullCost = fullSet.reduce((s, r) => s + r.uncovered, 0);
const sampCost = sampSet.length * 60;

// 一档内部优先序（A 不可逆 / B 可恢复），判据可检索：先命中不可逆词表，再命中可恢复词表，都不命中按不可逆默认。
const SPECIAL = /(credential|token|secret|oauth|auth|permission|privilege|sandbox|keychain|cipher|encrypt|decrypt|update|updater|install|sign|signature|deploy|ssh|wsl|docker|shell|kill|terminate|delete|unlink|truncate|overwrite|save|database|sqlite|migrat|localmediapreviewprotocol)/i;
const RECOVERABLE = /(cache|cdn|telemetry|metric|log|trace|sampl|snapshot|sync|viewport|display|screenshot|screen|recorder|recording|webm|video|audio|tray|icon|theme|layout|chrome|window|resize|focus|indicator|overlay|cursor|notification|clipboard|preview|list|detect|discovery|probe|status|progress|heartbeat|reconnect|residency|recovery|restore|history|timeout|open|editor|application|print|pdf|resource|pip|network)/i;
function prio(path) {
  const base = path.split('/').pop();
  if (SPECIAL.test(base)) return { g: 'A', why: `文件名含 ${base.match(SPECIAL)[0]}（不可逆操作）` };
  if (RECOVERABLE.test(base)) return { g: 'B', why: `文件名含 ${base.match(RECOVERABLE)[0]}（可恢复对象）` };
  return { g: 'A', why: '未命中可恢复特征，按不可逆默认（保守）' };
}
const open1p = open1.map((r) => ({ ...r, ...prio(r.file) }));
const groupA = open1p.filter((r) => r.g === 'A').sort((a, b) => b.uncovered - a.uncovered);
const groupB = open1p.filter((r) => r.g === 'B').sort((a, b) => b.uncovered - a.uncovered);

const md = [];
md.push(`# ZC 注释范围分档表（2026-11-10）
`);
md.push(`> 口径：全文件覆盖率 = \`covered / units\`（\`deep-quality.mjs --metric-version v3\`）。**不是** b228 的逻辑区口径；逻辑区权威分母与抽样分母的分工见 \`ZC-DEEP-b228.md\` §8.1。
> 分档按**风险**，不按未覆盖数。判据列直接引用 §1 的规则编号，规则全部可检索（路径正则 / 源码 API / 文件名 token），不靠语感。
> 扫描范围：\`packages/desktop/src/main\` 235 + \`packages/services\`、\`packages/rpc\`、\`packages/server\` 537 + \`packages/ui\` 1958 = **2730 文件 / ${fmt(total.units)} 单元**。范围外的包见 §7。
`);
md.push(`## 1. 判档规则（可检索）

按下列顺序命中即停；命中第一条即定档，后续规则不再看。

### 一档：安全相关 / 跨进程边界

| 规则 | 检索条件 | 判据 |
| --- | --- | --- |
| R1.1 | 路径匹配 \`packages/desktop/src/main/(browserView|pluginSandbox|mcpUserDirectory|web-remote-relay|embedded-browser-permission-contract)/\` | guest 生命周期、沙箱、权限契约；main↔guest 跨进程 |
| R1.2 | 路径匹配 \`packages/rpc/\` | main↔renderer 的 RPC 传输、序列化与通道 |
| R1.3 | 路径匹配 \`packages/server/\` | 网络入口、SSH/Docker/WSL 远程执行、部署与鉴权 |
| R1.4 | 路径名含 \`oauth|auth|permission|credential|cookie|secure|security|sandbox|keychain|safeStorage\` | 鉴权/凭据/沙箱域 |
| R1.5 | 源码含 \`ipcMain.handle/on\`、\`ipcRenderer.invoke/send\`、\`contextBridge.exposeInMainWorld\` | IPC 注册点/调用点，跨进程入口 |
| R1.6 | 源码含 \`setPermissionRequestHandler\`、\`setWindowOpenHandler\`、\`will-attach-webview\` | 权限与 webview 安全属性 |
| R1.7 | 源码含 \`new BrowserView\`、\`new WebContentsView\`、\`session.fromPartition\` | guest 视图 / session 划分 |
| R1.8 | 源码含 \`protocol.handle\`、\`registerSchemesAsPrivileged\`、\`protocol.intercept*\` | 自定义协议注册点 |
| R1.9 | 源码含 \`safeStorage.encryptString/decryptString/isEncryptionAvailable\`、\`keytar.*\` | 凭据存储 API（明文/加密读写） |
| R1.10 | 源码含 \`MessageChannelMain\`、\`MessagePortMain\` | main↔utility 消息通道 |
| R1.11 | 源码含 \`from 'child_process'\`/\`require('child_process')\`，或 \`execFile\`/\`spawnSync\`/\`execSync\` 调用 | OS 命令执行边界（注入面） |
| R1.12 | 源码含 \`isPathInside\`、\`resolveUserPath\`、\`assertWithin*\`、\`pathTraversal\` | 路径穿越校验 |

> 例外：\`packages/ui/\` 下的 \`sandbox/auth/permission\` 命名多为展示组件，不触发 R1.4；若其中真有安全 API，仍会被 R1.5–R1.12 捕获。安全实现应在 main/services，不在渲染层。

### 二档：有状态的核心逻辑

| 规则 | 检索条件 | 判据 |
| --- | --- | --- |
| R2.1 | 文件名或源码含 \`session|queue|scheduler|lock|mutex|semaphore|retry|backoff|persist|repository|database|sqlite|transaction|cache|recovery|migration|snapshot|store|storage|updater|download|checkpoint|journal|lease|heartbeat|reconnect\` | 会话/锁/队列/重试/持久化/恢复 |
| R2.2 | 以上都不命中 | 普通生产逻辑，**保守默认二档**（不许因为"看不出风险"降到三档） |

### 三档：纯呈现与格式

| 规则 | 检索条件 | 判据 |
| --- | --- | --- |
| R3.1 | \`packages/ui/\` 下 \`.tsx\` | React 组件，纯渲染 |
| R3.2 | \`packages/ui/\` 下 \`.ts\`，文件名含呈现词（\`pane|layout|view|style|theme|icon|format|label|text|scroll|zoom|...\`） | 纯呈现辅助（渲染/格式化/几何计算） |
| R3.3 | 路径含 \`i18n|locales|translations|messages|copy|theme|styles|colors|icons|assets|fonts|constants\` | 文案、常量、样式资源 |

> UI 下既不含状态词、也不含呈现词的 \`.ts\`（如 telemetry supervisor、connection flow）**不降到三档**，按 R2.2 保守归二档。三档只放"能一眼看出是呈现"的文件，避免用"目录在 ui 下"当免责理由。

> 三档不是"不做"：函数级块注释必须回答**目的 / 谁调用 / 失败或异常路径**。一个函数写完三行仍说不出这三点，就以 \`文件:函数名\` 记入批次文档的「无注释价值函数」清单——这是允许的结论，但必须被点名，不能默默跳过。
`);
md.push(`## 2. 分档合计

| 档 | 文件 | 单元 | 已覆盖 | 未覆盖 | 现在覆盖率 | 处理标准 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 一档（安全/跨进程） | ${fmt(s1.files)} | ${fmt(s1.units)} | ${fmt(s1.covered)} | ${fmt(s1.uncovered)} | ${pct(s1.cov)} | 按 §5.3 取小者收尾：R≤120 全读、R>120 抽 60 至连续 60 条无缺口 |
| 二档（有状态核心） | ${fmt(s2.files)} | ${fmt(s2.units)} | ${fmt(s2.covered)} | ${fmt(s2.uncovered)} | ${pct(s2.cov)} | 逻辑区 40% 上下 + 全文件级块注释；残余一次 60 条抽样交代 |
| 三档（纯呈现/格式） | ${fmt(s3.files)} | ${fmt(s3.units)} | ${fmt(s3.covered)} | ${fmt(s3.uncovered)} | ${pct(s3.cov)} | 函数级块注释（目的/调用方/失败路径），不逐行 |
| **合计** | **${fmt(total.files)}** | **${fmt(total.units)}** | **${fmt(total.covered)}** | **${fmt(total.uncovered)}** | **${pct(total.cov)}** | — |

> 二档、三档的"未覆盖"只用于排工作量，不用于决定是否做。**按风险定档，按档定写法。**
`);
md.push(`## 3. 一档（${fmt(s1.files)} 文件 / 未覆盖 ${fmt(s1.uncovered)}；其中 ${DONE.size} 个已定格，待做 ${open1.length} 个）

按未覆盖降序。这是下一步的候选范围。\`browserGuestManager.ts\` 已按 §5.3 定格（b228；修复后连续 60 条无缺口，v2.4 复核成立），不在待做清单里。

> 分母口径修正（v2.4）：import 的多行续行不再计单元，本表单元数已按修正后的脚本重算，与修正前的覆盖率**不可逐文件对比**。修正前的旧表只作历史记录。

| 文件 | 单元 | 未覆盖 | 现在覆盖率 | 建议档 | 判据 |
| --- | ---: | ---: | ---: | --- | --- |
${t1.map(row).join('\n')}
`);
md.push(`## 4. 二档（${fmt(s2.files)} 文件 / 未覆盖 ${fmt(s2.uncovered)}）

只列未覆盖前 60；全量见 \`ZC-SCOPE-TIERS.tsv\`。

| 文件 | 单元 | 未覆盖 | 现在覆盖率 | 建议档 | 判据 |
| --- | ---: | ---: | ---: | --- | --- |
${t2.slice(0, 60).map(row).join('\n')}
`);
md.push(`## 5. 三档（${fmt(s3.files)} 文件 / 未覆盖 ${fmt(s3.uncovered)}）

只列未覆盖前 40；全量见 \`ZC-SCOPE-TIERS.tsv\`。

| 文件 | 单元 | 未覆盖 | 现在覆盖率 | 建议档 | 判据 |
| --- | ---: | ---: | ---: | --- | --- |
${t3.slice(0, 40).map(row).join('\n')}
`);
md.push(`## 6. 一档工作量估算（按 b228 实际消耗折算）

b228 的实耗：2626 单元、2024 行新增、16 批。折算系数：

- 注释行 / 单元 = 2024 / 2626 = **0.771 行/单元**
- 吞吐 = 2626 / 16 = **164 单元/批**（约 126 行/批）
- 该 0.771 对应的终点是逻辑区 61.4%（全文件 45.8%）

下表已扣除 \`browserGuestManager.ts\`（2626 单元、1202 已覆盖、已按 §5.3 定格），只算待做的 ${open1.length} 个文件 / ${fmt(s1o.units)} 单元。

| 口径 | 需补单元 | 折合注释行 | 折合批次 | 相当于 b228 |
| --- | ---: | ---: | ---: | ---: |
| 一档补到全文件 45%（≈逻辑区 60%） | ${fmt(Math.round(0.45 * s1o.units - s1o.covered))} | ${fmt(Math.round(0.771 * (0.45 * s1o.units - s1o.covered)))} | ${fmt(Math.round((0.45 * s1o.units - s1o.covered) / 164))} | ${((0.45 * s1o.units - s1o.covered) / 164 / 16).toFixed(1)} |
| 一档补到全文件 60%（更严） | ${fmt(Math.round(0.6 * s1o.units - s1o.covered))} | ${fmt(Math.round(0.771 * (0.6 * s1o.units - s1o.covered)))} | ${fmt(Math.round((0.6 * s1o.units - s1o.covered) / 164))} | ${((0.6 * s1o.units - s1o.covered) / 164 / 16).toFixed(1)} |
| 一档全量 | ${fmt(s1o.uncovered)} | ${fmt(Math.round(0.771 * s1o.uncovered))} | ${fmt(Math.round(s1o.uncovered / 164))} | ${(s1o.uncovered / 164 / 16).toFixed(1)} |

结论：一档按"逻辑区 60% + 抽样定格"走完，量级约 **${fmt(Math.round(0.45 * s1o.units - s1o.covered))} 个单元 / ${fmt(Math.round(0.771 * (0.45 * s1o.units - s1o.covered)))} 行注释 / ${fmt(Math.round((0.45 * s1o.units - s1o.covered) / 164))} 批**，相当于 **${((0.45 * s1o.units - s1o.covered) / 164 / 16).toFixed(1)} 个 b228**。

**文件级收尾的固定成本（按 v2.4 取小者重算）。** 旧规则「每个文件固定两轮 120 条」给出 ${fmt(s1o.files)} × 120 = **${fmt(s1o.files * 120)} 条**——**该数是旧规则下的错误估算，已作废**。按 §5.3：${fmt(fullSet.length)} 个文件 R≤120，合计 ${fmt(fullCost)} 个单元全读；${fmt(sampSet.length)} 个文件 R>120，首轮 60 条共 ${fmt(sampCost)} 条；**最低 ${fmt(fullCost + sampCost)} 条判定**。

> 这个数只是最低值：① 不含 R>120 文件后续的「重抽 60 条 + 修补」轮次；② 不含补缺口本身的注释成本；③ 全读的成本就是 R，R 越接近 120 越贵。把 ② 加回来，一档的真实量级是 **约 ${fmt(Math.round(0.771 * (0.45 * s1o.units - s1o.covered)))} 行注释 + ${fmt(s1o.files)} 份收尾记录 + ≥${fmt(fullCost + sampCost)} 条判定**。

二档按 40% 走：按 b228 的逻辑区/全文件比（61.4 / 45.8 ≈ 1.34）折算，逻辑区 40% 约等于全文件 30%；需补 ${fmt(Math.round(0.3 * s2.units - s2.covered))} 单元、约 ${fmt(Math.round(0.771 * (0.3 * s2.units - s2.covered)))} 行、${fmt(Math.round((0.3 * s2.units - s2.covered) / 164))} 批（约 ${((0.3 * s2.units - s2.covered) / 164 / 16).toFixed(1)} 个 b228），另加 ${fmt(s2.files)} 个文件的全文件级块注释（不按单元计价）。若直接按全文件 40% 算，是 ${fmt(Math.round(0.4 * s2.units - s2.covered))} 单元 / ${fmt(Math.round(0.771 * (0.4 * s2.units - s2.covered)))} 行 / ${fmt(Math.round((0.4 * s2.units - s2.covered) / 164))} 批，偏保守。

二档的"残余一次 60 条"还有一个必须先定死的口径：按**文件**算 = ${fmt(s2.files)} × 60 = **${fmt(s2.files * 60)} 条判定**；按**批**合并算（${fmt(Math.round((0.3 * s2.units - s2.covered) / 164))} 批）= ${fmt(Math.round((0.3 * s2.units - s2.covered) / 164) * 60)} 条。两者差 13 倍，开工前必须写进预登记，不能等做完再解释。

三档按函数级：${fmt(s3.files)} 个文件，不以单元计价。按正则近似统计，函数锚点约 **9,279 个**（均 8.7/文件）；按每函数 3 行（目的/调用方/失败路径）计，约 **27,800 行**。这是近似值，开工前需按文件实测函数边界，不能沿用 b228 的单元折算。写不满三行的函数以 \`文件:函数名\` 记入「无注释价值函数」清单——允许存在，但必须点名。
`);
md.push(`## 7. 不在本表范围（必须单独决策）

以下包未扫描，不得据本表宣称"ZCode 全仓已分档"：

- \`apps/zcode-cli\`：约 2979 个 TS/JS 文件（含 \`packages/core\` 工具层；legacy 队列里的 \`edit.ts\` 在此）。
- \`packages/client\`、\`packages/shared\`、\`packages/provider\`、\`packages/provider-node\`、\`packages/web\`、\`packages/web-share\`、\`packages/share-ui\`、\`packages/android\`、\`packages/zcode-cua\`、\`packages/zcode-server-cli\` 等。

这些包若要进入范围，先按 §1 同一套规则扫描分档，不另行拍口径。
`);

const prioStat = (a) => ({ files: a.length, units: sum(a, 'units'), uncovered: sum(a, 'uncovered') });
const pa = prioStat(groupA), pb = prioStat(groupB);
md.push(`## 8. 一档内部优先序（不可逆 / 可恢复）

判据只有一条：**这个文件出问题，后果是不可逆的还是可恢复的。**

| 组 | 判定 | 文件 | 单元 | 未覆盖 | 收尾标准 |
| --- | --- | ---: | ---: | ---: | --- |
| A 第一优先 | 凭据泄露、远程执行、文件删除、越权写入 | ${fmt(pa.files)} | ${fmt(pa.units)} | ${fmt(pa.uncovered)} | 全量标准，做到 §5.3 抽样定格 |
| B 第二优先 | 缓存、视图同步、采样上报 | ${fmt(pb.files)} | ${fmt(pb.units)} | ${fmt(pb.uncovered)} | 每个函数体有归属即可收尾，不追百分比 |

分组可检索：文件名先命中不可逆词表（credential/token/oauth/auth/permission/sandbox/cipher/update/install/sign/deploy/delete/overwrite/save/database/migrat/...），再命中可恢复词表（cache/telemetry/metric/log/snapshot/sync/screen/recorder/tray/theme/...），**都不命中按不可逆默认**——不允许因为"看不出风险"降到 B。

### A 组（前 30，按未覆盖降序）

| 文件 | 单元 | 未覆盖 | 判据 |
| --- | ---: | ---: | --- |
${groupA.slice(0, 30).map((r) => `| \`${r.file}\` | ${fmt(r.units)} | ${fmt(r.uncovered)} | ${r.why} |`).join('\n')}

### B 组（全量）

| 文件 | 单元 | 未覆盖 | 判据 |
| --- | ---: | ---: | --- |
${groupB.map((r) => `| \`${r.file}\` | ${fmt(r.units)} | ${fmt(r.uncovered)} | ${r.why} |`).join('\n')}
`);

fs.writeFileSync('d:/code/ZCode/docs/annotation/ZC-SCOPE-TIERS.md', md.join('\n') + '\n');
fs.writeFileSync('d:/code/_annot_baseline/_tiers.json', JSON.stringify({ tiers, files: out }, null, 1));

console.log(JSON.stringify({ tiers, total }, null, 1));
for (const t of [1, 2, 3]) console.log(`T${t} top5:\n` + tierOf(t).slice(0, 5).map((r) => `${r.uncovered}\t${r.units}\t${r.cov.toFixed(0)}%\t${r.file}\t${r.why}`).join('\n'));
console.log('written ZC-SCOPE-TIERS.md / .tsv');
