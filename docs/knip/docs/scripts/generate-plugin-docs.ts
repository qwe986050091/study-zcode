// INV-01 所有输出路径都由脚本文件位置推导：守住位置 根目录常量；改错故障 从其他工作目录执行时写到错误位置。
// INV-02 模板目录必须跳过：守住位置 目录遍历判断；改错故障 生成一份无意义的模板文档。
// INV-03 插件元数据只从插件入口模块读取：守住位置 动态导入；改错故障 文档与真实配置脱节。
// INV-04 默认配置按键合并，空数组不写入：守住位置 defaults 构造；改错故障 文档出现空配置块。
// INV-05 文档补充项追加在源码声明之后：守住位置 entry 合并顺序；改错故障 覆盖用户自定义条目。
// INV-06 启用条件文案按声明数量分派：守住位置 enabledText 分支；改错故障 单依赖被写成列表。
// INV-07 启用条件支持字符串、数组与正则三类：守住位置 分支内的类型判断；改错故障 正则源被打印成对象。
// INV-08 默认配置块只在存在条目时生成：守住位置 hasDefaultConfig；改错故障 每页都带空 JSON。
// INV-09 命令行参数说明过滤 binaries 字段：守住位置 argsText 构造；改错故障 内部字段暴露到文档。
// INV-10 值打印必须区分数组、函数与普通值：守住位置 printCode；改错故障 函数被序列化成空对象。
// INV-11 JSON 打印后补空格以便阅读：守住位置 正则替换；改错故障 生成物过于紧凑。
// INV-12 每页固定包含来源链接与生成说明：守住位置 generated 片段；改错故障 无法回溯文档来源。
// INV-13 页面根节点顺序固定：守住位置 tree 构造；改错故障 标题与正文错序。
// INV-14 写文件失败只记录错误并继续：守住位置 writeTree 的捕获；改错故障 单个插件失败中断整轮生成。
// INV-15 序列化配置固定使用 yaml 前置与短横线列表：守住位置 remarkStringify 选项；改错故障 生成物风格漂移。
// INV-16 插件列表按目录名排序：守住位置 末尾排序；改错故障 索引顺序随文件系统变化。
// INV-17 列表标题包含插件总数：守住位置 前置元数据；改错故障 数字与条目不一致。
// INV-18 列表链接指向参考文档相对地址：守住位置 链接构造；改错故障 站点内跳转 404。
//
// 模块职责：扫描 knip 插件目录，为每个插件生成参考文档，并汇总插件索引页。
// 状态所有权：全部为一次性脚本状态；插件清单在内存累积后统一排序写出。
// 阅读顺序：先看路径与解析工具，再读目录遍历中的元数据合并，最后看页面树与索引页。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Root } from 'mdast';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import type { Node } from 'unist';
import { u } from 'unist-builder';
import type { Plugin } from '../../knip/src/types/config.ts';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const referenceDocsDir = path.join(rootDir, 'src/content/docs/reference');
const knipDir = path.join(rootDir, '../../packages/knip');
const pluginsDir = path.join(knipDir, 'src/plugins');
const directories = await fs.opendir(pluginsDir);
const plugins = [];
const srcBaseUrl = new URL('webpro-nl/knip/blob/main/packages/knip/src/plugins', 'https://github.com');

const parseFragment = (text: string) => {
  const tree = unified().use(remarkParse).parse(text);
  return tree.children;
};

// 先 await 插件链产出，再统一序列化 Markdown 选项。
// 前置元数据固定为 yaml，列表统一用短横线。
// [失败路径] 写文件异常只打印并继续，保证整轮生成不被单页阻断。
// 该函数是所有文档落盘的唯一出口。
// 调用方不关心序列化细节，只提供语法树。
const writeTree = async (tree: Node, filePath: string) => {
  try {
    const file = await unified().run(tree);
    const markdown = unified()
      .use(remarkFrontmatter, ['yaml'])
      .use(remarkDirective)
      .use(remarkStringify, {
        bullet: '-',
      })
      .stringify(file as Root);

    await fs.writeFile(filePath, markdown);
  } catch (err) {
    console.error(err);
  }
};

// 只处理 dirent.isDirectory() 且名字不等于模板目录的项。
// 每个插件目录独立 import，元数据取自模块导出。
// 标题与目录名成对 push 进列表，供索引页复用。
// [资源] 目录句柄由 for-await 自动关闭。
// 循环内不捕获导入错误，缺失插件应显式失败。
for await (const dir of directories) {
  if (dir.isDirectory() && dir.name !== '_template') {
    const pluginName = dir.name;
    const pluginDir = path.join(pluginsDir, pluginName);
    const mod = await import(path.join(pluginDir, 'index.ts'));
    const plugin: Plugin = mod.default;
    const docs: undefined | { note: string; entry?: string[]; production?: string[] } = mod.docs;

    const { title, enablers, args, config, entry, production, project } = plugin;

    plugins.push([title, pluginName]);

    const frontmatter = u('yaml', `title: ${title}\nsidebar:\n  hidden: true`);

    // config 为函数时以 { cwd: pluginDir } 求值，否则原样使用。
    // 先写入源码声明的 defaults，再追加文档补充项。
    // 同键补充项用 push 拼接，不覆盖 defaults 已有条目。
    // defaults 中长度为 0 的键视为未声明，不写入配置块。
    // 该对象直接决定默认配置块的 JSON 内容。
    const defaults: Record<string, string[]> = {};
    const configFiles = typeof config === 'function' ? config({ cwd: pluginDir }) : config;
    if (configFiles && configFiles.length > 0) defaults.config = configFiles;
    if (entry && entry.length > 0) defaults.entry = entry;
    if (docs?.entry && docs.entry.length > 0) defaults.entry = [...(defaults.entry ?? []), ...docs.entry];
    if (production && production.length > 0) defaults.entry = [...(defaults.entry ?? []), ...production];
    if (docs?.production && docs.production.length > 0)
      defaults.entry = [...(defaults.entry ?? []), ...docs.production];
    if (project && project.length > 0) defaults.project = project;

    const hasDefaultConfig = Object.values(defaults).some(v => v.length > 0);

    // enablers 为数组时按长度区分单条与多条两种句式。
    // enablers.length === 1 时直接内联该字符串。
    // 长度大于 1 时生成项目符号列表，并保留 enablers 原串作为正则源。
    // 字符串声明按 Markdown 片段解析。
    // 未声明时输出始终启用文案。
    const enabledText =
      Array.isArray(enablers) && enablers.length > 0
        ? enablers.length === 1 && typeof enablers[0] === 'string'
          ? parseFragment(
              `This plugin is enabled if \`"${enablers[0]}"\` is listed in \`"dependencies"\` or \`"devDependencies"\` in \`package.json\`.`
            )
          : [
              ...parseFragment(
                `This plugin is enabled if there's a match in \`"dependencies"\` or \`"devDependencies"\` in \`package.json\`:`
              ),
              u(
                'list',
                enablers.map((enabler: string | RegExp) =>
                  u('listItem', [u('inlineCode', typeof enabler === 'string' ? enabler : enabler.source)])
                )
              ),
            ]
        : typeof enablers === 'string'
          ? parseFragment(enablers)
          : [u('paragraph', [u('text', 'This plugin is always enabled.')])];

    const defaultConfig = hasDefaultConfig
      ? [
          u('heading', { depth: 2 }, [u('text', 'Default configuration')]),
          ...parseFragment('If this plugin is enabled, the following configuration is added automatically:'),
          u('code', {
            lang: 'json', // TODO How to set attributes/properties/props properly?
            value: JSON.stringify({ [pluginName]: defaults }, null, 2),
          }),
          ...parseFragment('Depending on local configuration, plugins may modify the defaults as shown.'),
          ...parseFragment('Custom `config` or `entry` options override default values, they are not merged.'),
          ...parseFragment(
            'See [Plugins](../../explanations/plugins.md) for more details about plugins and their `entry` and `config` options.'
          ),
        ]
      : [];

    const notes = docs?.note ? [u('heading', { depth: 2 }, [u('text', 'Note')]), ...parseFragment(docs.note)] : [];

    const printCode = (value: unknown): string =>
      Array.isArray(value)
        ? `[${value.map(printCode).join(', ')}]`
        : typeof value === 'function'
          ? value.toString()
          : JSON.stringify(value).replace(/([,:])/g, '$1 ');

    const argsText = args
      ? [
          ...parseFragment(
            `## Shell commands\n\nThis plugin adds argument parsing for the <code>${args.binaries ? args.binaries.join(' and ') : pluginName}</code>
            ${args.binaries && args.binaries.length > 1 ? 'binaries' : 'binary'}. Configuration:`
          ),
          ...parseFragment(
            `\`\`\`\n${Object.entries(args)
              .filter(([key]) => key !== 'binaries')
              .map(([key, value]) => `${key}: ${printCode(value)}`)
              .join('\n')}\n\`\`\``
          ),
          ...parseFragment(
            'The configuration was generated from source code. Also see [Script Parser](../../features/script-parser.md).'
          ),
        ]
      : [];

    const generated = parseFragment(
      `## Generated from source\n\nThis page was generated from the [${pluginName} plugin source code](${srcBaseUrl}/${dir.name}/index.ts).`
    );

    const tree = u('root', [
      frontmatter,
      u('heading', { depth: 2 }, [u('text', 'Enabled')]),
      ...enabledText,
      ...defaultConfig,
      ...notes,
      ...argsText,
      ...generated,
    ]);

    console.log(`Writing ${pluginName} docs to plugins/${pluginName}.md`);
    await writeTree(tree, path.join(referenceDocsDir, `plugins/${pluginName}.md`));
  }
}

// plugins.sort 的键取目录名 a[1] / b[1]，不是展示标题。
// 先 sort 再生成索引树，保证多次运行输出一致。
// 标题里的 Plugins (N) 取排序后的 plugins.length。
// 索引页由 frontmatter 与列表树两部分组成。
// 链接 href 用站点内相对路径，不带域名前缀。
plugins.sort((a, b) => (a[1] < b[1] ? -1 : 1));

const frontmatter = u('yaml', `title: Plugins (${plugins.length})\ntableOfContents: false`);

const tree = u('root', [
  frontmatter,
  u('containerDirective', { name: 'section{.columns.min200}' }, [
    u(
      'list',
      { spread: false, ordered: false },
      plugins.map(plugin =>
        u('listItem', [u('link', { title: plugin[0], url: `/reference/plugins/${plugin[1]}` }, [u('text', plugin[0])])])
      )
    ),
    u('paragraph'),
  ]),
]);

console.log('Writing plugin list to plugins.md');
await writeTree(tree, path.join(referenceDocsDir, 'plugins.md'));
