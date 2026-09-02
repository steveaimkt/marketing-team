#!/usr/bin/env node
/**
 * plan-compiler.mjs · G2 계획을 기계가 대조할 수 있는 구조로 굳힌다.
 *
 * 사용:
 *   node scripts/plan-compiler.mjs compile outputs/.../plan.json
 *   node scripts/plan-compiler.mjs approve outputs/.../plan.json
 *   node scripts/plan-compiler.mjs check   outputs/.../plan.json
 *
 * 왜 필요한가 · 실측 2026-08-30
 *   중급 실행이 승인 전에 계획에 없던 HTML 을 만들었고, 고급 실행이 사용자가 지정한
 *   `061→073→065→066` 을 `061→065→073→066` 으로 바꿔 돌았다.
 *   「계획을 보여주고 기다린다」는 문장만으로는 계획과 실행이 같은지 아무도 대조하지 못한다.
 *   승인의 대상이 **문장이 아니라 해시**여야 한다.
 *
 * 상태: plan-ready → awaiting-approval → approved
 *   approved 가 아니면 run-receipt start 가 실행을 열지 않는다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileChain, validateChainPlan } from './chain-compiler.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'marketing-team.plan/v1';
const STATES = ['plan-ready', 'awaiting-approval', 'approved'];
const KINDS = new Set(['business', 'compliance']);
const PERSPECTIVES = new Set(['경영', '재무', '고객', '법무', '브랜드']);

const fail = message => { console.error(`🔴 ${message}`); process.exit(1); };

/* ── 스킬 선언 읽기 ─────────────────────────────────────────── */

function frontmatterList(text, key) {
  const line = (text.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, 'm')) || [])[1];
  if (!line) return [];
  return line.split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

let cache = null;
export function skillDeclarations() {
  if (cache) return cache;
  cache = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name === 'SKILL.md') {
        const text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
        const id = ((text.match(/^id:\s*["']?(\d{3})/m) || [])[1] || '').trim();
        if (!id) continue;
        cache.set(id, {
          id,
          name: ((text.match(/^name:\s*(.+)$/m) || [])[1] || '').trim(),
          gate: /^gate:\s*true\s*$/m.test(text),
          pii: /^pii:\s*true\s*$/m.test(text),
          review: ((text.match(/^review:\s*(.+)$/m) || [])[1] || '')
            .split(/[·,]/).map(v => v.trim()).filter(Boolean),
          writesTo: frontmatterList(text, 'writes_to'),
          chainsTo: frontmatterList(text, 'chains_to'),
        });
      }
    }
  };
  walk(path.join(PLUGIN, '100-skills'));
  return cache;
}

/* ── 정규화와 해시 ──────────────────────────────────────────── */

/** 의미가 같은 계획은 같은 해시를 내야 한다. 순서가 의미인 곳은 정렬하지 않는다. */
export function normalizePlan(plan) {
  const steps = (plan.steps || []).map((step, index) => ({
    step: index + 1,                                   // 번호는 위치로 다시 매긴다
    skill: String(step.skill || '').trim(),
    inputs: [...(step.inputs || [])].map(String).sort(),   // 입력은 집합
    outputs: [...(step.outputs || [])].map(String).sort(), // 산출물도 집합
    reviews: [...(step.reviews || [])]
      .map(r => ({ kind: String(r.kind || ''), ...(r.perspective ? { perspective: String(r.perspective) } : {}) }))
      .sort((a, b) => `${a.kind}:${a.perspective || ''}`.localeCompare(`${b.kind}:${b.perspective || ''}`)),
    depends_on: [...(step.depends_on || [])].map(String).sort(),
  }));
  return {
    schema: SCHEMA,
    request: String(plan.request || '').trim(),
    requested_order: (plan.requested_order || []).map(String),  // 사용자가 말한 순서 · 있으면 계약이다
    chain: plan.chain ? String(plan.chain) : null,
    risks: [...(plan.risks || [])].map(r => ({ code: String(r.code || ''), message: String(r.message || '') })),
    skills: (plan.skills || []).map(String),            // 순서가 곧 실행 순서다 · 정렬 금지
    steps,
    budget: {
      tool_calls: Number(plan.budget?.tool_calls || 0),
      wall_minutes: Number(plan.budget?.wall_minutes || 0),
      review_rounds: Number(plan.budget?.review_rounds ?? 3),
    },
  };
}

export function planHash(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizePlan(plan)), 'utf8').digest('hex');
}

/* ── 검사 ───────────────────────────────────────────────────── */

export function validatePlan(plan) {
  const issues = [];
  if (plan.schema && plan.schema !== SCHEMA) issues.push(`지원하지 않는 스키마입니다: ${plan.schema}`);
  if (!String(plan.request || '').trim()) issues.push('request 가 비었습니다. 사용자 요청을 그대로 적으세요.');
  const skills = plan.skills || [];
  if (!skills.length) issues.push('skills 가 비었습니다.');
  const steps = plan.steps || [];
  if (!steps.length) issues.push('steps 가 비었습니다. 단계마다 스킬·입력·산출물·검토를 적으세요.');
  for (const [field, label] of [['tool_calls', '도구 호출'], ['wall_minutes', '실행 시간'], ['review_rounds', '검토 라운드']]) {
    const value = Number(plan.budget?.[field] ?? (field === 'review_rounds' ? 3 : 0));
    if (!Number.isFinite(value) || value < 0) issues.push(`${label} 예산은 0 이상의 숫자여야 합니다: ${plan.budget?.[field]}`);
  }

  // 사용자가 순서를 말했으면 그대로 돈다. 모델이 「더 나은 순서」로 바꾸지 않는다.
  // 실측 2026-08-30 — 사용자가 061→073→065→066 을 지정했는데 061→065→073→066 으로 바꿔 돌았다.
  // 정방향이 아니라는 이유로 고쳐 주면, 사용자는 자기가 시킨 것과 다른 결과를 받는다.
  // 충돌이 있으면 G2 에서 설명하고 승인받되, 승인된 순서는 그대로 지킨다.
  const requested = (plan.requested_order || []).map(String);
  if (requested.length) {
    const got = (plan.skills || []).map(String);
    if (requested.join(',') !== got.join(','))
      issues.push(`사용자가 지정한 순서와 다릅니다: 요청 ${requested.join('→')} · 계획 ${got.join('→')}`);
  }

  let planFormat = null;
  try { planFormat = normalizeFormatChoice(plan.형식, '계획의'); }
  catch (error) { issues.push(error.message); }

  const decl = skillDeclarations();
  const stepSkills = steps.map(s => String(s.skill || '').trim());
  if (skills.join(',') !== stepSkills.join(','))
    issues.push(`skills 와 steps 의 순서가 다릅니다: ${skills.join('→')} ≠ ${stepSkills.join('→')}`);

  const producedSoFar = new Set();
  for (const [index, step] of steps.entries()) {
    const id = String(step.skill || '').trim();
    const found = decl.get(id);
    const at = `step ${index + 1}(${id || '?'})`;
    if (!found) { issues.push(`${at} · 그런 스킬이 없습니다.`); continue; }

    // 재실행 산출물 1:1 계약 (P1 · 2026-08-30 최종 검토) —
    // 이름-2.md 는 정본 이름.md 의 재실행이다. 정본 하나에 실제 파일이 정확히 하나,
    // 재실행 순번은 한 단계 안에서 하나여야 한다 (정본과 -2 동시는 두 실행이 섞인 것이다).
    // 정확 일치를 먼저 보므로 이름에 숫자가 든 기존 계약은 안 깨진다. run-receipt 와 같은 규칙.
    const parseOut = out => {
      const m2 = out.match(/^(.*)-(\d+)(\.[a-z0-9]+)$/i);
      return m2 ? { canon: m2[1] + m2[3], ord: m2[2] } : { canon: out, ord: '1' };
    };
    const outs = (step.outputs || []).map(v => path.posix.basename(String(v)));
    const 계약 = [...new Set(found.writesTo.map(v => path.posix.basename(v)).filter(b => b.includes('.')))];
    let allowed = 계약;
    try { allowed = applyFormatChoice(계약, planFormat); }
    catch (error) { issues.push(`${at} · ${error.message}`); }
    const canonOf = out => (allowed.includes(out) ? out : (allowed.includes(parseOut(out).canon) ? parseOut(out).canon : null));
    const matchCount = new Map(allowed.map(b => [b, 0]));
    const ords = new Set();
    for (const out of outs) {
      const canon = canonOf(out);
      if (canon === null) { issues.push(`${at} · 스킬 계약에 없는 산출물입니다: ${out}`); continue; }
      matchCount.set(canon, matchCount.get(canon) + 1);
      ords.add(out === canon ? '1' : parseOut(out).ord);
    }
    for (const base of allowed) {
      const count = matchCount.get(base) || 0;
      if (count === 0) issues.push(`${at} · writes_to 파일이 산출물에 없습니다: ${base}`);
      if (count > 1) issues.push(`${at} · 같은 정본에 산출물이 ${count}개 대응합니다 — 한 실행에 하나입니다: ${base}`);
    }
    if (ords.size > 1) issues.push(`${at} · 재실행 순번이 섞였습니다(${[...ords].sort().join('·')}) — 한 실행의 산출물은 같은 순번을 씁니다.`);
    // 검토 정책 · 선언한 것은 계획에 있어야 한다
    const reviews = step.reviews || [];
    for (const perspective of found.review) {
      if (!PERSPECTIVES.has(perspective)) { issues.push(`${at} · 모르는 검토 관점입니다: ${perspective}`); continue; }
      if (!reviews.some(r => r.kind === 'business' && r.perspective === perspective))
        issues.push(`${at} · review: ${perspective} 인데 계획에 business:${perspective} 가 없습니다.`);
    }
    if (found.gate && !reviews.some(r => r.kind === 'compliance'))
      issues.push(`${at} · gate: true 인데 계획에 compliance 검사가 없습니다.`);
    for (const r of reviews) {
      if (!KINDS.has(r.kind)) issues.push(`${at} · 검토 종류가 잘못됐습니다: ${r.kind}`);
      if (r.kind === 'business' && !PERSPECTIVES.has(r.perspective))
        issues.push(`${at} · 사업 검토 관점이 잘못됐습니다: ${r.perspective}`);
    }
    // 앞 단계 산출물이 뒤 단계 입력으로 이어지는가 (2단계부터, workspace: 입력만 본다)
    if (index > 0) {
      const fromWorkspace = (step.inputs || []).filter(v => String(v).startsWith('workspace:'));
      for (const ref of fromWorkspace) {
        if (!producedSoFar.has(String(ref)))
          issues.push(`${at} · 앞 단계가 만들지 않은 작업 폴더 입력입니다: ${ref}`);
      }
    }
    for (const ref of step.outputs || []) producedSoFar.add(String(ref));
  }

  // 같은 파일을 두 단계가 덮어쓰는가
  const seen = new Map();
  for (const [index, step] of steps.entries()) {
    for (const ref of step.outputs || []) {
      const key = String(ref);
      if (seen.has(key)) issues.push(`step ${seen.get(key)} 와 step ${index + 1} 이 같은 파일을 씁니다: ${key}`);
      else seen.set(key, index + 1);
    }
  }
  issues.push(...validateChainPlan(plan));
  return issues;
}

/* ── 파일 조작 ──────────────────────────────────────────────── */

const read = file => {
  if (!fs.existsSync(file)) fail(`계획 파일이 없습니다: ${file}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`계획 파일을 읽지 못했습니다: ${error.message}`); }
};
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** 승인이 현재 계획에 유효한가. run-receipt 와 훅이 함께 쓴다. */
/**
 * 사용자가 고른 **그릇**을 계약에 반영한다 (2026-09-02).
 *
 * 그릇만 바꾼다 — 파일 수와 이름 줄기는 그대로다. `writes_to` 는 여전히 정본이고,
 * 무엇을 몇 개 내는지는 스킬이 정한다. 사용자는 **무엇으로 열지**만 고른다.
 * 어느 정본을 바꾸는지 이름으로 짚게 해서 1:1 계약이 흐려지지 않게 한다.
 *
 *   "형식": { "091-work-audit.xlsx": "csv" }
 *
 * G2 계획에서 한 번 정하고 승인과 함께 봉인한다. 실행 중에 바꾸지 않는다.
 * run-receipt 가 이 둘을 그대로 가져다 쓴다 — 계획과 영수증이 같은 자로 재야 한다.
 */
export const 그릇 = new Set(['md', 'csv', 'xlsx', 'html', 'docx', 'pptx', 'pdf']);

export function normalizeFormatChoice(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where} 형식은 {"정본파일명": "확장자"} 꼴이어야 합니다.`);
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const 정본 = path.posix.basename(String(key));
    const 새 = String(raw).replace(/^\./, '').toLowerCase();
    if (!그릇.has(새))
      throw new Error(`모르는 그릇입니다: .${새} — ${[...그릇].map(v => '.' + v).join(' · ')} 중에서 고르세요.`);
    out[정본] = 새;
  }
  return Object.keys(out).length ? out : null;
}

export function applyFormatChoice(expected, choice) {
  if (!choice) return expected;
  const out = [...expected];
  for (const [정본, 새] of Object.entries(choice)) {
    const i = out.indexOf(정본);
    if (i === -1)
      throw new Error(`그릇을 바꿀 정본이 계약에 없습니다: ${정본} · 계약은 ${expected.join(' · ')} 입니다.`);
    const 바뀐 = 정본.replace(/\.[^.]+$/, `.${새}`);
    if (바뀐 !== 정본 && out.includes(바뀐))
      throw new Error(`그릇을 바꾸면 다른 정본과 이름이 겹칩니다: ${바뀐}`);
    out[i] = 바뀐;
  }
  return out;
}

export function approvalState(plan) {
  const current = planHash(plan);
  if (plan.status !== 'approved') return { ok: false, current, reason: `계획이 ${plan.status || 'plan-ready'} 상태입니다. 승인을 받으세요.` };
  if (!plan.approved_sha256) return { ok: false, current, reason: '승인 해시가 없습니다.' };
  if (plan.approved_sha256 !== current)
    return { ok: false, current, reason: `승인한 계획과 지금 계획이 다릅니다. 새 [실행 계획]으로 다시 승인받으세요.` };
  return { ok: true, current };
}

/* ── CLI ───────────────────────────────────────────────────── */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const [command, target] = process.argv.slice(2);
  if (!command || !target) fail('사용: plan-compiler.mjs <compile|approve|check> <plan.json>');
  const file = path.resolve(process.cwd(), target);
  if (path.basename(file) !== 'plan.json') fail('계획 파일 이름은 plan.json 이어야 합니다.');
  const plan = read(file);

  if (command === 'compile') {
    const issues = validatePlan(plan);
    if (issues.length) { for (const line of issues) console.error(`⛔ ${line}`); fail(`계획이 계약과 맞지 않습니다 · ${issues.length}건`); }
    plan.schema = SCHEMA;
    const graph = compileChain(plan);
    plan.chain_graph = { schema: graph.schema, chain: graph.chain, nodes: graph.nodes, edges: graph.edges };
    plan.risks = graph.warnings;
    plan.plan_sha256 = planHash(plan);
    plan.status = 'awaiting-approval';
    plan.approved_sha256 = null;
    write(file, plan);
    console.log(`✅ 계획 확정 · ${plan.skills.join('→')} · ${plan.plan_sha256.slice(0, 12)} · 승인 대기`);
    // 계획 흔적을 실행 타래에 남긴다 (P2 · 2026-08-30) — 작업 공간일 때만 · 실패해도 컴파일을 막지 않는다.
    try {
      if (fs.existsSync(path.resolve(process.cwd(), 'outputs'))) {
        const { appendEvent } = await import('./orchestrator-events.mjs');
        appendEvent(process.cwd(), { plan: { plan_sha256: plan.plan_sha256 }, skills: plan.skills, status: plan.status },
          'plan.compiled', { plan_id: plan.plan_id || null, request: plan.request || null });
      }
    } catch { /* 무시 */ }
  } else if (command === 'approve') {
    const issues = validatePlan(plan);
    if (issues.length) { for (const line of issues) console.error(`⛔ ${line}`); fail('계획이 계약과 맞지 않아 승인할 수 없습니다.'); }
    const current = planHash(plan);
    if (plan.plan_sha256 && plan.plan_sha256 !== current)
      fail('확정한 뒤 계획이 바뀌었습니다. compile 을 다시 돌리고 새로 승인받으세요.');
    plan.plan_sha256 = current;
    plan.approved_sha256 = current;
    plan.status = 'approved';
    write(file, plan);
    console.log(`✅ 계획 승인 봉인 · ${current.slice(0, 12)}`);
    try {
      if (fs.existsSync(path.resolve(process.cwd(), 'outputs'))) {
        const { appendEvent } = await import('./orchestrator-events.mjs');
        appendEvent(process.cwd(), { plan: { plan_sha256: current }, skills: plan.skills, status: plan.status },
          'plan.approved', { plan_id: plan.plan_id || null, request: plan.request || null });
      }
    } catch { /* 무시 */ }
  } else if (command === 'check') {
    const issues = validatePlan(plan);
    for (const line of issues) console.error(`⛔ ${line}`);
    const state = approvalState(plan);
    if (!state.ok) fail(state.reason);
    if (issues.length) fail(`계획이 계약과 맞지 않습니다 · ${issues.length}건`);
    console.log(`✅ 승인 유효 · ${state.current.slice(0, 12)} · ${plan.skills.join('→')}`);
  } else fail('명령은 compile · approve · check 중 하나입니다.');
}
