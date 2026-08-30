#!/usr/bin/env node
import assert from 'node:assert/strict';
import { canonicalChains, compileChain } from './chain-compiler.mjs';

assert.equal(canonicalChains().size, 15, '카테고리 10개 + 교차 체인 5개여야 한다.');
assert.equal(canonicalChains().get('콘텐츠프로덕션').variants.length, 2, '선택 분기를 두 변형으로 컴파일해야 한다.');
assert.equal(canonicalChains().get('광고애널리틱스').variants.length, 2, '괄호 선택 분기를 두 변형으로 컴파일해야 한다.');

// 2단계부터 직전 산출물을 입력에 받는다 (P1 · 2026-08-30) — 안 이으면 그래프가 아니라 나열이다.
const make = (skills, extra = {}) => ({
  request: '체인 실행', skills,
  steps: skills.map((skill, index) => ({
    step: index + 1, skill,
    inputs: index ? [`workspace:outputs/${skills[index - 1]}.md`] : [],
    outputs: [`workspace:outputs/${skill}.md`], reviews: [],
  })),
  ...extra,
});

let graph = compileChain(make(['001', '002', '006', '009'], { chain: '시장리서치' }));
assert.equal(graph.issues.length, 0);
assert.equal(graph.chain, '시장리서치');
assert.equal(graph.edges.filter(edge => edge.kind === 'artifact').length, 3, '정본 체인은 산출물 간선으로 이어져야 한다.');

// 순서만 정본과 같고 산출물이 안 이어지는 계획은 막는다 (P1 · 2026-08-30 최종 검토)
const disconnected = make(['001', '002', '006', '009'], { chain: '시장리서치' });
disconnected.steps[2].inputs = [];
graph = compileChain(disconnected);
assert.match(graph.issues.join('\n'), /직전 단계.*산출물을 입력에 받지 않습니다/, '입력이 안 이어진 정본 체인을 막아야 한다.');

// 더 앞 단계 산출물을 쓰면 depends_on 으로 명시하고 통과한다
const declared = make(['001', '002', '006', '009'], { chain: '시장리서치' });
declared.steps[2].inputs = ['workspace:outputs/001.md'];
declared.steps[2].depends_on = ['001'];
graph = compileChain(declared);
assert.equal(graph.issues.length, 0, 'depends_on 으로 명시한 앞 단계 사용은 통과해야 한다.');

graph = compileChain(make(['001', '006', '009'], { chain: '시장리서치' }));
assert.match(graph.issues.join('\n'), /정본과 다릅니다/, '중간 단계 누락을 막아야 한다.');

graph = compileChain(make(['009', '006', '002', '001'], {
  chain: '시장리서치', requested_order: ['009', '006', '002', '001'],
}));
assert.equal(graph.issues.length, 0, '사용자가 지정한 역방향은 자동 교정하지 않는다.');
assert.match(graph.warnings[0].code, /user-order/, '역방향 위험을 계획에 남겨야 한다.');

graph = compileChain(make(['009', '006', '002', '001'], { chain: '시장리서치' }));
assert.match(graph.issues.join('\n'), /정본과 다릅니다/, '사용자 지정이 아닌 역순은 막아야 한다.');

const cycle = make(['001', '002']);
cycle.steps[0].depends_on = ['002'];
cycle.steps[1].depends_on = ['001'];
graph = compileChain(cycle);
assert.match(graph.issues.join('\n'), /역방향|순환/, '순환 의존을 막아야 한다.');

const forward = make(['001', '002']);
forward.steps[0].inputs = [forward.steps[1].outputs[0]];
graph = compileChain(forward);
assert.match(graph.issues.join('\n'), /아직 만들지 않은/, '앞 단계 없는 입력을 막아야 한다.');

graph = compileChain(make(['001', '001']));
assert.match(graph.issues.join('\n'), /같은 스킬을 두 번/, '중복 단계를 막아야 한다.');

console.log('체인 컴파일러 · 정본 15 · 선택 분기 2 · 누락·역순·순환·입력단절·중복 5 · 위험 고지 1 · 입력 연결 강제 3 · ✅');
