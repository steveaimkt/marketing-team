#!/usr/bin/env node
/**
 * output-checks.mjs · 산출물 내용을 기계로 잰다. 판단이 아니라 재는 일만 여기 둔다.
 *
 * 사용:
 *   node scripts/output-checks.mjs outputs/.../run.json
 *
 * run.json 의 `checks` 배열이 무엇을 돌릴지 정한다.
 *
 *   "checks": ["pii", "csv-format", "house-style"]
 *
 * `pii` 는 `pii` 블록이 있으면 `checks` 에 안 적어도 돈다 (하위 호환).
 *
 * 왜 이 층이 있나 · 실측 2026-08-30
 *   고급 시나리오 한 번에서 나온 결함 여섯 개를 **전부 스크립트가 잡았다.**
 *   대체키 복원 880/880 · 원문 ID 노출 · 요일 오탐 · 샘플 충돌 · 빌드 이동 ·
 *   검토 보고서의 원문 재인용. 담당(사업검토자)이 잡은 것은 논리 결함 쪽이었다.
 *   결정적으로 판정되는 것은 사람이 볼 자리가 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPii } from './pii-check.mjs';

/* ── 금칙어 · 정본은 docs/쉬운말.md §③ ─────────────────────── */

/** 우리 코드의 낱말 · 산출물에 나오면 그대로 새어 나간 것이다. 오탐이 없다. */
const HARD_TERMS = [
  ['mutating:', '「이 스킬은 밖으로 나갈 수 있습니다」'],
  ['writes_to', '「결과는 여기 저장했습니다 · <경로>」'],
  ['sample_fallback', '「회사 자료가 없어서 연습용 자료로 갔습니다」'],
  ['chains_to', '「이걸로 다음에 만들 수 있는 것」'],
  ['staff-gate-auditor', '「AI 규제검토자」'],
  ['staff-reviewer', '「AI 사업검토자」'],
  ['staff-compliance-setup', '「AI 규제세팅」'],
  ['에스컬레이션', '「제가 정할 자리가 아니라 여쭙니다」 · 「CS 우선 확인」'],
  ['폴백', '「회사 자료가 없어서 연습용 자료로 갔습니다」'],
];

/** 우리끼리 쓰는 말 · 자연스러운 쓰임이 있어 경고로만 낸다. */
const SOFT_TERMS = [
  ['라우팅', '「이 일에는 이 스킬이 맞겠습니다」'],
  ['착지', '「결과는 여기 저장했습니다」'],
  ['원장', '「실행 기록」'],
  ['정본', '「기준으로 삼는 자료」'],
];

const GATE_TOKEN = /(^|[^A-Za-z0-9])G[1-5]([^0-9]|$)/;

const TEXT_EXT = /\.(md|txt|html?)$/i;

function targetsOf(run, resolve) {
  const out = new Map();
  const add = ref => {
    if (!ref) return;
    try {
      const abs = resolve(ref);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.set(ref, abs);
    } catch { /* 경로 문제는 영수증 검사가 잡는다 */ }
  };
  for (const item of run.outputs || []) add(typeof item === 'string' ? item : item.path);
  for (const item of run.reviews || []) { add(item.report); add(item.artifact); }
  return out;
}

/** `.csv` 로 저장한 것이 실제 쉼표 구분 데이터인가 */
function checkCsvFormat(run, resolve) {
  const issues = [];
  for (const [ref, abs] of targetsOf(run, resolve)) {
    if (!/\.csv$/i.test(abs)) continue;
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw.startsWith('﻿')) issues.push(`CSV 에 UTF-8 BOM 이 없습니다 (엑셀에서 한글이 깨집니다): ${ref}`);
    const lines = raw.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    if (!lines.length) { issues.push(`CSV 가 비었습니다: ${ref}`); continue; }
    if (!lines[0].includes(',')) issues.push(`CSV 첫 줄에 쉼표가 없습니다. 열 이름 줄이 아닙니다: ${ref}`);
    const md = lines.filter(line => /^\s*(#{1,6}\s|\|.*\||-{3,}\s*$|\*\s|>\s)/.test(line));
    if (md.length) issues.push(`CSV 안에 마크다운이 들어 있습니다 · ${md.length}행: ${ref}`);
    const cols = lines[0].split(',').length;
    const ragged = lines.slice(1).filter(line => !/"/.test(line) && line.split(',').length !== cols);
    if (ragged.length) issues.push(`CSV 열 수가 첫 줄과 다른 행이 ${ragged.length}개 있습니다: ${ref}`);
  }
  return issues;
}

/** 우리 내부의 말이 사용자 화면에 나갔는가 */
function checkHouseStyle(run, resolve) {
  const issues = [];
  for (const [ref, abs] of targetsOf(run, resolve)) {
    if (!TEXT_EXT.test(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const [term, instead] of HARD_TERMS) {
      const n = text.split(term).length - 1;
      if (n) issues.push(`내부의 말이 산출물에 나왔습니다: \`${term}\` ${n}회 → ${instead} · ${ref}`);
    }
    for (const [term, instead] of SOFT_TERMS) {
      const n = text.split(term).length - 1;
      if (n) issues.push(`⚠ 다듬을 말: \`${term}\` ${n}회 → ${instead} · ${ref}`);
    }
    const dashes = text.split('\n').filter(line => line.includes('—')).length;
    if (dashes) issues.push(`⚠ 줄표(—)가 ${dashes}행에 있습니다. 가운뎃점 · 이나 마침표로 끊습니다 · ${ref}`);
    const gates = text.split('\n').filter(line => GATE_TOKEN.test(line)).length;
    if (gates) issues.push(`⚠ 게이트 이름(G1~G5)이 ${gates}행에 있습니다. 지금 무엇을 하는지로 씁니다 · ${ref}`);
  }
  return issues;
}

const REGISTRY = {
  'pii': (run, resolve) => scanPii(run, resolve),
  'csv-format': (run, resolve) => checkCsvFormat(run, resolve),
  'house-style': (run, resolve) => checkHouseStyle(run, resolve),
};

export const AVAILABLE_CHECKS = Object.keys(REGISTRY);

/**
 * @returns {Promise<string[]>} 문제 목록. `⚠` 로 시작하면 경고(완료를 막지 않는다).
 */
export async function runChecks(run, resolve) {
  const wanted = new Set(Array.isArray(run.checks) ? run.checks : []);
  if (run.pii) wanted.add('pii');            // 블록이 있으면 안 적어도 돈다
  const issues = [];
  for (const name of wanted) {
    const fn = REGISTRY[name];
    if (!fn) { issues.push(`모르는 검사입니다: ${name} (가능: ${AVAILABLE_CHECKS.join(' · ')})`); continue; }
    try {
      issues.push(...(await fn(run, resolve)));
    } catch (error) {
      issues.push(`${name} 검사를 돌리지 못했습니다: ${error.message}`);
    }
  }
  return issues;
}

/* ── CLI ───────────────────────────────────────────────────────── */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const WORK = path.resolve(process.cwd());
  const resolve = ref => {
    const raw = typeof ref === 'string' ? ref : ref?.path;
    if (!raw) throw new Error('경로가 비었습니다.');
    if (raw.startsWith('plugin:')) return path.resolve(PLUGIN, raw.slice('plugin:'.length));
    return path.resolve(WORK, raw.replace(/^workspace:/, ''));
  };
  const target = process.argv[2];
  if (!target) { console.error('🔴 run.json 경로가 필요합니다.'); process.exit(1); }
  const run = JSON.parse(fs.readFileSync(path.resolve(WORK, target), 'utf8'));
  const issues = await runChecks(run, resolve);
  const hard = issues.filter(line => !line.startsWith('⚠'));
  const soft = issues.filter(line => line.startsWith('⚠'));
  for (const line of hard) console.error(`⛔ ${line}`);
  for (const line of soft) console.warn(`🟡 ${line}`);
  if (hard.length) { console.error(`🔴 산출물 검사 실패 · ${hard.length}건`); process.exit(1); }
  const ran = [...new Set([...(run.checks || []), ...(run.pii ? ['pii'] : [])])];
  console.log(`✅ 산출물 검사 통과 · ${ran.length ? ran.join(' · ') : '선언된 검사 없음'}${soft.length ? ` · 경고 ${soft.length}건` : ''}`);
}
