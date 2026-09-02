#!/usr/bin/env node
/**
 * memory.mjs 회귀 — 인용은 영수증이 만든다 · 멱등 · 역링크 양방향 · 주목가치 게이트 · 점검
 * 실측 회귀 포함: 섹션 여러 줄 왕복 (m 플래그 `$` 가 첫 줄만 잡던 것)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-memory-'));
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a],
  { cwd: temp, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: temp } });
const write = (rel, obj) => {
  const p = path.join(temp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return rel;
};
const read = rel => fs.readFileSync(path.join(temp, rel), 'utf8');

try {
  write('outputs/2026-08-30/046-r/run.json', {
    schema: 'marketing-team.run/v1', run_id: '20260830-046-aaa',
    started_at: '2026-08-30T05:57:34Z', completed_at: '2026-08-30T06:01:20Z',
    status: 'completed', request: '광고 예산 다시 짜줘', data_mode: '샘플',
    skills: [{ id: '046', name: 'ROAS 진단' }],
    outputs: [{ path: 'workspace:outputs/2026-08-30/046-r/046-r.md' }],
  });
  const draft = {
    schema: 'marketing-team.memory/v1',
    run: { receipt: 'workspace:outputs/2026-08-30/046-r/run.json' },
    notes: [{
      slug: '경쟁사/올리브영', title: '올리브영',
      facts: ['8월 초 주력 라인 가격을 12% 내렸다', '쿠팡 로켓배송을 8월에 시작했다'],
      timeline: '경쟁 가격 인하가 ROAS 하락의 주원인으로 확인됐다',
      links: ['교훈/가격인하-대응'],
    }],
  };

  // ① 인용은 영수증이 만든다 — 스킬·날짜·데이터 모드가 자동으로 붙는다
  write('draft.json', draft);
  let r = run('capture', '--file', 'draft.json');
  assert.match(r.stdout, /신규 · 아는 것 \+2/, '새 페이지에 사실 2건이 들어가야 한다');
  let page = read('brand/memory/경쟁사/올리브영.md');
  assert.match(page, /\[출처: ROAS 진단\(046\) · 2026-08-30 · 샘플\]/, '인용을 영수증에서 만들어야 한다');
  assert.match(page, /runs: \[20260830-046-aaa\]/, '영수증 id 를 frontmatter 에 남겨야 한다');
  assert.match(page, /\*\*2026-08-30\*\* · \[ROAS 진단\(046\)\]\(\.\.\/\.\.\/\.\.\/outputs\/2026-08-30\/046-r\/046-r\.md\)/,
    '타임라인이 산출물 원본을 가리켜야 한다');
  assert.match(page, /\[\[교훈\/가격인하-대응\]\]/, '연결이 들어가야 한다');

  // ② 섹션 여러 줄 왕복 — 다시 읽어 다시 써도 두 줄이 살아남아야 한다 (실측 회귀)
  write('draft2.json', { ...draft, notes: [{ ...draft.notes[0], facts: ['자체 PB 라인을 9월에 낸다'], timeline: null, links: [] }] });
  r = run('capture', '--file', 'draft2.json');
  page = read('brand/memory/경쟁사/올리브영.md');
  assert.equal((page.match(/^- .*\[출처:/gm) || []).length, 3, '기존 두 줄이 살아 있고 한 줄이 늘어야 한다');

  // ③ 멱등 — 같은 사실을 다시 남겨도 두 번 쌓이지 않는다
  r = run('capture', '--file', 'draft.json');
  assert.match(r.stdout, /아는 것 \+0/, '같은 사실은 다시 쌓이지 않아야 한다');
  page = read('brand/memory/경쟁사/올리브영.md');
  assert.equal((page.match(/12% 내렸다/g) || []).length, 1, '중복 문장이 하나여야 한다');
  assert.equal((page.match(/\*\*2026-08-30\*\*/g) || []).length, 1, '타임라인도 중복되지 않아야 한다');

  // ④ 역링크 철칙 — 상대 페이지가 생기면 그쪽에도 돌아오는 링크가 들어간다
  write('draft3.json', {
    schema: 'marketing-team.memory/v1', run: { receipt: 'workspace:outputs/2026-08-30/046-r/run.json' },
    notes: [{ slug: '교훈/가격인하-대응', title: '가격 인하 대응', facts: ['경쟁 인하에는 예산보다 소재를 먼저 본다'] }],
  });
  run('capture', '--file', 'draft3.json');
  write('draft4.json', {
    schema: 'marketing-team.memory/v1', run: { receipt: 'workspace:outputs/2026-08-30/046-r/run.json' },
    notes: [{ slug: '채널/메타', title: '메타', facts: ['8월 ROAS 1.4'], links: ['교훈/가격인하-대응'] }],
  });
  r = run('capture', '--file', 'draft4.json');
  assert.match(r.stdout, /교훈\/가격인하-대응 \(역링크\)/, '상대 페이지에 역링크를 넣어야 한다');
  assert.match(read('brand/memory/교훈/가격인하-대응.md'), /\[\[채널\/메타\]\]/, '역링크가 실제로 파일에 있어야 한다');

  // ⑤ 출처를 AI가 직접 쓰면 거부한다 (원칙 2)
  write('bad-cite.json', {
    schema: 'marketing-team.memory/v1', run: { receipt: 'workspace:outputs/2026-08-30/046-r/run.json' },
    notes: [{ slug: '경쟁사/무신사', facts: ['가격을 내렸다 [출처: 내가 그냥 앎]'] }],
  });
  r = run('capture', '--file', 'bad-cite.json');
  assert.notEqual(r.status, 0, '직접 쓴 출처는 거부해야 한다');
  assert.match(r.stderr, /출처는 직접 쓰지 않습니다/);

  // ⑥ 영수증 없이는 기억을 남기지 않는다
  write('no-receipt.json', {
    schema: 'marketing-team.memory/v1', run: { receipt: 'workspace:outputs/없는/run.json' },
    notes: [{ slug: '경쟁사/무신사', facts: ['뭔가 안다'] }],
  });
  r = run('capture', '--file', 'no-receipt.json');
  assert.notEqual(r.status, 0, '없는 영수증은 거부해야 한다');
  assert.match(r.stderr, /영수증이 없습니다/);

  // ⑦ 주목가치 게이트 — 한 실행에 3건까지
  write('too-many.json', {
    schema: 'marketing-team.memory/v1', run: { receipt: 'workspace:outputs/2026-08-30/046-r/run.json' },
    notes: Array.from({ length: 4 }, (_, i) => ({ slug: `경쟁사/x${i}`, facts: ['안다'] })),
  });
  r = run('capture', '--file', 'too-many.json');
  assert.notEqual(r.status, 0, '4건은 거부해야 한다');
  assert.match(r.stderr, /3건까지/);

  // ⑧ 슬러그 문법 — 주제 밖·경로 탈출을 막는다
  for (const slug of ['아무거나/x', '경쟁사/../../etc/passwd', '경쟁사', '경쟁사/x.md']) {
    write('bad-slug.json', {
      schema: 'marketing-team.memory/v1', run: { receipt: 'workspace:outputs/2026-08-30/046-r/run.json' },
      notes: [{ slug, facts: ['안다'] }],
    });
    r = run('capture', '--file', 'bad-slug.json');
    assert.notEqual(r.status, 0, `슬러그를 막아야 한다: ${slug}`);
  }
  assert.ok(!fs.existsSync(path.join(temp, 'etc')), '작업 폴더 밖에 쓰지 않아야 한다');

  // ⑨ 회상 — 키워드와 주제 필터
  r = run('search', '가격 인하');
  assert.match(r.stdout, /경쟁사\/올리브영/, '키워드로 기억을 찾아야 한다');
  r = run('search', '', '--type', '채널');
  assert.match(r.stdout, /채널\/메타/, '주제 필터가 돌아야 한다');
  assert.doesNotMatch(r.stdout, /경쟁사\/올리브영/, '필터 밖은 나오면 안 된다');

  // ⑩ 색인 — capture 가 다시 만든다
  assert.match(read('brand/memory/INDEX.md'), /경쟁사 \| \[올리브영\]/, 'INDEX 가 재생성돼야 한다');

  // ⑪ 점검 — 끊긴 링크와 인용 없는 사실을 잡는다
  r = run('doctor');
  assert.match(r.stdout, /이상 없음/, '정상 상태에서는 깨끗해야 한다');
  fs.mkdirSync(path.join(temp, 'brand/memory/제품'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'brand/memory/제품/앰플.md'), [
    '---', 'type: 제품', 'slug: 제품/앰플', 'title: 앰플', 'created: 2026-08-30', 'updated: 2026-08-30', 'runs: []', '---',
    '', '# 앰플', '', '## 아는 것', '- 출처가 없는 사실이다', '', '## 타임라인', '- (아직 없음)', '', '## 연결', '- [[경쟁사/없는곳]]', '',
  ].join('\n'));
  r = run('doctor', '--json');
  const report = JSON.parse(r.stdout);
  assert.ok(report.issues.some(i => i.kind === '인용없음'), '인용 없는 사실을 잡아야 한다');
  assert.ok(report.issues.some(i => i.kind === '끊긴링크'), '끊긴 링크를 잡아야 한다');

  console.log('기억 · 인용 4 · 왕복 1 · 멱등 2 · 역링크 2 · 거부 7 · 회상 3 · 색인 1 · 점검 3 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
