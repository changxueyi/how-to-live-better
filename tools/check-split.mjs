// 收益、备注、来源的拆分规则有两份：tools/lib/split-items.mjs（EPUB、PDF）和 index.html 里
// <split-rules> 那一段（检索网页、离线单文件）。这个脚本拿全书每一条比对两边拆出来的结果，
// 顺带查拆完能不能逐字拼回原文、加粗的 ** 有没有被拆到两块里。
// 用法：node tools/check-split.mjs     有问题退出码 1
import { readdirSync } from 'node:fs';
import vm from 'node:vm';
import { read, readBook } from './lib/book.mjs';
import { splitGain, splitSrc } from './lib/split-items.mjs';

const html = read('index.html');
const m = html.match(/\/\/ <split-rules>[\s\S]*?\/\/ <\/split-rules>/);
if (!m) { console.error('index.html 里找不到 // <split-rules> … // </split-rules> 这一段'); process.exit(1); }
const ctx = {};
vm.runInNewContext(`${m[0]}\nthis.splitGain = splitGain; this.splitSrc = splitSrc;`, ctx);

const { docFiles } = readBook();
const files = [...readdirSync(new URL('../book/', import.meta.url)).filter(f => f.endsWith('.md')).map(f => `book/${f}`), ...docFiles];
const problems = [];
let total = 0, split = 0;
for (const f of files) {
  read(f).split('\n').forEach((line, i) => {
    const mm = line.match(/^\s*- (收益|备注|来源)：(.*)$/);
    if (!mm) return;
    const [, label, body] = mm;
    const at = `${f}:${i + 1}（${label}）`;
    const lib = label === '来源' ? splitSrc(body) : splitGain(body);
    const web = label === '来源' ? ctx.splitSrc(body) : ctx.splitGain(body);
    total++;
    if (lib.length > 1) split++;
    if (JSON.stringify(lib) !== JSON.stringify(web)) problems.push(`${at}：split-items.mjs 拆成 ${lib.length} 块，index.html 拆成 ${web.length} 块`);
    if (label !== '来源' && lib.join('') !== body) problems.push(`${at}：拆完拼不回原文`);
    if (lib.length > 1 && lib.some(c => (c.match(/\*\*/g) || []).length % 2)) problems.push(`${at}：有一块里的 ** 不成对，加粗被拆开了`);
  });
}
for (const p of problems) console.log(p);
console.log(`${files.length} 个文件，${total} 个收益/备注/来源字段，拆开 ${split} 个，问题 ${problems.length} 处`);
process.exit(problems.length ? 1 : 0);
