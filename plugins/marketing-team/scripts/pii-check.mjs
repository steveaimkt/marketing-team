#!/usr/bin/env node
/**
 * pii-check.mjs · 개인 식별 정보가 산출물에 남았는지 기계로 잰다.
 *
 * 사용:
 *   node scripts/pii-check.mjs outputs/.../run.json
 *
 * run.json 에 `pii` 블록이 있을 때만 돈다. 없으면 통과다.
 *
 *   "pii": {
 *     "source": "plugin:sample-data/A브랜드-고객마스터.csv",
 *     "id_columns": ["고객ID"],
 *     "surrogate_column": "대체키"
 *   }
 *
 * 왜 담당이 아니라 기계인가 · 실측 2026-08-30
 *   065 산출물이 무염 SHA-256 앞 8자를 「되돌릴 수 없는 대체키」라고 적었다.
 *   880개 전부 1초 만에 복원됐다. 경영 검토자는 「이 관점 밖」이라며 넘겼고,
 *   규제검토자는 gate:false 라 불리지 않았다. 아무도 안 봤다.
 *   복원 가능 여부는 판단할 일이 아니라 재는 일이다. 그래서 여기 있다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HASHES = ['md5', 'sha1', 'sha256', 'sha512', 'blake2s256', 'blake2b512'];
const MIN_PREFIX = 4;
const MIN_ID_LENGTH = 3;

/** 첫 줄이 열 이름인 CSV 를 읽는다. BOM 과 큰따옴표만 다룬다. */
function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(line => line.length);
  if (!lines.length) return { header: [], rows: [] };
  const split = line => {
    const out = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cell); cell = ''; }
      else cell += ch;
    }
    out.push(cell);
    return out;
  };
  const header = split(lines[0]);
  return { header, rows: lines.slice(1).map(split) };
}

function columnValues(file, columns) {
  const { header, rows } = readCsv(file);
  const missing = columns.filter(name => !header.includes(name));
  const values = new Set();
  for (const name of columns) {
    const at = header.indexOf(name);
    if (at < 0) continue;
    for (const row of rows) {
      const value = (row[at] || '').trim();
      if (value) values.add(value);
    }
  }
  return { values, missing };
}

/** 원문에서 유도할 수 있는 값을 전부 펼친다 — 대체키가 여기 걸리면 복원 가능한 것이다. */
function derivations(ids) {
  const out = new Map();
  const put = (value, how) => { if (value && !out.has(value)) out.set(value, how); };
  for (const id of ids) {
    put(id, '원문 그대로');
    put(id.toLowerCase(), '원문 소문자');
    put(id.toUpperCase(), '원문 대문자');
    put(Buffer.from(id, 'utf8').toString('base64'), 'base64');
    put(Buffer.from(id, 'utf8').toString('hex'), 'hex');
    for (const algo of HASHES) {
      let digest;
      try { digest = crypto.createHash(algo).update(id, 'utf8').digest('hex'); }
      catch { continue; }
      for (let n = MIN_PREFIX; n <= digest.length; n++) put(digest.slice(0, n), `${algo} 앞 ${n}자`);
    }
  }
  return out;
}

/**
 * @param {object} run  run.json 내용
 * @param {(ref:string)=>string} resolve  `workspace:` · `plugin:` 참조를 절대 경로로
 * @returns {Promise<string[]>} 문제 목록 (빈 배열이면 통과)
 */
export async function scanPii(run, resolve) {
  const spec = run.pii;
  if (!spec) return [];
  const issues = [];

  let sourceAbs;
  try { sourceAbs = resolve(spec.source); }
  catch (error) { return [`개인정보 원본 경로를 읽지 못했습니다: ${spec.source} (${error.message})`]; }
  if (!fs.existsSync(sourceAbs)) return [`개인정보 원본이 없습니다: ${spec.source}`];

  const columns = Array.isArray(spec.id_columns) ? spec.id_columns : [];
  if (!columns.length) return ['pii.id_columns 가 비었습니다. 식별자 열 이름을 적으세요.'];

  const { values: ids, missing } = columnValues(sourceAbs, columns);
  for (const name of missing) issues.push(`원본에 식별자 열이 없습니다: ${name} (${spec.source})`);
  const usable = [...ids].filter(id => id.length >= MIN_ID_LENGTH);
  const tooShort = ids.size - usable.length;
  if (!usable.length) {
    issues.push(`검사할 식별자가 없습니다 (${MIN_ID_LENGTH}자 미만은 오탐이라 건너뜁니다).`);
    return issues;
  }

  // 검사 대상 · 산출물 전부 + 검토 보고서 전부
  const targets = new Map();
  const add = ref => {
    if (!ref) return;
    try {
      const abs = resolve(ref);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) targets.set(ref, abs);
    } catch { /* 못 읽는 참조는 다른 검사가 잡는다 */ }
  };
  for (const item of run.outputs || []) add(typeof item === 'string' ? item : item.path);
  for (const item of run.reviews || []) { add(item.report); add(item.artifact); }

  // ① 원문 노출 — 식별자가 산출물·보고서 어디에도 인용되면 안 된다
  for (const [ref, abs] of targets) {
    const text = fs.readFileSync(abs, 'utf8');
    const hits = usable.filter(id => text.includes(id));
    if (hits.length) {
      const sample = hits.slice(0, 3).map(id => `${id.slice(0, 1)}…`).join(' · ');
      issues.push(`원문 식별자가 노출됐습니다: ${ref} · ${hits.length}건 (예: ${sample})`);
    }
  }

  // ② 복원 가능성 — 대체키가 원문에서 유도되면 마스킹이 아니다
  if (spec.surrogate_column) {
    const derived = derivations(usable);
    for (const [ref, abs] of targets) {
      if (!/\.csv$/i.test(abs)) continue;
      const { header, rows } = readCsv(abs);
      const at = header.indexOf(spec.surrogate_column);
      if (at < 0) continue;
      const broken = new Map();
      for (const row of rows) {
        const key = (row[at] || '').trim();
        if (key && derived.has(key)) broken.set(key, derived.get(key));
      }
      if (broken.size) {
        const how = [...new Set(broken.values())].slice(0, 2).join(' · ');
        issues.push(
          `대체키가 원문에서 복원됩니다: ${ref} · ${broken.size}/${rows.length}건 · 유도 방식 ${how}`,
        );
      }
    }
  }

  // ③ 대응표 잔존 — 원문과 대체키가 같은 줄에 함께 있으면 표를 저장한 것이다
  if (spec.surrogate_column) {
    for (const [ref, abs] of targets) {
      const surrogates = new Set();
      if (/\.csv$/i.test(abs)) {
        const { header, rows } = readCsv(abs);
        const at = header.indexOf(spec.surrogate_column);
        if (at >= 0) for (const row of rows) { const v = (row[at] || '').trim(); if (v) surrogates.add(v); }
      }
      if (!surrogates.size) continue;
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      const paired = lines.filter(line =>
        usable.some(id => line.includes(id)) && [...surrogates].some(key => line.includes(key)));
      if (paired.length) issues.push(`원문↔대체키 대응표가 남았습니다: ${ref} · ${paired.length}행`);
    }
  }

  if (tooShort) {
    issues.push(`⚠ 참고 · ${MIN_ID_LENGTH}자 미만 식별자 ${tooShort}건은 오탐이라 검사에서 뺐습니다.`);
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
  if (!run.pii) { console.log('⚪ pii 블록이 없어 건너뜁니다.'); process.exit(0); }
  const issues = await scanPii(run, resolve);
  const hard = issues.filter(line => !line.startsWith('⚠'));
  for (const line of issues) console[hard.includes(line) ? 'error' : 'warn'](`${hard.includes(line) ? '⛔' : '🟡'} ${line}`);
  if (hard.length) { console.error(`🔴 개인정보 검사 실패 · ${hard.length}건`); process.exit(1); }
  console.log('✅ 개인정보 검사 통과 · 원문 노출 0 · 복원 0 · 대응표 0');
}
