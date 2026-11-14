import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.tsx',
    target: 37,
    header: [
      '// INV-01 能力探测是唯一开关：守住位置 canOpenAsFile；改错故障 按钮出现在不支持的宿主。',
      '// INV-02 探测同时要求两个平台方法：守住位置 双字段判断；改错故障 半实现宿主打开即崩。',
      '// INV-03 不支持时整块缺席：守住位置 返回 null；改错故障 头部留下空壳。',
      '// INV-04 版本化路径缓存：守住位置 pathsRef 的键；改错故障 切换版本后打开旧副本。',
      '// INV-05 缓存存的是 Promise：守住位置 set 时机；改错故障 连点两次触发两次物化。',
      '// INV-06 失败即出缓存：守住位置 catch 清理；改错故障 失败被永久记住无法重试。',
      '// INV-07 字节未就绪直接拒绝：守住位置 bytes 判空；改错故障 空字节写出损坏文件。',
      '// INV-08 主按钮走系统默认应用：守住位置 handleOpenDefault；改错故障 点击无响应。',
      '// INV-09 编辑器选择会持久化偏好：守住位置 persistLastSelectedEditorId；改错故障 每次都要重选。',
      '// INV-10 本机路径不带远程目标：守住位置 openInEditor 选项；改错故障 副本被当远端路径。',
      '// INV-11 打开列表首次展开才加载：守住位置 loadEditors；改错故障 挂载即发起 IPC。',
      '// INV-12 列表失败回落空数组：守住位置 catch 分支；改错故障 菜单永久停在加载中。',
      '// INV-13 显示原位仅在提供回调时出现：守住位置 onReveal 判断；改错故障 菜单出现死项。',
      '// INV-14 打开失败统一提示：守住位置 reportFailure；改错故障 失败静默无反馈。',
      '// INV-15 失败日志带动作与标识：守住位置 日志字段；改错故障 无法定位是哪一版失败。',
      '// INV-16 两个触发按钮同步禁用：守住位置 disabled 变量；改错故障 仅主动作禁用菜单仍可点。',
      '// INV-17 菜单文字全部走 i18n：守住位置 formatMessage；改错故障 出现硬编码文案。',
      '// INV-18 复制路径同样先物化：守住位置 handleCopyPath；改错故障 复制到空字符串。',
      '//',
      '// 模块职责：产物页头部的「作为文件打开」分段按钮与打开方式菜单。',
      '// 状态所有权：编辑器列表与路径缓存为组件局部状态，跨版本按版本号隔离。',
      '// 阅读顺序：先看能力探测，再看路径缓存，最后看菜单动作与失败处理。',
    ],
    blocks: [
      {
        anchor: 'interface ArtifactOpenAsFileButtonProps {',
        lines: [
          '四个标识共同定位一个副本。',
          '文件名决定系统打开方式。',
          '字节未读到时为 null。',
          '显示原位回调完全可选。',
          '回调缺席即菜单少一项。',
        ],
      },
      {
        anchor: 'function canOpenAsFile(platform: IPlatformService | null): platform is MaterializeCapablePlatform {',
        lines: [
          '平台对象存在是前提。',
          '物化方法与打开方法都必需。',
          '只有任一缺失即判定不支持。',
          '判定同时用于渲染与菜单分流。',
          '这里不做任何异步探测。',
        ],
      },
      {
        anchor: 'const ensureLocalPath = useCallback((): Promise<string> => {',
        lines: [
          '键由四个字段拼接而成。',
          '命中缓存直接复用同一个 Promise。',
          '未加载字节时不发起物化。',
          '成功后写入缓存。',
          '失败立刻删除以便重试。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowArtifactIndex.tsx',
    target: 38,
    header: [
      '// INV-01 预览要么读得清要么不画：守住位置 文件头规则；改错故障 出现模糊缩略图。',
      '// INV-02 交付物与其余产物形态区分：守住位置 有框与无框；改错故障 两段层级混淆。',
      '// INV-03 每行高度固定 26px：守住位置 LINE_CLASS；改错故障 长标题把行撑高。',
      '// INV-04 一行永远渲染按钮：守住位置 button 元素；改错故障 不可打开时无法禁用。',
      '// INV-05 不可打开即禁用：守住位置 disabled 属性；改错故障 点击无效却仍获焦点。',
      '// INV-06 关闭态不挂点击处理：守住位置 onClick 条件；改错故障 禁用按钮仍触发回调。',
      '// INV-07 版本号缺省为一：守住位置 空值合并；改错故障 老产物显示 v1 尾槽。',
      '// INV-08 尾槽仅从第二版出现：守住位置 showVersion 判断；改错故障 首版就占位。',
      '// INV-09 版本号变化才重挂：守住位置 key 属性；改错故障 再发布时不播放进场。',
      '// INV-10 打开箭头与版本号共用槽：守住位置 叠放容器；改错故障 两者并排挤压缩略。',
      '// INV-11 详情仅在存在时渲染：守住位置 hasDetail 判断；改错故障 出现空等宽段。',
      '// INV-12 门不是产物：守住位置 MoreLine 语义；改错故障 「还有 N 个」被计入产物数。',
      '// INV-13 被砍过的清单不报数字：守住位置 truncated 判断；改错故障 显示错误的总数。',
      '// INV-14 门的箭头常驻：守住位置 无悬停样式；改错故障 用户不知道还有内容。',
      '// INV-15 列布局由参数决定：守住位置 columns 属性；改错故障 侧板出现两列。',
      '// INV-16 细线仅在跟交付物后出现：守住位置 rule 属性；改错故障 独占卡时多一条横线。',
      '// INV-17 进场延迟按序递增：守住位置 PILL_STAGGER_MS 乘下标；改错故障 所有行同时出现。',
      '// INV-18 可选属性用条件展开：守住位置 展开语法；改错故障 传入 undefined 覆盖默认值。',
      '//',
      '// 模块职责：渲染产物索引的普通行、门的行与整体列布局。',
      '// 状态所有权：无状态；回调、标签与延迟全部由上层注入。',
      '// 阅读顺序：先看行组件，再看门的行，最后看索引容器的布局与延迟。',
    ],
    blocks: [
      {
        anchor: 'function enterStyle(enterDelayMs: number | undefined): CSSProperties | undefined {',
        lines: [
          '延迟缺省或非正即不设样式。',
          '延迟只作用于进场动画。',
          '填充模式用 backwards 保证首帧。',
          '返回 undefined 表示交给默认样式。',
        ],
      },
      {
        anchor: 'function WorkflowArtifactLine({',
        lines: [
          '标题由展示纯函数给出。',
          '种类文案走消息键映射。',
          '可打开性只取决于回调是否存在。',
          '版本尾槽从第二版开始显示。',
        ],
      },
      {
        anchor: 'function WorkflowArtifactMoreLine({',
        lines: [
          '计数可能被发射侧截断。',
          '截断时用省略号替代数字。',
          '门本身不携带产物标识。',
          '可打开性同样只看回调。',
        ],
      },
      {
        anchor: 'export function WorkflowArtifactIndex({',
        lines: [
          '列布局只区分自动与单列。',
          '规则的细线由布尔参数控制。',
          '行延迟以首延迟为基线递增。',
          '门排在所有行之后。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/workflow-timeline/WorkflowCompletionCard.tsx',
    target: 38,
    header: [
      '// INV-01 卡片顺序即论点：守住位置 三段结构；改错故障 数字先于交付物出现。',
      '// INV-02 纯展示不读字节：守住位置 props 边界；改错故障 卡片自己发起请求。',
      '// INV-03 拿不到的格子写破折号：守住位置 parts 为 undefined；改错故障 用零冒充未知。',
      '// INV-04 紧凑计数固定小数位：守住位置 formatCompactCount；改错故障 四格宽度随数据跳动。',
      '// INV-05 千位保留一位小数：守住位置 toFixed；改错故障 读数精度不一致。',
      '// INV-06 百万位保留两位小数：守住位置 第二个分支；改错故障 大数显示过长。',
      '// INV-07 全值放 title：守住位置 title 属性；改错故障 用户看不到精确值。',
      '// INV-08 首帧必须是终值：守住位置 useState 初值；改错故障 静态渲染出现零。',
      '// INV-09 仅在明确允许时翻数字：守住位置 motionAllowed；改错故障 减少动效用户仍看到动画。',
      '// INV-10 问不到媒体查询即落终值：守住位置 环境判断；改错故障 jsdom 下测试抖动。',
      '// INV-11 动画帧在卸载时取消：守住位置 清理函数；改错故障 卸载后仍在 setState。',
      '// INV-12 缓动函数保持单调：守住位置 easeOutCubic；改错故障 数字回跳。',
      '// INV-13 四格共用同一延迟基准：守住位置 figureDelay；改错故障 四格先后错乱。',
      '// INV-14 时长按语言拆分单位：守住位置 workDurationParts；改错故障 单位与语言不匹配。',
      '// INV-15 分隔符随语言变化：守住位置 workDurationUnitSeparator；改错故障 中文出现英文空格。',
      '// INV-16 标签构建只依赖 intl：守住位置 useMemo 依赖；改错故障 切换语言后标签不更新。',
      '// INV-17 布局按截断标志计算：守住位置 useMemo 依赖；改错故障 产物增减后格数不刷新。',
      '// INV-18 头部插槽缺席即不传：守住位置 条件展开；改错故障 空插槽占位。',
      '//',
      '// 模块职责：渲染完成态工作流收据卡，包括交付物、产物索引与四格数字。',
      '// 状态所有权：仅数字翻动是本地动画状态，其余全部由宿主传入。',
      '// 阅读顺序：先看计数格式化，再看数字翻动，最后看卡片组装。',
    ],
    blocks: [
      {
        anchor: 'export function formatCompactCount(count: number): { value: string; unit: string } {',
        lines: [
          '小于一千取原值。',
          '千位区间保留一位小数。',
          '百万区间保留两位小数。',
          '单位与数值分开返回。',
        ],
      },
      {
        anchor: 'function useCountUp(target: number | undefined): number | undefined {',
        lines: [
          '初值直接取目标值。',
          '不允许动画时同步落值。',
          '帧回调按进度取整。',
          '结束帧后不再申请下一帧。',
        ],
      },
      {
        anchor: 'function Figure({',
        lines: [
          '数值段与单位段交替展示。',
          '缺席时用破折号并补可访问名。',
          '进场延迟由外部给定。',
          '测试标识按格子键拼接。',
        ],
      },
      {
        anchor: 'export function WorkflowCompletionCard({',
        lines: [
          '标签构建集中在一次 memo。',
          '布局由产物与截断标志派生。',
          '四个计数各自独立翻动。',
          '数字延迟接在产物落位之后。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useCodingPlanEntryPlanList.ts',
    target: 36,
    header: [
      '// INV-01 状态只有三档：守住位置 联合类型；改错故障 调用方需要判断更多分支。',
      '// INV-02 团队数据必须绑定身份：守住位置 sameIdentity；改错故障 切换账号后显示他人套餐。',
      '// INV-03 还要绑定刷新代次：守住位置 generation 比较；改错故障 重试后沿用旧结果。',
      '// INV-04 团队来源必须全部可用：守住位置 every 判断；改错故障 部分失败仍标就绪。',
      '// INV-05 刷新失败不等于未购买：守住位置 缓存复用条件；改错故障 网络抖动清空已购套餐。',
      '// INV-06 缓存复用需三项一致：守住位置 用户、提供方与令牌；改错故障 串用他人的产品列表。',
      '// INV-07 两个提供方并行读取：守住位置 Promise.all；改错故障 串行拖慢首屏。',
      '// INV-08 令牌读取先裁剪：守住位置 trim；改错故障 空白令牌被当已登录。',
      '// INV-09 无令牌返回空列表而非缺失：守住位置 早退分支；改错故障 后续判空逻辑分叉。',
      '// INV-10 单提供方失败不拖垮整体：守住位置 try 包裹；改错故障 一个异常让整块不可用。',
      '// INV-11 卸载后不再写状态：守住位置 cancelled 标记；改错故障 卸载告警与竞态。',
      '// INV-12 重新挂载可重新请求：守住位置 依赖数组；改错故障 视图变化后不刷新。',
      '// INV-13 重试只在错误态刷新视图：守住位置 status 判断；改错故障 就绪时重复请求。',
      '// INV-14 重试一定推进代次：守住位置 setGeneration；改错故障 相同参数命中缓存不重算。',
      '// INV-15 访问判定复用权益逻辑：守住位置 resolveAccountProviderInspectionAccess；改错故障 未选中套餐被过滤。',
      '// INV-16 缺失判定保留历史成功：守住位置 missing 过滤；改错故障 成功确认未开通被当失败。',
      '// INV-17 加载中合并多项来源：守住位置 pending 表达式；改错故障 提前展示空清单。',
      '// INV-18 就绪才构建入口清单：守住位置 status 三元；改错故障 未就绪时传入空快照。',
      '//',
      '// 模块职责：汇总个人与团队套餐权益，产出可展示的入口套餐清单与加载状态。',
      '// 状态所有权：团队快照与代次为本地状态，权益数据复用独立 hook。',
      '// 阅读顺序：先看身份绑定，再看并行拉取与缓存复用，最后看状态合成。',
    ],
    blocks: [
      {
        anchor: 'export function useCodingPlanEntryPlanList(): CodingPlanEntryInventory {',
        lines: [
          '视图与加载态来自设置视图。',
          '凭据与订阅服务来自服务容器。',
          '权益 hook 关闭指纹自动刷新。',
          '代次用于强制重算。',
          '重试同时刷新视图与代次。',
        ],
      },
      {
        anchor: 'const [teams, setTeams] = useState<{',
        lines: [
          '快照同时记录身份与代次。',
          '两个提供方各自保存令牌与产品。',
          '产品为 null 表示本次读取失败。',
          '身份字段用于命中判断。',
          '代次用于识别过期结果。',
        ],
      },
      {
        anchor: 'const missing = required.filter((item) => {',
        lines: [
          '没有快照即视为缺失。',
          '明确未开通不算缺失。',
          '未认证或带原因视为缺失。',
          '过滤保留仍需等待的项。',
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
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b164-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
