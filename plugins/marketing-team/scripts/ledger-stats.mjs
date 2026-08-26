#!/usr/bin/env node
/**
 * ledger-stats.mjs · 실적 원장을 읽어 부피를 재고 진단 신호를 뽑는다.
 *
 * 왜: 원장은 지우지 않고 쌓는다. 그런데 쌓기만 하면 무거워지기만 하고 아무것도 나아지지 않는다.
 *     원장에는 이미 답이 들어 있다 — 어느 스킬이 죽었고, 어느 스킬이 한 번에 안 나오고,
 *     어디서 규제에 걸리고, 어디서 파일이 안 남는지. 사람이 세면 안 센다. **기계가 센다.**
 *     (부피 규칙 정본 — docs/공통규약.md 「원장 롤오버」)
 *
 * 사용: node scripts/ledger-stats.mjs                작업 폴더의 원장을 재고 진단한다
 *       node scripts/ledger-stats.mjs --check        롤오버가 필요하면 종료코드 1
 *       node scripts/ledger-stats.mjs --summary      logs/build-log-summary.md 를 갱신한다
 *       node scripts/ledger-stats.mjs --dir <경로>   작업 폴더를 지정한다 (기본: 현재 폴더)
 *       node scripts/ledger-stats.mjs --hook         SessionStart 훅 모드 · 말할 것이 있을 때만 JSON
 *                                                    (7일 주기 · 원장 없으면 무음 · hooks/hooks.json 이 부른다)
 *
 * ⛔ 이 스크립트는 **읽고 summary 만 쓴다.** 원장을 옮기거나 지우지 않는다 —
 *    롤오버는 사용자 승인이 필요한 상태 변경이라 `마케팅팀-구축하기` 가 ⏸ 로 물어보고 한다.
 */
import fs from 'node:fs';
// ⚠️ 윈도우 CRLF 방어 — build-stats.mjs 와 같은 이유. 읽는 즉시 눕힌다.
const _readFileSync = fs.readFileSync;
fs.readFileSync = (p, o) =>
  (o === 'utf8' || o?.encoding === 'utf8')
    ? String(_readFileSync(p, o)).replace(/\r\n/g, '\n')
    : _readFileSync(p, o);

import path from 'node:path';

const CHECK = process.argv.includes('--check');
const SUMMARY = process.argv.includes('--summary');
// --hook · SessionStart 훅이 부르는 조용한 모드. 말할 것이 있을 때만 JSON 한 덩이를 낸다.
//   훅은 모든 세션에서 돈다 — 마케팅 작업 폴더가 아니거나 이상이 없으면 **아무것도 출력하지 않는다.**
const HOOK = process.argv.includes('--hook');
const HOOK_INTERVAL_DAYS = 7;   // 같은 폴더에서 이 주기 안에는 다시 보지 않는다 (잔소리 방지)
const say = HOOK ? () => {} : (...a) => console.log(...a);
const dirFlag = process.argv.indexOf('--dir');
const WORK = path.resolve(dirFlag > -1 ? process.argv[dirFlag + 1] : process.cwd());
const LOGS = path.join(WORK, 'logs');
const LEDGER = path.join(LOGS, 'build-log.md');
const ARCHIVE = path.join(LOGS, 'archive');

// 정본 임계 — docs/공통규약.md 「원장 롤오버」와 같아야 한다. verify.mjs 가 드리프트를 잡는다.
const ROLLOVER_ROWS = 800;
const STALE_DAYS = 90;
const REWORK_AVG = 2;      // 평균 보완 횟수가 이 이상이면 한 번에 안 나오는 스킬
const BLOCK_RATE = 0.3;    // 차단률이 이 이상이면 규제와 계속 부딪히는 스킬
const SAMPLE_RATE = 0.8;   // 샘플률이 이 이상(3건 이상)이면 실데이터가 안 붙어 있다

const COLS = ['일시', '스킬 ID', '요청', '데이터 모드', '산출물 경로', '게이트', '보완 횟수', '상태'];

/** 마크다운 표 한 줄을 셀로 가른다. `\|` 는 값 안의 파이프다. */
const cells = line =>
  line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

/** 원장 하나를 읽어 데이터 행만 돌려준다. 머리말·헤더·구분선·빈 행은 버린다. */
function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|') || line.startsWith('>')) continue;
    const c = cells(line);
    if (c[0] === COLS[0]) continue;                      // 헤더
    if (/^:?-{2,}:?$/.test(c[0])) continue;              // 구분선
    if (c.join('') === '') continue;                     // 빈 행 (템플릿 잔재)
    if (c.length < COLS.length) continue;                // 구형 6열 — 세지 않는다
    const [일시, 스킬, 요청, 모드, 경로, 게이트, 보완, 상태] = c;
    rows.push({ 일시, 스킬, 요청, 모드, 경로, 게이트, 보완: Number(보완) || 0, 상태, file });
  }
  return rows;
}

const archiveFiles = fs.existsSync(ARCHIVE)
  ? fs.readdirSync(ARCHIVE).filter(f => /^build-log-.*\.md$/.test(f)).sort().map(f => path.join(ARCHIVE, f))
  : [];

const current = readLedger(LEDGER);
const all = [...archiveFiles.flatMap(readLedger), ...current];

const day = s => (s || '').slice(0, 10);
// 원장 일시는 사용자의 **로컬** 시각이다. toISOString() 은 UTC 라 하루가 어긋난다 (KST 오전에 실측).
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const days = d => Math.floor((Date.now() - new Date(`${d}T00:00:00`).getTime()) / 86400000);
const 완료 = r => r.상태 === '완료';
const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;

if (!fs.existsSync(LEDGER)) {
  // 훅은 모든 세션에서 돈다 — 여기가 마케팅 작업 폴더가 아니면 조용히 빠진다. 이것이 정상 경로다.
  say(`원장이 없습니다 — ${path.relative(WORK, LEDGER)}`);
  say('「마케팅팀 구축하자」가 brand-templates/build-log.md 를 복사합니다.');
  process.exit(0);
}

// 훅 주기 제한 — 같은 폴더를 매 세션 들여다보면 잔소리가 된다. 7일에 한 번만 본다.
const STAMP = path.join(LOGS, '.ledger-check');
if (HOOK) {
  try {
    const last = fs.readFileSync(STAMP, 'utf8').trim();
    if (last && days(last) < HOOK_INTERVAL_DAYS) process.exit(0);
  } catch { /* 스탬프가 없으면 이번이 처음이다 */ }
}

say(`\n실적 원장 점검 · ${path.relative(WORK, LEDGER)}${WORK === process.cwd() ? '' : `  (${WORK})`}\n`);

// ── 1. 부피 ────────────────────────────────────────────────────────────────
const yrs = [...new Set(current.map(r => day(r.일시).slice(0, 4)))].filter(Boolean).sort();
const thisYear = String(new Date().getFullYear());
const staleYear = yrs.some(y => y && y !== thisYear);
const overRows = current.length > ROLLOVER_ROWS;
const needRollover = overRows || staleYear;

// 행이 시간순으로 쌓인다는 보장이 없다 (손으로 끼워 넣기도 한다). 최소·최대를 직접 구한다.
const ds = current.map(r => day(r.일시)).filter(Boolean).sort();
const span = ds.length ? `${ds[0]} ~ ${ds.at(-1)}` : '비어 있음';
say(`  부피    ${current.length}행 (${span})${archiveFiles.length ? ` · 아카이브 ${archiveFiles.length}개 ${all.length - current.length}행` : ''}`);

if (needRollover) {
  const why = [overRows && `${ROLLOVER_ROWS}행 초과`, staleYear && `${yrs.filter(y => y !== thisYear).join('·')}년 행이 섞여 있음`].filter(Boolean).join(' · ');
  say(`  🟡 롤오버 필요 — ${why}`);
  say(`     「마케팅팀 구축하자」가 ⏸ 로 물어보고 logs/archive/ 로 옮깁니다. 지우지 않습니다.`);
} else {
  say(`  ✅ 부피 정상 (임계 ${ROLLOVER_ROWS}행 · 연도 ${thisYear})`);
}

if (!all.length) {
  say('\n데이터 행이 없습니다 — 진단할 것이 아직 없습니다.\n');
  process.exit(0);
}

// ── 2. 스킬별 집계 ─────────────────────────────────────────────────────────
const by = new Map();
for (const r of all) {
  if (!r.스킬) continue;
  const s = by.get(r.스킬) || { 스킬: r.스킬, rows: [], 최초: r.일시, 최종: r.일시 };
  s.rows.push(r);
  if (day(r.일시) < day(s.최초)) s.최초 = r.일시;
  if (day(r.일시) > day(s.최종)) s.최종 = r.일시;
  by.set(r.스킬, s);
}
for (const s of by.values()) {
  s.누적 = s.rows.filter(완료).length;                                   // 카운터는 완료만 — 원장 머리말 규칙
  s.차단 = s.rows.filter(r => r.상태 === '차단됨').length;
  s.저장실패 = s.rows.filter(r => r.상태 === '저장실패').length;
  s.샘플 = s.rows.filter(r => r.모드 === '샘플').length;
  s.보완평균 = s.rows.reduce((a, r) => a + r.보완, 0) / s.rows.length;
  s.무호출일 = days(day(s.최종));
}
const skills = [...by.values()].sort((a, b) => b.rows.length - a.rows.length);
say(`\n  스킬    ${skills.length}종 · 완료 ${all.filter(완료).length}건 / 전체 ${all.length}행`);

// ── 3. 진단 신호 · 원장이 시스템을 고치는 자리 ─────────────────────────────
const 신호 = [];
for (const s of skills) {
  if (s.무호출일 >= STALE_DAYS)
    신호.push(['🔕 무호출', s.스킬, `${s.무호출일}일째 · 마지막 ${day(s.최종)}`, '상시에서 내릴지 묻는다']);
  if (s.rows.length >= 3 && s.보완평균 >= REWORK_AVG)
    신호.push(['🔁 재작업', s.스킬, `평균 보완 ${s.보완평균.toFixed(1)}회 (${s.rows.length}건)`, '이 스킬의 inputs·브리핑이 부실하다']);
  if (s.rows.length >= 3 && s.차단 / s.rows.length >= BLOCK_RATE)
    신호.push(['⛔ 차단', s.스킬, `${s.차단}/${s.rows.length}건 (${pct(s.차단, s.rows.length)}%)`, '표현 규칙을 프롬프트에 미리 넣는다']);
  if (s.rows.length >= 3 && s.샘플 / s.rows.length >= SAMPLE_RATE)
    신호.push(['📄 샘플', s.스킬, `${s.샘플}/${s.rows.length}건`, '실데이터가 안 붙어 있다 — 프로필·MCP 확인']);
  if (s.저장실패)
    신호.push(['💾 저장실패', s.스킬, `${s.저장실패}건`, '착지가 실패했다 — 회수 가능한지 본다']);
}

// ── 완주 조건 사후 대조 ────────────────────────────────────────────────────
//   문서는 「파일 착지 · 규제 게이트 · 원장 1행」을 33·5·23회 강조하는데 재는 곳이 없었다.
//   원장 1행은 이 파일이 있다는 것 자체가 증거다. 나머지 둘은 **원장과 실물을 대조**해 뒤늦게 잰다.
//   ⚠️ 최근 것만 본다 — 오래된 건 회수도 안 되고, 통독은 §A 위반이다.
{
  const 최근 = all.filter(r => days(day(r.일시)) <= 56 && r.상태 === '완료');   // 최근 8주 · 완료만
  const abs = q => path.resolve(WORK, q);
  const 착지실패 = [], 게이트없음 = [], 형식위반 = [];

  // 스킬이 정한 확장자(writes_to)와 실제로 떨어진 것이 다른가
  //   실측 2026-08-27 · 052 는 writes_to 가 .html 인데 .md 로 냈다.
  //   「대시보드로 낼 것을 문서로 냈다」는 대화 안의 판단이라 훅으로는 못 잡는다.
  //   그러나 **확장자가 다른 것은 확실한 위반**이라 여기서 잰다.
  const 정본형식 = new Map();
  try {
    const SK = path.resolve(process.env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(new URL(import.meta.url).pathname), '..'), '100-skills');
    const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const q = path.join(d, e.name);
      if (e.isDirectory()) return walk(q);
      if (e.name !== 'SKILL.md') return;
      const t = fs.readFileSync(q, 'utf8');
      const id = (t.match(/^id:\s*"?(\d+)/m) || [])[1];
      const w = (t.match(/^writes_to:\s*\[([^\]]+)/m) || [])[1];
      if (id && w) {
        const ext = (w.split(',')[0].trim().match(/\.(\w+)$/) || [])[1];
        if (ext) 정본형식.set(id, ext);
      }
    });
    walk(SK);
  } catch { /* 패키지를 못 찾으면 이 신호만 건너뛴다 */ }

  for (const r of 최근) {
    const q = (r.경로 || '').trim();
    if (!q || q.startsWith('(')) continue;                    // (차단됨) · (저장 실패) 는 경로가 아니다
    if (!fs.existsSync(abs(q))) { 착지실패.push(r); continue; }
    // 발행물이면 같은 폴더에 gate.md 가 있어야 한다 (게이트 열이 채워진 행 = 게이트를 탄 행)
    if (['✅', '⚠️', '⛔'].includes(r.게이트) && !fs.existsSync(path.join(path.dirname(abs(q)), 'gate.md')))
      게이트없음.push(r);
    // 형식 대조 — 스킬 ID 에서 번호를 뽑아 정본 확장자와 비교
    const num = (r.스킬 || '').match(/\((\d{3})\)/);
    const want = num && 정본형식.get(num[1]);
    const got = (q.match(/\.(\w+)$/) || [])[1];
    if (want && got && want !== got) 형식위반.push({ ...r, want, got });
  }
  if (착지실패.length)
    신호.push(['📁 착지실패', `${착지실패.length}건`, 착지실패.slice(0, 2).map(r => day(r.일시)).join(' · '),
               '원장엔 있는데 파일이 없다 — 「저장 안 된 거 있어?」로 회수한다']);
  if (게이트없음.length)
    신호.push(['🚪 게이트기록', `${게이트없음.length}건`, 게이트없음.slice(0, 2).map(r => r.스킬).join(' · '),
               '게이트는 탔는데 gate.md 가 없다 — 근거가 안 남았다']);
  if (형식위반.length)
    신호.push(['📊 형식위반', `${형식위반.length}건`,
               형식위반.slice(0, 2).map(r => `${r.스킬} .${r.got}→.${r.want}`).join(' · '),
               '스킬이 정한 형식과 다르게 냈다 — 다음 스킬이 그 경로를 못 찾는다']);
}

// 같은 말이 다른 스킬로 간 자리 = 라우팅이 흔들리는 자리
const 요청별 = new Map();
for (const r of all) {
  if (!r.요청) continue;
  const k = r.요청.trim();
  if (!요청별.has(k)) 요청별.set(k, new Set());
  요청별.get(k).add(r.스킬);
}
for (const [요청, set] of 요청별)
  if (set.size > 1) 신호.push(['🗣 라우팅', 요청, `${set.size}개 스킬로 갈렸다`, [...set].join(' · ')]);

if (신호.length) {
  say(`\n  진단 신호 ${신호.length}건 — 원장이 말해 주는 고칠 자리\n`);
  const w = n => Math.max(...신호.map(s => [...s[n]].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0)));
  const pad = (s, n) => s + ' '.repeat(Math.max(0, w(n) - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 2 : 1), 0)));
  for (const [종류, 대상, 수치, 처방] of 신호)
    say(`    ${pad(종류, 0)}  ${pad(대상, 1)}  ${pad(수치, 2)}  → ${처방}`);
  say(`\n  ⚠️ 고칠 지점은 3개 이내로 돌려준다 — 열 개를 적으면 하나도 안 고쳐진다.`);
} else {
  say(`\n  ✅ 진단 신호 없음 (무호출 ${STALE_DAYS}일 · 재작업 ${REWORK_AVG}회 · 차단 ${BLOCK_RATE * 100}% · 샘플 ${SAMPLE_RATE * 100}%)`);
}

// ── 4. 요약 원장 갱신 ──────────────────────────────────────────────────────
if (SUMMARY) {
  const src = [...archiveFiles.map(f => `logs/archive/${path.basename(f)}`), 'logs/build-log.md'].join(' + ');
  const rows = [...by.values()].sort((a, b) => day(b.최종).localeCompare(day(a.최종)))
    .map(s => `| ${s.스킬} | ${day(s.최초)} | ${day(s.최종)} | ${s.누적} | ${s.보완평균.toFixed(1)} | ${s.차단} |`);
  const out = `# Build Log Summary

> 스킬별 누적. **90일 무호출 점검이 이 파일을 읽는다** — 아카이브를 열지 않아도 마지막 실행일을 안다.
> 값은 \`scripts/ledger-stats.mjs --summary\` 가 계산한다. **손으로 고치지 않는다.**
>
> - **파생물이다.** 원장·아카이브와 어긋나면 **원장이 맞다.** 언제든 다시 만들 수 있다.
> - **누적 건수는 \`상태 = 완료\` 행만** 센다. \`차단됨\` · \`저장실패\` · \`중단\` 은 넣지 않는다.
> - 평균 보완이 ${REWORK_AVG}회 이상이면 그 스킬은 한 번에 안 나온다는 뜻이다.

최종 갱신 : ${today()}
집계 범위 : ${src}

| 스킬 ID | 최초 실행 | 최종 실행 | 누적 건수 | 평균 보완 | 차단 |
|---|---|---|---:|---:|---:|
${rows.join('\n')}
`;
  fs.writeFileSync(path.join(LOGS, 'build-log-summary.md'), out);
  say(`\n  ✓ logs/build-log-summary.md 갱신 · ${rows.length}종 (집계 ${src})`);
}

// ── 5. 훅 모드 · 말할 것이 있을 때만 말한다 ────────────────────────────────
if (HOOK) {
  // 봤다는 사실을 먼저 남긴다 — 사용자가 처방을 미뤄도 7일간은 다시 묻지 않는다.
  try { fs.mkdirSync(LOGS, { recursive: true }); fs.writeFileSync(STAMP, today()); } catch { /* 못 써도 진행 */ }
  if (!needRollover && !신호.length) process.exit(0);        // 이상 없음 — 조용히 끝낸다

  const 줄 = [];
  if (needRollover) 줄.push(`🟡 원장 ${current.length}행 — 롤오버가 필요합니다`);
  for (const [종류, 대상, 수치] of 신호.slice(0, 3)) 줄.push(`${종류} ${대상} · ${수치}`);
  const 더 = 신호.length > 3 ? ` (신호 ${신호.length}건 중 3건)` : '';

  process.stdout.write(JSON.stringify({
    systemMessage: `📒 실적 원장 점검${더}\n  ${줄.join('\n  ')}\n  → 「점검해줘」 하면 처방까지 냅니다`,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `[마케팅팀 원장 자동 점검] 이 작업 폴더의 logs/build-log.md 에서 아래가 나왔다. ` +
        `사용자가 원장·점검을 물으면 이것부터 답하고, 아니면 먼저 꺼내지 말 것.\n` +
        줄.map(l => `- ${l}`).join('\n') +
        `\n전체는 \`node \${CLAUDE_PLUGIN_ROOT}/scripts/ledger-stats.mjs\` · 처방은 「마케팅팀 구축하자」.`,
    },
  }));
  process.exit(0);
}

say('');
if (CHECK && needRollover) {
  console.error('🟡 롤오버가 필요하다 — 「마케팅팀 구축하자」로 ⏸ 승인을 받아 옮겨라');
  process.exit(1);
}
