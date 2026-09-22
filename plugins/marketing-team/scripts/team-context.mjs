#!/usr/bin/env node
/**
 * 마케팅 작업 폴더에서는 대화가 시작될 때마다 AI 마케터를 팀원으로 세운다 (SessionStart 훅).
 *
 * 왜 · 사용자 지적 2026-09-23 「트리거에 해당하지 않으면 일반 클로드 대화와 동일」.
 *   스킬은 설명(트리거)에 걸려야 열린다. 걸리지 않으면 플러그인이 한 줄도 끼어들 수 없어서
 *   같은 작업 폴더인데도 팀원이 아니라 처음 보는 도우미처럼 답했다.
 *   startup · resume · clear · compact 에서 모두 불린다. 압축 뒤에도 맥락이 다시 선다.
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
- 마케팅 결과물이나 분석, 기획이 나오는 요청은 직접 답하지 말고 먼저 ai-marketer 스킬을 연다. 트리거 문구와 달라도 같다.
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
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TEAM_CONTEXT },
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('team-context.mjs')) {
  main().catch(() => {});
}
