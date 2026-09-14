#!/usr/bin/env node
/**
 * rfm-segments.mjs · 065 고객 등급 분석이 매번 새로 짜던 RFM 집계를 대신한다.
 *
 * 왜: cohort-retention.mjs 와 같은 이유(실측 2026-09-14 · 8장 CRM 체인) — 숫자는 여기서
 *     한 번에 내고 **해석·세그먼트 병합 판단은 모델이 한다** (065 SKILL.md Phases 그대로).
 *
 * 사용: node scripts/rfm-segments.mjs <csv경로> [--as-of YYYY-MM-DD] [--dormancy-days 180]
 * 출력: JSON (stdout) · 고객별 R·F·M 점수·세그먼트(익명 대체키) · 분위 경계값 · 세그먼트 집계
 * 입력 3열(이름은 유연하게 찾는다): 고객ID · 주문일(구매일) · 주문금액(결제금액)
 *
 * 익명화: 원문 고객ID는 출력에 한 번도 쓰지 않는다. `crypto.randomBytes`로 만든, 원문과
 * 무관한 실행별 임의 대체키만 쓰고 대응표는 어디에도 남기지 않는다(065 Contract §4).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const fail = message => { console.error(`🔴 ${message}`); process.exit(1); };

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
    else positional.push(argv[i]);
  }
  return { positional, opts };
}

/** cohort-retention.mjs 와 같은 최소 CSV 파서 — 두 스크립트는 독립 실행 도구라 각자 갖는다. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

function findColumn(header, patterns) {
  return header.findIndex(h => patterns.some(p => p.test(h)));
}

function loadOrders(csvPath) {
  if (!fs.existsSync(csvPath)) fail(`파일이 없습니다: ${csvPath}`);
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length < 2) fail('데이터 행이 없습니다.');
  const header = rows[0].map(h => h.trim());
  const idCol = findColumn(header, [/고객.?id/i, /customer.?id/i, /^고객$/]);
  const dateCol = findColumn(header, [/구매일/, /주문일/, /order.?date/i, /purchase.?date/i]);
  const amountCol = findColumn(header, [/결제금액/, /주문금액/, /매출/, /amount/i, /금액/]);
  if (idCol < 0 || dateCol < 0 || amountCol < 0)
    fail(`필수 3열(고객ID·주문일·주문금액)을 못 찾았습니다. 헤더: ${header.join(' · ')}`);
  const orders = [];
  for (const r of rows.slice(1)) {
    const id = (r[idCol] || '').trim();
    const date = (r[dateCol] || '').trim();
    const amount = Number((r[amountCol] || '0').replace(/[^0-9.-]/g, ''));
    if (!id || !/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
    orders.push({ id, date: date.slice(0, 10), amount });
  }
  if (!orders.length) fail('유효한 주문 행이 없습니다(날짜 형식 YYYY-MM-DD 필요).');
  return orders;
}

function daysBetween(a, b) { return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000); }

/** 오름차순 값 배열에서 분위 경계값(quantile 개수)을 구한다. */
function quantileBoundaries(sortedValues, buckets) {
  const bounds = [];
  for (let i = 1; i < buckets; i++) {
    const pos = (sortedValues.length * i) / buckets;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    const v = hi >= sortedValues.length ? sortedValues[sortedValues.length - 1]
      : (sortedValues[lo] + sortedValues[Math.min(hi, sortedValues.length - 1)]) / 2;
    bounds.push(v);
  }
  return bounds;
}

/** 값 하나를 분위 점수(1~buckets)로 매긴다. ascending=false 면 값이 작을수록 높은 점수(R용). */
function scoreOf(value, bounds, buckets, ascending) {
  let rank = 1;
  for (const b of bounds) if (value > b) rank++;
  return ascending ? rank : buckets - rank + 1;
}

function segmentOf(r, f, m, buckets) {
  const hi = buckets, midHi = Math.ceil(buckets * 0.8), lowCut = Math.ceil(buckets * 0.4);
  // 5분위 기준 원안(R5·F4+ 등)을 분위 수에 맞춰 비례 환산한다 — 3분위여도 같은 규칙이 뜻대로 작동한다.
  const top = hi, midPlus = Math.max(2, midHi - 1), low = Math.max(1, lowCut - 1);
  if (r >= top && f >= midPlus) return '챔피언';
  if (r >= midPlus && f >= low + 1) return '충성';
  if (r === top && f === 1) return '신규';
  if (r >= midPlus && f <= low) return '잠재 충성';
  if (r <= low && f >= low + 1) return '이탈 위험';
  if (r <= low && m >= midPlus) return '고액 이탈';
  if (r <= low && f <= low) return '휴면';
  return '성장 관찰'; // 위 어디에도 안 걸리는 중간대 — SKILL.md "필요 시 병합" 여지를 모델에 남긴다
}

const { positional, opts } = parseArgs(process.argv.slice(2));
if (!positional[0]) fail('사용: node scripts/rfm-segments.mjs <csv경로> [--as-of YYYY-MM-DD] [--dormancy-days 180]');
const dormancyDays = Number(opts['dormancy-days'] || 180);

const orders = loadOrders(positional[0]);
const byCustomer = new Map();
for (const o of orders) {
  if (!byCustomer.has(o.id)) byCustomer.set(o.id, []);
  byCustomer.get(o.id).push(o);
}
const asOf = opts['as-of'] || orders.reduce((max, o) => o.date > max ? o.date : max, '0000-00-00');

const raw = [...byCustomer.entries()].map(([id, list]) => {
  const lastDate = list.reduce((max, o) => o.date > max ? o.date : max, '0000-00-00');
  return {
    id,
    recencyDays: daysBetween(lastDate, asOf),
    frequency: list.length,
    monetary: list.reduce((sum, o) => sum + o.amount, 0),
  };
});

const buckets = raw.length < 200 ? 3 : 5;
const rBounds = quantileBoundaries([...raw.map(c => c.recencyDays)].sort((a, b) => a - b), buckets);
const fBounds = quantileBoundaries([...raw.map(c => c.frequency)].sort((a, b) => a - b), buckets);
const mBounds = quantileBoundaries([...raw.map(c => c.monetary)].sort((a, b) => a - b), buckets);

const customers = raw.map(c => {
  const r = scoreOf(c.recencyDays, rBounds, buckets, false); // 최근일수는 작을수록 고득점
  const f = scoreOf(c.frequency, fBounds, buckets, true);
  const m = scoreOf(c.monetary, mBounds, buckets, true);
  return {
    // 원문 ID는 출력에 남기지 않는다 — 원문과 무관한 임의 대체키(대응표 미보관)
    customerKey: `고객-${crypto.randomBytes(4).toString('hex')}`,
    recencyDays: c.recencyDays, frequency: c.frequency, monetary: c.monetary,
    rScore: r, fScore: f, mScore: m,
    segment: segmentOf(r, f, m, buckets),
    dormant: c.recencyDays > dormancyDays,
  };
});

const bySegment = {};
for (const c of customers) {
  bySegment[c.segment] ??= { count: 0, revenue: 0 };
  bySegment[c.segment].count++;
  bySegment[c.segment].revenue += c.monetary;
}
const totalRevenue = customers.reduce((sum, c) => sum + c.monetary, 0);
for (const seg of Object.values(bySegment)) seg.revenueShare = totalRevenue ? seg.revenue / totalRevenue : 0;

console.log(JSON.stringify({
  asOf, buckets, dormancyDaysUsed: dormancyDays,
  quantileBoundaries: { recencyDays: rBounds, frequency: fBounds, monetary: mBounds },
  customerCount: customers.length,
  segments: bySegment,
  customers,
}, null, 2));
