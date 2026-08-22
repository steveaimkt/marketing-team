#!/usr/bin/env node
/**
 * build-catalog.mjs · ROUTING.md → 100-skills/카탈로그.html
 *
 * 왜: 100개를 한 장으로 훑을 자리가 없었다. 대화로 100줄을 쏟으면 아무것도 안 읽힌다.
 *     브라우저에서 검색되는 한 장을 패키지에 넣어 둔다. 인터넷 없이도 열린다.
 * 사용: node scripts/build-catalog.mjs   ·  ROUTING.md 가 바뀌면 다시 돌린다
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = path.join(ROOT, '100-skills');
const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 1) 명부 파싱
const t = fs.readFileSync(path.join(M, 'ROUTING.md'), 'utf8');
const cats = []; let cur = null;
for (const ln of t.split('\n')) {
  const h = ln.match(/^## (\d\d-[a-z-]+) · (.+)$/);
  if (h) { cur = { id: h[1], name: h[2], rows: [] }; cats.push(cur); continue; }
  const r = ln.match(/^\|\s*(\d{3})\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/);
  if (r && cur) cur.rows.push({ n: r[1], name: r[2], trig: r[3], next: r[4], g: r[5].trim() });
}
const total = cats.reduce((a, c) => a + c.rows.length, 0);

// 각 스킬의 「하는 일」 — SKILL.md description 의 첫 문장
const DO = {};
for (const c of cats) {
  const sd = path.join(M, c.id, 'skills');
  if (!fs.existsSync(sd)) continue;
  for (const dir of fs.readdirSync(sd)) {
    const f = path.join(sd, dir, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const fm = (fs.readFileSync(f, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
    const d = ((fm.match(/^description:\s*(.*)$/m) || [, ''])[1] || '').trim().replace(/^"|"$/g, '');
    DO[dir.slice(0, 3)] = d.split(/\.\s|\. /)[0].replace(/\.$/, '').trim();
  }
}

// 2) 체인 — 카테고리 10 (PLUGIN.md) + 교차 5 (CHAINS.md)
const chains = [];
for (const c of cats) {
  const p = path.join(M, c.id, 'PLUGIN.md');
  if (!fs.existsSync(p)) continue;
  const fm = (fs.readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
  const f = k => ((fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [, ''])[1] || '').trim();
  if (f('chain')) chains.push([f('chain'), f('chain_steps'), f('chain_desc')]);
}
for (const m of fs.readFileSync(path.join(M, 'CHAINS.md'), 'utf8')
  .matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|\s*`(.+?)`\s*\|\s*(.+?)\s*\|\s*$/gm)) chains.push([m[1], m[2], m[3]]);

// 3) 세기
let trig = 0, gate = 0, mut = 0;
for (const c of cats) for (const r of c.rows) {
  trig += r.trig.split('·').filter(x => x.trim()).length;
  if (r.g.includes('G')) gate++;
  if (r.g.includes('!')) mut++;
}

const nav = cats.map(c => `<a href="#c${c.id.split('-')[0]}">${e(c.name)}</a>`).join('');
const secs = cats.map(c => {
  const num = c.id.split('-')[0];
  const rows = c.rows.map(r => {
    const tg = r.trig.split('·').map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean).join(' · ');
    let chip = '';
    if (r.g.includes('G')) chip += '<span class="chip g">게이트</span>';
    if (r.g.includes('!')) chip += '<span class="chip m">상태변경</span>';
    const does = DO[r.n] || '';
    return `<tr data-s="${e(r.n + ' ' + r.name + ' ' + tg + ' ' + does)}"><td class="n">${r.n}</td>`
      + `<td class="nm">${e(r.name)}${chip}</td>`
      + `<td class="do">${e(does)}</td>`
      + `<td class="tg">${tg.split(' · ').map(x => `<span class="t">${e(x)}</span>`).join('')}</td></tr>`;
  }).join('');
  return `<section id="c${num}"><h2><span class="cn">${num}</span>${e(c.name)}`
    + `<span class="rng">${c.rows[0].n}–${c.rows.at(-1).n}</span></h2>`
    + `<div class="tw"><table><thead><tr><th>번호</th><th>스킬</th><th>하는 일</th><th>부르는 말 · 트리거</th></tr></thead>`
    + `<tbody>${rows}</tbody></table></div></section>`;
}).join('');
const chHtml = chains.map(([n, s, d]) =>
  `<tr data-s="${e(n + ' ' + s)}"><td class="nm">${e(n)}</td><td class="n">${e(s)}</td><td class="tg">${e(d)}</td></tr>`).join('');

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>마케팅 스킬 ${total}</title>
<style>
:root{--ink:#1C1B22;--soft:#5A5866;--faint:#8C8A99;--bg:#F2F1F4;--card:#FFF;--rule:#DDDBE3;
--acc:#6B4A9E;--acc-w:#EEE9F6;--g:#8A6516;--g-w:#F7F0DD;--m:#A8342B;--m-w:#F9E8E5}
@media(prefers-color-scheme:dark){:root{--ink:#E4E2EA;--soft:#A5A2B2;--faint:#767386;--bg:#131218;
--card:#1B1A22;--rule:#2E2C38;--acc:#A98BD6;--acc-w:#241D33;--g:#D6AC5E;--g-w:#2C2617;--m:#E08578;--m-w:#31201D}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.6;
font-family:"IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:clamp(24px,4vw,56px) clamp(14px,3vw,32px) 80px}
h1{font-size:clamp(1.7rem,4vw,2.3rem);margin:0;font-weight:600;letter-spacing:-.02em}
.kick{font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:0 0 10px;font-family:ui-monospace,monospace}
.stats{display:flex;flex-wrap:wrap;gap:6px 20px;margin-top:14px;font-size:.84rem;color:var(--soft);font-variant-numeric:tabular-nums}
.stats b{color:var(--acc);font-family:ui-monospace,monospace}
header{border-bottom:2px solid var(--ink);padding-bottom:20px}
.bar{position:sticky;top:0;z-index:5;background:var(--bg);padding:14px 0 10px;border-bottom:1px solid var(--rule)}
#q{width:100%;padding:10px 14px;border:1px solid var(--rule);border-radius:4px;background:var(--card);color:var(--ink);font-family:inherit;font-size:.92rem}
#q:focus{outline:2px solid var(--acc);outline-offset:1px}
.nav{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.nav a{font-size:.78rem;padding:3px 10px;border:1px solid var(--rule);border-radius:20px;color:var(--soft);text-decoration:none}
.nav a:hover{border-color:var(--acc);color:var(--acc)}
section{margin-top:34px}
h2{font-size:1.05rem;font-weight:600;margin:0 0 10px;display:flex;align-items:baseline;gap:10px}
.cn{font-family:ui-monospace,monospace;color:var(--acc);font-size:.85rem}
.rng{font-family:ui-monospace,monospace;font-size:.75rem;color:var(--faint);margin-left:auto}
.tw{overflow-x:auto;border:1px solid var(--rule);border-radius:4px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.88rem;min-width:640px}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--rule);vertical-align:top}
thead th{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);font-family:ui-monospace,monospace;font-weight:500;background:var(--bg)}
tbody tr:last-child td{border-bottom:none}tbody tr:hover{background:var(--acc-w)}
td.n{font-family:ui-monospace,monospace;color:var(--acc);font-variant-numeric:tabular-nums;white-space:nowrap}
td.nm{font-weight:500;white-space:nowrap}
td.do{color:var(--ink);font-size:.85rem;min-width:220px}
td.tg{font-size:.8rem;min-width:230px}
.t{display:inline-block;background:var(--bg);border:1px solid var(--rule);color:var(--soft);
border-radius:12px;padding:1px 9px;margin:2px 3px 2px 0;white-space:nowrap;font-size:.76rem}
tbody tr:hover .t{border-color:var(--acc);color:var(--acc)}
.chip{display:inline-block;font-size:.62rem;padding:1px 6px;border-radius:3px;margin-left:6px;font-family:ui-monospace,monospace;vertical-align:middle}
.chip.g{background:var(--g-w);color:var(--g)}.chip.m{background:var(--m-w);color:var(--m)}
.gates{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));margin-top:16px}
.gk{background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:14px 18px}
.gk b{font-family:ui-monospace,monospace;margin-left:8px;color:var(--ink)}
.gk p{margin:8px 0 0;font-size:.83rem;color:var(--soft);line-height:1.65}
.gk p b{font-family:inherit;margin:0;color:var(--ink)}
.both{margin:12px 0 0;font-size:.83rem;color:var(--soft);background:var(--acc-w);
border-left:3px solid var(--acc);padding:10px 16px;border-radius:0 4px 4px 0}
.both b{color:var(--ink)}
.how{background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:18px 22px;margin-top:34px}
.how code{font-family:ui-monospace,monospace;font-size:.85em;background:var(--bg);padding:2px 7px;border-radius:3px}
.none{display:none;padding:24px;text-align:center;color:var(--faint);font-size:.9rem}
footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--rule);font-size:.78rem;color:var(--faint)}
</style></head><body><div class="wrap">
<header><p class="kick">marketing-team · 스킬 카탈로그</p><h1>마케팅 스킬 ${total}</h1>
<div class="stats"><span>스킬 <b>${total}</b></span><span>분야 <b>${cats.length}</b></span>
<span>부르는 말 <b>${trig}</b></span><span>규제 게이트 <b>${gate}</b></span>
<span>상태 변경 <b>${mut}</b></span><span>체인 <b>${chains.length}</b></span></div></header>
<div class="bar"><input id="q" type="search" placeholder="검색 — 번호 · 스킬 이름 · 부르는 말  (예: 광고, 046, 리뷰)" autocomplete="off">
<div class="nav">${nav}<a href="#chains">체인 ${chains.length}</a></div></div>
<div class="gates"><div class="gk"><span class="chip g">게이트</span><b>${gate}개</b>
<p><b>틀린 말이 밖으로 나가는 것</b>을 막는다. 산출물이 완성된 뒤 전달 전에
규제 감사관이 표시광고법·업종 법령으로 전수 검사한다. <b>판정은 AI가</b> 하고,
통과 못 하면 전달 자체가 중단된다.</p></div>
<div class="gk"><span class="chip m">상태변경</span><b>${mut}개</b>
<p><b>되돌릴 수 없는 일이 벌어지는 것</b>을 막는다. 발송·예약·자동화 등록처럼
바깥 세상을 바꾸는 일이다. 실행 직전에 멈추고 <b>사람이 ⏸ 승인</b>해야 간다.
AI가 대신 눌러 주지 않는다.</p></div></div>
<p class="both">둘 다 붙은 것이 <b>2개</b> 있다 — <b>074 이메일 시퀀스</b>와 <b>079 리뷰 요청</b>.
고객에게 나가는 글이면서 실제로 발송까지 하니, <b>규제 검사와 사람 승인을 둘 다</b> 거친다.</p>
${secs}
<section id="chains"><h2><span class="cn">체인</span>한 줄로 한 바퀴<span class="rng">${chains.length}종</span></h2>
<div class="tw"><table><thead><tr><th>이름</th><th>순서</th><th>무엇을 하나</th></tr></thead><tbody>${chHtml}</tbody></table></div></section>
<p class="none" id="none">해당하는 스킬이 없습니다. 다르게 말해 보세요 — 비슷하게만 말해도 찾아 줍니다.</p>
<div class="how"><p style="margin:0;color:var(--soft)"><b style="color:var(--ink)">부르는 법 세 가지</b> — 
그냥 말한다 <code>리뷰 분석해줘</code> · 번호로 <code>046 돌려줘</code> · 한 바퀴 <code>광고애널리틱스 돌려줘</code></p>
<p style="margin:10px 0 0;color:var(--soft);font-size:.86rem">여기 적힌 것은 대표 예시입니다.
등록된 말이 ${trig}개라 비슷하게만 말해도 걸립니다.</p></div>
<footer>100-skills/ROUTING.md 에서 생성 · node scripts/build-catalog.mjs</footer></div>
<script>
var q=document.getElementById('q'),none=document.getElementById('none');
q.addEventListener('input',function(){
 var v=q.value.trim().toLowerCase(),hit=0;
 document.querySelectorAll('tbody tr').forEach(function(tr){
  var m=!v||(tr.dataset.s||'').toLowerCase().indexOf(v)>-1;tr.style.display=m?'':'none';if(m)hit++;});
 document.querySelectorAll('section').forEach(function(s){
  var any=Array.prototype.some.call(s.querySelectorAll('tbody tr'),function(t){return t.style.display!=='none';});
  s.style.display=any?'':'none';});
 none.style.display=hit?'none':'block';});
</script></body></html>`;

fs.writeFileSync(path.join(M, '카탈로그.html'), html);
console.log(`카탈로그.html 생성 · 스킬 ${total} · 분야 ${cats.length} · 부를 말 ${trig} · 게이트 ${gate} · 상태변경 ${mut} · 체인 ${chains.length}`);
