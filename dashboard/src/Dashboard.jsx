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

// ── CHARTE BOOST CONVERSION ────────────────────────────────────────────────
const C = {
  // Fonds
  bg:     '#1C0D30',   // Bleu Sérieux foncé
  s1:     '#251342',   // Surface primaire
  s2:     '#2D1A4E',   // Surface secondaire
  s3:     '#361F5C',   // Surface tertiaire
  b1:     '#4A2E78',   // Bordure
  b2:     '#5C3A8A',   // Bordure active

  // Couleurs Boost Conversion
  purple: '#B97FE5',   // Science Purple — principal
  blue:   '#92ABFB',   // Bleu Ciel
  orange: '#FFAD77',   // Orange Tonique
  white:  '#FFFFFF',

  // Dérivés
  purpleLight: '#D4A8F0',
  purpleDark:  '#8A55C4',
  blueLight:   '#B8CDFF',
  orangeLight: '#FFD0AA',

  // Textes
  text:   '#F7F1FB',   // Fond Violet utilisé comme texte clair
  dim:    '#9B85B8',
  muted:  '#5C3A8A',

  // Sémantique
  green:  '#7EE8A2',
  red:    '#FF8FA3',
  yellow: '#FFCB77',
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
      AND (JSONExtractInt(s.blocks_json,b,'seen')=1 OR JSONExtractInt(s.blocks_json,b,'clicks')>0 OR JSONExtractInt(s.blocks_json,b,'cta')>0)
    GROUP BY bloc, bloc_raw ORDER BY cvr_seen DESC`,

  // Vue structure : TOUS les blocs dans l'ordre de la page
  blocksStructure: (site, page, days) => `
    SELECT
      coalesce(bl.label, b) AS bloc,
      b AS bloc_raw,
      round(avg(JSONExtractInt(s.blocks_json,b,'scroll_pct')),0) AS position,
      count() AS total_sessions,
      countIf(JSONExtractInt(s.blocks_json,b,'seen')=1 OR JSONExtractInt(s.blocks_json,b,'clicks')>0 OR JSONExtractInt(s.blocks_json,b,'cta')>0) AS sessions_actives,
      round(countIf(JSONExtractInt(s.blocks_json,b,'seen')=1 OR JSONExtractInt(s.blocks_json,b,'clicks')>0 OR JSONExtractInt(s.blocks_json,b,'cta')>0)/count()*100,0) AS pct_vu,
      sum(JSONExtractInt(s.blocks_json,b,'cta')) AS cta_totaux,
      round(avg(JSONExtractInt(s.blocks_json,b,'ms'))/1000,1) AS avg_sec
    FROM bc_tracker.sessions s
    ARRAY JOIN JSONExtractKeys(blocks_json) AS b
    LEFT JOIN bc_tracker.block_labels bl ON bl.site=s.site AND bl.page=s.page AND bl.bloc_id=b
    WHERE s.site='${site}' AND s.page='${page}' AND date>=today()-${days}
      AND blocks_json != '{}'
    GROUP BY bloc, bloc_raw
    ORDER BY position ASC`,
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
  metaUnified: (site, days) => `
    SELECT m.page,
      round(sum(m.spend),0) AS spend,
      sum(m.clicks) AS meta_clicks,
      sum(m.purchases) AS meta_purchases,
      round(avg(m.cpc),2) AS cpc,
      round(avg(m.cvr_meta),2) AS cvr_meta,
      count(s.sid) AS bc_sessions,
      countIf(s.converted=1) AS bc_conversions,
      round(countIf(s.converted=1)/if(count(s.sid)>0,toFloat64(count(s.sid)),1)*100,2) AS cvr_reelle,
      round(avg(s.max_scroll),0) AS avg_scroll,
      round(avg(s.time_ms)/1000,1) AS avg_time
    FROM bc_tracker.meta_ads m
    LEFT JOIN bc_tracker.sessions s ON s.site=m.site AND s.page=m.page
    WHERE m.site='${site}' AND m.date>=today()-${days} AND m.page!=''
    GROUP BY m.page ORDER BY spend DESC LIMIT 20`,
  metaCampaigns: (site, days) => `
    SELECT campaign,
      round(sum(spend),0) AS spend,
      sum(clicks) AS clics,
      sum(purchases) AS achats,
      round(avg(cpc),2) AS cpc,
      round(avg(cvr_meta),2) AS cvr_meta
    FROM bc_tracker.meta_ads
    WHERE site='${site}' AND date>=today()-${days} AND campaign!=''
    GROUP BY campaign ORDER BY spend DESC LIMIT 15`,
};

// ── COMPOSANTS ─────────────────────────────────────────────────────────────

function Tag({ children, color = C.purple }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', padding:'2px 8px', borderRadius:20, fontSize:10, fontWeight:600, letterSpacing:'0.03em', background:color+'22', color, border:`1px solid ${color}44` }}>
      {children}
    </span>
  );
}

function KPI({ label, value, sub, color = C.purple }) {
  return (
    <div style={{ padding:'16px 18px', background:C.s2, borderRadius:10, border:`1px solid ${C.b1}`, flex:1, minWidth:110, position:'relative', overflow:'hidden' }}>
      <div style={{ position:'absolute', top:0, left:0, right:0, height:2, background:`linear-gradient(90deg, ${color}88, transparent)` }}/>
      <div style={{ color:C.dim, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:6, fontFamily:'Helvetica Neue, Arial, sans-serif' }}>{label}</div>
      <div style={{ color, fontSize:24, fontWeight:700, lineHeight:1, fontFamily:'Helvetica Neue, Arial, sans-serif' }}>{value ?? '—'}</div>
      {sub && <div style={{ color:C.muted, fontSize:10, marginTop:4 }}>{sub}</div>}
    </div>
  );
}

function Bar({ value, max = 100, color = C.purple }) {
  return (
    <div style={{ height:3, background:C.s3, borderRadius:2, overflow:'hidden' }}>
      <div style={{ height:'100%', width:`${Math.min(value/max*100,100)}%`, background:color, borderRadius:2, transition:'width .5s ease' }} />
    </div>
  );
}

function Loader() {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:60, color:C.dim, fontSize:13 }}>
      <div style={{ width:20, height:20, border:`2px solid ${C.b1}`, borderTop:`2px solid ${C.purple}`, borderRadius:'50%', animation:'spin 0.8s linear infinite', marginRight:12 }}/>
      Chargement…
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
  const speedLabel = ['■ arrêt','▸ lent','▶ moyen','▶▶ rapide'][Math.round(b.avg_speed)||0];
  const speedColor = [C.green,'#A8D5B5',C.yellow,C.red][Math.round(b.avg_speed)||0];

  function confirm() {
    const newName = val.trim().replace(/\s+/g,'-').toLowerCase();
    if (newName && newName !== b.bloc_raw) onRename(b.bloc_raw, newName);
    setEditing(false);
  }

  return (
    <div style={{ padding:'12px 16px', background:C.s2, borderRadius:10, border:`1px solid ${C.b1}`, marginBottom:6, transition:'border-color .15s' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, flex:1 }}>
          {editing ? (
            <input ref={inputRef} value={val} onChange={e=>setVal(e.target.value)}
              onKeyDown={e=>{if(e.key==='Enter')confirm();if(e.key==='Escape')setEditing(false);e.stopPropagation();}}
              onBlur={confirm}
              style={{ background:C.s3, border:`1px solid ${C.purple}`, borderRadius:6, color:C.purple, fontFamily:'Helvetica Neue, Arial, sans-serif', fontWeight:700, fontSize:13, padding:'3px 8px', outline:'none', width:200 }}/>
          ) : (
            <span onClick={()=>{setVal(b.bloc);setEditing(true);}} title="Cliquer pour renommer"
              style={{ color:C.text, fontWeight:700, fontSize:13, cursor:'text', padding:'2px 4px', borderRadius:4, border:'1px solid transparent' }}>
              {b.bloc}
            </span>
          )}
          {!editing && <span onClick={()=>{setVal(b.bloc);setEditing(true);}} style={{ color:C.muted, fontSize:11, cursor:'pointer', opacity:.6 }}>✎</span>}
          {b.cta_clicks>0 && <Tag color={C.green}>CTA ×{b.cta_clicks}</Tag>}
          {b.selections>0 && <Tag color={C.blue}>sel ×{b.selections}</Tag>}
          {b.returns>0 && <Tag color={C.blue}>↩ {b.returns}</Tag>}
        </div>
        <span style={{ fontWeight:700, color:liftColor, fontSize:15, whiteSpace:'nowrap' }}>
          {lift>0?'+':''}{lift.toFixed(1)}pt
        </span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:8 }}>
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
            <span style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em' }}>Conv si vu</span>
            <span style={{ color:C.green, fontSize:11, fontWeight:700 }}>{b.cvr_seen}%</span>
          </div>
          <Bar value={b.cvr_seen} max={10} color={C.green}/>
        </div>
        <div>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
            <span style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em' }}>Conv si pas vu</span>
            <span style={{ color:C.muted, fontSize:11, fontWeight:700 }}>{notSeenCvr||'—'}%</span>
          </div>
          <Bar value={notSeenCvr||0} max={10} color={C.muted}/>
        </div>
      </div>
      <div style={{ display:'flex', gap:12, fontSize:10, flexWrap:'wrap', color:C.dim }}>
        <span>vues: <b style={{color:C.text}}>{b.seen}</b></span>
        <span>tps moy: <b style={{color:C.orange}}>{b.avg_sec}s</b></span>
        <span style={{color:speedColor}}>{speedLabel}</span>
      </div>
    </div>
  );
}

function MetaRow({ m }) {
  const cvrDiff = (parseFloat(m.cvr_reelle)||0) - (parseFloat(m.cvr_meta)||0);
  const diffColor = cvrDiff>0?C.green:cvrDiff<-0.5?C.red:C.yellow;
  return (
    <div style={{ padding:'14px 16px', background:C.s2, borderRadius:10, border:`1px solid ${C.b1}`, marginBottom:6 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
        <span style={{ color:C.text, fontWeight:700, fontSize:14 }}>{m.page||'—'}</span>
        <span style={{ color:C.orange, fontWeight:700, fontSize:15 }}>€{Number(m.spend).toLocaleString('fr')}</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:10 }}>
        {[
          { label:'Clics Meta', value:Number(m.meta_clicks).toLocaleString('fr'), color:C.blue },
          { label:'Achats Meta', value:m.meta_purchases, color:C.purple },
          { label:'CVR Meta', value:`${m.cvr_meta}%`, color:C.dim },
          { label:'CVR Réelle', value:`${m.cvr_reelle}%`, color:C.green },
        ].map(k=>(
          <div key={k.label} style={{ background:C.s3, borderRadius:8, padding:'8px 10px' }}>
            <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:4 }}>{k.label}</div>
            <div style={{ color:k.color, fontWeight:700, fontSize:15 }}>{k.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display:'flex', gap:14, fontSize:10, color:C.dim, flexWrap:'wrap' }}>
        <span>Sessions BC: <b style={{color:C.text}}>{m.bc_sessions}</b></span>
        <span>Scroll moy: <b style={{color:C.text}}>{m.avg_scroll}%</b></span>
        <span>Tps moy: <b style={{color:C.text}}>{m.avg_time}s</b></span>
        <span style={{color:diffColor}}>Δ CVR: {cvrDiff>0?'+':''}{cvrDiff.toFixed(2)}pt</span>
      </div>
    </div>
  );
}

// ── APP ────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [sites, setSites]       = useState([]);
  const [site, setSite]         = useState('');
  const [days, setDays]         = useState(30);
  const [tab, setTab]           = useState('pages');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [kpis, setKpis]         = useState(null);
  const [pages, setPages]       = useState([]);
  const [selPage, setSelPage]   = useState('');
  const [blocks, setBlocks]         = useState([]);
  const [blocksStruct, setBlocksStruct] = useState([]);
  const [notSeen, setNotSeen]   = useState({});
  const [sources, setSources]   = useState([]);
  const [timeseries, setTs]     = useState([]);
  const [recent, setRecent]     = useState([]);
  const [metaData, setMetaData] = useState([]);
  const [metaCamp, setMetaCamp] = useState([]);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    query(Q.sites()).then(d=>{ setSites(d); if(d.length>0) setSite(d[0].site); }).catch(e=>setError(e.message));
  }, []);

  const loadMain = useCallback(async () => {
    if (!site) return;
    setLoading(true); setError(null);
    try {
      const [k,pg,src,ts,rec,meta,camp] = await Promise.all([
        query(Q.kpis(site,days)), query(Q.pages(site,days)),
        query(Q.sources(site,days)), query(Q.timeseries(site,days)),
        query(Q.recent(site)), query(Q.metaUnified(site,days)),
        query(Q.metaCampaigns(site,days)),
      ]);
      setKpis(k[0]); setPages(pg);
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
      const [b,ns,bs] = await Promise.all([
        query(Q.blocks(site,selPage,days*4)),
        query(Q.blocksNotSeen(site,selPage,days*4)),
        query(Q.blocksStructure(site,selPage,days*4)),
      ]);
      setBlocks(b);
      setBlocksStruct(bs);
      const nsMap={}; ns.forEach(n=>nsMap[n.bloc]=n.cvr_not_seen); setNotSeen(nsMap);
    } catch(e) { setError(e.message); }
  }, [site,selPage,days]);

  useEffect(() => { loadBlocks(); }, [loadBlocks]);

  async function handleRename(blocRaw, newLabel) {
    setRenaming(true);
    try { await query(Q.renameBlock(site,selPage,blocRaw,newLabel)); await loadBlocks(); }
    catch(e) { setError(e.message); }
    setRenaming(false);
  }

  const tabs = [
    { id:'pages',     label:'Comportement' },
    { id:'structure', label:`Structure page` },
    { id:'blocs',     label:`Blocs (${blocks.length})` },
    { id:'meta',      label:'Acquisition Meta' },
    { id:'sources',   label:'Sources' },
    { id:'recent',    label:'Sessions' },
  ];

  const tsMax = Math.max(...timeseries.map(d=>Number(d.n)),1);
  const totalSpend = metaData.reduce((a,m)=>a+Number(m.spend),0);

  const selectStyle = {
    padding:'6px 12px', background:C.s2, border:`1px solid ${C.b1}`,
    borderRadius:8, color:C.text, fontSize:12,
    fontFamily:'Helvetica Neue, Arial, sans-serif',
  };

  const btnStyle = {
    padding:'6px 14px', background:C.purple, border:'none',
    borderRadius:8, color:'#fff', fontSize:12, fontWeight:600,
    cursor:'pointer', fontFamily:'Helvetica Neue, Arial, sans-serif',
  };

  return (
    <div style={{ minHeight:'100vh', background:C.bg, color:C.text, fontFamily:'Helvetica Neue, Arial, sans-serif' }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:${C.s1}}
        ::-webkit-scrollbar-thumb{background:${C.b1};border-radius:2px}
        select,button{cursor:pointer;font-family:inherit}
        input:focus{outline:none}
      `}</style>

      {/* HEADER */}
      <div style={{ padding:'14px 28px', borderBottom:`1px solid ${C.b1}`, background:C.s1, display:'flex', alignItems:'center', justifyContent:'space-between', position:'sticky', top:0, zIndex:10 }}>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          {/* Logo Boost Conversion */}
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ width:10, height:10, background:C.purple, borderRadius:'50%' }}/>
            <span style={{ fontWeight:700, fontSize:15, letterSpacing:'0.04em', color:C.text }}>BOOST CONVERSION</span>
          </div>
          <div style={{ width:1, height:20, background:C.b1 }}/>
          <span style={{ fontSize:11, color:C.dim, letterSpacing:'0.06em', textTransform:'uppercase' }}>NeuroCRO Dashboard</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {renaming && <Tag color={C.yellow}>Sauvegarde…</Tag>}
          <select value={site} onChange={e=>setSite(e.target.value)} style={selectStyle}>
            {sites.map(s=><option key={s.site} value={s.site}>{s.site} ({s.n})</option>)}
          </select>
          <select value={days} onChange={e=>setDays(Number(e.target.value))} style={selectStyle}>
            <option value={7}>7 jours</option>
            <option value={14}>14 jours</option>
            <option value={30}>30 jours</option>
            <option value={60}>60 jours</option>
            <option value={90}>90 jours</option>
            <option value={180}>6 mois</option>
            <option value={365}>12 mois</option>
          </select>
          <button onClick={loadMain} style={btnStyle}>↻ Actualiser</button>
        </div>
      </div>

      <div style={{ padding:'24px 28px', maxWidth:1000, margin:'0 auto' }}>
        {error && <div style={{ marginBottom:14, padding:'10px 16px', background:'#3D0B1A', border:`1px solid ${C.red}44`, borderRadius:8, color:C.red, fontSize:12 }}>⚠ {error}</div>}

        {/* MINI CHART */}
        {timeseries.length>0 && (
          <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:36, marginBottom:16, padding:'0 2px' }}>
            {timeseries.map((d,i)=>(
              <div key={i} title={`${d.date}: ${d.n}`}
                style={{ flex:1, background:`linear-gradient(180deg, ${C.purple}, ${C.blue})`, opacity:0.15+Number(d.n)/tsMax*0.85, borderRadius:'2px 2px 0 0', height:`${Number(d.n)/tsMax*100}%`, minHeight:3 }}/>
            ))}
          </div>
        )}

        {/* KPIs */}
        {kpis && (
          <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap' }}>
            <KPI label="Sessions"    value={Number(kpis.sessions).toLocaleString('fr')} sub={`${days} derniers jours`} color={C.purple}/>
            <KPI label="Conversion"  value={`${kpis.cvr}%`} color={C.green} sub={`${kpis.conversions} commandes`}/>
            <KPI label="Revenus"     value={`€${Number(kpis.revenue).toLocaleString('fr')}`} color={C.orange}/>
            <KPI label="Tps moyen"   value={`${kpis.avg_time}s`} color={C.blue} sub={`↓${kpis.avg_scroll}% scroll`}/>
            <KPI label="Mobile"      value={`${Math.round(kpis.mobile_pct)}%`} color={C.purple}/>
            <KPI label="Frictions"   value={kpis.rages} color={C.red} sub={`${kpis.exits} exits`}/>
            {totalSpend>0 && <KPI label="Spend Meta" value={`€${totalSpend.toLocaleString('fr')}`} color={C.orange} sub={`${days}j`}/>}
          </div>
        )}

        {/* TABS */}
        <div style={{ display:'flex', gap:0, marginBottom:20, borderBottom:`1px solid ${C.b1}` }}>
          {tabs.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)}
              style={{ padding:'8px 18px', background:'none', border:'none', borderBottom:tab===t.id?`2px solid ${C.purple}`:'2px solid transparent', color:tab===t.id?C.text:C.dim, fontSize:12, fontWeight:tab===t.id?600:400, letterSpacing:'0.02em', marginBottom:-1, transition:'all .15s' }}>
              {t.label}
            </button>
          ))}
        </div>

        {loading && <Loader/>}

        {/* COMPORTEMENT */}
        {!loading && tab==='pages' && (
          <div style={{ display:'grid', gridTemplateColumns:'260px 1fr', gap:20 }}>
            <div>
              <div style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:12 }}>Pages · {pages.length}</div>
              {pages.map(p=>(
                <div key={p.page+p.variant} onClick={()=>setSelPage(p.page)}
                  style={{ padding:'11px 14px', background:selPage===p.page?C.s3:C.s2, borderRadius:10, border:`1px solid ${selPage===p.page?C.purple:C.b1}`, marginBottom:5, cursor:'pointer', transition:'all .15s' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <span style={{ color:C.text, fontWeight:700, fontSize:13 }}>{p.page}</span>
                      <Tag color={C.blue}>{p.variant}</Tag>
                    </div>
                    <span style={{ color:Number(p.cvr)>3?C.green:Number(p.cvr)>1.5?C.yellow:C.red, fontWeight:700, fontSize:13 }}>{p.cvr}%</span>
                  </div>
                  <div style={{ display:'flex', gap:10, fontSize:10, color:C.dim, marginTop:5 }}>
                    <span>{p.sessions} sess.</span><span>€{p.revenue}</span><span>↓{p.avg_scroll}%</span>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <div style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:12 }}>
                Blocs — <span style={{color:C.text}}>{selPage}</span>
                <span style={{color:C.purple,marginLeft:8}}>✎ clic pour renommer</span>
              </div>
              {blocks.length===0
                ? <div style={{ color:C.muted, fontSize:13, padding:32, textAlign:'center', background:C.s2, borderRadius:10, border:`1px dashed ${C.b1}` }}>Pas encore assez de données pour cette page</div>
                : blocks.map(b=><BlockRow key={b.bloc_raw} b={b} notSeenCvr={notSeen[b.bloc]} onRename={handleRename}/>)}
            </div>
          </div>
        )}

        {/* STRUCTURE DE PAGE */}
        {!loading && tab==='structure' && (
          <div>
            <div style={{ display:'flex', gap:8, marginBottom:16, alignItems:'center', flexWrap:'wrap' }}>
              <span style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em' }}>Page :</span>
              {[...new Set(pages.map(p=>p.page))].map(pg=>(
                <button key={pg} onClick={()=>setSelPage(pg)}
                  style={{ padding:'4px 12px', background:selPage===pg?C.purple:C.s2, border:`1px solid ${selPage===pg?C.purple:C.b1}`, borderRadius:6, color:selPage===pg?'#fff':C.text, fontSize:11 }}>
                  {pg}
                </button>
              ))}
            </div>
            <div style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:16 }}>
              Structure de la page · <span style={{color:C.text}}>{selPage}</span> · du haut vers le bas
            </div>
            {blocksStruct.length === 0
              ? <div style={{ color:C.muted, fontSize:13, padding:32, textAlign:'center', background:C.s2, borderRadius:10, border:`1px dashed ${C.b1}` }}>Pas encore assez de données</div>
              : (
                <div style={{ display:'flex', gap:20 }}>
                  {/* COLONNE GAUCHE : structure visuelle */}
                  <div style={{ width:280, flexShrink:0 }}>
                    <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:10 }}>Heatmap visibilité</div>
                    {blocksStruct.map((b, i) => {
                      const pct = Number(b.pct_vu);
                      const color = pct >= 70 ? C.green : pct >= 40 ? C.yellow : pct >= 15 ? C.orange : C.red;
                      const bgOpacity = Math.max(0.08, pct/100*0.4);
                      return (
                        <div key={b.bloc_raw} onClick={()=>setSelPage(selPage)}
                          style={{ marginBottom:4, padding:'8px 12px', background:`rgba(${color==='#7EE8A2'?'126,232,162':color==='#FFAD77'?'255,173,119':color==='#eab308'?'234,179,8':'255,143,163'},${bgOpacity})`, borderRadius:8, border:`1px solid ${color}44`, cursor:'default' }}>
                          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                            <span style={{ color:C.text, fontSize:12, fontWeight:600 }}>{b.bloc}</span>
                            <span style={{ color, fontSize:13, fontWeight:700 }}>{pct}%</span>
                          </div>
                          <div style={{ marginTop:5, height:4, background:C.s3, borderRadius:2 }}>
                            <div style={{ height:'100%', width:`${pct}%`, background:color, borderRadius:2, transition:'width .5s' }}/>
                          </div>
                          <div style={{ display:'flex', gap:10, marginTop:4, fontSize:10, color:C.dim }}>
                            <span>{b.sessions_actives}/{b.total_sessions} visiteurs</span>
                            {Number(b.cta_totaux) > 0 && <span style={{color:C.green}}>CTA ×{b.cta_totaux}</span>}
                            {Number(b.avg_sec) > 0 && <span>{b.avg_sec}s moy</span>}
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ marginTop:12, padding:'8px 12px', background:C.s2, borderRadius:8, fontSize:10, color:C.dim }}>
                      <div style={{ marginBottom:4, fontWeight:600, color:C.text }}>Légende</div>
                      {[['#7EE8A2','≥70% — Très vu'],['#eab308','40-70% — Bien vu'],['#FFAD77','15-40% — Peu vu'],['#FF8FA3','<15% — Rarement vu']].map(([c,l])=>(
                        <div key={c} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                          <div style={{ width:10, height:10, borderRadius:2, background:c }}/>
                          <span>{l}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* COLONNE DROITE : insights */}
                  <div style={{ flex:1 }}>
                    <div style={{ color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:10 }}>Insights clés</div>
                    {/* Bloc le plus cliqué */}
                    {(() => {
                      const topCta = [...blocksStruct].sort((a,b)=>Number(b.cta_totaux)-Number(a.cta_totaux))[0];
                      const leastSeen = blocksStruct.filter(b=>Number(b.pct_vu)<15);
                      const dropOff = blocksStruct.findIndex((b,i)=> i>0 && Number(b.pct_vu) < Number(blocksStruct[i-1]?.pct_vu)*0.5);
                      return (
                        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                          {topCta && Number(topCta.cta_totaux)>0 && (
                            <div style={{ padding:'12px 14px', background:C.s2, borderRadius:10, border:`1px solid ${C.green}33` }}>
                              <div style={{ color:C.green, fontSize:11, fontWeight:600, marginBottom:4 }}>🎯 Bloc le plus converti</div>
                              <div style={{ color:C.text, fontSize:13, fontWeight:700 }}>{topCta.bloc}</div>
                              <div style={{ color:C.dim, fontSize:11, marginTop:2 }}>{topCta.cta_totaux} clics CTA · {topCta.pct_vu}% des visiteurs l'ont vu</div>
                            </div>
                          )}
                          {dropOff >= 0 && (
                            <div style={{ padding:'12px 14px', background:C.s2, borderRadius:10, border:`1px solid ${C.orange}33` }}>
                              <div style={{ color:C.orange, fontSize:11, fontWeight:600, marginBottom:4 }}>⚠ Point de décrochage</div>
                              <div style={{ color:C.text, fontSize:13, fontWeight:700 }}>{blocksStruct[dropOff]?.bloc}</div>
                              <div style={{ color:C.dim, fontSize:11, marginTop:2 }}>
                                Chute de {blocksStruct[dropOff-1]?.pct_vu}% → {blocksStruct[dropOff]?.pct_vu}% entre le bloc précédent et celui-ci
                              </div>
                            </div>
                          )}
                          {leastSeen.length > 0 && (
                            <div style={{ padding:'12px 14px', background:C.s2, borderRadius:10, border:`1px solid ${C.red}33` }}>
                              <div style={{ color:C.red, fontSize:11, fontWeight:600, marginBottom:4 }}>👻 Blocs fantômes (moins de 15% des visiteurs)</div>
                              {leastSeen.map(b=>(
                                <div key={b.bloc_raw} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', borderBottom:`1px solid ${C.b1}` }}>
                                  <span style={{ color:C.text, fontSize:12 }}>{b.bloc}</span>
                                  <span style={{ color:C.red, fontSize:12 }}>{b.pct_vu}%</span>
                                </div>
                              ))}
                              <div style={{ color:C.dim, fontSize:10, marginTop:6 }}>Ces blocs ne sont vus que par une minorité → potentiel de restructuration</div>
                            </div>
                          )}
                          <div style={{ padding:'12px 14px', background:C.s2, borderRadius:10, border:`1px solid ${C.b1}` }}>
                            <div style={{ color:C.dim, fontSize:11, fontWeight:600, marginBottom:8 }}>Tableau complet</div>
                            {blocksStruct.map((b,i)=>(
                              <div key={b.bloc_raw} style={{ display:'grid', gridTemplateColumns:'20px 1fr 50px 50px 60px', gap:8, padding:'5px 0', borderBottom:`1px solid ${C.b1}`, alignItems:'center', fontSize:11 }}>
                                <span style={{ color:C.muted }}>{i+1}</span>
                                <span style={{ color:C.text, fontWeight:600 }}>{b.bloc}</span>
                                <span style={{ color:Number(b.pct_vu)>=70?C.green:Number(b.pct_vu)>=40?C.yellow:Number(b.pct_vu)>=15?C.orange:C.red, textAlign:'right' }}>{b.pct_vu}%</span>
                                <span style={{ color:C.dim, textAlign:'right' }}>{b.cta_totaux} CTA</span>
                                <span style={{ color:C.dim, textAlign:'right' }}>{b.avg_sec}s</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )
            }
          </div>
        )}

        {/* BLOCS */}
        {!loading && tab==='blocs' && (
          <div>
            <div style={{ display:'flex', gap:8, marginBottom:16, alignItems:'center', flexWrap:'wrap' }}>
              <span style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em' }}>Page :</span>
              {pages.map(p=>(
                <button key={p.page+p.variant} onClick={()=>setSelPage(p.page)}
                  style={{ padding:'4px 12px', background:selPage===p.page?C.purple:C.s2, border:`1px solid ${selPage===p.page?C.purple:C.b1}`, borderRadius:6, color:selPage===p.page?'#fff':C.text, fontSize:11 }}>
                  {p.page}
                </button>
              ))}
            </div>
            <div style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:12 }}>
              Corrélation bloc → conversion · <span style={{color:C.purple}}>✎ clic pour renommer</span>
            </div>
            {blocks.map(b=><BlockRow key={b.bloc_raw} b={b} notSeenCvr={notSeen[b.bloc]} onRename={handleRename}/>)}
          </div>
        )}

        {/* META */}
        {!loading && tab==='meta' && (
          <div>
            <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap' }}>
              <KPI label="Spend total"  value={`€${totalSpend.toLocaleString('fr')}`} color={C.orange}/>
              <KPI label="Clics totaux" value={metaData.reduce((a,m)=>a+Number(m.meta_clicks),0).toLocaleString('fr')} color={C.blue}/>
              <KPI label="Achats Meta"  value={metaData.reduce((a,m)=>a+Number(m.meta_purchases),0).toLocaleString('fr')} color={C.purple}/>
              <KPI label="Sessions BC"  value={metaData.reduce((a,m)=>a+Number(m.bc_sessions),0).toLocaleString('fr')} color={C.green}/>
            </div>
            <div style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:14 }}>
              Performance par landing page · Meta × Comportement réel
            </div>
            {metaData.map(m=><MetaRow key={m.page} m={m}/>)}
            {metaCamp.length>0 && (
              <>
                <div style={{ color:C.dim, fontSize:10, textTransform:'uppercase', letterSpacing:'0.07em', margin:'24px 0 12px' }}>Campagnes</div>
                {metaCamp.map((c,i)=>(
                  <div key={i} style={{ padding:'12px 16px', background:C.s2, borderRadius:10, border:`1px solid ${C.b1}`, marginBottom:6 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                      <span style={{ color:C.text, fontSize:11, flex:1, paddingRight:16 }}>{c.campaign}</span>
                      <span style={{ color:C.orange, fontWeight:700, fontSize:14, whiteSpace:'nowrap' }}>€{Number(c.spend).toLocaleString('fr')}</span>
                    </div>
                    <div style={{ display:'flex', gap:14, fontSize:10, color:C.dim }}>
                      <span>clics: <b style={{color:C.text}}>{Number(c.clics).toLocaleString('fr')}</b></span>
                      <span>achats: <b style={{color:C.purple}}>{c.achats}</b></span>
                      <span>CPC: <b style={{color:C.text}}>€{c.cpc}</b></span>
                      <span>CVR: <b style={{color:C.green}}>{c.cvr_meta}%</b></span>
                    </div>
                    <div style={{ marginTop:8, height:3, background:C.s3, borderRadius:2 }}>
                      <div style={{ height:'100%', width:`${Math.min(Number(c.spend)/metaCamp[0]?.spend*100,100)}%`, background:`linear-gradient(90deg,${C.purple},${C.blue})`, borderRadius:2 }}/>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* SOURCES */}
        {!loading && tab==='sources' && sources.map(s=>(
          <div key={s.src+s.med} style={{ padding:'12px 16px', background:C.s2, borderRadius:10, border:`1px solid ${C.b1}`, marginBottom:6 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:7 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ color:C.text, fontWeight:700, fontSize:13 }}>{s.src}</span>
                <Tag color={C.blue}>{s.med}</Tag>
              </div>
              <span style={{ color:Number(s.cvr)>3?C.green:Number(s.cvr)>1.5?C.yellow:C.red, fontWeight:700, fontSize:14 }}>{s.cvr}%</span>
            </div>
            <div style={{ display:'flex', gap:14, fontSize:10, color:C.dim, marginBottom:8 }}>
              <span>sess: <b style={{color:C.text}}>{s.n}</b></span>
              <span>conv: <b style={{color:C.green}}>{s.conv}</b></span>
              <span>rev: <b style={{color:C.orange}}>€{s.rev}</b></span>
            </div>
            <Bar value={Number(s.cvr)} max={8} color={Number(s.cvr)>3?C.green:Number(s.cvr)>1.5?C.yellow:C.red}/>
          </div>
        ))}

        {/* SESSIONS */}
        {!loading && tab==='recent' && (
          <div>
            <div style={{ display:'grid', gridTemplateColumns:'70px 70px 90px 60px 60px 60px 70px', gap:'0 12px', padding:'6px 10px', color:C.dim, fontSize:9, textTransform:'uppercase', letterSpacing:'0.06em', borderBottom:`1px solid ${C.b1}`, marginBottom:4 }}>
              <span>Heure</span><span>Page</span><span>Source</span><span>Variant</span><span>Scroll</span><span>Tps</span><span>Conv.</span>
            </div>
            {recent.map((s,i)=>(
              <div key={s.sid+i} style={{ display:'grid', gridTemplateColumns:'70px 70px 90px 60px 60px 60px 70px', gap:'0 12px', padding:'7px 10px', background:i%2===0?C.s2:'transparent', borderRadius:6, marginBottom:2, alignItems:'center', fontSize:11 }}>
                <span style={{color:C.dim}}>{String(s.collected_at).slice(11,16)}</span>
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
