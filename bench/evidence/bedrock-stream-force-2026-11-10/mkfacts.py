import json,collections
S="D:/temp/claude/67392035d714e8ba/b98023ea-3bcc-4ecb-9e49-e3cf2888146a/scratchpad/bedrock-stream-force/"
rs=[json.loads(l) for l in open(S+"records.jsonl")]
FAM={ 'us.amazon.nova-2-lite-v1:0':'nova','us.anthropic.claude-haiku-4-5-20251001-v1:0':'claude-haiku-4.5',
'meta.llama3-1-70b-instruct-v1:0':'llama-3.1','us.meta.llama3-3-70b-instruct-v1:0':'llama-3.3','us.meta.llama4-scout-17b-instruct-v1:0':'llama-4',
'qwen.qwen3-32b-v1:0':'qwen3-32b','qwen.qwen3-coder-30b-a3b-v1:0':'qwen3-coder','deepseek.v3.2':'deepseek-v3.2','moonshotai.kimi-k2.5':'kimi-k2.5',
'moonshot.kimi-k2-thinking':'kimi-k2-thinking','us.moonshotai.kimi-k3':'kimi-k3','zai.glm-4.7':'glm-4.7','zai.glm-5':'glm-5','minimax.minimax-m2':'minimax-m2',
'minimax.minimax-m2.5':'minimax-m2.5','openai.gpt-oss-20b-1:0':'gpt-oss','openai.gpt-oss-120b-1:0':'gpt-oss','mistral.mistral-large-3-675b-instruct':'mistral-large-3',
'mistral.devstral-2-123b':'devstral-2','nvidia.nemotron-nano-3-30b':'nemotron-nano-3','google.gemma-3-27b-it':'gemma-3','mistral.mistral-large-2407-v1:0':'mistral-large-2',
'us.mistral.pixtral-large-2502-v1:0':'pixtral-large'}
def use(r):
    c=r['cell']
    if r['model']=='minimax.minimax-m2':  # 200-token cells were cut by max_tokens; use the 800 retry
        return c.endswith('@800') or c in('any_hello','named')
    return '@' not in c
by=collections.defaultdict(lambda: collections.defaultdict(list))
for r in rs:
    if use(r): by[FAM[r['model']]][r['cell'].split('@')[0]].append(r)
def err(r): return r['response']['outcome']=='error'
out={}
for fam,cells in by.items():
    f={}
    st=cells.get('stream',[])
    if st:
        n=len(st); ref=sum(err(r) and 'streaming mode' in r['error']['message'] for r in st); ok=sum(r['response']['outcome']=='tool_ok' for r in st); br=sum(r['response']['outcome']=='tool_broken' for r in st); tx=sum(r['response']['outcome']=='text' for r in st)
        if ref==n: f['stream']=('refused',ref,n,"every ConverseStream request with tools refused: \"This model doesn't support tool use in streaming mode.\"")
        elif br>=n/2: f['stream']=('broken',br,n,f"{br} of {n} streams carried tool input that does not parse as JSON (opening fragment missing); {ok} parsed")
        elif ok>0: f['stream']=('incremental',ok,n,f"{ok} of {n} streams joined into valid JSON tool input; {br} broken fragments; {tx} answered in text without a tool call")
    allc=[r for c in ('auto','any_hello','any_tool','named') for r in cells.get(c,[])]
    acc=lambda c: [not err(r) for r in cells.get(c,[])]
    a_ok=all(acc('auto')) ; any_ok=all(acc('any_hello')+acc('any_tool')); nm_ok=all(acc('named'))
    anyr=any(err(r) for r in cells.get('any_hello',[])+cells.get('any_tool',[])); nmr=any(err(r) for r in cells.get('named',[]))
    val={'auto':bool(a_ok),'required':bool(any_ok),'named':bool(nm_ok)}
    kmatch=0; nn=0
    for c,key in (('auto','auto'),('any_hello','required'),('any_tool','required'),('named','named')):
        for r in cells.get(c,[]): nn+=1; kmatch+= (not err(r))==val[key]
    errs=sorted({r['error']['message'] for r in allc if err(r)})
    f['toolChoice']=(val,kmatch,nn,"accepted = HTTP 200; rejected = ValidationException"+(": "+" | ".join(e[:110] for e in errs) if errs else ""))
    hello=cells.get('any_hello',[]); ar=cells.get('any_tool',[])
    if hello:
        h=[r for r in hello]; n=len(h); rej=sum(err(r) for r in h); tool=sum(r['response']['outcome']=='tool' for r in h); txt=sum(r['response']['outcome']=='text' for r in h)
        if rej==n: v=('rejected',rej)
        elif tool>=txt: v=('honoured',tool)
        else: v=('ignored',txt)
        nm=cells.get('named',[]); nmt=sum(r['response'].get('namedMatch')==True for r in nm); nmx=sum(r['response']['outcome']=='text' for r in nm); nmrj=sum(err(r) for r in nm)
        f['toolForce']=(v[0],v[1],n,f"toolChoice any on the prompt 'Say hello.': {tool} toolUse, {txt} text, {rej} rejected. Named tool on the same prompt: {nmt} toolUse of the named tool, {nmx} text, {nmrj} rejected. any on a tool-needing prompt: {sum(r['response']['outcome']=='tool' for r in ar)} of {len(ar)} toolUse")
    out[fam]=f
json.dump(out,open(S+"facts-raw.json","w"),indent=1)
CP="AWS SDK v3 Converse/ConverseStream, one read_file tool, maxTokens 200 (800 for MiniMax M2 stream/auto/any rows), temperature 0 (omitted for Kimi K3), us-east-1 (us-west-2 for Llama 3.1 70B and Mistral Large 2407)"
def fact(name,v,k,n,note,src_extra=""):
    return {"value":v,"level":"measured","source":"bedrock-stream-force run bsf-2026-11-10 (raw JSONL attached to the PR)","readOn":"2026-11-10","k":k,"n":n,"runId":"bsf-2026-11-10","clientPath":CP,"note":note}
rows={}
for fam,f in out.items():
    if 'stream' in f:
        v,k,n,note=f['stream']; rows[f"bedrock-converse-stream-{fam}"]={"id":f"bedrock-converse-stream-{fam}","provider":"bedrock","engine":"*","api":"converse-stream","modelFamily":fam,"facts":{"streamingToolArgs":fact("streamingToolArgs",v,k,n,note)}}
    cf={}
    v,k,n,note=f['toolChoice']; cf['toolChoice']=fact('toolChoice',v,k,n,note)
    v,k,n,note=f['toolForce']; cf['toolForce']=fact('toolForce',v,k,n,note)
    rows[f"bedrock-converse-{fam}"]={"id":f"bedrock-converse-{fam}","provider":"bedrock","engine":"*","api":"converse","modelFamily":fam,"facts":cf}
json.dump(rows,open(S+"new-rows.json","w"),indent=1)
# merge into a copy of the PR file
base=json.load(open("D:/temp/sf/surfaceFacts.generated.json"))
idx={r['id']:r for r in base['rows']}
log=[]
for rid,row in rows.items():
    if rid in idx:
        for k,v in row['facts'].items():
            if k in idx[rid]['facts']: log.append(f"replace {rid}.{k} (was {idx[rid]['facts'][k]['level']})")
            else: log.append(f"add {rid}.{k}")
            idx[rid]['facts'][k]=v
    else:
        base['rows'].append(row); log.append(f"new row {rid}")
json.dump(base,open(S+"surfaceFacts.generated.patched.json","w"),indent=2); open(S+"patch-ops.txt","w").write("\n".join(log))
print("\n".join(log))
