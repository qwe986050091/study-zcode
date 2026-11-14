import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/app-shell/workflow-artifacts/WorkflowArtifactBody.tsx',
    target: 44,
    header: [
      '// INV-01 预置看板不读字节：守住位置 种类判断；改错故障 看板等待字节加载。',
      '// INV-02 元数据未读完不报缺失：守住位置 展开条件；改错故障 每次打开先闪错误。',
      '// INV-03 字节错误优先展示：守住位置 空值判断；改错故障 错误被加载态覆盖。',
      '// INV-04 无字节即加载态：守住位置 空值分支；改错故障 查看器用空数据渲染。',
      '// INV-05 内容分派单独组件：守住位置 钩子拆分；改错故障 条件渲染改变钩子数量。',
      '// INV-06 文本按类型解码：守住位置 三态判断；改错故障 二进制被当文本。',
      '// INV-07 markdown 传主题：守住位置 属性；改错故障 深色底出现深色字。',
      '// INV-08 pdf 用 Blob 数据源：守住位置 回退构造；改错故障 空 Blob 渲染失败。',
      '// INV-09 图片缺地址给错误提示：守住位置 空值分支；改错故障 出现破图。',
      '// INV-10 pptx 复制独立缓冲：守住位置 切片；改错故障 带偏移的视图渲染错位。',
      '// INV-11 office 仅两种类型编码：守住位置 类型判断；改错故障 大文件白算 base64。',
      '// INV-12 html 走浏览器卡片：守住位置 类型分支；改错故障 进程内执行脚本。',
      '// INV-13 旧版 html 不给预览：守住位置 版本标志；改错故障 预览与文件内容不符。',
      '// INV-14 表外类型给元数据卡：守住位置 末尾回退；改错故障 未知类型白屏。',
      '// INV-15 懒加载重量级查看器：守住位置 动态导入；改错故障 首屏包体膨胀。',
      '// INV-16 内容类型有缺省值：守住位置 空值合并；改错故障 空类型无法分派。',
      '// INV-17 解码按字节与类型记忆：守住位置 依赖数组；改错故障 切版本后显示旧文本。',
      '// INV-18 在浏览器打开可选注入：守住位置 可选属性；改错故障 无宿主时按钮无响应。',
      '//',
      '// 模块职责：工作流产物标签页的正文分派与懒加载查看器装配。',
      '// 状态所有权：产物内容由上层查询，本组件只按类型选择渲染器。',
      '// 阅读顺序：先看文本语言判定，再看正文分派，最后看内容分派。',
    ],
    blocks: [
      {
        anchor: 'function textLanguageFor(contentType: string): string | undefined {',
        lines: [
          '结构化文本按类型给语言。',
          '其余文本统一按纯文本。',
          '未知类型不返回语言。',
          'markdown 不在此列。',
          '语言只决定高亮。',
        ],
      },
      {
        anchor: 'export function WorkflowArtifactBody(props: WorkflowArtifactBodyProps) {',
        lines: [
          '预置看板先分派。',
          '元数据未读完不传缺失文案。',
          '字节错误优先返回。',
          '无字节统一走加载态。',
          '就绪后交给内容组件。',
          '本组件不持有状态。',
        ],
      },
      {
        anchor: 'function WorkflowArtifactContent({',
        lines: [
          '文本三态共用一次解码。',
          'office 只在两种类型编码。',
          'pptx 切片得到独立缓冲。',
          '分派只按内容类型。',
          '每个分支自带容器。',
          '末尾回退到元数据卡。',
        ],
      },
      {
        anchor: 'const officePreview = useMemo<FileBinaryPreview | null>(() => {',
        lines: [
          '非 office 直接返回空。',
          '路径优先取源文件。',
          '字节转成 base64。',
          '总长度取字节长度。',
          '按标识与类型记忆。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/ui/alert-dialog.tsx',
    target: 41,
    header: [
      '// INV-01 根组件透传属性：守住位置 展开语法；改错故障 调用方受控状态失效。',
      '// INV-02 触发器保留插槽标记：守住位置 数据属性；改错故障 样式选择器失配。',
      '// INV-03 传送门独立导出：守住位置 组件拆分；改错故障 无法自定义挂载位置。',
      '// INV-04 遮罩覆盖完整窗口：守住位置 固定定位；改错故障 顶部残留亮条。',
      '// INV-05 遮罩动画随状态：守住位置 数据状态类；改错故障 关闭时无过渡。',
      '// INV-06 内容自带传送门：守住位置 嵌套结构；改错故障 弹窗被父级裁剪。',
      '// INV-07 内容居中且限宽：守住位置 定位与最大宽；改错故障 小屏溢出。',
      '// INV-08 内容圆角无边框：守住位置 样式类；改错故障 出现双边框。',
      '// INV-09 头部左对齐纵向排列：守住位置 布局类；改错故障 标题与描述挤在一行。',
      '// INV-10 底部小屏倒序：守住位置 响应式类；改错故障 主操作落在难触位置。',
      '// INV-11 标题语义独立：守住位置 原语标题；改错故障 读屏读不到标题。',
      '// INV-12 描述保留换行：守住位置 空白规则；改错故障 多段文案挤成一段。',
      '// INV-13 确认按钮复用按钮变体：守住位置 变体组合；改错故障 确认键样式与全站不一致。',
      '// INV-14 取消按钮默认描边：守住位置 空值回退；改错故障 取消键与确认键同权重。',
      '// INV-15 样式可被调用方覆盖：守住位置 合并顺序；改错故障 外部类名被内置类覆盖。',
      '// INV-16 插槽标记统一前缀：守住位置 数据属性命名；改错故障 测试选择器冲突。',
      '// INV-17 组件全部具名导出：守住位置 导出块；改错故障 引用路径不稳定。',
      '// INV-18 不引入额外状态：守住位置 纯包装；改错故障 与弹窗库状态双写。',
      '//',
      '// 模块职责：确认式弹窗的无状态样式与语义包装。',
      '// 状态所有权：开关与焦点全部交给底层弹窗原语。',
      '// 阅读顺序：先看遮罩与内容，再看头部与底部，最后看按钮与导出。',
    ],
    blocks: [
      {
        anchor: 'function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {',
        lines: [
          '属性原样透传。',
          '不维护内部状态。',
          '保留插槽数据属性。',
          '受控与否交给原语。',
          '仅做样式与语义包装。',
        ],
      },
      {
        anchor: 'function AlertDialogOverlay({',
        lines: [
          '固定覆盖整个窗口。',
          '背景半透明并模糊。',
          '打开关闭带淡入淡出。',
          '外部类名最后合并。',
          '独立层级避免被裁剪。',
        ],
      },
      {
        anchor: 'function AlertDialogContent({',
        lines: [
          '自带传送门与遮罩。',
          '居中定位并限制最大宽。',
          '小屏留出边距。',
          '打开带缩放动画。',
          '关闭后立即卸载。',
        ],
      },
      {
        anchor: 'function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {',
        lines: [
          '小屏纵向倒序。',
          '宽屏右对齐横排。',
          '主操作靠右。',
          '间距与头部一致。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/hooks/useWorkspaceServices.tsx',
    target: 42,
    header: [
      '// INV-01 断连服务单例：守住位置 模块缓存；改错故障 每次渲染新建代理。',
      '// INV-02 命令一律拒绝：守住位置 调用实现；改错故障 断连后仍发 RPC。',
      '// INV-03 事件返回空订阅：守住位置 监听实现；改错故障 释放订阅时崩溃。',
      '// INV-04 代理复用真实分类契约：守住位置 通道代理；改错故障 两套事件规则漂移。',
      '// INV-05 远程目标缺会话即断连：守住位置 空值回退；改错故障 请求误路由到本机。',
      '// INV-06 远程目标不回落本机：守住位置 早退分支；改错故障 远程任务查不到。',
      '// INV-07 未注册时用上下文服务：守住位置 空值合并；改错故障 初始化阶段无服务。',
      '// INV-08 基础服务优先注册值：守住位置 合并顺序；改错故障 远端连接污染本地查询。',
      '// INV-09 远程判定先看标识：守住位置 非空判断；改错故障 路径相同被当本地。',
      '// INV-10 路径相同再看身份：守住位置 相等分支；改错故障 同路径远程误判。',
      '// INV-11 活动页远程元数据兜底：守住位置 标签判断；改错故障 仅路径调用走错主机。',
      '// INV-12 多标签同路径不判定：守住位置 数量判断；改错故障 本地多开被当远程。',
      '// INV-13 无路径直接判本地：守住位置 空值早退；改错故障 空路径触发远程查询。',
      '// INV-14 强制无作用域关闭远程：守住位置 选项判断；改错故障 设置页被绑到远端。',
      '// INV-15 连接态三值：守住位置 三元链；改错故障 就绪判断失真。',
      '// INV-16 等待态不可发 RPC：守住位置 就绪字段；改错故障 重连期反复失败重试。',
      '// INV-17 返回值按依赖记忆：守住位置 记忆化；改错故障 每次渲染触发下游重算。',
      '// INV-18 对外保留解析钩子：守住位置 导出函数；改错故障 调用方无法读连接态。',
      '//',
      '// 模块职责：按工作区身份解析应使用的服务访问器与连接态。',
      '// 状态所有权：会话服务归远端会话库，本模块只做选择与降级。',
      '// 阅读顺序：先看断连代理，再看目标解析，最后看解析钩子。',
    ],
    blocks: [
      {
        anchor: 'function createDisconnectedRemoteServices(): IServiceAccessor {',
        lines: [
          '命令调用立即拒绝。',
          '拒绝错误带稳定码。',
          '监听返回空订阅。',
          '复用真实通道代理。',
          '结果在模块级缓存。',
        ],
      },
      {
        anchor: 'export function resolveWorkspaceServicesForTarget(params: {',
        lines: [
          '有会话标识优先取会话服务。',
          '远程目标缺服务给断连代理。',
          '本地目标用基础服务。',
          '无作用域可显式注入。',
          '最后回退到上下文服务。',
        ],
      },
      {
        anchor: 'export function resolveWorkspaceServiceIsRemoteTarget(params: {',
        lines: [
          '标识或会话存在即远程。',
          '无路径直接判本地。',
          '同路径再比身份。',
          '活动页远程元数据兜底。',
          '多个同路径标签不判定。',
        ],
      },
      {
        anchor: 'export function useWorkspaceServicesResolution(',
        lines: [
          '远程目标缺会话保持断连。',
          '强制无作用域关闭远程。',
          '连接态由会话可用性决定。',
          '等待态禁止发 RPC。',
          '结果按依赖记忆。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/project-sidebar/HomeOnlyWorkspaceRows.tsx',
    target: 41,
    header: [
      '// INV-01 单飞打开请求：守住位置 待定键；改错故障 两个切换互相覆盖。',
      '// INV-02 可桥接走切换：守住位置 类型判断；改错故障 远程目标走错入口。',
      '// INV-03 不可桥接走重连：守住位置 分支；改错故障 桌面已有连接被重建。',
      '// INV-04 重连后刷新列表：守住位置 调用顺序；改错故障 状态显示过期。',
      '// INV-05 失败统一提示：守住位置 捕获分支；改错故障 用户看不到原因。',
      '// INV-06 失败先记日志：守住位置 日志调用；改错故障 线上问题无痕迹。',
      '// INV-07 结束必清待定键：守住位置 最终清理；改错故障 按钮永久禁用。',
      '// INV-08 待定期间禁用全部行：守住位置 禁用条件；改错故障 并发请求打架。',
      '// INV-09 无重连能力即禁用：守住位置 条件组合；改错故障 点击无反应。',
      '// INV-10 连接态映射展示：守住位置 状态解析；改错故障 失败显示为离线。',
      '// INV-11 重连中标记连接中：守住位置 待定键判断；改错故障 无任何进行中反馈。',
      '// INV-12 远程行显示状态图标：守住位置 类型分支；改错故障 远程与本地图标相同。',
      '// INV-13 非桥接追加连接动作：守住位置 双条件；改错故障 用户不知道可点击。',
      '// INV-14 空列表给空态文案：守住位置 长度判断；改错故障 区域空白。',
      '// INV-15 加载中给加载文案：守住位置 双空判断；改错故障 加载与空态同时出现。',
      '// INV-16 错误给重试入口：守住位置 错误分支；改错故障 用户只能刷新整页。',
      '// INV-17 文案全部走国际化：守住位置 格式化调用；改错故障 出现硬编码文本。',
      '// INV-18 行键用工作区键：守住位置 键属性；改错故障 切换后行状态错位。',
      '//',
      '// 模块职责：首页专用工作区列表的打开、重连与状态展示。',
      '// 状态所有权：列表数据归专用钩子，进行中请求归本组件。',
      '// 阅读顺序：先看操作函数，再看连接态派生，最后看渲染分支。',
    ],
    blocks: [
      {
        anchor: 'export function HomeOnlyWorkspaceRows({',
        lines: [
          '列表与错误来自专用钩子。',
          '同时只允许一个进行中请求。',
          '可桥接走切换。',
          '其余走重连并刷新。',
          '失败提示后清理待定键。',
        ],
      },
      {
        anchor: 'const run = async (workspace: WebRemoteControlWorkspaceTarget) => {',
        lines: [
          '先记录待定键。',
          '按可桥接性分派。',
          '重连成功后刷新。',
          '失败记日志并提示。',
          '最终一定清空待定键。',
        ],
      },
      {
        anchor: 'const presentation = resolveRemoteConnectionPresentation({',
        lines: [
          '连接态映射到展示态。',
          '待定且不可桥接算重连中。',
          '失败优先于离线。',
          '连接中视为忙碌。',
          '展示只读派生值。',
        ],
      },
      {
        anchor: 'const busy = presentation.status === "connecting";',
        lines: [
          '连接中禁用整行。',
          '有待定请求也禁用。',
          '无重连能力同样禁用。',
          '禁用时指针显示等待。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAuto = srcLines[0].replace(/\r$/, '').trim();
  const firstAnchor = spec.first ?? firstAuto;
  if (spec.first && firstAnchor !== firstAuto) {
    console.error(`FIRST MISMATCH ${spec.file}\n  spec: ${spec.first}\n  file: ${firstAuto}`);
    process.exit(1);
  }
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(`ZC-deep-b132-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
