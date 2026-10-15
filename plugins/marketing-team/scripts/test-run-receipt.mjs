#!/usr/bin/env node
/** run-receipt.mjs의 성공 경로와 검토 후 변경 차단을 실제 파일로 확인한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planHash, skillDeclarations } from './plan-compiler.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-receipt.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-run-receipt-'));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: temp, encoding: 'utf8' });

try {
  fs.mkdirSync(path.join(temp, 'brand'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'outputs', '2026-08-30', '043-meta-ad-copy'), { recursive: true });
  fs.mkdirSync(path.join(temp, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'brand', 'profile.md'), '업종: 화장품\n');
  // 프로필이 「채움」이라 회사 업무(실무)다 · 아래 샘플 영수증·계획은 「샘플로 실습」이라 "실습": true 를 적는다 (재검토 2026-10-15)
  fs.writeFileSync(path.join(temp, 'inputs', 'brief.md'), '신제품 광고\n');
  // 045 는 광고 자료를 읽는다 · 「실데이터」로 시작하려면 그 스킬의 자료가 입력에 있어야 한다 (재검토 2026-10-15)
  fs.writeFileSync(path.join(temp, 'inputs', '메타광고_8월.csv'), 'date,spend\n2026-08-01,1000\n');

  const out = 'outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy.md';
  const 표 = 'outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy.xlsx';
  const receipt = 'outputs/2026-08-30/043-meta-ad-copy/run.json';
  fs.writeFileSync(path.join(temp, receipt), `${JSON.stringify({
    schema: 'marketing-team.run/v1',
    status: 'draft',
    request: '메타 광고 카피 만들어줘',
    skills: ['043'],
    data_mode: '실데이터',
    inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
    profile: 'workspace:brand/profile.md',
    outputs: [`workspace:${표}`, `workspace:${out}`],
    required_reviews: [
      { kind: 'business', perspective: '브랜드', artifact: `workspace:${out}` },
      { kind: 'compliance', artifact: `workspace:${out}` },
      { kind: 'business', perspective: '브랜드', artifact: `workspace:${표}` },
      { kind: 'compliance', artifact: `workspace:${표}` },
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
  fs.writeFileSync(path.join(temp, 표), '[실데이터] 카피 열 개와 점수표\n');
  fs.writeFileSync(path.join(temp, 'outputs/2026-08-30/043-meta-ad-copy/review-브랜드.md'), '판정: 승인\n');
  fs.writeFileSync(path.join(temp, 'outputs/2026-08-30/043-meta-ad-copy/gate.md'), '판정: ✅ 통과\n');

  result = run('review', receipt, '--kind', 'business', '--perspective', '브랜드', '--status', 'approved',
    '--report', 'outputs/2026-08-30/043-meta-ad-copy/review-브랜드.md', '--artifact', out);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run('review', receipt, '--kind', 'compliance', '--status', 'pass',
    '--report', 'outputs/2026-08-30/043-meta-ad-copy/gate.md', '--artifact', out);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run('review', receipt, '--kind', 'business', '--perspective', '브랜드', '--status', 'approved',
    '--report', 'outputs/2026-08-30/043-meta-ad-copy/review-브랜드.md', '--artifact', 표);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run('review', receipt, '--kind', 'compliance', '--status', 'pass',
    '--report', 'outputs/2026-08-30/043-meta-ad-copy/gate.md', '--artifact', 표);
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
  assert.equal(sealed.reviews.length, 4);   // 산출물 둘 × 검토 둘 (2026-09-02 · 043 이 표+해설 두 파일 계약)
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
    inputs: [{ path: 'workspace:inputs/brief.md', period: '2026-08' }, { path: 'workspace:inputs/메타광고_8월.csv', period: '2026-08' }],
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
    실습: true, data_mode: '샘플',
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
    outputs: [
      'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy-2.xlsx',
      'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy-2.md',
    ],
    // 검토 정책 자동 생성은 정본 이름으로 아티팩트를 매칭하므로 재실행(-2)에는 명시로 넣는다 (알려진 제약 · 2026-08-30)
    required_reviews: [
      { kind: 'compliance', artifact: 'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy-2.xlsx' },
      { kind: 'compliance', artifact: 'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy-2.md' },
    ],
  }), null, 2)}\n`);
  result = run('start', rerunReceipt);
  assert.equal(result.status, 0, `-2 재실행 산출물 단독은 시작돼야 합니다: ${result.stderr}`);
  const dupReceipt = 'outputs/2026-08-30/043-meta-ad-copy/run-9.json';
  fs.writeFileSync(path.join(temp, dupReceipt), `${JSON.stringify(rerunDraft({
    outputs: [
      'workspace:outputs/2026-08-30/043-meta-ad-copy/043-meta-ad-copy.xlsx',
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
    data_mode: '틀',   // 050 은 UTM 현황 자료를 읽는다 · brief.md 만으로는 「실데이터」가 아니다 (재검토 2026-10-15)
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
    skills: ['046'], 실습: true, data_mode: '샘플',
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
    'workspace:outputs/2026-08-30/006-review-mining/006-review-mining.xlsx',
    'workspace:outputs/2026-08-30/006-review-mining/006-review-mining.html',
    'workspace:outputs/2026-08-30/006-review-mining/006-review-mining-해설.md',
  ];
  const piiDraft = {
    schema: 'marketing-team.run/v1',
    status: 'draft',
    request: '샘플 리뷰를 분석해줘',
    skills: ['006'],
    실습: true, data_mode: '샘플',
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

  // ── 초안/최종 두 단계 · 2026-09-09 ──────────────────────────────
  //    「내용을 먼저 보고 형식을 고른다」 계약. 초안은 .md 만, 최종은 형식 + 초안.
  const 초안본 = ['workspace:outputs/2026-08-30/006-review-mining/006-review-mining.md',
                  'workspace:outputs/2026-08-30/006-review-mining/006-review-mining-해설.md'];
  const 초안영수증 = 'outputs/2026-08-30/006-review-mining/run-11.json';
  fs.writeFileSync(path.join(temp, 초안영수증), `${JSON.stringify({
    ...piiDraft, 단계: '초안', outputs: 초안본,
    pii: { source: 'plugin:sample-data/A브랜드-리뷰-200건.csv', id_columns: ['번호'] },
  }, null, 2)}\n`);
  result = run('start', 초안영수증);
  assert.equal(result.status, 0, `초안 단계는 .md 만으로 시작돼야 한다: ${result.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 초안영수증), 'utf8')).단계, '초안');

  // 초안 단계에 최종 형식(.xlsx)을 끼워 넣으면 막는다
  const 섞은영수증 = 'outputs/2026-08-30/006-review-mining/run-12.json';
  fs.writeFileSync(path.join(temp, 섞은영수증), `${JSON.stringify({
    ...piiDraft, 단계: '초안',
    outputs: [...초안본, 'workspace:outputs/2026-08-30/006-review-mining/006-review-mining.xlsx'],
    pii: { source: 'plugin:sample-data/A브랜드-리뷰-200건.csv', id_columns: ['번호'] },
  }, null, 2)}\n`);
  assert.notEqual(run('start', 섞은영수증).status, 0, '초안 단계에 최종 형식을 허용했습니다.');

  // 최종 단계 — 형식 전부 + 초안이 함께 있어도 통과한다
  const 최종영수증 = 'outputs/2026-08-30/006-review-mining/run-13.json';
  fs.writeFileSync(path.join(temp, 최종영수증), `${JSON.stringify({
    ...piiDraft, 단계: '최종',
    outputs: [...piiOutputs, 'workspace:outputs/2026-08-30/006-review-mining/006-review-mining.md'],
    pii: { source: 'plugin:sample-data/A브랜드-리뷰-200건.csv', id_columns: ['번호'] },
  }, null, 2)}\n`);
  result = run('start', 최종영수증);
  assert.equal(result.status, 0, `최종 단계는 초안을 함께 둬도 통과해야 한다: ${result.stderr}`);

  // 최종 단계에서 형식이 빠지면 여전히 막는다
  const 빠진영수증 = 'outputs/2026-08-30/006-review-mining/run-14.json';
  fs.writeFileSync(path.join(temp, 빠진영수증), `${JSON.stringify({
    ...piiDraft, 단계: '최종', outputs: 초안본,
    pii: { source: 'plugin:sample-data/A브랜드-리뷰-200건.csv', id_columns: ['번호'] },
  }, null, 2)}\n`);
  assert.notEqual(run('start', 빠진영수증).status, 0, '최종 단계에서 형식 누락을 허용했습니다.');

  // 모르는 단계는 막는다
  const 이상영수증 = 'outputs/2026-08-30/006-review-mining/run-15.json';
  fs.writeFileSync(path.join(temp, 이상영수증), `${JSON.stringify({
    ...piiDraft, 단계: '중간', outputs: 초안본,
    pii: { source: 'plugin:sample-data/A브랜드-리뷰-200건.csv', id_columns: ['번호'] },
  }, null, 2)}\n`);
  assert.notEqual(run('start', 이상영수증).status, 0, '모르는 단계를 허용했습니다.');

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
    data_mode: '틀',   // 050 은 UTM 현황 자료를 읽는다 · brief.md 만으로는 「실데이터」가 아니다 (재검토 2026-10-15)
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
      실습: true, data_mode: '샘플',
      inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
      profile: 'workspace:brand/profile.md',
      outputs: [
        `workspace:${dir}/073-customer-journey-map.xlsx`,
        `workspace:${dir}/073-customer-journey-map.html`,
        `workspace:${dir}/073-customer-journey-map.md`,
      ],
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
      실습: true, data_mode: '샘플',
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

  // 사용자가 고른 그릇 · 파일 수와 이름은 그대로 두고 확장자만 바꾼다 (2026-09-02)
  // 저자 결정 · 「산출물은 사용자가 원하는 형식에 맞게 나올 수 있게」 · G2 에서 한 번 정한다.
  {
    const dir = 'outputs/2026-08-30/042-naver-shopping-ads';
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
    const 초안 = (name, extra) => {
      const rj = `${dir}/${name}`;
      fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
        schema: 'marketing-team.run/v1', status: 'draft', request: '네이버 광고 키워드 진단해줘',
        skills: ['042'], 실습: true, data_mode: '샘플',
        inputs: [{ path: 'workspace:inputs/brief.md', period: '해당없음' }],
        profile: 'workspace:brand/profile.md',
        required_reviews: [], reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
        ...extra,
      }, null, 2)}\n`);
      return rj;
    };
    const 낸다 = (...names) => names.map(n => `workspace:${dir}/${n}`);

    // ① 표를 csv 로 받겠다고 하면 csv 로 착지한다
    let r = run('start', 초안('run-11.json', {
      형식: { '042-naver-shopping-ads.xlsx': 'csv' },
      outputs: 낸다('042-naver-shopping-ads.csv', '042-naver-shopping-ads.html', '042-naver-shopping-ads.md'),
    }));
    assert.equal(r.status, 0, `고른 그릇으로 시작돼야 한다: ${r.stderr}${r.stdout}`);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(temp, `${dir}/run-11.json`), 'utf8')).형식['042-naver-shopping-ads.xlsx'],
      'csv', 'start 가 고른 그릇을 영수증에 남기지 않았습니다.');

    // ② 그릇만 바꾸는 것이라 파일을 빼면 여전히 막는다
    r = run('start', 초안('run-12.json', {
      형식: { '042-naver-shopping-ads.xlsx': 'csv' },
      outputs: 낸다('042-naver-shopping-ads.csv'),
    }));
    assert.notEqual(r.status, 0, '그릇을 바꾼다고 파일 수까지 줄이면 안 된다.');
    assert.match(`${r.stdout}\n${r.stderr}`, /필수 산출물이 outputs에 없습니다/);

    // ③ 모르는 그릇은 안 받는다
    r = run('start', 초안('run-13.json', {
      형식: { '042-naver-shopping-ads.xlsx': 'xls' },
      outputs: 낸다('042-naver-shopping-ads.xls', '042-naver-shopping-ads.html', '042-naver-shopping-ads.md'),
    }));
    assert.notEqual(r.status, 0, '모르는 그릇을 받았습니다.');
    assert.match(`${r.stdout}\n${r.stderr}`, /모르는 그릇/);

    // ④ 계약에 없는 정본은 못 바꾼다
    r = run('start', 초안('run-14.json', {
      형식: { '042-naver-shopping-ads.pdf': 'csv' },
      outputs: 낸다('042-naver-shopping-ads.xlsx', '042-naver-shopping-ads.html', '042-naver-shopping-ads.md'),
    }));
    assert.notEqual(r.status, 0, '계약에 없는 정본의 그릇을 바꿨습니다.');
    assert.match(`${r.stdout}\n${r.stderr}`, /계약에 없습니다/);
  }

  // 단계별 실행과 재개 · 중단해도 완료한 단계를 다시 만들지 않는다
  // 실측 2026-08-30 — 4스킬 조합이 중간에 멈추면 어디까지 됐는지 알 방법이 없었다.
  {
    const rel = 'outputs/2026-08-30/066-kpi-tree';
    const dir = path.join(temp, rel);
    fs.mkdirSync(dir, { recursive: true });
    const ref = name => `workspace:${rel}/${name}`;
    const plan = {
      schema: 'marketing-team.plan/v1', plan_id: 'chain', request: '061 → 073 → 065 → 066 조합', 실습: true,
      requested_order: ['061', '073', '065', '066'], skills: ['061', '073', '065', '066'],
      steps: [
        { step: 1, skill: '061', inputs: ['plugin:sample-data/A브랜드-2026-06-매출.xlsx'], outputs: [ref('061-sales-data-analysis.xlsx'), ref('061-sales-data-analysis.html'), ref('061-sales-data-analysis.md')], reviews: [] },
        { step: 2, skill: '073', inputs: [ref('061-sales-data-analysis.xlsx')], outputs: [ref('073-customer-journey-map.xlsx'), ref('073-customer-journey-map.html'), ref('073-customer-journey-map.md')], reviews: [{ kind: 'business', perspective: '경영' }] },
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
      skills: ['061', '073', '065', '066'], 실습: true, data_mode: '샘플',
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
    { const r = run('start', rj); assert.equal(r.status, 0, `단계 있는 실행이 시작돼야 한다: ${r.stderr}${r.stdout}`); }

    const make = {
      1: () => { for (const e of ['xlsx', 'html', 'md']) fs.writeFileSync(path.join(dir, `061-sales-data-analysis.${e}`), '061\n'); },
      2: () => { for (const e of ['xlsx', 'html', 'md']) fs.writeFileSync(path.join(dir, `073-customer-journey-map.${e}`), '073\n'); },
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

  // 이름 있는 체인 · 스킬마다 자기 폴더, run.json 이 있는 프로젝트 폴더 아래 나란히 둔다
  // 실측 2026-09-14·09-15 · 8장 015→053→051→052, 10장 045→046→043 이 전부 마지막 스킬
  // 폴더로 몰려 저장됐다 — plan.json 의 chain 이 있으면 각자 자기 폴더를 강제해야 한다.
  {
    const proj = 'outputs/2026-09-테스트체인';

    // 옛 버릇 · 전부 마지막 스킬(073) 폴더로 몰면 이름 있는 체인에서는 막혀야 한다
    {
      const dir = path.join(temp, proj, '073-customer-journey-map');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify({ chain: '테스트체인' }, null, 2)}\n`);
      const rj = `${proj}/073-customer-journey-map/run.json`;
      const ref = name => `workspace:${proj}/073-customer-journey-map/${name}`;
      fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
        schema: 'marketing-team.run/v1', status: 'draft', request: '061 → 073 조합(이름 있는 체인)',
        skills: ['061', '073'], 실습: true, data_mode: '샘플',
        inputs: [{ path: 'plugin:sample-data/A브랜드-2026-06-매출.xlsx', period: '2026-06-01~2026-06-30' }],
        profile: 'plugin:sample-data/profile-sample.md',
        outputs: [
          ref('061-sales-data-analysis.xlsx'), ref('061-sales-data-analysis.html'), ref('061-sales-data-analysis.md'),
          ref('073-customer-journey-map.xlsx'), ref('073-customer-journey-map.html'), ref('073-customer-journey-map.md'),
        ],
        required_reviews: [{ kind: 'business', perspective: '경영', artifact: ref('073-customer-journey-map.md') }],
        reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
      }, null, 2)}\n`);
      const r = run('start', rj);
      assert.notEqual(r.status, 0, '이름 있는 체인에서 마지막 스킬 폴더로 산출물을 몰아도 통과시켰습니다.');
      assert.match(`${r.stdout}\n${r.stderr}`, /자기 폴더/, '옛 방식(주 스킬 폴더 통합)을 이름 있는 체인 오류로 안 잡았습니다.');
      fs.rmSync(path.join(temp, proj), { recursive: true, force: true });
    }

    // 고친 방식 · 스킬마다 자기 폴더, 프로젝트 폴더 아래 나란히
    {
      const dir1 = path.join(temp, proj, '061-sales-data-analysis');
      const dir2 = path.join(temp, proj, '073-customer-journey-map');
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });
      const ref1 = name => `workspace:${proj}/061-sales-data-analysis/${name}`;
      const ref2 = name => `workspace:${proj}/073-customer-journey-map/${name}`;
      const plan = {
        schema: 'marketing-team.plan/v1', plan_id: 'chain-named', request: '061 → 073 조합(이름 있는 체인)', 실습: true,
        chain: '테스트체인', requested_order: ['061', '073'], skills: ['061', '073'],
        risks: [],
        steps: [
          { step: 1, skill: '061', inputs: ['plugin:sample-data/A브랜드-2026-06-매출.xlsx'], outputs: [ref1('061-sales-data-analysis.xlsx'), ref1('061-sales-data-analysis.html'), ref1('061-sales-data-analysis.md')], reviews: [] },
          { step: 2, skill: '073', inputs: [ref1('061-sales-data-analysis.xlsx')], outputs: [ref2('073-customer-journey-map.xlsx'), ref2('073-customer-journey-map.html'), ref2('073-customer-journey-map.md')], reviews: [{ kind: 'business', perspective: '경영' }] },
        ],
        budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
      };
      // plan-compiler.mjs CLI(compile·approve)는 chain 이름을 정본 목록(CHAINS.md 등)과
      // 대조한다 — 테스트용 가짜 이름은 그 검사에 걸리므로, run-receipt.mjs 가 실제로 보는
      // 것(승인 해시)만 직접 봉인한다. run-receipt.mjs 의 validateApprovedPlan 은
      // approvalState() 만 보지 validatePlan() 의 체인 정본 검사는 보지 않는다.
      const sealed = planHash(plan);
      fs.writeFileSync(path.join(temp, proj, 'plan.json'),
        `${JSON.stringify({ ...plan, plan_sha256: sealed, status: 'approved', approved_sha256: sealed }, null, 2)}\n`);

      const rj = `${proj}/run.json`;
      fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
        schema: 'marketing-team.run/v1', status: 'draft', request: '061 → 073 조합(이름 있는 체인)',
        skills: ['061', '073'], 실습: true, data_mode: '샘플',
        inputs: [{ path: 'plugin:sample-data/A브랜드-2026-06-매출.xlsx', period: '2026-06-01~2026-06-30' }],
        profile: 'plugin:sample-data/profile-sample.md',
        outputs: plan.steps.flatMap(x => x.outputs),
        required_reviews: [{ kind: 'business', perspective: '경영', artifact: ref2('073-customer-journey-map.md') }],
        reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
      }, null, 2)}\n`);
      const r = run('start', rj);
      assert.equal(r.status, 0, `스킬마다 자기 폴더에 둔 이름 있는 체인은 통과해야 합니다: ${r.stderr}${r.stdout}`);
    }
  }

  // ⭐ 초안 .md 실재 검사 (2026-09-15) — writes_to 에 .md 를 약속한 스킬은
  // 최종 그릇이 .md 가 아니게 바뀌어도 그 초안이 outputs 에 실제로 있어야 한다.
  // 046(writes_to = .md 단독)을 .docx 로 굽도록 그릇을 바꾼 경우로 확인한다 —
  // 옛 코드는 이 자리에서 초안을 요구하지 않았다(덤은 언제나 선택이었다).
  {
    const dir = 'outputs/2026-08-30/046-roas-budget-rebalance';
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
    const draft = (name, extra) => {
      const rj = `${dir}/${name}`;
      fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
        schema: 'marketing-team.run/v1', status: 'draft', request: '광고 예산 다시 짜줘',
        skills: ['046'], 실습: true, data_mode: '샘플',
        required_reviews: [], reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
        형식: { '046-roas-budget-rebalance.md': 'docx' },
        ...extra,
      }, null, 2)}\n`);
      return rj;
    };
    const 낸다 = (...names) => names.map(n => `workspace:${dir}/${n}`);

    // 그릇만 바꾸고 초안(.md)을 함께 남기지 않으면 — 최종 형식만으론 통과해도 이 검사가 막는다
    let r = run('start', draft('run-16.json', { outputs: 낸다('046-roas-budget-rebalance.docx') }));
    assert.notEqual(r.status, 0, '그릇을 바꾸며 초안 .md 를 지워도 통과시켰습니다.');
    assert.match(`${r.stdout}\n${r.stderr}`, /초안이 outputs 에 없습니다/);

    // 초안을 함께 남기면 통과한다 (§H · 초안은 지우지 않는다)
    r = run('start', draft('run-17.json', {
      outputs: 낸다('046-roas-budget-rebalance.docx', '046-roas-budget-rebalance.md'),
    }));
    assert.equal(r.status, 0, `그릇을 바꿔도 초안을 함께 두면 통과해야 합니다: ${r.stderr}${r.stdout}`);
  }

  // writes_to 에 .md 가 아예 없는 스킬(100개 중 14개)은 이 검사에서 빠진다 —
  // 실측 2026-09-15 · 원고소스(v9) production 표본 045·062 등. 안 빼면 그 스킬들의
  // 실제 완료 실행을 전부 거짓 거부한다.
  {
    const dir = 'outputs/2026-08-30/045-weekly-ads-report';
    fs.mkdirSync(path.join(temp, dir), { recursive: true });
    const rj = `${dir}/run-18.json`;
    fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
      schema: 'marketing-team.run/v1', status: 'draft', request: '광고 주간 리포트 만들어줘',
      skills: ['045'], 실습: true, data_mode: '샘플',
      outputs: [`workspace:${dir}/045-weekly-ads-report.html`],
      required_reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
    }, null, 2)}\n`);
    const r = run('start', rj);
    assert.equal(r.status, 0, `.md 를 약속하지 않은 스킬까지 초안을 요구했습니다: ${r.stderr}${r.stdout}`);
  }

  // 작동 검토 2026-09-22 #4 · 계획은 최종 그릇만 적고, 같은 자리의 .md 초안은 계획 안으로 본다
  {
    const pc = (...a) => spawnSync(process.execPath, [path.join(path.dirname(SCRIPT), 'plan-compiler.mjs'), ...a], { cwd: temp, encoding: 'utf8' });
    const one = (id, slug, finalExt, fmt, reviews) => {
      const rel = `outputs/2026-09-22/${id}-${slug}`;
      fs.mkdirSync(path.join(temp, rel), { recursive: true });
      const out = ext => `workspace:${rel}/${id}-${slug}.${ext}`;
      const plan = { schema: 'marketing-team.plan/v1', plan_id: `draft-${id}`, request: '초안 재현', 실습: true, skills: [id],
        steps: [{ step: 1, skill: id, inputs: ['plugin:sample-data/A브랜드-채널성과-90일.csv'], outputs: [out(finalExt)], reviews }],
        budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 } };
      if (fmt) plan.형식 = fmt;
      fs.writeFileSync(path.join(temp, rel, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
      assert.equal(pc('compile', `${rel}/plan.json`).status, 0, `${id} 계획이 compile 되지 않는다`);
      pc('approve', `${rel}/plan.json`);
      return (단계, exts) => {
        const receipt = { schema: 'marketing-team.run/v1', status: 'draft', request: '초안 재현', skills: [id], 실습: true, data_mode: '샘플',
          inputs: [{ path: 'plugin:sample-data/A브랜드-채널성과-90일.csv', period: '2026-05-01~2026-07-29' }],
          profile: 'plugin:sample-data/profile-sample.md', outputs: exts.map(out),
          required_reviews: exts.flatMap(e => reviews.map(r => ({ ...r, artifact: out(e) }))), reviews: [],
          ledger: { path: 'workspace:logs/build-log.md' }, 단계 };
        if (fmt) receipt.형식 = fmt;
        fs.writeFileSync(path.join(temp, rel, 'run.json'), `${JSON.stringify(receipt, null, 2)}\n`);
        return run('start', `${rel}/run.json`);
      };
    };
    let r = one('045', 'weekly-ads-report', 'html', null, [])('초안', ['md']);
    assert.equal(r.status, 0, `045 html 계획의 .md 초안 start 를 막았다: ${r.stderr}${r.stdout}`);
    const s046 = one('046', 'roas-budget-rebalance', 'docx', { '046-roas-budget-rebalance.md': 'docx' }, [{ kind: 'business', perspective: '재무' }]);
    r = s046('초안', ['md']);
    assert.equal(r.status, 0, `046 docx 계획의 .md 초안 start 를 막았다: ${r.stderr}${r.stdout}`);
    r = s046('최종', ['docx', 'md']);
    assert.equal(r.status, 0, `046 최종(docx + 초안 md) start 를 막았다: ${r.stderr}${r.stdout}`);
  }

  // 책 실습 · 샘플 + 빈 프로필이면 원고 결과를 그대로 놓는다 · 프로필을 채우면 독자 기준 (저자 결정 2026-10-12)
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-book-'));
    try {
      const P = path.resolve(path.dirname(SCRIPT), '..');
      const sh = (...a) => spawnSync(process.execPath, a, { cwd: ws, encoding: 'utf8' });
      fs.mkdirSync(path.join(ws, 'brand'), { recursive: true });
      fs.copyFileSync(path.join(P, 'brand-templates', 'profile.md'), path.join(ws, 'brand', 'profile.md'));
      const dir = 'outputs/2026-10-12/006-review-mining', planRel = `${dir}/plan.json`;
      fs.mkdirSync(path.join(ws, dir), { recursive: true });
      const o = n => `workspace:${dir}/${n}`;
      const 계획 = (inputs) => fs.writeFileSync(path.join(ws, planRel), JSON.stringify({ request: '리뷰 분석해줘', skills: ['006'], steps: [{ step: 1, skill: '006',
        inputs, outputs: [o('006-review-mining.xlsx'), o('006-review-mining.html'), o('006-review-mining-해설.md')], reviews: [{ kind: 'compliance' }] }] }));
      // 입력을 [] 로 적어도 compile 이 샘플로 채운다 (실측 2026-10-12 · 「분석할 자료」 줄이 빠지고 책 실습이 꺼졌다)
      계획([]);
      assert.match(sh(path.join(P, 'scripts', 'plan-compiler.mjs'), 'compile', planRel).stdout, /📎 inputs 가 비어 샘플 자료로 채웠다 · sample-data\/A브랜드-리뷰-200건\.csv/, '빈 입력을 샘플로 채우지 않았다');
      assert.notEqual(sh(SCRIPT, 'book', planRel).status, 0, '승인 전 계획으로 기준본을 놓았다');
      sh(path.join(P, 'scripts', 'plan-compiler.mjs'), 'approve', planRel);
      const r = sh(SCRIPT, 'book', planRel);
      assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /📖 책 실습/);
      const ref = path.join(P, 'sample-data', '참고결과', '006-review-mining');
      assert.ok(fs.readFileSync(path.join(ws, dir, '006-review-mining.xlsx')).equals(fs.readFileSync(path.join(ref, '006-review-mining.xlsx'))), '원고 xlsx 와 다르다');
      assert.match(fs.readFileSync(path.join(ws, dir, '006-review-mining-해설.md'), 'utf8'), /outputs\/2026-10-12\//, '{날짜} 를 그날로 바꾸지 않았다');
      assert.doesNotMatch(r.stdout, /화면 끝/, '영수증 전인데 화면을 냈다');
      assert.match(r.stdout, /검토자를 부르지 않는다/, '영수증 전 안내가 검토자를 부르게 둔다');
      // 검토도 원고 것 · 영수증 전이면 보고서만 놓고 봉인은 미룬다 (실측 2026-10-12 · 새로 부른 검토자가 「조건부」를 내 차단됨으로 끝났다)
      assert.ok(fs.existsSync(path.join(ws, dir, 'gate.md')), '원고 검토 보고서를 놓지 않았다');
      assert.match(r.stdout, /영수증\(run-receipt start\)이 아직 없어/, '영수증 없이 검토를 봉인한 척했다');
      // 우리 양식(brand/skill-notes/006.md)을 정했으면 원고 결과를 놓지 않는다 (2026-10-14)
      fs.mkdirSync(path.join(ws, 'brand', 'skill-notes'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'brand', 'skill-notes', '006.md'), '# 006 우리 규칙\n형식: docx\n');
      assert.match(sh(SCRIPT, 'book', planRel).stdout, /해당 없음 · 우리 양식/, '보완 파일이 있는데 원고 결과를 놓았다');
      fs.rmSync(path.join(ws, 'brand', 'skill-notes'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'brand', 'profile.md'), '# 우리 회사 · 반려동물 사료\n');
      assert.match(sh(SCRIPT, 'book', planRel).stdout, /해당 없음 · 브랜드 프로필을 채웠다/, '프로필을 채웠는데 원고 결과를 놓았다');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  // 사용자 스킬(brand/my-skills · 101~199)도 영수증을 연다 · 스킬 사본은 작업 폴더 기준으로 봉인한다 (2026-10-14)
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-my-skill-'));
    try {
      const sk = path.join(ws, 'brand', 'my-skills', '101-ad-stop-judge');
      fs.mkdirSync(sk, { recursive: true });
      fs.writeFileSync(path.join(sk, 'SKILL.md'), '---\nid: "101"\nname: 광고 소재 중단 판정\ncategory: custom\nwrites_to: [outputs/{날짜}/101-ad-stop-judge/101-ad-stop-judge.md]\n---\n');
      const dir = 'outputs/2026-10-14/101-ad-stop-judge';
      fs.mkdirSync(path.join(ws, dir), { recursive: true });
      fs.mkdirSync(path.join(ws, 'logs'), { recursive: true });
      const art = `workspace:${dir}/101-ad-stop-judge.md`;
      fs.writeFileSync(path.join(ws, dir, 'run.json'), JSON.stringify({ schema: 'marketing-team.run/v1', status: 'draft', request: '이 소재 끌까 말까', skills: ['101'],
        data_mode: '샘플', inputs: [{ path: 'plugin:sample-data/A브랜드-메타광고-30일.csv', period: '30일' }], outputs: [art],
        required_reviews: [{ kind: 'compliance', artifact: art }], reviews: [], ledger: { path: 'workspace:logs/build-log.md' } }));
      const r = spawnSync(process.execPath, [SCRIPT, 'start', `${dir}/run.json`], { cwd: ws, encoding: 'utf8' });
      assert.equal(r.status, 0, `사용자 스킬 영수증 start 가 막혔다: ${r.stderr}${r.stdout}`);
      const sealed = JSON.parse(fs.readFileSync(path.join(ws, dir, 'run.json'), 'utf8'));
      assert.equal(sealed.skills[0].path, 'workspace:brand/my-skills/101-ad-stop-judge/SKILL.md', '사용자 스킬 사본 경로가 작업 폴더 기준이 아니다');
      assert.equal(sealed.skills[0].gate, true, 'gate 를 안 적은 사용자 스킬은 true 로 봉인한다');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // 데이터 표시는 실제로 쓴 근거로 · 샘플 입력이 있으면 「실데이터」를 받지 않는다 (2026-10-14 · 검토 P0)
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-data-mode-'));
    try {
      const dir = 'outputs/2026-10-14/045-weekly-ads-report';
      for (const d of [dir, 'inputs', 'logs', 'brand']) fs.mkdirSync(path.join(ws, d), { recursive: true });
      fs.writeFileSync(path.join(ws, 'inputs', 'ads.csv'), 'date,spend\n2026-10-01,1000\n');
      fs.writeFileSync(path.join(ws, 'brand', 'profile.md'), '| 브랜드명 | 팀플 |\n');
      const art = `workspace:${dir}/045-weekly-ads-report.html`;
      const go = (mode, inputs, name = 'run.json') => {
        fs.writeFileSync(path.join(ws, dir, name), JSON.stringify({ schema: 'marketing-team.run/v1', status: 'draft', request: '광고 주간 리포트',
          skills: ['045'], 실습: true, data_mode: mode, inputs, profile: 'workspace:brand/profile.md', outputs: [art], required_reviews: [], ledger: { path: 'workspace:logs/build-log.md' } }));
        return spawnSync(process.execPath, [SCRIPT, 'start', `${dir}/${name}`], { cwd: ws, encoding: 'utf8' });
      };
      const 샘플 = { path: 'plugin:sample-data/A브랜드-광고매체통합-12주.csv', period: '12주' }, 우리 = { path: 'workspace:inputs/ads.csv', period: '2026-10' };
      let r = go('실데이터', [샘플]);
      assert.notEqual(r.status, 0, '샘플 입력인데 「실데이터」로 시작했다');
      assert.match(r.stderr, /「실데이터」로 적을 수 없습니다[\s\S]*전부 샘플이면 「샘플」/, '전부 샘플일 때 무엇으로 적을지 알리지 않았다');
      r = go('실데이터', [우리, 샘플], 'run-2.json');
      assert.notEqual(r.status, 0, '우리 자료와 샘플이 섞였는데 「실데이터」로 시작했다');
      assert.match(r.stderr, /섞였으면 「혼합」/, '섞였을 때 「혼합」을 알리지 않았다');
      r = go('샘플', [우리, 샘플], 'run-3.json');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /「혼합」이 맞습니다/, '섞였는데 「샘플」로 적으면 「혼합」을 알려야 한다');
      r = go('실데이터', [우리], 'run-4.json');
      assert.equal(r.status, 0, `우리 자료만 쓴 「실데이터」를 막았다: ${r.stderr}`);
      // start 뒤에 data_mode 를 고쳐도 finalize 가 잡는다
      r = go('혼합', [우리, 샘플], 'run-5.json');
      assert.equal(r.status, 0, r.stderr);
      const f5 = path.join(ws, dir, 'run-5.json');
      fs.writeFileSync(f5, JSON.stringify({ ...JSON.parse(fs.readFileSync(f5, 'utf8')), data_mode: '실데이터' }));
      r = spawnSync(process.execPath, [SCRIPT, 'finalize', `${dir}/run-5.json`, '--status', 'interrupted'], { cwd: ws, encoding: 'utf8' });
      assert.notEqual(r.status, 0, '봉인 뒤 「실데이터」로 고친 영수증을 finalize 가 통과시켰다');
      assert.match(r.stderr, /「실데이터」로 적을 수 없습니다/);

      // (3) 자료를 읽어야 하는 045 가 업무 자료 없이 「실데이터」 · 회사 B S6·A 067 · 「틀」(또는 「추정」)이 맞다
      fs.mkdirSync(path.join(ws, 'inputs', '양식'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'inputs', '양식', '월간보고_양식.docx'), 'docx');
      fs.mkdirSync(path.join(ws, 'brand', '디자인'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'brand', '디자인', '가이드.md'), '# 가이드\n');
      r = go('실데이터', [], 'run-6.json');
      assert.notEqual(r.status, 0, '광고 자료 없이 만든 045 를 「실데이터」로 시작했다');
      assert.match(r.stderr, /스킬 045, 광고 주간 성과 분석\. 읽는 자료는 「매체별 광고 데이터 소스」입니다\. 이 자료가 입력에 없어[\s\S]*「틀」[\s\S]*「추정」/, '「틀」·「추정」을 안내하지 않았다');
      r = go('실데이터', [{ path: 'workspace:inputs/양식/월간보고_양식.docx', period: '-' }, { path: 'workspace:brand/디자인/가이드.md', period: '-' }], 'run-7.json');
      assert.notEqual(r.status, 0, '회사 양식과 brand/ 만 입력으로 적은 045 를 「실데이터」로 시작했다');
      r = go('틀', [], 'run-8.json');
      assert.equal(r.status, 0, `「틀」을 data_mode 로 받지 않았다: ${r.stderr}`);
      r = go('추정', [], 'run-9.json');
      assert.equal(r.status, 0, r.stderr);
      // 프로필만으로 만드는 생성 스킬(028 링크드인 글)은 입력 없이도 「실데이터」 그대로다
      const d028 = 'outputs/2026-10-14/028-linkedin-post';
      fs.mkdirSync(path.join(ws, d028), { recursive: true });
      fs.writeFileSync(path.join(ws, d028, 'run.json'), JSON.stringify({ schema: 'marketing-team.run/v1', status: 'draft', request: '링크드인 글 써줘', skills: ['028'],
        data_mode: '실데이터', inputs: [], profile: 'workspace:brand/profile.md', outputs: [`workspace:${d028}/028-linkedin-post.md`], ledger: { path: 'workspace:logs/build-log.md' } }));
      r = spawnSync(process.execPath, [SCRIPT, 'start', `${d028}/run.json`], { cwd: ws, encoding: 'utf8' });
      assert.equal(r.status, 0, `생성 스킬(028)의 「실데이터」를 막았다: ${r.stderr}`);

      // (8) 앞 결과가 샘플로 만든 것이면 샘플로 센다 · 책 실습 4장 011 · 「혼합이 맞다」 경고가 잘못 나왔다
      const d006 = 'outputs/2026-10-14/006-review-mining';
      fs.mkdirSync(path.join(ws, d006), { recursive: true });
      const 앞결과 = `workspace:${d006}/006-review-mining-해설.md`;
      fs.writeFileSync(path.join(ws, d006, '006-review-mining-해설.md'), '# 해설\n');
      const 앞영수증 = mode => fs.writeFileSync(path.join(ws, d006, 'run.json'), JSON.stringify({ schema: 'marketing-team.run/v1', run_id: 'r-006', status: 'completed', data_mode: mode, outputs: [{ path: 앞결과 }] }));
      앞영수증('샘플');
      r = go('샘플', [{ path: 앞결과, period: '-' }, 샘플], 'run-10.json');
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /혼합/, '샘플로 만든 앞 결과와 샘플을 「섞였다」고 했다');
      r = go('실데이터', [{ path: 앞결과, period: '-' }], 'run-11.json');
      assert.notEqual(r.status, 0, '샘플로 만든 앞 결과만 읽고 「실데이터」로 시작했다');
      앞영수증('실데이터');
      r = go('샘플', [{ path: 앞결과, period: '-' }, 샘플], 'run-12.json');
      assert.match(r.stderr, /「혼합」이 맞습니다/, '실데이터 앞 결과와 샘플이 섞였는데 알리지 않았다');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // 092 · 새 스킬 폴더 {NNN}-{slug}/ 는 실행 중에 이름이 정해진다 · 같은 승인으로 영수증을 연다 (실측 2026-10-14 · 승인 두 번)
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-092-'));
    try {
      const pc = (...a) => spawnSync(process.execPath, [path.join(path.dirname(SCRIPT), 'plan-compiler.mjs'), ...a], { cwd: ws, encoding: 'utf8' });
      const dir = 'outputs/2026-10-14/092-skill-builder-meta';
      fs.mkdirSync(path.join(ws, dir), { recursive: true });
      fs.mkdirSync(path.join(ws, 'logs'), { recursive: true });
      const rep = `workspace:${dir}/092-skill-builder-meta.md`;
      // 새 스킬 폴더에 쓰는 파일 · 092 writes_to 를 그대로 읽는다 (SKILL.md 가 writes_to 에 들어오면 함께 시험한다)
      const 하위 = skillDeclarations().get('092').writesTo.filter(v => v.split('/').length > 4).map(v => path.posix.basename(v));
      const 자리 = sub => 하위.map(n => `workspace:${dir}/${sub}/${n}`);
      const 열기 = (planSub, realSub, extra = []) => {
        // 시도마다 새 실행이다 · 앞 시도의 영수증이 남아 있으면 compile 이 「이미 돈 계획」으로 막는다 (같은 날 재실행 규칙)
        fs.rmSync(path.join(ws, dir, 'run.json'), { force: true });
        fs.writeFileSync(path.join(ws, dir, 'plan.json'), JSON.stringify({ request: '내 업무를 스킬로 만들자', skills: ['092'],
          steps: [{ step: 1, skill: '092', inputs: [], outputs: [rep, ...자리(planSub)], reviews: [] }] }));
        const c = pc('compile', `${dir}/plan.json`);
        assert.equal(c.status, 0, `092 계획이 compile 되지 않는다: ${c.stderr}`);
        pc('approve', `${dir}/plan.json`);
        fs.writeFileSync(path.join(ws, dir, 'run.json'), JSON.stringify({ schema: 'marketing-team.run/v1', status: 'draft', request: '내 업무를 스킬로 만들자',
          skills: ['092'], data_mode: '실데이터', inputs: [], outputs: [rep, ...자리(realSub), ...extra],
          required_reviews: [], ledger: { path: 'workspace:logs/build-log.md' } }));
        return spawnSync(process.execPath, [SCRIPT, 'start', `${dir}/run.json`], { cwd: ws, encoding: 'utf8' });
      };
      let r = 열기('{NNN}-{slug}', '101-ad-stop-judge');
      assert.equal(r.status, 0, `계획이 {NNN}-{slug} 를 그대로 적었는데 정해진 이름으로 시작하지 못했다: ${r.stderr}`);
      r = 열기('101-guess', '102-ad-stop-judge');
      assert.equal(r.status, 0, `계획이 짐작한 이름과 다르다고 다시 승인을 요구했다: ${r.stderr}`);
      r = 열기('{NNN}-{slug}', '101-ad-stop-judge/deep');
      assert.notEqual(r.status, 0, 'writes_to 자리보다 깊은 폴더를 받아들였다');
      r = 열기('{NNN}-{slug}', 'x-not-a-skill');
      assert.notEqual(r.status, 0, '{NNN} 자리에 세 자리 번호가 아닌 폴더를 받아들였다');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  console.log('실행 영수증 검사 · 멱등 시작 1 · 미완료 verify 차단 1 · 성공 1 · 산출물 변경 차단 1 · 입력 변경 차단 1 · writes_to 외 산출물 차단 1 · 재실행 1:1 3 · 조기 중단 보존 1 · PII 블록 누락 차단·보존 2 · 검토 정책 자동 생성 2 · 다중 산출물 검토 누락 차단 1 · 고른 그릇 4 · 단계별 실행·재개 6 · 이름 있는 체인 자기 폴더 2 · 초안 실재 검사 2 · .md 없는 스킬 예외 1 · 초안은 계획 안 3 · 책 실습 9 · 보완 파일 책 실습 끔 1 · 사용자 스킬 영수증 3 · 데이터 표시 근거 7 · 틀·업무 자료 6 · 앞 결과 모드 3 · 092 새 스킬 폴더 4 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
