#!/usr/bin/env node
/** frontmatter와 CHAINS.md의 정본 체인을 계획의 실행 그래프로 컴파일한다. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, '100-skills');

const clean = value => String(value || '').trim().replace(/^['"`*]+|['"`*]+$/g, '');
const idsOf = value => String(value || '').match(/\d{3}/g) || [];

function variantsOf(expression) {
  const tokens = String(expression).split(/\s*→\s*/).filter(Boolean).map(token => {
    const ids = idsOf(token);
    return ids.length ? ids : [clean(token)];
  });
  return tokens.reduce((variants, choices) => variants.flatMap(row => choices.map(choice => [...row, choice])), [[]]);
}

let cached;
export function canonicalChains() {
  if (cached) return cached;
  const chains = new Map();
  for (const dir of fs.readdirSync(SKILLS, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^\d\d-/.test(dir.name)) continue;
    const file = path.join(SKILLS, dir.name, 'PLUGIN.md');
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const name = clean((text.match(/^chain:\s*(.+)$/m) || [])[1]);
    const expression = clean((text.match(/^chain_steps:\s*(.+)$/m) || [])[1]);
    const description = clean((text.match(/^chain_desc:\s*(.+)$/m) || [])[1]);
    if (name && expression) chains.set(name, { name, expression, description, variants: variantsOf(expression), source: path.relative(ROOT, file) });
  }
  const cross = path.join(SKILLS, 'CHAINS.md');
  const text = fs.readFileSync(cross, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/);
    if (!match) continue;
    const [, name, expression, description] = match;
    chains.set(name, { name, expression, description, variants: variantsOf(expression), source: '100-skills/CHAINS.md' });
  }
  cached = chains;
  return chains;
}

function dependencyIndex(steps, value) {
  const raw = String(value);
  if (/^\d+$/.test(raw)) {
    const byStep = steps.findIndex(step => Number(step.step) === Number(raw));
    if (byStep >= 0) return byStep;
  }
  return steps.findIndex(step => String(step.skill) === raw);
}

export function compileChain(plan) {
  const steps = (plan.steps || []).map((step, index) => ({ ...step, step: index + 1, skill: String(step.skill || '') }));
  const issues = [], warnings = [], edges = [];
  const seenSkills = new Map();
  const producers = new Map();
  for (const [index, step] of steps.entries()) {
    if (seenSkills.has(step.skill)) issues.push(`체인에서 같은 스킬을 두 번 실행합니다: ${step.skill} (step ${seenSkills.get(step.skill)} · ${index + 1})`);
    else seenSkills.set(step.skill, index + 1);
    for (const output of step.outputs || []) producers.set(String(output), index);
  }
  for (const [index, step] of steps.entries()) {
    for (const input of step.inputs || []) {
      const producer = producers.get(String(input));
      if (producer === undefined) continue;
      if (producer >= index) issues.push(`step ${index + 1}(${step.skill}) 입력이 아직 만들지 않은 단계에 의존합니다: ${input}`);
      else edges.push({ from: producer + 1, to: index + 1, via: String(input), kind: 'artifact' });
    }
    for (const dependency of step.depends_on || []) {
      const producer = dependencyIndex(steps, dependency);
      if (producer < 0) issues.push(`step ${index + 1}(${step.skill}) 의존 대상을 찾지 못했습니다: ${dependency}`);
      else {
        edges.push({ from: producer + 1, to: index + 1, via: String(dependency), kind: 'explicit' });
        if (producer >= index) issues.push(`step ${index + 1}(${step.skill}) 의존 순서가 역방향이거나 순환합니다: ${dependency}`);
      }
    }
  }

  const chains = canonicalChains();
  let named = plan.chain ? chains.get(String(plan.chain)) : null;
  if (plan.chain && !named) issues.push(`정본에 없는 체인입니다: ${plan.chain}`);
  if (!named) {
    const ids = steps.map(step => step.skill);
    named = [...chains.values()].find(chain => chain.variants.some(variant => variant.join(',') === ids.join(','))) || null;
  }
  if (named) {
    const ids = steps.map(step => step.skill);
    const exact = named.variants.some(variant => variant.join(',') === ids.join(','));
    const sameMembers = named.variants.some(variant => [...variant].sort().join(',') === [...ids].sort().join(','));
    if (!exact && sameMembers && (plan.requested_order || []).map(String).join(',') === ids.join(',')) {
      warnings.push({ code: 'user-order-conflicts-canonical-chain', message: `사용자 지정 순서 ${ids.join('→')}가 정본 ${named.expression}과 다릅니다. 중간 입력이 약해질 수 있으나 자동 교정하지 않습니다.` });
    } else if (!exact) {
      issues.push(`체인 ${named.name} 단계가 정본과 다릅니다: 계획 ${ids.join('→')} · 정본 ${named.expression}`);
    }
  }

  // 명시·산출물 의존 그래프의 일반 순환 검사
  const indegree = Array(steps.length).fill(0);
  const adjacency = Array.from({ length: steps.length }, () => []);
  for (const edge of edges) {
    if (edge.from < 1 || edge.to < 1 || edge.from > steps.length || edge.to > steps.length) continue;
    adjacency[edge.from - 1].push(edge.to - 1); indegree[edge.to - 1]++;
  }
  const queue = indegree.map((value, index) => value === 0 ? index : -1).filter(index => index >= 0);
  let visited = 0;
  while (queue.length) {
    const node = queue.shift(); visited++;
    for (const next of adjacency[node]) if (--indegree[next] === 0) queue.push(next);
  }
  if (visited !== steps.length && !issues.some(issue => issue.includes('순환'))) issues.push('단계 의존 그래프에 순환이 있습니다.');

  return {
    schema: 'marketing-team.chain/v1',
    chain: named?.name || plan.chain || null,
    nodes: steps.map(step => ({ step: step.step, skill: step.skill })),
    edges,
    warnings,
    issues,
  };
}

export function validateChainPlan(plan) { return compileChain(plan).issues; }

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const [command, target] = process.argv.slice(2);
  if (command === 'list') {
    console.log(JSON.stringify([...canonicalChains().values()], null, 2));
  } else if (command === 'check' && target) {
    const plan = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), target), 'utf8'));
    const graph = compileChain(plan);
    console.log(JSON.stringify(graph, null, 2));
    process.exit(graph.issues.length ? 1 : 0);
  } else {
    console.error('사용: chain-compiler.mjs list | check <plan.json>'); process.exit(1);
  }
}
