#!/usr/bin/env node
/**
 * run-receipt.mjs · 한 번의 마케팅 실행과 검토가 같은 산출물을 가리키는지 봉인한다.
 *
 * 사용:
 *   node scripts/run-receipt.mjs start outputs/.../run.json
 *   node scripts/run-receipt.mjs review outputs/.../run.json \
 *     --kind compliance --status pass --report outputs/.../gate.md --artifact outputs/.../result.md
 *   node scripts/run-receipt.mjs review outputs/.../run.json \
 *     --kind business --perspective 재무 --status approved \
 *     --report outputs/.../review-재무.md --artifact outputs/.../result.md
 *   node scripts/run-receipt.mjs finalize outputs/.../run.json --status completed
 *   node scripts/run-receipt.mjs verify outputs/.../run.json
 *
 * run.json 의 `checks` 배열(과 `pii` 블록)이 있으면 finalize·verify 가
 * scripts/output-checks.mjs 를 함께 돌린다 — pii · csv-format · house-style.
 *
 * 요청문·브랜드 데이터는 셸 인수로 받지 않는다. AI가 먼저 run.json 초안을 쓰고 이 도구는
 * 그 파일을 읽는다. 사용자 문자열이 셸 명령으로 해석될 틈을 만들지 않기 위해서다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './output-checks.mjs';
import { approvalState, normalizeFormatChoice, applyFormatChoice } from './plan-compiler.mjs';
import { mergeRequiredReviews, requiredReviewsForExecution } from './review-policy.mjs';
import { appendEvent } from './orchestrator-events.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.resolve(process.cwd());
const SCHEMA = 'marketing-team.run/v1';
const DATA_MODES = new Set(['실데이터', '샘플', '추정', '혼합']);
const KINDS = new Set(['business', 'compliance']);
const PERSPECTIVES = new Set(['경영', '재무', '고객', '법무', '브랜드']);
const STATUSES = {
  business: new Set(['approved', 'conditional', 'rejected']),
  compliance: new Set(['pass', 'needs-fix', 'blocked', 'industry-required']),
};
const FINAL = new Set(['completed', 'blocked', 'interrupted', 'save-failed']);

const fail = message => {
  console.error(`🔴 ${message}`);
  process.exit(1);
};

const iso = () => new Date().toISOString();
const cleanId = value => String(value || '').match(/\d{3}/)?.[0] || '';
const posix = value => value.split(path.sep).join('/');

function frontmatterList(text, key) {
  const value = (text.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm')) || [])[1] || '';
  return value.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * 이동 가능한 경로 표기:
 *   workspace:outputs/...  작업 폴더 기준
 *   plugin:sample-data/... 플러그인 패키지 기준
 * 접두사가 없으면 작업 폴더 기준으로 읽되 저장할 때 workspace: 로 정규화한다.
 */
function resolveRef(value, { workspaceOnly = false } = {}) {
  const raw = typeof value === 'string' ? value : value?.path;
  if (!raw) throw new Error('파일 경로가 비었습니다.');
  let base = WORK;
  let body = raw;
  if (raw.startsWith('workspace:')) body = raw.slice('workspace:'.length);
  else if (raw.startsWith('plugin:')) {
    if (workspaceOnly) throw new Error(`작업 폴더 밖에는 쓸 수 없습니다: ${raw}`);
    base = PLUGIN;
    body = raw.slice('plugin:'.length);
  }
  const abs = path.resolve(base, body);
  if (!inside(base, abs)) throw new Error(`허용된 기준 폴더를 벗어났습니다: ${raw}`);
  return {
    abs,
    ref: `${base === PLUGIN ? 'plugin' : 'workspace'}:${posix(path.relative(base, abs))}`,
  };
}

function receiptPath(value) {
  if (!value) fail('run.json 경로가 필요합니다.');
  try {
    const { abs } = resolveRef(value, { workspaceOnly: true });
    if (!/^run(?:-\d+)?\.json$/.test(path.basename(abs)))
      fail('실행 영수증 이름은 run.json 또는 run-2.json 같은 순번 형식이어야 합니다.');
    return abs;
  } catch (error) {
    fail(error.message);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${posix(path.relative(WORK, file))} 를 읽지 못했습니다: ${error.message}`);
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function refreshUsage(run, delta = {}) {
  const started = Date.parse(run.started_at || iso());
  const usage = run.usage || { tool_calls: 0, review_rounds: 0, wall_minutes: 0, warnings: [] };
  usage.tool_calls += Number(delta.tool_calls || 0);
  usage.review_rounds += Number(delta.review_rounds || 0);
  usage.wall_minutes = Math.max(0, Number(((Date.now() - started) / 60000).toFixed(2)));
  const limits = run.budget || {};
  for (const [field, label] of [['tool_calls', '도구 호출'], ['wall_minutes', '실행 시간'], ['review_rounds', '검토 라운드']]) {
    const limit = Number(limits[field] || 0);
    if (limit > 0 && usage[field] > limit) {
      const warning = `${label} 소프트 예산 초과: ${usage[field]} > ${limit}`;
      if (!usage.warnings.includes(warning)) usage.warnings.push(warning);
    }
  }
  run.usage = usage;
  return usage;
}

function emit(file, run, type, detail = {}) {
  try { appendEvent(WORK, run, type, { receipt: `workspace:${posix(path.relative(WORK, file))}`, ...detail }); }
  catch (error) { console.warn(`🟡 이벤트 기록 실패: ${error.message}`); }
}

async function hashFile(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function snapshot(value, options = {}) {
  const { abs, ref } = resolveRef(value, options);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`파일이 없습니다: ${ref}`);
  return { path: ref, sha256: await hashFile(abs) };
}

let skillIndex;
function skills() {
  if (skillIndex) return skillIndex;
  skillIndex = new Map();
  const root = path.join(PLUGIN, '100-skills');
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name === 'SKILL.md') {
        const text = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
        const id = cleanId((text.match(/^id:\s*["']?([^\n"']+)/m) || [])[1]);
        const name = ((text.match(/^name:\s*["']?([^\n"']+)/m) || [])[1] || '').trim();
        if (id) skillIndex.set(id, {
          id,
          name,
          path: target,
          pii: /^pii:\s*true\s*$/m.test(text),
          gate: /^gate:\s*true\s*$/m.test(text),
          review: ((text.match(/^review:\s*(.+)$/m) || [])[1] || '')
            .split(/[·,]/).map(part => part.trim()).filter(Boolean),
          writesTo: frontmatterList(text, 'writes_to').filter(value => value.startsWith('outputs/') && path.extname(value)),
        });
      }
    }
  };
  walk(root);
  return skillIndex;
}

async function skillSnapshot(value) {
  const id = cleanId(typeof value === 'string' ? value : value?.id);
  const found = skills().get(id);
  if (!found) throw new Error(`스킬 ${id || value}을 찾지 못했습니다.`);
  return {
    id,
    name: found.name,
    path: `plugin:${posix(path.relative(PLUGIN, found.path))}`,
    sha256: await hashFile(found.path),
    pii: found.pii,
    gate: found.gate,
    review: found.review,
    writes_to: found.writesTo,
  };
}

function normalizePii(value, inputRows) {
  if (!value || typeof value !== 'object') throw new Error('pii:true 스킬은 run.json 초안에 pii 블록이 필요합니다.');
  if (!value.source) throw new Error('pii.source가 비었습니다. 개인정보 원본 경로를 적으세요.');
  const source = resolveRef(value.source).ref;
  if (!inputRows.some(item => item.path === source))
    throw new Error(`pii.source는 이 실행의 inputs에도 있어야 합니다: ${source}`);
  const idColumns = Array.isArray(value.id_columns)
    ? value.id_columns.map(item => String(item).trim()).filter(Boolean)
    : [];
  if (!idColumns.length) throw new Error('pii.id_columns가 비었습니다. 식별자 열 이름을 적으세요.');
  const surrogate = String(value.surrogate_column || '').trim();
  return {
    source,
    id_columns: idColumns,
    ...(surrogate ? { surrogate_column: surrogate } : {}),
  };
}

/**
 * `review:` · `gate: true` 를 선언한 스킬은 required_reviews 에 그 검토가 있어야 한다.
 *
 * 실측 2026-08-22 · 08-27 · 08-30 — 「판단이 갈리면 부른다」도, 「주제로 부른다」도
 * 호출 0회였다. `pii` 는 블록을 강제하고 나서야 멈췄다. 같은 모양으로 닫는다.
 * 이 검사가 없으면 검토 의무가 있는 60개 중 52개가 「AI 마케터가 기억하기」에 달려 있다.
 */
/**
 * 같은 폴더에 plan.json 이 있으면 **승인된 계획**과 대조한다.
 * 계획이 없으면 예전 run/v1 경로 그대로 간다 (하위 호환).
 *
 * 실측 2026-08-30 — 중급이 계획에 없던 HTML 을 만들었고, 고급이 지정 순서를 바꿔 돌았다.
 * 승인의 대상이 문장이 아니라 해시여야 그 둘을 대조할 수 있다.
 */
function validateApprovedPlan(receiptFile, skillRows, outputRows, requiredRows, formatChoice) {
  const planFile = path.join(path.dirname(receiptFile), 'plan.json');
  if (!fs.existsSync(planFile)) return null;
  let plan;
  try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); }
  catch (error) { throw new Error(`plan.json 을 읽지 못했습니다: ${error.message}`); }

  const state = approvalState(plan);
  if (!state.ok) throw new Error(`승인된 계획이 아닙니다: ${state.reason}`);

  const planFormat = normalizeFormatChoice(plan.형식, 'plan.json 의');
  if (JSON.stringify(planFormat) !== JSON.stringify(formatChoice || null))
    throw new Error('승인한 계획과 그릇이 다릅니다. 형식은 G2 에서 정하고 승인과 함께 봉인합니다.');

  const planned = (plan.skills || []).map(String);
  const actual = skillRows.map(item => item.id);
  if (planned.join(',') !== actual.join(','))
    throw new Error(`승인한 계획과 스킬·순서가 다릅니다: 계획 ${planned.join('→')} · 실행 ${actual.join('→')}`);

  const plannedOutputs = new Set((plan.steps || []).flatMap(step => (step.outputs || []).map(String)));
  for (const row of outputRows) {
    if (!plannedOutputs.has(row.path))
      throw new Error(`승인한 계획에 없는 산출물입니다: ${row.path} · 새 계획으로 다시 승인받으세요.`);
  }
  const plannedReviews = new Set((plan.steps || []).flatMap(step =>
    (step.reviews || []).map(r => `${r.kind}:${r.perspective || ''}`)));
  for (const key of plannedReviews) {
    const [kind, perspective] = key.split(':');
    if (!requiredRows.some(row => row.kind === kind && (kind !== 'business' || row.perspective === perspective)))
      throw new Error(`승인한 계획의 검토가 required_reviews 에 없습니다: ${key}`);
  }
  const steps = (plan.steps || []).map((step, index) => ({
    step: index + 1,
    skill: String(step.skill || '').trim(),
    status: 'pending',
    inputs: (step.inputs || []).map(String),
    outputs: (step.outputs || []).map(String),
    consumed: {},          // 완료 시점에 이 단계가 실제로 먹은 앞 산출물 지문
    started_at: null,
    completed_at: null,
  }));
  return { plan_sha256: state.current, plan_id: plan.plan_id || null, steps, budget: plan.budget || null };
}

function validateReviewCoverage(skillRows, requiredRows) {
  const missing = [];
  for (const skill of skillRows) {
    for (const perspective of skill.review || []) {
      if (!PERSPECTIVES.has(perspective)) {
        missing.push(`스킬 ${skill.id}의 review 관점을 모릅니다: ${perspective} (${[...PERSPECTIVES].join(' · ')})`);
        continue;
      }
      const found = requiredRows.some(row => row.kind === 'business' && row.perspective === perspective);
      if (!found) missing.push(`스킬 ${skill.id}은 review: ${perspective} 다. required_reviews 에 business:${perspective} 를 넣으세요.`);
    }
    if (skill.gate && !requiredRows.some(row => row.kind === 'compliance'))
      missing.push(`스킬 ${skill.id}은 gate: true 인 대외 발행물이다. required_reviews 에 compliance 를 넣으세요.`);
  }
  if (missing.length) throw new Error(missing.join(' / '));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateExecutionContract(file, skillRows, outputRows, formatChoice) {
  const ids = skillRows.map(item => item.id);
  const expected = skillRows.flatMap(item => item.writes_to || []).map(value => path.posix.basename(value));
  if (!expected.length) throw new Error(`스킬 ${ids.join('→')}의 writes_to 파일 계약을 찾지 못했습니다.`);
  const uniqueExpected = applyFormatChoice([...new Set(expected)], formatChoice);
  const actual = outputRows.map(item => path.posix.basename(item.path.replace(/^workspace:/, '')));
  const uniqueActual = new Set(actual);
  // 재실행 산출물 1:1 계약 (P1 · 2026-08-30 최종 검토 · plan-compiler 와 같은 규칙) —
  // 이름-2.md 는 정본 이름.md 의 재실행이다. 정본 하나에 실제 파일이 정확히 하나,
  // 재실행 순번은 한 실행 전체에서 하나여야 한다. 정확 일치를 먼저 보므로 기존 계약은 안 깨진다.
  const parseOut = out => {
    const m = out.match(/^(.*)-(\d+)(\.[a-z0-9]+)$/i);
    return m ? { canon: m[1] + m[3], ord: m[2] } : { canon: out, ord: '1' };
  };
  const canonOf = out => (uniqueExpected.includes(out) ? out : (uniqueExpected.includes(parseOut(out).canon) ? parseOut(out).canon : null));
  const matchCount = new Map(uniqueExpected.map(name => [name, 0]));
  const ords = new Set();
  const extra = [];
  for (const out of uniqueActual) {
    const canon = canonOf(out);
    if (canon === null) { extra.push(out); continue; }
    matchCount.set(canon, matchCount.get(canon) + 1);
    ords.add(out === canon ? '1' : parseOut(out).ord);
  }
  const missing = uniqueExpected.filter(name => (matchCount.get(name) || 0) === 0);
  const duplicated = uniqueExpected.filter(name => (matchCount.get(name) || 0) > 1);
  if (missing.length) throw new Error(`writes_to 필수 산출물이 outputs에 없습니다: ${missing.join(' · ')}`);
  if (extra.length) throw new Error(`writes_to에 없는 산출물은 이 실행에 추가할 수 없습니다: ${extra.join(' · ')}`);
  if (duplicated.length) throw new Error(`같은 정본에 산출물이 2개 이상 대응합니다 — 한 실행에 하나입니다: ${duplicated.join(' · ')}`);
  if (ords.size > 1) throw new Error(`재실행 순번이 섞였습니다(${[...ords].sort().join('·')}) — 한 실행의 산출물은 같은 순번을 씁니다.`);
  if (actual.length !== uniqueActual.size) throw new Error('outputs에 같은 파일명이 중복됐습니다.');

  const receiptDir = path.dirname(file);
  const receiptRel = posix(path.relative(WORK, receiptDir));
  const mainTemplate = skillRows.at(-1).writes_to?.[0];
  const mainFolder = mainTemplate?.split('/')[2];
  if (!mainFolder || !new RegExp(`^outputs/\\d{4}-\\d{2}-\\d{2}/${escapeRegex(mainFolder)}$`).test(receiptRel))
    throw new Error(`run.json은 주 스킬 폴더 outputs/{날짜}/${mainFolder || '{번호}-{슬러그}'}/에 두세요: ${receiptRel}`);
  for (const item of outputRows) {
    const { abs } = resolveRef(item.path, { workspaceOnly: true });
    if (path.dirname(abs) !== receiptDir)
      throw new Error(`조합 산출물은 run.json과 같은 주 스킬 폴더에 모아야 합니다: ${item.path}`);
  }
}

function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) out._.push(token);
    else {
      const key = token.slice(2);
      const next = argv[i + 1];
      out[key] = next && !next.startsWith('--') ? (i++, next) : true;
    }
  }
  return out;
}

function normalizeRequired(value, outputRefs) {
  const item = typeof value === 'string' ? { kind: value } : { ...value };
  if (!KINDS.has(item.kind)) throw new Error(`검토 종류가 잘못됐습니다: ${item.kind}`);
  if (item.kind === 'business' && !PERSPECTIVES.has(item.perspective))
    throw new Error(`사업 검토 perspective는 ${[...PERSPECTIVES].join(' · ')} 중 하나여야 합니다.`);
  if (!item.artifact) throw new Error(`${item.kind} 필수 검토에는 artifact가 필요합니다.`);
  const artifact = resolveRef(item.artifact, { workspaceOnly: true }).ref;
  if (!outputRefs.has(artifact)) throw new Error(`필수 검토 대상이 outputs에 없습니다: ${artifact}`);
  return item.kind === 'business'
    ? { kind: item.kind, perspective: item.perspective, artifact }
    : { kind: item.kind, artifact };
}

function reviewKey(value) {
  return `${value.kind}:${value.perspective || ''}:${value.artifact || ''}`;
}

async function start(file) {
  if (!fs.existsSync(file)) fail('AI가 먼저 run.json 초안을 써야 합니다. docs/실행-영수증.md의 뼈대를 사용하세요.');
  const draft = readJson(file);
  if (draft.schema && draft.schema !== SCHEMA) fail(`지원하지 않는 스키마입니다: ${draft.schema}`);
  if (draft.run_id) {
    if (draft.status !== 'running')
      fail(`이미 ${draft.status} 상태인 실행입니다. 같은 스킬 재실행은 새 폴더(-2)에 시작하세요.`);
    const current = await inspect(draft, 'running');
    if (current.issues.length || current.sourceChanges.length)
      fail(`시작 뒤 자료가 바뀌었습니다. 기존 실행을 덮지 말고 새 폴더(-2)에 시작하세요.`);
    console.log(`✅ 이미 시작된 실행 · ${draft.run_id}`);
    return;
  }
  if (!String(draft.request || '').trim()) fail('request가 비었습니다. 사용자 요청을 그대로 적으세요.');
  if (!DATA_MODES.has(draft.data_mode)) fail(`data_mode는 ${[...DATA_MODES].join(' · ')} 중 하나여야 합니다.`);
  if (!Array.isArray(draft.skills) || !draft.skills.length) fail('skills가 비었습니다. 번호를 하나 이상 적으세요.');
  if (!Array.isArray(draft.outputs) || !draft.outputs.length) fail('outputs가 비었습니다. 만들 경로를 먼저 정하세요.');

  try {
    const skillRows = [];
    for (const value of draft.skills) skillRows.push(await skillSnapshot(value));
    const inputRows = [];
    for (const value of draft.inputs || []) {
      const snap = await snapshot(value);
      inputRows.push({ ...snap, period: typeof value === 'object' ? value.period || '미확인' : '미확인' });
    }
    const pii = skillRows.some(item => item.pii) ? normalizePii(draft.pii, inputRows) : null;
    const profile = draft.profile ? await snapshot(draft.profile) : null;
    const outputRows = draft.outputs.map(value => {
      const { ref } = resolveRef(value, { workspaceOnly: true });
      return { path: ref, sha256: null };
    });
    const formatChoice = normalizeFormatChoice(draft.형식, 'run.json 의');
    validateExecutionContract(file, skillRows, outputRows, formatChoice);
    const outputRefs = new Set(outputRows.map(item => item.path));
    const manualRequired = (draft.required_reviews || []).map(value => normalizeRequired(value, outputRefs));
    const automaticRequired = requiredReviewsForExecution(skillRows, outputRows);
    const required = mergeRequiredReviews(manualRequired, automaticRequired);
    validateReviewCoverage(skillRows, required);
    const approvedPlan = validateApprovedPlan(file, skillRows, outputRows, required, formatChoice);
    const run = {
      schema: SCHEMA,
      run_id: draft.run_id || `${iso().replace(/[-:.TZ]/g, '').slice(0, 14)}-${skillRows[0].id}-${crypto.randomBytes(3).toString('hex')}`,
      started_at: draft.started_at || iso(),
      completed_at: null,
      status: 'running',
      ...(approvedPlan ? {
        plan: { plan_sha256: approvedPlan.plan_sha256, plan_id: approvedPlan.plan_id },
        steps: approvedPlan.steps,
      } : {}),
      request: String(draft.request).trim(),
      skills: skillRows,
      data_mode: draft.data_mode,
      ...(formatChoice ? { 형식: formatChoice } : {}),
      inputs: inputRows,
      profile,
      ...(pii ? { pii } : {}),
      outputs: outputRows,
      required_reviews: required,
      review_policy: { source: 'skill-frontmatter', generated: automaticRequired.length },
      reviews: Array.isArray(draft.reviews) ? draft.reviews : [],
      ledger: {
        path: resolveRef(draft.ledger?.path || 'logs/build-log.md', { workspaceOnly: true }).ref,
        recorded: false,
      },
      integrity: { status: 'pending', verified_at: null, issues: [] },
      budget: approvedPlan?.budget || draft.budget || { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
      usage: { tool_calls: 0, review_rounds: 0, wall_minutes: 0, warnings: [] },
    };
    refreshUsage(run);
    writeJson(file, run);
    emit(file, run, 'run.started', { plan_id: run.plan?.plan_id || null, request: run.request || null });
    console.log(`✅ 실행 시작 · ${run.run_id} · 스킬 ${skillRows.map(s => s.id).join('→')}`);
  } catch (error) {
    fail(error.message);
  }
}

async function recordReview(file, args) {
  const run = readJson(file);
  if (run.schema !== SCHEMA) fail('start로 봉인된 run.json이 아닙니다.');
  const kind = args.kind;
  const status = args.status;
  if (!KINDS.has(kind)) fail('--kind는 business 또는 compliance입니다.');
  if (!STATUSES[kind].has(status)) fail(`${kind}의 --status가 잘못됐습니다: ${status}`);
  if (kind === 'business' && !PERSPECTIVES.has(args.perspective))
    fail(`사업 검토 --perspective는 ${[...PERSPECTIVES].join(' · ')} 중 하나여야 합니다.`);
  if (!args.report || !args.artifact) fail('--report와 --artifact가 필요합니다.');

  try {
    const artifact = await snapshot(args.artifact, { workspaceOnly: true });
    const report = await snapshot(args.report, { workspaceOnly: true });
    if (!run.outputs.some(item => item.path === artifact.path))
      fail(`검토 대상이 이 실행의 outputs에 없습니다: ${artifact.path}`);
    const row = {
      kind,
      ...(kind === 'business' ? { perspective: args.perspective } : {}),
      status,
      artifact: artifact.path,
      artifact_sha256: artifact.sha256,
      report: report.path,
      report_sha256: report.sha256,
      reviewed_at: iso(),
    };
    const key = reviewKey(row);
    run.reviews = (run.reviews || []).filter(item => reviewKey(item) !== key);
    run.reviews.push(row);
    run.status = 'running';
    run.completed_at = null;
    run.integrity = { status: 'pending', verified_at: null, issues: [] };
    refreshUsage(run, { review_rounds: 1 });
    writeJson(file, run);
    emit(file, run, 'review.recorded', { kind, perspective: row.perspective || null, review_status: status, artifact: row.artifact });
    console.log(`✅ 검토 봉인 · ${kind}${row.perspective ? `:${row.perspective}` : ''} · ${status}`);
  } catch (error) {
    fail(error.message);
  }
}

async function currentHash(ref) {
  const { abs } = resolveRef(ref);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return await hashFile(abs);
}

async function inspect(run, finalStatus = run.status) {
  const issues = [];
  const sourceChanges = [];
  const notes = []; // ⚠ 참고 — 위반도 변경도 아닌 안내문. 완료 봉인을 막지 않는다 (설치본 실기 실측 2026-08-30)
  const checkSnapshot = async (item, label) => {
    const now = await currentHash(item.path);
    if (!now) issues.push(`${label} 파일이 없습니다: ${item.path}`);
    else if (now !== item.sha256) sourceChanges.push(`실행 뒤 바뀐 ${label}: ${item.path}`);
  };

  for (const item of run.skills || []) await checkSnapshot(item, `스킬 ${item.id}`);
  for (const item of run.inputs || []) await checkSnapshot(item, '입력');
  if (run.profile) await checkSnapshot(run.profile, '프로필');

  for (const item of run.outputs || []) {
    const now = await currentHash(item.path);
    if (!now && finalStatus === 'completed') issues.push(`산출물이 없습니다: ${item.path}`);
    else if (item.sha256 && now !== item.sha256) issues.push(`완료 뒤 산출물이 바뀌었습니다: ${item.path}`);
  }

  if (run.pii || (Array.isArray(run.checks) && run.checks.length)) {
    try {
      for (const line of await runChecks(run, ref => resolveRef(ref).abs)) {
        // 「⚠ 참고」는 pii-check 의 안내문(예: 3자 미만 식별자 오탐 제외)이다 — 변경 사항으로 승격하면
        // 짧은 식별자 데이터셋에서 finalize 가 영원히 실패한다 (설치본 초급 실기 실측 2026-08-30).
        if (line.startsWith('\u26a0 참고')) notes.push(line.replace(/^\u26a0\s*/, ''));
        else if (line.startsWith('\u26a0')) sourceChanges.push(line.replace(/^\u26a0\s*/, ''));
        else issues.push(`산출물 검사 · ${line}`);
      }
    } catch (error) {
      issues.push(`산출물 검사를 돌리지 못했습니다: ${error.message}`);
    }
  }

  for (const item of run.reviews || []) {
    const artifactNow = await currentHash(item.artifact);
    const reportNow = await currentHash(item.report);
    if (!artifactNow) issues.push(`검토 대상이 없습니다: ${item.artifact}`);
    else if (artifactNow !== item.artifact_sha256)
      issues.push(`검토 뒤 산출물이 바뀌었습니다. 재검토가 필요합니다: ${item.artifact}`);
    if (!reportNow) issues.push(`검토 보고서가 없습니다: ${item.report}`);
    else if (reportNow !== item.report_sha256) issues.push(`검토 보고서가 바뀌었습니다: ${item.report}`);
  }

  if (finalStatus === 'completed') {
    for (const required of run.required_reviews || []) {
      const found = (run.reviews || []).find(item =>
        item.kind === required.kind && item.artifact === required.artifact &&
        (required.kind !== 'business' || item.perspective === required.perspective));
      if (!found) issues.push(`필수 검토가 없습니다: ${required.kind}${required.perspective ? `:${required.perspective}` : ''}`);
      else if (required.kind === 'business' && found.status !== 'approved')
        issues.push(`사업 검토가 승인 상태가 아닙니다: ${required.perspective}=${found.status}`);
      else if (required.kind === 'compliance' && found.status !== 'pass')
        issues.push(`규제 검사가 통과 상태가 아닙니다: ${found.status}`);
    }
  }

  const ledgerRef = run.ledger?.path || 'workspace:logs/build-log.md';
  const { abs: ledger } = resolveRef(ledgerRef, { workspaceOnly: true });
  let ledgerRecorded = false;
  if (fs.existsSync(ledger)) {
    const text = fs.readFileSync(ledger, 'utf8');
    const evidence = [run.run_id, ...run.outputs.map(item => item.path.replace(/^workspace:/, ''))];
    ledgerRecorded = evidence.some(value => value && text.includes(value));
  }
  if (finalStatus === 'completed' && !ledgerRecorded)
    issues.push(`원장에서 이 실행을 찾지 못했습니다: ${ledgerRef}`);

  return { issues, sourceChanges, notes, ledgerRecorded };
}

/* ── 단계별 실행 · 중단과 재개 ─────────────────────────────────
 * 실측 2026-08-30 — 고급 4스킬 조합이 중간에 멈추면 어디까지 됐는지 알 방법이 없어
 * 처음부터 다시 돌려야 했다. 완료한 단계를 다시 만드는 것은 시간도 돈도 낭비이고,
 * 다시 만든 결과가 앞서 검토받은 것과 달라질 수도 있다.
 * 그래서 단계마다 상태와 **먹은 앞 산출물의 지문**을 남긴다.
 */

function stepsOf(run) {
  if (!Array.isArray(run.steps) || !run.steps.length)
    fail('이 실행에는 단계가 없습니다. plan.json 을 두고 start 하면 단계가 생깁니다.');
  return run.steps;
}

/** 앞 단계가 만든 산출물 중 이 단계가 입력으로 쓰는 것 */
function upstreamOf(steps, index) {
  const produced = new Map();
  for (let i = 0; i < index; i++) for (const ref of steps[i].outputs || []) produced.set(ref, i + 1);
  return (steps[index].inputs || []).filter(ref => produced.has(ref));
}

async function stepStart(file, args) {
  const run = readJson(file);
  const steps = stepsOf(run);
  const n = Number(args.step);
  const target = steps.find(item => item.step === n);
  if (!target) fail(`그런 단계가 없습니다: ${n} (1~${steps.length})`);
  if (target.status === 'completed') fail(`이미 끝난 단계입니다: ${n}. 다시 돌리려면 resume 로 무효화하세요.`);
  const earlier = steps.filter(item => item.step < n && item.status !== 'completed');
  if (earlier.length) fail(`앞 단계가 아직 안 끝났습니다: ${earlier.map(item => item.step).join(' · ')}`);
  target.status = 'running';
  target.started_at = iso();
  run.status = 'running';
  refreshUsage(run);
  writeJson(file, run);
  emit(file, run, 'step.started', { step: n, skill: target.skill });
  console.log(`▶ 단계 ${n} 시작 · 스킬 ${target.skill}`);
}

async function stepDone(file, args) {
  const run = readJson(file);
  const steps = stepsOf(run);
  const n = Number(args.step);
  const index = steps.findIndex(item => item.step === n);
  if (index < 0) fail(`그런 단계가 없습니다: ${n}`);
  const target = steps[index];
  if (target.status !== 'running') fail(`단계 ${n} 이 running 이 아닙니다: ${target.status}`);
  for (const ref of target.outputs || []) {
    const now = await currentHash(ref);
    if (!now) fail(`단계 ${n} 의 산출물이 없습니다: ${ref}`);
  }
  const consumed = {};
  for (const ref of upstreamOf(steps, index)) consumed[ref] = await currentHash(ref);
  target.consumed = consumed;
  target.status = 'completed';
  target.completed_at = iso();
  refreshUsage(run);
  writeJson(file, run);
  emit(file, run, 'step.completed', { step: n, skill: target.skill });
  const left = steps.filter(item => item.status !== 'completed').length;
  console.log(`✅ 단계 ${n} 완료 · 스킬 ${target.skill} · 남은 단계 ${left}`);
}

/** 완료한 단계 중 먹은 앞 산출물이 바뀐 것을 찾아 그 뒤를 전부 되돌린다 */
async function resume(file) {
  const run = readJson(file);
  const steps = stepsOf(run);
  let invalidFrom = null;
  for (const [index, step] of steps.entries()) {
    if (step.status !== 'completed') continue;
    for (const [ref, was] of Object.entries(step.consumed || {})) {
      const now = await currentHash(ref);
      if (now !== was) { invalidFrom = invalidFrom ?? index; break; }
    }
    if (invalidFrom !== null) break;
  }
  const undone = [];
  if (invalidFrom !== null) {
    for (let i = invalidFrom; i < steps.length; i++) {
      if (steps[i].status === 'completed') undone.push(steps[i].step);
      steps[i].status = 'pending';
      steps[i].consumed = {};
      steps[i].started_at = null;
      steps[i].completed_at = null;
    }
    run.status = 'running';
    run.completed_at = null;
    writeJson(file, run);
    emit(file, run, 'run.resumed', { invalidated_steps: undone });
  }
  const next = steps.find(item => item.status !== 'completed');
  if (undone.length) console.log(`🟡 앞 산출물이 바뀌어 되돌린 단계: ${undone.join(' · ')}`);
  if (!next) { console.log(`✅ 모든 단계 완료 · finalize 로 넘어가세요.`); return; }
  const done = steps.filter(item => item.status === 'completed').map(item => item.step);
  console.log(`▶ 재개 지점 · 단계 ${next.step} (스킬 ${next.skill})` +
    (done.length ? ` · 이미 끝난 단계 ${done.join(' · ')} 는 다시 만들지 않습니다` : ''));
}

async function finalize(file, args) {
  const run = readJson(file);
  const status = args.status;
  if (run.schema !== SCHEMA) fail('start로 봉인된 run.json이 아닙니다.');
  if (!FINAL.has(status)) fail(`--status는 ${[...FINAL].join(' · ')} 중 하나여야 합니다.`);
  try {
    for (const item of run.outputs) item.sha256 = await currentHash(item.path);
    if (status === 'completed' && Array.isArray(run.steps) && run.steps.length) {
      const left = run.steps.filter(item => item.status !== 'completed');
      if (left.length) fail(`아직 안 끝난 단계가 있습니다: ${left.map(item => `${item.step}(${item.status})`).join(' · ')}`);
    }
    const result = await inspect(run, status);
    run.ledger.recorded = result.ledgerRecorded;
    const hardIssues = [...result.issues, ...(status === 'completed' ? result.sourceChanges : [])];
    run.integrity = {
      status: hardIssues.length ? 'failed' : result.sourceChanges.length ? 'source-changed' : 'current',
      verified_at: iso(),
      issues: [...result.issues, ...result.sourceChanges],
    };
    if (hardIssues.length) {
      run.status = 'verification-failed';
      run.completed_at = null;
      writeJson(file, run);
      for (const issue of result.issues) console.error(`🔴 ${issue}`);
      for (const warning of result.sourceChanges) console.error(`🔴 ${warning}`);
      fail('완료하지 않았습니다. 산출물·검토·원장을 맞춘 뒤 다시 finalize 하세요.');
    }
    run.status = status;
    run.completed_at = iso();
    refreshUsage(run);
    writeJson(file, run);
    emit(file, run, status === 'completed' ? 'run.completed' : 'run.stopped', { final_status: status });
    for (const warning of result.sourceChanges) console.warn(`🟡 ${warning}`);
    for (const note of result.notes || []) console.warn(`🟡 ${note}`);
    console.log(`✅ 실행 봉인 · ${run.run_id} · ${status}`);
  } catch (error) {
    fail(error.message);
  }
}

async function metric(file, args) {
  const run = readJson(file);
  if (run.schema !== SCHEMA) fail('start로 봉인된 run.json이 아닙니다.');
  const increment = Number(args['tool-calls'] || 0);
  if (!Number.isInteger(increment) || increment < 0) fail('--tool-calls는 0 이상의 정수여야 합니다.');
  refreshUsage(run, { tool_calls: increment });
  writeJson(file, run);
  emit(file, run, 'budget.measured', { usage: run.usage, budget: run.budget });
  for (const warning of run.usage.warnings || []) console.warn(`🟡 ${warning}`);
  console.log(`✅ 사용량 기록 · 도구 ${run.usage.tool_calls} · ${run.usage.wall_minutes}분 · 검토 ${run.usage.review_rounds}`);
}

async function verify(file) {
  const run = readJson(file);
  if (run.schema !== SCHEMA) fail(`스키마가 다릅니다: ${run.schema}`);
  if (run.status !== 'completed')
    fail(`완료 상태가 아닙니다: ${run.status || '미기록'} · finalize --status completed 뒤에만 verify 할 수 있습니다.`);
  if (!run.completed_at)
    fail('completed_at이 없습니다. finalize --status completed로 실행을 봉인하세요.');
  if (run.integrity?.status !== 'current')
    fail(`무결성 상태가 current가 아닙니다: ${run.integrity?.status || '미기록'} · 다시 finalize 하세요.`);
  try {
    const result = await inspect(run, 'completed');
    const all = [...result.issues, ...result.sourceChanges];
    if (all.length) {
      for (const issue of result.issues) console.error(`🔴 ${issue}`);
      for (const warning of result.sourceChanges) console.error(`🟡 ${warning}`);
      fail(`실행 영수증이 현재 상태와 다릅니다: ${all.length}건`);
    }
    console.log(`✅ 실행 영수증 현재 · ${run.run_id} · ${run.status}`);
  } catch (error) {
    fail(error.message);
  }
}

const [command, fileArg, ...rest] = process.argv.slice(2);
const file = receiptPath(fileArg);
const args = argsOf(rest);

if (command === 'start') await start(file);
else if (command === 'review') await recordReview(file, args);
else if (command === 'finalize') await finalize(file, args);
else if (command === 'verify') await verify(file);
else if (command === 'step-start') await stepStart(file, args);
else if (command === 'step-done') await stepDone(file, args);
else if (command === 'resume') await resume(file);
else if (command === 'metric') await metric(file, args);
else fail('명령은 start · step-start · step-done · resume · review · metric · finalize · verify 중 하나입니다.');
