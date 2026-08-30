#!/usr/bin/env node
/** run-receipt.mjs의 성공 경로와 검토 후 변경 차단을 실제 파일로 확인한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-receipt.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-run-receipt-'));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: temp, encoding: 'utf8' });

try {
  fs.mkdirSync(path.join(temp, 'brand'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'outputs', '2026-08-30', '043-meta-ad-copy'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'brand', 'profile.md'), '업종: 화장품\n');
  fs.writeFileSync(path.join(temp, 'inputs', 'brief.md'), '신제품 광고\n');

  const out = 'outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy.md';
  const receipt = 'outputs/2026-08-30/043-meta-ad-copy/run.json';
  fs.writeFileSync(path.join(temp, receipt), `${JSON.stringify({
    schema: 'marketing-team.run/v1',
    status: 'draft',
    request: '메타 광고 카피 만들어줘',
    skills: ['043'],
    data_mode: '실데이터',
    inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
    profile: 'workspace:brand/profile.md',
    outputs: [`workspace:${out}`],
    required_reviews: [
      { kind: 'business', perspective: '브랜드', artifact: `workspace:${out}` },
      { kind: 'compliance', artifact: `workspace:${out}` },
    ],
    reviews: [],
    ledger: { path: 'workspace:logs/build-log.md' },
  }, null, 2)}\n`);

  let result = run('start', receipt);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run('start', receipt);
  assert.equal(result.status, 0, `같은 start 재호출이 멱등하지 않습니다.\n${result.stderr || result.stdout}`);
  result = run('verify', receipt);
  assert.notEqual(result.status, 0, 'running 상태를 완료된 실행처럼 통과시켰습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /완료 상태가 아닙니다: running/);

  fs.writeFileSync(path.join(temp, out), '[실데이터]\n검증된 신제품 광고 카피\n');
  fs.writeFileSync(path.join(temp, 'outputs/2026-08-30/043-meta-ad-copy/review-브랜드.md'), '판정: 승인\n');
  fs.writeFileSync(path.join(temp, 'outputs/2026-08-30/043-meta-ad-copy/gate.md'), '판정: ✅ 통과\n');

  result = run('review', receipt, '--kind', 'business', '--perspective', '브랜드', '--status', 'approved',
    '--report', 'outputs/2026-08-30/043-meta-ad-copy/review-브랜드.md', '--artifact', out);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run('review', receipt, '--kind', 'compliance', '--status', 'pass',
    '--report', 'outputs/2026-08-30/043-meta-ad-copy/gate.md', '--artifact', out);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  fs.writeFileSync(path.join(temp, 'logs', 'build-log.md'), [
    '| 일시 | 스킬 ID | 요청 | 데이터 모드 | 산출물 경로 | 게이트 | 보완 횟수 | 상태 |',
    '|---|---|---|---|---|---|---|---|',
    `| 2026-08-30 12:00 | 메타 광고 카피(043) | 광고 카피 | 실데이터 | ${out} | ✅ | 0 | 완료 |`,
    '',
  ].join('\n'));

  result = run('finalize', receipt, '--status', 'completed');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run('verify', receipt);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const sealed = JSON.parse(fs.readFileSync(path.join(temp, receipt), 'utf8'));
  assert.equal(sealed.status, 'completed');
  assert.equal(sealed.integrity.status, 'current');
  assert.equal(sealed.reviews.length, 2);
  assert.match(sealed.outputs[0].sha256, /^[a-f0-9]{64}$/);

  fs.appendFileSync(path.join(temp, out), '검토 뒤 몰래 바뀐 문장\n');
  result = run('verify', receipt);
  assert.notEqual(result.status, 0, '검토 뒤 산출물 변경을 놓쳤습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /재검토가 필요|산출물이 바뀌었습니다/);

  const staleDir = path.join(temp, 'outputs', '2026-08-30', '045-weekly-ads-report');
  fs.mkdirSync(staleDir, { recursive: true });
  const staleOut = 'outputs/2026-08-30/045-weekly-ads-report/045-weekly-ads-report.html';
  const staleReceipt = 'outputs/2026-08-30/045-weekly-ads-report/run-2.json';
  fs.writeFileSync(path.join(temp, staleReceipt), `${JSON.stringify({
    schema: 'marketing-team.run/v1',
    status: 'draft',
    request: '광고 주간 리포트 만들어줘',
    skills: ['045'],
    data_mode: '실데이터',
    inputs: [{ path: 'workspace:inputs/brief.md', period: '2026-08' }],
    profile: 'workspace:brand/profile.md',
    outputs: [`workspace:${staleOut}`],
    required_reviews: [],
    ledger: { path: 'workspace:logs/build-log.md' },
  }, null, 2)}\n`);
  result = run('start', staleReceipt);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.writeFileSync(path.join(temp, staleOut), '[실데이터]\n광고 주간 리포트\n');
  fs.appendFileSync(path.join(temp, 'inputs', 'brief.md'), '실행 중 바뀐 입력\n');
  fs.appendFileSync(path.join(temp, 'logs', 'build-log.md'),
    `| 2026-08-30 12:10 | 광고 주간 리포트(045) | 광고 리포트 | 실데이터 | ${staleOut} | 해당없음 | 0 | 완료 |\n`);
  result = run('finalize', staleReceipt, '--status', 'completed');
  assert.notEqual(result.status, 0, '실행 중 바뀐 입력으로 완료됐습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /실행 뒤 바뀐 입력/);

  const extraDir = path.join(temp, 'outputs', '2026-08-30', '046-roas-budget-rebalance');
  fs.mkdirSync(extraDir, { recursive: true });
  const extraReceipt = 'outputs/2026-08-30/046-roas-budget-rebalance/run-3.json';
  fs.writeFileSync(path.join(temp, extraReceipt), `${JSON.stringify({
    schema: 'marketing-team.run/v1',
    status: 'draft',
    request: '광고 예산 다시 짜줘',
    skills: ['046'],
    data_mode: '샘플',
    outputs: [
      'workspace:outputs/2026-08-30/046-roas-budget-rebalance/046-roas-budget-rebalance.md',
      'workspace:outputs/2026-08-30/046-roas-budget-rebalance/046-roas-budget-rebalance.html',
    ],
    required_reviews: [],
    ledger: { path: 'workspace:logs/build-log.md' },
  }, null, 2)}\n`);
  result = run('start', extraReceipt);
  assert.notEqual(result.status, 0, 'writes_to에 없는 HTML 산출물을 허용했습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /writes_to에 없는 산출물/);

  // 재실행 산출물 1:1 (P1 · 2026-08-30 최종 검토) — -2 단독 통과 · 정본+재실행 동시 차단 · 순번 섞임 차단
  const rerunReceipt = 'outputs/2026-08-30/043-meta-ad-copy/run-8.json';
  const rerunDraft = extra => ({
    schema: 'marketing-team.run/v1', status: 'draft', request: '메타 광고 카피 다시 만들어줘', skills: ['043'],
    data_mode: '실데이터', inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
    profile: 'workspace:brand/profile.md',
    required_reviews: [], reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
    ...extra,
  });
  fs.writeFileSync(path.join(temp, rerunReceipt), `${JSON.stringify(rerunDraft({
    outputs: ['workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy-2.md'],
    // 검토 정책 자동 생성은 정본 이름으로 아티팩트를 매칭하므로 재실행(-2)에는 명시로 넣는다 (알려진 제약 · 2026-08-30)
    required_reviews: [{ kind: 'compliance', artifact: 'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy-2.md' }],
  }), null, 2)}\n`);
  result = run('start', rerunReceipt);
  assert.equal(result.status, 0, `-2 재실행 산출물 단독은 시작돼야 합니다: ${result.stderr}`);
  const dupReceipt = 'outputs/2026-08-30/043-meta-ad-copy/run-9.json';
  fs.writeFileSync(path.join(temp, dupReceipt), `${JSON.stringify(rerunDraft({
    outputs: [
      'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy.md',
      'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy-2.md',
    ],
  }), null, 2)}\n`);
  result = run('start', dupReceipt);
  assert.notEqual(result.status, 0, '정본과 -2 재실행을 한 실행에 동시에 허용했습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /한 실행에 하나/);
  const ordReceipt = 'outputs/2026-08-30/050-utm-attribution/run-10.json';
  fs.mkdirSync(path.join(temp, 'outputs', '2026-08-30', '050-utm-attribution'), { recursive: true });
  fs.writeFileSync(path.join(temp, ordReceipt), `${JSON.stringify(rerunDraft({
    request: 'UTM 규칙 다시 만들어줘', skills: ['050'],
    outputs: [
      'workspace:outputs/2026-08-30/050-utm-attribution/050-utm-attribution-2.csv',
      'workspace:outputs/2026-08-30/050-utm-attribution/050-utm-attribution-해설-3.md',
    ],
  }), null, 2)}\n`);
  result = run('start', ordReceipt);
  assert.notEqual(result.status, 0, '재실행 순번이 섞였는데 시작됐습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /순번이 섞였습니다/);

  // 예산·자료 부족으로 조기 중단할 때는 아직 없는 산출물과 원장을 완료 조건처럼 요구하지 않는다.
  const blockedReceipt = 'outputs/2026-08-30/046-roas-budget-rebalance/run-4.json';
  fs.writeFileSync(path.join(temp, blockedReceipt), `${JSON.stringify({
    schema: 'marketing-team.run/v1', status: 'draft', request: '광고 예산 다시 짜줘',
    skills: ['046'], data_mode: '샘플',
    outputs: ['workspace:outputs/2026-08-30/046-roas-budget-rebalance/046-roas-budget-rebalance.md'],
    required_reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
  }, null, 2)}\n`);
  assert.equal(run('start', blockedReceipt).status, 0, '중단 가능한 실행이 시작돼야 한다.');
  result = run('finalize', blockedReceipt, '--status', 'blocked');
  assert.equal(result.status, 0, `산출물 전 조기 중단 상태를 보존해야 한다: ${result.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, blockedReceipt), 'utf8')).status, 'blocked');

  const piiDir = path.join(temp, 'outputs', '2026-08-30', '006-review-mining');
  fs.mkdirSync(piiDir, { recursive: true });
  const piiOutputs = [
    'workspace:outputs/2026-08-30/006-review-mining/006-review-mining.csv',
    'workspace:outputs/2026-08-30/006-review-mining/006-review-mining-해설.md',
  ];
  const piiDraft = {
    schema: 'marketing-team.run/v1',
    status: 'draft',
    request: '샘플 리뷰를 분석해줘',
    skills: ['006'],
    data_mode: '샘플',
    inputs: [{ path: 'plugin:sample-data/A브랜드-리뷰-200건.csv', period: '미확인' }],
    outputs: piiOutputs,
    required_reviews: [],
    ledger: { path: 'workspace:logs/build-log.md' },
  };
  const missingPiiReceipt = 'outputs/2026-08-30/006-review-mining/run-6.json';
  fs.writeFileSync(path.join(temp, missingPiiReceipt), `${JSON.stringify(piiDraft, null, 2)}\n`);
  result = run('start', missingPiiReceipt);
  assert.notEqual(result.status, 0, 'pii:true 스킬의 개인정보 검사 블록 누락을 허용했습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /pii 블록이 필요/);

  const piiReceipt = 'outputs/2026-08-30/006-review-mining/run-7.json';
  fs.writeFileSync(path.join(temp, piiReceipt), `${JSON.stringify({
    ...piiDraft,
    pii: {
      source: 'plugin:sample-data/A브랜드-리뷰-200건.csv',
      id_columns: ['번호'],
    },
  }, null, 2)}\n`);
  result = run('start', piiReceipt);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const piiSealed = JSON.parse(fs.readFileSync(path.join(temp, piiReceipt), 'utf8'));
  assert.equal(piiSealed.pii.source, 'plugin:sample-data/A브랜드-리뷰-200건.csv', 'start가 pii 블록을 버렸습니다.');

  const multiDir = path.join(temp, 'outputs', '2026-08-30', '050-utm-attribution');
  fs.mkdirSync(multiDir, { recursive: true });
  const multiA = 'outputs/2026-08-30/050-utm-attribution/050-utm-attribution.csv';
  const multiB = 'outputs/2026-08-30/050-utm-attribution/050-utm-attribution-해설.md';
  const multiReceipt = 'outputs/2026-08-30/050-utm-attribution/run-5.json';
  fs.writeFileSync(path.join(temp, multiReceipt), `${JSON.stringify({
    schema: 'marketing-team.run/v1',
    status: 'draft',
    request: '채널 두 곳 광고 카피 만들어줘',
    skills: ['050'],
    data_mode: '실데이터',
    inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
    profile: 'workspace:brand/profile.md',
    outputs: [`workspace:${multiA}`, `workspace:${multiB}`],
    required_reviews: [
      { kind: 'compliance', artifact: `workspace:${multiA}` },
      { kind: 'compliance', artifact: `workspace:${multiB}` },
    ],
    ledger: { path: 'workspace:logs/build-log.md' },
  }, null, 2)}\n`);
  result = run('start', multiReceipt);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.writeFileSync(path.join(temp, multiA), 'A 채널 카피\n');
  fs.writeFileSync(path.join(temp, multiB), 'B 채널 카피\n');
  fs.writeFileSync(path.join(temp, 'outputs/2026-08-30/050-utm-attribution/gate.md'), 'A만 검사 · ✅\n');
  result = run('review', multiReceipt, '--kind', 'compliance', '--status', 'pass',
    '--report', 'outputs/2026-08-30/050-utm-attribution/gate.md', '--artifact', multiA);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.appendFileSync(path.join(temp, 'logs', 'build-log.md'),
    `| 2026-08-30 12:20 | UTM 어트리뷰션(050) | UTM 규칙 | 실데이터 | ${multiA} | ✅ | 0 | 완료 |\n`);
  result = run('finalize', multiReceipt, '--status', 'completed');
  assert.notEqual(result.status, 0, '산출물 둘 중 하나만 검사했는데 완료됐습니다.');
  assert.match(`${result.stdout}\n${result.stderr}`, /필수 검토가 없습니다/);

  // 검토 의무 자동 생성 · 사용자가 required_reviews 내부 구조를 몰라도 frontmatter로 채운다.
  {
    const dir = 'outputs/2026-08-30/073-customer-journey-map';
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
    const rj = `${dir}/run.json`;
    const draft = extra => ({
      schema: 'marketing-team.run/v1',
      status: 'draft',
      request: '고객 여정 그려줘',
      skills: ['073'],
      data_mode: '샘플',
      inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
      profile: 'workspace:brand/profile.md',
      outputs: [`workspace:${dir}/073-customer-journey-map.md`],
      required_reviews: [],
      reviews: [],
      ledger: { path: 'workspace:logs/build-log.md' },
      ...extra,
    });

    fs.writeFileSync(path.join(temp, rj), `${JSON.stringify(draft(), null, 2)}\n`);
    const started = run('start', rj);
    assert.equal(started.status, 0, `검토 정책을 자동 생성해 시작해야 한다: ${started.stderr}`);
    const sealed = JSON.parse(fs.readFileSync(path.join(temp, rj), 'utf8'));
    assert.ok(sealed.required_reviews.some(row => row.kind === 'business' && row.perspective === '경영'));
  }

  // gate: true면 산출물별 규제 검사를 자동 생성한다 (083 보도자료)
  {
    const dir = 'outputs/2026-08-30/083-press-release';
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
    const rj = `${dir}/run.json`;
    fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
      schema: 'marketing-team.run/v1',
      status: 'draft',
      request: '보도자료 써줘',
      skills: ['083'],
      data_mode: '샘플',
      inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
      profile: 'workspace:brand/profile.md',
      outputs: [`workspace:${dir}/083-press-release.md`],
      required_reviews: [],
      reviews: [],
      ledger: { path: 'workspace:logs/build-log.md' },
    }, null, 2)}\n`);
    const started = run('start', rj);
    assert.equal(started.status, 0, `규제 검사 정책을 자동 생성해 시작해야 한다: ${started.stderr}`);
    const sealed = JSON.parse(fs.readFileSync(path.join(temp, rj), 'utf8'));
    assert.ok(sealed.required_reviews.some(row => row.kind === 'compliance'));
  }

  // 단계별 실행과 재개 · 중단해도 완료한 단계를 다시 만들지 않는다
  // 실측 2026-08-30 — 4스킬 조합이 중간에 멈추면 어디까지 됐는지 알 방법이 없었다.
  {
    const rel = 'outputs/2026-08-30/066-kpi-tree';
    const dir = path.join(temp, rel);
    fs.mkdirSync(dir, { recursive: true });
    const ref = name => `workspace:${rel}/${name}`;
    const plan = {
      schema: 'marketing-team.plan/v1', plan_id: 'chain', request: '061 → 073 → 065 → 066 조합',
      requested_order: ['061', '073', '065', '066'], skills: ['061', '073', '065', '066'],
      steps: [
        { step: 1, skill: '061', inputs: ['plugin:sample-data/A브랜드-2026-06-매출.xlsx'], outputs: [ref('061-sales-data-analysis.md')], reviews: [] },
        { step: 2, skill: '073', inputs: [ref('061-sales-data-analysis.md')], outputs: [ref('073-customer-journey-map.md')], reviews: [{ kind: 'business', perspective: '경영' }] },
        { step: 3, skill: '065', inputs: ['plugin:sample-data/A브랜드-고객마스터.csv'], outputs: [ref('065-rfm-segments.csv'), ref('065-rfm-segments-해설.md')], reviews: [] },
        { step: 4, skill: '066', inputs: [ref('073-customer-journey-map.md'), ref('065-rfm-segments-해설.md')], outputs: [ref('066-kpi-tree.md')], reviews: [] },
      ],
      budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
    };
    fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const pc = (...a) => spawnSync(process.execPath, [path.join(path.dirname(SCRIPT), 'plan-compiler.mjs'), ...a], { cwd: temp, encoding: 'utf8' });
    pc('compile', `${rel}/plan.json`); pc('approve', `${rel}/plan.json`);

    const rj = `${rel}/run.json`;
    fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
      schema: 'marketing-team.run/v1', status: 'draft', request: '061 → 073 → 065 → 066 조합',
      skills: ['061', '073', '065', '066'], data_mode: '샘플',
      inputs: [
        { path: 'plugin:sample-data/A브랜드-2026-06-매출.xlsx', period: '2026-06-01~2026-06-30' },
        { path: 'plugin:sample-data/A브랜드-고객마스터.csv', period: '2025-07-02~2026-06-30' },
      ],
      profile: 'plugin:sample-data/profile-sample.md',
      pii: { source: 'plugin:sample-data/A브랜드-고객마스터.csv', id_columns: ['고객ID'], surrogate_column: '대체키' },
      outputs: plan.steps.flatMap(x => x.outputs),
      required_reviews: [{ kind: 'business', perspective: '경영', artifact: ref('073-customer-journey-map.md') }],
      reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
    }, null, 2)}\n`);
    assert.equal(run('start', rj).status, 0, '단계 있는 실행이 시작돼야 한다');

    const make = {
      1: () => fs.writeFileSync(path.join(dir, '061-sales-data-analysis.md'), '061\n'),
      2: () => fs.writeFileSync(path.join(dir, '073-customer-journey-map.md'), '073\n'),
      3: () => { fs.writeFileSync(path.join(dir, '065-rfm-segments.csv'), '\ufeff대체키,세그먼트\nabc,챔피언\n'); fs.writeFileSync(path.join(dir, '065-rfm-segments-해설.md'), '065\n'); },
      4: () => fs.writeFileSync(path.join(dir, '066-kpi-tree.md'), '066\n'),
    };
    // 앞 단계를 건너뛰면 막는다
    assert.notEqual(run('step-start', rj, '--step', '2').status, 0, '1단계 전에 2단계를 열면 안 된다');

    for (const n of [1, 2]) { run('step-start', rj, '--step', String(n)); make[n](); run('step-done', rj, '--step', String(n)); }
    assert.notEqual(run('finalize', rj, '--status', 'completed').status, 0, '단계가 남았는데 완료하면 안 된다');
    assert.match(run('resume', rj).stdout, /단계 3/, '3단계부터 재개해야 한다');

    for (const n of [3, 4]) { run('step-start', rj, '--step', String(n)); make[n](); run('step-done', rj, '--step', String(n)); }
    assert.match(run('resume', rj).stdout, /모든 단계 완료/, '전부 끝나면 완료라고 해야 한다');

    // 2단계 산출물만 고치면 그것을 먹는 4단계만 되돌아간다 (3단계는 073을 안 먹는다)
    fs.writeFileSync(path.join(dir, '073-customer-journey-map.md'), '073 수정\n');
    const again = run('resume', rj);
    assert.match(again.stdout, /되돌린 단계: 4/, '바뀐 앞 산출물을 먹는 단계만 되돌려야 한다');
    const after = JSON.parse(fs.readFileSync(path.join(temp, rj), 'utf8'));
    assert.equal(after.steps.find(x => x.step === 3).status, 'completed', '무관한 단계까지 지우면 안 된다');
    assert.equal(after.steps.find(x => x.step === 4).status, 'pending');
  }

  console.log('실행 영수증 검사 · 멱등 시작 1 · 미완료 verify 차단 1 · 성공 1 · 산출물 변경 차단 1 · 입력 변경 차단 1 · writes_to 외 산출물 차단 1 · 재실행 1:1 3 · 조기 중단 보존 1 · PII 블록 누락 차단·보존 2 · 검토 정책 자동 생성 2 · 다중 산출물 검토 누락 차단 1 · 단계별 실행·재개 6 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
