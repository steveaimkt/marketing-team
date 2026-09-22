#!/usr/bin/env node
/** 팀원 맥락 훅 회귀 · 마케팅 작업 폴더에서만 켜지고, 개발 저장소와 다른 작업에는 끼어들지 않는다 (사용자 지적 2026-09-23) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'team-context.mjs');
const run = dir => spawnSync(process.execPath, [SCRIPT], {
  input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: dir }),
  encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-context-'));
try {
  const plain = path.join(temp, 'code'); fs.mkdirSync(plain);
  let r = run(plain);
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '', '마케팅 폴더가 아닌 곳에 끼어들었다');

  const ws = path.join(temp, 'ws'); fs.mkdirSync(path.join(ws, 'outputs'), { recursive: true });
  r = run(ws);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  for (const word of ['마케팅 팀원인 AI 마케터', 'ai-marketer 스킬을 연다', '트리거 문구와 달라도', '첫 줄에 무엇으로 하는지', 'plan.json 과 run.json'])
    assert.ok(out.additionalContext.includes(word), `맥락에 「${word}」가 없다`);

  const dev = path.join(temp, 'dev'); fs.mkdirSync(path.join(dev, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'outputs'));
  fs.writeFileSync(path.join(dev, '.claude-plugin', 'marketplace.json'), '{}');
  r = run(dev);
  assert.equal(r.stdout.trim(), '', '플러그인 개발 저장소에서 켜졌다');

  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: plain } });
  assert.equal(bad.status, 0, '입력을 못 읽으면 세션을 막았다');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('팀원 맥락 훅 · 다른 작업 무개입 1 · 마케팅 폴더 맥락 5 · 개발 저장소 무개입 1 · 입력 오류 무해 1 · ✅');
