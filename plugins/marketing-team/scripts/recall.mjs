#!/usr/bin/env node
/**
 * recall.mjs · 쌓인 실행을 다시 찾는다 (gbrain 구조 참고 · 2026-08-31)
 *
 * 원칙 (github.com/garrytan/gbrain 에서 가져온 것):
 *   1. 원본은 md 와 영수증이다. 색인은 캐시다 — 지워도 `index` 로 다시 만들어진다.
 *   2. 색인은 LLM 없이 만든다 — 영수증(run*.json)이 이미 들고 있는 것만 옮긴다.
 *   3. 회상은 두 모드다 — `search` 는 빠르고 모델을 안 부른다. 종합(왜·다음 행동)은
 *      AI 마케터가 검색 결과를 읽고 한다. 이 스크립트는 종합하지 않는다.
 *   4. 관계는 그래프다 — 단계의 `consumed` (앞 산출물 지문)가 앞→뒤 엣지다. `graph` 가 따라간다.
 *
 * 사용 (작업 폴더에서):
 *   node scripts/recall.mjs index                    영수증 → logs/recall-index.jsonl (증분)
 *   node scripts/recall.mjs search "예산 재배분"       키워드 회상 · --skill 046 · --recent 90 · --top 5
 *   node scripts/recall.mjs graph outputs/.../run.json  이 실행이 무엇을 먹고 무엇에게 먹혔나
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORK = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const INDEX = path.join(WORK, 'logs', 'recall-index.jsonl');
const fail = m => { console.error(`🔴 ${m}`); process.exit(1); };
const posix = v => v.split(path.sep).join('/');

function* receipts() {
  const root = path.join(WORK, 'outputs');
  if (!fs.existsSync(root)) return;
  const walk = function* (dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const t = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(t);
      else if (/^run(?:-\d+)?\.json$/.test(e.name)) yield t;
    }
  };
  yield* walk(root);
}

const tokens = text => [...new Set(String(text).toLowerCase().normalize('NFKC')
  .split(/[^0-9a-z가-힣]+/).filter(w => w.length >= 2))];

function rowOf(file) {
  let run;
  try { run = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!run.run_id) return null;
  const outs = (run.outputs || []).map(o => String(o.path || o));
  const consumed = [];
  for (const st of run.steps || [])
    for (const src of Object.keys(st.consumed || {})) consumed.push({ step: st.step, from: src });
  return {
    run_id: run.run_id,
    at: run.started_at || null,
    status: run.status || null,
    request: run.request || '',
    skills: (run.skills || []).map(s => ({ id: s.id, name: s.name })),
    outputs: outs,
    receipt: posix(path.relative(WORK, file)),
    gate: (run.reviews || []).some(r => r.kind === 'compliance')
      ? (run.reviews.find(r => r.kind === 'compliance')?.status || null) : null,
    consumed,
  };
}

function loadIndex() {
  if (!fs.existsSync(INDEX)) return [];
  return fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function cmdIndex() {
  const known = new Set(loadIndex().map(r => r.run_id));
  const added = [];
  for (const file of receipts()) {
    const row = rowOf(file);
    if (row && !known.has(row.run_id)) added.push(row);
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(INDEX), { recursive: true });
    fs.appendFileSync(INDEX, added.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  console.log(`✅ 색인 · 새로 ${added.length}건 · 누적 ${known.size + added.length}건 (${posix(path.relative(WORK, INDEX))})`);
  console.log('   색인은 캐시다 — 지워져도 이 명령으로 다시 만들어진다. 원본은 outputs/ 의 md 와 영수증이다.');
}

function cmdSearch(args) {
  const q = args.filter(a => !a.startsWith('--'))[0] || '';
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const skill = opt('--skill');
  const recent = Number(opt('--recent') || 0);
  const top = Number(opt('--top') || 5);
  if (!q && !skill) fail('질의나 --skill 이 필요합니다.');
  const qt = tokens(q);
  const cut = recent ? new Date(Date.now() - recent * 86400e3).toISOString() : null;
  const scored = loadIndex().map(r => {
    if (skill && !r.skills.some(s => s.id === skill)) return null;
    if (cut && r.at && r.at < cut) return null;
    const hay = tokens(`${r.request} ${r.skills.map(s => `${s.id} ${s.name || ''}`).join(' ')} ${r.outputs.join(' ')}`);
    const hit = qt.filter(t => hay.some(h => h.includes(t) || t.includes(h))).length;
    if (qt.length && !hit) return null;
    return { score: hit + (r.status === 'completed' ? 0.5 : 0), r };
  }).filter(Boolean).sort((a, b) => b.score - a.score || String(b.r.at).localeCompare(String(a.r.at)));
  if (!scored.length) { console.log('· 걸린 실행 없음 — 색인이 낡았으면 `index` 를 먼저 돈다'); return; }
  for (const { r } of scored.slice(0, top)) {
    const sk = r.skills.map(s => `${s.name || ''}(${s.id})`).join('→');
    console.log(`${(r.at || '').slice(0, 10)} · ${sk} · ${r.status}${r.gate ? ` · 규제 ${r.gate}` : ''}`);
    console.log(`  요청: ${r.request.slice(0, 60)}`);
    for (const o of r.outputs) console.log(`  📁 ${o}`);
  }
}

function cmdGraph(target) {
  if (!target) fail('run.json 경로나 산출물 경로가 필요합니다.');
  const rows = loadIndex();
  const norm = posix(target).replace(/^workspace:/, '');
  const me = rows.find(r => r.receipt === norm || r.outputs.some(o => o.replace(/^workspace:/, '') === norm) || r.run_id === target);
  if (!me) fail('색인에서 못 찾았습니다. `index` 를 먼저 돌리세요.');
  console.log(`● ${me.run_id} · ${me.skills.map(s => s.id).join('→')} · ${me.status}`);
  for (const c of me.consumed) console.log(`  ← 먹은 것 (단계 ${c.step}): ${c.from}`);
  const myOuts = new Set(me.outputs.map(o => o.replace(/^workspace:/, '')));
  for (const r of rows)
    for (const c of r.consumed)
      if (myOuts.has(c.from.replace(/^workspace:/, '')))
        console.log(`  → 먹힌 곳: ${r.run_id} (단계 ${c.step} · ${r.skills.map(s => s.id).join('→')})`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'index') cmdIndex();
else if (cmd === 'search') cmdSearch(rest);
else if (cmd === 'graph') cmdGraph(rest[0]);
else fail('사용: recall.mjs index | search "질의" [--skill 046] [--recent 90] [--top 5] | graph <run.json|산출물>');
