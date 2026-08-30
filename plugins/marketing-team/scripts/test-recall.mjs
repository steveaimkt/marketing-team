#!/usr/bin/env node
/** recall.mjs 회귀 — 색인 재생성 가능(캐시) · 검색 회수 · consumed 계보 · 규모 안전 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recall.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-recall-'));
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a],
  { cwd: temp, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: temp } });

const mk = (rel, obj) => {
  const p = path.join(temp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
};

try {
  mk('outputs/2026-08-01/045-w/run.json', {
    schema: 'marketing-team.run/v1', run_id: 'r-045', started_at: '2026-08-01T00:00:00Z',
    status: 'completed', request: '광고 주간 리포트 만들어줘',
    skills: [{ id: '045', name: '광고 주간 리포트' }],
    outputs: [{ path: 'workspace:outputs/2026-08-01/045-w/045-w.md' }],
  });
  mk('outputs/2026-08-02/046-r/run.json', {
    schema: 'marketing-team.run/v1', run_id: 'r-046', started_at: '2026-08-02T00:00:00Z',
    status: 'completed', request: '예산 재배분안 만들어줘',
    skills: [{ id: '046', name: 'ROAS 진단' }],
    outputs: [{ path: 'workspace:outputs/2026-08-02/046-r/046-r.md' }],
    steps: [{ step: 1, consumed: { 'workspace:outputs/2026-08-01/045-w/045-w.md': 'a'.repeat(64) } }],
  });

  let r = run('index');
  assert.match(r.stdout, /새로 2건/, '영수증 2건이 색인돼야 한다');
  r = run('index');
  assert.match(r.stdout, /새로 0건/, '증분 색인이어야 한다 — 다시 돌리면 0건');

  r = run('search', '예산 재배분');
  assert.match(r.stdout, /ROAS 진단\(046\)/, '키워드 회상이 맞는 실행을 찾아야 한다');
  assert.match(r.stdout, /046-r\.md/, '산출물 경로를 돌려줘야 한다');

  r = run('search', '', '--skill', '045');
  assert.match(r.stdout, /광고 주간 리포트\(045\)/, '스킬 필터가 돌아야 한다');

  r = run('graph', 'outputs/2026-08-01/045-w/045-w.md');
  assert.match(r.stdout, /먹힌 곳: r-046/, 'consumed 엣지로 뒤 실행(계보)을 찾아야 한다');
  r = run('graph', 'r-046');
  assert.match(r.stdout, /먹은 것 \(단계 1\)/, '앞 산출물 엣지를 보여야 한다');

  // 색인은 캐시다 — 지우고 다시 만들 수 있어야 한다 (gbrain 원칙 1)
  fs.rmSync(path.join(temp, 'logs', 'recall-index.jsonl'));
  r = run('index');
  assert.match(r.stdout, /새로 2건/, '색인을 지워도 원본에서 재생성돼야 한다');

  console.log('회상 · 색인 증분 2 · 검색 2 · 계보 2 · 캐시 재생성 1 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
