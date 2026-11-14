/**
 * PDF 文字提取的 CJK 归一。
 *
 * Chrome / Skia 打印 PDF 时，若字体 cmap 把部首兼容字符与汉字指向同一字形，ToUnicode 会写成部首
 * （文→⽂ U+2F42、黄→⻩ U+2EE9）。画面正确，但复制、查找、引用和模型读到的文字都错了。这里把
 * 部首映射回等价汉字：康熙部首按 NFKC；部首补充按 Unicode EquivalentUnifiedIdeograph.txt（16.0），
 * 只收等价字在 BMP 的条目，保证替换前后都是一个 UTF-16 单元。不做整体 NFKC：它会把全角标点变成半角。
 */

/** 部首补充（U+2E80–2EFF）→ 等价汉字，逐对排列。 */
const SUPPLEMENT =
  "⺁厂⺂乛⺃乚⺄乙⺅亻⺆冂⺈刀⺉刂⺊卜⺋㔾⺌小⺍小⺎兀⺏尣⺐尢⺒巳⺓幺⺔彑⺖忄⺗心" +
  "⺘扌⺙攵⺛旡⺜日⺝月⺞歺⺟母⺠民⺡氵⺢氺⺣灬⺤爫⺥爫⺦丬⺧牛⺨犭⺩王⺫目⺬示⺭礻" +
  "⺯糹⺰纟⺱罓⺲罒⺳㓁⺴冗⺶羊⺹耂⺺肀⺻聿⺼肉⺾艹⺿艹⻀艹⻁虎⻂衤⻃覀⻄西⻅见⻆角" +
  "⻈讠⻉贝⻋车⻌辶⻍辶⻎辶⻏邑⻐钅⻑長⻒镸⻓长⻔门⻖阝⻗雨⻘青⻙韦⻚页⻛风⻜飞⻝食" +
  "⻟飠⻠饣⻢马⻣骨⻤鬼⻥鱼⻦鸟⻧卤⻨麦⻩黄⻪黾⻫斉⻬齐⻭歯⻮齿⻯竜⻰龙⻱龜⻲亀⻳龟";

const KANGXI_FIRST = 0x2f00;
const KANGXI_LAST = 0x2fd5;
const RADICALS = /[⺀-⻿⼀-⿕]/g;

const EQUIVALENT = new Map<string, string>();
for (let i = 0; i < SUPPLEMENT.length; i += 2) EQUIVALENT.set(SUPPLEMENT[i], SUPPLEMENT[i + 1]);
for (let code = KANGXI_FIRST; code <= KANGXI_LAST; code++) {
  const radical = String.fromCharCode(code);
  EQUIVALENT.set(radical, radical.normalize("NFKC"));
}

// 纯字符串重写：只替换康熙部首与部首补充区，其他字符（含全角标点）原样保留；幂等且不修改入参。
// 未收录的码位回退为原字符，因此不会把未知部首误映射成错误汉字，也不会抛错。
// 调用方在 PDF 抽文本后立即执行一次即可，重复调用不会二次改写。
/** Replace CJK radical code points with the ideographs they stand for; other text is unchanged. */
export function normalizeCjkCompat(text: string): string {
  return text.replace(RADICALS, (radical) => EQUIVALENT.get(radical) ?? radical);
}
