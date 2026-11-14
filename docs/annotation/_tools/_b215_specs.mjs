// B215 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/workspace-file-tree/WorkspaceFileTreeStickyFolders.tsx',
    target: 30,
    header: [
      '// INV-01 空列表返回 null：守住位置 items.length 判断；改错故障 页面顶部多出一个空容器吃掉点击。',
      '// INV-02 容器高度为零：守住位置 h-0 与 overflow-visible；改错故障 吸顶行把正文向下顶。',
      '// INV-03 点击权限分两层：守住位置 外层 none 与内层 auto；改错故障 吸顶行永远点不开菜单。',
      '// INV-04 行视图用静态布局：守住位置 layout="static"；改错故障 吸顶行参与虚拟滚动定位，出现重影。',
      '// INV-05 选中判定先判空：守住位置 selectedPath !== null；改错故障 空串把第一个文件标成选中。',
      '// INV-06 git 状态先查映射：守住位置 getWorkspaceFileGitStatus；改错故障 已跟踪文件被忽略集覆盖。',
      '// INV-07 忽略状态只作兜底：守住位置 ?? 右侧三元；改错故障 忽略文件显示为已修改。',
      '// INV-08 目录状态单独汇总：守住位置 getWorkspaceDirectoryGitStatuses；改错故障 目录行显示成文件状态。',
      '// INV-09 展开后下一帧再揭示：守住位置 requestAnimationFrame；改错故障 滚动目标尚未挂载，揭示落空。',
      '// INV-10 回调全部由父级注入：守住位置 props 解构；改错故障 组件自己发请求，测试无法注入。',
      '// INV-11 key 用行路径：守住位置 key={row.path}；改错故障 同目录多行共享展开状态。',
      '// INV-12 样式固定空对象：守住位置 style={{}}；改错故障 动态定位干扰静态布局。',
      '// INV-13 编辑器状态整组透传：守住位置 editorState 三字段；改错故障 新增字段漏传，菜单少项。',
      '// INV-14 本组件只显示与转发：守住位置 文件内无 effect；改错故障 吸顶层出现第二份数据源。',
      '//',
      '// 模块职责：工作区文件树的吸顶文件夹行，复用行视图并转发选择与切换事件。',
      '// 阅读顺序：先看空列表早退与两层容器，再看行视图参数，最后看展开后的揭示时机。',
    ],
    blocks: [
      {
        anchor: 'if (items.length === 0) {',
        lines: [
          '没有吸顶项就不渲染容器。',
        ],
      },
      {
        anchor: '<div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible px-1">',
        lines: [
          '高度为零，靠 overflow-visible 叠在上方。',
        ],
      },
      {
        anchor: '<div className="pointer-events-auto overflow-hidden rounded-lg">',
        lines: [
          '内层恢复点击，否则菜单无法打开。',
        ],
      },
      {
        anchor: 'const row = item.row;',
        lines: [
          'row 是唯一数据源，item 只提供揭示入口。',
        ],
      },
      {
        anchor: 'const handleToggle = (nextRow: WorkspaceFileTreeRow) => {',
        lines: [
          '先交给父级切换，再决定是否揭示。',
        ],
      },
      {
        anchor: 'requestAnimationFrame(() => onRevealRow(item));',
        lines: [
          '等下一帧再滚动，确保展开后的行已挂载。',
        ],
      },
      {
        anchor: 'key={row.path}',
        lines: [
          '同一目录可能有多行，用路径作 key。',
        ],
      },
      {
        anchor: 'layout="static"',
        lines: [
          '静态布局，不参与虚拟列表定位。',
        ],
      },
      {
        anchor: 'selected={selectedPath !== null && areWorkspaceFilePathsEqual(selectedPath, row.path)}',
        lines: [
          '先判空再比较，避免空串命中。',
        ],
      },
      {
        anchor: 'getWorkspaceFileGitStatus(gitStatusByPath, row.path) ??',
        lines: [
          '先查显式状态，缺失时再看忽略集。',
        ],
      },
      {
        anchor: '(isWorkspaceFileGitIgnored(ignoredPathSet, row.path) ? "ignored" : null)',
        lines: [
          '忽略状态只作为兜底。',
        ],
      },
      {
        anchor: 'directoryGitStatuses={getWorkspaceDirectoryGitStatuses(gitStatusByPath, row.path)}',
        lines: [
          '目录状态单独汇总，不能复用文件状态。',
        ],
      },
      {
        anchor: 'style={{}}',
        lines: [
          '静态布局固定空样式，避免动态定位。',
        ],
      },
    ],
  },
  {
    file: 'apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts',
    target: 30,
    header: [
      '// INV-01 排空单飞：守住位置 runtimeCommandDrainActive 早退；改错故障 两条 drain 各取一条，命令被执行两次。',
      '// INV-02 置位与复位包住整个消费循环：守住位置 try/finally；改错故障 中途异常留下半开临界区。',
      '// INV-03 复位必须在 finally：守住位置 finally 第一行；改错故障 消费抛错后队列永久卡死。',
      '// INV-04 同批通知合并一次模型轮：守住位置 runTaskNotificationBatch；改错故障 每条通知各起一个 turn。',
      '// INV-05 混合批直接抛错：守住位置 length 比较；改错故障 语义不同的输入混进同一轮。',
      '// INV-06 非通知批只允许一条：守住位置 commands.length 判断；改错故障 续跑与设置轮被打乱顺序。',
      '// INV-07 消费前校验分支代际：守住位置 isStaleBranchRuntimeCommand；改错故障 rewind 前的命令仍被执行。',
      '// INV-08 有租约只出队预留项：守住位置 dequeueNextRunnableBatch 分支；改错故障 普通命令抢在预留之前出队。',
      '// INV-09 出队与消费租约同一同步步：守住位置 removeById 后立即清 lease；改错故障 中间窗口被别的命令插入。',
      '// INV-10 前台执行槽是唯一取消域：守住位置 beginForegroundExecution；改错故障 Stop 停不到 goal 续跑。',
      '// INV-11 父信号已取消要立即兑现：守住位置 parentAbortSignal.aborted；改错故障 已取消命令仍完整跑完。',
      '// INV-12 释放槽位无条件执行：守住位置 finally 内 finishForegroundExecution；改错故障 runtime 永久 busy。',
      '// INV-13 busy 判定含六项：守住位置 hasActiveOrQueuedTurnWork；改错故障 admission 误判空闲，开出第二条 turn。',
      '// INV-14 Stop 幂等且校验 expected：守住位置 两处早退；改错故障 重复点击报错，或停错别的执行。',
      '//',
      '// 模块职责：runtime command 的入队、批量排空、前台执行槽与晋升租约。',
      '// 阅读顺序：先看 enqueue 与 drain，再看租约与 busy 判定，最后看单条命令生命周期与 Stop。',
    ],
    blocks: [
      {
        anchor: 'export function enqueueRuntimeCommand(this: AgentRuntimeInternal, command: RuntimeCommand): void {',
        lines: [
          '入队只写内存，不等待排空。',
        ],
      },
      {
        anchor: 'if (sourceTaskId && this.runtimeTaskRegistry.get(sourceTaskId)?.offPeakCancelled) return;',
        lines: [
          '已取消任务的通知直接丢弃，没有等待方。',
        ],
      },
      {
        anchor: 'if (offPeakExecutionId) command = { ...command, offPeakExecutionId };',
        lines: [
          '回填执行批次，队列按它划分批量边界。',
        ],
      },
      {
        anchor: 'void this.drainRuntimeCommandQueue();',
        nth: 1,
        lines: [
          '提交侧立即拿到回执，排空异步进行。',
        ],
      },
      {
        anchor: 'if (this.runtimeCommandDrainActive) return;',
        lines: [
          '单飞标志挡住并发 drain。',
        ],
      },
      {
        anchor: 'this.runtimeCommandDrainActive = true;',
        lines: [
          '置位与 finally 复位构成一次临界区。',
        ],
      },
      {
        anchor: 'throw new Error("Runtime command queue returned a mixed task-notification batch");',
        lines: [
          '混合批属于契约破坏，直接失败。',
        ],
      },
      {
        anchor: 'throw new Error(`Runtime command queue returned an unsupported ${firstCommand.mode} batch`);',
        lines: [
          '非通知批只允许一条命令。',
        ],
      },
      {
        anchor: 'this.runtimeCommandDrainActive = false;',
        lines: [
          '复位必须在 finally，否则队列永久卡死。',
        ],
      },
      {
        anchor: 'if (this.runtimeCommandQueue.hasPending() && this.foregroundPromotionLease === undefined) {',
        lines: [
          '只在无租约的空闲沿递归重扫。',
        ],
      },
      {
        anchor: 'if (!promotedCommand) return Object.freeze([]);',
        lines: [
          '预留项不在队列就结束本批，不顺手跑别的。',
        ],
      },
      {
        anchor: 'this.foregroundPromotionLease = undefined;',
        nth: 1,
        lines: [
          '出队与消费租约在同一同步步完成。',
        ],
      },
      {
        anchor: 'if (!hasActiveOrQueuedTurnWork.call(this)) this.workflowBlockedReminder?.sessionIdle();',
        lines: [
          '完整 busy 集为空才报告空闲。',
        ],
      },
    ],
  },
  {
    file: 'docs/knip/docs/scripts/get-monthly-sponsorships-github.ts',
    target: 30,
    header: [
      '// INV-01 密钥只从环境读取：守住位置 process.env；改错故障 token 出现在命令行历史里。',
      '// INV-02 一次取全量活动：守住位置 first: 100 与 period: ALL；改错故障 分页缺失导致总额偏低。',
      '// INV-03 活动按时间升序：守住位置 sort；改错故障 先处理后新增，取消被当成无效。',
      '// INV-04 月份先铺零：守住位置 建表循环；改错故障 空月缺键，图表断点。',
      '// INV-05 一次性赞助只计当月：守住位置 isOneTime 分支；改错故障 一次性收入被摊到往后所有月份。',
      '// INV-06 recurringOnly 跳过一次性：守住位置 continue；改错故障 订阅视图混入单次打赏。',
      '// INV-07 取消是移除不是负数：守住位置 delete；改错故障 总额出现负值。',
      '// INV-08 每次变动重算活跃总额：守住位置 reduce；改错故障 后续月份沿用旧总额。',
      '// INV-09 月份键取 ISO 前七位：守住位置 substring(0, 7)；改错故障 跨时区月份错位。',
      '// INV-10 区间裁剪在出口层：守住位置 getGitHubTotals；改错故障 聚合层猜区间，复用时口径不一。',
      '// INV-11 缺 token 立即抛错：守住位置 入口判断；改错故障 发出匿名请求得到空结果。',
      '// INV-12 查询字段与响应类型一致：守住位置 GraphQL 模板；改错故障 运行时字段为 undefined。',
      '// INV-13 缺失档位按零处理：守住位置 两处可选链；改错故障 NaN 污染整月总额。',
      '// INV-14 返回 Map 保留月份顺序：守住位置 建表与遍历顺序；改错故障 输出顺序不稳定。',
      '//',
      '// 模块职责：从 GitHub Sponsors 活动回放每月订阅总额，供文档脚本消费。',
      '// 阅读顺序：先看查询与排序，再看按月回放，最后看区间裁剪与 token 校验。',
    ],
    blocks: [
      {
        anchor: 'const token = process.env.GITHUB_TOKEN_SPONSORSHIPS;',
        lines: [
          '密钥只从环境变量读取。',
        ],
      },
      {
        anchor: 'const getMonthlyTotals = async (options: Options) => {',
        lines: [
          '内层函数保留 token 参数，便于调用方注入。',
        ],
      },
      {
        anchor: 'sponsorsActivities(first: 100, period: ALL) {',
        lines: [
          '一次取全量活动，按月聚合交给本地。',
        ],
      },
      {
        anchor: 'const activities = [...viewer.sponsorsActivities.nodes].sort(',
        lines: [
          '按时间升序回放赞助状态。',
        ],
      },
      {
        anchor: 'const activeRecurring = new Map<string, number>();',
        lines: [
          '活跃赞助按登录名去重。',
        ],
      },
      {
        anchor: "monthlyTotals.set(d.toISOString().substring(0, 7), 0);",
        lines: [
          '先铺零，保证空月也有键。',
        ],
      },
      {
        anchor: 'if (recurringOnly && sponsorsTier?.isOneTime) continue;',
        lines: [
          '只看订阅时跳过一次性赞助。',
        ],
      },
      {
        anchor: "if (!recurringOnly && action === 'NEW_SPONSORSHIP') {",
        lines: [
          '一次性赞助只计入当月。',
        ],
      },
      {
        anchor: "if (action === 'CANCELLED_SPONSORSHIP') activeRecurring.delete(sponsor.login);",
        lines: [
          '取消是移除，不产生负数。',
        ],
      },
      {
        anchor: 'const total = Array.from(activeRecurring.values()).reduce((sum, a) => sum + a, 0);',
        lines: [
          '每次变动后重算活跃总额。',
        ],
      },
      {
        anchor: 'if (month >= monthYear) monthlyTotals.set(month, total);',
        lines: [
          '只覆盖当前及之后的月份。',
        ],
      },
      {
        anchor: "if (!token) throw new Error('GITHUB_TOKEN_SPONSORSHIPS is not set');",
        lines: [
          '缺 token 立即失败，不发匿名请求。',
        ],
      },
      {
        anchor: 'if (month < startMonth || (endMonth && month > endMonth)) monthlyData.delete(month);',
        lines: [
          '区间裁剪留在这里，聚合层不猜。',
        ],
      },
    ],
  },
  {
    file: 'packages/desktop/scripts/mcp-apps-host-fixture/managed-late-checks.ts',
    target: 30,
    header: [
      '// INV-01 每条用例独立命名：守住位置 check 的标题；改错故障 失败信息无法定位场景。',
      '// INV-02 三条用例覆盖三类迟到：守住位置 三个 check 调用；改错故障 替换竞态无人验证。',
      '// INV-03 事件按偏移切片：守住位置 history.slice(offset)；改错故障 统计到上一用例的残留事件。',
      '// INV-04 gate 只扣单个方法：守住位置 env.gates.set；改错故障 页面启动被整体挂起。',
      '// INV-05 gate 用完即删：守住位置 env.gates.delete；改错故障 后续用例永久等待。',
      '// INV-06 新旧 token 必须不同：守住位置 notEqual；改错故障 替换页复用旧实例仍算通过。',
      '// INV-07 旧实例校验必须被拒：守住位置 assert.rejects；改错故障 过期句柄仍可操作。',
      '// INV-08 旧沙箱显式销毁：守住位置 dispose 调用；改错故障 旧窗口泄漏。',
      '// INV-09 游客恒为一：守住位置 countGuests；改错故障 替换变成新增窗口。',
      '// INV-10 端口监听恒为一：守住位置 listeners.ports；改错故障 旧监听未释放。',
      '// INV-11 迟到授权不得授予替换页：守住位置 oldCall 的 error 断言；改错故障 旧许可越权生效。',
      '// INV-12 被拒调用不留执行记录：守住位置 executed 过滤；改错故障 权限阻断形同虚设。',
      '// INV-13 新权限请求单独等待：守住位置 approvals.wait；改错故障 拒绝作用到错误的请求。',
      '// INV-14 用例只读断言：守住位置 不写产品代码；改错故障 测试夹具与产品共用可变状态。',
      '//',
      '// 模块职责：MCP 托管页替换场景的迟到回调用例，验证旧句柄与旧授权不会复活。',
      '// 阅读顺序：先看 prepare 回执用例，再看迟到授权用例，最后看工具注册用例。',
    ],
    blocks: [
      {
        anchor: 'export async function checkLate(',
        lines: [
          '三条用例共用同一夹具与断言入口。',
        ],
      },
      {
        anchor: 'const ui = (code: string) => win.webContents.executeJavaScript(code);',
        lines: [
          '页面脚本统一走这个入口。',
        ],
      },
      {
        anchor: '"retry while prepare reply is withheld discards old handle and serializes replacement",',
        lines: [
          '第一条：扣住 prepare 回执，验证替换与串行。',
        ],
      },
      {
        anchor: 'const offset = env.events.history.length;',
        nth: 1,
        lines: [
          '以当前事件数为起点，只看本轮。',
        ],
      },
      {
        anchor: 'env.gates.set("return:prepareSandbox", gate.promise);',
        lines: [
          '只扣住 prepare，其它桥调用照常。',
        ],
      },
      {
        anchor: 'const stale = env.handles.get(win.webContents.id);',
        lines: [
          '先记住即将被替换的旧句柄。',
        ],
      },
      {
        anchor: 'env.gates.delete("return:prepareSandbox");',
        lines: [
          '用完即删，避免后续页面永远挂起。',
        ],
      },
      {
        anchor: 'assert.notEqual(replacement.instance.token, stale.instance.token);',
        lines: [
          '替换页必须持有新 token。',
        ],
      },
      {
        anchor: 'await assert.rejects(() =>',
        nth: 1,
        lines: [
          '旧实例的校验必须被拒绝。',
        ],
      },
      {
        anchor: 'assert.equal(env.countGuests(), 1);',
        nth: 1,
        lines: [
          '替换不新增游客窗口。',
        ],
      },
      {
        anchor: 'assert.equal((await ui("window.managedState()")).listeners.ports, 1);',
        nth: 1,
        lines: [
          '旧端口监听已经释放。',
        ],
      },
      {
        anchor: 'const pending = await env.agent.approvals.wait((r) => r.params.input?.key === "project-stale");',
        lines: [
          '第二条：先扣住旧页面的项目级授权。',
        ],
      },
      {
        anchor: 'env.agent.events.history.some((e) => e.type === "executed" && e.key.startsWith("project-")),',
        lines: [
          '旧授权迟到也不得留下执行记录。',
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
    `ZC-deep-b215-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
