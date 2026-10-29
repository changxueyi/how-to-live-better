// 把全书条目做成一副 Anki 牌组（.apkg），一条一张问答卡，按节分子牌组（issue #97）。
// 用法：node tools/anki/build.mjs [输出路径]   默认输出 dist/HowToLiveBetter.apkg
//
// 卡片正面是节名和条目标题，背面是说人话、成本、性价比、收益量级、口径和证据等级，再给一个在线版链接。
// 标题本身就是建议，所以正面不挖空；复习时回想的是「为什么值得做、代价多大」。
// 挖空要逐条人工标，新增条目也得跟着标，维护不起，所以只做自动生成的这一种。
//
// 零依赖：.apkg 就是一个 zip，里面一个 SQLite 库（Anki 2.1 的旧版库结构，各版本 Anki 都能导入）
// 加一个媒体清单。库用 Node 自带的 node:sqlite 写，zip 用 tools/lib/zip.mjs。
//
// 重新导入时 Anki 按笔记的 guid 认「同一张卡」：内容更新、复习记录保留。guid 取「节号-条号」，
// 所以条目只追加在节末（CLAUDE.md 本来就这么要求）就不会串；删条目让后面的条号整体减一时，
// 老用户那边的卡会对到新内容上，复习记录跟着错位一条，这个代价能接受。
// 牌组、笔记类型的 id 写死，也是为了重新导入时合进原来那副牌，不另起一副。
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zip } from '../lib/zip.mjs';
import { ROOT, SITE, TITLE, read, readBook, COST_W, ratioOf, gitCommit, buildStamp } from '../lib/book.mjs';

const OUT = resolve(ROOT, process.argv[2] ?? 'dist/HowToLiveBetter.apkg');
const NOW = new Date();
const NOW_S = Math.floor(NOW.getTime() / 1000);
const NOW_MS = NOW.getTime();

const MODEL_ID = 1759900000001;
const ROOT_DECK_ID = 1759900000100;
const deckId = sec => ROOT_DECK_ID + Number(sec);
const noteId = (sec, n) => 1759900100000 + Number(sec) * 1000 + Number(n);
const cardId = (sec, n) => 1759900200000 + Number(sec) * 1000 + Number(n);

// ---------- 读条目 ----------
const FIELD = { 成本: 'cost', 说人话: 'human', 证据等级: 'grade', 备注: 'note' };

function parseSection(md) {
  const head = md.match(/^# (\d+)\. (.+)$/m);
  if (!head) throw new Error('节文件第三行应该是「# N. 节名」');
  const entries = [];
  let e = null;
  for (const line of md.split('\n')) {
    const h = line.match(/^### (\d+)\. (.+)$/);
    if (h) { e = { n: h[1], title: h[2].trim() }; entries.push(e); continue; }
    if (!e) continue;
    const tag = line.match(/^<!--\s*成本标签:\s*(.*?)\s*-->/);
    if (tag) {
      for (const kv of tag[1].split(/\s+/)) { const [k, v] = kv.split('='); e[k] = v; }
      continue;
    }
    const f = line.match(/^- (成本|说人话|证据等级|备注)：(.*)$/);
    if (f) e[FIELD[f[1]]] = f[2].trim();
  }
  return { sec: head[1], name: head[2].trim(), entries };
}

const { bookFiles } = readBook();
const sections = bookFiles.map(f => parseSection(read(f)));

// ---------- 字段 ----------
const esc = s => String(s ?? '').replace(/\*\*/g, '').replace(/\\([*_])/g, '$1')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pad = n => String(n).padStart(2, '0');
const deckName = s => `${TITLE}::${pad(s.sec)} ${s.name}`;

const FIELDS = ['节', '标题', '说人话', '成本', '要点', '链接'];
const notes = [];
let due = 0;
for (const s of sections) {
  for (const e of s.entries) {
    const cost = (COST_W.money[e.钱] ?? 0) + (COST_W.time[e.时间] ?? 0) + (COST_W.will[e.毅力] ?? 0);
    const ratio = e.收益 ? ratioOf(cost, e.收益) : '';
    const grade = (e.grade ?? '').match(/^[ABC]/)?.[0] ?? '';
    const dispute = /^争议/.test(e.note ?? '');
    const points = [
      ratio && `性价比${ratio}`,
      e.收益 && `收益${e.收益}`,
      e.口径 && `口径：${e.口径}`,
      grade && `证据 ${grade} 级${dispute ? '（有争议）' : ''}`,
    ].filter(Boolean).join(' · ');
    const url = `${SITE}#e-${s.sec}-${e.n}`;
    const fields = [
      `第 ${s.sec} 节 · ${esc(s.name)} · 第 ${e.n} 条`,
      esc(e.title),
      esc(e.human || ''),
      esc(e.cost || ''),
      esc(points),
      `<a href="${url}">在线版看全文和来源</a>`,
    ];
    const tags = [`第${pad(s.sec)}节`, grade && `证据${grade}`, ratio && `性价比${ratio}`, e.口径 && `口径${e.口径}`, dispute && '争议']
      .filter(Boolean);
    notes.push({ s, e, fields, tags, due: due++ });
  }
}

// ---------- 笔记类型和牌组 ----------
const CSS = `.card { font-family: "Segoe UI", -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 18px; line-height: 1.7; text-align: left; max-width: 40em; margin: 0 auto; padding: 0 12px; color: #213547; background: #fff; }
.nightMode.card, .night_mode .card { color: rgba(255,255,245,.86); background: #1b1b1f; }
.sec { font-size: 13px; color: #67676c; }
.q { font-size: 22px; font-weight: 600; margin: 8px 0 12px; }
.hint { font-size: 14px; color: #67676c; }
.label { font-size: 13px; color: #67676c; margin-top: 14px; }
.points { font-size: 14px; margin-top: 14px; }
.link { font-size: 14px; margin-top: 14px; }
a { color: #3451b2; }
.nightMode a, .night_mode a { color: #a8b1ff; }
.nightMode .sec, .nightMode .hint, .nightMode .label { color: #98989f; }`;

const QFMT = `<div class="sec">{{节}}</div>
<div class="q">{{标题}}</div>
<div class="hint">想一想：为什么值得做，要花多少代价？</div>`;
const AFMT = `<div class="sec">{{节}}</div>
<div class="q">{{标题}}</div>
<hr id="answer">
{{#说人话}}<div class="label">说人话</div><div>{{说人话}}</div>{{/说人话}}
{{#成本}}<div class="label">成本</div><div>{{成本}}</div>{{/成本}}
<div class="points">{{要点}}</div>
<div class="link">{{链接}}</div>`;

const model = {
  id: MODEL_ID, name: `${TITLE}（问答卡）`, type: 0, mod: NOW_S, usn: -1, sortf: 1, did: ROOT_DECK_ID,
  tmpls: [{ name: '问答', ord: 0, qfmt: QFMT, afmt: AFMT, did: null, bqfmt: '', bafmt: '' }],
  flds: FIELDS.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
  css: CSS, latexPre: '', latexPost: '', latexsvg: false, req: [[0, 'any', [1]]], tags: [], vers: [],
};

const deck = (id, name, desc = '') => ({
  id, name, desc, mod: NOW_S, usn: -1, dyn: 0, conf: 1, collapsed: false, browserCollapsed: false,
  newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0], extendNew: 0, extendRev: 0,
});
const commit = gitCommit();
const rootDesc = `《${TITLE}》全书条目，一条一张卡，按节分子牌组。生成于 ${buildStamp()}（北京时间）`
  + `${commit ? `，正文提交 ${commit.slice(0, 7)}` : ''}。正文会继续更新，以 <a href="${SITE}">在线版</a> 为准；`
  + '重新下载导入会更新卡片内容，复习记录保留。';
const decks = {
  1: deck(1, 'Default'),
  [ROOT_DECK_ID]: deck(ROOT_DECK_ID, TITLE, rootDesc),
  ...Object.fromEntries(sections.map(s => [deckId(s.sec), deck(deckId(s.sec), deckName(s))])),
};

const dconf = {
  1: {
    id: 1, name: 'Default', mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, order: 1, perDay: 20, bury: true, separate: true },
    rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, bury: true },
    lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 },
  },
};
const conf = {
  activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true,
  curModel: String(MODEL_ID), nextPos: notes.length + 1, sortType: 'noteFld', sortBackwards: false, addToCur: true,
};

// ---------- 写库 ----------
const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null,
  odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);`;

const tmp = mkdtempSync(join(tmpdir(), 'anki-'));
const dbPath = join(tmp, 'collection.anki2');
const db = new DatabaseSync(dbPath);
db.exec(SCHEMA);
const dayStart = Math.floor(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()).getTime() / 1000);
db.prepare('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)').run(
  dayStart, NOW_MS, NOW_MS, JSON.stringify(conf), JSON.stringify({ [MODEL_ID]: model }),
  JSON.stringify(decks), JSON.stringify(dconf), '{}');

const stripHtml = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const csum = s => parseInt(createHash('sha1').update(stripHtml(s)).digest('hex').slice(0, 8), 16);
const insNote = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, \'\')');
const insCard = db.prepare('INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, \'\')');
db.exec('BEGIN');
for (const { s, e, fields, tags, due } of notes) {
  const sortField = fields[model.sortf];
  insNote.run(noteId(s.sec, e.n), `hltb-${s.sec}-${e.n}`, MODEL_ID, NOW_S, ` ${tags.join(' ')} `,
    fields.join('\x1f'), stripHtml(sortField), csum(sortField));
  insCard.run(cardId(s.sec, e.n), noteId(s.sec, e.n), deckId(s.sec), NOW_S, due);
}
db.exec('COMMIT');
db.close();
const collection = readFileSync(dbPath);
rmSync(tmp, { recursive: true, force: true });

// ---------- 打包 ----------
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip([
  { name: 'collection.anki2', data: collection },
  { name: 'media', data: Buffer.from('{}') },
], NOW));
const missing = notes.filter(x => !x.fields[2]).length;
console.log(`已生成 ${OUT}：${sections.length} 节 ${notes.length} 张卡${missing ? `，其中 ${missing} 张缺说人话` : ''}`);
