#!/usr/bin/env node
/** 실행 상태 전이를 JSONL로 남기고 한 번에 요약한다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function eventPath(workspace) { return path.join(workspace, 'logs', 'orchestrator-events.jsonl'); }

export function appendEvent(workspace, run, type, detail = {}) {
  const file = eventPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = {
    at: new Date().toISOString(), type,
    run_id: run.run_id || null,
    plan_sha256: run.plan?.plan_sha256 || null,
    skills: (run.skills || []).map(skill => skill.id || String(skill)),
    status: run.status || null,
    ...detail,
  };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return row;
}

export function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${path.basename(file)} ${index + 1}행 JSON 오류: ${error.message}`); }
  });
}

export function summarizeEvents(rows, runId = null) {
  let selected = runId ? rows.filter(row => row.run_id === runId) : rows;
  if (runId && selected.length) {
    // 상관 확장 (P2 · 2026-08-30) — 실행 이전의 라우팅·계획 흔적을 같은 타래로 묶는다.
    // 계획은 plan_sha256, 라우팅은 요청 원문이 상관키다. run_id 없는 행만 끌어온다.
    const hashes = new Set(selected.map(row => row.plan_sha256).filter(Boolean));
    const requests = new Set(selected.map(row => row.request).filter(Boolean));
    const linked = rows.filter(row => !row.run_id && (
      (row.plan_sha256 && hashes.has(row.plan_sha256)) ||
      (row.request && requests.has(row.request))));
    selected = [...linked, ...selected].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  }
  const counts = {};
  for (const row of selected) counts[row.type] = (counts[row.type] || 0) + 1;
  const lastRun = [...selected].reverse().find(row => row.run_id === runId) || selected.at(-1);
  return {
    run_id: runId,
    events: selected.length,
    first_at: selected[0]?.at || null,
    last_at: selected.at(-1)?.at || null,
    current_status: lastRun?.status || null,
    counts,
  };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const [command, fileArg, runId] = process.argv.slice(2);
  if (command !== 'summary') { console.error('사용: orchestrator-events.mjs summary [events.jsonl] [run_id]'); process.exit(1); }
  const file = path.resolve(process.cwd(), fileArg || 'logs/orchestrator-events.jsonl');
  try { console.log(JSON.stringify(summarizeEvents(readEvents(file), runId || null), null, 2)); }
  catch (error) { console.error(`🔴 ${error.message}`); process.exit(1); }
}
