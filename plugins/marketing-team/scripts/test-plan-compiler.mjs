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
import { planHash, validatePlan, approvalState, renderPlanScreen, skillDeclarations, parseScreenTemplate, canonicalScreenPlan, chainScreenTemplate, preferLatestReruns, applyFormatChoice, frontmatterField, frontmatterFlag, frontmatterList, bookInputs, bookCheck, replayFind, replayStep, userSkills, notesFormat, profileIsEmpty, profileState, sampleInputs, dataRequest, todoLines, matchingInputs, referenceFile, placePlan, workspaceOf } from './plan-compiler.mjs';
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
    const chainDir = path.join(temp, 'outputs', '2026-09-광고애널리틱스', '045-weekly-ads-report');
    fs.mkdirSync(chainDir, { recursive: true });
    const chainRel = 'outputs/2026-09-광고애널리틱스';
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
    // 팀 이름으로 폴더를 지으면 막는다 · 원고와 책 실습 대본은 outputs/{YYYY-MM}-광고애널리틱스/ 다 (실측 2026-10-12 · 10장)
    const teamRel = 'outputs/2026-09-퍼포먼스마케팅팀';
    fs.mkdirSync(path.join(temp, teamRel), { recursive: true });
    const teamPlan = JSON.parse(JSON.stringify(chainPlan).replaceAll(chainRel, teamRel));
    fs.writeFileSync(path.join(temp, teamRel, 'plan.json'), `${JSON.stringify(teamPlan, null, 2)}\n`);
    const team = cli('plan-compiler.mjs', 'compile', `${teamRel}/plan.json`);
    assert.notEqual(team.status, 0, '체인 폴더가 아닌 곳(팀 이름 폴더)에 둔 체인 계획은 compile 이 막아야 한다');
    assert.match(team.stderr + team.stdout, /outputs\/\{YYYY-MM\}-광고애널리틱스\//, '어디로 옮길지 알려야 한다');
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
        // 입력을 계획 맨 위에 {path} · package: 로 적어도 같은 화면이 찍힌다 (실측 2026-09-24)
        const moved = { ...plan, inputs: plan.steps[0].inputs.map(v => ({ path: String(v).replace(/^plugin:/, 'package:') })),
          steps: plan.steps.map((st, i) => (i ? st : { ...st, inputs: [] })) };
        assert.equal(renderPlanScreen(moved, { cwd: screenCwd }), got, `${id} · 입력을 맨 위에 적으면 화면이 달라진다`);
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

  // 작동 검토 2026-09-22 #5·#6·#7
  {
    const chain = canonicalScreenPlan('광고애널리틱스');
    const at043 = chain.steps.findIndex(x => x.skill === '043');
    const p5 = structuredClone(chain);
    p5.steps[at043].inputs.push('workspace:inputs/reference.png');
    assert.deepEqual(validatePlan(p5), [], '체인 뒤 단계의 사용자 원본(inputs) 입력을 막았다 (#5)');
    const p5b = structuredClone(chain);
    p5b.steps[at043].inputs.push('workspace:outputs/2026-09-광고애널리틱스/999-x/없는것.md');
    assert.ok(validatePlan(p5b).some(i => i.includes('앞 단계가 만들지 않은')), '앞 단계가 안 만든 outputs 입력을 놓쳤다');
    const p6 = structuredClone(chain);
    const xlsx = p6.steps[at043].outputs.find(o => o.endsWith('.xlsx'));
    p6.형식 = { [path.posix.basename(xlsx)]: 'csv' };
    p6.steps[at043].outputs = p6.steps[at043].outputs.map(o => (o === xlsx ? o.replace(/\.xlsx$/, '.csv') : o));
    assert.deepEqual(validatePlan(p6), [], '한 단계의 형식 변경이 다른 단계에서 거부됐다 (#6)');
    assert.deepEqual(applyFormatChoice(['084-proposal-generator.pptx', '084-proposal-generator.docx', '084-proposal-generator.md'],
      { '084-proposal-generator.pptx': 'md', '084-proposal-generator.docx': 'md' }), ['084-proposal-generator.md'],
      '문서 스킬이 없을 때 .md 대체가 같은 이름 .md 와 합쳐지지 않았다 (#7)');
    assert.throws(() => applyFormatChoice(['a.xlsx', 'a.csv'], { 'a.xlsx': 'csv' }), /겹칩니다/, '다른 그릇끼리의 이름 충돌은 막아야 한다');
  }

  // 머리말이 다른 모양으로 와도 같은 값 (실측 2026-10-12 · 데스크톱 클라우드 동기화본이 `writes_to: "[…]"` 로
  // 따옴표를 씌워 계약이 빈 목록이 됐고 006 정상 산출물 셋이 「계약에 없는 산출물」로 거부됐다)
  {
    const 정본 = '---\nid: "006"\ngate: true\npii: true\nreview: 브랜드·고객   # 주석\nwrites_to: [outputs/{날짜}/a/a.xlsx, outputs/{날짜}/a/a-해설.md]   # 주석\n---\n';
    const 따옴표 = '---\nid: \'006\'\ngate: "true"\npii: \'true\'\nreview: "브랜드·고객"\nwrites_to: "[outputs/{날짜}/a/a.xlsx, outputs/{날짜}/a/a-해설.md]"\n---\n';
    const 여러줄 = '---\nid: 006\ngate: true\npii: "true"\nreview: \'브랜드·고객\'\nwrites_to:\n  - outputs/{날짜}/a/a.xlsx\n  - "outputs/{날짜}/a/a-해설.md"\n---\n# 본문\nwrites_to: [가짜]\n';
    // 뒤 주석까지 따옴표 안에 든 모양 · v0.69 는 이것을 시험하지 않아 실제 006 에서 다시 실패했다
    const 주석까지 = '---\nid: "006"\ngate: "true   # 주석"\npii: true\nreview: \'브랜드·고객   # 주석\'\nwrites_to: "[outputs/{날짜}/a/a.xlsx, outputs/{날짜}/a/a-해설.md]   # 🔴 주석"\n---\n';
    const 읽기 = t => [frontmatterField(t, 'id'), frontmatterFlag(t, 'gate'), frontmatterFlag(t, 'pii'), frontmatterField(t, 'review'), frontmatterList(t, 'writes_to')];
    for (const [이름, t] of [['따옴표', 따옴표], ['여러 줄', 여러줄], ['주석까지 따옴표', 주석까지]]) assert.deepEqual(읽기(t), 읽기(정본), `머리말 ${이름} 모양을 정본과 다르게 읽었다`);
    assert.equal(frontmatterList(정본, 'writes_to').length, 2, '정본 목록을 못 읽었다');
  }

  // 책 실습이면 계획 입력을 원고 계획의 입력으로 맞춘다 (실측 2026-10-12 · 「분석할 자료」 줄이 모델 입력에 따라 흔들렸다)
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'book-inputs-'));
    try {
      const D = '2026-10-12';
      for (const f of ['006-review-mining/006-review-mining-해설.md', '002-competitor-analysis/002-competitor-analysis.md']) {
        fs.mkdirSync(path.join(ws, 'outputs', D, path.dirname(f)), { recursive: true });
        fs.writeFileSync(path.join(ws, 'outputs', D, f), 'x');
      }
      const 계획 = (skill, folder, inputs) => ({ steps: [{ step: 1, skill, inputs, outputs: [`workspace:outputs/${D}/${folder}/${folder}.md`] }] });
      const a = 계획('002', '002-competitor-analysis', ['plugin:sample-data/경쟁사-3곳.md', `workspace:outputs/${D}/006-review-mining/006-review-mining-해설.md`]);
      assert.deepEqual(bookInputs(a, ws), ['plugin:sample-data/경쟁사-3곳.md'], '002 는 원고처럼 샘플만 입력이어야 한다');
      const b = 계획('011', '011-product-concept-ideation', ['plugin:sample-data/profile-sample.md']);
      assert.equal(bookInputs(b, ws)?.length, 2, '011 은 원고처럼 006·002 결과를 입력으로 맞춰야 한다');
      const c = 계획('011', '011-product-concept-ideation', ['workspace:inputs/내자료.md']);
      assert.equal(bookInputs(c, ws), null, '독자 자료가 있는데 입력을 바꿨다');
      fs.mkdirSync(path.join(ws, 'brand')); fs.writeFileSync(path.join(ws, 'brand', 'profile.md'), '# 우리 회사\n');
      assert.equal(bookInputs(계획('011', '011-product-concept-ideation', []), ws), null, '프로필을 채웠는데 입력을 바꿨다');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // 사용자 스킬 · brand/my-skills/{NNN}-{slug}/SKILL.md 의 계획이 compile 을 지난다 (2026-10-14 · 「그런 스킬이 없습니다」)
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'my-skills-'));
    try {
      const mine = (dir, head) => {
        fs.mkdirSync(path.join(ws, 'brand', 'my-skills', dir), { recursive: true });
        fs.writeFileSync(path.join(ws, 'brand', 'my-skills', dir, 'SKILL.md'), `---\n${head}\n---\n# 본문\n`);
      };
      mine('101-ad-stop-judge', 'id: "101"\nname: 광고 소재 중단 판정\ncategory: custom\nwrites_to: [outputs/{날짜}/101-ad-stop-judge/101-ad-stop-judge.md]');
      mine('046-copycat', 'id: "046"\nname: 베낀 것\ncategory: custom\nwrites_to: [outputs/{날짜}/046-copycat/046-copycat.md]');
      mine('102-bad-path', 'id: "102"\nname: 경로 틀림\ncategory: custom\nwrites_to: [outputs/102-bad-path.md]');
      mine('103-not-custom', 'id: "103"\nname: 종류 틀림\ncategory: 05-ads\nwrites_to: [outputs/{날짜}/103-not-custom/103-not-custom.md]');
      const u = userSkills(ws);
      assert.deepEqual([...u.map.keys()], ['101'], '형식이 맞는 사용자 스킬만 읽어야 한다');
      assert.equal(u.warnings.length, 3, '공식 번호 겹침 · 경로 틀림 · 종류 틀림을 각각 경고해야 한다');
      assert.equal(u.map.get('101').gate, true, 'gate 를 안 적은 사용자 스킬은 true 로 본다');
      assert.equal(skillDeclarations(ws).get('046').name, skillDeclarations(os.tmpdir()).get('046').name, '사용자 스킬이 공식 046 을 덮었다');
      const D = '2026-10-14';
      const dir101 = path.join(ws, 'outputs', D, '101-ad-stop-judge');
      fs.mkdirSync(dir101, { recursive: true });
      const p101 = { request: '이 소재 끌까 말까', skills: ['101'], steps: [{ step: 1, skill: '101', inputs: ['plugin:sample-data/A브랜드-메타광고-30일.csv'],
        outputs: [`workspace:outputs/${D}/101-ad-stop-judge/101-ad-stop-judge.md`], reviews: [{ kind: 'compliance' }] }] };
      fs.writeFileSync(path.join(dir101, 'plan.json'), JSON.stringify(p101));
      const r = spawnSync(process.execPath, [path.join(HERE, 'plan-compiler.mjs'), 'compile', `outputs/${D}/101-ad-stop-judge/plan.json`], { cwd: ws, encoding: 'utf8' });
      assert.equal(r.status, 0, `사용자 스킬 계획이 compile 에서 막혔다: ${r.stderr}`);
      assert.match(r.stdout, /공식 스킬 번호와 겹칩니다/, '공식 번호와 겹치는 사용자 스킬을 경고하지 않았다');
      const noGate = structuredClone(p101); noGate.steps[0].reviews = [];
      assert.ok(validatePlan(noGate, { cwd: ws }).some(i => i.includes('gate: true')), 'gate 를 안 적은 사용자 스킬의 규제 검사 누락을 놓쳤다');
      assert.ok(validatePlan(p101, { cwd: os.tmpdir() }).some(i => i.includes('그런 스킬이 없습니다')), '다른 작업 폴더의 사용자 스킬이 보였다');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // 스킬별 보완(brand/skill-notes/{번호}.md) · 형식 기본값 · 화면 줄 · 책 실습 끔 (2026-10-14)
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-notes-'));
    try {
      const note = (id, body) => { fs.mkdirSync(path.join(ws, 'brand', 'skill-notes'), { recursive: true }); fs.writeFileSync(path.join(ws, 'brand', 'skill-notes', `${id}.md`), body); };
      // (a) 형식 줄이 있고 계획에 형식이 없으면 채운다 · 산출물 확장자도 따라간다
      note('046', '# 046 우리 규칙\n형식: docx\n양식 원본: inputs/양식/예산안.docx\n');
      const p = canonicalScreenPlan('046');
      const said = notesFormat(p, ws);
      assert.deepEqual(p.형식, { '046-roas-budget-rebalance.md': 'docx' }, '보완 파일의 형식으로 계획을 채우지 않았다');
      assert.ok(p.steps[0].outputs[0].endsWith('046-roas-budget-rebalance.docx'), '채운 형식에 산출물 확장자가 따라가지 않았다');
      assert.equal(said.length, 1); assert.match(said[0], /형식을 docx로 채웠다/);
      assert.deepEqual(validatePlan(p, { cwd: ws }), [], '형식을 채운 계획이 계약 검사를 못 지났다');
      const kept = canonicalScreenPlan('046'); kept.형식 = { '046-roas-budget-rebalance.md': 'pdf' };
      kept.steps[0].outputs = kept.steps[0].outputs.map(o => o.replace(/\.md$/, '.pdf'));
      assert.deepEqual(notesFormat(kept, ws), [], '계획에 형식이 있으면 보완 파일이 덮지 않는다');
      assert.deepEqual(kept.형식, { '046-roas-budget-rebalance.md': 'pdf' });
      note('045', '형식: hwp\n');
      const bad = canonicalScreenPlan('045'); notesFormat(bad, ws);
      assert.equal(bad.형식, undefined, '모르는 그릇을 계획에 넣었다');
      // (b) 화면 · 보완 파일이 있으면 「근거로 쓰는 것」 끝에 붙는다 · 없으면 원고 화면 그대로(위 「찍힌 화면」 대조)
      const plain = renderPlanScreen(canonicalScreenPlan('046'), { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'skill-notes-empty-')) });
      const withNote = renderPlanScreen(canonicalScreenPlan('046'), { cwd: ws });
      const 근거 = t => t.split('\n').find(l => l.startsWith('근거로 쓰는 것:'));
      assert.equal(근거(withNote), `${근거(plain)} · 우리 양식 brand/skill-notes/046.md`, '보완 파일 줄이 화면에 붙지 않았다');
      assert.equal(withNote.replace(' · 우리 양식 brand/skill-notes/046.md', ''), plain, '보완 파일 줄 말고도 화면이 바뀌었다');
      // (c) 책 실습 · 보완 파일이나 회사 양식(inputs/양식/)이 있으면 원고 결과를 놓지 않는다
      const seal = plan => { plan.status = 'approved'; plan.approved_sha256 = planHash(plan); return plan; };
      const book = seal(canonicalScreenPlan('002'));
      assert.equal(bookCheck(book, fs.mkdtempSync(path.join(os.tmpdir(), 'book-plain-'))).ok, true, '보완 파일 없는 빈 프로필 002 는 책 실습이어야 한다');
      note('002', '# 002 우리 구조\n제외   17 경쟁사 비교\n');
      assert.equal(bookCheck(book, ws).ok, false, '보완 파일이 있는데 책 실습을 켰다');
      assert.equal(bookInputs(canonicalScreenPlan('002'), ws), null, '보완 파일이 있는데 원고 입력으로 바꿨다');
      const form = canonicalScreenPlan('002'); form.steps[0].inputs.push('workspace:inputs/양식/경쟁사-양식.xlsx'); seal(form);
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'book-form-'));
      assert.match(bookCheck(form, ws2).reason || '', /회사 양식/, '회사 양식 파일이 있는데 책 실습을 켰다');
      // 대본 장 · 첫 말로 여는 대본(6장 043)과 계획으로 이어지는 대본(10장 광고애널리틱스)
      const ws3 = fs.mkdtempSync(path.join(os.tmpdir(), 'book-replay-'));
      fs.mkdirSync(path.join(ws3, 'outputs'), { recursive: true });
      assert.ok(replayStep(ws3, '광고 카피 뽑아줘.')?.turn, '보완 파일 없으면 6장 대본이 열려야 한다');
      const ws4 = fs.mkdtempSync(path.join(os.tmpdir(), 'book-replay-note-'));
      fs.mkdirSync(path.join(ws4, 'outputs'), { recursive: true });
      fs.mkdirSync(path.join(ws4, 'brand', 'skill-notes'), { recursive: true }); fs.writeFileSync(path.join(ws4, 'brand', 'skill-notes', '043.md'), '형식: docx\n');
      assert.equal(replayStep(ws4, '광고 카피 뽑아줘.')?.turn, undefined, '043 보완 파일이 있는데 6장 대본을 열었다');
      const chain = canonicalScreenPlan('광고애널리틱스');
      const chainDir = path.join(ws4, 'outputs', '2026-09-광고애널리틱스');
      fs.mkdirSync(chainDir, { recursive: true });
      fs.writeFileSync(path.join(chainDir, 'plan.json'), JSON.stringify({ ...chain, status: 'awaiting-approval' }));
      assert.equal(replayFind(ws4), null, '체인 단계(043)에 보완 파일이 있는데 대본을 이었다');
      fs.rmSync(path.join(ws4, 'brand'), { recursive: true });
      assert.ok(replayFind(ws4), '보완 파일이 없으면 체인 대본이 이어져야 한다');
      chain.steps[0].inputs.push('workspace:inputs/양식/주간보고.pptx');
      fs.writeFileSync(path.join(chainDir, 'plan.json'), JSON.stringify({ ...chain, status: 'awaiting-approval' }));
      assert.equal(replayFind(ws4), null, '회사 양식 입력이 있는데 대본을 이었다');
      for (const d of [ws2, ws3, ws4]) fs.rmSync(d, { recursive: true, force: true });
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // 빈 프로필 판정 · §8 우리 팀과 내 역할은 뒤에 붙인 선택 절이다 · 옛 템플릿으로 구축한 빈 프로필도 빈 것이다 (2026-10-14)
  {
    const tpl = fs.readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'brand-templates', 'profile.md'), 'utf8');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-empty-'));
    fs.mkdirSync(path.join(ws, 'brand'));
    const 판정 = text => { fs.writeFileSync(path.join(ws, 'brand', 'profile.md'), text); return profileIsEmpty(ws); };
    assert.equal(판정(tpl), true, '새 템플릿 그대로인 프로필을 채움으로 봤다');
    assert.equal(판정(tpl.replace(/\n## 8\. 우리 팀과 내 역할[\s\S]*$/, '\n')), true, '§8 이 없는 옛 템플릿 프로필을 채움으로 봤다 · 책 실습이 꺼진다');
    assert.equal(판정(tpl.replace(/(\| 내 역할 \| )[^|]+\|/, '$1팀장 |')), false, '§8 만 채운 프로필을 빈 것으로 봤다');
    // 0바이트 · 공백 · 주석 · 안내 인용 · 자리표시만 있으면 「빈」 (검토 2026-10-14 · 0바이트와 주석 붙인 템플릿이 「채움」이었다)
    for (const [이름, text] of [['0바이트', ''], ['공백뿐', '  \n\n\t\n'], ['템플릿 + 주석', `${tpl}\n<!-- 검토 -->\n`], ['주석뿐', '<!--\n우리 회사\n-->\n'],
      ['안내 인용뿐', '> 여기에 쓴다\n> 나중에\n'], ['자리표시뿐', '| 브랜드명 | (예: 멍멍푸드) |\n- 업종: {업종}\n| 핵심 제품/서비스 (Top 3) | ① ② ③ |\n']]) {
      판정(text);
      assert.equal(profileState(ws), '빈', `${이름} 프로필을 「채움」으로 봤다`);
      assert.equal(profileIsEmpty(ws), true, `${이름} · profileIsEmpty 가 profileState 와 다르다`);
    }
    fs.rmSync(path.join(ws, 'brand', 'profile.md'));
    assert.equal(profileState(ws), '빈', '프로필 파일이 없는데 「채움」으로 봤다');
    판정(tpl.replace('| 브랜드명 | (우리 브랜드명) |', '| 브랜드명 | 팀플 |'));
    assert.equal(profileState(ws), '채움', '브랜드 한 줄만 있어도 「채움」이다');
    fs.rmSync(ws, { recursive: true, force: true });
  }

  // 샘플 자동 채움은 프로필 「빈」이거나 plan.실습 일 때만 · 채움이면 우리 자료를 달라고 한다 (2026-10-14 · 검토 P0 재현)
  {
    const tpl = fs.readFileSync(path.join(HERE, '..', 'brand-templates', 'profile.md'), 'utf8');
    const 채운 = tpl.replace('| 브랜드명 | (우리 브랜드명) |', '| 브랜드명 | 팀플 |')
      .replace(/(\| 업종 \(규제 카테고리\) \| )[^|]+\|/, '$1B2B 협업 서비스 |')
      .replace(/(\| 핵심 제품\/서비스 \(Top 3\) \| )[^|]+\|/, '$1팀 협업 툴 |');
    const 만들기 = (profile, extra = {}) => {
      const w = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-gate-'));
      fs.mkdirSync(path.join(w, 'brand'), { recursive: true });
      if (profile !== null) fs.writeFileSync(path.join(w, 'brand', 'profile.md'), profile);
      const D = '2026-10-14', d = `outputs/${D}/006-review-mining`;
      fs.mkdirSync(path.join(w, d), { recursive: true });
      const o = n => `workspace:${d}/${n}`;
      const plan = { request: '리뷰 분석해줘', skills: ['006'], ...extra, steps: [{ step: 1, skill: '006', inputs: [],
        outputs: [o('006-review-mining.xlsx'), o('006-review-mining.html'), o('006-review-mining-해설.md')], reviews: [{ kind: 'compliance' }] }] };
      fs.writeFileSync(path.join(w, d, 'plan.json'), JSON.stringify(plan));
      const r = spawnSync(process.execPath, [path.join(HERE, 'plan-compiler.mjs'), 'compile', `${d}/plan.json`], { cwd: w, encoding: 'utf8' });
      return { w, r, plan: JSON.parse(fs.readFileSync(path.join(w, d, 'plan.json'), 'utf8')), file: `${d}/plan.json` };
    };
    // (1) 프로필 채움 · 리뷰 없음 · 006 빈 입력 → 샘플이 들어가지 않는다
    const a = 만들기(채운);
    assert.equal(a.r.status, 0, a.r.stderr);
    assert.deepEqual(a.plan.steps[0].inputs, [], '프로필을 채웠는데 A브랜드 리뷰를 넣었다');
    assert.equal(sampleInputs({ steps: [{ skill: '006', inputs: [] }] }, a.w), null, 'sampleInputs 가 채운 프로필에 샘플을 돌려줬다');
    assert.match(a.r.stdout, /📎 우리 자료가 없습니다 · 리뷰·댓글·CS 데이터를 inputs\/ 에 넣거나 대화에 붙여 주세요 · 샘플로 회사 결론을 내지 않는다/, 'compile 이 우리 자료를 달라는 줄을 내지 않았다');
    assert.doesNotMatch(a.r.stdout, /샘플 자료로 채웠다/);
    assert.ok(a.plan.screen.includes('분석할 자료: 우리 자료가 아직 없습니다 · 리뷰·댓글·CS 데이터를 inputs 폴더에 넣거나 대화에 붙여 주시면 그 자료로 분석합니다.'), '화면 「분석할 자료」 줄이 우리 자료를 달라고 하지 않았다');
    assert.ok(!a.plan.screen.includes('[샘플]'), '채운 프로필 화면에 샘플 줄이 남았다');
    assert.ok(a.plan.screen.includes('우리 자료로 하려면'), '자료가 없으면 내려받는 길을 함께 보여야 한다');
    assert.ok(!a.plan.screen.includes('업종: 「우리는 반려동물 사료야」'), '프로필에 업종이 있는데 업종을 다시 물었다');
    assert.ok(a.plan.screen.includes('분석 기간: 기본은 최근 7일'), '업종 말고 다른 질문까지 뺐다');
    assert.equal(dataRequest({ ...a.plan, 실습: true }, a.w), null, '실습이면 우리 자료를 달라고 하지 않는다');
    // (2) 같은 상황에 「샘플로 실습」(plan.실습) → 샘플이 들어간다 · 책 실습은 아니다(프로필이 채움)
    const b = 만들기(채운, { 실습: true });
    assert.deepEqual(b.plan.steps[0].inputs, ['plugin:sample-data/A브랜드-리뷰-200건.csv'], '실습인데 샘플을 넣지 않았다');
    assert.match(b.r.stdout, /📎 inputs 가 비어 샘플 자료로 채웠다/);
    spawnSync(process.execPath, [path.join(HERE, 'plan-compiler.mjs'), 'approve', b.file], { cwd: b.w, encoding: 'utf8' });
    assert.match(bookCheck(JSON.parse(fs.readFileSync(path.join(b.w, b.file), 'utf8')), b.w).reason || '', /프로필을 채웠다/, '채운 프로필 실습에 원고 결과를 놓으려 했다');
    // (3) 빈 프로필(템플릿 그대로 · 0바이트 · 없음) + 006 → 샘플이 들어가고 책 실습 그대로 · 화면은 원고와 같다
    const 원고화면 = renderPlanScreen(canonicalScreenPlan('006'), { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'sample-gate-none-')) });
    for (const [이름, profile] of [['템플릿', tpl], ['0바이트', ''], ['없음', null]]) {
      const c = 만들기(profile);
      assert.deepEqual(c.plan.steps[0].inputs, ['plugin:sample-data/A브랜드-리뷰-200건.csv'], `${이름} 프로필인데 샘플을 넣지 않았다`);
      assert.doesNotMatch(c.r.stdout, /우리 자료가 없습니다|📝 할 일/, `${이름} 프로필에 채움 안내를 냈다`);
      assert.equal(c.plan.screen.replace(/2026-10-14/g, '2026-09-15'), 원고화면, `${이름} 프로필 화면이 원고와 다르다`);
      spawnSync(process.execPath, [path.join(HERE, 'plan-compiler.mjs'), 'approve', c.file], { cwd: c.w, encoding: 'utf8' });
      assert.equal(bookCheck(JSON.parse(fs.readFileSync(path.join(c.w, c.file), 'utf8')), c.w).ok, true, `${이름} 프로필 006 이 책 실습이 아니다`);
      fs.mkdirSync(path.join(c.w, 'outputs'), { recursive: true });
      assert.ok(replayStep(c.w, '광고 카피 뽑아줘.')?.turn, `${이름} 프로필에서 6장 대본이 열리지 않았다`);
      fs.rmSync(c.w, { recursive: true, force: true });
    }
    // (4) 067 · §4 숫자가 있거나 광고 채널이 없으면 「월 목표」를 묻지 않는다 · 생성 스킬(sample_fallback 없음)은 자료를 달라고 하지 않는다
    const f = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-067-'));
    fs.mkdirSync(path.join(f, 'brand'));
    const 월목표 = () => renderPlanScreen(canonicalScreenPlan('067'), { cwd: f }).includes('월 목표: 목표 ROAS나 월 예산');
    fs.writeFileSync(path.join(f, 'brand', 'profile.md'), 채운);
    assert.equal(월목표(), true, '§4 가 비고 채널도 모르면 월 목표를 물어야 한다');
    fs.writeFileSync(path.join(f, 'brand', 'profile.md'), 채운.replace(/(\| 목표 ROAS \| )\|/, '$1300% |'));
    assert.equal(월목표(), false, '§4 에 목표 ROAS 가 있는데 월 목표를 다시 물었다');
    fs.writeFileSync(path.join(f, 'brand', 'profile.md'), 채운.replace('| (채널1) | | |', '| 네이버 블로그 | 운영 | 월 방문 3천 |'));
    assert.equal(월목표(), false, '광고 채널이 없는데 월 목표(ROAS)를 물었다');
    fs.writeFileSync(path.join(f, 'brand', 'profile.md'), 채운.replace('| (채널1) | | |', '| 메타 광고 | 운영 | ROAS 250% |'));
    assert.equal(월목표(), true, '광고 채널이 있고 §4 가 비었으면 월 목표를 물어야 한다');
    assert.equal(dataRequest(canonicalScreenPlan('013') && { steps: [{ skill: '013', inputs: [] }] }, f), null, '프로필만으로 되는 생성 스킬(013)에 자료를 달라고 했다');
    assert.equal(dataRequest({ steps: [{ skill: '043', inputs: [] }] }, f), null, '스킬이 읽지 않는 고아 sample_fallback(043)으로 자료를 달라고 했다');
    // (5) 할 일 줄 · 회사 양식(양식 원본)이 있고 정한 날이 없으면 · §8 역할과 보고 대상이 있으면
    fs.mkdirSync(path.join(f, 'brand', 'skill-notes'));
    fs.writeFileSync(path.join(f, 'brand', 'skill-notes', '067.md'), '# 067\n양식 원본: inputs/양식/월간보고.docx\n');
    let todo = todoLines({ steps: [{ skill: '067' }] }, f);
    assert.deepEqual(todo, ['📝 할 일 · 회사 양식에서 고칠 점을 3개 이하로 제안하고 승인받은 것만 skill-notes 에 남긴다(정한 날 기록) · brand/skill-notes/067.md'], '양식 원본만 있고 정한 날이 없는데 할 일 줄이 없다');
    fs.appendFileSync(path.join(f, 'brand', 'skill-notes', '067.md'), '정한 날 2026-10-14\n');
    assert.deepEqual(todoLines({ steps: [{ skill: '067' }] }, f), [], '정한 날이 있는데 다시 고칠 점을 제안하라고 했다');
    fs.writeFileSync(path.join(f, 'brand', 'profile.md'), 채운.replace(/(\| 내 역할 \| )[^|]+\|/, '$1팀장 |').replace(/(\| 결과물을 보고받는 사람 \| )[^|]+\|/, '$1대표 |'));
    todo = todoLines({ steps: [{ skill: '067' }] }, f);
    assert.deepEqual(todo, ['📝 할 일 · 보고 대상 대표 · 역할 팀장 → docs/공통규약.md §0-a 표대로 첫 장·길이를 맞춘다'], '§8 을 채웠는데 보고 대상 할 일 줄이 없다');
    const 화면 = renderPlanScreen(canonicalScreenPlan('067'), { cwd: f });
    assert.ok(!화면.includes('📝'), '할 일 줄이 계획 화면 안에 들어갔다');
    for (const d of [a.w, b.w, f]) fs.rmSync(d, { recursive: true, force: true });
  }
  // ── v0.72.31 실측 회사 A·B · 책 실습 (2026-10-14) ──────────────────────────────
  {
    const tpl = fs.readFileSync(path.join(HERE, '..', 'brand-templates', 'profile.md'), 'utf8');
    const 채운 = tpl.replace('| 브랜드명 | (우리 브랜드명) |', '| 브랜드명 | 모래결 |')
      .replace(/(\| 업종 \(규제 카테고리\) \| )[^|]+\|/, '$1화장품 |');
    const PC = path.join(HERE, 'plan-compiler.mjs');
    const pcIn = (w, ...a) => spawnSync(process.execPath, [PC, ...a], { cwd: w, encoding: 'utf8' });
    const RR = path.join(HERE, 'run-receipt.mjs');
    const rrIn = (w, ...a) => spawnSync(process.execPath, [RR, ...a], { cwd: w, encoding: 'utf8' });
    const 공간 = (profile, files = {}) => {
      const w = fs.mkdtempSync(path.join(os.tmpdir(), 'v07231-'));
      for (const d of ['brand', 'inputs', 'outputs', 'logs']) fs.mkdirSync(path.join(w, d), { recursive: true });
      if (profile !== null) fs.writeFileSync(path.join(w, 'brand', 'profile.md'), profile);
      for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(w, rel)), { recursive: true }); fs.writeFileSync(path.join(w, rel), text); }
      return w;
    };
    const 읽기 = (w, rel) => JSON.parse(fs.readFileSync(path.join(w, rel), 'utf8'));
    const 계획쓰기 = (w, rel, plan) => { fs.mkdirSync(path.dirname(path.join(w, rel)), { recursive: true }); fs.writeFileSync(path.join(w, rel), `${JSON.stringify(plan, null, 2)}\n`); };
    const D = '2026-10-14', F006 = `outputs/${D}/006-review-mining`;
    const o006 = (dir, n = '') => [`workspace:${dir}/006-review-mining${n}.xlsx`, `workspace:${dir}/006-review-mining${n}.html`, `workspace:${dir}/006-review-mining-해설${n}.md`];

    // (1) 회사 B S7 · 같은 날 실데이터 006 뒤 「샘플로 실습해볼래. 리뷰 분석」 · 계획을 006-review-mining-2/ 에 썼다 (B 의 실제 plan.json 모양)
    const 리뷰csv = '리뷰ID,작성일,평점,옵션,리뷰\nR001,2026-09-02,2,핸드·바디 선물 세트,생각보다 향이 약해서 아쉬웠어요\nR002,2026-09-03,3,핸드·바디 선물 세트,세일할 때 사려고요\n';
    const wB = 공간(채운, { 'inputs/리뷰_자사몰.csv': 리뷰csv, 'inputs/좋았던_인스타글.md': '# 좋았던 글\n' });
    계획쓰기(wB, `${F006}/plan.json`, { schema: 'marketing-team.plan/v1', request: '자사몰 리뷰 넣었어. inputs/리뷰_자사몰.csv 로 리뷰 분석해줘', skills: ['006'], requested_order: [],
      steps: [{ step: 1, skill: '006', inputs: ['workspace:inputs/리뷰_자사몰.csv'], outputs: o006(F006), reviews: [{ kind: 'compliance' }] }] });
    assert.equal(pcIn(wB, 'compile', `${F006}/plan.json`).status, 0);
    assert.equal(pcIn(wB, 'approve', `${F006}/plan.json`).status, 0);
    const 실계획 = fs.readFileSync(path.join(wB, F006, 'plan.json'), 'utf8');
    // 앞 실행 영수증 · B 의 run.json 그대로(run_id·completed·실데이터)
    fs.writeFileSync(path.join(wB, F006, 'run.json'), JSON.stringify({ schema: 'marketing-team.run/v1', run_id: '20261014090624-006-bcd64a', status: 'completed',
      plan: { plan_sha256: JSON.parse(실계획).plan_sha256, plan_id: null }, data_mode: '실데이터',
      inputs: [{ path: 'workspace:inputs/리뷰_자사몰.csv', period: '2026-09-01~2026-09-28' }], outputs: o006(F006).map(p => ({ path: p })) }));
    // (1-a) B 가 끝에 한 것 · 같은 폴더 plan.json 을 샘플 계획으로 덮어 compile → 막고 새 자리를 알린다
    계획쓰기(wB, `${F006}/plan.json`, { schema: 'marketing-team.plan/v1', request: '샘플로 실습해볼래. 리뷰 분석', 실습: true, skills: ['006'], requested_order: [],
      steps: [{ step: 1, skill: '006', inputs: ['plugin:sample-data/A브랜드-리뷰-200건.csv'],
        outputs: [`workspace:${F006}/006-review-mining-2.xlsx`, `workspace:${F006}/006-review-mining-2.html`, `workspace:${F006}/006-review-mining-2-해설.md`], reviews: [{ kind: 'compliance' }] }],
      형식: { '006-review-mining-2.xlsx': 'xlsx', '006-review-mining-2.html': 'html', '006-review-mining-2-해설.md': 'md' }, risks: [] });
    let r = pcIn(wB, 'compile', `${F006}/plan.json`);
    assert.notEqual(r.status, 0, '앞 실행(run.json)이 돈 plan.json 을 덮은 계획을 compile 이 받아들였다');
    assert.match(r.stderr, /이미 돈 실행\(run\.json · 20261014090624-006-bcd64a\)의 계획/, '어느 실행의 계획인지 알리지 않았다');
    assert.match(r.stderr, /plan-2\.json · 영수증 run-2\.json · 산출물 006-review-mining-2\.xlsx · 006-review-mining-2\.html · 006-review-mining-해설-2\.md/, '새 자리(순번 2)를 알리지 않았다');
    assert.equal(pcIn(wB, 'approve', `${F006}/plan.json`).status === 0, false, '앞 실행의 계획 자리에 다른 계획을 봉인했다');
    fs.writeFileSync(path.join(wB, F006, 'plan.json'), 실계획);
    r = pcIn(wB, 'compile', `${F006}/plan.json`);
    assert.equal(r.status, 0, '이미 돈 같은 계획을 다시 compile 하면 그대로 두어야 한다');
    assert.match(r.stdout, /이미 승인되어 실행한 계획/);
    assert.equal(fs.readFileSync(path.join(wB, F006, 'plan.json'), 'utf8'), 실계획, '이미 돈 계획을 다시 compile 해 상태를 풀었다');
    // (1-b) B S7 처음 모양 · 006-review-mining-2/plan.json (B 가 쓴 글자 그대로) → 같은 폴더 plan-2.json 으로 옮기고 산출물은 -2
    const F2 = `outputs/${D}/006-review-mining-2`;
    계획쓰기(wB, `${F2}/plan.json`, { schema: 'marketing-team.plan/v1', request: '샘플로 실습해볼래. 리뷰 분석', 실습: true, skills: ['006'], requested_order: [],
      steps: [{ step: 1, skill: '006', inputs: ['plugin:sample-data/A브랜드-리뷰-200건.csv'], outputs: o006(F2), reviews: [{ kind: 'compliance' }] }],
      형식: { '006-review-mining.xlsx': 'xlsx', '006-review-mining.html': 'html', '006-review-mining-해설.md': 'md' },
      chain_graph: { schema: 'marketing-team.chain/v1', chain: null, nodes: [{ step: 1, skill: '006' }], edges: [] }, risks: [] });
    r = pcIn(wB, 'compile', `${F2}/plan.json`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /📁 스킬 폴더로 옮겼다 · outputs\/2026-10-14\/006-review-mining-2\/plan\.json → outputs\/2026-10-14\/006-review-mining\/plan-2\.json · 같은 날 2번째 실행 · 산출물 이름 끝에 -2 · 영수증 run-2\.json/);
    assert.equal(fs.existsSync(path.join(wB, F2)), false, '옮긴 뒤 빈 006-review-mining-2/ 폴더가 남았다');
    assert.equal(fs.readFileSync(path.join(wB, F006, 'plan.json'), 'utf8'), 실계획, '앞 실행의 plan.json 이 바뀌었다');
    const 둘째 = 읽기(wB, `${F006}/plan-2.json`);
    assert.deepEqual(둘째.steps[0].outputs, o006(F006, '-2'), '산출물 이름이 같은 날 재실행 규칙(-2 · 해설-2)과 다르다');
    assert.ok(둘째.screen.includes(`나오는 곳: ${F006}/`), '화면의 나오는 곳이 계획 폴더와 다르다');
    // (4) 실습 화면의 샘플 이유 · 리뷰 csv 가 있는데 「리뷰 파일이 없어」라고 하지 않는다
    assert.ok(둘째.screen.includes('분석할 자료: 실습을 고르셔서 연습용 A브랜드(화장품) 리뷰 200건으로 돌립니다. 결과에는 [샘플]이 붙습니다.'), '실습 화면이 실습을 고른 이유를 적지 않았다');
    assert.ok(!둘째.screen.includes('리뷰 파일이 없어'), '리뷰 파일이 있는데 「없어」라고 적었다');
    // (4-b) 실습은 연습용 A브랜드 프로필로 읽는다 · 회사 프로필(brand/profile.md)을 샘플 해석의 근거로 적지 않는다 (2026-10-14 · 회사 A·B)
    assert.ok(둘째.screen.includes('근거로 쓰는 것: 실습을 고르셔서 연습용 A브랜드 프로필을 씁니다.'), '실습 화면의 근거가 연습용 프로필이 아니다');
    assert.ok(!둘째.screen.includes('brand/profile.md'), '실습 화면에 회사 프로필이 근거로 찍혔다');
    assert.match(r.stdout, /📖 실습은 연습용 A브랜드 프로필로 읽는다 · 회사 기준\(brand\/profile\.md · 우리 양식\)을 샘플 해석에 붙이지 않는다/);
    // 영수증 짝 · run-2.json 은 plan-2.json 과 맞춘다 · plan-2.json 이 없으면 앞 실행의 plan.json 을 빌리지 않는다
    assert.equal(pcIn(wB, 'approve', `${F006}/plan-2.json`).status, 0);
    const 영수증2 = { schema: 'marketing-team.run/v1', status: 'draft', request: '샘플로 실습해볼래. 리뷰 분석. 진행 승인', skills: ['006'], data_mode: '샘플', 단계: '최종',
      형식: { '006-review-mining.xlsx': 'xlsx', '006-review-mining.html': 'html', '006-review-mining-해설.md': 'md' },
      inputs: [{ path: 'plugin:sample-data/A브랜드-리뷰-200건.csv', period: '2026-06-01~2026-07-31' }], profile: { path: 'workspace:brand/profile.md' },
      pii: { source: 'plugin:sample-data/A브랜드-리뷰-200건.csv', id_columns: [], surrogate_column: '번호' },
      outputs: o006(F006, '-2').map(p => ({ path: p })), required_reviews: o006(F006, '-2').map(a => ({ kind: 'compliance', artifact: a })),
      ledger: { path: 'workspace:logs/build-log.md' } };
    fs.renameSync(path.join(wB, F006, 'plan-2.json'), path.join(wB, F006, '.plan-2.json'));
    fs.writeFileSync(path.join(wB, F006, 'run-2.json'), JSON.stringify(영수증2));
    r = rrIn(wB, 'start', `${F006}/run-2.json`);
    assert.notEqual(r.status, 0, 'run-2.json 이 앞 실행의 plan.json 을 계획으로 빌렸다');
    assert.match(r.stderr, /run-2\.json 의 계획은 plan-2\.json 입니다/);
    fs.renameSync(path.join(wB, F006, '.plan-2.json'), path.join(wB, F006, 'plan-2.json'));
    r = rrIn(wB, 'start', `${F006}/run-2.json`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(읽기(wB, `${F006}/run-2.json`).plan.plan_sha256, 둘째.plan_sha256, 'run-2.json 이 plan-2.json 으로 봉인되지 않았다');
    // 다음 재실행 자리는 3 · 시작한 run-2 의 plan-2 도 덮지 않는다
    r = pcIn(wB, 'compile', `${F006}/plan-2.json`);
    assert.equal(r.status, 0, '이미 돈 같은 plan-2 를 다시 compile 하면 그대로 둔다');
    fs.rmSync(wB, { recursive: true, force: true });

    // (2)·(6) 회사 A · 회사 양식(inputs/양식/ · §8)과 brand/ 만 있으면 067 은 「우리 자료가 없습니다」 · 리뷰·문의 csv 는 006 의 자료다
    const A프로필 = 채운.replace(/(\| 자주 쓰는 회사 양식 \| )[^|]+\|/, '$1`inputs/양식/월간마케팅보고_양식.docx` (스킬 067) · `inputs/양식/제안서_양식.pptx` (스킬 084) |');
    const wA = 공간(A프로필, { 'inputs/양식/월간마케팅보고_양식.docx': 'docx', 'inputs/양식/제안서_양식.pptx': 'pptx',
      'inputs/VOC_고객문의_30건.csv': '번호,문의\n1,배송\n', 'inputs/좋았던_링크드인글.md': '# 글\n', 'brand/디자인/가이드.md': '# 가이드\n' });
    const F067 = `outputs/${D}/067-monthly-report`;
    계획쓰기(wA, `${F067}/plan.json`, { request: '이번 달 마케팅 성과 보고서 만들어줘', skills: ['067'], steps: [{ step: 1, skill: '067',
      inputs: ['workspace:brand/profile.md', 'workspace:brand/디자인/가이드.md', 'workspace:inputs/양식/월간마케팅보고_양식.docx'],
      outputs: [`workspace:${F067}/067-monthly-report.xlsx`, `workspace:${F067}/067-monthly-report.html`], reviews: [{ kind: 'business', perspective: '재무' }] }] });
    r = pcIn(wA, 'compile', `${F067}/plan.json`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /📎 우리 자료가 없습니다 · 전 채널 월간 데이터를 inputs\/ 에 넣거나/, '회사 양식과 brand/ 만 있는데 자료가 있다고 봤다');
    assert.ok(읽기(wA, `${F067}/plan.json`).screen.includes('분석할 자료: 우리 자료가 아직 없습니다 · 전 채널 월간 데이터를 inputs 폴더에'), '067 화면에 「우리 자료가 아직 없습니다」가 없다');
    const decl = skillDeclarations(wA);
    assert.deepEqual(matchingInputs(wA, decl.get('067')), [], '회사 양식·VOC·좋았던 글을 067 의 자료로 셌다');
    assert.deepEqual(matchingInputs(wA, decl.get('006')), ['inputs/VOC_고객문의_30건.csv'], 'VOC 고객문의 csv 를 006 의 자료로 보지 않았다');
    assert.equal(dataRequest({ steps: [{ skill: '006', inputs: [] }] }, wA), null, '006 자료(VOC csv)가 있는데 달라고 했다');
    assert.equal(referenceFile(wA, 'inputs/양식/제안서_양식.pptx') && referenceFile(wA, 'inputs/좋았던_링크드인글.md') && referenceFile(wA, 'brand/디자인/가이드.md'), true);
    // §8 에만 적힌 양식(inputs/양식/ 밖)도 회사 양식이다
    fs.writeFileSync(path.join(wA, 'brand', 'profile.md'), A프로필.replace('`inputs/양식/제안서_양식.pptx`', '`inputs/월간보고_틀.xlsx`'));
    fs.writeFileSync(path.join(wA, 'inputs', '월간보고_틀.xlsx'), 'x');
    assert.equal(referenceFile(wA, 'inputs/월간보고_틀.xlsx'), true, '프로필 §8 「자주 쓰는 회사 양식」에 적힌 파일을 업무 자료로 봤다');
    assert.deepEqual(matchingInputs(wA, decl.get('067')), [], '§8 회사 양식을 067 자료로 셌다');
    fs.writeFileSync(path.join(wA, 'inputs', '9월_채널별_성과.csv'), 'a,b\n');
    assert.deepEqual(matchingInputs(wA, decl.get('067')), ['inputs/9월_채널별_성과.csv'], '채널별 성과 csv 를 067 자료로 보지 않았다');
    fs.rmSync(wA, { recursive: true, force: true });
    // 회사 B 045 · 리뷰 csv·좋았던 글만 있다 · 광고 자료가 아니다 · sample_fallback 이 없는 096 도 견적서를 달라고 한다(6)
    const wB2 = 공간(채운, { 'inputs/리뷰_자사몰.csv': 리뷰csv, 'inputs/좋았던_인스타글.md': '# 글\n' });
    assert.equal(dataRequest({ steps: [{ skill: '045', inputs: [] }] }, wB2), '매체별 광고 데이터 소스', '리뷰 csv 를 045 광고 자료로 봤다');
    assert.equal(dataRequest({ steps: [{ skill: '006', inputs: [] }] }, wB2), null, '리뷰 csv 가 있는데 006 자료를 달라고 했다');
    assert.equal(dataRequest({ steps: [{ skill: '096', inputs: [] }] }, wB2), '견적서 2개 이상', 'sample_fallback 이 없는 096 이 자료(견적서)를 달라고 하지 않았다');
    // 096 은 화면 틀이 없다 · compile 안내 줄로 본다 · 화면 줄은 틀이 있는 045 로 본다 (회사 B S6 · 045 화면에 줄이 없었다)
    const F096 = `outputs/${D}/096-quote-comparison`;
    계획쓰기(wB2, `${F096}/plan.json`, { request: '견적 비교해줘', skills: ['096'], steps: [{ step: 1, skill: '096', inputs: [],
      outputs: [`workspace:${F096}/096-quote-comparison.csv`, `workspace:${F096}/096-quote-comparison-해설.md`],
      reviews: [{ kind: 'business', perspective: '법무' }, { kind: 'business', perspective: '재무' }] }] });
    r = pcIn(wB2, 'compile', `${F096}/plan.json`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /📎 우리 자료가 없습니다 · 견적서 2개 이상을 inputs\/ 에 넣거나/, '096 compile 이 자료를 달라는 줄을 내지 않았다');
    const F045 = `outputs/${D}/045-weekly-ads-report`;
    const s045 = renderPlanScreen({ request: '이번 달 광고 어땠어? 045로 해줘. 광고 파일은 지금 없으니 할 수 있는 것만.', skills: ['045'],
      steps: [{ step: 1, skill: '045', inputs: [], outputs: [`workspace:${F045}/045-weekly-ads-report.html`], reviews: [] }] }, { cwd: wB2 });
    assert.ok(s045.includes('분석할 자료: 우리 자료가 아직 없습니다 · 매체별 광고 데이터 소스를 inputs 폴더에'), '045 화면에 「분석할 자료」 요청 줄이 없다');
    for (const id of ['013', '028', '051', '084']) assert.equal(dataRequest({ steps: [{ skill: id, inputs: [] }] }, wB2), null, `프로필만으로 만드는 생성 스킬(${id})에 자료를 달라고 했다`);
    fs.rmSync(wB2, { recursive: true, force: true });
    // 빈 프로필 · inputs/ 의 레퍼런스 그림(10장)은 045 의 자료가 아니다 · 샘플로 채운다 (예전엔 inputs/ 에 무엇이든 있으면 채우지 않았다)
    const w10 = 공간(tpl, { 'inputs/광고 소재 레퍼런스/A브랜드-광고소재-참고레퍼런스.png': 'png' });
    assert.deepEqual(sampleInputs({ steps: [{ skill: '045', inputs: [] }] }, w10), ['plugin:sample-data/A브랜드-광고매체통합-12주.csv'], '레퍼런스 그림 때문에 샘플을 채우지 않았다');
    fs.writeFileSync(path.join(w10, 'inputs', '메타광고_9월.csv'), 'a,b\n');
    assert.equal(sampleInputs({ steps: [{ skill: '045', inputs: [] }] }, w10), null, '광고 자료가 있는데 샘플로 채웠다');
    fs.rmSync(w10, { recursive: true, force: true });

    // (7) 책 실습 10장 · 모델이 팀 이름 폴더에 쓴 체인 계획(실측 글자 그대로) · compile 이 체인 폴더로 옮기고 옛 폴더를 지운다 · 대본이 그 폴더를 찾는다
    const w7 = 공간(tpl, { 'inputs/광고 소재 레퍼런스/A브랜드-광고소재-참고레퍼런스.png': 'png' });
    const 팀 = 'outputs/2026-10-퍼포먼스마케팅팀', 바른 = 'outputs/2026-10-광고애널리틱스';
    const wsr = (dir, sk, n) => `workspace:${dir}/${sk}/${n}`;
    계획쓰기(w7, `${팀}/plan.json`, { schema: 'marketing-team.plan/v1', plan_id: '2026-10-14-퍼포먼스마케팅팀', request: '퍼포먼스 마케팅 팀 업무 시작하자.', chain: '광고애널리틱스',
      skills: ['045', '046', '043'], steps: [
        { step: 1, skill: '045', inputs: ['plugin:sample-data/A브랜드-광고매체통합-12주.csv'], outputs: [wsr(팀, '045-weekly-ads-report', '045-weekly-ads-report.html')], reviews: [] },
        { step: 2, skill: '046', inputs: ['plugin:sample-data/A브랜드-광고매체통합-12주.csv', wsr(팀, '045-weekly-ads-report', '045-weekly-ads-report.html')],
          outputs: [wsr(팀, '046-roas-budget-rebalance', '046-roas-budget-rebalance.md')], reviews: [{ kind: 'business', perspective: '재무' }] },
        { step: 3, skill: '043', inputs: [wsr(팀, '046-roas-budget-rebalance', '046-roas-budget-rebalance.md'), 'workspace:inputs/광고 소재 레퍼런스/A브랜드-광고소재-참고레퍼런스.png'],
          outputs: [wsr(팀, '043-meta-ad-copy', '043-meta-ad-copy.xlsx'), wsr(팀, '043-meta-ad-copy', '043-meta-ad-copy.md')], reviews: [{ kind: 'compliance' }] }],
      risks: [] });
    r = pcIn(w7, 'compile', `${팀}/plan.json`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /📁 체인 폴더로 옮겼다 · outputs\/2026-10-퍼포먼스마케팅팀\/plan\.json → outputs\/2026-10-광고애널리틱스\/plan\.json/);
    assert.equal(fs.existsSync(path.join(w7, 팀)), false, '팀 이름 폴더가 남았다');
    const 체인 = 읽기(w7, `${바른}/plan.json`);
    assert.ok(체인.steps.flatMap(st => st.outputs).every(v => v.startsWith(`workspace:${바른}/`)), '산출물이 체인 폴더로 옮겨지지 않았다');
    assert.ok(체인.steps[1].inputs.includes(wsr(바른, '045-weekly-ads-report', '045-weekly-ads-report.html')), '앞 단계 산출물을 읽는 입력을 고치지 않았다');
    assert.ok(!JSON.stringify(체인).includes('퍼포먼스마케팅팀/'), '옛 폴더 경로가 계획에 남았다');
    assert.ok(체인.screen.includes(`나오는 곳: ${바른}/`));
    assert.equal(pcIn(w7, 'approve', `${바른}/plan.json`).status, 0);
    assert.equal(replayFind(w7)?.name, '광고애널리틱스', '옮긴 체인 폴더를 책 실습 대본이 찾지 못했다');
    fs.rmSync(w7, { recursive: true, force: true });

    // (8) 책 실습 11장 · 모델이 `cd {플러그인}/100-skills && head …` 를 돌려 셸 cwd 가 플러그인 안에 남은 채 절대 경로로 compile 했다 ·
    //     cwd 기준으로 재자 계획이 플러그인 안 100-skills/outputs/ 로 옮겨지고 작업 폴더의 원본이 지워졌다 (실측 2026-10-14)
    const 플안 = path.join(HERE, '..', '100-skills');
    const 플산출 = path.join(플안, 'outputs');
    const 플산출있었나 = fs.existsSync(플산출);
    const 체인계획 = dir => ({ schema: 'marketing-team.plan/v1', plan_id: '2026-10-14-광고애널리틱스', request: '퍼포먼스 마케팅 팀 업무 시작하자.', chain: '광고애널리틱스',
      skills: ['045', '046', '043'], steps: [
        { step: 1, skill: '045', inputs: ['plugin:sample-data/A브랜드-광고매체통합-12주.csv'], outputs: [wsr(dir, '045-weekly-ads-report', '045-weekly-ads-report.html')], reviews: [] },
        { step: 2, skill: '046', inputs: ['plugin:sample-data/A브랜드-광고매체통합-12주.csv', wsr(dir, '045-weekly-ads-report', '045-weekly-ads-report.html')],
          outputs: [wsr(dir, '046-roas-budget-rebalance', '046-roas-budget-rebalance.md')], reviews: [{ kind: 'business', perspective: '재무' }] },
        { step: 3, skill: '043', inputs: [wsr(dir, '046-roas-budget-rebalance', '046-roas-budget-rebalance.md')],
          outputs: [wsr(dir, '043-meta-ad-copy', '043-meta-ad-copy.xlsx'), wsr(dir, '043-meta-ad-copy', '043-meta-ad-copy.md')], reviews: [{ kind: 'compliance' }] }],
      risks: [] });
    // (8-a) 바른 자리 · 절대 경로 · cwd 는 플러그인 안 → 옮기지 않고 그대로 compile 된다
    const w8 = 공간(tpl);
    계획쓰기(w8, `${바른}/plan.json`, 체인계획(바른));
    r = pcIn(플안, 'compile', path.join(w8, 바른, 'plan.json'));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('📁'), `바른 자리의 계획을 옮겼다 · ${r.stdout}`);
    assert.equal(fs.existsSync(플산출), 플산출있었나, '플러그인 안 100-skills/outputs/ 에 썼다');
    const 그대로 = 읽기(w8, `${바른}/plan.json`);
    assert.equal(그대로.status, 'awaiting-approval', '바른 자리의 계획이 compile 되지 않았다');
    assert.ok(그대로.steps.flatMap(st => st.outputs).every(v => v.startsWith(`workspace:${바른}/`)), '산출물 자리가 바뀌었다');
    assert.ok(그대로.screen.includes(`나오는 곳: ${바른}/`));
    // 같은 계획을 작업 폴더에서 compile 한 화면과 글자까지 같다 (셸 cwd 가 결과를 바꾸지 않는다)
    const w8b = 공간(tpl);
    계획쓰기(w8b, `${바른}/plan.json`, 체인계획(바른));
    assert.equal(pcIn(w8b, 'compile', `${바른}/plan.json`).status, 0);
    assert.equal(그대로.screen, 읽기(w8b, `${바른}/plan.json`).screen, '셸 cwd 에 따라 계획 화면이 달라졌다');
    assert.equal(그대로.plan_sha256, 읽기(w8b, `${바른}/plan.json`).plan_sha256, '셸 cwd 에 따라 계획 해시가 달라졌다');
    assert.equal(pcIn(플안, 'approve', path.join(w8, 바른, 'plan.json')).status, 0);
    assert.equal(pcIn(플안, 'check', path.join(w8, 바른, 'plan.json')).status, 0);
    assert.equal(replayFind(w8)?.name, '광고애널리틱스', '책 실습 대본이 바른 자리의 체인 폴더를 찾지 못했다');
    // 영수증 도구도 작업 폴더를 경로에서 찾는다 · 예전엔 「허용된 기준 폴더를 벗어났습니다」로 막혔다
    r = rrIn(플안, 'book', path.join(w8, 바른, 'plan.json'));
    assert.equal(r.status, 0, `셸 cwd 가 플러그인 안이라 영수증 도구가 작업 폴더를 못 찾았다 · ${r.stderr}`);
    assert.equal(fs.existsSync(플산출), 플산출있었나, '플러그인 안 100-skills/outputs/ 에 썼다');
    // (8-b) 팀 이름 폴더 · cwd 는 플러그인 안 → 작업 폴더 안에서만 옮긴다
    const w9 = 공간(tpl);
    계획쓰기(w9, `${팀}/plan.json`, 체인계획(팀));
    r = pcIn(플안, 'compile', path.join(w9, 팀, 'plan.json'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /📁 체인 폴더로 옮겼다 · outputs\/2026-10-퍼포먼스마케팅팀\/plan\.json → outputs\/2026-10-광고애널리틱스\/plan\.json/);
    assert.equal(fs.existsSync(path.join(w9, 팀)), false, '팀 이름 폴더가 남았다');
    assert.equal(읽기(w9, `${바른}/plan.json`).status, 'awaiting-approval');
    assert.equal(fs.existsSync(플산출), 플산출있었나, '플러그인 안 100-skills/outputs/ 에 썼다');
    // (8-c) 작업 폴더를 계획 경로에서 찾는다 · 플러그인 안은 작업 폴더가 아니다
    assert.equal(fs.realpathSync(workspaceOf(path.join(w9, 바른, 'plan.json'), { cwd: 플안, env: {} })), fs.realpathSync(w9));
    assert.equal(workspaceOf(path.join(플안, 'outputs', 'x', 'plan.json'), { cwd: 플안, env: {} }), null, '플러그인 안을 작업 폴더로 봤다');
    assert.equal(fs.realpathSync(workspaceOf(path.join(플안, 'x', 'plan.json'), { cwd: 플안, env: { CLAUDE_PROJECT_DIR: w9 } })), fs.realpathSync(w9), 'CLAUDE_PROJECT_DIR 를 보지 않았다');
    // (8-d) 옮길 자리·지울 자리가 작업 폴더 밖이면 아무것도 옮기거나 지우지 않고 막는다
    const 남 = 공간(tpl);
    계획쓰기(w9, `${팀}/plan.json`, 체인계획(팀));
    const 밖 = placePlan(path.join(w9, 팀, 'plan.json'), 체인계획(팀), { cwd: 남, chain: '광고애널리틱스' });
    assert.ok(밖.block && /아무것도 옮기거나 지우지 않았습니다/.test(밖.block[0]), '작업 폴더 밖 계획을 막지 않았다');
    assert.ok(fs.existsSync(path.join(w9, 팀, 'plan.json')), '작업 폴더 밖이라며 원본을 지웠다');
    assert.equal(fs.existsSync(path.join(남, 바른)), false, '다른 폴더에 계획을 썼다');
    const 플막 = placePlan(path.join(w9, 팀, 'plan.json'), 체인계획(팀), { cwd: 플안, chain: '광고애널리틱스' });
    assert.ok(플막.block, '플러그인 안으로 옮기려 했다');
    assert.equal(fs.existsSync(플산출), 플산출있었나, '플러그인 안 100-skills/outputs/ 에 썼다');
    // (8-e) 계획 파일이 플러그인 안이면 compile 이 쓰지 않고 막는다
    const 플계획 = path.join(플안, '_plan-test-tmp', 'plan.json');
    fs.mkdirSync(path.dirname(플계획), { recursive: true });
    const 플글자 = `${JSON.stringify(체인계획(바른), null, 2)}\n`;
    fs.writeFileSync(플계획, 플글자);
    try {
      r = pcIn(플안, 'compile', 플계획);
      assert.notEqual(r.status, 0, '플러그인 안의 계획을 compile 했다');
      assert.match(r.stderr, /플러그인 폴더 안에 있습니다/);
      assert.equal(fs.readFileSync(플계획, 'utf8'), 플글자, '플러그인 안 계획 파일을 고쳐 썼다');
    } finally { fs.rmSync(path.dirname(플계획), { recursive: true, force: true }); }
    for (const d of [w8, w8b, w9, 남]) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`계획 컴파일러 · 해시 재현·민감도 7 · 계약 검사 4 · 고른 그릇 3 · 재실행 1:1 3 · 최근 순번 입력 1 · 지정 순서 2 · 승인 상태 5 · start 차단·통과 2 · 이름 있는 체인 자동 채움 2 · 체인 폴더 2 · 찍힌 화면 ${화면수} · 사용자 원본 입력 2 · 단계별 형식 1 · md 대체 합침 2 · 머리말 모양 4 · 책 실습 입력 4 · 빈 프로필 판정 16 · 샘플 채움 조건 32 · 사용자 스킬 8 · 보완 형식 4 · 보완 화면 2 · 보완·양식 책 실습 끔 8 · 같은 날 재실행 자리 14 · 업무 자료 판단 19 · 체인 폴더 옮김 8 · 셸 cwd 무관 작업 폴더 24 · 실습 근거 3 · ✅`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
