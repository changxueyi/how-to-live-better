// 最近更新：翻 git 历史，逐条比对 book/ 的条目，记下每条是哪天新增的、正文最后一次改是哪天，
// 写进根目录的 updates.json，检索页拿它标「新增」「改过」和做「最近更新」筛选。
//
//   node tools/updates.mjs            # 重新生成 updates.json（sync-stats.mjs 会自动调用）
//   node tools/updates.mjs --check    # 只比对不写，过时了退出码 1（CI 用，要 fetch-depth: 0）
//
// 不用提交信息：那是写给维护者的（「同步导览」「补锚点」），读者看不懂。
// 条目按标题认，不按条号认：删一条，后面的条号全变。标题按规矩只许加字，所以前后两版
// 标题对不上时再按标题和正文的相似度配对，配不上的才算新增或删除。
// 只有读者看得见的正文变了才算「改过」：标题、成本、说人话、收益、证据等级、备注。
// 来源栏、成本标签、条号顺延、「第 N 条（锚点）」里的条号和锚点词变了都不算，不然天天满屏「改过」。
// 只走 main 的第一父提交：本地 merge --no-ff 合进来的 PR 算在合并那天。
// 起算日之前的条目一律当老条目，不标新增。日期按北京时间。
// --check 只比对「哪些条目、新增还是改过、改了哪几栏」，不比日期：PR 在 CI 上是临时合并提交，
// 日期必然和本地生成时差一点。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/book.mjs';

const CHECK = process.argv.includes('--check');
const SINCE = '2026-10-01';
const REF = process.env.UPDATES_REF || 'HEAD';
const OUT = 'updates.json';
const FIELDS = ['标题', '成本', '说人话', '收益', '证据等级', '备注'];

const day = sec => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(sec * 1000));
const git = (args, input) => {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
};

// ---------- 解析 ----------
// 引用里的条号和锚点会随顺延和补锚点变，抹掉再比
const norm = s => s.replace(/\s+/g, '')
  .replace(/第\d+(节|条)/g, '第#$1')
  .replace(/(第#条)（[^（）]{1,30}）/g, '$1');

function parse(text) {
  const out = [];
  let sec = null, e = null;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = /^# (\d+)\. /.exec(line))) { sec = m[1]; continue; }
    if ((m = /^### (\d+)\. (.+)$/.exec(line)) && sec) {
      e = { key: `${sec}-${m[1]}`, f: { 标题: m[2].trim() } };
      out.push(e); continue;
    }
    if (!e) continue;
    if ((m = /^- (成本|说人话|收益|证据等级|备注)：(.*)$/.exec(line))) e.f[m[1]] = m[2].trim();
  }
  for (const x of out) x.n = Object.fromEntries(FIELDS.map(k => [k, norm(x.f[k] ?? '')]));
  return out;
}

// 中文按相邻两字切片算相似度
const grams = s => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return 2 * n / (a.size + b.size);
}

// 前一版的条目（带追踪信息）和这一版配对，返回这一版的追踪列表
function step(prev, cur, date) {
  const next = new Array(cur.length);
  const byTitle = new Map();
  prev.forEach((p, i) => { const k = p.e.n.标题; if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(i); });
  const used = new Set();
  // ① 标题一字不差：同名的优先配同一个节号
  cur.forEach((c, j) => {
    const cand = (byTitle.get(c.n.标题) ?? []).filter(i => !used.has(i));
    if (!cand.length) return;
    const sec = c.key.split('-')[0];
    const i = cand.find(i => prev[i].e.key.split('-')[0] === sec) ?? cand[0];
    used.add(i); next[j] = { ...prev[i], e: c };
  });
  // ② 剩下的按标题和正文相似度配
  const restP = prev.map((p, i) => i).filter(i => !used.has(i));
  const restC = cur.map((c, j) => j).filter(j => !next[j]);
  if (restP.length && restC.length) {
    const sig = e => ({ t: grams(e.n.标题), b: grams(e.n.说人话 + e.n.收益) });
    const sp = new Map(restP.map(i => [i, sig(prev[i].e)]));
    const pairs = [];
    for (const j of restC) {
      const sc = sig(cur[j]);
      for (const i of restP) {
        const s = Math.max(dice(sc.t, sp.get(i).t), dice(sc.b, sp.get(i).b) * 0.9);
        if (s >= 0.5) pairs.push([s, i, j]);
      }
    }
    pairs.sort((a, b) => b[0] - a[0]);
    for (const [, i, j] of pairs) {
      if (used.has(i) || next[j]) continue;
      used.add(i); next[j] = { ...prev[i], e: cur[j] };
    }
  }
  cur.forEach((c, j) => { if (!next[j]) next[j] = { e: c, added: date, changed: null, fields: [] }; });
  return next;
}

// 光改措辞不算「改过」：2026-10-14 全书审校一次改了五百多条的说人话和备注，全标上读者会被淹没。
// 算数的是：标题或证据等级变了；栏里的数字变了（新数据、改正的数字）；或者一栏加长了不少（补了新内容）。
const nums = s => (s.match(/\d+(?:\.\d+)?/g) ?? []).sort().join();
function real(k, a, b) {
  if (a === b) return false;
  if (k === '标题' || k === '证据等级') return true;
  return nums(a) !== nums(b) || b.length - a.length >= Math.max(60, a.length / 4);
}

// 配对之后逐栏比，记下改了哪几栏；同一天改了几轮的，栏目并在一起
function advance(prev, cur, date) {
  const next = step(prev, cur, date);
  const old = new Map(prev.map(p => [p.id, p.e]));
  for (const t of next) {
    if (t.id === undefined) { t.id = SEQ++; continue; }
    const o = old.get(t.id);
    const diff = FIELDS.filter(k => real(k, o.n[k], t.e.n[k]));
    if (!diff.length || t.added === date) continue;
    t.fields = t.changed === date ? [...new Set([...t.fields, ...diff])] : diff;
    t.changed = date;
  }
  return next;
}
let SEQ = 0;

// ---------- 取历史 ----------
const sinceTs = Math.floor(new Date(`${SINCE}T00:00:00+08:00`).getTime() / 1000);
const base = git(['rev-list', '-1', '--first-parent', `--before=${sinceTs}`, REF]).toString().trim();
if (!base) throw new Error(`找不到 ${SINCE} 之前的提交。请检查 ${REF} 是否包含完整历史`);
const log = git(['log', '--first-parent', '--reverse', '--diff-merges=first-parent', '--name-only',
  '--format=@%H %ct', `${base}..${REF}`, '--', 'book/']).toString();
const commits = [];
for (const line of log.split('\n')) {
  if (line.startsWith('@')) { const [h, t] = line.slice(1).split(' '); commits.push({ h, date: day(Number(t)), files: [] }); continue; }
  if (/^book\/.+\.md$/.test(line.trim())) commits.at(-1).files.push(line.trim());
}
const baseFiles = git(['ls-tree', '--name-only', base, 'book/']).toString().split('\n').filter(f => f.endsWith('.md'));

// 一次 cat-file --batch 取完所有要的版本，Windows 上逐个起 git 进程太慢
const reqs = [...baseFiles.map(f => `${base}:${f}`), ...commits.flatMap(c => c.files.map(f => `${c.h}:${f}`))];
const blob = git(['cat-file', '--batch'], reqs.join('\n') + '\n');
const got = new Map();
let pos = 0;
for (const r of reqs) {
  const nl = blob.indexOf(10, pos);
  const head = blob.subarray(pos, nl).toString();
  pos = nl + 1;
  if (head.endsWith(' missing')) { got.set(r, null); continue; }
  const size = Number(head.split(' ')[2]);
  got.set(r, blob.subarray(pos, pos + size).toString('utf8'));
  pos += size + 1;
}

// ---------- 逐版比对 ----------
const files = new Map(baseFiles.map(f => [f, got.get(`${base}:${f}`)]));
const snapshot = () => [...files.keys()].sort().flatMap(f => files.get(f) ? parse(files.get(f)) : []);
let track = advance([], snapshot(), null);
for (const c of commits) {
  for (const f of c.files) files.set(f, got.get(`${c.h}:${f}`));
  track = advance(track, snapshot(), c.date);
}
// 工作区里还没提交的改动算今天：sync-stats 在提交前跑，生成的就是提交后的样子
const disk = readdirSync(join(ROOT, 'book')).filter(f => f.endsWith('.md')).map(f => `book/${f}`);
const dirty = disk.some(f => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n') !== files.get(f)?.replace(/\r\n/g, '\n'))
  || [...files.keys()].some(f => files.get(f) && !disk.includes(f));
if (dirty) {
  files.clear();
  for (const f of disk) files.set(f, readFileSync(join(ROOT, f), 'utf8'));
  track = advance(track, snapshot(), day(Date.now() / 1000));
}

// ---------- 输出 ----------
const items = {};
for (const t of track) {
  if (t.added) items[t.e.key] = { added: t.added };
  else if (t.changed) items[t.e.key] = { changed: t.changed, fields: FIELDS.filter(k => t.fields.includes(k)) };
}
const keys = Object.keys(items).sort((a, b) => {
  const [x1, y1] = a.split('-').map(Number), [x2, y2] = b.split('-').map(Number);
  return x1 - x2 || y1 - y2;
});
// 一条一行，diff 读得懂
const json = `{"since":"${SINCE}","items":{\n${keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(items[k])}`).join(',\n')}\n}}\n`;

const nAdd = keys.filter(k => items[k].added).length, nChg = keys.length - nAdd;
console.log(`最近更新：${SINCE} 起新增 ${nAdd} 条、改过 ${nChg} 条（比对了 ${commits.length} 个提交${dirty ? '加工作区' : ''}）`);

const strip = s => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(s).items)
  .map(([k, v]) => [k, v.added ? 'added' : v.fields.join()])));
const old = existsSync(join(ROOT, OUT)) ? readFileSync(join(ROOT, OUT), 'utf8') : '';
if (CHECK) {
  if (old && strip(old) === strip(json)) { console.log('updates.json 检查通过'); process.exit(0); }
  console.log('updates.json 过时了。本地跑 node tools/sync-stats.mjs（或 node tools/updates.mjs），然后提交。');
  process.exit(1);
}
if (old.replace(/\r\n/g, '\n') !== json) writeFileSync(join(ROOT, OUT), json);
