#!/usr/bin/env node
/**
 * test-plan-compiler.mjs · 계획 스키마·해시·승인 봉인 회귀
 * 골든 케이스는 실측에서 나왔다 (2026-08-30) — 계획 밖 HTML 생성, 지정 순서 변경.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planHash, validatePlan, approvalState, renderPlanScreen, skillDeclarations, parseScreenTemplate, canonicalScreenPlan, chainScreenTemplate, preferLatestReruns } from './plan-compiler.mjs';
import { canonicalChains } from './chain-compiler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-plan-'));
const dir = path.join(temp, 'outputs', '2026-08-30', '046-roas-budget-rebalance');
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.join(temp, 'logs'), { recursive: true });
const planFile = path.join(dir, 'plan.json');
const rel = 'outputs/2026-08-30/046-roas-budget-rebalance';
const OUT = `workspace:${rel}/046-roas-budget-rebalance.md`;
const cli = (script, ...args) =>
  spawnSync(process.execPath, [path.join(HERE, script), ...args], { cwd: temp, encoding: 'utf8' });
const base = () => ({
  schema: 'marketing-team.plan/v1',
  plan_id: 'p-001',
  request: '광고 예산 다시 짜줘',
  skills: ['046'],
  steps: [{
    step: 1, skill: '046',
    inputs: ['plugin:sample-data/A브랜드-채널성과-90일.csv'],
    outputs: [OUT],
    reviews: [{ kind: 'business', perspective: '재무' }],
  }],
  budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
});
const save = plan => fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
const load = () => JSON.parse(fs.readFileSync(planFile, 'utf8'));

try {
  // 해시 재현성 · 민감도
  assert.equal(planHash(base()), planHash(base()), '같은 계획은 같은 해시여야 한다');
  const reordered = base(); reordered.steps[0].inputs = [...reordered.steps[0].inputs].reverse();
  assert.equal(planHash(base()), planHash(reordered), '입력 순서는 의미가 아니므로 해시가 같아야 한다');
  for (const mutate of [
    p => p.skills.push('045'),
    p => p.steps[0].outputs.push(`workspace:${rel}/extra.html`),
    p => p.steps[0].reviews.push({ kind: 'compliance' }),
    p => { p.request = '다른 요청'; },
  ]) {
    const changed = base(); mutate(changed);
    assert.notEqual(planHash(base()), planHash(changed), '계획이 바뀌면 해시가 달라져야 한다');
  }

  // 계약 검사
  const badOutput = base(); badOutput.steps[0].outputs.push(`workspace:${rel}/extra.html`);
  assert.match(validatePlan(badOutput).join(' '), /계약에 없는 산출물/, '계획 밖 산출물을 잡아야 한다');
  const noReview = base(); noReview.steps[0].reviews = [];
  assert.match(validatePlan(noReview).join(' '), /business:재무/, 'review: 선언 누락을 잡아야 한다');
  const orderMismatch = base(); orderMismatch.skills = ['045'];
  assert.match(validatePlan(orderMismatch).join(' '), /순서가 다릅니다/, 'skills 와 steps 불일치를 잡아야 한다');
  const ghost = base(); ghost.skills = ['999']; ghost.steps[0].skill = '999';
  assert.match(validatePlan(ghost).join(' '), /그런 스킬이 없습니다/, '없는 스킬을 잡아야 한다');

  // 사용자가 고른 그릇 (2026-09-02) · 계획에서 한 번 정하고 승인과 함께 봉인한다
  const 그릇바꿈 = base();
  그릇바꿈.형식 = { '046-roas-budget-rebalance.md': 'docx' };
  그릇바꿈.steps[0].outputs = [`workspace:${rel}/046-roas-budget-rebalance.docx`];
  assert.equal(validatePlan(그릇바꿈).length, 0, '고른 그릇은 계획에서 통과해야 한다');
  const 그릇모름 = base();
  그릇모름.형식 = { '046-roas-budget-rebalance.md': 'hwp' };
  assert.match(validatePlan(그릇모름).join(' '), /모르는 그릇/, '모르는 그릇은 막아야 한다');
  const 그릇남 = base();
  그릇남.형식 = { '999-없는것.md': 'csv' };
  assert.match(validatePlan(그릇남).join(' '), /계약에 없습니다/, '계약에 없는 정본은 막아야 한다');

  // 재실행 산출물 1:1 (P1 · 2026-08-30 최종 검토)
  const rerunOnly = base(); rerunOnly.steps[0].outputs = [`workspace:${rel}/046-roas-budget-rebalance-2.md`];
  assert.equal(validatePlan(rerunOnly).length, 0, '-2 재실행 산출물 단독은 통과해야 한다');
  const dupCanon = base(); dupCanon.steps[0].outputs = [OUT, `workspace:${rel}/046-roas-budget-rebalance-2.md`];
  assert.match(validatePlan(dupCanon).join(' '), /한 실행에 하나/, '정본과 -2 동시 입력은 막아야 한다');
  const freeName = base(); freeName.steps[0].outputs = [`workspace:${rel}/046-roas-budget-rebalance-final.md`];
  assert.match(validatePlan(freeName).join(' '), /계약에 없는 산출물/, '숫자 아닌 이름 변형은 막아야 한다');

  // 사용자가 지정한 순서 · 모델이 바꾸면 막는다 (실측 2026-08-30 · 061→073→065→066 이 바뀜)
  const ordered = base();
  ordered.requested_order = ['046'];
  assert.equal(validatePlan(ordered).length, 0, '지정 순서와 같으면 통과해야 한다');
  const reordered2 = base();
  reordered2.requested_order = ['045', '046'];
  assert.match(validatePlan(reordered2).join(' '), /지정한 순서와 다릅니다/, '순서를 바꾸면 잡아야 한다');
  assert.notEqual(planHash(base()), planHash(ordered), 'requested_order 도 해시에 들어가야 한다');

  // 승인 상태
  save(base());
  assert.equal(cli('plan-compiler.mjs', 'compile', `${rel}/plan.json`).status, 0, 'compile 은 성공해야 한다');
  assert.equal(load().status, 'awaiting-approval', 'compile 뒤에는 승인 대기여야 한다');
  assert.equal(approvalState(load()).ok, false, '승인 전에는 유효하지 않아야 한다');

  assert.equal(cli('plan-compiler.mjs', 'approve', `${rel}/plan.json`).status, 0, 'approve 는 성공해야 한다');
  assert.equal(load().status, 'approved');
  assert.equal(approvalState(load()).ok, true, '승인 뒤에는 유효해야 한다');

  const after = load(); after.steps[0].outputs.push(`workspace:${rel}/extra.html`); save(after);
  assert.equal(approvalState(load()).ok, false, '승인 뒤 계획이 바뀌면 무효여야 한다');
  assert.notEqual(cli('plan-compiler.mjs', 'check', `${rel}/plan.json`).status, 0, 'check 가 막아야 한다');

  // 승인 전 start 차단 · 승인 뒤 통과
  save(base());
  cli('plan-compiler.mjs', 'compile', `${rel}/plan.json`);
  const runFile = path.join(dir, 'run.json');
  fs.writeFileSync(runFile, `${JSON.stringify({
    schema: 'marketing-team.run/v1', status: 'draft', request: '광고 예산 다시 짜줘', skills: ['046'],
    data_mode: '샘플',
    inputs: [{ path: 'plugin:sample-data/A브랜드-채널성과-90일.csv', period: '2026-05-01~2026-07-29' }],
    profile: 'plugin:sample-data/profile-sample.md',
    outputs: [OUT],
    required_reviews: [{ kind: 'business', perspective: '재무', artifact: OUT }],
    reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
  }, null, 2)}\n`);
  const blocked = cli('run-receipt.mjs', 'start', `${rel}/run.json`);
  assert.notEqual(blocked.status, 0, '승인 전에는 실행을 열지 않아야 한다');
  assert.match(blocked.stderr, /승인/, '왜 막혔는지 알려야 한다');

  cli('plan-compiler.mjs', 'approve', `${rel}/plan.json`);
  const started = cli('run-receipt.mjs', 'start', `${rel}/run.json`);
  assert.equal(started.status, 0, `승인 뒤에는 시작해야 한다: ${started.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).plan.plan_sha256, planHash(load()), '영수증에 승인 해시가 남아야 한다');

  // 이름 있는 체인은 compile 이 plan.chain 을 채워야 한다 (2026-09-15) —
  // run-receipt.mjs 의 스킬별 자기 폴더 강제가 chain_graph.chain 이 아니라 이 필드를 읽는다.
  // 모델이 chain 을 안 적어도, 정본 순서(05-ads PLUGIN.md 「광고애널리틱스」 045→046→043)와
  // 정확히 같으면 chain-compiler 가 이미 알아낸 이름을 top-level 에도 남겨야 한다.
  // 실측 2026-09-14·09-15 · 10장 045→046→043 이 이 필드가 비어 각자 폴더 규칙을 못 타고
  // 마지막 스킬 폴더로 몰렸다.
  {
    const chainDir = path.join(temp, 'outputs', '2026-09-추적', '045-weekly-ads-report');
    fs.mkdirSync(chainDir, { recursive: true });
    const chainRel = 'outputs/2026-09-추적';
    const wsRef = (skillDir, name) => `workspace:${chainRel}/${skillDir}/${name}`;
    const chainPlan = {
      schema: 'marketing-team.plan/v1',
      plan_id: 'p-chain',
      request: '광고애널리틱스 돌려줘',
      requested_order: ['045', '046', '043'],
      skills: ['045', '046', '043'],
      steps: [
        {
          step: 1, skill: '045',
          inputs: ['plugin:sample-data/A브랜드-채널성과-90일.csv'],
          outputs: [wsRef('045-weekly-ads-report', '045-weekly-ads-report.html')],
          reviews: [],
        },
        {
          step: 2, skill: '046',
          inputs: [wsRef('045-weekly-ads-report', '045-weekly-ads-report.html')],
          outputs: [wsRef('046-roas-budget-rebalance', '046-roas-budget-rebalance.md')],
          reviews: [{ kind: 'business', perspective: '재무' }],
        },
        {
          step: 3, skill: '043',
          inputs: [wsRef('046-roas-budget-rebalance', '046-roas-budget-rebalance.md')],
          outputs: [wsRef('043-meta-ad-copy', '043-meta-ad-copy.xlsx'), wsRef('043-meta-ad-copy', '043-meta-ad-copy.md')],
          reviews: [{ kind: 'compliance' }],
        },
      ],
      budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
    };
    assert.equal(chainPlan.chain, undefined, '이 테스트는 chain 을 일부러 비워 둔다 — 모델이 안 적는 실제 상황을 재현한다');
    const chainPlanFile = path.join(chainDir, '..', 'plan.json');
    fs.writeFileSync(chainPlanFile, `${JSON.stringify(chainPlan, null, 2)}\n`);
    const chainPlanRel = `${chainRel}/plan.json`;
    const compiled = cli('plan-compiler.mjs', 'compile', chainPlanRel);
    assert.equal(compiled.status, 0, `정본과 정확히 같은 순서의 체인은 compile 이 통과해야 한다: ${compiled.stderr}${compiled.stdout}`);
    const onDisk = JSON.parse(fs.readFileSync(path.join(temp, chainPlanRel), 'utf8'));
    assert.equal(onDisk.chain, '광고애널리틱스', 'compile 은 정본과 일치하는 체인 이름을 top-level plan.chain 에 채워야 한다');
    assert.equal(onDisk.chain_graph.chain, '광고애널리틱스', 'chain_graph.chain 도 그대로 유지돼야 한다');
  }

  // ── 계획 화면은 스크립트가 찍는다 · 틀이 있는 스킬은 「찍힌 화면」과 글자 단위로 같아야 한다 (2026-09-15) ──
  //    원고의 실습 화면 = 코워크 화면 100%. 같은 조건(샘플·빈 프로필·형식 선택 없음)이면 같은 글자다.
  let 화면수 = 0;
  {
    const screenCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-screen-'));
    try {
      for (const [id, d] of skillDeclarations()) {
        const refFile = path.join(d.dir, 'example', 'plan-screen.md');
        if (!fs.existsSync(refFile)) continue;
        const refText = fs.readFileSync(refFile, 'utf8');
        if (!parseScreenTemplate(refText)) continue;
        const expected = (refText.match(/^## 찍힌 화면\n\n````text\n([\s\S]*?)\n````$/m) || [])[1];
        assert.ok(expected, `${id} · 틀이 있으면 「## 찍힌 화면」 블록도 있어야 한다`);
        const plan = canonicalScreenPlan(id);
        const got = renderPlanScreen(plan, { cwd: screenCwd });
        assert.equal(got, expected, `${id} · 찍힌 화면과 틀 출력이 다르다 — 틀을 고쳤으면 「찍힌 화면」도 다시 찍어 넣는다`);
        assert.equal(renderPlanScreen(plan, { cwd: screenCwd }), got, `${id} · 같은 조건에서 두 번 찍은 화면이 다르다`);
        assert.ok(!got.includes('—'), `${id} · 화면에 em dash 가 있다`);
        화면수 += 1;
      }
      assert.ok(화면수 >= 1, '틀을 가진 스킬이 하나도 없다');
      // 체인 · 틀이 있는 체인은 같은 파일의 「#### 찍힌 화면: {체인}」 블록과 같아야 한다
      const docs = [path.join(HERE, '..', '100-skills', 'CHAINS.md'),
        ...fs.readdirSync(path.join(HERE, '..', '100-skills'), { withFileTypes: true })
          .filter(e => e.isDirectory() && /^\d\d-/.test(e.name)).map(e => path.join(HERE, '..', '100-skills', e.name, 'PLUGIN.md'))]
        .filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8'));
      for (const name of canonicalChains().keys()) {
        if (!chainScreenTemplate(name)) continue;
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^#### 찍힌 화면: ${esc}\\n\\n\`\`\`\`text\\n([\\s\\S]*?)\\n\`\`\`\`$`, 'm');
        const expected = docs.map(t => (t.match(re) || [])[1]).find(Boolean);
        assert.ok(expected, `${name} · 체인 틀이 있으면 「#### 찍힌 화면: ${name}」 블록도 있어야 한다`);
        const got = renderPlanScreen(canonicalScreenPlan(name), { cwd: screenCwd });
        assert.equal(got, expected, `${name} · 체인 찍힌 화면과 틀 출력이 다르다`);
        assert.ok(!got.includes('—'), `${name} · 체인 화면에 em dash 가 있다`);
        화면수 += 1;
      }
    } finally {
      fs.rmSync(screenCwd, { recursive: true, force: true });
    }
  }

  // 앞선 실행 입력은 같은 날 가장 늦은 순번으로 (실측 2026-09-15 · 006 을 3번 돌렸다. 011 은 첫 파일을 읽었다)
  {
    const prev = path.join(temp, 'outputs', '2026-09-15', '006-review-mining');
    fs.mkdirSync(prev, { recursive: true });
    for (const name of ['006-review-mining-해설.md', '006-review-mining-해설-2.md', '006-review-mining-해설-3.md', '006-review-mining.html'])
      fs.writeFileSync(path.join(prev, name), '');
    const own = 'workspace:outputs/2026-09-15/011-product-concept-ideation/011-product-concept-ideation.md';
    const plan = { steps: [{ inputs: ['workspace:outputs/2026-09-15/006-review-mining/006-review-mining-해설.md', 'workspace:outputs/2026-09-15/006-review-mining/006-review-mining.html', 'plugin:sample-data/경쟁사-3곳.md'], outputs: [own] }] };
    const changed = preferLatestReruns(plan, { cwd: temp });
    assert.equal(changed.length, 1, '순번이 있는 파일만 바꾼다');
    assert.equal(plan.steps[0].inputs[0], 'workspace:outputs/2026-09-15/006-review-mining/006-review-mining-해설-3.md');
    assert.equal(plan.steps[0].inputs[1], 'workspace:outputs/2026-09-15/006-review-mining/006-review-mining.html', '다시 돌린 적 없는 파일은 그대로');
    assert.equal(plan.steps[0].inputs[2], 'plugin:sample-data/경쟁사-3곳.md');
  }

  console.log(`계획 컴파일러 · 해시 재현·민감도 7 · 계약 검사 4 · 고른 그릇 3 · 재실행 1:1 3 · 최근 순번 입력 1 · 지정 순서 2 · 승인 상태 5 · start 차단·통과 2 · 이름 있는 체인 자동 채움 2 · 찍힌 화면 ${화면수} · ✅`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
