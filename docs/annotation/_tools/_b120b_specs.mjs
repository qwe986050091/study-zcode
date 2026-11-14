import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/BotsDialog/shared.tsx',
    first: 'import { Bot, Webhook } from "lucide-react";',
    target: 42,
    header: [
      '// INV-01 全部工作区用空列表表示：守住位置 工作区判定；改错故障 新工作区默认不可见。',
      '// INV-02 绑定码有效期复用共享常量：守住位置 常量再导出；改错故障 前后端倒计时不一致。',
      '// INV-03 机器人父地址固定：守住位置 父地址常量；改错故障 引导跳到错误页面。',
      '// INV-04 展示名去空白后回退：守住位置 展示名函数；改错故障 空白名显示为空。',
      '// INV-05 绑定码状态四项齐全：守住位置 状态类型；改错故障 倒计时缺少起始时间。',
      '// INV-06 飞书注册含双域名：守住位置 域名与轮询域名；改错故障 国际版轮询错域名。',
      '// INV-07 微信注册无域名：守住位置 状态联合类型；改错故障 多余字段进入状态机。',
      '// INV-08 渠道图标按来源映射：守住位置 嵌套三元；改错故障 渠道显示通用机器人图标。',
      '// INV-09 未知来源回退通用图标：守住位置 末尾兜底；改错故障 图标区域为空。',
      '// INV-10 钩子来源单独图标：守住位置 钩子分支；改错故障 钩子显示机器人脸。',
      '// INV-11 图标对读屏隐藏：守住位置 隐藏属性；改错故障 读屏朗读装饰图。',
      '// INV-12 图标尺寸可被覆盖：守住位置 类名合并；改错故障 调用方无法调整大小。',
      '// INV-13 运行文案优先本地化键：守住位置 消息标识判断；改错故障 多语言环境显示英文。',
      '// INV-14 无格式化再退原始消息：守住位置 空值合并顺序；改错故障 无格式函数时文案为空。',
      '// INV-15 运行点按状态分色：守住位置 状态判断顺序；改错故障 错误与轮询同色。',
      '// INV-16 未启用使用边框色：守住位置 末尾分支；改错故障 停用机器人显示活跃色。',
      '// INV-17 倒计时向上取整到秒：守住位置 取整与下界；改错故障 倒计时出现负数。',
      '// INV-18 默认命令全开：守住位置 返回值七项；改错故障 新机器人默认禁用命令。',
      '//',
      '// 模块职责：机器人设置弹窗共享的类型、常量与展示工具。',
      '// 状态所有权：无状态；注册与绑定状态由上层持有。',
      '// 阅读顺序：先看状态类型与常量，再读展示名与图标，最后看运行文案与倒计时。',
    ],
    blocks: [
      {
        anchor: 'export function ProviderIcon({',
        lines: [
          '图标按渠道来源挑选。',
          '未列来源回退通用图标。',
          '钩子来源用专用图标。',
          '图片图标对读屏隐藏。',
          '尺寸类名由调用方合并。',
        ],
      },
      {
        anchor: 'export function runtimeText(',
        lines: [
          '有消息标识先本地化。',
          '缺格式函数退回原始消息。',
          '再退状态字符串。',
          '最后按启用态给默认词。',
          '该函数不缓存结果。',
        ],
      },
      {
        anchor: 'export function runtimeDot(',
        lines: [
          '错误态用危险色。',
          '轮询与已连接用成功色。',
          '已启用但未知态用次要前景。',
          '未启用用边框色。',
          '判断按严重度从高到低。',
        ],
      },
      {
        anchor: 'export function formatBindCountdown(ms: number): string {',
        lines: [
          '毫秒转秒并向上取整。',
          '负数被夹到零。',
          '结果带秒后缀。',
          '不做本地化。',
          '该函数为纯函数。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/ui/input-group.tsx',
    first: '"use client";',
    target: 43,
    header: [
      '// INV-01 输入组容器角色固定：守住位置 分组角色；改错故障 读屏不再聚合子控件。',
      '// INV-02 数据槽标记固定：守住位置 槽属性；改错故障 样式选择器失效。',
      '// INV-03 焦点环由子控件触发：守住位置 焦点可见变体；改错故障 聚焦时无外环。',
      '// INV-04 非法态由子控件传染：守住位置 非法值变体；改错故障 错误边框不显示。',
      '// INV-05 块级对齐改纵向布局：守住位置 块级变体；改错故障 文本域与按钮错行。',
      '// INV-06 文本域自动撑高：守住位置 文本域变体；改错故障 多行输入被裁切。',
      '// INV-07 附加区默认内联起始：守住位置 默认变体；改错故障 图标落到右侧。',
      '// INV-08 附加区点击聚焦输入：守住位置 点击处理器；改错故障 点击空白无响应。',
      '// INV-09 点击按钮不抢焦点：守住位置 最近按钮判断；改错故障 点击按钮后焦点跳走。',
      '// INV-10 禁用态整体降透明：守住位置 组禁用变体；改错故障 禁用后仍显示可用。',
      '// INV-11 按钮尺寸四档：守住位置 尺寸变体；改错故障 图标按钮撑破行高。',
      '// INV-12 按钮默认幽灵样式：守住位置 默认变体；改错故障 内嵌按钮过于抢眼。',
      '// INV-13 按钮不重复接收尺寸：守住位置 类型排除尺寸；改错故障 双尺寸来源冲突。',
      '// INV-14 输入控件去边框与外环：守住位置 类名覆盖；改错故障 组内出现双层边框。',
      '// INV-15 文本域去缩放：守住位置 缩放类；改错故障 用户拖动破坏布局。',
      '// INV-16 文本域与输入共享数据槽：守住位置 同一槽属性；改错故障 两种控件样式分叉。',
      '// INV-17 组件全部具名导出：守住位置 末尾导出表；改错故障 调用方导入路径不统一。',
      '// INV-18 本文件不持有状态：守住位置 纯展示组件；改错故障 组件间共享脏状态。',
      '//',
      '// 模块职责：输入组容器与其附加区、按钮、文本、输入控件的样式封装。',
      '// 状态所有权：无状态；禁用与非法态由子控件或属性传入。',
      '// 阅读顺序：先看容器与变体表，再读附加区点击，最后看按钮与输入控件。',
    ],
    blocks: [
      {
        anchor: 'function InputGroup({ className, ...props }: React.ComponentProps<"div">) {',
        lines: [
          '容器只负责布局与边框。',
          '角色声明为分组。',
          '数据槽供样式选择。',
          '外部类名最后合并。',
          '其余属性原样透传。',
          '该组件不处理焦点。',
        ],
      },
      {
        anchor: 'const inputGroupAddonVariants = cva(',
        lines: [
          '默认内联起始。',
          '块级变体改为整行。',
          '禁用态由组属性驱动。',
          '内嵌键帽统一圆角。',
          '图标尺寸有兜底。',
        ],
      },
      {
        anchor: 'function InputGroupAddon({',
        lines: [
          '点击空白聚焦输入。',
          '点击按钮不抢焦点。',
          '对齐方式写入数据属性。',
          '变体类名与外部类名合并。',
          '该组件不控制展开。',
        ],
      },
      {
        anchor: 'const inputGroupButtonVariants = cva(',
        lines: [
          '四档尺寸覆盖图标场景。',
          '默认档位为最小号。',
          '圆角与内边距随档位。',
          '阴影统一去掉。',
          '尺寸只在此处定义。',
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
  const total = spec.header.length + spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  const bodyTotal = spec.blocks.reduce((sum, b) => sum + b.lines.length, 0);
  console.log(`${spec.file} header=${spec.header.length} body=${bodyTotal} total=${total} expect=${spec.target} ${total === spec.target ? 'OK' : 'MISMATCH'}`);
  fs.writeFileSync(
    `ZC-deep-b120b-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  index += 1;
}
