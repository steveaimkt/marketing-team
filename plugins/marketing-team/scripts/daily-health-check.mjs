#!/usr/bin/env node
/**
 * daily-health-check.mjs · 일일 자가검증 실행기 (개선 플랜 §14 · M1)
 *
 * 무엇을 하나 — 결정론 검사만 돈다. 실모델 실기는 여기 없다 (§14.3 · 주간/릴리스 관문).
 *   구조   scripts/verify.mjs 전체 (🔴 만 실패 · 🟡 은 「작업 중 드리프트」 정보로 분류)
 *   회귀   scripts/test-*.mjs 전부 (자기 자신 제외 · 파일 목록에서 자동 발견)
 *   안전   maintenance/self-check-policy.json 무결성 — 실행기 자신과 정책 파일이
 *          자동 수정 금지 목록에 들어 있는지 (검사자가 자기 기준을 못 바꾸게)
 *
 * 규칙:
 *   - 한 검사가 실패·정지해도 나머지를 끝까지 돌고, 마지막에 통합 판정한다.
 *   - 보고서는 저장소 루트 maintenance/reports/ 에 JSON 으로 남는다 (배포 밖 · plugins/ 아님).
 *   - 직전 보고서와 비교해 같은 검사가 연속 실패하면 circuit_break 로 표시한다 (M4 의 재료).
 *   - 이 스크립트는 아무것도 수정하지 않는다. 검사와 보고만 한다.
 *
 * 사용:  node scripts/daily-health-check.mjs [--list] [--only <이름조각>]
 * 시험용 환경변수:  DHC_CHECKS(검사 목록 JSON 경로) · DHC_REPORT_DIR · DHC_POLICY · DHC_TIMEOUT_MS
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
  ? path.resolve(ROOT, '..', '..') : ROOT;
const POLICY = process.env.DHC_POLICY || path.join(REPO, 'maintenance', 'self-check-policy.json');
const REPORT_DIR = process.env.DHC_REPORT_DIR || path.join(REPO, 'maintenance', 'reports');
const TIMEOUT = Number(process.env.DHC_TIMEOUT_MS || 300000);
const SELF = 'daily-health-check.mjs';

function defaultChecks() {
  const checks = [{ name: 'verify', area: '구조', script: path.join(ROOT, 'scripts', 'verify.mjs') }];
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).sort())
    if (/^test-.*\.mjs$/.test(f) && f !== 'test-daily-health-check.mjs')
      checks.push({ name: f.replace(/\.mjs$/, ''), area: '회귀', script: path.join(ROOT, 'scripts', f) });
  checks.push({ name: 'self-check-policy', area: '안전', policy: true });
  return checks;
}

function policyIssues() {
  if (!fs.existsSync(POLICY)) return [`정책 파일이 없다: ${POLICY}`];
  let p;
  try { p = JSON.parse(fs.readFileSync(POLICY, 'utf8')); } catch { return ['정책 파일이 JSON 이 아니다']; }
  const issues = [];
  const forbid = p.auto_fix?.forbid || [];
  if (!forbid.some(f => f.includes(SELF)))
    issues.push('실행기 자신이 자동 수정 금지 목록에 없다 — 검사자가 자기 기준을 바꿀 수 있게 된다');
  if (!forbid.some(f => f.includes('self-check-policy.json')))
    issues.push('정책 파일 자신이 자동 수정 금지 목록에 없다');
  if (!(Number(p.repeat_failure_limit) >= 1))
    issues.push('repeat_failure_limit 가 1 이상이 아니다');
  return issues;
}

function runOne(c) {
  const t0 = Date.now();
  if (c.policy) {
    const issues = policyIssues();
    return { name: c.name, area: c.area, ok: issues.length === 0, seconds: 0, tail: issues.join(' · ') || '정책 무결' };
  }
  if (!fs.existsSync(c.script))
    return { name: c.name, area: c.area, ok: false, seconds: 0, tail: `스크립트가 없다: ${c.script}` };
  const r = spawnSync(process.execPath, [c.script], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.signal && r.status === null);
  const row = {
    name: c.name, area: c.area,
    ok: !timedOut && r.status === 0,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    tail: timedOut ? `시간 초과 (${TIMEOUT}ms)` : out.trim().split('\n').slice(-2).join(' · ').slice(0, 300),
  };
  if (c.name === 'verify') {
    const m = out.match(/🔴 (\d+) · 🟡 (\d+)/);
    if (m) { row.red = Number(m[1]); row.yellow = Number(m[2]); }
  }
  return row;
}

function lastReport() {
  try {
    const files = fs.readdirSync(REPORT_DIR).filter(f => f.endsWith('.json')).sort();
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, files.at(-1)), 'utf8'));
  } catch { return null; }
}

// ── 진입 ──
const args = process.argv.slice(2);
let checks = process.env.DHC_CHECKS
  ? JSON.parse(fs.readFileSync(process.env.DHC_CHECKS, 'utf8'))
  : defaultChecks();
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
if (only) checks = checks.filter(c => c.name.includes(only));

if (args.includes('--list')) {
  console.log(JSON.stringify(checks.map(c => ({ name: c.name, area: c.area })), null, 2));
  process.exit(0);
}

const git = a => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout?.trim() || '';
const commit = git(['rev-parse', '--short', 'HEAD']) || 'no-git';
const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean).length;
let version = null;
try { version = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch {}

const prev = lastReport();
const started = new Date();
const rows = checks.map(c => {
  const row = runOne(c);
  console.log(`${row.ok ? '✅' : '🔴'} ${row.area} · ${row.name} · ${row.seconds}s${row.ok ? '' : ` · ${row.tail}`}`);
  return row;
});

const failed = rows.filter(r => !r.ok);
const prevFailed = new Set((prev?.checks || []).filter(r => !r.ok).map(r => r.name));
for (const r of failed) r.repeat = prevFailed.has(r.name);
let limit = 2;
try { limit = Number(JSON.parse(fs.readFileSync(POLICY, 'utf8')).repeat_failure_limit) || 2; } catch {}
const circuit = failed.filter(r => r.repeat).map(r => r.name);

const verifyRow = rows.find(r => r.name === 'verify');
const report = {
  schema: 'marketing-team.health/v1',
  at: started.toISOString(),
  commit, dirty_files: dirty, version,
  checks: rows,
  counts: { total: rows.length, passed: rows.length - failed.length, failed: failed.length },
  drift: { yellow: verifyRow?.yellow ?? null, dirty_files: dirty },   // 정보 — 실패로 세지 않는다 (§14 결정 ①)
  circuit_break: circuit.length >= 1 && failed.filter(r => r.repeat).length >= limit - 1 ? circuit : [],
  elapsed_s: Math.round((Date.now() - started.getTime()) / 100) / 10,
};
fs.mkdirSync(REPORT_DIR, { recursive: true });
const fname = `${started.toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${commit}.json`;
fs.writeFileSync(path.join(REPORT_DIR, fname), JSON.stringify(report, null, 2) + '\n');

const driftNote = report.drift.yellow ? ` · 드리프트 🟡${report.drift.yellow} (정보 · 릴리스 때 버전과 함께)` : '';
const circuitNote = report.circuit_break.length ? ` · ⛔ 연속 실패 회로: ${report.circuit_break.join(', ')} — 자동 수정 금지, 사용자 판단 필요` : '';
console.log(`${failed.length ? '🔴' : '✅'} 자가검증 · 검사 ${report.counts.total} · 실패 ${failed.length}${driftNote}${circuitNote}`);
console.log(`   보고서 ${path.relative(REPO, path.join(REPORT_DIR, fname))}`);
process.exit(failed.length ? 1 : 0);
