#!/usr/bin/env node
/**
 * router.mjs · 자연어 요청을 실행하지 않고 스킬 후보만 좁힌다.
 *
 * 이 파일의 점수는 최종 판단 점수가 아니다. 트리거·이름·설명(when_to_use)만으로 좁히는 로컬 후보 검색이며,
 * AI 마케터는 low confidence 또는 동률이면 상위 후보를 보여 주고 한 번만 확인한다.
 * ⛔ routing-eval.jsonl 은 색인에 넣지 않는다 (P2 · 2026-08-30) — 평가 문장으로 운영 색인을 만들면
 *    같은 문장으로 재는 평가가 과대평가된다. 평가셋은 eval-routing.mjs 전용이다.
 * 실제 의미 라우팅 품질은 eval-routing.mjs --live-cc 로 별도 측정한다.
 *
 * 사용: node scripts/router.mjs "광고 예산을 다시 나눠줘"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, '100-skills');

const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
const grams = value => {
  const text = norm(value);
  const out = new Map();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    out.set(gram, (out.get(gram) || 0) + 1);
  }
  return out;
};
const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let overlap = 0, left = 0, right = 0;
  for (const count of a.values()) left += count;
  for (const count of b.values()) right += count;
  for (const [key, count] of a) overlap += Math.min(count, b.get(key) || 0);
  return (2 * overlap) / (left + right);
};

function frontmatter(text) {
  return (text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
}
function scalar(fm, key) {
  return ((fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm')) || [])[1] || '')
    .trim().replace(/^['"]|['"]$/g, '');
}
function blockList(fm, key) {
  const lines = fm.split('\n');
  const index = lines.findIndex(line => line.startsWith(`${key}:`));
  if (index < 0) return [];
  const inline = lines[index].slice(key.length + 1).trim();
  if (inline.startsWith('[')) return inline.replace(/^\[|\]$/g, '').split(',')
    .map(value => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const out = [];
  for (let i = index + 1; i < lines.length; i++) {
    const item = lines[i].match(/^\s*-\s+(.*)$/);
    if (!item) break;
    out.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

let cached;
export function loadRoutingIndex() {
  if (cached) return cached;
  const rows = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name === 'SKILL.md') {
        const text = fs.readFileSync(target, 'utf8');
        const fm = frontmatter(text);
        const id = scalar(fm, 'id').match(/\d{3}/)?.[0];
        if (!id) continue;
        rows.push({
          id,
          name: scalar(fm, 'name'),
          description: scalar(fm, 'description'),
          whenToUse: scalar(fm, 'when_to_use'),
          triggers: blockList(fm, 'triggers'),
        });
      }
    }
  };
  walk(SKILLS);
  cached = rows.sort((a, b) => a.id.localeCompare(b.id)).map(row => ({
    ...row,
    triggerGrams: row.triggers.map(grams),
    nameGrams: grams(row.name),
    descGrams: grams(`${row.description} ${row.whenToUse}`),
  }));
  return cached;
}

export function routeOne(request, { limit = 3 } = {}) {
  const query = grams(request);
  const compact = norm(request);
  const candidates = loadRoutingIndex().map(skill => {
    const bestTrigger = Math.max(0, ...skill.triggerGrams.map(value => dice(query, value)));
    const exactTrigger = skill.triggers.some(value => {
      const phrase = norm(value);
      return phrase.length >= 4 && (compact.includes(phrase) || phrase.includes(compact));
    });
    const score = Math.min(1, (exactTrigger ? 0.5 : 0) + bestTrigger * 0.42 +
      dice(query, skill.nameGrams) * 0.14 + dice(query, skill.descGrams) * 0.1);
    return { id: skill.id, name: skill.name, score: Number(score.toFixed(4)), reason: skill.whenToUse || skill.description };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = candidates.slice(0, Math.max(2, limit));
  const margin = (top[0]?.score || 0) - (top[1]?.score || 0);
  // 낮은 절대 점수보다 후보 간 분리를 우선한다. 짧은 한국어 요청은 2-gram 점수가 원래 낮다.
  const low = (top[0]?.score || 0) < 0.18;
  const tied = margin < 0.06;
  return {
    request,
    candidates: top.slice(0, limit),
    decision: low || tied ? null : top[0].id,
    confidence: low ? 'low' : tied ? 'ambiguous' : top[0].score >= 0.72 ? 'high' : 'medium',
    needs_user_choice: low || tied,
    ...(low || tied ? { question: `요청이 겹칩니다. ${top.slice(0, 2).map(row => `${row.id} ${row.name}`).join(' / ')} 중 어느 쪽인가요?` } : {}),
  };
}

export function routeRequest(request) {
  const parts = String(request).split(/(?:\s*(?:그리고|하고|동시에|한 번에|그다음|→)\s*)/)
    .map(value => value.trim()).filter(Boolean).slice(0, 4);
  if (parts.length <= 1) return { request_class: 'single', ...routeOne(request) };
  return { request_class: 'compound', request, subrequests: parts.map(part => routeOne(part)) };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const request = process.argv.slice(2).join(' ').trim();
  if (!request) { console.error('사용: router.mjs "자연어 요청"'); process.exit(1); }
  const result = routeRequest(request);
  console.log(JSON.stringify(result, null, 2));
  // 라우팅 흔적을 실행 타래에 남긴다 (P2 · 2026-08-30) — 작업 공간일 때만 · 실패해도 라우팅을 막지 않는다.
  try {
    if (fs.existsSync(path.resolve(process.cwd(), 'outputs'))) {
      const { appendEvent } = await import('./orchestrator-events.mjs');
      appendEvent(process.cwd(), { skills: [] }, 'route.completed', {
        request,
        request_class: result.request_class,
        decision: result.decision ?? (result.subrequests ? result.subrequests.map(row => row.decision).join(',') : null),
        confidence: result.confidence || null,
      });
    }
  } catch { /* 무시 */ }
}
