// B218 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/lib/mcpStatusProbe.ts',
    target: 30,
    header: [
      '// INV-01 探测只读：守住位置 全部实现；改错故障 测试连接改动了用户配置。',
      '// INV-02 缺 type 时按字段推断：守住位置 normalizeMcpServerConfigForTest；改错故障 旧配置被判为无效类型。',
      '// INV-03 SSE 用 GET 其余用 OPTIONS：守住位置 buildUrlProbeRequest；改错故障 SSE 端点返回 405 被当成不可达。',
      '// INV-04 200~499 视为可达：守住位置 isReachableHttpStatus；改错故障 需要鉴权的端点被误判离线。',
      '// INV-05 5xx 与网络错误不可达：守住位置 三元与 catch；改错故障 服务端崩溃仍显示绿灯。',
      '// INV-06 每次探测独立超时：守住位置 AbortController 与 setTimeout；改错故障 请求悬挂拖住设置页。',
      '// INV-07 finally 清定时器：守住位置 clearTimeout；改错故障 已结束请求仍触发 abort。',
      '// INV-08 缺 url 直接返回配置错误：守住位置 第一个早退；改错故障 fetch 收到 undefined 抛未捕获异常。',
      '// INV-09 stdio 只校验 command：守住位置 testStdioServer；改错故障 测试连接真的拉起子进程。',
      '// INV-10 空 command 视为错误：守住位置 trim 判断；改错故障 空白命令显示连接成功。',
      '// INV-11 耗时统一用 startTime 差值：守住位置 四处 response_time；改错故障 各分支口径不一致。',
      '// INV-12 未知类型带类型名报错：守住位置 末尾模板串；改错故障 用户看不出配置错在哪。',
      '// INV-13 自定义 headers 原样透传：守住位置 RequestInit；改错故障 鉴权头被丢弃。',
      '// INV-14 返回三字段结构固定：守住位置 McpTestResult；改错故障 调用方需要处理多种形状。',
      '//',
      '// 模块职责：MCP 服务器连通性探测，覆盖 URL 与 stdio 两类配置。',
      '// 阅读顺序：先看类型规整与 URL 探测，再看 stdio 校验，最后看总入口的分派。',
    ],
    blocks: [
      {
        anchor: 'const MCP_PROBE_TIMEOUT_MS = 5000;',
        lines: [
          '探测超时集中一处，便于统一调整。',
        ],
      },
      {
        anchor: 'function normalizeMcpServerConfigForTest(config: McpServerConfig): McpServerConfig {',
        lines: [
          '测试前先补齐可推断的 type。',
        ],
      },
      {
        anchor: 'if (config.command) {',
        lines: [
          '有 command 视为 stdio。',
        ],
      },
      {
        anchor: 'if (config.url) {',
        lines: [
          '有 url 视为 http。',
        ],
      },
      {
        anchor: 'method: config.type === "sse" ? "GET" : "OPTIONS",',
        lines: [
          'SSE 需要 GET，其余用 OPTIONS 探测。',
        ],
      },
      {
        anchor: 'return status >= 200 && status < 500;',
        lines: [
          '4xx 也算可达，只关心端点是否存在。',
        ],
      },
      {
        anchor: 'if (!config.url) {',
        lines: [
          '缺 url 直接返回配置错误。',
        ],
      },
      {
        anchor: 'const timeoutId = window.setTimeout(() => controller.abort(), MCP_PROBE_TIMEOUT_MS);',
        lines: [
          '每次探测都有独立超时。',
        ],
      },
      {
        anchor: 'const response = await fetch(config.url, {',
        lines: [
          '请求头原样透传，鉴权由配置负责。',
        ],
      },
      {
        anchor: 'const errorMessage = error instanceof Error ? error.message : "Unknown error";',
        lines: [
          '非 Error 抛出也要有可读文案。',
        ],
      },
      {
        anchor: 'window.clearTimeout(timeoutId);',
        lines: [
          '定时器必须在 finally 清理。',
        ],
      },
      {
        anchor: 'if (!config.command?.trim()) {',
        lines: [
          'stdio 只校验命令非空，不做真实启动。',
        ],
      },
      {
        anchor: 'if (normalizedConfig.url) {',
        lines: [
          '其余可探测类型统一走 URL 探测。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/onboarding/OnboardingAgentsFileStep.tsx',
    target: 30,
    firstNth: 1,
    header: [
      '// INV-01 组件只读迁移状态：守住位置 props.migration；改错故障 引导步骤自己发起探测，与 hook 状态分叉。',
      '// INV-02 可选中要求 supported：守住位置 selected 与 supported 的与；改错故障 缺源文件时仍能勾选。',
      '// INV-03 重新扫描受 loading 约束：守住位置 按钮 disabled；改错故障 连续点击发起多次探测。',
      '// INV-04 错误条独立于卡片：守住位置 卡片外的 error 块；改错故障 探测失败时整步不可操作。',
      '// INV-05 整卡就是切换入口：守住位置 外层 button；改错故障 只有小勾选框可点。',
      '// INV-06 不支持时整卡禁用：守住位置 disabled={!supported}；改错故障 点击无反馈但状态被改。',
      '// INV-07 勾选空态用透明文字：守住位置 text-transparent；改错故障 空态尺寸与选中态不一致。',
      '// INV-08 源与目标路径各一行：守住位置 两个 grid；改错故障 路径挤在一行无法复制。',
      '// INV-09 缺路径回落加载文案：守住位置 两处 ??；改错故障 首帧出现空白单元格。',
      '// INV-10 路径等宽并截断：守住位置 font-mono truncate；改错故障 长路径撑破卡片。',
      '// INV-11 缺源警告只在非加载态：守住位置 双条件；改错故障 扫描中先闪一次警告。',
      '// INV-12 全部文案走 intl：守住位置 所有 formatMessage；改错故障 页面出现硬编码中文。',
      '// INV-13 勾选框无独立点击区：守住位置 内层 div；改错故障 出现两个焦点目标。',
      '// INV-14 不派生额外状态：守住位置 组件内无 useState；改错故障 刷新后选中态与 hook 脱节。',
      '//',
      '// 模块职责：引导流程的 AGENTS.md 迁移步骤，展示路径并允许勾选复制。',
      '// 阅读顺序：先看 supported 与 selected，再看顶部扫描按钮，最后看卡片与警告。',
    ],
    blocks: [
      {
        anchor: 'export function OnboardingAgentsFileStep(props: { migration: OnboardingAgentsFileMigrationState }) {',
        lines: [
          '组件只读迁移状态，探测由 hook 负责。',
        ],
      },
      {
        anchor: 'const supported = status?.supported === true;',
        lines: [
          '严格比较 true，未知状态不算支持。',
        ],
      },
      {
        anchor: 'const selected = props.migration.selected && supported;',
        lines: [
          '不支持时选中态强制为假。',
        ],
      },
      {
        anchor: 'disabled={props.migration.loading}',
        lines: [
          '加载中禁止重复触发扫描。',
        ],
      },
      {
        anchor: '{props.migration.loading ? (',
        lines: [
          '转圈与刷新图标互斥。',
        ],
      },
      {
        anchor: '{props.migration.error ? (',
        lines: [
          '错误条独立于卡片，失败仍可重扫。',
        ],
      },
      {
        anchor: 'disabled={!supported}',
        lines: [
          '不支持时整卡不可点。',
        ],
      },
      {
        anchor: 'onClick={() => props.migration.setSelected(!selected)}',
        lines: [
          '整卡就是切换入口。',
        ],
      },
      {
        anchor: 'className={`flex size-4 items-center justify-center rounded-sm border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-transparent"}`}',
        lines: [
          '用透明文字模拟空态，尺寸不跳动。',
        ],
      },
      {
        anchor: '{status?.sourcePath ?? intl.formatMessage({ id: "onboarding.agentsFile.loading" })}',
        lines: [
          '缺源路径时回落为加载文案。',
        ],
      },
      {
        anchor: '{status?.targetPath ?? intl.formatMessage({ id: "onboarding.agentsFile.loading" })}',
        lines: [
          '缺目标路径时同样回落。',
        ],
      },
      {
        anchor: '{!supported && !props.migration.loading ? (',
        lines: [
          '缺源警告只在加载结束后出现。',
        ],
      },
      {
        anchor: '<AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />',
        lines: [
          '警告图标只是视觉强调。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/plugin-ui/domain/pluginUiToolFeed.ts',
    target: 30,
    header: [
      '// INV-01 纯函数：守住位置 全部导出；改错故障 归约过程中改写投影行。',
      '// INV-02 未完成不产出结果：守住位置 pending 与 in_progress 早退；改错故障 面板显示占位结果。',
      '// INV-03 stopped 走 cancelled 通道：守住位置 isPluginUiToolCancelled；改错故障 被停止的工具伪装成成功。',
      '// INV-04 结构化内容优先数组：守住位置 rawContent 分支；改错故障 图片与资源块丢失。',
      '// INV-05 非对象内容块在此过滤：守住位置 filter 类型守卫；改错故障 宿主收到非法块。',
      '// INV-06 截断只写 _meta：守住位置 mergedMeta；改错故障 内容被替换成提示文本。',
      '// INV-07 isError 合并两种来源：守住位置 展开三元；改错故障 失败结果在面板上显示为成功。',
      '// INV-08 surface 三重匹配：守住位置 kind / surface / pluginId；改错故障 同插件多 surface 串数据。',
      '// INV-09 binding 校验服务与资源：守住位置 serverName 与 resourceUri；改错故障 同名 surface 跨服务污染。',
      '// INV-10 latest 只按 rowId 前进：守住位置 比较链；改错故障 旧行覆盖新行。',
      '// INV-11 同 rowId 状态变化也更新：守住位置 第二个或条件；改错故障 状态标签停在旧值。',
      '// INV-12 result 只由成功且非 isError 覆盖：守住位置 双条件；改错故障 失败结果替换掉上一份好数据。',
      '// INV-13 无变化返回原对象：守住位置 末尾三元；改错故障 宿主每次归约都重发 tool-result。',
      '// INV-14 merge 与 reduce 同一新优规则：守住位置 mergePluginUiSurfaceFeed；改错故障 两条路径收敛到不同快照。',
      '//',
      '// 模块职责：MCP Apps 面板的工具行投喂，包含结果构造、surface 归约与快照合并。',
      '// 阅读顺序：先看输入与结果构造，再看 surface 匹配与归约，最后看合并函数。',
    ],
    blocks: [
      {
        anchor: 'export function readPluginUiToolInput(',
        lines: [
          '只有普通对象才作为输入返回。',
        ],
      },
      {
        anchor: 'export function isPluginUiToolCancelled(toolCall: PluginUiLegacyToolCall | null): boolean {',
        lines: [
          '停止是唯一改走 cancelled 通道的状态。',
        ],
      },
      {
        anchor: 'if (!toolCall || !presentation) return undefined;',
        lines: [
          '缺行或缺呈现就没有载荷。',
        ],
      },
      {
        anchor: 'if (toolCall.status === "pending" || toolCall.status === "in_progress") return undefined;',
        lines: [
          '未完成不产出结果。',
        ],
      },
      {
        anchor: 'const rawContent = parseJsonText(presentation.content);',
        lines: [
          '优先使用 agent 投影的原始内容数组。',
        ],
      },
      {
        anchor: 'const content = Array.isArray(rawContent)',
        lines: [
          '数组内的非对象块在这里丢弃。',
        ],
      },
      {
        anchor: 'const mergedMeta = presentation.truncated',
        lines: [
          '截断只写 _meta，不改内容。',
        ],
      },
      {
        anchor: '...(toolCall.status === "failed" || presentation.isError ? { isError: true } : {}),',
        lines: [
          '两种失败来源合并成一个标志。',
        ],
      },
      {
        anchor: 'display?.kind !== "mcp_tool" ||',
        lines: [
          '三类身份必须同时匹配。',
        ],
      },
      {
        anchor: '(presentation.serverName !== binding.serverName ||',
        lines: [
          '绑定校验防止同 surface 跨服务串流。',
        ],
      },
      {
        anchor: 'row.rowId > latest.rowId ||',
        lines: [
          'latest 只按 rowId 前进。',
        ],
      },
      {
        anchor: '!presentation.isError &&',
        lines: [
          'MCP isError 不覆盖上一份好结果。',
        ],
      },
      {
        anchor: 'return latest === previous.latest && result === previous.result ? previous : { latest, result };',
        lines: [
          '无变化返回原对象，保持引用稳定。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/useProjectTaskActions.ts',
    target: 30,
    header: [
      '// INV-01 适配层不保存事实：守住位置 文件头注释；改错故障 侧栏另存一份状态，与 Host 分叉。',
      '// INV-02 成功后才刷新：守住位置 每个 await refresh；改错故障 失败也刷新，出现无意义请求。',
      '// INV-03 失败统一走 report：守住位置 catch 分支；改错故障 各处错误提示格式不一致。',
      '// INV-04 失败返回 null：守住位置 每个 catch；改错故障 调用方需要额外 try/catch。',
      '// INV-05 pin 先走外部钩子：守住位置 onPin 分支；改错故障 需要确认的场景被直接提交。',
      '// INV-06 钩子存在时由它执行 commit：守住位置 await onPin；改错故障 commit 执行两次。',
      '// INV-07 archive 只在本窗口清理一次：守住位置 removeTaskState；改错故障 主区残留已归档会话。',
      '// INV-08 清理语义与 Header 一致：守住位置 !task.archived；改错故障 取消归档时误删状态。',
      '// INV-09 标记已读带期望时间戳：守住位置 expectedUnreadAt；改错故障 并发下覆盖新的未读。',
      '// INV-10 target 用 memo 固化：守住位置 useMemo；改错故障 每次渲染都重建回调与请求。',
      '// INV-11 remoteSessionId 可为空：守住位置 解析 hook；改错故障 本地任务被要求远端会话。',
      '// INV-12 回调依赖完整：守住位置 各依赖数组；改错故障 闭包拿到过期 task。',
      '// INV-13 入参 id 未使用：守住位置 下划线参数；改错故障 误以为可按任意 id 操作。',
      '// INV-14 只返回五个入口：守住位置 返回值；改错故障 service 泄漏到组件层。',
      '//',
      '// 模块职责：侧栏任务操作的 UI 适配，转调 Host 入口并处理提示与刷新。',
      '// 阅读顺序：先看 target 与 mutate，再看 report，最后看五个动作的差异。',
    ],
    blocks: [
      {
        anchor: 'export function useProjectTaskActions(task: ProjectTask, refresh: () => Promise<void>) {',
        lines: [
          '适配层只调用 Host 入口，不保存事实。',
        ],
      },
      {
        anchor: 'const target = useMemo(',
        lines: [
          '目标身份固化，避免回调依赖抖动。',
        ],
      },
      {
        anchor: 'const mutate = useCallback(',
        lines: [
          '统一注入 service、controller 与远端会话。',
        ],
      },
      {
        anchor: 'logger.error("[project-sidebar] 任务操作失败", { ...target, kind, error });',
        lines: [
          '失败先记结构化日志。',
        ],
      },
      {
        anchor: 'toast(intl.formatMessage({ id: `taskList.${kind}Failed` }));',
        lines: [
          '再按动作给用户一条提示。',
        ],
      },
      {
        anchor: 'await refresh();',
        nth: 1,
        lines: [
          '成功变更后立即刷新列表。',
        ],
      },
      {
        anchor: 'if (onPin) {',
        lines: [
          '外部钩子优先，便于插入确认流程。',
        ],
      },
      {
        anchor: 'await onPin(task, pinned, commit);',
        lines: [
          'commit 由外部决定何时执行。',
        ],
      },
      {
        anchor: 'report("pin", error);',
        lines: [
          '失败只提示，不向上抛。',
        ],
      },
      {
        anchor: 'const result = await mutate({ kind: "archive", archived: !task.archived });',
        lines: [
          '归档是取反操作。',
        ],
      },
      {
        anchor: 'if (!task.archived) removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);',
        lines: [
          '仅归档时清理本窗口任务态。',
        ],
      },
      {
        anchor: 'value ? { kind: "mark-unread" } : { kind: "mark-read", expectedUnreadAt: task.unreadAt },',
        lines: [
          '标记已读要带期望时间戳。',
        ],
      },
      {
        anchor: 'return { remoteSessionId, rename, pin, archive, unread };',
        lines: [
          '只暴露五个入口，不泄漏 service。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b218-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
