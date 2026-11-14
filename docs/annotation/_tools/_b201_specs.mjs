import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/components/marketing-touch/marketingPopupAdapter.ts',
    target: 31,
    header: [
      '// INV-01 有任意模态在场时不得开营销弹窗：守住位置 canOpenMarketingPopup 的查询；改错故障 弹窗叠在登录或支付流程之上。',
      '// INV-02 隐藏标签页同样不弹：守住位置 visibilityState 判断；改错故障 后台恢复时一次性弹多个。',
      '// INV-03 选择器表是唯一白名单：守住位置 拼接数组；改错故障 新模态漏登记后弹窗穿插。',
      '// INV-04 HTML 标签只取纯文本：守住位置 template.content.textContent；改错故障 富文本混入可执行节点。',
      '// INV-05 解析前先移除五类危险节点：守住位置 querySelectorAll；改错故障 带副作用属性的节点被执行。',
      '// INV-06 取不到文本时退化为空串：守住位置 空值合并；改错故障 标题渲染出 null。',
      '// INV-07 按钮 id 按数组下标生成：守住位置 button 加 index；改错故障 两个按钮抢同一个 action。',
      '// INV-08 actions 与 buttons 共用同一 key：守住位置 同一 index；改错故障 点击后找不到对应动作。',
      '// INV-09 只有 close 走次要样式：守住位置 variant 三元；改错故障 主次按钮视觉反转。',
      '// INV-10 计划查看按钮可被文案覆盖：守住位置 labelOverride 的三重条件；改错故障 升级页显示通用按钮名。',
      '// INV-11 navigate 目标只映射到两个内页：守住位置 destination 三元；改错故障 未知 page 值把用户带到空白页。',
      '// INV-12 动作类型必须穷尽：守住位置 末尾的 claim_plan 兜底；改错故障 新增动作被默默当成领取计划。',
      '// INV-13 plaintext 统一归一为 plain_text：守住位置 formatted 字段；改错故障 渲染层按未知 format 处理。',
      '//',
      '// 模块职责：把服务端下发的营销弹窗载荷适配成通用云内容弹窗的入参。',
      '// 阅读顺序：先看可弹出条件与 HTML 取文本，再看按钮映射与动作表。',
    ],
    blocks: [
      {
        anchor: 'export function canOpenMarketingPopup() {',
        lines: [
          '标签页不可见时不弹，避免用户回来看到一串弹窗。',
          '任何对话框在场都算被打断，直接放弃本次弹出机会。',
          '列表同时覆盖通用角色、升级入口与补充材料弹窗。',
        ],
      },
      {
        anchor: 'const template = document.createElement("template");',
        lines: [
          '用 template 解析不会触发图片加载与脚本执行。',
          '先删危险节点再取 textContent，双保险。',
          '取不到文本时返回空串，调用方不需要再判空。',
        ],
      },
      {
        anchor: 'const buttons = popup.buttons.map((button, index) => {',
        lines: [
          '下标即稳定 key：服务端按钮顺序变化会改变 key，属于预期。',
          '文案覆盖只对指定 provider 的模型设置页生效。',
          'formattedLabel 在覆盖时强制纯文本，避免套用富文本格式。',
          '每个按钮同时产出一条 action，两者共用同一个 key。',
        ],
      },
      {
        anchor: 'actions[key] =',
        lines: [
          '四种服务端动作映射到三种通用动作，close 不跳转。',
          'navigate 只区分插件市场与设置，其它值一律落到设置。',
          'claim_plan 是唯一兜底分支，新增类型必须先在这里补映射。',
        ],
      },
      {
        anchor: 'schemaVersion: 1,',
        lines: [
          'revision 固定为 1：同一弹窗不参与增量更新。',
          '标题与描述分别给出可渲染文本与原始格式，供不同端取用。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/git-branch-switcher/switchAssist.ts',
    target: 31,
    header: [
      '// INV-01 只有可提交类 issue 才弹协助：守住位置 isGitBranchCommitAssistIssue；改错故障 无关错误也弹出提交面板。',
      '// INV-02 issue 或目标分支缺失直接返回 null：守住位置 三元早退；改错故障 面板展示空分支名。',
      '// INV-03 三项查询并发且互不拖累：守住位置 allSettled；改错故障 一项失败导致面板整体不可用。',
      '// INV-04 失败只告警不抛出：守住位置 三个 rejected 分支；改错故障 网络抖动打断切分支流程。',
      '// INV-05 失败时按空列表继续：守住位置 fulfilled 判断；改错故障 面板拿到 undefined 后崩溃。',
      '// INV-06 staged 与 unstaged 合并后再去重：守住位置 buildGitBranchCommitPreviewFiles；改错故障 同一文件出现两行。',
      '// INV-07 受影响文件以 issue.paths 为准：守住位置 selectGitBranchAffectedFiles；改错故障 展示与阻断原因不一致。',
      '// INV-08 stage 路径包含 issue.paths 全集：守住位置 Set 合并；改错故障 提交后 issue 仍未消除。',
      '// INV-09 统计口径来自 commitFiles：守住位置 getGitBranchCommitTotals；改错故障 面板行数与实际提交数不符。',
      '// INV-10 身份缺失用 null 而不是 undefined：守住位置 返回结构；改错故障 校验函数走到未定义分支。',
      '// INV-11 无身份视为可提交：守住位置 hasGitCommitIdentity 的首个判断；改错故障 首次配置前无法提交。',
      '// INV-12 身份必须同时有用户名与邮箱：守住位置 布尔与；改错故障 半配置身份提交失败后才报错。',
      '// INV-13 空路径列表格式化为空串：守住位置 长度判断；改错故障 Intl 输出一对空括号。',
      '// INV-14 路径列表按当前语言格式化：守住位置 Intl.ListFormat；改错故障 中文界面出现英文 and。',
      '//',
      '// 模块职责：把切分支失败结果整理成「阻断原因加待提交文件」的面板状态。',
      '// 阅读顺序：先看早退条件与并发查询，再看文件合并与统计口径。',
    ],
    blocks: [
      {
        anchor: 'return new Intl.ListFormat(locale, {',
        lines: [
          '用短格式与 conjunction，输出「a、b 和 c」这类自然语言。',
          '列表为空时不调用 Intl，避免产生空括号。',
        ],
      },
      {
        anchor: 'return identity === null || (Boolean(identity.userName) && Boolean(identity.userEmail));',
        lines: [
          '没有身份信息时不阻断：首次提交可由 git 全局配置兜底。',
          '有身份则必须两项齐全，半配置会让提交在远端失败。',
        ],
      },
      {
        anchor: 'const issue = getPrimaryGitBranchIssue(options.result.issues);',
        lines: [
          '只取首要 issue：面板一次只解决一个阻断原因。',
          '不可提交类 issue 不走这个面板，交给原错误提示。',
          '目标分支名缺失时不构造状态，避免出现空标题。',
        ],
      },
      {
        anchor: 'const [unstagedChangesResult, stagedChangesResult, identityResult] = await Promise.allSettled([',
        lines: [
          '三项并发读取，任何一项失败都不影响其余两项。',
          '用 allSettled 而不是 all：这是可降级的辅助信息。',
          '身份读取失败时按 null 处理，由校验函数决定是否阻断。',
        ],
      },
      {
        anchor: 'const stagePaths = Array.from(',
        lines: [
          '提交文件与 issue 路径取并集，保证阻断原因一定被覆盖。',
          '用 Set 去重，顺序保持首次出现顺序。',
        ],
      },
      {
        anchor: 'return {',
        lines: [
          '目标分支来自切换结果，当前分支来自摘要，两者不可混用。',
          '统计与文件列表同源，避免面板数字与实际不符。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useOAuth.ts',
    target: 32,
    header: [
      '// INV-01 每次登录自增 attempt：守住位置 startLogin 首行；改错故障 旧请求回流覆盖新登录状态。',
      '// INV-02 attempt 不一致即静默返回：守住位置 成功与失败两处比较；改错故障 旧失败关闭新流程的轮询。',
      '// INV-03 启动失败只显示通用文案：守住位置 setError 的 i18n 调用；改错故障 登录页泄漏 provider 与 token 细节。',
      '// INV-04 只有本地凭据解密失败可降级：守住位置 isCredentialDecryptError；改错故障 RPC 错误被当成未登录吞掉。',
      '// INV-05 解密失败仍保留 provider 列表：守住位置 只清 activeProvider；改错故障 用户看到没有任何登录渠道。',
      '// INV-06 列表加载失败才同时清空两者：守住位置 外层 catch；改错故障 局部失败让整页变空。',
      '// INV-07 loadingProviders 必在 finally 收尾：守住位置 finally；改错故障 失败后骨架屏永不结束。',
      '// INV-08 轮询开关只对智谱与 BigModel 打开：守住位置 两个 id 比较；改错故障 其他 provider 白等回调。',
      '// INV-09 先登记 state 再打开浏览器：守住位置 调用顺序；改错故障 回调先到而 state 尚未登记。',
      '// INV-10 埋点只上报 hostname：守住位置 resolveSafeTelemetryHostname；改错故障 state 参数进日志。',
      '// INV-11 cancel 同样自增 attempt：守住位置 cancel 首行；改错故障 取消后旧回调重新拉起等待态。',
      '// INV-12 成功回调必须刷新列表：守住位置 setOAuthSuccess；改错故障 登录后界面仍显示未登录。',
      '// INV-13 回调监听不在本 hook：守住位置 文件头约定；改错故障 出现多份监听，回调被处理两次。',
      '//',
      '// 模块职责：发起 OAuth 登录并维护登录 UI 状态，回调监听由常驻层负责。',
      '// 阅读顺序：先看 attempt 防串号，再看 provider 刷新与启动登录，最后看取消与回调注入。',
    ],
    blocks: [
      {
        anchor: 'const loginAttempt = ++loginAttemptRef.current;',
        lines: [
          '自增即作废旧请求：之后所有旧回调都会被 attempt 比较挡掉。',
          '这一步必须在任何 await 之前，否则两个登录会拿到同一编号。',
          '清 error 与置 waiting 放在同一批状态更新里，避免中间态闪现。',
        ],
      },
      {
        anchor: 'const providerList = await oauthService.getProviders();',
        lines: [
          '先设置加载态再请求，失败路径统一由外层 catch 兜住。',
          'provider 列表成功就立刻落地，不等 active provider。',
        ],
      },
      {
        anchor: 'if (!isCredentialDecryptError(err)) {',
        lines: [
          '只有本地解密失败能降级：它代表凭据坏了而不是链路坏了。',
          '其它错误必须抛出，否则真实的 RPC 故障会被当成未登录。',
          '降级时仅清 active provider，登录渠道列表保持可见。',
        ],
      },
      {
        anchor: 'if (loginAttemptRef.current !== loginAttempt) {',
        nth: 1,
        lines: [
          '拿到授权地址后再校验一次：期间可能有更新的登录发起。',
          '被作废的请求不登记 state、不打开浏览器、不切轮询开关。',
        ],
      },
      {
        anchor: 'platform.registerOAuthState({ state, provider: startedProvider });',
        lines: [
          '先登记 state 再打开浏览器，避免回调早于登记到达。',
          '轮询开关只对需要轮询的两家 provider 打开。',
          '埋点只取 hostname，完整授权地址含 state 不得外泄。',
        ],
      },
      {
        anchor: 'setError(intl.formatMessage({ id: "login.oauth.loginFailure" }));',
        lines: [
          '失败态只给通用文案，原始错误留在日志里。',
          '同时关轮询并清 pending，避免界面停在等待态。',
          '错误文案通过 i18n 渲染，不直接拼接服务端字符串。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts',
    target: 31,
    header: [
      '// INV-01 行键由工作区键加 taskId 组成：守住位置 buildWebRemoteControlTaskRowKey；改错故障 跨工作区同 id 撞键。',
      '// INV-02 跨区判定只比工作区键：守住位置 两个 resolve 结果；改错故障 同路径不同身份被误判为同区。',
      '// INV-03 打开动作先通知调用方跨区与否：守住位置 onTaskOpen 的位置；改错故障 UI 在切换中途才知道要收起面板。',
      '// INV-04 同区路径不看未读配置：守住位置 markTaskReadOnOpen 条件；改错故障 每次打开都写未读。',
      '// INV-05 未读写入失败只告警：守住位置 logReadFailure；改错故障 用户因标记失败打不开任务。',
      '// INV-06 未读是即发即忘：守住位置 void 与 catch；改错故障 打开动作被网络请求阻塞。',
      '// INV-07 查看状态更新失败不影响打开：守住位置 try/catch；改错故障 手机端状态失败导致回不到聊天。',
      '// INV-08 跨区先置切换态再请求：守住位置 onSwitchingChange 顺序；改错故障 切换期间仍可重复点击。',
      '// INV-09 错误对象优先取 message：守住位置 对象判定；改错故障 bridge 拒绝原因被 String 成对象字符串。',
      '// INV-10 失败必须复位切换态：守住位置 catch 内两处回调；改错故障 骨架屏永久卡住。',
      '// INV-11 断连错误退回首页：守住位置 文本匹配分支；改错故障 用户卡在错误页看不到重连按钮。',
      '// INV-12 其他错误交给调用方展示：守住位置 setError；改错故障 错误被静默吞掉。',
      '// INV-13 可选参数透传不补默认值：守住位置 switchWorkspace 的对象展开；改错故障 未提供的字段被写成 undefined。',
      '// INV-14 taskHostId 仅在有 hostId 时传：守住位置 条件展开；改错故障 空串 host 覆盖已有路由。',
      '//',
      '// 模块职责：从手机端远控列表打开指定 task，必要时先切换远控工作区。',
      '// 阅读顺序：先看跨区判定与同区分支，再看跨区切换与失败降级。',
    ],
    blocks: [
      {
        anchor: 'export async function openWebRemoteControlTask({',
        lines: [
          '同区与跨区分成两条完全独立的路径，共享的只有开头判定。',
          '调用方通过回调接收切换态与错误，本函数不持有 UI 状态。',
          '返回值固定为 void，打开是否成功靠回调表达。',
        ],
      },
      {
        anchor: 'const isCrossWorkspace = taskWorkspaceKey !== activeWorkspaceKey;',
        lines: [
          '先算出两边的工作区键，后续所有判断都基于这两个键。',
          '跨区通知要早于任何请求，让面板先收起。',
          '同路径不同身份会被判为跨区，这是有意的保守策略。',
        ],
      },
      {
        anchor: 'if (markTaskReadOnOpen && typeof task.unreadAt === "number" && switcher.markTaskRead) {',
        lines: [
          '三个条件同时满足才写未读，缺一不可。',
          '写入失败只告警，不阻断打开；首页快照会恢复蓝点。',
          '必须显式表达已读，不能依赖桌面选择的缓存命中。',
        ],
      },
      {
        anchor: 'await switcher.switchWorkspace(taskWorkspaceKey, {',
        lines: [
          '可选参数按条件展开，未提供的键不出现在请求里。',
          'hostId 与跳转意图只在存在时透传，避免覆盖既有路由。',
          '未读时间随切换一起带过去，由切换侧完成已读。',
        ],
      },
      {
        anchor: 'if (isDisconnectedRemoteWorkspaceBridgeError(message)) {',
        lines: [
          '断连时退回首页，让用户看到重连入口而不是错误提示。',
          '其余错误交给调用方展示，函数本身不吞消息。',
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
    `ZC-deep-b201-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
