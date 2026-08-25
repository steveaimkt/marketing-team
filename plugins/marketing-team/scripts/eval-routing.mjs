#!/usr/bin/env node
/**
 * eval-routing.mjs · 「부를 말」이 아직 그 스킬로 가는가 (라우팅 회귀 검사)
 *
 * 왜: 이 패키지의 진입로는 자연어 하나뿐이다. 트리거 한 줄을 고치거나 스킬을 하나 더하면
 *     엉뚱한 스킬이 열리는데, **그걸 알아챌 방법이 지금까지 없었다.**
 *     routing-eval.jsonl 596건은 2026-08 부터 있었지만 아무도 돌리지 않았다.
 *     (validate-skills.mjs 의 머리말이 이 파일을 이미 가리키고 있었다 — 이제야 생겼다.)
 *
 * 두 층으로 검사한다. 층이 나뉜 이유는 **돈**이다.
 *   A층 (기본 · 무료 · CI)   구조 · 모순 · 트리거 충돌 · 어휘 기준선 회귀
 *   B층 (--live · 유료)      실제 모델에게 ROUTING.md 를 주고 596건을 라우팅시킨다
 *
 * A층의 「어휘 기준선」은 진짜 라우팅이 아니다. 글자 2-gram 유사도로 고른 1등일 뿐이다.
 * 절대 점수는 의미가 없다. 의미가 있는 것은 **어제 맞던 것이 오늘 틀리는가** 하나다.
 * 그래서 통과선을 숫자로 박지 않고, 기준선 파일에 「지금 틀리는 것」을 적어 두고
 * **거기 없던 것이 틀리기 시작하면** 실패시킨다.
 *
 * 사용:
 *   node scripts/eval-routing.mjs                     A층
 *   node scripts/eval-routing.mjs --report            틀린 케이스를 전부 본다
 *   node scripts/eval-routing.mjs --update-baseline   A층 기준선 갱신 (의도한 변경일 때만)
 *   node scripts/eval-routing.mjs --live-cc           B층 · 맥스 구독 (claude CLI · 추가 결제 없음)
 *   node scripts/eval-routing.mjs --live             B층 · API 키 (별도 과금 · CI 용)
 *   node scripts/eval-routing.mjs --live-cc --limit 50   50건만 짧게
 *
 * B층은 두 길이 있다. **재는 것은 같고 계산서가 다르다.**
 *   --live-cc  이미 깔린 claude CLI 를 헤드리스(-p)로 부른다 → 구독 사용량. 사람이 로컬에서 돌린다
 *   --live     공식 SDK 로 API 를 부른다 → 토큰 과금. 키를 시크릿에 넣으면 CI 에서도 돈다
 *
 * 종료 0=통과 1=위반
 */
import fs from 'node:fs';
// ⚠️ 윈도우에서 클론하면 .md 가 CRLF 로 온다 (git 기본값 core.autocrlf=true).
//    그러면 frontmatter 파서(`/^---\n…\n---\n/`)가 통째로 실패해 이 스크립트가 조용히 오작동한다.
//    .gitattributes 가 새 클론을 막지만, 이미 CRLF 가 된 파일과 윈도우 에디터가 저장한 파일도 있다.
//    정규식을 11군데 고치면 빠뜨린다. **읽는 즉시 눕힌다.** (실측 2026-08-23)
const _readFileSync = fs.readFileSync;
fs.readFileSync = (p, o) =>
  (o === 'utf8' || o?.encoding === 'utf8')
    ? String(_readFileSync(p, o)).replace(/\r\n/g, '\n')
    : _readFileSync(p, o);

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = path.join(ROOT, '100-skills');
const BASELINE = path.join(ROOT, 'scripts', 'routing-baseline.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REPORT = has('--report');
const UPDATE = has('--update-baseline');
const LIVE = has('--live');          // API · 토큰 과금
const LIVE_CC = has('--live-cc');    // 맥스 구독 · claude CLI
const MODEL = val('--model', 'claude-opus-5');
const LIMIT = Number(val('--limit', '0')) || 0;

const issues = [];
const ok = [];
const err = (m) => issues.push(['🔴', m]);
const warn = (m) => issues.push(['🟡', m]);

// ─────────────────────────────────────────────────────────────
// 0. 정본 읽기
// ─────────────────────────────────────────────────────────────
const fmOf = (t) => (t.match(/^---\n([\s\S]*?)\n---\n/) || [, ''])[1];
const fld = (f, k) =>
  ((f.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [, ''])[1] || '').trim().replace(/^["']|["']$/g, '');

// triggers 는 `- "…"` 블록 리스트다. fld 로는 안 잡힌다.
const blockList = (fm, key) => {
  const lines = fm.split('\n');
  const i = lines.findIndex((l) => l.startsWith(key + ':'));
  if (i < 0) return [];
  const inline = lines[i].slice(key.length + 1).trim();
  if (inline.startsWith('[')) {
    return inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].match(/^\s*-\s+(.*)$/);
    if (!m) break;
    out.push(m[1].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
};

const skills = [];
for (const cat of fs.readdirSync(M).filter((d) => /^\d\d-/.test(d)).sort()) {
  const sd = path.join(M, cat, 'skills');
  if (!fs.existsSync(sd)) continue;
  for (const dir of fs.readdirSync(sd).sort()) {
    const p = path.join(sd, dir, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const fm = fmOf(fs.readFileSync(p, 'utf8'));
    skills.push({
      dir,
      cat,
      id: fld(fm, 'id'),
      name: fld(fm, 'name'),
      desc: fld(fm, 'description'),
      triggers: blockList(fm, 'triggers'),
      evalPath: path.join(sd, dir, 'routing-eval.jsonl'),
    });
  }
}
const byId = new Map(skills.map((s) => [s.id, s]));
if (skills.length !== 100) err(`스킬이 100개가 아니다: ${skills.length}`);

// ─────────────────────────────────────────────────────────────
// 1. 케이스 읽기 + 구조 검사
// ─────────────────────────────────────────────────────────────
const cases = [];
const seenIntent = new Map(); // 정규화 intent → [{id}]
for (const s of skills) {
  if (!fs.existsSync(s.evalPath)) { err(`${s.id} · routing-eval.jsonl 없음 — 이 스킬은 회귀 검사를 못 받는다`); continue; }
  const lines = fs.readFileSync(s.evalPath, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length < 3) warn(`${s.id} · 케이스 ${lines.length}건 — 3건 미만이면 회귀를 못 잡는다`);
  lines.forEach((line, n) => {
    let o;
    try { o = JSON.parse(line); } catch (e) { err(`${s.id}:${n + 1} · JSON 파싱 실패 — ${e.message}`); return; }
    if (typeof o.intent !== 'string' || !o.intent.trim()) { err(`${s.id}:${n + 1} · intent 가 없다`); return; }
    if (o.expected_skill !== s.id) err(`${s.id}:${n + 1} · expected_skill 이 폴더와 다르다: ${o.expected_skill}`);
    if (!byId.has(o.expected_skill)) err(`${s.id}:${n + 1} · 없는 스킬을 기대한다: ${o.expected_skill}`);
    for (const a of o.ambiguous_with || []) {
      if (!byId.has(a)) err(`${s.id}:${n + 1} · ambiguous_with 에 없는 스킬: ${a}`);
      if (a === s.id) warn(`${s.id}:${n + 1} · ambiguous_with 에 자기 자신이 있다`);
    }
    // 트리거를 그대로 베낀 케이스는 회귀를 못 잡는다. 바꿔 말한 문장이어야 한다.
    if (s.triggers.some((t) => norm(t) === norm(o.intent)))
      warn(`${s.id}:${n + 1} · intent 가 트리거와 똑같다 — 바꿔 말한 문장이어야 한다`);

    const k = norm(o.intent);
    if (!seenIntent.has(k)) seenIntent.set(k, []);
    seenIntent.get(k).push(s.id);
    cases.push({ id: s.id, intent: o.intent, ambiguous: o.ambiguous_with || [] });
  });
}

// 같은 문장을 두 스킬이 서로 자기 것이라고 하면 라우팅이 성립하지 않는다
for (const [k, ids] of seenIntent) {
  const uniq = [...new Set(ids)];
  if (uniq.length > 1) err(`같은 문장을 ${uniq.join('·')} 가 서로 자기 것이라 한다: "${k.slice(0, 30)}…"`);
  else if (ids.length > 1) warn(`${uniq[0]} · 같은 문장이 ${ids.length}번 들어 있다: "${k.slice(0, 30)}…"`);
}

// 트리거 충돌 — 두 스킬이 같은 부를 말을 가지면 어느 쪽도 확실히 못 연다
const trigOwner = new Map();
for (const s of skills)
  for (const t of s.triggers) {
    const k = norm(t);
    if (!k) continue;
    if (trigOwner.has(k) && trigOwner.get(k) !== s.id)
      err(`트리거 충돌 · "${t}" 를 ${trigOwner.get(k)} 와 ${s.id} 가 함께 가진다`);
    else trigOwner.set(k, s.id);
  }

// 거의 같은 트리거 — 「광고 카피 뽑아줘」 와 「광고 카피 만들어줘」 가 다른 스킬에 있으면
// 글자로는 안 겹치지만 사람이 부를 때는 같은 말이다. 새 스킬이 남의 말을 훔치는 자리다.
const NEAR = 0.85;
const flat = skills.flatMap((s) => s.triggers.map((t) => ({ id: s.id, t, g: grams(t) })));
for (let i = 0; i < flat.length; i++)
  for (let j = i + 1; j < flat.length; j++) {
    if (flat[i].id === flat[j].id) continue;
    const d = dice(flat[i].g, flat[j].g);
    if (d >= NEAR)
      warn(`트리거가 거의 같다 (${d.toFixed(2)}) · ${flat[i].id} "${flat[i].t}" ↔ ${flat[j].id} "${flat[j].t}"`);
  }

// ─────────────────────────────────────────────────────────────
// 2. 어휘 기준선 — 글자 2-gram 유사도로 1등을 고른다
//    진짜 라우팅이 아니다. 「어제 맞던 것이 오늘 틀리는가」만 본다.
// ─────────────────────────────────────────────────────────────
function norm(s) { return String(s).toLowerCase().replace(/[^0-9a-z가-힣]/g, ''); }
function grams(s) {
  const t = norm(s), m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const [g, c] of a) { const d = b.get(g); if (d) inter += Math.min(c, d); }
  let sa = 0, sb = 0;
  for (const c of a.values()) sa += c;
  for (const c of b.values()) sb += c;
  return (2 * inter) / (sa + sb);
}

for (const s of skills) {
  s._trig = s.triggers.map(grams);
  s._name = grams(s.name);
  s._desc = grams(s.desc);
}
function rank(intent) {
  const g = grams(intent);
  return skills
    .map((s) => {
      let best = 0;
      for (const t of s._trig) { const d = dice(g, t); if (d > best) best = d; }
      return { id: s.id, score: best + 0.35 * dice(g, s._name) + 0.15 * dice(g, s._desc) };
    })
    .sort((a, b) => b.score - a.score);
}

const misses = [];
let top1 = 0, top5 = 0;
for (const c of cases) {
  const r = rank(c.intent);
  const i = r.findIndex((x) => x.id === c.id);
  if (i === 0) top1++;
  else misses.push({ id: c.id, intent: c.intent, got: r[0].id });
  if (i >= 0 && i < 5) top5++;
}

// ─────────────────────────────────────────────────────────────
// 3. 기준선 대조 — 새로 틀리기 시작한 것만 실패로 본다
// ─────────────────────────────────────────────────────────────
const keyOf = (m) => `${m.id}|${norm(m.intent)}`;
const nowMiss = new Set(misses.map(keyOf));
const stamp = { cases: cases.length, skills: skills.length, top1, top5, known_misses: misses.map(keyOf).sort() };

let regressions = [], fixed = [];
if (UPDATE) {
  fs.writeFileSync(BASELINE, JSON.stringify(stamp, null, 2) + '\n');
  ok.push(`기준선 갱신 · ${BASELINE.replace(ROOT + '/', '')} (top1 ${top1}/${cases.length})`);
} else if (!fs.existsSync(BASELINE)) {
  warn(`기준선이 없다 — 먼저 \`node scripts/eval-routing.mjs --update-baseline\` 를 한 번 돌린다`);
} else {
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const wasMiss = new Set(base.known_misses || []);
  regressions = [...nowMiss].filter((k) => !wasMiss.has(k));
  fixed = [...wasMiss].filter((k) => !nowMiss.has(k));
  if (base.cases > cases.length) err(`케이스가 줄었다: ${base.cases} → ${cases.length}`);
  if (base.skills > skills.length) err(`스킬이 줄었다: ${base.skills} → ${skills.length}`);
  for (const k of regressions) {
    const m = misses.find((x) => keyOf(x) === k);
    err(`라우팅 회귀 · "${m.intent}" 가 ${m.id} 로 안 간다 (지금 1등: ${m.got})`);
  }
  if (fixed.length) ok.push(`전에 틀리던 ${fixed.length}건이 이제 맞는다 — \`--update-baseline\` 으로 기준선을 내린다`);
  if (!regressions.length) ok.push(`어휘 기준선 회귀 0건 (top1 ${top1}/${cases.length} · top5 ${top5}/${cases.length})`);
  // ⚠️ 「회귀 0건」은 **새로 나빠지지 않았다**는 뜻일 뿐이다. 이미 틀린 것이 몇 건인지 함께 말하지 않으면
  //    초록 한 줄이 부채를 가린다 (실측 2026-08-25 · 280/596 = 47% 가 박제돼 있었다).
  const 부채 = nowMiss.size, 비율 = Math.round((부채 / cases.length) * 100);
  const 변화 = fixed.length ? ` · 이번에 ${fixed.length}건 갚음` : '';
  ok.push(`어휘층 부채 ${부채}/${cases.length} (${비율}%)${변화} — 회귀가 아니라 **줄어야 할 빚**이다 ` +
          `(실사용 라우팅은 B층 \`--live-cc\` 가 잰다)`);
}

// ─────────────────────────────────────────────────────────────
// 4. B층 — 실제 모델 라우팅
//    길은 둘, 재는 것은 하나다. 아래 SYSTEM/USER 와 채점은 두 길이 공유한다.
// ─────────────────────────────────────────────────────────────
// AI 마케터는 후보가 갈리면 docs/헷갈리는-쌍.md 를 먼저 연다 (skills/AI-마케터/SKILL.md §526).
// 명부만 주고 재면 실제보다 harsh 하게 나온다 — 사용자가 겪는 것과 같은 것을 재야 한다.
const PAIRS = (() => {
  const p = path.join(ROOT, 'docs', '헷갈리는-쌍.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
})();

const SYSTEM = (routing) =>
  '너는 이 마케팅 팀의 AI 마케터 다. 아래는 스킬 100개의 라우팅 명부다.\n' +
  '사용자 요청 문장마다 열어야 할 스킬 ID 를 정확히 하나 고른다.\n' +
  '고를 수 없으면 "000" 을 쓴다.\n\n' +
  '답은 오직 JSON 하나다. 설명·머리말·코드펜스를 붙이지 않는다.\n' +
  '{"picks":[{"n":1,"id":"043"},{"n":2,"id":"006"}]}\n\n' + routing +
  (PAIRS ? '\n\n---\n\n' + PAIRS : '');

const USER = (batch) =>
  `아래 ${batch.length}개 요청을 각각 라우팅해라.\n\n` +
  batch.map((c, i) => `${i + 1}. ${c.intent}`).join('\n');

// 모델이 코드펜스를 붙이거나 앞뒤로 말을 얹어도 JSON 만 건져 낸다
function picksOf(text) {
  const t = String(text).replace(/```(?:json)?/g, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(t.slice(i, j + 1)).picks || null; } catch { return null; }
}

function chunk(pool, n) {
  const out = [];
  for (let i = 0; i < pool.length; i += n) out.push(pool.slice(i, i + n));
  return out;
}

function score(out) {
  if (!out.length) { console.log('\n  🔴 한 건도 못 받았다 — 위 경고를 보라. 검사가 돌지 않았다.\n'); return 1; }
  let hit = 0; const near = [], bad = [];
  for (const { c, got } of out) {
    if (got === c.id) hit++;
    else if (c.ambiguous.includes(got)) near.push({ c, got });
    else bad.push({ c, got });
  }
  const rate = ((hit / out.length) * 100).toFixed(1);
  console.log(`\n  정확 ${hit}/${out.length} (${rate}%) · 헷갈릴 만한 것 ${near.length} · 틀림 ${bad.length}\n`);
  if (near.length && REPORT)
    for (const { c, got } of near) console.log(`  🟡 ${c.id} ↔ ${got} · "${c.intent}"  (ambiguous_with 에 적혀 있음)`);
  for (const { c, got } of bad.slice(0, REPORT ? 9999 : 15))
    console.log(`  🔴 ${c.id} 여야 하는데 ${got} · "${c.intent}"`);
  if (!REPORT && bad.length > 15) console.log(`  … 외 ${bad.length - 15}건 (--report 로 전부)`);
  console.log('');
  return bad.length;
}

// ── 길 ① 맥스 구독 · 이미 깔린 claude CLI 를 헤드리스로 부른다 ──────────
//    프롬프트 캐시를 못 쓰니 ROUTING.md 를 매번 다시 보낸다. 그래서 묶음을 크게 잡는다.
async function liveCC() {
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const WIN = process.platform === 'win32';
  const routing = fs.readFileSync(path.join(M, 'ROUTING.md'), 'utf8');
  const pool = LIMIT ? cases.slice(0, LIMIT) : cases;
  const batches = chunk(pool, 40);

  console.log(`\n🔵 B층 · 맥스 구독 (claude CLI) · ${pool.length}건 / ${batches.length}회`);
  console.log('   추가 결제가 없다. 구독 사용량만 쓴다. API 보다 느리다.\n');

  const ask = (batch, bi) =>
    new Promise((resolve) => {
      const args = ['-p', '--output-format', 'text', '--tools', '', '--strict-mcp-config',
                    '--system-prompt', SYSTEM(routing)];
      if (argv.includes('--model')) args.push('--model', MODEL);
      // cwd 를 /tmp 로 둔다 — 작업 폴더의 CLAUDE.md·스킬이 딸려 들어가면 순수한 라우팅이 아니다
      // cwd 를 임시 폴더로 둔다 — 작업 폴더의 CLAUDE.md·스킬이 딸려 들어가면 순수한 라우팅이 아니다.
      //   ⚠️ '/tmp' 를 박으면 윈도우에서 깨진다. shell:true 도 윈도우에서만 — claude 가 .cmd 라서다.
      const cp = spawn('claude', args, { cwd: os.tmpdir(), shell: WIN, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', errb = '';
      cp.stdout.on('data', (d) => (out += d));
      cp.stderr.on('data', (d) => (errb += d));
      cp.on('error', (e) => {
        console.log(`\n  🔴 claude 를 못 부른다 (${e.message}) · 클로드 코드가 깔려 있어야 한다\n`);
        process.exit(1);
      });
      cp.on('close', (code) => {
        if (code !== 0) { console.log(`  ⚠️ ${bi + 1}번째 묶음 · claude 종료코드 ${code} ${errb.trim().slice(0, 120)}`); return resolve([]); }
        const picks = picksOf(out);
        if (!picks) { console.log(`  ⚠️ ${bi + 1}번째 묶음 · 파싱 실패`); return resolve([]); }
        process.stdout.write(`  ${bi + 1}/${batches.length}\r`);
        resolve(picks.map((p) => ({ c: batch[p.n - 1], got: String(p.id).padStart(3, '0') })).filter((x) => x.c));
      });
      cp.stdin.end(USER(batch));
    });

  // 2개씩만 · 구독 한도를 밀어붙이지 않는다
  const out = [];
  for (let i = 0; i < batches.length; i += 2)
    out.push(...(await Promise.all(batches.slice(i, i + 2).map((b, j) => ask(b, i + j)))).flat());
  return score(out);
}

// ── 길 ② API · 토큰 과금 · CI 에서도 돈다 ─────────────────────────────
async function live() {
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch {
    console.log('\n🔴 --live 에는 공식 SDK 가 필요하다:  npm i @anthropic-ai/sdk');
    console.log('   추가 결제 없이 재려면 --live-cc (맥스 구독) 를 써라.\n');
    process.exit(1);
  }
  const routing = fs.readFileSync(path.join(M, 'ROUTING.md'), 'utf8');
  const client = new Anthropic();
  const pool = LIMIT ? cases.slice(0, LIMIT) : cases;
  const batches = chunk(pool, 20);

  console.log(`\n🔵 B층 · API (토큰 과금) · ${pool.length}건 / ${batches.length}회 · ${MODEL}`);
  console.log('   ROUTING.md 를 프롬프트 캐시에 올린다. 첫 호출만 비싸다.\n');

  const SCHEMA = {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: { n: { type: 'integer' }, id: { type: 'string' } },
          required: ['n', 'id'],
          additionalProperties: false,
        },
      },
    },
    required: ['picks'],
    additionalProperties: false,
  };

  const run = async (batch, bi) => {
    let res;
    try {
      res = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: [{ type: 'text', text: SYSTEM(routing), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: USER(batch) }],
      });
    } catch (e) {
      // 키 오타 하나에 스택 트레이스가 쏟아지지 않게 한다. 무엇을 고쳐야 하는지만 말한다.
      if (e instanceof Anthropic.AuthenticationError) {
        console.log('\n  🔴 API 키가 틀렸다 · ANTHROPIC_API_KEY 를 확인해라 (console.anthropic.com)');
        console.log('     추가 결제 없이 재려면 --live-cc (맥스 구독).\n');
        process.exit(1);
      }
      if (e instanceof Anthropic.NotFoundError) {
        console.log(`\n  🔴 모델을 못 찾는다: ${MODEL} · --model 로 바꿔라\n`);
        process.exit(1);
      }
      if (e instanceof Anthropic.RateLimitError) { console.log(`  ⚠️ ${bi + 1}번째 묶음 · 한도 초과`); return []; }
      if (e instanceof Anthropic.APIError) { console.log(`  ⚠️ ${bi + 1}번째 묶음 · API ${e.status} ${e.message}`); return []; }
      // SDK 는 키가 아예 없으면 요청 전에 여기서 걸린다 (APIError 가 아니다)
      if (/authentication method/i.test(e.message)) {
        console.log('\n  🔴 자격 증명이 없다.  export ANTHROPIC_API_KEY=sk-ant-…  (console.anthropic.com)');
        console.log('     추가 결제 없이 재려면 --live-cc (맥스 구독).\n');
        process.exit(1);
      }
      console.log(`  ⚠️ ${bi + 1}번째 묶음 · ${e.message}`);
      return [];
    }
    if (res.stop_reason === 'refusal') { console.log(`  ⚠️ ${bi + 1}번째 묶음 거절됨`); return []; }
    const picks = picksOf(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!picks) { console.log(`  ⚠️ ${bi + 1}번째 묶음 · 파싱 실패`); return []; }
    process.stdout.write(`  ${bi + 1}/${batches.length}\r`);
    return picks.map((p) => ({ c: batch[p.n - 1], got: String(p.id).padStart(3, '0') })).filter((x) => x.c);
  };

  const out = [];
  for (let i = 0; i < batches.length; i += 4)
    out.push(...(await Promise.all(batches.slice(i, i + 4).map((b, j) => run(b, i + j)))).flat());
  return score(out);
}

// ─────────────────────────────────────────────────────────────
// 5. 출력
// ─────────────────────────────────────────────────────────────
console.log(`\n라우팅 회귀 검사 · 스킬 ${skills.length} · 케이스 ${cases.length}\n`);
if (REPORT && misses.length) {
  console.log(`  ── 어휘 기준선에서 1등을 못 잡는 ${misses.length}건 ──`);
  for (const m of misses) console.log(`     ${m.id} → ${m.got}  "${m.intent}"`);
  console.log('');
}
for (const o of ok) console.log(`  ✅ ${o}`);
for (const [s, m] of issues) console.log(`  ${s} ${m}`);

let fail = issues.filter((i) => i[0] === '🔴').length;
console.log(`\n🔴 ${fail} · 🟡 ${issues.length - fail}`);
if (!LIVE && !LIVE_CC)
  console.log('   B층(실제 모델 라우팅)은 `--live-cc` (맥스 구독) 또는 `--live` (API). 이 검사는 모델을 부르지 않는다.\n');
if (LIVE_CC) fail += await liveCC();
else if (LIVE) fail += await live();
process.exit(fail ? 1 : 0);
