#!/usr/bin/env node
/**
 * test-pii-check.mjs · 개인정보 검사 회귀
 *
 * 골든 케이스는 실측에서 나왔다 (2026-08-30).
 *   깨진 것 · 무염 SHA-256 앞 8자를 대체키로 쓴 산출물 + 검토 보고서가 원문 ID를 되풀이
 *   고친 것 · 실행마다 임의 대체키 + 어디에도 원문 인용 없음
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanPii } from './pii-check.mjs';

let pass = 0;
const check = (name, ok) => { if (!ok) { console.error(`🔴 ${name}`); process.exit(1); } pass++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-check-'));
const write = (rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const resolve = ref => path.join(root, String(ref).replace(/^(workspace|plugin):/, ''));

const IDS = Array.from({ length: 50 }, (_, i) => `C${1000 + i}`);
write('src/고객마스터.csv', `고객ID,주문금액\n${IDS.map(id => `${id},47000`).join('\n')}\n`);
const spec = {
  source: 'plugin:src/고객마스터.csv',
  id_columns: ['고객ID'],
  surrogate_column: '대체키',
};

// ① 깨진 것 · 무염 sha256 앞 8자
const weak = IDS.map(id => crypto.createHash('sha256').update(id).digest('hex').slice(0, 8));
write('out/broken.csv', `대체키,세그먼트\n${weak.map(k => `${k},챔피언`).join('\n')}\n`);
const brokenIssues = await scanPii(
  { outputs: ['workspace:out/broken.csv'], pii: spec }, resolve);
check('무염 해시 대체키를 복원으로 잡는다',
  brokenIssues.some(l => l.includes('복원됩니다') && l.includes('sha256')));

// ② 깨진 것 · 검토 보고서가 원문 ID 를 되풀이
write('out/review-경영.md', `원문 고객ID(예: \`${IDS[0]}\`)는 싣지 않았습니다.\n`);
const leakIssues = await scanPii(
  { outputs: [], reviews: [{ report: 'workspace:out/review-경영.md', artifact: 'workspace:out/review-경영.md' }], pii: spec },
  resolve);
check('검토 보고서의 원문 인용을 잡는다', leakIssues.some(l => l.includes('원문 식별자가 노출')));

// ③ 깨진 것 · 원문↔대체키 대응표가 남았다
const rnd = IDS.map(() => crypto.randomBytes(4).toString('hex'));
write('out/map.csv', `대체키,원본\n${rnd.map((k, i) => `${k},${IDS[i]}`).join('\n')}\n`);
const mapIssues = await scanPii({ outputs: ['workspace:out/map.csv'], pii: spec }, resolve);
check('원문↔대체키 대응표를 잡는다', mapIssues.some(l => l.includes('대응표가 남았습니다')));

// ④ 고친 것 · 실행마다 임의 대체키 · 원문 인용 없음
write('out/good.csv', `대체키,세그먼트\n${rnd.map(k => `${k},챔피언`).join('\n')}\n`);
write('out/good-해설.md', '원문 고객ID(`C` + 4자리 형식)는 산출물에 싣지 않았습니다.\n');
const goodIssues = await scanPii(
  { outputs: ['workspace:out/good.csv', 'workspace:out/good-해설.md'], pii: spec }, resolve);
check('임의 대체키 산출물은 통과한다', goodIssues.length === 0);

// ⑤ pii 블록이 없으면 건너뛴다
check('pii 블록이 없으면 통과', (await scanPii({ outputs: [] }, resolve)).length === 0);

fs.rmSync(root, { recursive: true, force: true });
console.log(`개인정보 검사 · 무염해시 복원 1 · 보고서 원문 인용 1 · 대응표 잔존 1 · 정상 통과 1 · 미선언 통과 1 · ✅ (${pass})`);
