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
  for (const word of ['마케팅 팀원인 AI 마케터', 'ai-marketer 스킬을 연다', '트리거 문구와 달라도', '첫 줄에 무엇으로 하는지', 'plan.json 과 run.json', '첫 답을 하기 전에'])
    assert.ok(out.additionalContext.includes(word), `맥락에 「${word}」가 없다`);

  const dev = path.join(temp, 'dev'); fs.mkdirSync(path.join(dev, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dev, 'outputs'));
  fs.writeFileSync(path.join(dev, '.claude-plugin', 'marketplace.json'), '{}');
  r = run(dev);
  assert.equal(r.stdout.trim(), '', '플러그인 개발 저장소에서 켜졌다');

  // UserPromptSubmit · 말을 거는 순간 AI 마케터가 답한다 (사용자 지시 2026-09-24)
  const say = (dir, prompt, transcript) => spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: dir, transcript_path: transcript }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  const fresh = path.join(temp, 'fresh.jsonl'); fs.writeFileSync(fresh, '{"type":"user","message":{"role":"user","content":"안녕"}}\n');
  r = say(ws, '안녕', fresh);
  const p1 = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(p1.hookEventName, 'UserPromptSubmit');
  assert.ok(p1.additionalContext.includes('ai-marketer 스킬을 먼저 연다'), '인사에도 AI 마케터를 열라고 하지 않았다');
  assert.ok(p1.additionalContext.includes('marketing-team-tasks'), '업무 리스트 요청의 자리가 없다');
  r = say(ws, '안녕', path.join(temp, 'none.jsonl'));
  assert.ok(r.stdout.includes('ai-marketer'), '기록을 못 읽을 때 열라고 하지 않았다');
  const loaded = path.join(temp, 'loaded.jsonl');
  fs.writeFileSync(loaded, '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"marketing-team:ai-marketer"}}]}}\n');
  r = say(ws, '리뷰 분석해줘', loaded);
  assert.equal(r.stdout.trim(), '', '이미 연 스킬을 매번 다시 열라고 했다');
  r = say(ws, '/marketing-team-setup 마케팅 팀 구축하자', fresh);
  assert.equal(r.stdout.trim(), '', '사용자가 고른 명령에 끼어들었다');
  r = say(plain, '안녕', fresh);
  assert.equal(r.stdout.trim(), '', '마케팅 폴더가 아닌 곳에서 말에 끼어들었다');
  r = say(dev, '안녕', fresh);
  assert.equal(r.stdout.trim(), '', '개발 저장소에서 말에 끼어들었다');

  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: plain } });
  assert.equal(bad.status, 0, '입력을 못 읽으면 세션을 막았다');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('팀원 맥락 훅 · 다른 작업 무개입 1 · 마케팅 폴더 맥락 6 · 개발 저장소 무개입 1 · 말 걸면 AI 마케터 6 · 입력 오류 무해 1 · ✅');
