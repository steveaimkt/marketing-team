#!/usr/bin/env node
/**
 * memory.mjs · 실행이 끝나면 「아는 것」이 남는다 (gbrain 구조 참고 · 2026-09-01)
 *
 * 회상(recall.mjs)과 짝이다. 회상은 **무엇을 했나**를 찾고, 기억은 **무엇을 아나**를 남긴다.
 * 회상만 있으면 경쟁사를 다섯 번 분석해도 「그 경쟁사에 대해 우리가 아는 것」이 어디에도 없다.
 *
 * 원칙 (github.com/garrytan/gbrain 에서 가져온 것):
 *   1. 주제가 자리를 정한다 — 형식도, 스킬 번호도, 날짜도 아니다. 무엇에 대한 앎인가로 간다.
 *   2. 인용 없는 사실은 없다 — 출처는 AI가 쓰지 않는다. 이 스크립트가 **영수증에서 읽어** 붙인다.
 *   3. 역링크는 철칙이다 — 연결을 걸면 상대 페이지에도 돌아오는 링크를 넣는다. 한쪽 링크는 끊긴 것이다.
 *   4. 주목가치 게이트 — 아무거나 페이지로 만들지 않는다. 다시 쓸 것만 남긴다 (⏸ 는 AI 마케터가 받는다).
 *   5. 기억은 산출물을 복사하지 않는다 — 한 줄 사실과 원본 포인터만 남긴다. 정본은 언제나 outputs/ 다.
 *
 * 사용 (작업 폴더에서):
 *   node scripts/memory.mjs search "가격 인하" [--type 경쟁사] [--top 5]
 *   node scripts/memory.mjs capture --file outputs/.../memory.json
 *   node scripts/memory.mjs list [--type 교훈]
 *   node scripts/memory.mjs doctor [--json]
 *
 * 요청문·사실 문장은 셸 인수로 받지 않는다. AI가 먼저 초안 json 을 쓰고 이 도구는 그 파일을 읽는다
 * (run-receipt.mjs 와 같은 이유 — 사용자 문자열이 셸 명령으로 해석될 틈을 만들지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORK = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const ROOT = path.join(WORK, 'brand', 'memory');
const SCHEMA = 'marketing-team.memory/v1';

/** 주제는 여섯이다. 늘리지 않는다 — 늘리면 같은 것이 두 곳에 쌓인다 (정본 docs/기억-운영.md §1). */
const TYPES = ['경쟁사', '고객', '채널', '제품', '캠페인', '교훈'];
const SECTIONS = ['아는 것', '타임라인', '연결'];
const STALE_DAYS = 180;
const ORPHAN_DAYS = 90;
const FACT_CAP = 40;

const fail = message => { console.error(`🔴 ${message}`); process.exit(1); };
const posix = value => value.split(path.sep).join('/');
const iso = () => new Date().toISOString();
const day = value => String(value || '').slice(0, 10);
const norm = value => String(value).replace(/\s+/g, ' ').trim();

const tokens = text => [...new Set(String(text).toLowerCase().normalize('NFKC')
  .split(/[^0-9a-z가-힣]+/).filter(word => word.length >= 2))];

/** 슬러그 문법: `{주제}/{이름}`. 경로 탈출·확장자·대문자를 막는다. */
function parseSlug(value) {
  const slug = String(value || '').trim();
  const match = slug.match(/^([가-힣]+)\/([가-힣a-z0-9._-]+)$/);
  if (!match) throw new Error(`슬러그 문법이 틀렸습니다: ${slug || '(빈 값)'} — 「주제/이름」 이어야 합니다`);
  const [, type, name] = match;
  if (!TYPES.includes(type)) throw new Error(`주제는 ${TYPES.join(' · ')} 뿐입니다: ${type}`);
  if (name.includes('..') || name.endsWith('.md')) throw new Error(`이름에 .. 나 .md 를 쓰지 않습니다: ${name}`);
  return { slug: `${type}/${name}`, type, name, file: path.join(ROOT, type, `${name}.md`) };
}

// ── 페이지 읽고 쓰기 ────────────────────────────────────────────────────────────

function emptyPage(parsed, title) {
  return {
    ...parsed,
    front: { type: parsed.type, slug: parsed.slug, title: title || parsed.name, created: day(iso()), updated: day(iso()), runs: [] },
    facts: [], timeline: [], links: [], exists: false,
  };
}

function readPage(parsed) {
  if (!fs.existsSync(parsed.file)) return emptyPage(parsed);
  const text = fs.readFileSync(parsed.file, 'utf8');
  const front = {};
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) for (const line of fm[1].split('\n')) {
    const hit = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!hit) continue;
    const [, key, raw] = hit;
    front[key] = raw.startsWith('[')
      ? raw.replace(/^\[|\]$/g, '').split(',').map(v => v.trim()).filter(Boolean)
      : raw.trim();
  }
  const section = name => {
    // m 플래그를 쓰지 않는다 — `$` 가 줄 끝에 걸려 첫 줄만 잡힌다 (실측 2026-09-01)
    const hit = text.match(new RegExp(`\\n## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return hit ? hit[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2)) : [];
  };
  return {
    ...parsed, front, exists: true,
    facts: section('아는 것'), timeline: section('타임라인'), links: section('연결'),
  };
}

function writePage(page) {
  const front = page.front;
  const lines = [
    '---',
    `type: ${front.type}`,
    `slug: ${front.slug}`,
    `title: ${front.title}`,
    `created: ${front.created}`,
    `updated: ${front.updated}`,
    `runs: [${(front.runs || []).join(', ')}]`,
    '---',
    '',
    `# ${front.title}`,
    '',
    '## 아는 것',
    ...(page.facts.length ? page.facts.map(f => `- ${f}`) : ['- (아직 없음)']),
    '',
    '## 타임라인',
    ...(page.timeline.length ? page.timeline.map(t => `- ${t}`) : ['- (아직 없음)']),
    '',
    '## 연결',
    ...(page.links.length ? page.links.map(l => `- ${l}`) : ['- (아직 없음)']),
    '',
  ];
  fs.mkdirSync(path.dirname(page.file), { recursive: true });
  fs.writeFileSync(page.file, lines.join('\n'));
}

function allPages() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const type of TYPES) {
    const dir = path.join(ROOT, type);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort())
      out.push(readPage(parseSlug(`${type}/${name.replace(/\.md$/, '')}`)));
  }
  return out;
}

// ── 인용 · 영수증이 만든다. AI가 쓰지 않는다 ────────────────────────────────────

function receiptFacts(ref) {
  const rel = String(ref || '').replace(/^workspace:/, '');
  if (!rel) throw new Error('run 에 영수증 경로(receipt)가 필요합니다.');
  const file = path.resolve(WORK, rel);
  if (path.relative(WORK, file).startsWith('..')) throw new Error(`작업 폴더 밖 영수증입니다: ${rel}`);
  if (!fs.existsSync(file)) throw new Error(`영수증이 없습니다: ${rel} — 실행 영수증 없이는 기억을 남기지 않습니다`);
  let run;
  try { run = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`영수증 JSON 오류 (${rel}): ${error.message}`); }
  if (run.schema !== 'marketing-team.run/v1') throw new Error(`영수증 스키마가 아닙니다: ${rel}`);
  if (!run.run_id) throw new Error(`영수증에 run_id 가 없습니다: ${rel}`);
  const skills = (run.skills || []).map(s => `${s.name || '이름없음'}(${s.id})`).join('→') || '스킬미상';
  const date = day(run.completed_at || run.started_at) || day(iso());
  const mode = run.data_mode || '미상';
  const artifact = (run.outputs || []).map(o => String(o.path || o).replace(/^workspace:/, ''))[0] || posix(rel);
  return {
    run_id: run.run_id, date, skills, mode, artifact,
    citation: `[출처: ${skills} · ${date} · ${mode}]`,
  };
}

/** 페이지에서 산출물까지의 상대 경로 — brand/memory/{주제}/x.md 기준이라 세 단계를 올라간다. */
const linkTo = target => posix(path.relative(path.join(ROOT, '주제'), path.join(WORK, target)));

// ── capture ───────────────────────────────────────────────────────────────────

function cmdCapture(args) {
  const index = args.indexOf('--file');
  if (index < 0 || !args[index + 1]) fail('사용: memory.mjs capture --file <초안.json>');
  const draftPath = path.resolve(WORK, args[index + 1]);
  if (!fs.existsSync(draftPath)) fail(`초안이 없습니다: ${args[index + 1]}`);
  let draft;
  try { draft = JSON.parse(fs.readFileSync(draftPath, 'utf8')); }
  catch (error) { fail(`초안 JSON 오류: ${error.message}`); }
  if (draft.schema !== SCHEMA) fail(`초안 스키마가 ${SCHEMA} 이어야 합니다.`);
  if (!Array.isArray(draft.notes) || !draft.notes.length) fail('notes 가 비었습니다 — 남길 것이 없으면 부르지 않습니다.');
  if (draft.notes.length > 3) fail(`한 실행에 3건까지입니다 (받은 것 ${draft.notes.length}건) — 주목가치 게이트입니다.`);

  let source;
  try { source = receiptFacts(draft.run?.receipt); } catch (error) { fail(error.message); }

  const touched = [];
  for (const note of draft.notes) {
    let parsed;
    try { parsed = parseSlug(note.slug); } catch (error) { fail(error.message); }
    const page = readPage(parsed);
    if (!page.exists) Object.assign(page, emptyPage(parsed, note.title || parsed.name), { facts: [], timeline: [], links: [] });
    if (note.title) page.front.title = note.title;
    page.front.type = parsed.type;
    page.front.slug = parsed.slug;
    page.front.created = page.front.created || day(iso());

    // ① 아는 것 · 인용은 기계가 붙인다. 같은 문장은 두 번 쌓지 않는다.
    const known = new Set(page.facts.map(f => norm(f.replace(/\s*\[출처:[^\]]*\]\s*$/, ''))));
    const added = [];
    for (const raw of note.facts || []) {
      const fact = norm(raw);
      if (!fact) continue;
      if (/\[출처:/.test(fact)) fail(`출처는 직접 쓰지 않습니다 — 영수증에서 붙입니다: ${fact.slice(0, 40)}`);
      if (known.has(fact)) continue;
      known.add(fact);
      page.facts.push(`${fact} ${source.citation}`);
      added.push(fact);
    }

    // ② 타임라인 · 언제 무엇을 하다 알았나 + 산출물 포인터
    if (note.timeline) {
      const line = `**${source.date}** · [${source.skills}](${linkTo(source.artifact)}) — ${norm(note.timeline)}`;
      if (!page.timeline.some(t => norm(t) === norm(line))) page.timeline.push(line);
    }

    // ③ 연결 · 역링크 철칙 (원칙 3). 상대가 있으면 상대에도 넣는다.
    for (const raw of note.links || []) {
      let other;
      try { other = parseSlug(raw); } catch (error) { fail(error.message); }
      if (other.slug === parsed.slug) continue;
      if (!page.links.some(l => l.includes(`[[${other.slug}]]`))) page.links.push(`[[${other.slug}]]`);
      if (fs.existsSync(other.file)) {
        const back = readPage(other);
        if (!back.links.some(l => l.includes(`[[${parsed.slug}]]`))) {
          back.links.push(`[[${parsed.slug}]]`);
          back.front.updated = day(iso());
          writePage(back);
          touched.push(`${other.slug} (역링크)`);
        }
      }
    }

    page.front.runs = [...new Set([...(page.front.runs || []), source.run_id])];
    page.front.updated = day(iso());
    if (!page.facts.length && !page.timeline.length) fail(`${parsed.slug} 에 남길 것이 없습니다 — facts 나 timeline 중 하나는 있어야 합니다.`);
    writePage(page);
    touched.push(`${parsed.slug} (${page.exists ? '갱신' : '신규'} · 아는 것 +${added.length})`);
  }

  rebuildIndex();
  console.log(`✅ 기억 · ${touched.length}건`);
  for (const line of touched) console.log(`   ${line}`);
  console.log(`   인용 ${source.citation} — 영수증 ${posix(path.relative(WORK, path.resolve(WORK, String(draft.run.receipt).replace(/^workspace:/, ''))))}`);
}

// ── INDEX ─────────────────────────────────────────────────────────────────────

function rebuildIndex() {
  const pages = allPages();
  if (!pages.length) return;
  const lines = [
    '# 기억 색인 (INDEX.md)',
    '',
    '> `memory.mjs capture` 가 다시 만든다. 손으로 고치지 않는다 — 원본은 각 페이지다.',
    '',
    '| 주제 | 페이지 | 아는 것 | 마지막 갱신 |',
    '|---|---|---|---|',
  ];
  for (const page of pages)
    lines.push(`| ${page.type} | [${page.front.title || page.name}](${page.type}/${page.name}.md) | ${page.facts.filter(f => f !== '(아직 없음)').length} | ${page.front.updated || '-'} |`);
  lines.push('', `총 ${pages.length}쪽 · 갱신 ${day(iso())}`, '');
  fs.writeFileSync(path.join(ROOT, 'INDEX.md'), lines.join('\n'));
}

// ── search · 모델을 부르지 않는다 ───────────────────────────────────────────────

function cmdSearch(args) {
  const query = args.filter(a => !a.startsWith('--'))[0] || '';
  const opt = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : null; };
  const type = opt('--type');
  const top = Number(opt('--top') || 5);
  if (type && !TYPES.includes(type)) fail(`주제는 ${TYPES.join(' · ')} 뿐입니다: ${type}`);
  const pages = allPages().filter(p => !type || p.type === type);
  if (!pages.length) { console.log('· 기억이 아직 없습니다 — 실행을 마치고 G5 에서 남깁니다'); return; }
  const wanted = tokens(query);
  const scored = pages.map(page => {
    const hay = tokens([page.slug, page.front.title, ...page.facts, ...page.timeline, ...page.links].join(' '));
    const hit = wanted.filter(t => hay.some(h => h.includes(t) || t.includes(h))).length;
    if (wanted.length && !hit) return null;
    return { score: hit, page };
  }).filter(Boolean).sort((a, b) =>
    b.score - a.score || String(b.page.front.updated).localeCompare(String(a.page.front.updated)));
  if (!scored.length) { console.log('· 걸린 기억 없음 — 없으면 없는 대로 갑니다'); return; }
  for (const { page } of scored.slice(0, top)) {
    console.log(`${page.slug} · ${page.front.title} · 갱신 ${page.front.updated}`);
    for (const fact of page.facts.slice(0, 3)) console.log(`  · ${fact}`);
    if (page.links.length) console.log(`  ↔ ${page.links.join(' ')}`);
    console.log(`  📁 brand/memory/${page.type}/${page.name}.md`);
  }
}

function cmdList(args) {
  const opt = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : null; };
  const type = opt('--type');
  const pages = allPages().filter(p => !type || p.type === type);
  if (!pages.length) { console.log('· 기억이 아직 없습니다'); return; }
  for (const t of TYPES) {
    const group = pages.filter(p => p.type === t);
    if (!group.length) continue;
    console.log(`${t} · ${group.length}쪽`);
    for (const page of group) console.log(`  ${page.slug} · 아는 것 ${page.facts.length} · ${page.front.updated}`);
  }
}

// ── doctor · 재는 자리가 있어야 지켜진다 ─────────────────────────────────────────

function diagnose() {
  const pages = allPages();
  const issues = [];
  const linked = new Set();
  for (const page of pages)
    for (const link of page.links) {
      const hit = link.match(/\[\[([^\]]+)\]\]/);
      if (hit) linked.add(hit[1]);
    }
  const known = new Set(pages.map(p => p.slug));
  const today = Date.now();
  const ageOf = value => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(time) ? null : Math.round((today - time) / 86400e3);
  };

  for (const page of pages) {
    const where = `${page.slug}`;
    for (const key of ['type', 'slug', 'title', 'created', 'updated'])
      if (!page.front[key]) issues.push({ kind: '형식', page: where, detail: `frontmatter 에 ${key} 가 없다` });
    if (page.front.slug && page.front.slug !== page.slug)
      issues.push({ kind: '형식', page: where, detail: `frontmatter slug(${page.front.slug})와 파일 위치가 다르다` });
    for (const fact of page.facts) {
      if (fact === '(아직 없음)') continue;
      if (!/\[출처:[^\]]+\]/.test(fact))
        issues.push({ kind: '인용없음', page: where, detail: `「${fact.slice(0, 30)}…」에 출처가 없다` });
    }
    for (const link of page.links) {
      const hit = link.match(/\[\[([^\]]+)\]\]/);
      if (hit && !known.has(hit[1]))
        issues.push({ kind: '끊긴링크', page: where, detail: `[[${hit[1]}]] 대상 페이지가 없다` });
    }
    const facts = page.facts.filter(f => f !== '(아직 없음)');
    if (facts.length > FACT_CAP)
      issues.push({ kind: '비대', page: where, detail: `아는 것 ${facts.length}줄 — ${FACT_CAP}줄을 넘었다. 묶어 줄인다` });
    const age = ageOf(page.front.updated);
    if (age !== null && age > STALE_DAYS)
      issues.push({ kind: '낡음', page: where, detail: `${age}일 갱신 없음` });
    if (age !== null && age > ORPHAN_DAYS && !linked.has(page.slug) && facts.length <= 1)
      issues.push({ kind: '고아', page: where, detail: `아무도 링크하지 않고 아는 것이 ${facts.length}줄 — 지울 후보` });
  }
  return { pages: pages.length, issues };
}

function cmdDoctor(args) {
  const report = diagnose();
  if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return; }
  if (!report.pages) { console.log('· 기억이 아직 없습니다 — 점검할 것이 없습니다'); return; }
  if (!report.issues.length) { console.log(`✅ 기억 점검 · ${report.pages}쪽 · 이상 없음`); return; }
  const counts = {};
  for (const issue of report.issues) counts[issue.kind] = (counts[issue.kind] || 0) + 1;
  console.log(`⚠️ 기억 점검 · ${report.pages}쪽 · ${report.issues.length}건 (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')})`);
  // 한 번에 3개 이내로 고친다 — 열 개를 적으면 하나도 안 고쳐진다 (docs/원장-운영.md 와 같은 규칙)
  for (const issue of report.issues.slice(0, 3)) console.log(`   ${issue.kind} · ${issue.page} · ${issue.detail}`);
  if (report.issues.length > 3) console.log(`   … 그 밖 ${report.issues.length - 3}건 (--json 으로 전부 본다)`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'capture') cmdCapture(rest);
  else if (command === 'search') cmdSearch(rest);
  else if (command === 'list') cmdList(rest);
  else if (command === 'doctor') cmdDoctor(rest);
  else fail('사용: memory.mjs search "질의" [--type 경쟁사] [--top 5] | capture --file <초안.json> | list [--type 교훈] | doctor [--json]');
}

export { TYPES, SECTIONS, parseSlug, readPage, diagnose };
