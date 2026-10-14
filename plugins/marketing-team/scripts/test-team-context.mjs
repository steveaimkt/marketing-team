#!/usr/bin/env node
/** 팀원 맥락 훅 회귀 · 마케팅 작업 폴더에서만 켜지고, 개발 저장소와 다른 작업에는 끼어들지 않는다 (사용자 지적 2026-09-23) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { profileState } from './plan-compiler.mjs';

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

  // 책 실습 대본 · 우리 양식(brand/skill-notes/043.md)이 있으면 6장 대본을 열지 않고 평소대로 돈다 (2026-10-14)
  const book = path.join(temp, 'book'); fs.mkdirSync(path.join(book, 'outputs'), { recursive: true });
  r = say(book, '광고 카피 뽑아줘.', fresh);
  assert.ok(r.stdout.includes('책 실습'), '보완 파일이 없는데 6장 대본을 열지 않았다');
  const noted = path.join(temp, 'noted'); fs.mkdirSync(path.join(noted, 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(noted, 'brand', 'skill-notes'), { recursive: true });
  fs.writeFileSync(path.join(noted, 'brand', 'skill-notes', '043.md'), '# 043 우리 규칙\n형식: docx\n');
  r = say(noted, '광고 카피 뽑아줘.', fresh);
  assert.ok(!r.stdout.includes('책 실습') && r.stdout.includes('ai-marketer'), '보완 파일이 있는데 책 실습 대본을 열었다');

  // 7장 「대시보드 만들어줘.」 · 빠른 진입이라 계획이 없어 모델이 「판매 분석 대시보드가 이미 있는데 062 로 갈까요?」로
  // 되묻곤 했다 (실측 2026-10-14 · 세 번에 한 번꼴). 061 원고 결과가 있으면 대본이 062 원고 결과와 화면을 낸다
  const REF = path.join(path.dirname(SCRIPT), '..', 'sample-data', '참고결과');
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const with061 = name => {
    const w = path.join(temp, name); const out = path.join(w, 'outputs', today, '061-sales-data-analysis');
    fs.mkdirSync(out, { recursive: true });
    for (const n of fs.readdirSync(path.join(REF, '061-sales-data-analysis')).filter(n => !['화면.md', '출처.md'].includes(n)))
      fs.writeFileSync(path.join(out, n), /\.(md|html|csv)$/.test(n) ? fs.readFileSync(path.join(REF, '061-sales-data-analysis', n), 'utf8').replaceAll('{날짜}', today) : fs.readFileSync(path.join(REF, '061-sales-data-analysis', n)));
    return w;
  };
  const dash = with061('dash');
  const placed = path.join(dash, 'outputs', today, '062-marketing-dashboard', '062-marketing-dashboard.html');
  r = say(dash, '대시보드 만들어줘.', fresh);
  assert.ok(r.stdout.includes('책 실습') && r.stdout.includes('마케팅 대시보드입니다'), '061 결과가 있는데 「대시보드 만들어줘.」 대본이 열리지 않았다');
  assert.equal(fs.readFileSync(placed, 'utf8'), fs.readFileSync(path.join(REF, '062-marketing-dashboard', '062-marketing-dashboard.html'), 'utf8'), '062 원고 결과가 기준본과 다르게 놓였다');
  r = say(dash, '아니 괜찮아', fresh);
  assert.ok(r.stdout.includes('책 실습') && r.stdout.includes('자동 갱신은 걸지 않겠습니다'), '대시보드 대본이 놓은 062 결과로 「아니 괜찮아」가 열리지 않았다');
  r = say(dash, '대시보드 만들어줘.', fresh);
  assert.ok(!r.stdout.includes('책 실습'), '「이후」 대본이 두 번 열렸다');
  const dash2 = with061('dash2');
  r = say(dash2, '대시보드 만들어줘', fresh);
  assert.ok(r.stdout.includes('책 실습'), '마침표 없는 「대시보드 만들어줘」에 대본이 열리지 않았다');
  const no061 = path.join(temp, 'no061'); fs.mkdirSync(path.join(no061, 'outputs'), { recursive: true });
  r = say(no061, '대시보드 만들어줘.', fresh);
  assert.ok(!r.stdout.includes('책 실습'), '061 결과가 없는데 대시보드 대본을 열었다');
  assert.ok(!fs.existsSync(path.join(no061, 'outputs', today, '062-marketing-dashboard')), '061 결과가 없는데 062 파일을 놓았다');
  const dashNoted = with061('dashNoted');
  fs.mkdirSync(path.join(dashNoted, 'brand', 'skill-notes'), { recursive: true });
  fs.writeFileSync(path.join(dashNoted, 'brand', 'skill-notes', '062.md'), '# 062 우리 규칙\n형식: docx\n');
  r = say(dashNoted, '대시보드 만들어줘.', fresh);
  assert.ok(!r.stdout.includes('책 실습'), '062 보완 파일이 있는데 대시보드 대본을 열었다');
  const dashOwn = with061('dashOwn');
  fs.mkdirSync(path.join(dashOwn, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(dashOwn, 'brand', 'profile.md'), '# 브랜드 프로필\n\n## 1. 기본 정보\n\n| 항목 | 내용 |\n|---|---|\n| 브랜드명 | 우리회사 |\n| 업종 | 반려동물 사료 |\n');
  assert.equal(profileState(dashOwn), '채움', '시험용 프로필이 채움으로 읽히지 않는다');
  r = say(dashOwn, '대시보드 만들어줘.', fresh);
  assert.ok(!r.stdout.includes('책 실습'), '프로필을 채웠는데 대시보드 대본을 열었다');

  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: plain } });
  assert.equal(bad.status, 0, '입력을 못 읽으면 세션을 막았다');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('팀원 맥락 훅 · 다른 작업 무개입 1 · 마케팅 폴더 맥락 6 · 개발 저장소 무개입 1 · 말 걸면 AI 마케터 6 · 보완 파일 대본 끔 2 · 7장 대시보드 대본 9 · 입력 오류 무해 1 · ✅');
