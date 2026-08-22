import re, os, glob, json, collections, sys
ROOT="100-skills"
def fm(t):
    m=re.match(r'^---\n(.*?)\n---\n', t, re.S); return m.group(1) if m else ""
def fld(f,k):
    m=re.search(rf'^{k}:\s*(.*)$', f, re.M); return (m.group(1) or "").strip().strip('"') if m else ""
def lst(v):
    return [x.strip() for x in re.sub(r'^\[|\]$','',v).replace('"','').split(',') if x.strip()]

S=[]
for p in sorted(glob.glob(f"{ROOT}/*/skills/*/SKILL.md")):
    t=open(p,encoding='utf-8').read(); f=fm(t); body=t[len(f)+10:]
    S.append(dict(p=p, id=fld(f,'id'), name=fld(f,'name'), cat=fld(f,'category'),
        tier=fld(f,'tier'), gate=fld(f,'gate'), mut=fld(f,'mutating'),
        inputs=fld(f,'inputs'), outputs=fld(f,'outputs'), wt=fld(f,'writes_to'),
        sf=fld(f,'sample_fallback'), persona=fld(f,'persona'), req=fld(f,'requires'),
        chains=lst(fld(f,'chains_to')), trig=len(re.findall(r'^\s+- "', f, re.M)),
        body=body, lines=len(body.split('\n')), f=f))

I=collections.defaultdict(list)
def add(sev,cat,s,msg): I[cat].append((sev,s['id'],s['name'],msg))

PUB = ['카피','상세페이지','게시물','블로그','뉴스레터','보도자료','랜딩','스크립트','답변','포스트','콘텐츠','피드','메일','알림톡','제안서','피치']
for s in S:
    # 1 샘플 폴백 — 외부 데이터를 요구하는데 없으면 못 돈다
    needs = any(k in s['inputs'] for k in ['CSV','csv','데이터','리포트','로그','엑셀','통계','지표','내역'])
    if needs and not s['sf']: add('🟡','샘플폴백 없음',s,f"inputs 가 외부 데이터를 요구: {s['inputs'][:60]}")
    # 2 크롤링 전제
    if 'URL' in s['inputs'] and '크롤링' not in s['inputs']:
        add('🟡','URL 전제',s,f"inputs 에 URL — 로그인 뒤면 못 긁는다: {s['inputs'][:60]}")
    # 3 게이트 적정성 — 이름이 대외 발행물인데 gate:false
    if s['gate']!='true' and any(k in s['name'] for k in PUB):
        add('🟡','게이트 누락 의심',s,f"이름이 발행물인데 gate:false — {s['name']}")
    # 4 persona
    if not s['persona']: add('🟡','persona 없음',s,'')
    elif len(s['persona'])<15: add('🟡','persona 빈약',s,s['persona'])
    # 5 본문 길이
    if s['lines']<60: add('🟡','본문 짧음',s,f"{s['lines']}줄")
    # 6 경계 문장
    if '내 일이 아닌 것' not in s['body']: add('🟡','경계 없음',s,'헷갈리는 쌍에서 갈리지 않는다')
    # 7 Anti-Patterns
    if 'Anti-Pattern' not in s['body'] and '안티패턴' not in s['body']: add('🟡','안티패턴 없음',s,'')
    # 8 outputs 확장자 vs writes_to
    mo=re.search(r'\.(md|csv|html|pptx|xlsx|json)', s['outputs']); mw=re.search(r'\.(md|csv|html|pptx|xlsx|json)', s['wt'])
    if mo and mw and mo.group(1)!=mw.group(1): add('🔴','확장자 불일치',s,f"outputs .{mo.group(1)} vs writes_to .{mw.group(1)}")
    # 9 트리거 수
    if s['trig']<3: add('🟡','트리거 부족',s,f"{s['trig']}개")
    if s['trig']>6: add('🟡','트리거 과다',s,f"{s['trig']}개")
    # 10 성공지표
    if not fld(s['f'],'success_metrics'): add('🟡','success_metrics 없음',s,'')

# 11 체인 고아 — 아무도 안 가리키는 스킬
inc=collections.Counter()
for s in S:
    for c in s['chains']:
        if c!='ALL': inc[c]+=1
for s in S:
    if inc[s['id']]==0 and not s['chains']: add('🟡','체인 고립',s,'들어오지도 나가지도 않는다')

print(f"스킬 {len(S)}개 감사\n")
tot=0
for cat,v in sorted(I.items(), key=lambda x:-len(x[1])):
    r=len([x for x in v if x[0]=='🔴']); tot+=len(v)
    print(f"  {'🔴' if r else '🟡'} {cat:20s} {len(v):3d}건")
print(f"\n  합계 {tot}건")
json.dump({k:[list(x) for x in v] for k,v in I.items()}, open('/tmp/audit.json','w'), ensure_ascii=False)

sys.exit(1 if any(x[0]=='🔴' for v in I.values() for x in v) else 0)
