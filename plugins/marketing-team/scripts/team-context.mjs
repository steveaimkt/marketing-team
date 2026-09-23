#!/usr/bin/env node
/**
 * 마케팅 작업 폴더에서는 대화가 시작될 때마다 AI 마케터를 팀원으로 세운다 (SessionStart 훅).
 *
 * 왜 · 사용자 지적 2026-09-23 「트리거에 해당하지 않으면 일반 클로드 대화와 동일」.
 *   스킬은 설명(트리거)에 걸려야 열린다. 걸리지 않으면 플러그인이 한 줄도 끼어들 수 없어서
 *   같은 작업 폴더인데도 팀원이 아니라 처음 보는 도우미처럼 답했다.
 *   startup · resume · clear · compact 에서 모두 불린다. 압축 뒤에도 맥락이 다시 선다.
 *
 * UserPromptSubmit 에서도 불린다 (사용자 지시 2026-09-24 「말을 거는 순간 AI 마케터가 대답하게」).
 *   이 대화에서 ai-marketer 스킬이 아직 안 열렸으면, 인사든 짧은 질문이든 먼저 스킬을 열라고 붙인다.
 *   한 번 열렸으면(압축 뒤에도 스킬은 다시 붙는다) 아무것도 내지 않는다. 매번 다시 열면 컨텍스트만 불어난다.
 *   「/」로 시작하는 명령은 사용자가 이미 스킬을 고른 것이라 건드리지 않는다.
 *
 * 켜는 조건 · 작업 폴더에 brand · outputs · logs · inputs 중 하나가 있을 때만.
 *   다른 작업(코딩 등)에는 끼어들지 않는다. 플러그인 개발 저장소에서도 켜지 않는다.
 *   못 읽거나 조건이 안 맞으면 아무것도 내지 않는다. 훅이 세션을 막는 일은 없다.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOTS = ['brand', 'outputs', 'logs', 'inputs'];

export const TEAM_CONTEXT = `이 작업 폴더는 사용자의 마케팅 팀 공간이다. 이 대화에서 너는 사용자의 마케팅 팀원인 AI 마케터다.
- 이 대화의 첫 답을 하기 전에 ai-marketer 스킬을 연다. 인사나 짧은 질문이어도, 트리거 문구와 달라도 같다.
  「업무 리스트 보여줘」는 marketing-team-tasks, 「구축하자」·설치 점검은 marketing-team-setup 을 연다.
- 업무 요청에 답할 때는 첫 줄에 무엇으로 하는지 밝힌다. 「소비자 리뷰 분석(스킬 006)으로 하겠습니다」,
  「스킬 100개에 없는 일이라 제가 직접 하겠습니다」처럼. 인사나 짧은 질문처럼 업무가 아니면 첫 줄 없이 바로 답한다.
- 업무가 아닌 대화도 팀원으로 답한다. brand/profile.md 에 적힌 우리 회사를 알고 말하고, 결론을 먼저 쓰고,
  의견을 물으면 선택지를 늘어놓지 말고 추천 하나와 이유 한 줄을 낸다. 모르면 모른다고 하고 없는 숫자는 지어내지 않는다.
- 사용자에게 훅, 게이트, G1 같은 시스템 말을 쓰지 않는다.
- 대화가 압축된 뒤라면 승인과 진행 상태는 outputs 의 plan.json 과 run.json 에 있다. 이미 받은 승인을 다시 묻지 않는다.`;

export function isMarketingWorkspace(dir) {
  if (!dir) return false;
  try {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) return false; // 플러그인 개발 저장소
    return ROOTS.some(name => {
      try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch { return false; }
    });
  } catch { return false; }
}

export const PROMPT_CONTEXT = `이 메시지에 답하기 전에 ai-marketer 스킬을 먼저 연다. 인사나 짧은 질문이어도 같다. AI 마케터로서 답한다.
「업무 리스트 보여줘」처럼 목록을 보려는 말이면 marketing-team-tasks, 「구축하자」·설치 점검이면 marketing-team-setup 을 대신 연다.`;

const LOADED = /"skill"\s*:\s*"(?:marketing-team:)?ai-marketer"|[\\/]skills[\\/]ai-marketer[\\/]/;

/** 이 대화에서 ai-marketer 가 이미 열렸나 · 못 읽으면 안 열린 것으로 본다(한 번 더 여는 쪽이 덜 나쁘다) */
export function entrySkillLoaded(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
    return LOADED.test(fs.readFileSync(transcriptPath, 'utf8'));
  } catch { return false; }
}

async function main() {
  let input = {};
  try {
    let body = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) body += chunk;
    input = body.trim() ? JSON.parse(body) : {};
  } catch { /* 못 읽으면 아무것도 내지 않는다 */ }
  const dir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  if (!isMarketingWorkspace(dir)) return;
  if (input.hook_event_name === 'UserPromptSubmit') {
    if (String(input.prompt || '').trimStart().startsWith('/')) return;
    if (entrySkillLoaded(input.transcript_path)) return;
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_CONTEXT },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TEAM_CONTEXT },
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('team-context.mjs')) {
  main().catch(() => {});
}
