#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, eventPath, readEvents, summarizeEvents } from './orchestrator-events.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-events-'));
try {
  const run = { run_id: 'run-1', status: 'running', skills: [{ id: '046' }] };
  appendEvent(temp, run, 'run.started');
  appendEvent(temp, run, 'step.completed', { step: 1 });
  run.status = 'completed'; appendEvent(temp, run, 'run.completed');
  const rows = readEvents(eventPath(temp));
  const summary = summarizeEvents(rows, 'run-1');
  assert.equal(rows.length, 3);
  assert.equal(summary.current_status, 'completed');
  assert.equal(summary.counts['step.completed'], 1);
  console.log('오케스트레이터 이벤트 · 기록 3 · 실행 요약 1 · ✅');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
