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
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { canonicalChains, compileChain, validateChainPlan } from './chain-compiler.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'marketing-team.plan/v1';
const STATES = ['plan-ready', 'awaiting-approval', 'approved'];
const KINDS = new Set(['business', 'compliance']);
const PERSPECTIVES = new Set(['경영', '재무', '고객', '법무', '브랜드']);

const fail = message => { console.error(`🔴 ${message}`); process.exit(1); };

/**
 * 점검이 실패하면 설치본이 저장소보다 낡았는지 먼저 본다. 고친 판이 나왔는데 데스크톱이 옛 판을 계속 쓰면
 * 같은 오류가 반복되고, 모델은 플러그인 사본을 고쳐 점검을 비켜 가자고 한다 (실측 2026-10-12 · 데스크톱이
 * 9월 21일 동기화본 v0.61.4 로 돌아 v0.69·v0.72.2 의 수정이 한 번도 닿지 않았다). 못 읽으면 말하지 않는다.
 */
export function staleNotice() {
  try {
    const mine = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    const repo = String(mine.repository || '').match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
    if (!repo || process.env.MARKETING_TEAM_NO_UPDATE_CHECK) return '';
    const cacheFile = path.join(os.tmpdir(), `marketing-team-latest-${repo.replace('/', '-')}.json`);
    let latest = '';
    try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (Date.now() - c.at < 3600e3) latest = c.version; } catch { /* 없음 */ }
    if (!latest) {
      const url = `https://raw.githubusercontent.com/${repo}/main/.claude-plugin/marketplace.json`;
      const r = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(r=>r.ok?r.text():'').then(t=>process.stdout.write(t)).catch(()=>{})`], { encoding: 'utf8', timeout: 4000 });
      const market = JSON.parse(r.stdout || '{}');
      latest = (market.plugins || []).find(x => x.name === mine.name)?.version || '';
      if (latest) try { fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), version: latest })); } catch { /* 무시 */ }
    }
    const n = v => String(v).split('.').map(Number);
    const [a, b] = [n(mine.version), n(latest)];
    const older = latest && [0, 1, 2].some((i, _, all) => all.slice(0, i).every(j => a[j] === b[j]) && a[i] < b[i]);
    return older ? `설치본은 v${mine.version}, 저장소 최신은 v${latest}입니다. 이 오류는 최신 판에서 고쳐졌을 수 있습니다. ` +
      '사용자에게 「마켓플레이스를 먼저 동기화 → 플러그인 업데이트 → 새 대화」를 안내하세요. 플러그인 파일을 복사하거나 고쳐서 점검을 비켜 가지 않습니다.' : '';
  } catch { return ''; }
}
const failPlan = message => { const stale = staleNotice(); if (stale) console.error(`🟡 ${stale}`); fail(message); };

/* ── 스킬 선언 읽기 ─────────────────────────────────────────── */

// 머리말은 우리가 쓴 모양 그대로 도착하지 않는다 (실측 2026-10-12 · 데스크톱 클라우드 동기화본에서
// `writes_to: "[a, b, c]"` 처럼 따옴표로 감싸여 와서 계약이 빈 목록으로 읽혔고, 정상 산출물 셋이
// 「계약에 없는 산출물」로 거부됐다). 따옴표·뒤 주석·여러 줄 목록을 모두 같은 값으로 읽는다.
// 같은 규칙을 run-receipt · runtime-guard · ledger-stats 가 가져다 쓴다 · 한 곳만 고치면 어긋난다.
const unquote = v => v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
const stripComment = v => v.replace(/\s+#(?=\s|$).*$/, '');
// 뒤 주석까지 통째로 따옴표에 들어온 모양 `"[a, b]   # 주석"` 도 있다 (실측 2026-10-12 · v0.69 는 주석 없는
// 모양만 시험해서 006 의 마지막 파일이 `…해설.md]` 로 읽혔다). 주석을 먼저 떼면 닫는 따옴표까지 잘린다.
const clean = v => {
  const a = stripComment(v).trim();
  if (!/^["']/.test(a) || /^(["'])[\s\S]*\1$/.test(a)) return unquote(a);
  return unquote(stripComment(unquote(v)));
};
const frontmatterOf = text => {
  const t = String(text).replace(/\r\n/g, '\n');
  return (t.match(/^---\n([\s\S]*?)\n---(?:\n|$)/) || [, t])[1];
};

/** 머리말 한 칸의 값 · 없으면 '' · 따옴표와 뒤 주석은 뗀다 */
export function frontmatterField(text, key) {
  const m = frontmatterOf(text).match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  return m ? clean(m[1]) : '';
}

/** 머리말 목록 · `[a, b]` · `"[a, b]"` · 다음 줄부터 `- a` 를 모두 읽는다 */
export function frontmatterList(text, key) {
  const fm = frontmatterOf(text);
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!m) return [];
  let value = clean(m[1]);
  if (!value) {
    const block = fm.slice(m.index + m[0].length).match(/^(?:\n[ \t]+-[ \t]*.*)+/);
    return block ? block[0].split('\n').map(l => l.replace(/^[ \t]+-[ \t]*/, '')).map(clean).filter(Boolean) : [];
  }
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  return value.split(',').map(unquote).filter(Boolean);
}

/** 머리말 참·거짓 · `true` · `"true"` · `true  # 주석` 모두 참 */
export const frontmatterFlag = (text, key) => frontmatterField(text, key).toLowerCase() === 'true';

let cache = null;
/** 공식 100개 · 패키지 안이라 한 번만 읽는다 */
function officialDeclarations() {
  if (cache) return cache;
  cache = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      // _보류/ 는 등록되지 않은 스킬을 보관하는 폴더다. 배제하지 않으면
      // 같은 id를 쓰는 보류 스킬이 등록 스킬 계약을 조용히 덮어쓴다
      // (실측 2026-09-13 · 8장 052 ID 충돌).
      if (entry.isDirectory() && entry.name === '_보류') continue;
      if (entry.isDirectory()) walk(target);
      else if (entry.name === 'SKILL.md') {
        const text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
        const id = (frontmatterField(text, 'id').match(/^\d{3}/) || [''])[0];
        if (!id) continue;
        cache.set(id, {
          id,
          dir: path.dirname(target),
          name: frontmatterField(text, 'name'),
          gate: frontmatterFlag(text, 'gate'),
          pii: frontmatterFlag(text, 'pii'),
          mutating: frontmatterFlag(text, 'mutating'),
          // review: 뒤 「# 날짜 · 이유」 주석은 관점이 아니다 (verify.mjs 와 같은 규칙)
          review: frontmatterField(text, 'review').split(/[·,]/).map(v => v.trim()).filter(Boolean),
          writesTo: frontmatterList(text, 'writes_to'),
          chainsTo: frontmatterList(text, 'chains_to'),
        });
      }
    }
  };
  walk(path.join(PLUGIN, '100-skills'));
  return cache;
}

/**
 * 사용자 스킬 · 작업 폴더 brand/my-skills/{NNN}-{slug}/SKILL.md (규격 100-skills/SPEC.md §6).
 * 공식만 읽으면 092 로 만든 스킬의 계획이 「그런 스킬이 없습니다」로 막혔다 (2026-10-14).
 * id 101~199 · category 는 custom(적었다면) · 폴더는 {id}- 로 · writes_to 는 outputs/{날짜}/{id}-…/파일.
 * 하나라도 어기면 그 스킬은 쓰지 않고 경고만 낸다. gate 는 false 라고 적었을 때만 끈다.
 * 같은 규칙을 run-receipt · router · runtime-guard 가 가져다 쓴다.
 */
export function userSkills(cwd = process.cwd()) {
  const map = new Map();
  const warnings = [];
  const root = path.join(cwd, 'brand', 'my-skills');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); }
  catch { return { map, warnings }; }
  const official = officialDeclarations();
  for (const name of dirs) {
    const file = path.join(root, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const skip = why => warnings.push(`brand/my-skills/${name}/SKILL.md · ${why} · 이 스킬은 쓰지 않습니다`);
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const raw = frontmatterField(text, 'id');
    if (!/^\d{3}$/.test(raw)) { skip(`id 가 세 자리 번호가 아닙니다 (${raw || '없음'})`); continue; }
    if (official.has(raw)) { skip(`id ${raw} 가 공식 스킬 번호와 겹칩니다 · 101~199 를 씁니다`); continue; }
    if (!/^1(0[1-9]|[1-9]\d)$/.test(raw)) { skip(`id 는 101~199 여야 합니다 (${raw})`); continue; }
    if (map.has(raw)) { skip(`id ${raw} 를 다른 사용자 스킬이 이미 씁니다`); continue; }
    const category = frontmatterField(text, 'category');
    if (category && category !== 'custom') { skip(`category 는 custom 이어야 합니다 (${category})`); continue; }
    if (!name.startsWith(`${raw}-`)) { skip(`폴더 이름이 ${raw}- 로 시작하지 않습니다`); continue; }
    const writesTo = frontmatterList(text, 'writes_to');
    const files = writesTo.filter(v => v.startsWith('outputs/'));
    const shape = new RegExp(`^outputs/\\{날짜\\}/${raw}-[^/]+/[^/]+\\.[a-z0-9]+$`, 'i');
    if (!files.length || !files.every(v => shape.test(v))) { skip(`writes_to 는 outputs/{날짜}/${raw}-{slug}/파일 꼴이어야 합니다`); continue; }
    map.set(raw, {
      id: raw,
      dir: path.dirname(file),
      path: file,
      user: true,
      name: frontmatterField(text, 'name'),
      gate: frontmatterField(text, 'gate').toLowerCase() !== 'false',   // 없으면 true (SPEC §6)
      pii: frontmatterFlag(text, 'pii'),
      mutating: frontmatterFlag(text, 'mutating'),
      review: frontmatterField(text, 'review').split(/[·,]/).map(v => v.trim()).filter(Boolean),
      writesTo,
      chainsTo: frontmatterList(text, 'chains_to'),
    });
  }
  return { map, warnings };
}

/** 공식 100개 + 작업 폴더의 사용자 스킬 */
export function skillDeclarations(cwd = process.cwd()) {
  const official = officialDeclarations();
  const { map } = userSkills(cwd);
  return map.size ? new Map([...official, ...map]) : official;
}

/**
 * 스킬별 보완 · brand/skill-notes/{번호}.md (brand-templates/skill-notes.md).
 * 「형식: docx」·「양식 원본: inputs/양식/…」 줄만 기계가 읽는다 · 없으면 그 칸은 비운다.
 */
export function skillNotes(cwd, id) {
  if (!cwd || !id) return null;
  const rel = `brand/skill-notes/${id}.md`;
  let text;
  try { text = fs.readFileSync(path.join(cwd, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
  const line = key => ((text.match(new RegExp(`^[ \\t>*-]*${key}[ \\t]*(?:[:：][ \\t]*|[ \\t]+)([^\\n]+)$`, 'm')) || [])[1] || '')
    .replace(/\s+#(?=\s|$).*$/, '').replace(/[`*]/g, '').trim();
  const 형식 = (line('형식').match(/^\.?([a-z]+)/i) || [])[1]?.toLowerCase() || '';
  // 「정한 날」 줄 · 회사 양식에서 고칠 점을 승인받아 남긴 날 · 없으면 compile 이 할 일 줄을 낸다
  return { rel, 형식, 양식원본: line('양식 원본'), 정한날: /^[ \t>*|-]*정한 날/m.test(text) };
}
const notesOfPlan = (plan, cwd) => (plan.steps || [])
  .map(st => String(st.skill || '').match(/\d{3}/)?.[0]).filter(Boolean).some(id => skillNotes(cwd, id));
const 양식입력 = v => /^(workspace:)?inputs\/양식\//.test(String(v?.path ?? v));

/**
 * 보완 파일에 형식이 있고 계획에 형식이 비었으면 그 형식으로 채운다 · 단계의 대표 파일({id}-{slug}.확장자) 하나의 그릇만 바꾼다.
 * 이미 그 그릇을 내는 스킬이면 그대로 둔다. 바꾼 대표 파일은 계획 산출물의 확장자도 함께 바꾼다. 알린 문장을 돌려준다.
 */
export function notesFormat(plan, cwd) {
  const said = [];
  if (plan.형식 && Object.keys(plan.형식).length) return said;
  const decl = skillDeclarations(cwd);
  const choice = {};
  for (const step of plan.steps || []) {
    const id = String(step.skill || '').match(/\d{3}/)?.[0];
    const note = id && skillNotes(cwd, id);
    const d = id && decl.get(id);
    if (!note?.형식 || !d) continue;
    if (!그릇.has(note.형식)) { said.push(`🟡 ${note.rel} 의 형식 「${note.형식}」은 모르는 그릇이라 무시합니다 · ${[...그릇].join(' · ')} 중에서 고릅니다`); continue; }
    const 계약 = [...new Set(d.writesTo.map(v => path.posix.basename(v)).filter(b => b.includes('.')))];
    const folder = (d.writesTo.find(v => v.startsWith('outputs/')) || '').split('/')[2] || '';
    if (계약.includes(`${folder}.${note.형식}`)) continue;   // 이미 그 그릇으로 낸다
    // 표 그릇(csv·xlsx)은 표 파일을, 나머지는 문서 파일(.md 먼저)을 바꾼다 · 해설 같은 딸린 파일은 건드리지 않는다
    const 표 = v => /\.(xlsx|csv)$/.test(v);
    const 후보 = 계약.filter(v => v.replace(/\.[^.]+$/, '') === folder && 표(v) === 표(`.${note.형식}`));
    const 대표 = 후보.find(v => v.endsWith('.md')) || 후보[0];
    if (!대표) continue;
    try { applyFormatChoice(계약, { [대표]: note.형식 }); }
    catch (error) { said.push(`🟡 ${note.rel} 의 형식을 쓰지 못했습니다 · ${error.message}`); continue; }
    choice[대표] = note.형식;
    const stem = 대표.replace(/\.[^.]+$/, '');
    const ext = 대표.slice(stem.length);
    step.outputs = (step.outputs || []).map(o => {
      const v = String(o);
      const base = path.posix.basename(v);
      const m = base.match(/^(.*?)(-\d+)?(\.[a-z0-9]+)$/i);
      return m && m[1] === stem && m[3] === ext ? `${v.slice(0, -base.length)}${m[1]}${m[2] || ''}.${note.형식}` : o;
    });
    said.push(`📎 우리 양식 ${note.rel} · 형식을 ${으로(note.형식)} 채웠다 · ${대표} → ${stem}.${note.형식}`);
  }
  if (Object.keys(choice).length) plan.형식 = choice;
  return said;
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

export function validatePlan(plan, { cwd = process.cwd() } = {}) {
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

  const decl = skillDeclarations(cwd);
  const stepSkills = steps.map(s => String(s.skill || '').trim());
  if (skills.join(',') !== stepSkills.join(','))
    issues.push(`skills 와 steps 의 순서가 다릅니다: ${skills.join('→')} ≠ ${stepSkills.join('→')}`);

  const producedSoFar = new Set();
  const 전체계약 = new Set();
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
    for (const b of 계약) 전체계약.add(b);
    try { allowed = applyFormatChoice(계약, scopeFormatChoice(계약, planFormat)); }
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
      // 앞 단계 산출물만 본다 · inputs·brand 의 사용자 원본은 어느 단계에서든 넣을 수 있다
      // (실측 2026-09-22 · 작동 검토 #5 — 043 의 필수 입력인 레퍼런스 이미지를 체인 뒤 단계에서 못 넣었다)
      const fromWorkspace = (step.inputs || []).filter(v => String(v).startsWith('workspace:outputs/'));
      for (const ref of fromWorkspace) {
        if (!producedSoFar.has(String(ref)))
          issues.push(`${at} · 앞 단계가 만들지 않은 작업 폴더 입력입니다: ${ref}`);
      }
    }
    for (const ref of step.outputs || []) producedSoFar.add(String(ref));
  }
  // 단계마다는 제 파일만 바꾸므로, 어느 단계에도 없는 이름은 계획 전체에서 한 번 잡는다
  for (const 정본 of Object.keys(planFormat || {}))
    if (!전체계약.has(정본)) issues.push(`그릇을 바꿀 정본이 이 계획의 어느 단계 계약에 없습니다: ${정본}`);

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

/**
 * 앞선 실행의 산출물을 입력으로 쓰면 같은 날 다시 돌린 가장 늦은 순번(-2·-3)으로 바꾼다.
 * 실측 2026-09-15 코워크 · 006 을 3번 돌려 `-3` 까지 생겼다. 그런데 011 계획은 첫 파일을 읽는다고 적었다.
 * 이 계획 안에서 만드는 산출물은 건드리지 않는다. 바꾼 것은 [원래, 바뀐] 쌍으로 돌려준다.
 */
export function preferLatestReruns(plan, { cwd = process.cwd() } = {}) {
  const changed = [];
  const produced = new Set((plan.steps || []).flatMap(s => (s.outputs || []).map(String)));
  for (const step of plan.steps || []) {
    step.inputs = (step.inputs || []).map(ref => {
      const value = String(ref);
      if (!value.startsWith('workspace:outputs/') || produced.has(value)) return ref;
      const rel = value.slice('workspace:'.length);
      const m = path.posix.basename(rel).match(/^(.*?)(?:-(\d{1,2}))?(\.[a-z0-9]+)$/i);
      if (!m) return ref;
      const dir = path.resolve(cwd, path.posix.dirname(rel));
      if (!fs.existsSync(dir)) return ref;
      let best = Number(m[2] || 1);
      let bestName = null;
      for (const name of fs.readdirSync(dir)) {
        const hit = name.match(/^(.*)-(\d{1,2})(\.[a-z0-9]+)$/i);
        if (hit && hit[1] === m[1] && hit[3] === m[3] && Number(hit[2]) > best) { best = Number(hit[2]); bestName = name; }
      }
      if (!bestName) return ref;
      const next = `workspace:${path.posix.join(path.posix.dirname(rel), bestName)}`;
      changed.push([value, next]);
      return next;
    });
  }
  return changed;
}

/* ── 같은 날 다시 돌리기 · 순번 하나 (2026-10-14 · 회사 B S7) ──────────────────────
 * 같은 날 006 을 실데이터로 돌린 뒤 「샘플로 실습」을 돌리자 앞 실행의 plan.json 이 샘플 계획으로 덮였다.
 * 계획은 006-review-mining-2/ 폴더에, 산출물은 006-review-mining/ 에 생겼고 빈 폴더가 남았다.
 * 규칙은 하나다 · 폴더는 그대로(outputs/{날짜}/{번호}-{슬러그}/ · 체인은 outputs/{YYYY-MM}-{체인}/) ·
 * N번째 실행은 계획 plan-N.json · 영수증 run-N.json · 산출물 {정본 이름}-N.{확장자}(006-review-mining-해설-2.md) ·
 * 첫 실행은 순번 없이 plan.json · run.json · 정본 이름. 앞 실행의 plan·run 은 덮지 않는다.
 * plan-compiler · run-receipt · runtime-guard 가 이 함수들을 같이 쓴다.
 */
export const slotName = (kind, n) => (n > 1 ? `${kind}-${n}.json` : `${kind}.json`);
/** plan.json → 1 · plan-3.json → 3 · run-2.json → 2 · 아니면 null */
export const slotOf = name => { const m = path.basename(String(name)).match(/^(?:plan|run)(?:-(\d+))?\.json$/); return m ? Number(m[1] || 1) : null; };
/** 정본 이름에 순번을 붙인다 · 이미 순번이 붙은 이름은 정본으로 되돌린 뒤 붙인다 · 계약 이름이 숫자로 끝나도(051-detail-page-24) 안 깨진다 */
export function slotOutput(base, n, contract = []) {
  const m = base.match(/^(.*)-(\d+)(\.[a-z0-9]+)$/i);
  const canon = contract.includes(base) || !m || !contract.includes(m[1] + m[3]) ? base : m[1] + m[3];
  return n > 1 ? canon.replace(/(\.[a-z0-9]+)$/i, `-${n}$1`) : canon;
}
/** 그 자리(순번)의 영수증이 이미 시작됐으면 그 영수증 · 아니면 null */
export function sealedRun(folder, n) {
  try { const run = JSON.parse(fs.readFileSync(path.join(folder, slotName('run', n)), 'utf8')); return run?.run_id ? run : null; }
  catch { return null; }
}
/** 그 폴더의 다음 빈 순번 · plan-N·run-N 이 하나라도 있는 순번은 찬 것이다 */
export function nextSlot(folder) {
  let max = 0;
  try { for (const n of fs.readdirSync(folder)) { const k = slotOf(n); if (k && k > max) max = k; } } catch { /* 없는 폴더 */ }
  return max + 1;
}
/** 단계 산출물의 계약 이름 · 고른 그릇을 반영한다 */
function stepContract(step, choice, cwd) {
  const d = skillDeclarations(cwd).get(String(step.skill || '').trim());
  const 계약 = [...new Set((d?.writesTo || []).map(v => path.posix.basename(v)).filter(b => b.includes('.')))];
  try { return applyFormatChoice(계약, scopeFormatChoice(계약, choice)); } catch { return 계약; }
}
/** 「형식」 칸에 순번 붙은 이름을 적었으면 정본 이름으로 (실측 2026-10-14 · 회사 B 「006-review-mining-2.xlsx」) */
function canonFormatKeys(plan, cwd) {
  if (!plan.형식 || typeof plan.형식 !== 'object') return;
  const all = new Set((plan.steps || []).flatMap(st => {
    const d = skillDeclarations(cwd).get(String(st.skill || '').trim());
    return (d?.writesTo || []).map(v => path.posix.basename(v));
  }));
  const out = {};
  for (const [k, v] of Object.entries(plan.형식)) {
    const m = path.posix.basename(k).match(/^(.*)-(\d+)(\.[a-z0-9]+)$/i);
    const key = all.has(path.posix.basename(k)) || !m || !all.has(m[1] + m[3]) ? k : m[1] + m[3];
    out[key] = v;
  }
  plan.형식 = out;
}

/**
 * compile·approve 전에 계획을 바른 자리에 둔다 · 돌려주는 것 { file, said[], block } ·
 *   체인 · plan.json 이 outputs/{YYYY-MM}-{체인}/ 이 아니면 그리로 옮기고 산출물을 {체인 폴더}/{스킬 폴더}/ 로 고친다 ·
 *         바른 폴더에 이미 다른 plan.json 이 있으면 덮지 않고 막는다 (실측 2026-10-14 · 10장 팀 이름 폴더가 두 번 연속 남았다)
 *   스킬 하나 · plan 이 그 스킬 번호로 시작하는 다른 폴더(006-review-mining-2/ 등)에 있으면 outputs/{날짜}/{스킬 폴더}/ 의 다음 순번 자리로 옮긴다
 *   그 자리의 영수증이 이미 시작됐으면(앞 실행의 계획이면) 막고 새 자리를 알려 준다 · 덮으면 앞 실행의 근거가 사라진다
 *   계획 순번과 산출물 순번이 다르면 계획 순번으로 맞춘다 (plan-2.json → …-2.xlsx)
 * 옮기고 나서 비게 된 옛 폴더는 지운다 · 다른 파일이 있으면 그대로 둔다.
 */
const 실경로 = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** child 가 parent 안(같은 자리 포함)인가 · 없는 경로는 있는 윗자리까지 실경로로 맞춰 잰다 (/tmp ↔ /private/tmp) */
export function isInside(child, parent) {
  const realish = p => {
    let d = path.resolve(p);
    const rest = [];
    while (!fs.existsSync(d) && path.dirname(d) !== d) { rest.unshift(path.basename(d)); d = path.dirname(d); }
    return path.join(실경로(d), ...rest);
  };
  const rel = path.relative(realish(parent), realish(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 작업 폴더 · 계획 파일 경로에서 찾는다 · 셸의 현재 폴더는 믿지 않는다.
 * 실측 2026-10-14 · 책 실습 11장 · 모델이 `cd {플러그인}/100-skills && head …` 를 돌린 뒤 바른 자리의 plan.json 을
 * 절대 경로로 compile 했다 · cwd 기준으로 재자 계획이 플러그인 안 100-skills/outputs/ 로 옮겨지고 원본이 지워졌다.
 * 찾는 순서 · ① 계획 위로 올라가며 가장 가까운 outputs/ 의 부모 ② outputs/ 를 품은 윗폴더 ③ CLAUDE_PROJECT_DIR ④ 셸 cwd
 * 플러그인 폴더 안은 작업 폴더가 아니다 · 못 찾으면 null.
 */
export function workspaceOf(file, { env = process.env, cwd = process.cwd() } = {}) {
  const 밖 = d => d && !isInside(d, PLUGIN);
  const start = path.dirname(path.resolve(cwd, file));
  // 플러그인 안의 계획은 위로 올라가 바깥 폴더를 작업 폴더로 삼지 않는다
  if (밖(start)) {
    for (let d = start; ; d = path.dirname(d)) {
      if (path.basename(d) === 'outputs' && 밖(path.dirname(d))) return path.dirname(d);
      if (path.dirname(d) === d) break;
    }
    for (let d = start; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'outputs'))) return d;
      if (path.dirname(d) === d) break;
    }
  }
  for (const d of [env.CLAUDE_PROJECT_DIR, cwd]) if (d && 밖(path.resolve(d))) return path.resolve(d);
  return null;
}

export function placePlan(file, plan, { cwd = process.cwd(), chain = plan.chain } = {}) {
  const said = [];
  // 옮길 자리·지울 자리가 모두 작업 폴더 안이어야 한다 · 플러그인 안에는 쓰지 않는다 (실측 2026-10-14 · 11장)
  const 안전 = abs => isInside(abs, cwd) && !isInside(abs, PLUGIN);
  const 밖막음 = (what) => ({ file, said, block: [`${what} · 계획 ${file} · 작업 폴더 ${cwd} · 아무것도 옮기거나 지우지 않았습니다`,
    '계획을 작업 폴더의 outputs/ 아래에 두고 다시 compile 하세요 · 플러그인 폴더 안에는 쓰지 않습니다'] });
  const relOf = abs => path.relative(cwd, abs).split(path.sep).join('/');
  const here = relOf(path.dirname(file));
  const steps = plan.steps || [];
  const choice = (() => { try { return normalizeFormatChoice(plan.형식, '계획의'); } catch { return null; } })();
  const folderOf = st => (skillDeclarations(cwd).get(String(st.skill || '').trim())?.writesTo || []).find(v => v.startsWith('outputs/'))?.split('/')[2] || '';
  const d0 = new Date();
  const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  const outRels = steps.flatMap(st => st.outputs || []).map(v => String(v?.path ?? v).replace(/^workspace:/, ''));
  let right;
  if (chain) {
    const month = (here.match(/^outputs\/(\d{4}-\d{2})/) || [])[1] || outRels.map(v => (v.match(/^outputs\/(\d{4}-\d{2})/) || [])[1]).find(Boolean) || today.slice(0, 7);
    right = `outputs/${month}-${chain}`;
  } else if (steps.length === 1 && folderOf(steps[0])) {
    // 그 스킬 번호로 시작하는 폴더(006-review-mining-2/ 등)만 바로잡는다 · 다른 이름 폴더는 영수증 start 가 막는다
    const id = String(steps[0].skill || '').trim();
    if (!path.posix.basename(here).startsWith(`${id}-`)) return { file, said };
    const day = [path.posix.basename(path.posix.dirname(here)), ...outRels.map(v => v.split('/')[1])].find(v => /^\d{4}-\d{2}-\d{2}$/.test(v || '')) || today;
    right = `outputs/${day}/${folderOf(steps[0])}`;
  } else return { file, said };

  const rightAbs = path.join(cwd, right);
  let target = file;
  let n = slotOf(file) || 1;
  if (here !== right) {
    if (!안전(file)) return 밖막음('계획 파일이 작업 폴더 밖(또는 플러그인 안)에 있습니다');
    if (!안전(rightAbs)) return 밖막음(`옮길 자리 ${right}/ 가 작업 폴더 밖(또는 플러그인 안)입니다`);
    if (chain) {
      if (fs.existsSync(path.join(rightAbs, 'plan.json')))
        return { file, said, block: [`체인 「${chain}」의 결과는 ${right}/ 아래에 둡니다 · 그 폴더에 이미 다른 plan.json 이 있어 옮기지 않았습니다 · ${here}/`,
          `체인 폴더 이름이 다릅니다 · plan.json 과 outputs 를 outputs/{YYYY-MM}-${chain}/ 아래로 옮겨 다시 compile 하세요`] };
      n = 1;
    } else n = nextSlot(rightAbs);
    target = path.join(rightAbs, slotName('plan', n));
  } else {
    const run = sealedRun(rightAbs, n);
    if (run && run.plan?.plan_sha256 && run.plan.plan_sha256 === planHash(plan) && plan.status === 'approved') return { file, said, sealed: run };
    if (run) {
      const m = nextSlot(rightAbs);
      const ex = steps.flatMap(st => stepContract(st, choice, cwd)).map(b => slotOutput(b, m)).join(' · ');
      return { file, said, block: [`${relOf(file)} 은 이미 돈 실행(${slotName('run', n)} · ${run.run_id})의 계획입니다 · 앞 실행의 계획과 영수증은 덮지 않습니다`,
        `같은 날 다시 돌리면 같은 폴더에 새 순번으로 씁니다 · 계획 ${right}/${slotName('plan', m)} · 영수증 ${slotName('run', m)} · 산출물 ${ex}`] };
    }
  }
  // 산출물 · 바른 폴더 아래 스킬 자리(하위 자리 {NNN}-{slug}/ 는 그대로) · 순번은 계획 순번으로 (첫 실행이면 이름은 그대로)
  const norm = v => String(v?.path ?? v).replace(/^(?!workspace:)/, 'workspace:');
  const place = (st, v) => {
    const rel = norm(v).slice('workspace:'.length);
    const folder = folderOf(st);
    const at = rel.split('/').indexOf(folder);
    const rest = at >= 0 ? rel.split('/').slice(at + 1) : [path.posix.basename(rel)];
    if (n > 1) rest[rest.length - 1] = slotOutput(rest[rest.length - 1], n, stepContract(st, choice, cwd));
    const want = chain ? `workspace:${right}/${folder}/${rest.join('/')}` : `workspace:${right}/${rest.join('/')}`;
    return want === norm(v) ? v : want;
  };
  const map = new Map();
  for (const st of steps) {
    st.outputs = (st.outputs || []).map(v => { const next = place(st, v); if (next !== v) map.set(norm(v), next); return next; });
  }
  const oldPrefix = here !== right ? `workspace:${here}/` : null;
  const fix = v => {
    const s0 = norm(v);
    if (map.has(s0)) return map.get(s0);
    if (oldPrefix && s0.startsWith(oldPrefix)) return `workspace:${right}/${s0.slice(oldPrefix.length)}`;
    return v;
  };
  for (const st of steps) st.inputs = (st.inputs || []).map(v => (String(v?.path ?? v).startsWith('plugin:') ? v : fix(v)));
  canonFormatKeys(plan, cwd);
  if (target !== file) {
    fs.mkdirSync(rightAbs, { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`);
    fs.rmSync(file, { force: true });
    try { if (!fs.readdirSync(path.dirname(file)).length) fs.rmdirSync(path.dirname(file)); } catch { /* 남은 파일이 있으면 그대로 */ }
    said.push(chain
      ? `📁 체인 폴더로 옮겼다 · ${relOf(file)} → ${relOf(target)} · 산출물도 ${right}/ 아래로 고쳤다`
      : `📁 스킬 폴더로 옮겼다 · ${relOf(file)} → ${relOf(target)}${n > 1 ? ` · 같은 날 ${n}번째 실행 · 산출물 이름 끝에 -${n} · 영수증 ${slotName('run', n)}` : ''}`);
  } else if (map.size) {
    said.push(`↻ 산출물 자리를 계획에 맞췄다 · ${[...map].map(([a, b2]) => `${a.replace(/^workspace:/, '')} → ${b2.replace(/^workspace:/, '')}`).join(' · ')}`);
  }
  return { file: target, said };
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

/** 계획 전체의 형식 변경에서 이 단계 파일에 해당하는 것만 남긴다 (작동 검토 2026-09-22 #6) */
export function scopeFormatChoice(expected, choice) {
  if (!choice) return null;
  const kept = Object.fromEntries(Object.entries(choice).filter(([정본]) => expected.includes(정본)));
  return Object.keys(kept).length ? kept : null;
}

export function applyFormatChoice(expected, choice) {
  if (!choice) return expected;
  const out = [...expected];
  for (const [정본, 새] of Object.entries(choice)) {
    const i = out.indexOf(정본);
    if (i === -1)
      throw new Error(`그릇을 바꿀 정본이 계약에 없습니다: ${정본} · 계약은 ${expected.join(' · ')} 입니다.`);
    const 바뀐 = 정본.replace(/\.[^.]+$/, `.${새}`);
    if (바뀐 !== 정본 && out.includes(바뀐)) {
      // 문서 스킬이 없어 .docx·.pptx 를 .md 로 낼 때 같은 이름 .md 가 이미 있으면 그 한 파일에 합친다
      // (실측 2026-09-22 · 작동 검토 #7 — 084 가 이름 충돌로 대체 경로를 못 탔다). 다른 그릇끼리는 여전히 막는다
      if (새 === 'md') { out.splice(i, 1); continue; }
      throw new Error(`그릇을 바꾸면 다른 정본과 이름이 겹칩니다: ${바뀐}`);
    }
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

/* ── 계획 화면 · 같은 조건이면 같은 글자 (2026-09-15) ─────────────
 * 원고의 실습 화면과 코워크 화면이 100% 같아야 한다. 모델이 화면을 지으면 실행마다 칸 이름·순서·
 * 문장이 흔들렸다(실측 2026-09-14 코워크 · 「근거로 쓰는 것 / 멈추는 곳 없음 / (재실행)」).
 * 그래서 화면은 스크립트가 찍고 모델은 그대로 옮긴다. 스킬마다 다른 말만 틀(```틀 블록)에 두고
 * 나머지는 계획과 스킬 선언에서 기계로 채운다. 틀이 없는 스킬은 화면을 찍지 않는다(null).
 */
const FORMAT_LABEL = [
  [/-해설\.md$/, '해설 .md'], [/\.xlsx$/, '표 .xlsx'], [/\.csv$/, '표 .csv'], [/\.html$/, '화면 .html'],
  [/\.docx$/, '문서 .docx'], [/\.pptx$/, '발표 자료 .pptx'], [/\.pdf$/, '문서 .pdf'], [/\.md$/, '문서 .md'], [/\.jsonl$/, '평가 파일 .jsonl'],
];
const formatLabel = base => (FORMAT_LABEL.find(([re]) => re.test(base)) || [null, base])[1];
/** 받침이 있으면 「으로」, 없거나 ㄹ 받침이면 「로」 */
const 으로 = word => {
  const code = String(word).trim().slice(-1).charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${word}로`;
  const 받침 = code % 28;
  return `${word}${받침 === 0 || 받침 === 8 ? '로' : '으로'}`;
};

/** ```틀 블록을 읽는다. 「키: 값」 한 줄씩, 「우리 자료로 하려면:」 아래 「- 」 줄은 목록이다. */
export function parseScreenTemplate(text) {
  const block = (String(text).replace(/\r\n/g, '\n').match(/^```틀\n([\s\S]*?)^```$/m) || [])[1];
  if (!block) return null;
  const tpl = { 목록: {} };
  let listKey = null;
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^-\s+(.*)$/);
    if (item && listKey) { tpl.목록[listKey].push(item[1].trim()); continue; }
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    if (kv[2].trim() === '') { listKey = key; tpl.목록[key] = []; continue; }
    listKey = null;
    tpl[key] = kv[2].trim();
  }
  return tpl;
}

export function skillScreenTemplate(id, cwd = process.cwd()) {
  const found = skillDeclarations(cwd).get(String(id));
  if (!found) return null;
  const file = path.join(found.dir, 'example', 'plan-screen.md');
  return fs.existsSync(file) ? parseScreenTemplate(fs.readFileSync(file, 'utf8')) : null;
}

export function chainScreenTemplate(name) {
  if (!name) return null;
  const root = path.join(PLUGIN, '100-skills');
  const files = [path.join(root, 'CHAINS.md'),
    ...fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d\d-/.test(e.name))
      .map(e => path.join(root, e.name, 'PLUGIN.md'))];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const m of text.matchAll(/^```틀\n([\s\S]*?)^```$/gm)) {
      const tpl = parseScreenTemplate(`\`\`\`틀\n${m[1]}\`\`\``);
      if (tpl && tpl.체인 === name) return tpl;
    }
  }
  return null;
}

/* ── 브랜드 프로필 상태 · 「빈」 또는 「채움」 (2026-10-14) ─────────────
 * 예전에는 템플릿과 글자째 같을 때만 빈 것으로 봐서 0바이트 파일이나 템플릿 뒤에 주석 한 줄 붙인 파일이
 * 「채움」이 됐다 (검토 2026-10-14 · 재현). 이제는 우리 회사 정보가 한 줄이라도 있는지를 본다.
 * 빼는 것 · 빈 줄 · HTML 주석 · 안내 인용(> 줄) · 코드 울타리 · 구분선 · 받은 템플릿(지금 판 · §8 없는 옛 판)의 줄 ·
 * 자리표시((예: …) · {…} · 칸 전체가 괄호 · ①②③) · 값이 빈 표 행과 「항목:」 줄 · 상태 체크 줄.
 * 남는 줄이 하나라도 있으면 「채움」이다. 「채움」은 「이번 업무에 충분하다」는 뜻이 아니다 (docs/공통규약.md §0-b).
 */
const 줄정리 = line => String(line).replace(/\s+/g, ' ').trim();
const 글자있음 = v => /[가-힣A-Za-z0-9]/.test(v);
/** 값 칸의 자리표시를 뗀다 · 남은 것이 없으면 '' */
const 자리표시뗌 = v => {
  let s = String(v).replace(/`/g, '').replace(/\*\*/g, '').replace(/⭐/g, '')
    .replace(/\((?:예|e\.g\.)\s*[:：)][^)]*\)?/gi, '').replace(/\{[^{}]*\}/g, '').replace(/[①-⑩]/g, '').trim();
  if (/^\([^()]*\)$/.test(s)) s = '';
  return 글자있음(s) ? s : '';
};
const 표칸 = t => t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const 열쇠 = v => 줄정리(String(v).replace(/\*\*|⭐|`/g, '')).replace(/^[-*]\s*/, '');
let 틀캐시 = null;
function 프로필틀() {
  const file = path.join(PLUGIN, 'brand-templates', 'profile.md');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { /* 없으면 줄 대조 없이 자리표시만 본다 */ }
  if (틀캐시?.text === text) return 틀캐시;
  const lines = new Set(), labels = new Set(), keys = new Set();
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const t = 줄정리(raw);
    if (!t) continue;
    lines.add(t);
    if (t.startsWith('|')) labels.add(열쇠(표칸(t)[0] || ''));
    const kv = t.match(/^[-*]?\s*([^:：|]+)[:：]/);
    if (kv) keys.add(열쇠(kv[1]));
  }
  틀캐시 = { text, lines, labels, keys };
  return 틀캐시;
}

/** 프로필에서 우리 정보가 든 줄 · { section, label, value, line } · 표 행은 label·value, 「항목: 값」 줄도 같다 */
export function profileRows(cwd) {
  const file = path.join(cwd || '', 'brand', 'profile.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
  const tpl = 프로필틀();
  const rows = [];
  let section = '';
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const t = 줄정리(raw);
    const h = t.match(/^#{1,6}\s*(\d+)\./);
    if (h) section = h[1];
    if (!t || t.startsWith('>') || /^(```|~~~)/.test(t) || /^[-*_]{3,}$/.test(t)) continue;
    if (/^\|[\s:|-]+\|?$/.test(t)) continue;   // 표 머리 구분선
    if (tpl.lines.has(t)) continue;
    if (/^[-*]\s*\[[ xX]\]/.test(t) || /^[-*]?\s*최종 갱신/.test(t)) continue;   // 상태 칸
    if (t.startsWith('|')) {
      const cells = 표칸(t);
      const label = 열쇠(cells[0] || '');
      const values = cells.slice(1).map(자리표시뗌).filter(Boolean);
      if (tpl.labels.has(label)) { if (values.length) rows.push({ section, label, value: values.join(' · '), line: t }); continue; }
      const own = 자리표시뗌(label);
      if (own || values.length) rows.push({ section, label: own, value: values.join(' · '), line: t });
      continue;
    }
    const kv = t.match(/^[-*]?\s*([^:：|]+)[:：]\s*(.*)$/);
    if (kv && tpl.keys.has(열쇠(kv[1]))) {
      const value = 자리표시뗌(kv[2]);
      if (value) rows.push({ section, label: 열쇠(kv[1]), value, line: t });
      continue;
    }
    // 「항목: 값」 꼴은 값이 있어야 우리 정보다 (「- 업종: {업종}」 같은 자리표시 줄)
    if (kv) { const value = 자리표시뗌(kv[2]); if (value) rows.push({ section, label: 열쇠(kv[1]), value, line: t }); continue; }
    if (자리표시뗌(t.replace(/^#{1,6}\s*/, ''))) rows.push({ section, label: '', value: 자리표시뗌(t), line: t });
  }
  return rows;
}

/** 프로필 상태 · 'empty' 가 아니라 화면·문서와 같은 말 「빈」·「채움」을 돌려준다 */
export function profileState(cwd) {
  const rows = profileRows(cwd);
  return rows && rows.length ? '채움' : '빈';
}

/** 예전 이름 · 책 실습·대본 판단이 그대로 쓴다 */
export function profileIsEmpty(cwd) {
  return profileState(cwd) === '빈';
}

const 광고채널 = /광고|\bads?\b|메타|페이스북|facebook|구글|google|네이버\s*(?:검색|쇼핑)|파워링크|GFA|모먼트|틱톡|tiktok|애드|ROAS|CPA|CPC/i;
/** 화면과 compile 안내 줄이 읽는 칸 몇 개 · 프로필이 「빈」이면 전부 비어 있다 */
export function profileFacts(cwd) {
  const rows = profileRows(cwd) || [];
  const pick = (re, section) => rows.find(r => (!section || r.section === section) && re.test(r.label) && r.value)?.value || '';
  const 채널 = rows.filter(r => r.section === '5' && r.label && !/중단/.test(r.value)).map(r => `${r.label} ${r.value}`);
  return {
    state: rows.length ? '채움' : '빈',
    업종: pick(/^업종/),
    브랜드명: pick(/^브랜드명/),
    핵심제품: pick(/^핵심 제품/),
    마진율: pick(/^마진율/, '4'),
    숫자: rows.some(r => r.section === '4' && r.value),
    채널,
    광고채널없음: 채널.length > 0 && !채널.some(c => 광고채널.test(c)),
    역할: pick(/^내 역할/, '8'),
    보고: pick(/^결과물을 보고받는 사람/, '8'),
  };
}

/**
 * 「함께 알려주면 좋은 것」에서 프로필이 이미 답한 줄 · 틀 파일은 그대로 두고 찍을 때만 뺀다.
 * 프로필이 「빈」이면 아무것도 빼지 않는다 · 원고 화면과 글자까지 같다.
 * 줄 앞 이름(「업종:」 등)으로 고른다 · 스킬 번호로 고르지 않아 새 틀에도 같은 규칙이 간다.
 */
const 이미답함 = [
  [/^업종$/, f => Boolean(f.업종)],
  [/^월 목표$/, f => f.숫자 || f.광고채널없음],
  [/^브랜드명과 제품명$/, f => Boolean(f.브랜드명 && f.핵심제품)],
  [/^마진율$/, f => Boolean(f.마진율)],
];
export function askAnswered(item, facts) {
  if (!facts || facts.state !== '채움') return false;
  const label = (String(item).match(/^([^:：]+)[:：]/) || [])[1]?.trim() || '';
  return 이미답함.some(([re, ok]) => re.test(label) && ok(facts));
}

/** 스킬의 sample_fallback · { file, orphan } · 없으면 null · 「고아 필드」라고 적힌 것은 스킬이 읽지 않는 파일이다 (043) */
export function skillSampleFallback(d) {
  if (!d?.dir) return null;
  let text = '';
  try { text = fs.readFileSync(path.join(d.dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
  const raw = (frontmatterOf(text).match(/^sample_fallback:[ \t]*(.*)$/m) || [])[1];
  if (!raw) return null;
  const file = clean(raw).split(/\s+/)[0];
  return file ? { file, orphan: /고아/.test(raw) } : null;
}

/** 스킬 inputs 에서 자료를 가리키는 칸 하나 · 괄호 안 설명은 뗀다 (괄호 안 쉼표로 쪼개지 않는다)
 *  고르는 순서 · (선택) 이 아닌 칸 중 자료 낱말이 든 첫 칸 → (선택) 이 아닌 첫 칸 → 첫 칸 */
const 자료말 = /데이터|자료|리포트|보고서|리뷰|댓글|CSV|XLSX|엑셀|시트|이력|기록|로그|내보내기|녹취|메모|스냅샷|원가|VoC|문의/i;
/** 스킬 inputs 칸을 하나씩 · { raw, name } · raw 는 괄호 설명까지, name 은 괄호를 뗀 이름 · brand/ 칸은 뺀다 */
function inputItems(d) {
  if (!d?.dir) return [];
  let text = '';
  try { text = fs.readFileSync(path.join(d.dir, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n'); } catch { return []; }
  let value = frontmatterField(text, 'inputs');
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const items = [];
  let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(' || ch === '（') depth += 1;
    if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  const tidy = v => 줄정리(v.replace(/\([^()]*\)|（[^（）]*）/g, '').replace(/[`*]/g, '').replace(/^있으면\s+/, ''));
  return items.map(raw => ({ raw, name: tidy(raw) })).filter(v => v.name && !/^brand\//.test(v.name));
}
export function skillDataNeed(d) {
  if (!d?.dir) return '';
  // 실행 기록을 읽는 스킬(091·097·098·100)은 inputs 가 아니라 logs/build-log.md 가 자료다
  if (/build-log/.test(skillSampleFallback(d)?.file || '')) return '실행 기록(logs/build-log.md)';
  const list = inputItems(d);
  const must = list.filter(v => !/선택/.test(v.raw));
  return (must.find(v => 자료말.test(v.raw)) || must[0] || list[0])?.name || '';
}

/* ── 이 스킬이 우리 자료를 읽어야 하나 · 무엇이 우리 자료인가 (2026-10-14 · v0.72.31 실측 회사 A·B) ──────
 * 회사 A 는 inputs/양식/ 의 회사 양식과 brand/ 만 있는데 067 계획이 「우리 자료가 없습니다」를 내지 않았고,
 * 회사 B 는 리뷰 csv 만 있는데 045(광고) 계획이 자료가 있다고 봤다. inputs/ 에 파일이 있느냐가 아니라
 * 그 스킬의 자료 칸에 맞는 파일이 있느냐를 본다. 확신이 없으면 없다고 본다 · 샘플을 넣지 않는 쪽이 안전하다.
 */

/**
 * 자료를 읽어야 하는 스킬인가 · 그 자료 칸 이름을 돌려준다 · 아니면 ''.
 *   sample_fallback 이 있고 고아가 아니면 · 자료 칸(skillDataNeed)에 자료 낱말(자료요구말)이 있을 때만
 *     (예: 006 「리뷰·댓글·CS 데이터」 · 045 「매체별 광고 데이터 소스」) · 실행 기록을 읽는 스킬은 그 기록
 *   sample_fallback 이 없으면 · (선택)·(…시) 가 아닌 칸이 파일을 요구할 때만 (데이터·CSV·엑셀·내보내기·견적서·녹취·이력)
 *     (예: 050 「현재 UTM 사용 현황(GA4 유입 내보내기 …)」 · 096 「견적서 2개 이상」)
 *   프로필만으로 만드는 생성 스킬(카피·상세페이지·이름 짓기 · 013·028·051 등)은 '' 다.
 */
const 파일요구말 = /데이터|CSV|XLSX|엑셀|내보내기|견적서|녹취|이력/i;
// 자료 칸을 볼 때 쓴다 · 자료말과 같되 「블로그」·「로그인」의 로그는 자료가 아니고, 광고 성과 칸(노출·클릭·광고비)은 자료다
const 자료요구말 = /데이터|자료|리포트|보고서|리뷰|댓글|CSV|XLSX|엑셀|시트|이력|기록|(?<!블)로그(?!인)|내보내기|녹취|메모|스냅샷|원가|VoC|문의|광고비/i;
export function skillNeedsData(d) {
  if (!d?.dir) return '';
  const fb = skillSampleFallback(d);
  if (fb?.orphan) return '';
  if (fb) {
    if (/build-log/.test(fb.file)) return skillDataNeed(d);
    const need = skillDataNeed(d);
    const item = inputItems(d).find(v => v.name === need);
    return item && 자료요구말.test(item.raw) ? need : '';
  }
  return inputItems(d).find(v => !/선택/.test(v.raw) && !/^\s*[(（]/.test(v.raw) && 파일요구말.test(v.raw))?.name || '';
}

// 자료 낱말 묶음 · 자료 칸에 한 낱말이 있으면 묶음 전체로 파일 이름을 본다 (영문은 낱말 경계로만 · 「ad」가 download 에 걸리지 않게)
const 자료묶음 = [
  ['리뷰', 'review', '후기', '상품평', '구매평', '별점'],
  ['댓글', 'comment', 'dm'],
  ['cs', '문의', 'voc', 'qna', '상담', '클레임', '고객의소리'],
  ['광고', 'ads', 'ad', '메타', 'meta', 'facebook', '페이스북', '구글', 'google', '네이버', 'naver', '쿠팡', 'coupang', '캠페인', 'campaign', '매체', 'roas', 'gfa', '파워링크'],
  ['매출', '판매', 'sales', '주문', 'order', 'orders', '구매', '결제', 'revenue'],
  ['고객', 'customer', 'customers', '회원', 'member', 'crm'],
  ['키워드', 'keyword', 'keywords', '검색어', '검색량'],
  ['성과', '지표', '인사이트', 'insight', 'insights', '통계', 'ga4', 'analytics', '유입', '트래픽', 'traffic'],
  ['설문', 'survey', 'nps', '응답'],
  ['콘텐츠', 'content', '게시물', '포스트', 'post', 'posts', '피드'],
  ['원가', 'cost', '마진', '단가'],
  ['경쟁', 'competitor', '경쟁사'],
  ['회의', '미팅', 'meeting', '녹취', '회의록'],
  ['유튜브', 'youtube', '영상'],
  ['인스타', 'instagram'],
  ['재고', 'inventory', 'stock'],
  ['퍼널', 'funnel', '전환'],
  ['견적', 'quote', 'estimate'],
];
const 빈말 = new Set(['데이터', '자료', '소스', '파일', '목록', '정보', '기간', '분석', '기본', '최근', '최대', '건수', '또는', '있으면', '선택',
  '권장', '산출물', '브랜드', 'a브랜드', 'csv', 'xlsx', '엑셀', '텍스트', '캡처', '시트', '구글시트', '로그인', '크롤링', '불가', '내보내서',
  '내보내기', 'inputs', '중', '이상', '모드', '필수', '연결', '탐색', '보고서', '리포트', '로우데이터', 'api', 'mcp', '통합']);
const 영문낱말 = w => /^[a-z0-9]+$/.test(w);
/** 그 스킬의 자료를 알아보는 낱말 · 자료 칸(자료 낱말이 든 필수 칸 전부)과 sample_fallback 파일 이름에서 뽑는다 */
export function skillDataWords(d) {
  const need = skillNeedsData(d) || skillDataNeed(d);
  const items = inputItems(d).filter(v => (!/선택/.test(v.raw) && 자료말.test(v.raw)) || v.name === need);
  const fb = path.posix.basename(skillSampleFallback(d)?.file || '').replace(/\.[^.]+$/, '');
  const tokens = [...items.map(v => v.name), fb].join(' ').toLowerCase().split(/[^0-9a-z가-힣]+/)
    .map(t => t.replace(/별$/, '')).filter(t => t.length >= 2 && !/^\d/.test(t) && !빈말.has(t));
  const words = new Set(tokens);
  for (const g of 자료묶음) if (tokens.some(t => g.some(w => (영문낱말(w) ? t === w : t.includes(w))))) for (const w of g) words.add(w);
  return [...words].filter(w => w.length >= 2);
}
const 낱말맞음 = (name, words) => {
  const s = String(name).toLowerCase();
  return words.some(w => (영문낱말(w) ? new RegExp(`(^|[^a-z])${w}s?([^a-z]|$)`).test(s) : s.includes(w)));
};

/** 프로필 §8 「자주 쓰는 회사 양식」에 적힌 파일 · 경로와 파일 이름 둘 다 */
function 회사양식(cwd) {
  const out = new Set();
  for (const r of profileRows(cwd) || []) {
    if (r.section !== '8' || !/회사 양식/.test(r.label)) continue;
    for (const f of String(r.line).match(/[^\s`'"·,()|]+\.[a-z0-9]{2,5}/gi) || []) { out.add(f.replace(/^workspace:/, '')); out.add(path.posix.basename(f)); }
  }
  return out;
}
// 참고로 넣은 것 · 레퍼런스 이미지 · 좋았던 글 · 예시 · 양식 (폴더 이름에 있어도 같다)
const 참고말 = /레퍼런스|참고|reference|좋았던|예시|example|샘플|sample|양식|template|템플릿/i;
const 그림 = /\.(png|jpe?g|webp|gif|heic)$/i;

/** 작업 폴더의 이 파일이 업무 자료가 아니라 회사 양식·참고 자료인가 · rel 은 작업 폴더 기준 */
export function referenceFile(cwd, rel) {
  const r = String(rel?.path ?? rel).replace(/^workspace:/, '').split(path.sep).join('/');
  if (/^brand(\/|$)/.test(r) || /^inputs\/양식(\/|$)/.test(r)) return true;
  const 양식 = 회사양식(cwd);
  if (양식.has(r) || 양식.has(path.posix.basename(r))) return true;
  return r.split('/').slice(r.startsWith('inputs/') ? 1 : 0).some(seg => 참고말.test(seg));
}

/** inputs/ 아래 이 스킬의 자료 칸에 맞는 파일 · 확장자와 이름 낱말로만 고른다 · 참고 자료는 세지 않는다 */
export function matchingInputs(cwd, d) {
  if (!cwd || !d) return [];
  const words = skillDataWords(d);
  if (!words.length) return [];
  const 그림됨 = inputItems(d).some(v => /캡처|스크린샷|이미지|사진/.test(v.raw));
  const out = [];
  const walk = (dir, rel, depth) => {
    let es = [];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 3) walk(path.join(dir, e.name), r, depth + 1); continue; }
      const full = `inputs/${r}`;
      if (referenceFile(cwd, full)) continue;
      if (!/\.(csv|tsv|xlsx|xls|json|txt|md|pdf|docx|hwp|hwpx)$/i.test(e.name) && !(그림됨 && 그림.test(e.name))) continue;
      if (낱말맞음(r, words)) out.push(full);
    }
  };
  walk(path.join(cwd, 'inputs'), '', 0);
  return out;
}

/** 그 폴더(와 위 폴더)의 영수증에서 이 산출물을 낸 실행의 data_mode · 못 찾으면 null */
export function outputDataMode(cwd, rel) {
  const r = String(rel?.path ?? rel).replace(/^workspace:/, '');
  if (!cwd || !r.startsWith('outputs/')) return null;
  const ref = `workspace:${r}`;
  for (const dir of [path.posix.dirname(r), path.posix.dirname(path.posix.dirname(r))]) {
    if (!dir.startsWith('outputs/')) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(cwd, dir)).filter(n => /^run(-\d+)?\.json$/.test(n)); } catch { continue; }
    for (const n of names) {
      try {
        const run = JSON.parse(fs.readFileSync(path.join(cwd, dir, n), 'utf8'));
        const outs = (run.outputs || []).map(o => String(o?.path ?? o).replace(/^(?!workspace:)/, 'workspace:'));
        if (outs.includes(ref) && run.data_mode) return run.data_mode;
      } catch { /* 못 읽으면 다음 것 */ }
    }
  }
  return null;
}

/** 계획·영수증에 적힌 입력이 업무 자료인가 · 회사 양식·참고 자료는 아니다 · 앞 결과는 그 실행의 data_mode 를 따른다 */
export function workInput(cwd, ref) {
  const v = String(ref?.path ?? ref);
  if (!v.startsWith('workspace:')) return false;
  if (referenceFile(cwd, v)) return false;
  const mode = outputDataMode(cwd, v);
  return !mode || mode === '실데이터' || mode === '혼합';
}

/** 받침이 있으면 「을」, 없으면 「를」 · 한글로 안 끝나면 「을(를)」 */
const 을를 = word => {
  const code = String(word).trim().slice(-1).charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${word}을(를)`;
  return `${word}${code % 28 === 0 ? '를' : '을'}`;
};

/**
 * 우리 자료를 달라고 할 때인가 · 그 스킬이 무엇을 받는지(inputs 의 자료 칸)를 돌려준다 · 아니면 null.
 * 판단 규칙 · 프로필 「채움」 · 실습 아님 · 그 스킬이 자료를 읽어야 한다(skillNeedsData) ·
 * 계획에 적힌 입력에 업무 자료가 없다(workInput · brand/·회사 양식·참고 자료·샘플로 만든 앞 결과는 세지 않는다) ·
 * inputs/ 에 그 스킬의 자료 칸에 맞는 파일이 없다(matchingInputs · 확장자와 이름 낱말).
 * 프로필만으로 되는 생성 스킬(카피·상세페이지·이름 짓기)은 묻지 않고 그대로 돈다.
 * sample_fallback 이 없어도 파일을 요구하는 스킬(050·096 등)이면 묻는다 (2026-10-14 · 회사 B 045 계획에 줄이 없었다).
 */
export function dataRequest(plan, cwd) {
  const first = (plan?.steps || [])[0];
  if (!cwd || !first || plan.실습 === true) return null;
  const listed = [...(first.inputs || []), ...(plan.inputs || [])];
  if (listed.some(v => String(v?.path ?? v).replace(/^package:/, 'plugin:').startsWith('plugin:sample-data/'))) return null;   // 샘플을 적었으면 화면이 샘플 줄을 낸다
  if (listed.some(v => workInput(cwd, v))) return null;
  if (profileState(cwd) !== '채움') return null;
  const d = skillDeclarations(cwd).get(String(first.skill || '').match(/\d{3}/)?.[0] || '');
  const need = skillNeedsData(d);
  if (!need) return null;
  // 실행 기록을 읽는 스킬은 logs/build-log.md 에 기록이 있으면 그것이 우리 자료다
  if (/build-log/.test(skillSampleFallback(d)?.file || '')) { try { if (fs.readFileSync(path.join(cwd, 'logs', 'build-log.md'), 'utf8').trim()) return null; } catch { /* 없음 */ } }
  else if (matchingInputs(cwd, d).length) return null;
  return need || '이 업무의 자료';
}

/** 화면 「분석할 자료」 줄 · 우리 자료가 없을 때 (문서가 같은 문장을 쓴다 · docs/공통규약.md §0-b) */
export const 자료없음줄 = need => `분석할 자료: 우리 자료가 아직 없습니다 · ${을를(need)} inputs 폴더에 넣거나 대화에 붙여 주시면 그 자료로 분석합니다. 연습용 샘플로 우리 회사 결론을 내지 않습니다.`;
/** compile 안내 줄 · 화면 밖 */
export const 자료없음안내 = need => `📎 우리 자료가 없습니다 · ${을를(need)} inputs/ 에 넣거나 대화에 붙여 주세요 · 샘플로 회사 결론을 내지 않는다 · 사용자가 「샘플로 실습」이라고 했을 때만 plan.json 에 "실습": true 를 적고 다시 compile 한다`;

/** compile 「할 일」 줄 · 화면 밖 · 문서 규칙만으로는 모델이 따르지 않았다 (실측 2026-10-14) */
export function todoLines(plan, cwd) {
  const out = [];
  const ids = [...new Set((plan?.steps || []).map(st => String(st.skill || '').match(/\d{3}/)?.[0]).filter(Boolean))];
  for (const id of ids) {
    const note = skillNotes(cwd, id);
    if (note?.양식원본 && !note.정한날)
      out.push(`📝 할 일 · 회사 양식에서 고칠 점을 3개 이하로 제안하고 승인받은 것만 skill-notes 에 남긴다(정한 날 기록) · ${note.rel}`);
  }
  const f = profileFacts(cwd);
  if (f.역할 && f.보고) out.push(`📝 할 일 · 보고 대상 ${f.보고} · 역할 ${f.역할} → docs/공통규약.md §0-a 표대로 첫 장·길이를 맞춘다`);
  return out;
}

const stopSentences = decl => {
  const out = [];
  if (decl.gate) out.push('완성 뒤 AI 규제검토자가 밖에 내기 전 표현을 검사합니다.');
  if (decl.pii) out.push('완성 뒤 AI 규제검토자에게 개인정보가 새지 않았는지 검사를 맡깁니다.');
  if (decl.review.length) out.push(`완성 뒤 AI 사업검토자가 ${decl.review.join('·')} 관점으로 봅니다.`);
  if (decl.mutating) out.push('밖으로 보내거나 올리는 일은 한 번 더 묻고 합니다.');
  return out;
};

export function renderPlanScreen(plan, { cwd = process.cwd() } = {}) {
  const decl = skillDeclarations(cwd);
  const steps = plan.steps || [];
  if (!steps.length) return null;
  const rows = steps.map(step => {
    const id = String(step.skill || '').trim();
    return { id, step, decl: decl.get(id), tpl: skillScreenTemplate(id, cwd) };
  });
  if (rows.some(r => !r.decl || !r.tpl)) return null;
  const isChain = rows.length > 1;
  const chainTpl = isChain ? chainScreenTemplate(plan.chain) : null;
  if (isChain && !chainTpl) return null;

  const rel = ref => String(ref).replace(/^(workspace|plugin):/, '');
  const choice = normalizeFormatChoice(plan.형식, '계획의');
  const lines = ['[실행 계획]', `계획: ${isChain ? plan.chain : rows[0].decl.name}`];
  if (isChain && chainTpl['부르는 팀']) lines.push(`부르는 팀: ${chainTpl['부르는 팀']} · 스킬 ${rows.length}개`);
  lines.push('', '무엇이 나오나');
  rows.forEach((r, i) => lines.push(`  ${isChain ? `${i + 1}. ` : ''}스킬 ${r.id} · ${r.decl.name}: ${r.tpl['무엇이 나오나']}`));
  lines.push('');

  const first = rows[0];
  // 단계 입력이 비어 있으면 계획 맨 위 inputs 를 본다 · 영수증처럼 {path} 로 적거나 package: 로 적어도 샘플을 알아본다
  // (실측 2026-09-24 · 모델이 run.json 모양으로 적자 샘플 줄과 「우리 자료로 하려면」이 빠진 화면이 찍혔다)
  const 입력목록 = (first.step.inputs || []).length ? first.step.inputs : (!isChain && plan.inputs) || [];
  const inputs = 입력목록.map(v => String(v?.path ?? v).replace(/^package:/, 'plugin:'));
  const sample = inputs.some(v => v.startsWith('plugin:sample-data/'));
  const own = inputs.filter(v => v.startsWith('workspace:')).map(rel);
  // 업무 자료 · brand/·회사 양식·참고 자료·샘플로 만든 앞 결과는 빼고 센다 (2026-10-14 · 회사 A 067 은 양식과 brand/ 만 적고 「읽습니다」가 찍혔다)
  const ownData = inputs.filter(v => v.startsWith('workspace:') && workInput(cwd, v));
  // 「샘플로 실습」을 고른 채움 프로필이면 그렇게 적는다 · 틀의 이유(「inputs 폴더에 리뷰 파일이 없어」)는 사실과 다를 수 있다
  // (실측 2026-10-14 · 회사 B S7 · 리뷰 csv 가 있는데 「리뷰 파일이 없어」) · 빈 프로필(책 실습) 화면은 원고 글자 그대로다
  const 샘플이유 = plan.실습 === true && profileState(cwd) === '채움' ? '실습을 고르셔서' : (first.tpl['샘플 이유'] || 'inputs 폴더가 비어있어');
  // 프로필 「채움」 · 실습 아님 · 자료 없음이면 샘플을 넣지 않고 우리 자료를 달라고 적는다 (빈 프로필 화면은 그대로)
  const need = !ownData.length && !sample ? dataRequest(plan, cwd) : null;
  if (ownData.length) lines.push(`분석할 자료: ${own.join(' · ')} 파일을 읽습니다.`);
  else if (!own.length && sample && first.tpl['샘플 자료']) lines.push(`분석할 자료: ${샘플이유} ${으로(first.tpl['샘플 자료'])} 돌립니다. 결과에는 [샘플]이 붙습니다.`);
  else if (need) lines.push(자료없음줄(need));
  else if (own.length) lines.push(`분석할 자료: ${own.join(' · ')} 파일을 읽습니다.`);
  // 보완 파일이 있는 스킬만 덧붙인다 · 없으면 원고 화면과 글자까지 같다
  const 우리양식 = [...new Set(rows.map(r => skillNotes(cwd, r.id)?.rel).filter(Boolean))].map(v => ` · 우리 양식 ${v}`).join('');
  const facts = profileFacts(cwd);
  // 「샘플로 실습」(plan.실습) · 채움 프로필이어도 샘플 해석에는 연습용 A브랜드 프로필을 쓴다 · 회사 기준·우리 양식을 붙이지 않는다
  // (실측 2026-10-14 · 회사 A·B · 실습 화면에 brand/profile.md 가 찍혀 회사 기준이 샘플 해석에 섞였다) · 빈 프로필 화면은 그대로다
  const 연습 = plan.실습 === true && facts.state !== '빈';
  lines.push(`근거로 쓰는 것: ${facts.state === '빈' ? '브랜드 프로필이 비어있어 연습용 A브랜드 프로필을 씁니다.' : 연습 ? '실습을 고르셔서 연습용 A브랜드 프로필을 씁니다.' : 'brand/profile.md'}${연습 ? '' : 우리양식}`);

  const firstOut = rel((first.step.outputs || [])[0] || '');
  const parts = firstOut.split('/');
  lines.push(`나오는 곳: ${isChain ? parts.slice(0, 2).join('/') : parts.slice(0, 3).join('/')}/`);

  const formatsOf = r => {
    const 계약 = [...new Set(r.decl.writesTo.map(v => path.posix.basename(v)).filter(b => b.includes('.')))];
    // 같은 그릇 이름은 한 번만 · 092 처럼 .md 를 둘 내는 스킬(제작 리포트 · 새 SKILL.md)도 「문서 .md」 하나다
    return [...new Set(applyFormatChoice(계약, scopeFormatChoice(계약, choice)).map(formatLabel))].join(' · ');
  };
  if (isChain) {
    lines.push('나오는 형식:');
    rows.forEach((r, i) => lines.push(`  ${i + 1}. ${r.decl.name}: ${formatsOf(r)}`));
  } else lines.push(`나오는 형식: ${formatsOf(first)}`);
  const allBases = rows.flatMap(r => r.decl.writesTo.map(v => path.posix.basename(v)));
  if (!choice && allBases.some(b => /\.xlsx$/.test(b)))
    lines.push('다른 형식: 표를 csv로 받으려면 「진행 승인. 표는 csv로」라고 답해주세요.');

  const stops = [];
  if (isChain) {
    rows.forEach((r, i) => {
      // 체인 안에서는 단독 호출 때 묻던 질문을 건너뛰는 스킬이 있다 · 그 스킬은 「체인에서 멈추는 곳 더」로 적는다 (「없음」이면 덧붙이지 않는다)
      const extra = '체인에서 멈추는 곳 더' in r.tpl ? r.tpl['체인에서 멈추는 곳 더'] : r.tpl['멈추는 곳 더'];
      const s = [...stopSentences(r.decl), ...(extra && extra !== '없음' ? [extra] : [])];
      if (s.length) stops.push(`  ${i + 1}. ${r.decl.name}: ${s.join(' ')}`);
    });
    for (const extra of chainTpl.목록['멈추는 곳'] || []) stops.push(`  ${extra}`);
    lines.push(stops.length ? '멈추는 곳:' : '멈추는 곳: 없음', ...stops);
  } else {
    const s = [...stopSentences(first.decl), ...(first.tpl['멈추는 곳 더'] ? [first.tpl['멈추는 곳 더']] : [])];
    lines.push(`멈추는 곳: ${s.length ? s.join(' ') : '없음'}`);
  }
  // 체인 틀에 시간이 없으면 단계별 「a~b분」을 더한다 · 지어낸 숫자를 쓰지 않는다
  const sumMinutes = () => {
    let lo = 0, hi = 0;
    for (const r of rows) {
      const m = String(r.tpl['걸리는 시간'] || '').match(/(\d+)\s*~\s*(\d+)\s*분/);
      if (!m) return null;
      lo += Number(m[1]); hi += Number(m[2]);
    }
    return `${lo}~${hi}분`;
  };
  const minutes = isChain ? (chainTpl['걸리는 시간'] || sumMinutes()) : first.tpl['걸리는 시간'];
  if (minutes) lines.push(`걸리는 시간: ${minutes}`);

  // 체인 틀에 같은 키가 있으면 체인 것을 쓴다 · 없으면 첫 단계 스킬 것을 쓴다
  const pick = key => (isChain && chainTpl.목록[key]) || first.tpl.목록[key] || [];
  const handoff = pick('우리 자료로 하려면');
  if (((sample && !own.length) || need) && handoff.length) {
    lines.push('', '우리 자료로 하려면');
    const 안내 = (isChain && chainTpl['우리 자료 안내']) || first.tpl['우리 자료 안내'];
    if (안내) lines.push(`  ${안내}`);
    for (const item of handoff) lines.push(`  ${item}`);
    lines.push('  넣은 뒤 승인할 때 「진행 승인. inputs/파일이름」처럼 파일 이름을 함께 적어주세요.');
  }
  // 프로필이 이미 답한 것(업종·월 목표·브랜드명·마진율)은 다시 묻지 않는다 · 「빈」이면 그대로
  const asks = pick('함께 알려주면 좋은 것').filter(item => !askAnswered(item, facts));
  if (asks.length) {
    lines.push('', '함께 알려주면 좋은 것');
    for (const item of asks) lines.push(`  ${item}`);
  }
  lines.push('', '[승인 요청]', '⏸ 이대로 갈까요? 진행하려면 「진행 승인」이라고 답해주세요.');
  return lines.join('\n');
}

/**
 * 문서·테스트용 표준 조건의 계획 · 샘플 자료 · 빈 프로필 · 형식 선택 없음 · 날짜 2026-09-15.
 * 스킬 하나면 날짜 폴더, 체인이면 `outputs/2026-09-{체인}/` 프로젝트 폴더 아래 스킬별 폴더다.
 */
export function canonicalScreenPlan(target, { date = '2026-09-15' } = {}) {
  const decl = skillDeclarations();
  let ids = [String(target)];
  let chain = null;
  if (!decl.has(String(target))) {
    const found = canonicalChains().get(String(target));
    if (!found) return null;
    ids = found.variants[0];
    chain = found.name;
  }
  const steps = ids.map((id, index) => {
    const d = decl.get(id);
    if (!d) return null;
    const skillText = fs.readFileSync(path.join(d.dir, 'SKILL.md'), 'utf8');
    const fallback = ((skillText.match(/^sample_fallback:\s*(\S+)/m) || [])[1] || '').trim();
    const files = d.writesTo.filter(v => v.includes('/'));
    const outputs = files.map(v => chain
      ? `workspace:outputs/${date.slice(0, 7)}-${chain}/${v.split('/')[2]}/${path.posix.basename(v)}`
      : `workspace:${v.replace('{날짜}', date)}`);
    return {
      step: index + 1, skill: id,
      inputs: index === 0 ? (fallback ? [`plugin:${fallback}`] : []) : [],
      outputs,
      reviews: [...(d.gate ? [{ kind: 'compliance' }] : []), ...d.review.map(p => ({ kind: 'business', perspective: p }))],
    };
  });
  if (steps.some(s => !s)) return null;
  for (let i = 1; i < steps.length; i += 1) if (steps[i - 1].outputs[0]) steps[i].inputs = [steps[i - 1].outputs[0]];
  return { request: '화면 표준 조건', skills: ids, ...(chain ? { chain } : {}), steps };
}

/**
 * 책 실습인가 · 샘플로 책을 따라 하면 원고와 같은 결과가 나와야 한다 (저자 결정 2026-10-12).
 * 승인된 단일 단계 계획 · 형식 선택 없음 · 빈 프로필 · 입력이 전부 플러그인 샘플이거나 원고 결과와 똑같은
 * 앞 실습 결과 · 그 스킬의 기준본(sample-data/참고결과/{폴더}/화면.md)이 있으면 책 실습이다.
 * run-receipt book 이 결과를 놓고, runtime-guard 가 그 전에 모델이 결과를 지어 쓰는 것을 막는다.
 */
export function bookCheck(plan, cwd) {
  const no = reason => ({ ok: false, reason });
  if (!approvalState(plan).ok) return no('승인 봉인 전');
  const steps = plan.steps || [];
  if (steps.length !== 1) return no('여러 단계 계획');
  if (plan.형식 && Object.keys(plan.형식).length) return no('형식을 골랐다');
  if (!profileIsEmpty(cwd)) return no('브랜드 프로필을 채웠다 · 독자 기준으로 만든다');
  // 우리 양식을 정했거나 회사 양식(inputs/양식/)을 넣었으면 원고 결과를 놓지 않는다 (2026-10-14)
  if (notesOfPlan(plan, cwd)) return no('우리 양식(brand/skill-notes)이 있다 · 독자 기준으로 만든다');
  if ((steps[0].inputs || []).some(양식입력)) return no('회사 양식(inputs/양식/)을 넣었다 · 독자 기준으로 만든다');
  const folder = skillDeclarations(cwd).get(String(steps[0].skill || '').match(/\d{3}/)?.[0] || '')?.writesTo?.[0]?.split('/')[2];
  const ref = folder && path.join(PLUGIN, 'sample-data', '참고결과', folder);
  if (!ref || !fs.existsSync(path.join(ref, '화면.md'))) return no('이 스킬의 기준본이 아직 없다');
  const text = f => /\.(md|html|csv|txt)$/i.test(f);
  const sameAsRef = (src, mine, day) => fs.existsSync(src) && fs.existsSync(mine) &&
    (text(src) ? fs.readFileSync(src, 'utf8').replaceAll('{날짜}', day) === fs.readFileSync(mine, 'utf8')
      : fs.readFileSync(src).equals(fs.readFileSync(mine)));
  const canon = name => name.replace(/-\d+(\.[a-z0-9]+)$/i, '$1');
  const inputs = (steps[0].inputs || []).map(v => String(v?.path ?? v).replace(/^package:/, 'plugin:'));
  if (!inputs.length) return no('입력이 없다');
  for (const v of inputs) {
    if (v.startsWith('plugin:sample-data/')) continue;
    const rel = v.replace(/^workspace:/, '');
    const m = rel.match(/^outputs\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!m && rel.startsWith('outputs/') && !path.extname(rel)) continue;   // 폴더 째 가리키면 맥락일 뿐이다
    if (m && sameAsRef(path.join(PLUGIN, 'sample-data', '참고결과', m[2], canon(m[3])), path.join(cwd, rel), m[1])) continue;
    return no(`샘플이나 원고 결과가 아닌 자료가 있다 (${rel})`);
  }
  const outs = (steps[0].outputs || []).map(v => path.join(cwd, String(v).replace(/^workspace:/, '')));
  const day = path.relative(cwd, outs[0] || '').split(path.sep)[1] || '';
  const placed = outs.length > 0 && outs.every(o => sameAsRef(path.join(ref, canon(path.basename(o))), o, day));
  return { ok: true, ref, outs, day, placed, sameAsRef, canon, text };
}

/**
 * 책 실습이면 계획의 입력을 원고 계획의 입력으로 맞춘다. 계획 화면의 「분석할 자료」 줄은 모델이 plan.json 에
 * 적은 입력으로 찍히는데, 모델마다 앞 결과를 넣기도 빼기도 해서 원고와 달라졌다 (실측 2026-10-12 · 002 에 006 을
 * 넣어 원고의 샘플 문장이 빠짐 · 011·091 은 앞 결과를 빼먹음). 기준본의 입력.json 이 원고 화면을 찍는 입력이다.
 * 빈 프로필이고 inputs/ 의 자기 자료가 없을 때만, 입력.json 의 앞 결과가 실제로 있을 때만 맞춘다.
 */
export function bookInputs(plan, cwd) {
  if (!cwd || !profileIsEmpty(cwd) || notesOfPlan(plan, cwd)) return null;
  const steps = plan.steps || [];
  if (steps.length !== 1) return null;
  const folder = skillDeclarations(cwd).get(String(steps[0].skill || '').match(/\d{3}/)?.[0] || '')?.writesTo?.[0]?.split('/')[2];
  let spec;
  try { spec = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'sample-data', '참고결과', folder, '입력.json'), 'utf8')); } catch { return null; }
  const cur = (steps[0].inputs || []).map(v => String(v?.path ?? v));
  if (cur.some(v => /^workspace:inputs(\/|$)/.test(v))) return null;   // 독자가 자기 자료를 넣었다
  const day = String(steps[0].outputs?.[0] ?? '').replace(/^workspace:/, '').split('/')[1] || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const want = spec.입력.map(v => v.replaceAll('{날짜}', day));
  if (!want.every(v => !v.startsWith('workspace:') || fs.existsSync(path.join(cwd, v.slice('workspace:'.length))))) return null;
  if (JSON.stringify(cur) === JSON.stringify(want)) return null;
  steps[0].inputs = want;
  return want;
}

/**
 * 첫 단계 입력이 비었고 작업 공간 inputs/ 에도 그 스킬의 자료 칸에 맞는 파일이 없으면(matchingInputs) 그 스킬의 sample_fallback 으로 채운다.
 * 스킬은 그때 어차피 샘플로 완주하는데, 계획에 [] 로 적히면 「분석할 자료」 줄이 빠지고 책 실습도
 * 「입력이 없다」로 꺼졌다 (실측 2026-10-12 · 4·8·9·10·11장 첫 턴 · 4장 006 이 원고와 다르게 분석됨).
 */
export function sampleInputs(plan, cwd) {
  const first = (plan.steps || [])[0];
  if (!cwd || !first || (first.inputs || []).length || (plan.inputs || []).length) return null;
  // 샘플로 채우는 것은 프로필이 「빈」이거나 사용자가 「샘플로 실습」을 말했을 때(plan.실습)뿐이다 (2026-10-14 · 검토 P0)
  // 우리 회사 프로필에 A브랜드 리뷰를 넣으면 그 리뷰의 고객·제품은 여전히 A브랜드 것이다
  if (plan.실습 !== true && profileState(cwd) !== '빈') return null;
  const d = skillDeclarations(cwd).get(String(first.skill || '').match(/\d{3}/)?.[0] || '');
  if (!d) return null;
  // inputs/ 에 그 스킬의 자료 칸에 맞는 파일이 있으면 채우지 않는다 · 회사 양식·레퍼런스·좋았던 글은 자료가 아니다 (2026-10-14)
  if (matchingInputs(cwd, d).length) return null;
  const fallback = skillSampleFallback(d)?.file || '';
  if (!fallback) return null;
  first.inputs = [`plugin:${fallback}`];
  return first.inputs;
}

/* ── 책 실습 대본 · 여러 턴으로 이어지는 장(8~13장) ──────────────────
 * 체인 장은 계획 승인 뒤에도 「제안해줘」「소재 6개 모두 제작」처럼 사람 말이 이어진다. 턴마다 원고 결과
 * 파일과 원고 답변이 정해져 있어 `sample-data/참고결과/대본/{체인}/대본.json` 에 적어 두었다.
 * 사람 말이 들어올 때(team-context · UserPromptSubmit) 다음 턴과 대조해 맞으면 그 턴의 파일을 놓고 답변을
 * 넘긴다. 원고에 없는 말이 오면 대본을 끝내고 평소대로 돈다 (저자 결정 2026-10-12).
 */
const 대본뿌리 = () => path.join(PLUGIN, 'sample-data', '참고결과', '대본');
const 말 = v => String(v || '').replace(/[\s.,!?~·'"「」]/g, '');
// 화면·파일의 {월}·{날짜} 를 채운다 · 원고 문장에 글자 그대로 남는 자리표시(13장 「inputs/광고주간/{날짜}.csv」)는 {{날짜}} 로 적는다
const 채움 = (v, 월, 날짜) => String(v).replaceAll('{{날짜}}', '\0d').replaceAll('{{월}}', '\0m')
  .replaceAll('{월}', 월).replaceAll('{날짜}', 날짜).replaceAll('\0d', '{날짜}').replaceAll('\0m', '{월}');

export function replayFind(cwd) {
  if (!cwd || !profileIsEmpty(cwd)) return null;
  let names = [];
  try { names = fs.readdirSync(대본뿌리()); } catch { return null; }
  let best = null;
  for (const name of names) {
    const file = path.join(대본뿌리(), name, '대본.json');
    if (!fs.existsSync(file)) continue;
    // 체인 장은 outputs/{월}-{체인}/ · 스킬 하나로 이어지는 장(12장 091 등)은 outputs/{날짜}/{스킬 폴더}/
    let dirs = [];
    try {
      const top = fs.readdirSync(path.join(cwd, 'outputs'));
      dirs = /^\d{3}-/.test(name) ? top.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(d => path.join(d, name))
        : top.filter(d => d.endsWith(`-${name}`));
    } catch { continue; }
    for (const d of dirs) {
      const folder = path.join(cwd, 'outputs', d);
      const planFile = path.join(folder, 'plan.json');
      if (!fs.existsSync(planFile)) continue;
      const at = fs.statSync(planFile).mtimeMs;
      if (!best || at > best.at) best = { at, name, file, folder, planFile };
    }
  }
  if (!best) return null;
  try {
    const plan = JSON.parse(fs.readFileSync(best.planFile, 'utf8'));
    if (!['awaiting-approval', 'approved'].includes(plan.status)) return null;
    if (plan.형식 && Object.keys(plan.형식).length) return null;
    if (notesOfPlan(plan, cwd)) return null;   // 우리 양식을 정했으면 독자 기준
    const own = `${path.relative(cwd, best.folder).split(path.sep).join('/')}/`;
    const 기록장 = /^\d{3}-/.test(best.name);   // 기록을 읽는 장은 작업 폴더의 기록·결과가 재료다
    for (const st of plan.steps || []) for (const v of st.inputs || []) {
      const ref = String(v?.path ?? v).replace(/^package:/, 'plugin:');
      const rel = ref.replace(/^workspace:/, '');
      if (양식입력(rel)) return null;   // 회사 양식은 독자 자료다
      if (ref.startsWith('plugin:sample-data/') || rel.startsWith(own) || rel.startsWith('inputs/')) continue;
      if (기록장 && /^(logs|outputs|brand)\//.test(rel)) continue;
      return null;   // 독자 자료가 섞였으면 독자 기준
    }
    const data = JSON.parse(fs.readFileSync(best.file, 'utf8'));
    const statePath = path.join(best.folder, '.대본.json');
    let state = { next: 0, done: false };
    try { state = { ...state, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; } catch { /* 처음 */ }
    // 스킬 장은 outputs/{날짜}/{스킬}/ 이라 위 폴더가 날짜다 · 체인 장은 outputs/{월}-{체인}/ 이라 위가 「outputs」라
    // 날짜로 「outputs」가 적혔다 (실측 2026-10-12) · 체인은 처음 연 날을 적어 두고 이어 쓴다
    const d = new Date(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const 날짜 = /^\d{3}-/.test(best.name) ? path.basename(path.dirname(best.folder))
      : (/^\d{4}-\d{2}-\d{2}$/.test(state.날짜 || '') ? state.날짜 : today);
    return { ...best, plan, data, state, statePath, 월: (/^\d{3}-/.test(best.name) ? 날짜 : path.basename(best.folder)).slice(0, 7), 날짜 };
  } catch { return null; }
}

/** 오늘 이전 어느 날짜 폴더든 그 스킬의 원고 결과(기준본과 같은 파일)가 놓여 있나 */
function 원고결과있음(cwd, folderName) {
  const ref = path.join(PLUGIN, 'sample-data', '참고결과', folderName);
  let days = [];
  try { days = fs.readdirSync(path.join(cwd, 'outputs')).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch { return false; }
  let names = [];
  try { names = fs.readdirSync(ref).filter(n => n !== '화면.md' && n !== '출처.md' && !/^(review|gate)/.test(n) && /\.(md|html|csv)$/.test(n)); } catch { return false; }
  if (!names.length) return false;
  return days.some(day => names.every(n => {
    try { return fs.readFileSync(path.join(ref, n), 'utf8').replaceAll('{날짜}', day) === fs.readFileSync(path.join(cwd, 'outputs', day, folderName, n), 'utf8'); }
    catch { return false; }
  }));
}

/** 계획 없이 첫 말로 시작하는 대본(13장 등) · 상태는 outputs/.대본-{이름}.json 에 둔다 */
function replayOpening(cwd, prompt) {
  if (!cwd || !profileIsEmpty(cwd)) return null;
  let names = [];
  try { names = fs.readdirSync(대본뿌리()); } catch { return null; }
  for (const name of names) {
    const file = path.join(대본뿌리(), name, '대본.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!data.무계획) continue;
    // 이 대본이 놓는 스킬 결과({번호}-…/)에 우리 양식이 있으면 열지 않는다
    const ids = new Set((data.turns || []).flatMap(t => t.files || []).map(f => String(f).match(/^(\d{3})-/)?.[1]).filter(Boolean));
    if ([...ids].some(id => skillNotes(cwd, id))) continue;
    if (data.이후 && !원고결과있음(cwd, data.이후)) continue;   // 「D로 하자」처럼 앞 결과가 있어야 뜻이 서는 말
    const statePath = path.join(cwd, 'outputs', `.대본-${name}.json`);
    let state = null;
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* 아직 안 열림 */ }
    const first = (data.turns?.[0]?.user || []).some(u => 말(u) === 말(prompt));
    if (state?.done) { if (!first || data.이후) continue; state = null; }   // 다 끝난 대본도 첫 말을 다시 하면 처음부터 · 「이후」 대본은 한 번만
    if (!state && !first) continue;
    const d = new Date(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;   // 사용자 시각 기준
    const folder = path.join(cwd, 'outputs', today);
    return { name, file, folder, planFile: null, plan: null, data, state: state || { next: 0, done: false }, statePath, 월: today.slice(0, 7), 날짜: today };
  }
  return null;
}

/** 사람 말 한 마디를 대본에 대 본다 · 맞으면 그 턴의 파일을 놓고 화면을 돌려준다 */
/** 새 말이 오면 앞 차례는 끝난 것이다 · 원고 답변을 기다리는 표시(pending)를 모두 거둔다
 *  안 거두면 응답 끝 검사가 다음 턴(대본과 상관없는 책 실습)을 지난 대본 화면으로 막았다
 *  (실측 2026-10-12 · v0.72.26 · 5장 인스타 내려받기 차례가 남아 「채널 성장이 왜 멈췄어?」 계획이 막혔다) */
function 차례거둠(cwd) {
  const walk = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(f, depth + 1); continue; }
      if (!/^\.대본(-.+)?\.json$/.test(e.name)) continue;
      try {
        const st = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!Number.isInteger(st.pending)) continue;
        delete st.pending; delete st.shown;
        fs.writeFileSync(f, JSON.stringify(st, null, 1));
      } catch { /* 무시 */ }
    }
  };
  walk(path.join(cwd, 'outputs'), 0);
}

export function replayStep(cwd, prompt, again = true) {
  if (again) 차례거둠(cwd);
  const found = replayFind(cwd);
  const r = (found && !found.state.done ? found : null) || replayOpening(cwd, prompt);   // 끝난 체인(12장 등) 뒤에도 13장 첫 말은 열린다
  if (!r || r.state.done) return null;
  const 다른첫말 = () => {   // 이 대본 밖의 말이 다른 첫 말 대본(5장 블로그 → 인스타그램 등)의 첫 말인가
    if (!again) return null;
    const n = replayStep(cwd, prompt, false);
    return n?.turn ? n : null;
  };
  const turns = r.data.turns || [];
  const said = 말(prompt);
  const fits = t => (t.approve && /^\s*진행\s*승인/.test(String(prompt))) ||
    (t.user || []).some(u => { const a = 말(u); return a && (a === said || (said.length > 1 && (a.includes(said) || said.includes(a)) && Math.min(a.length, said.length) / Math.max(a.length, said.length) > 0.6)); });
  let k = -1;
  for (let i = r.state.next; i < Math.min(turns.length, r.state.next + 3); i += 1) {
    if (fits(turns[i])) { k = i; break; }
    if (!turns[i].optional) break;   // 건너뛸 수 있는 것은 덧붙은 턴뿐이다
  }
  // 같은 말을 다시 보냈으면(예: 힉스필드를 연결하고 다시 요청) 방금 차례를 한 번 더 낸다
  if (k < 0 && r.state.next > 0 && fits(turns[r.state.next - 1])) k = r.state.next - 1;
  const save = st => { try { fs.writeFileSync(r.statePath, JSON.stringify(st, null, 1)); } catch { /* 무시 */ } };
  if (k < 0) {
    if (r.state.next === 0) return r.planFile ? 다른첫말() : null;   // 계획 승인 전의 말은 대본 밖이 아니다
    try { fs.mkdirSync(path.dirname(r.statePath), { recursive: true }); } catch { /* 무시 */ }
    save({ ...r.state, done: true, reason: '원고에 없는 말' });
    return 다른첫말() || { ended: true };
  }
  const t = turns[k];
  const fill = v => 채움(v, r.월, r.날짜);
  for (const rel of t.files || []) {
    const src = path.join(path.dirname(r.file), 'files', rel);
    const dst = path.join(r.folder, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (/\.(md|html|csv|txt)$/i.test(rel)) fs.writeFileSync(dst, fill(fs.readFileSync(src, 'utf8')));
    else fs.copyFileSync(src, dst);
  }
  try { fs.mkdirSync(path.dirname(r.statePath), { recursive: true }); } catch { /* 무시 */ }
  save({ next: k + 1, done: k + 1 >= turns.length, pending: k, 날짜: r.날짜 });
  return { turn: t, k, total: turns.length, screen: fill(t.screen), 장: r.data.장, plan: r.planFile ? path.relative(cwd, r.planFile) : null, folder: path.relative(cwd, r.folder), 날짜: r.날짜 };
}

/** 지금 원고 답변을 기다리는 대본 차례 · 계획이 있는 대본과 첫 말로 시작한 대본을 모두 본다 */
export function replayCurrent(cwd) {
  const pick = [];
  const r = replayFind(cwd);
  if (r) pick.push({ data: r.data, state: r.state, statePath: r.statePath, 월: r.월, 날짜: r.날짜 });
  try {
    for (const f of fs.readdirSync(path.join(cwd, 'outputs')).filter(n => n.startsWith('.대본-') && n.endsWith('.json'))) {
      const name = f.slice('.대본-'.length, -'.json'.length);
      const statePath = path.join(cwd, 'outputs', f);
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const data = JSON.parse(fs.readFileSync(path.join(대본뿌리(), name, '대본.json'), 'utf8'));
      const at = fs.statSync(statePath).mtimeMs;
      pick.push({ data, state, statePath, at, 날짜: state.날짜 || '', 월: (state.날짜 || '').slice(0, 7) });
    }
  } catch { /* 없으면 없다 */ }
  const live = pick.filter(p => Number.isInteger(p.state?.pending) && p.state.shown !== p.state.pending);
  if (!live.length) return null;
  const p = live.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  const t = p.data.turns[p.state.pending];
  return { ...p, turn: t, screen: 채움(t?.screen || '', p.월, p.날짜) };
}

/** 대본이 진행 중인가 · 진행 중이면 결과 파일을 지어 쓰지 못한다 */
export function replayActive(cwd) {
  const r = replayFind(cwd);
  return r && r.state.next > 0 && !r.state.done ? r : null;
}

/* ── CLI ───────────────────────────────────────────────────── */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const [command, target] = process.argv.slice(2);
  if (!command || !target) fail('사용: plan-compiler.mjs <compile|approve|check> <plan.json> · screen <스킬번호|체인이름>');
  // 틀을 고친 뒤 문서의 「찍힌 화면」을 다시 찍을 때 쓴다 · 빈 폴더(빈 프로필)에서 표준 조건으로 찍는다
  if (command === 'screen') {
    const plan = canonicalScreenPlan(target);
    if (!plan) fail(`그런 스킬이나 체인이 없습니다: ${target}`);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-screen-'));
    const screen = renderPlanScreen(plan, { cwd: empty });
    fs.rmSync(empty, { recursive: true, force: true });
    if (!screen) fail(`틀이 없어 화면을 찍지 못했습니다: ${target} (스킬 example/plan-screen.md 또는 체인 틀을 확인하세요)`);
    console.log(screen);
    process.exit(0);
  }
  let file = path.resolve(process.cwd(), target);
  // 작업 폴더는 계획 파일 경로에서 찾는다 · 셸 cwd 가 플러그인 안에 남아 있어도 결과가 같아야 한다 (실측 2026-10-14 · 11장)
  if (isInside(file, PLUGIN)) fail(`계획 파일이 플러그인 폴더 안에 있습니다 · 플러그인 안에는 쓰지 않습니다 · 작업 폴더의 outputs/ 아래에 plan.json 을 두세요 · ${file}`);
  const ws = workspaceOf(file) || process.cwd();
  // 같은 날 다시 돌리면 plan-2.json · run-2.json 처럼 순번이 붙는다 (2026-10-14 · 회사 B S7)
  if (!/^plan(-\d+)?\.json$/.test(path.basename(file))) fail('계획 파일 이름은 plan.json 이어야 합니다 · 같은 날 다시 돌리면 plan-2.json 처럼 순번을 붙입니다.');
  const plan = read(file);

  if (command === 'compile') {
    // 계획을 바른 자리에 둔다 · 체인 폴더 · 스킬 폴더 · 같은 날 다시 돌리면 다음 순번 · 앞 실행의 계획은 덮지 않는다
    let chainName = plan.chain || null;
    if (!chainName) try { chainName = compileChain(plan).chain || null; } catch { chainName = null; }
    const placed = placePlan(file, plan, { cwd: ws, chain: chainName });
    for (const line of placed.said) console.log(line);
    if (placed.block) { console.error(`⛔ ${placed.block[0]}`); failPlan(placed.block[1]); }
    if (placed.sealed) {
      console.log(`✅ 이미 승인되어 실행한 계획입니다 · ${slotName('run', slotOf(file) || 1)} · ${placed.sealed.run_id} · 다시 compile 하지 않습니다`);
      process.exit(0);
    }
    file = placed.file;
    const filled = sampleInputs(plan, ws);
    if (filled) console.log(`📎 inputs 가 비어 샘플 자료로 채웠다 · ${filled[0].replace(/^plugin:/, '')}`);
    else { const need = dataRequest(plan, ws); if (need) console.log(자료없음안내(need)); }
    if (plan.실습 === true && profileState(ws) === '채움') console.log('📖 실습은 연습용 A브랜드 프로필로 읽는다 · 회사 기준(brand/profile.md · 우리 양식)을 샘플 해석에 붙이지 않는다');
    for (const line of userSkills(ws).warnings) console.log(`🟡 ${line}`);
    for (const line of notesFormat(plan, ws)) console.log(line);
    for (const st of plan.steps || []) {
      const note = skillNotes(ws, String(st.skill || '').match(/\d{3}/)?.[0]);
      if (!note?.양식원본) continue;
      const there = fs.existsSync(path.resolve(ws, note.양식원본.replace(/^workspace:/, '')));
      console.log(there ? `📎 우리 양식 원본 · ${note.양식원본} 의 틀을 따른다` : `🟡 ${note.rel} 의 양식 원본이 없습니다 · ${note.양식원본}`);
    }
    // 할 일 줄 · 화면 밖 안내다 · 계획 화면 글자는 바꾸지 않는다
    for (const line of todoLines(plan, ws)) console.log(line);
    const forced = bookInputs(plan, ws);
    if (forced) console.log(`📖 책 실습 · 원고 계획의 입력으로 맞췄다 · ${forced.map(v => v.replace(/^(workspace|plugin):/, '')).join(' · ')}`);
    const issues = validatePlan(plan, { cwd: ws });
    if (issues.length) { for (const line of issues) console.error(`⛔ ${line}`); failPlan(`계획이 계약과 맞지 않습니다 · ${issues.length}건`); }
    plan.schema = SCHEMA;
    for (const [from, to] of preferLatestReruns(plan, { cwd: ws })) console.log(`↻ 같은 날 다시 돌린 결과를 읽습니다 · ${from.replace(/^workspace:/, '')} → ${to.replace(/^workspace:/, '')}`);
    const graph = compileChain(plan);
    plan.chain_graph = { schema: graph.schema, chain: graph.chain, nodes: graph.nodes, edges: graph.edges };
    plan.risks = graph.warnings;
    // 이름 있는 체인은 top-level plan.chain 에도 적어 둔다 (2026-09-15) — run-receipt.mjs 의
    // 스킬별 자기 폴더 강제(validateExecutionContract)가 chain_graph.chain 이 아니라 이 필드를
    // 읽는다. 모델이 plan.chain 을 스스로 적지 않아도(정본 순서와 정확히 같으면) compileChain 이
    // 이미 자동으로 알아낸 이름이 있으므로 여기서 채워 넣는다. 실측 2026-09-14·09-15,
    // 10장 045→046→043 이 「자기 폴더」 규칙이 이미 있었는데도 마지막 스킬 폴더로 몰렸다 —
    // plan.json 에 chain 이 끝내 비어 있었기 때문이다.
    if (graph.chain) plan.chain = graph.chain;
    // 이름 있는 체인은 outputs/{YYYY-MM}-{체인}/ 에 쌓는다 · 팀 이름으로 부르면 모델이 「2026-10-퍼포먼스마케팅팀」처럼
    // 폴더를 지어 원고(광고애널리틱스)와 달라지고 책 실습 대본도 열리지 않았다 (실측 2026-10-12 · 10장).
    // 처음에는 막기만 했는데 모델이 옛 폴더를 못 지워 빈 폴더가 남았다 (실측 2026-10-14 · 두 번 연속) · 이제 위 placePlan 이
    // 스스로 옮긴다. 체인 이름을 compile 이 여기서 처음 알게 된 경우(정본 순서와 같음)도 한 번 더 자리를 본다.
    if (plan.chain && plan.chain !== chainName) {
      const again = placePlan(file, plan, { cwd: ws, chain: plan.chain });
      for (const line of again.said) console.log(line);
      if (again.block) { console.error(`⛔ ${again.block[0]}`); failPlan(again.block[1]); }
      file = again.file;
      const re = validatePlan(plan, { cwd: ws });
      if (re.length) { for (const line of re) console.error(`⛔ ${line}`); failPlan(`계획이 계약과 맞지 않습니다 · ${re.length}건`); }
      const g2 = compileChain(plan);
      plan.chain_graph = { schema: g2.schema, chain: g2.chain, nodes: g2.nodes, edges: g2.edges };
    }
    plan.plan_sha256 = planHash(plan);
    plan.status = 'awaiting-approval';
    plan.approved_sha256 = null;
    const screen = renderPlanScreen(plan, { cwd: ws });
    if (screen) plan.screen = screen; else delete plan.screen;
    write(file, plan);
    console.log(`✅ 계획 확정 · ${plan.skills.join('→')} · ${plan.plan_sha256.slice(0, 12)} · 승인 대기`);
    if (screen) {
      console.log('── 아래 화면을 ```text 상자째, 한 글자도 바꾸지 말고 앞뒤에 문장을 붙이지 말고 그대로 사용자에게 낸다 ──');
      console.log(`\`\`\`text\n${screen}\n\`\`\``);
      console.log('── 화면 끝 ──');
    }
    // 계획 흔적을 실행 타래에 남긴다 (P2 · 2026-08-30) — 작업 공간일 때만 · 실패해도 컴파일을 막지 않는다.
    try {
      if (fs.existsSync(path.resolve(ws, 'outputs'))) {
        const { appendEvent } = await import('./orchestrator-events.mjs');
        appendEvent(ws, { plan: { plan_sha256: plan.plan_sha256 }, skills: plan.skills, status: plan.status },
          'plan.compiled', { plan_id: plan.plan_id || null, request: plan.request || null });
      }
    } catch { /* 무시 */ }
  } else if (command === 'approve') {
    // 앞 실행이 이미 이 자리의 계획으로 돌았으면 다른 계획을 봉인하지 않는다 · 같은 계획이면 그대로 둔다
    const run = sealedRun(path.dirname(file), slotOf(file) || 1);
    if (run && run.plan?.plan_sha256 !== planHash(plan)) {
      const m = nextSlot(path.dirname(file));
      fail(`${path.basename(file)} 은 이미 돈 실행(${slotName('run', slotOf(file) || 1)} · ${run.run_id})의 계획입니다 · 덮지 않습니다 · 같은 폴더에 ${slotName('plan', m)} 로 다시 쓰고 compile 하세요`);
    }
    const issues = validatePlan(plan, { cwd: ws });
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
      if (fs.existsSync(path.resolve(ws, 'outputs'))) {
        const { appendEvent } = await import('./orchestrator-events.mjs');
        appendEvent(ws, { plan: { plan_sha256: current }, skills: plan.skills, status: plan.status },
          'plan.approved', { plan_id: plan.plan_id || null, request: plan.request || null });
      }
    } catch { /* 무시 */ }
  } else if (command === 'check') {
    const issues = validatePlan(plan, { cwd: ws });
    for (const line of issues) console.error(`⛔ ${line}`);
    const state = approvalState(plan);
    if (!state.ok) fail(state.reason);
    if (issues.length) failPlan(`계획이 계약과 맞지 않습니다 · ${issues.length}건`);
    console.log(`✅ 승인 유효 · ${state.current.slice(0, 12)} · ${plan.skills.join('→')}`);
  } else fail('명령은 compile · approve · check 중 하나입니다.');
}
