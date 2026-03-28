import React, { useState, useEffect, useCallback, useRef } from "react";

const CH = {
  host:     'https://iofse68zg7.europe-west4.gcp.clickhouse.cloud:8443',
  user:     'default',
  password: 'nZU~hx4IoxmfI',
  db:       'bc_tracker',
};

async function query(sql) {
  const url = `${CH.host}/?database=${CH.db}&default_format=JSON`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': CH.user, 'X-ClickHouse-Key': CH.password, 'Content-Type': 'text/plain' },
    body: sql,
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).data || [];
}

const C = {
  bg:'#080809', s1:'#0f0f11', s2:'#141416', s3:'#1a1a1d',
  b1:'#222226', b2:'#2a2a2e',
  orange:'#ff6b35', green:'#22c55e', blue:'#3b82f6',
  purple:'#a855f7', yellow:'#eab308', red:'#ef4444', teal:'#14b8a6',
  text:'#f1f1f3', dim:'#71717a', muted:'#3f3f46',
};

const Q = {
  sites: () => `SELECT site, count() AS n, max(collected_at) AS last FROM bc_tracker.sessions GROUP BY site ORDER BY n DESC`,
  kpis: (site, days) => `
    SELECT count() AS sessions, uniq(uid) AS users,
      countIf(converted=1) AS conversions,
      round(countIf(converted=1)/count()*100,2) AS cvr,
      round(sum(revenue),0) AS revenue,
      round(avg(time_ms)/1000,1) AS avg_time,
      round(avg(max_scroll),0) AS avg_scroll,
      countIf(exit_intent=1) AS exits,
      countIf(rage_clicks>0) AS rages,
      countIf(device='m')/count()*100 AS mobile_pct
    FROM bc_tracker.sessions WHERE site='${site}' AND date>=today()-${days}`,
  pages: (site, days) => `
    SELECT page, variant, count() AS sessions,
      round(countIf(converted=1)/count()*100,2) AS cvr,
      round(sum(revenue),0) AS revenue,
      round(avg(max_scroll),0) AS avg_scroll
    FROM bc_tracker.sessions WHERE site='${site}' AND date>=today()-${days} AND page!=''
    GROUP BY page, variant ORDER BY sessions DESC LIMIT 30`,
  blocks: (site, page, days) => `
    SELECT coalesce(bl.label, b) AS bloc, b AS bloc_raw,
      count() AS seen, countIf(s.converted=1) AS converted,
      round(countIf(s.converted=1)/count()*100,2) AS cvr_seen,
      round(avg(JSONExtractInt(s.blocks_json,b,'ms'))/1000,1) AS avg_sec,
      round(avg(JSONExtractInt(s.blocks_json,b,'speed')),1) AS avg_speed,
      sum(JSONExtractInt(s.blocks_json,b,'returns')) AS returns,
      sum(JSONExtractInt(s.blocks_json,b,'cta')) AS cta_clicks,
      sum(JSONExtractInt(s.blocks_json,b,'selections')) AS selections
    FROM bc_tracker.sessions s
    ARRAY JOIN JSONExtractKeys(blocks_json) AS b
    LEFT JOIN bc_tracker.block_labels bl ON bl.site=s.site AND bl.page=s.page AND bl.bloc_id=b
    WHERE s.site='${site}' AND s.page='${page}' AND date>=today()-${days}
      AND JSONExtractInt(s.blocks_json,b,'seen')=1
    GROUP BY bloc, bloc_raw ORDER BY cvr_seen DESC`,
  blocksNotSeen: (site, page, days) => `
    SELECT coalesce(bl.label, b) AS bloc,
      round(countIf(s.converted=1)/count()*100,2) AS cvr_not_seen
    FROM bc_tracker.sessions s
    ARRAY JOIN JSONExtractKeys(blocks_json) AS b
    LEFT JOIN bc_tracker.block_labels bl ON bl.site=s.site AND bl.page=s.page AND bl.bloc_id=b
    WHERE s.site='${site}' AND s.page='${page}' AND date>=today()-${days}
      AND JSONExtractInt(s.blocks_json,b,'seen')=0
    GROUP BY bloc`,
  sources: (site, days) => `
    SELECT if(utm_source='','direct',utm_source) AS src,
      if(utm_medium='','organic',utm_medium) AS med,
      count() AS n, countIf(converted=1) AS conv,
      round(countIf(converted=1)/count()*100,2) AS cvr,
      round(sum(revenue),0) AS rev
    FROM bc_tracker.sessions WHERE site='${site}' AND date>=today()-${days}
    GROUP BY src,med ORDER BY n DESC LIMIT 15`,
  timeseries: (site, days) => `
    SELECT date, count() AS n, countIf(converted=1) AS conv, round(sum(revenue),0) AS rev
    FROM bc_tracker.sessions WHERE site='${site}' AND date>=today()-${days}
    GROUP BY date ORDER BY date ASC`,
  recent: (site) => `
    SELECT sid,page,variant,device,utm_source,max_scroll,time_ms,converted,revenue,collected_at
    FROM bc_tracker.sessions WHERE site='${site}'
    ORDER BY collected_at DESC LIMIT 30`,
  renameBlock: (site, page, oldId, newLabel) =>
    `INSERT INTO bc_tracker.block_labels VALUES ('${site}','${page}','${oldId}','${newLabel}',now())`,

  // ── META UNIFIÉ ──────────────────────────────────────────────────────────
  metaUnified: (site, days) => `
    SELECT
      m.page,
      round(sum(m.spend), 0) AS spend,
      sum(m.clicks)           AS meta_clicks,
      sum(m.purchases)        AS meta_purchases,
      round(avg(m.cpc), 2)    AS cpc,
      round(avg(m.cvr_meta), 2) AS cvr_meta,
      count(s.sid)            AS bc_sessions,
      countIf(s.converted=1)  AS bc_conversions,
      round(countIf(s.converted=1) / if(count(s.sid)>0, toFloat64(count(s.sid)), 1) * 100, 2) AS cvr_reelle,
      round(avg(s.max_scroll), 0) AS avg_scroll,
      round(avg(s.time_ms)/1000, 1) AS avg_time
    FROM bc_tracker.meta_ads m
    LEFT JOIN bc_tracker.sessions s ON s.site = m.site AND s.page = m.page
    WHERE m.site = '${site}' AND m.date >= today() - ${days} AND m.page != ''
    GROUP BY m.page
    ORDER BY spend DESC
    LIMIT 20`,

  metaCampaigns: (site, days) => `
    SELECT campaign,
      round(sum(spend), 0) AS spend,
      sum(clicks)           AS clics,
      sum(purchases)        AS achats,
      round(avg(cpc), 2)    AS cpc,
      round(avg(cvr_meta), 2) AS cvr_meta
    FROM bc_tracker.meta_ads
    WHERE site='${site}' AND date>=today()-${days} AND campaign!=''
    GROUP BY campaign ORDER BY spend DESC LIMIT 15`,
};

function Tag({ children, color = C.orange }) {
  return <span style={{ display:'inline-flex', alignItems:'center', padding:'2px 7px', borderRadius:4, fontSize:10, fontWeight:600, letterSpacing:'0.04em', background:color+'18', color, border:`1px solid ${color}35`, fontFamily:'monospace' }}>{children}</span>;
}

function KPI({ label, value, sub, color = C.orange }) {
  return (
    <div style={{ padding:'14px 16px', background:C.s2, borderRadius:8, border:`1px solid ${C.b1}`, flex:1, minWidth:100 }}>
      <div style={{ color:C.dim, fontSize:10, letterSpacing:'0.07em', textTransform:'uppercase', marginBottom:5, fontFamily:'monospace' }}>{label}</div>
      <div style={{ color, fontSize:22, fontWeight:800, lineHeight:1, fontFamily:"'Syne',sans-serif" }}>{value ?? '—'}</div>
      {sub && <div style={{ color:C.muted, fontSize:10, marginTop:3, fontFamily:'monospace' }}>{sub}</div>}
    </div>
  );
}

function Bar({ value, max = 100, color = C.orange }) {
  return (
    <div style={{ height:3, background:C.s3, borderRadius:2, overflow:'hidden' }}>
      <div style={{ height:'100%', width:`${Math.min(value/max*100,100)}%`, background:color, borderRadius:2, transition:'width .5s ease' }} />
    </div>
  );
}

function Loader() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:48, color:C.dim, fontFamily:'monospace', fontSize:12 }}>
      <span style={{ animation:'spin 1s linear infinite', display:'inline-block', marginRight:8 }}>⬡</span> Chargement…
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function BlockRow({ b, notSeenCvr, onRename }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(b.bloc);
  const inputRef = useRef();
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const lift = (b.cvr_seen||0) - (notSeenCvr||0);
  const liftColor = lift>2?C.green:lift>0?C.yellow:lift<-1?C.red:C.muted;
  const speedLabel = ['■ stop','▸ lent','▶ moyen','▶▶ vite'][Math.round(b.avg_speed)||0];
  const speedColor = [C.green,'#86efac',C.yellow,C.red][Math.round(b.avg_speed)||0];
  function confirm() {
    const newName = val.trim().replace(/\s+/g,'-').toLowerCase();
    if (newName && newName !== b.bloc_raw) onRename(b.bloc_raw, newName);
    setEditing(false);
  }
  return (
    <div style={{ padding:'11px 14px', background:C.s2, borderRadius:8, border:`1px solid ${C.b1}`, marginBottom:5 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:7 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, flex:1 }}>
          {editing ? (
            <input ref={inputRef} value={val} onChange={e=>setVal(e.target.value)}
              onKeyDown={e=>{if(e.key==='Enter')confirm();if(e.key==='Escape')setEditing(false);e.stopPropagation();}}
              onBlur={confirm}
              style={{ background:C.s3, border:`1px solid ${C.orange}`, borderRadius:4, color:C.orange, fontFamily:'monospace', fontWeight:700, fontSize:13, padding:'2px 6px', outline:'none', width:180 }}/>
          ) : (
            <span onClick={()=>{setVal(b.bloc);setEditing(true);}} style={{ color:C.text, fontWeight:700, fontSize:13, fontFamily:'monospace', cursor:'text', padding:'2px 4px', borderRadius:3, border:'1px solid transparent' }}>{b.bloc}</span>
          )}
          {!editing && <span onClick={()=>{setVal(b.bloc);setEditing(true);}} style={{ color:C.muted, fontSize:10, cursor:'pointer' }}>✎</span>}
          {b.cta_clicks > 0 && <Tag color={C.green}>CTA ×{b.cta_clicks}</Tag>}
          {b.selections > 0 && <Tag color={C.purple}>sel ×{b.selections}</Tag>}
        </div>
        <span style={{ fontWeight:800, color:liftColor, fontFamily:"'Syne',sans-serif", fontSize:14, whiteSpace:'nowrap' }}>
          {lift>0?'+':''}{lift.toFixed(1)}pt
        </span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:7 }}>
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
            <span style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.06em', fontFamily:'monospace' }}>Conv si vu</span>
            <span style={{ color:C.green, fontSize:11, fontFamily:'monospace', fontWeight:700 }}>{b.cvr_seen}%</span>
          </div>
          <Bar value={b.cvr_seen} max={10} color={C.green}/>
        </div>
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
            <span style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.06em', fontFamily:'monospace' }}>Conv si pas vu</span>
            <span style={{ color:C.muted, fontSize:11, fontFamily:'monospace', fontWeight:700 }}>{notSeenCvr||'—'}%</span>
          </div>
          <Bar value={notSeenCvr||0} max={10} color={C.muted}/>
        </div>
      </div>
      <div style={{ display:'flex', gap:12, fontSize:10, fontFamily:'monospace', flexWrap:'wrap', color:C.dim }}>
        <span>vues: <b style={{color:C.text}}>{b.seen}</b></span>
        <span>tps: <b style={{color:C.orange}}>{b.avg_sec}s</b></span>
        <span style={{color:speedColor}}>{speedLabel}</span>
      </div>
    </div>
  );
}

// ── COMPOSANT META ROW ────────────────────────────────────────────────────
function MetaRow({ m }) {
  const cvrDiff = (parseFloat(m.cvr_reelle)||0) - (parseFloat(m.cvr_meta)||0);
  const diffColor = cvrDiff > 0 ? C.green : cvrDiff < -0.5 ? C.red : C.yellow;
  return (
    <div style={{ padding:'12px 14px', background:C.s2, borderRadius:8, border:`1px solid ${C.b1}`, marginBottom:6 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <span style={{ color:C.text, fontWeight:700, fontSize:13, fontFamily:'monospace' }}>{m.page || '—'}</span>
        <span style={{ color:C.teal, fontWeight:800, fontFamily:"'Syne',sans-serif", fontSize:13 }}>€{Number(m.spend).toLocaleString('fr')}</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:8 }}>
        {[
          { label:'Clics Meta', value:Number(m.meta_clicks).toLocaleString('fr'), color:C.blue },
          { label:'Achats Meta', value:m.meta_purchases, color:C.purple },
          { label:'CVR Meta', value:`${m.cvr_meta}%`, color:C.dim },
          { label:'CVR Réelle', value:`${m.cvr_reelle}%`, color:C.green },
        ].map(k => (
          <div key={k.label} style={{ background:C.s3, borderRadius:6, padding:'8px 10px' }}>
            <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.05em', fontFamily:'monospace', marginBottom:3 }}>{k.label}</div>
            <div style={{ color:k.color, fontWeight:700, fontSize:14, fontFamily:"'Syne',sans-serif" }}>{k.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display:'flex', gap:14, fontSize:10, fontFamily:'monospace', color:C.dim, flexWrap:'wrap' }}>
        <span>Sessions BC: <b style={{color:C.text}}>{m.bc_sessions}</b></span>
        <span>Scroll moy: <b style={{color:C.text}}>{m.avg_scroll}%</b></span>
        <span>Tps moy: <b style={{color:C.text}}>{m.avg_time}s</b></span>
        <span style={{color:diffColor}}>
          Δ CVR: {cvrDiff>0?'+':''}{cvrDiff.toFixed(2)}pt
        </span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [sites, setSites]         = useState([]);
  const [site, setSite]           = useState('');
  const [days, setDays]           = useState(30);
  const [tab, setTab]             = useState('pages');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [kpis, setKpis]           = useState(null);
  const [pages, setPages]         = useState([]);
  const [selPage, setSelPage]     = useState('');
  const [blocks, setBlocks]       = useState([]);
  const [notSeen, setNotSeen]     = useState({});
  const [sources, setSources]     = useState([]);
  const [timeseries, setTs]       = useState([]);
  const [recent, setRecent]       = useState([]);
  const [metaData, setMetaData]   = useState([]);
  const [metaCamp, setMetaCamp]   = useState([]);
  const [renaming, setRenaming]   = useState(false);

  useEffect(() => {
    query(Q.sites()).then(d => { setSites(d); if(d.length>0) setSite(d[0].site); }).catch(e=>setError(e.message));
  }, []);

  const loadMain = useCallback(async () => {
    if (!site) return;
    setLoading(true); setError(null);
    try {
      const [k, pg, src, ts, rec, meta, camp] = await Promise.all([
        query(Q.kpis(site, days)),
        query(Q.pages(site, days)),
        query(Q.sources(site, days)),
        query(Q.timeseries(site, days)),
        query(Q.recent(site)),
        query(Q.metaUnified(site, days)),
        query(Q.metaCampaigns(site, days)),
      ]);
      setKpis(k[0]);
      setPages(pg);
      if(pg.length>0 && !selPage) setSelPage(pg[0].page);
      setSources(src); setTs(ts); setRecent(rec);
      setMetaData(meta); setMetaCamp(camp);
    } catch(e) { setError(e.message); }
    setLoading(false);
  }, [site, days]);

  useEffect(() => { loadMain(); }, [loadMain]);

  const loadBlocks = useCallback(async () => {
    if (!site || !selPage) return;
    try {
      const [b, ns] = await Promise.all([
        query(Q.blocks(site, selPage, days*4)),
        query(Q.blocksNotSeen(site, selPage, days*4)),
      ]);
      setBlocks(b);
      const nsMap = {}; ns.forEach(n=>nsMap[n.bloc]=n.cvr_not_seen); setNotSeen(nsMap);
    } catch(e) { setError(e.message); }
  }, [site, selPage, days]);

  useEffect(() => { loadBlocks(); }, [loadBlocks]);

  async function handleRename(blocRaw, newLabel) {
    setRenaming(true);
    try { await query(Q.renameBlock(site, selPage, blocRaw, newLabel)); await loadBlocks(); }
    catch(e) { setError(e.message); }
    setRenaming(false);
  }

  const tabs = [
    { id:'pages',   label:'Comportement' },
    { id:'blocs',   label:`Blocs (${blocks.length})` },
    { id:'meta',    label:`Acquisition Meta` },
    { id:'sources', label:'Sources' },
    { id:'recent',  label:'Sessions' },
  ];

  const tsMax = Math.max(...timeseries.map(d=>Number(d.n)),1);

  return (
    <div style={{ minHeight:'100vh', background:C.bg, color:C.text, fontFamily:"'DM Mono','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:${C.s1}}::-webkit-scrollbar-thumb{background:${C.b1};border-radius:2px}
        select,button{cursor:pointer;font-family:inherit}input:focus{outline:none}
      `}</style>

      <div style={{ padding:'13px 22px', borderBottom:`1px solid ${C.b1}`, background:C.s1, display:'flex', alignItems:'center', justifyContent:'space-between', position:'sticky', top:0, zIndex:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:28, height:28, background:C.orange, borderRadius:5, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:900 }}>⬡</div>
          <div>
            <div style={{ fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:14 }}>BC TRACKER</div>
            <div style={{ fontSize:9, color:C.dim, letterSpacing:'0.07em', textTransform:'uppercase' }}>Behavioral Intelligence</div>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {renaming && <Tag color={C.yellow}>Sauvegarde…</Tag>}
          <select value={site} onChange={e=>setSite(e.target.value)} style={{ padding:'4px 8px', background:C.s2, border:`1px solid ${C.b1}`, borderRadius:5, color:C.text, fontSize:11 }}>
            {sites.map(s=><option key={s.site} value={s.site}>{s.site} ({s.n})</option>)}
          </select>
          <select value={days} onChange={e=>setDays(Number(e.target.value))} style={{ padding:'4px 8px', background:C.s2, border:`1px solid ${C.b1}`, borderRadius:5, color:C.text, fontSize:11 }}>
            <option value={7}>7j</option><option value={14}>14j</option>
            <option value={30}>30j</option><option value={90}>90j</option>
          </select>
          <button onClick={loadMain} style={{ padding:'4px 10px', background:C.orange, border:'none', borderRadius:5, color:'#fff', fontSize:11, fontWeight:700 }}>↻</button>
        </div>
      </div>

      <div style={{ padding:'18px 22px', maxWidth:980, margin:'0 auto' }}>
        {error && <div style={{ marginBottom:12, padding:'10px 14px', background:'#1a0808', border:`1px solid ${C.red}30`, borderRadius:7, color:C.red, fontSize:11 }}>⚠ {error}</div>}

        {timeseries.length>0 && (
          <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:32, marginBottom:14 }}>
            {timeseries.map((d,i)=>(
              <div key={i} title={`${d.date}: ${d.n}`} style={{ flex:1, background:C.orange, opacity:0.2+Number(d.n)/tsMax*0.8, borderRadius:'2px 2px 0 0', height:`${Number(d.n)/tsMax*100}%`, minHeight:2 }}/>
            ))}
          </div>
        )}

        {kpis && (
          <div style={{ display:'flex', gap:8, marginBottom:18, flexWrap:'wrap' }}>
            <KPI label="Sessions"   value={Number(kpis.sessions).toLocaleString('fr')} sub={`${days}j`}/>
            <KPI label="Conv."      value={`${kpis.cvr}%`} color={C.green} sub={`${kpis.conversions} commandes`}/>
            <KPI label="Revenus"    value={`€${Number(kpis.revenue).toLocaleString('fr')}`} color={C.teal}/>
            <KPI label="Tps moyen"  value={`${kpis.avg_time}s`} color={C.blue} sub={`↓${kpis.avg_scroll}%`}/>
            <KPI label="Mobile"     value={`${Math.round(kpis.mobile_pct)}%`} color={C.purple}/>
            <KPI label="Frictions"  value={kpis.rages} color={C.red} sub={`${kpis.exits} exits`}/>
            {metaData.length>0 && <KPI label="Spend Meta" value={`€${metaData.reduce((a,m)=>a+Number(m.spend),0).toLocaleString('fr')}`} color={C.yellow} sub={`${days}j`}/>}
          </div>
        )}

        <div style={{ display:'flex', gap:0, marginBottom:18, borderBottom:`1px solid ${C.b1}` }}>
          {tabs.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)}
              style={{ padding:'7px 14px', background:'none', border:'none', borderBottom:tab===t.id?`2px solid ${C.orange}`:'2px solid transparent', color:tab===t.id?C.text:C.dim, fontSize:11, letterSpacing:'0.04em', marginBottom:-1, transition:'all .15s' }}>
              {t.label}
            </button>
          ))}
        </div>

        {loading && <Loader/>}

        {/* COMPORTEMENT */}
        {!loading && tab==='pages' && (
          <div style={{ display:'grid', gridTemplateColumns:'280px 1fr', gap:16 }}>
            <div>
              <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:10, fontFamily:'monospace' }}>Pages · {pages.length}</div>
              {pages.map(p=>(
                <div key={p.page+p.variant} onClick={()=>setSelPage(p.page)}
                  style={{ padding:'10px 12px', background:selPage===p.page?C.s3:C.s2, borderRadius:7, border:`1px solid ${selPage===p.page?C.orange:C.b1}`, marginBottom:4, cursor:'pointer' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ color:C.text, fontWeight:700, fontSize:12, fontFamily:'monospace' }}>{p.page}</span>
                      <Tag color={C.blue}>{p.variant}</Tag>
                    </div>
                    <span style={{ color:Number(p.cvr)>3?C.green:Number(p.cvr)>1.5?C.yellow:C.red, fontWeight:800, fontFamily:"'Syne',sans-serif", fontSize:13 }}>{p.cvr}%</span>
                  </div>
                  <div style={{ display:'flex', gap:10, fontSize:10, fontFamily:'monospace', color:C.dim, marginTop:4 }}>
                    <span>{p.sessions} sess.</span><span>€{p.revenue}</span><span>↓{p.avg_scroll}%</span>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:10, fontFamily:'monospace' }}>
                Blocs — {selPage} · <span style={{color:C.orange}}>✎ clic pour renommer</span>
              </div>
              {blocks.length===0
                ? <div style={{ color:C.muted, fontSize:12, padding:24, textAlign:'center' }}>Pas encore assez de données pour cette page</div>
                : blocks.map(b=><BlockRow key={b.bloc_raw} b={b} notSeenCvr={notSeen[b.bloc]} onRename={handleRename}/>)}
            </div>
          </div>
        )}

        {/* BLOCS */}
        {!loading && tab==='blocs' && (
          <div>
            <div style={{ display:'flex', gap:8, marginBottom:14, alignItems:'center', flexWrap:'wrap' }}>
              <span style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em', fontFamily:'monospace' }}>Page :</span>
              {pages.map(p=>(
                <button key={p.page+p.variant} onClick={()=>setSelPage(p.page)}
                  style={{ padding:'3px 10px', background:selPage===p.page?C.orange:C.s2, border:`1px solid ${selPage===p.page?C.orange:C.b1}`, borderRadius:4, color:selPage===p.page?'#fff':C.text, fontSize:11, fontFamily:'monospace' }}>
                  {p.page}
                </button>
              ))}
            </div>
            {blocks.map(b=><BlockRow key={b.bloc_raw} b={b} notSeenCvr={notSeen[b.bloc]} onRename={handleRename}/>)}
          </div>
        )}

        {/* META ACQUISITION */}
        {!loading && tab==='meta' && (
          <div>
            {/* KPIs Meta globaux */}
            <div style={{ display:'flex', gap:8, marginBottom:20, flexWrap:'wrap' }}>
              <KPI label="Spend total"    value={`€${metaData.reduce((a,m)=>a+Number(m.spend),0).toLocaleString('fr')}`} color={C.yellow}/>
              <KPI label="Clics totaux"   value={metaData.reduce((a,m)=>a+Number(m.meta_clicks),0).toLocaleString('fr')} color={C.blue}/>
              <KPI label="Achats Meta"    value={metaData.reduce((a,m)=>a+Number(m.meta_purchases),0).toLocaleString('fr')} color={C.purple}/>
              <KPI label="Sessions BC"    value={metaData.reduce((a,m)=>a+Number(m.bc_sessions),0).toLocaleString('fr')} color={C.teal}/>
            </div>

            {/* Par Landing Page */}
            <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:12, fontFamily:'monospace' }}>
              Performance par landing page · Meta × Comportement réel
            </div>
            {metaData.map(m=><MetaRow key={m.page} m={m}/>)}

            {/* Campagnes */}
            {metaCamp.length>0 && (
              <>
                <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em', margin:'20px 0 12px', fontFamily:'monospace' }}>Campagnes</div>
                {metaCamp.map((c,i)=>(
                  <div key={i} style={{ padding:'11px 14px', background:C.s2, borderRadius:8, border:`1px solid ${C.b1}`, marginBottom:5 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                      <span style={{ color:C.text, fontSize:11, fontFamily:'monospace', flex:1, paddingRight:12 }}>{c.campaign}</span>
                      <span style={{ color:C.yellow, fontWeight:700, fontFamily:"'Syne',sans-serif", fontSize:13, whiteSpace:'nowrap' }}>€{Number(c.spend).toLocaleString('fr')}</span>
                    </div>
                    <div style={{ display:'flex', gap:12, fontSize:10, fontFamily:'monospace', color:C.dim }}>
                      <span>clics: <b style={{color:C.text}}>{Number(c.clics).toLocaleString('fr')}</b></span>
                      <span>achats: <b style={{color:C.purple}}>{c.achats}</b></span>
                      <span>CPC: <b style={{color:C.text}}>€{c.cpc}</b></span>
                      <span>CVR: <b style={{color:C.green}}>{c.cvr_meta}%</b></span>
                    </div>
                    <div style={{ marginTop:6, height:3, background:C.s3, borderRadius:2 }}>
                      <div style={{ height:'100%', width:`${Math.min(Number(c.spend)/metaCamp[0]?.spend*100,100)}%`, background:C.yellow, borderRadius:2 }}/>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* SOURCES */}
        {!loading && tab==='sources' && sources.map(s=>(
          <div key={s.src+s.med} style={{ padding:'11px 13px', background:C.s2, borderRadius:7, border:`1px solid ${C.b1}`, marginBottom:5 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ color:C.text, fontWeight:700, fontSize:12, fontFamily:'monospace' }}>{s.src}</span>
                <Tag color={C.dim}>{s.med}</Tag>
              </div>
              <span style={{ color:Number(s.cvr)>3?C.green:Number(s.cvr)>1.5?C.yellow:C.red, fontWeight:800, fontFamily:"'Syne',sans-serif", fontSize:13 }}>{s.cvr}%</span>
            </div>
            <div style={{ display:'flex', gap:12, fontSize:10, fontFamily:'monospace', color:C.dim, marginBottom:6 }}>
              <span>sess: <b style={{color:C.text}}>{s.n}</b></span>
              <span>conv: <b style={{color:C.green}}>{s.conv}</b></span>
              <span>rev: <b style={{color:C.teal}}>€{s.rev}</b></span>
            </div>
            <Bar value={Number(s.cvr)} max={8} color={Number(s.cvr)>3?C.green:Number(s.cvr)>1.5?C.yellow:C.red}/>
          </div>
        ))}

        {/* SESSIONS */}
        {!loading && tab==='recent' && (
          <div style={{ fontFamily:'monospace', fontSize:11 }}>
            <div style={{ display:'grid', gridTemplateColumns:'70px 60px 80px 70px 60px 60px 60px', gap:'0 10px', padding:'5px 8px', color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.05em', borderBottom:`1px solid ${C.b1}`, marginBottom:3 }}>
              <span>Heure</span><span>Page</span><span>Source</span><span>Variant</span><span>Scroll</span><span>Tps</span><span>Conv.</span>
            </div>
            {recent.map((s,i)=>(
              <div key={s.sid+i} style={{ display:'grid', gridTemplateColumns:'70px 60px 80px 70px 60px 60px 60px', gap:'0 10px', padding:'6px 8px', background:i%2===0?C.s2:'transparent', borderRadius:4, marginBottom:2, alignItems:'center' }}>
                <span style={{color:C.muted}}>{String(s.collected_at).slice(11,16)}</span>
                <span style={{color:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.page||'—'}</span>
                <span style={{color:C.dim,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.utm_source||'direct'}</span>
                <span style={{color:C.blue}}>{s.variant||'—'}</span>
                <span style={{color:C.dim}}>{s.max_scroll}%</span>
                <span style={{color:C.dim}}>{Math.round(s.time_ms/1000)}s</span>
                {s.converted=='1'||s.converted===1?<Tag color={C.green}>€{s.revenue}</Tag>:<span style={{color:C.muted}}>—</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
