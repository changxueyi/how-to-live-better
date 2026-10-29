// 把一行写到底的超长「收益 / 备注」和串成一行的「来源」，在换话题、换出处的地方拆成子条目。
// 起因是一条「收益」常常一整段一千多字（比如第 31 节第 1 条把十二条路的门槛写在一行里），
// 读的时候是一整块，找不到哪句讲哪条路。
//
// 只改版式，不动正文的字：拆出来的块按顺序拼回去和原文逐字相同（来源栏丢掉的只是分隔用的「；」）。
// 正文 md 仍然一个字段一行，index.html 的按行解析、sync-stats 的链接计数都不受影响。
//
// 四个出口用同一套规则：EPUB、PDF 在构建时调 splitLongItems；检索网页和离线单文件在 index.html 里
// 有一份同样的 splitGain / splitSrc。**改这里的规则要同步改 index.html 里那份**，
// `node tools/check-split.mjs` 会拿全书逐条比对两边拆出来的结果。

export const GAIN_MIN_LEN = 300;  // 收益、备注短于这个字数的不拆
export const GAIN_MIN_CHUNK = 25; // 拆出来太短的块并回上一块

// 句号之后，下一句以这些开头，就当作换了一条依据
export const GAIN_TOPIC_START = [
  /^[^，。「」《》：；（）的]{1,12}看(《|[^，。「」的]{0,10}法[：「（第])/, // 当兵看兵役法：/ 考公务员看《…》；排除「的」，免得「它看的是…疗法（」被认进来
  /^《[^》]{2,40}》/,                                                 // 《某条例》……
  /^(?!该|本|此|这|同|上述|但|而|所以|因此|并且|也)[一-龥]{1,12}法(第[一二三四五六七八九十百零]+条|「)/, // 刑法第…条 / 义务教育法「；「该办法第五条」「但刑法第…条」是接着上文，不算
  /^(另一|另有一|还有一|再一|又一)(项|篇)/,                            // 另一项试验
  /^(国内|国外|国内外)也有/,
  /^案例[一二三四五六七八九十]/,
  /^(同一天|同一试验|同一指南|同一研究)/,
  /^(美国|英国|欧洲|世界卫生组织|WHO|中国)[^，。]{0,20}(指南|共识|建议|学会)/,
  /^(先说|再说|最后说|先看|再看|最后看)/,
  /^一(项|篇)[^，。]{0,20}(试验|研究|综述|分析|调查)/,
  /^(芬兰|北欧|英国|美国|日本|韩国|瑞典|丹麦|挪威|德国|法国|澳大利亚|加拿大|荷兰|台湾|香港|上海|北京)[^，。]{0,25}(研究|数据库|试验|队列|调查)/,
];

// 收益、备注：按不在「」『』《》（）里的句号切句，遇到换话题的句子另起一块
export function splitGain(text) {
  if (!text || text.length < GAIN_MIN_LEN) return [text];
  const sentences = [];
  let buf = '', depth = 0;
  for (const c of text) {
    if ('「『《（'.includes(c)) depth++;
    else if ('」』》）'.includes(c)) depth = Math.max(0, depth - 1);
    buf += c;
    if (c === '。' && depth === 0) { sentences.push(buf); buf = ''; }
  }
  if (buf) sentences.push(buf);
  const chunks = [];
  for (const s of sentences) {
    if (chunks.length && GAIN_TOPIC_START.some(re => re.test(s))) chunks.push(s);
    else if (chunks.length) chunks[chunks.length - 1] += s;
    else chunks.push(s);
  }
  const out = [];
  for (const c of chunks) {
    if (out.length && c.length < GAIN_MIN_CHUNK) out[out.length - 1] += c;
    else out.push(c);
  }
  if (out.length > 1 && out[0].length < GAIN_MIN_CHUNK) out.splice(0, 2, out[0] + out[1]);
  return out;
}

// 来源：「；」串起来的若干条文献，一条一行。和 index.html 原有的 splitSrc 同一条规则：
// 括号和引号里的分号不算分隔符（法条原文里有「……代理或者追认；……」）
export function splitSrc(text) {
  const parts = []; let buf = '', depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('「『（'.includes(c)) depth++;
    if ('」』）'.includes(c)) depth = Math.max(0, depth - 1);
    const semi = c === '；' || (c === ';' && /\s/.test(text[i - 1] || '') && /\s/.test(text[i + 1] || ''));
    if (semi && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  return parts.map(s => s.trim()).filter(Boolean);
}

// 子条目开头像「1. 」会被 markdown 认成有序列表，转义掉
const safe = s => s.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3');

// 给 EPUB、PDF 用：把 md 里的长字段改写成「- 收益：」加一层子列表
export function splitLongItems(md) {
  return md.split('\n').map(line => {
    const m = line.match(/^(\s*)- (收益|备注|来源)：(.*)$/);
    if (!m) return line;
    const [, indent, label, body] = m;
    const chunks = label === '来源' ? splitSrc(body) : splitGain(body);
    if (chunks.length < 2) return line;
    return `${indent}- ${label}：\n` + chunks.map(c => `${indent}  - ${safe(c.trim())}`).join('\n');
  }).join('\n');
}
