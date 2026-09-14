#!/usr/bin/env node
/**
 * cohort-retention.mjs · 064 재구매 유지율 분석이 매번 새로 짜던 계산을 대신한다.
 *
 * 왜: 실측 2026-09-14 · 8장 CRM 체인 — 064 혼자 계산 스크립트를 새로 작성하며 16분(Bash 25회·
 *     파일 쓰기 10회)을 썼다. 매번 같은 계산(코호트 매트릭스·꺾임 지점·재구매 간격 분포)을
 *     새로 짜는 대신, 숫자는 여기서 한 번에 내고 **해석은 모델이 한다** (064 SKILL.md Phases 그대로).
 *
 * 사용: node scripts/cohort-retention.mjs <csv경로> [--gray-min 30]
 * 출력: JSON (stdout) · 코호트 매트릭스 · 꺾임 지점 · 재구매 간격 분포 · 휴면 경계 권장값
 * 입력 3열(이름은 유연하게 찾는다): 고객ID · 주문일(구매일) · 주문금액(결제금액)
 */
import fs from 'node:fs';

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

/** 따옴표 속 쉼표·줄바꿈까지 다루는 최소 CSV 파서. 이 스킬들의 입력은 열이 단순해 이 정도로 충분하다. */
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
  const idx = header.findIndex(h => patterns.some(p => p.test(h)));
  return idx;
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
    if (!id || !/^\d{4}-\d{2}-\d{2}/.test(date)) continue; // 결측·형식 오류 행은 건너뛴다(집계에서 제외)
    orders.push({ id, date: date.slice(0, 10), amount });
  }
  if (!orders.length) fail('유효한 주문 행이 없습니다(날짜 형식 YYYY-MM-DD 필요).');
  return orders;
}

function monthOf(dateStr) { return dateStr.slice(0, 7); }
function addMonths(yyyyMm, k) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}
function daysBetween(a, b) { return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000); }

function buildCohorts(orders) {
  const byCustomer = new Map();
  for (const o of orders) {
    if (!byCustomer.has(o.id)) byCustomer.set(o.id, []);
    byCustomer.get(o.id).push(o);
  }
  for (const list of byCustomer.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const lastMonth = orders.reduce((max, o) => monthOf(o.date) > max ? monthOf(o.date) : max, '0000-00');
  const cohortMap = new Map(); // month → { customers: Set, monthsPurchased: Map(customerId → Set(month)) }
  for (const [id, list] of byCustomer) {
    const cohort = monthOf(list[0].date);
    if (!cohortMap.has(cohort)) cohortMap.set(cohort, new Map());
    const purchased = cohortMap.get(cohort);
    purchased.set(id, new Set(list.map(o => monthOf(o.date))));
  }

  const months = [...cohortMap.keys()].sort();
  const maxK = 12;
  const cohorts = months.map(month => {
    const customers = cohortMap.get(month);
    const size = customers.size;
    const retention = {};
    for (let k = 0; k <= maxK; k++) {
      const target = addMonths(month, k);
      if (target > lastMonth) { retention[k] = null; continue; } // 관측 밖 · 미성숙
      let retained = 0;
      for (const monthsSet of customers.values()) if (monthsSet.has(target)) retained++;
      retention[k] = size ? retained / size : 0;
    }
    return { month, size, retention, immature: monthDiff(month, lastMonth) < maxK };
  });
  return { cohorts, lastMonth };
}

function dropAnalysis(cohorts, grayMin) {
  const mature = cohorts.filter(c => c.size >= grayMin);
  const maxK = 12;
  const avg = {};
  for (let k = 0; k <= maxK; k++) {
    const vals = mature.map(c => c.retention[k]).filter(v => v !== null && v !== undefined);
    if (vals.length) avg[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  let worst = null;
  for (let k = 0; k < maxK; k++) {
    if (avg[k] == null || avg[k + 1] == null) continue;
    const drop = avg[k + 1] - avg[k];
    if (!worst || drop < worst.drop) worst = { from: `M${k}`, to: `M${k + 1}`, drop };
  }
  return { averageCurve: avg, steepestDrop: worst };
}

function intervalDistribution(orders) {
  const byCustomer = new Map();
  for (const o of orders) {
    if (!byCustomer.has(o.id)) byCustomer.set(o.id, []);
    byCustomer.get(o.id).push(o.date);
  }
  const intervals = [];
  for (const dates of byCustomer.values()) {
    if (dates.length < 2) continue;
    const sorted = [...dates].sort();
    for (let i = 1; i < sorted.length; i++) intervals.push(daysBetween(sorted[i - 1], sorted[i]));
  }
  intervals.sort((a, b) => a - b);
  const median = intervals.length
    ? (intervals.length % 2 ? intervals[(intervals.length - 1) / 2]
      : (intervals[intervals.length / 2 - 1] + intervals[intervals.length / 2]) / 2)
    : null;
  const buckets = [30, 60, 90, 120, 150, 180].map(days => {
    const count = intervals.filter(v => v <= days).length;
    return { days, count, cumulativePct: intervals.length ? count / intervals.length : 0 };
  });
  const recommended = (buckets.find(b => b.cumulativePct >= 0.85) || buckets[buckets.length - 1]).days;
  return { count: intervals.length, medianDays: median, buckets, recommendedDormancyDays: recommended };
}

const { positional, opts } = parseArgs(process.argv.slice(2));
if (!positional[0]) fail('사용: node scripts/cohort-retention.mjs <csv경로> [--gray-min 30]');
const grayMin = Number(opts['gray-min'] || 30);

const orders = loadOrders(positional[0]);
const { cohorts, lastMonth } = buildCohorts(orders);
const drop = dropAnalysis(cohorts, grayMin);
const intervals = intervalDistribution(orders);

console.log(JSON.stringify({
  observedThrough: lastMonth,
  grayMin,
  cohorts: cohorts.map(c => ({ ...c, gray: c.size < grayMin })),
  drop,
  intervalDistribution: intervals,
}, null, 2));
