/**
 * BC Tracker v3 — Auto-détection des blocs
 * 
 * MODES :
 * 1. Manuel    : data-bc-block="nom" sur les sections (le plus précis)
 * 2. Auto      : BC_AUTO=true — détecte les grandes sections automatiquement
 * 3. IA        : BC_AI=true   — envoie le DOM à Claude pour nommage intelligent
 *
 * USAGE MINIMAL (aucune config) :
 * <script>window.BC_AUTO=true</script>
 * <script src="bc-tracker.min.js" async></script>
 */
(function () {

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  var EP   = window.BC_ENDPOINT || null;
  var SID  = window.BC_SITE     || 'site';
  var DBG  = location.search.indexOf('bc_debug=1') > -1;
  var AUTO = window.BC_AUTO     !== undefined ? window.BC_AUTO : true; // auto par défaut
  var AI   = window.BC_AI       || false;

  // ── HELPERS ─────────────────────────────────────────────────────────────────
  function rand()   { return Math.random().toString(36).slice(2,10); }
  function ms()     { return Date.now() - S.t0; }
  function ls(k,v)  { try { if(v!==undefined){localStorage.setItem(k,v);return v;} return localStorage.getItem(k); } catch(e){return v;} }

  function scrollPct() {
    var h = document.documentElement;
    return h.scrollHeight-h.clientHeight > 0
      ? Math.round(h.scrollTop*100/(h.scrollHeight-h.clientHeight)) : 0;
  }

  function parentBlock(el) {
    var n = el && el.nodeType===3 ? el.parentElement : el;
    while(n && n!==document.body) {
      var b = n.getAttribute && n.getAttribute('data-bc-block');
      if(b) return b;
      n = n.parentElement;
    }
    return null;
  }

  // ── AUTO-DÉTECTION DES BLOCS ─────────────────────────────────────────────
  // Détecte automatiquement les grandes sections de la page sans aucun marquage
  function autoDetectBlocks() {
    var marked = document.querySelectorAll('[data-bc-block]');
    if(marked.length > 0) return; // Des blocs sont déjà marqués — on laisse

    // Éléments candidats (sections sémantiques ou éléments larges)
    var candidates = [];

    // 1. Balises sémantiques
    var semantic = document.querySelectorAll(
      'section, article, header, footer, main, [class*="section"], [class*="block"], [class*="row"], [class*="hero"], [class*="banner"]'
    );

    semantic.forEach(function(el) {
      var rect = el.getBoundingClientRect();
      var fullWidth = window.innerWidth;
      // Doit être large (>60% de la page) et haute (>150px)
      if(rect.width > fullWidth * 0.6 && rect.height > 150) {
        candidates.push(el);
      }
    });

    // 2. Fallback : divs larges si pas assez de candidats sémantiques
    if(candidates.length < 3) {
      var divs = document.querySelectorAll('div');
      divs.forEach(function(el) {
        var rect = el.getBoundingClientRect();
        if(rect.width > window.innerWidth * 0.7 && rect.height > 200) {
          // Vérifier que ce n'est pas déjà un enfant d'un candidat
          var isChild = candidates.some(function(c) { return c.contains(el) || el.contains(c); });
          if(!isChild) candidates.push(el);
        }
      });
    }

    // Dédupliquer (enlever les éléments parents/enfants redondants)
    var deduped = candidates.filter(function(el, i) {
      return !candidates.some(function(other, j) {
        return i !== j && other.contains(el) && el !== other;
      });
    });

    // Trier par position verticale
    deduped.sort(function(a,b) {
      return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    });

    // Assigner un nom automatique à chaque bloc
    deduped.forEach(function(el, i) {
      var name = guessBlockName(el, i);
      el.setAttribute('data-bc-block', name);
      el.setAttribute('data-bc-auto', '1'); // Marqué automatiquement
    });

    if(DBG) console.log('[BC] Auto-détection : ' + deduped.length + ' blocs trouvés', deduped.map(function(el){ return el.getAttribute('data-bc-block'); }));
  }

  // Devine un nom significatif pour un bloc
  function guessBlockName(el, index) {
    var tag  = el.tagName.toLowerCase();
    var cls  = (el.className || '').toLowerCase();
    var id   = (el.id || '').toLowerCase();
    var text = (el.innerText || '').slice(0, 100).toLowerCase();

    // Nom basé sur l'ID
    if(id && id.length < 30) return id.replace(/[^a-z0-9-]/g, '-').slice(0, 25);

    // Balise sémantique
    if(tag === 'header') return 'header';
    if(tag === 'footer') return 'footer';
    if(tag === 'main')   return 'main';

    // Classe révélatrice
    var classHints = [
      ['hero',       'hero'],
      ['banner',     'hero'],
      ['produit',    'produit'],
      ['product',    'produit'],
      ['benefit',    'benefices'],
      ['avantage',   'benefices'],
      ['feature',    'benefices'],
      ['prix',       'prix'],
      ['price',      'prix'],
      ['tarif',      'prix'],
      ['garanti',    'garantie'],
      ['guarantee',  'garantie'],
      ['avis',       'avis'],
      ['review',     'avis'],
      ['temoign',    'avis'],
      ['faq',        'faq'],
      ['cta',        'cta'],
      ['checkout',   'checkout'],
      ['panier',     'panier'],
      ['cart',       'panier'],
      ['ingredient', 'composition'],
      ['compos',     'composition'],
      ['about',      'a-propos'],
    ];

    for(var k=0; k<classHints.length; k++) {
      if(cls.indexOf(classHints[k][0]) > -1) return classHints[k][1];
    }

    // Contenu textuel
    if(text.indexOf('garanti') > -1)   return 'garantie';
    if(text.indexOf('avis') > -1)       return 'avis';
    if(text.indexOf('faq') > -1)        return 'faq';
    if(text.indexOf('€') > -1 || text.indexOf('prix') > -1) return 'prix';
    if(text.indexOf('commander') > -1 || text.indexOf('acheter') > -1) return 'cta';

    // Fallback : position ordinale
    var ordinals = ['hero','bloc-2','bloc-3','bloc-4','bloc-5','bloc-6','bloc-7','bloc-8','bloc-9','bloc-10'];
    return ordinals[index] || 'bloc-'+(index+1);
  }

  // ── MODE IA (optionnel) ──────────────────────────────────────────────────
  // Si BC_AI=true : envoie le DOM à Claude pour un nommage plus précis
  async function aiDetectBlocks() {
    if(!window.BC_AI_KEY && !window.BC_ENDPOINT) return;

    // Extraire la structure DOM légère
    var domSummary = [];
    document.querySelectorAll('[data-bc-auto]').forEach(function(el) {
      domSummary.push({
        tag:      el.tagName.toLowerCase(),
        auto_id:  el.getAttribute('data-bc-block'),
        classes:  el.className.slice(0, 80),
        text:     el.innerText.slice(0, 200),
        height:   Math.round(el.offsetHeight),
        position: Math.round(el.getBoundingClientRect().top + window.scrollY)
      });
    });

    if(domSummary.length === 0) return;

    try {
      var response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: 'Voici les blocs détectés sur une page e-commerce. Renomme chacun avec un ID court et sémantique en snake_case. Réponds UNIQUEMENT avec un objet JSON {"auto_id_original": "nouveau_nom"}.\n\n' + JSON.stringify(domSummary)
          }]
        })
      });

      var data   = await response.json();
      var text   = data.content?.[0]?.text || '{}';
      var clean  = text.replace(/```json?|```/g,'').trim();
      var renames = JSON.parse(clean);

      // Appliquer les renommages
      Object.entries(renames).forEach(function([oldId, newId]) {
        var el = document.querySelector('[data-bc-block="'+oldId+'"]');
        if(el && newId) {
          el.setAttribute('data-bc-block', newId);
          // Mettre à jour les données de session
          if(S.blocks[oldId]) {
            S.blocks[newId] = S.blocks[oldId];
            delete S.blocks[oldId];
          }
        }
      });

      if(DBG) console.log('[BC] IA a renommé les blocs :', renames);
    } catch(e) {
      if(DBG) console.warn('[BC] IA indisponible, noms auto conservés', e);
    }
  }

  // ── SESSION ─────────────────────────────────────────────────────────────────
  var S = {
    sid:0, uid:0, site:SID, url:location.href, ref:document.referrer||'',
    device: innerWidth<768?'m':innerWidth<1024?'t':'d', vw:innerWidth,
    t0: Date.now(),
    source: (function(){
      var p=new URLSearchParams(location.search);
      return { utm_source:p.get('utm_source')||'', utm_medium:p.get('utm_medium')||'',
               utm_campaign:p.get('utm_campaign')||'', gclid:p.get('gclid')?1:0, fbclid:p.get('fbclid')?1:0 };
    })(),
    blocks:{}, converted:0, revenue:0, order_id:'',
    max_scroll:0, time_ms:0, rage_clicks:0, exit_intent:0, exit_block:''
  };
  S.sid = rand();
  S.uid = ls('bc_uid') || ls('bc_uid', rand());

  function newBlock() { return {seen:0,ms:0,rank:0,returns:0,clicks:0,cta:0,selections:0,speed:0,scroll_pct:0,_t:0}; }
  function getBlock(id) { if(!S.blocks[id]) S.blocks[id]=newBlock(); return S.blocks[id]; }

  // ── PERSIST ──────────────────────────────────────────────────────────────────
  var _st;
  function save() {
    clearTimeout(_st);
    _st = setTimeout(function(){
      try {
        S.time_ms = ms();
        ls('bc:'+S.sid, JSON.stringify(S));
        var idx = JSON.parse(ls('bc:idx')||'[]');
        if(idx.indexOf(S.sid)<0){ idx.push(S.sid); if(idx.length>100) idx=idx.slice(-100); ls('bc:idx',JSON.stringify(idx)); }
      } catch(e) {}
      if(DBG) dbgRender();
    }, 500);
  }

  function flush() {
    if(!EP) return;
    S.time_ms = ms();
    try {
      var b = JSON.stringify(S);
      navigator.sendBeacon ? navigator.sendBeacon(EP,b) : fetch(EP,{method:'POST',body:b,headers:{'Content-Type':'application/json'},keepalive:true});
    } catch(e){}
  }
  setInterval(flush, 30000);

  // ── SCROLL ───────────────────────────────────────────────────────────────────
  var _sv={y:0,t:0,v:0};
  window.addEventListener('scroll',function(){
    var now=Date.now(),y=pageYOffset,dt=now-_sv.t;
    if(dt>0) _sv.v=Math.abs(y-_sv.y)/dt*1000;
    _sv.y=y; _sv.t=now;
    var p=scrollPct(); if(p>S.max_scroll){S.max_scroll=p;save();}
  },{passive:true});
  function spd(){var v=_sv.v;return v<50?0:v<200?1:v<600?2:3;}

  // ── INTERSECTION OBSERVER ────────────────────────────────────────────────────
  var _rank=0;
  function startObserving() {
    if(!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        var id=entry.target.getAttribute('data-bc-block'); if(!id) return;
        var b=getBlock(id);
        if(entry.isIntersecting){
          b.seen=1; b._t=Date.now();
          if(!b.rank){b.rank=++_rank;b.scroll_pct=scrollPct();} else {b.returns++;}
          b.speed=spd(); save();
        } else if(b._t){
          b.ms+=Date.now()-b._t; b._t=0; S.exit_block=id; save();
        }
      });
    },{threshold:0.25});

    function obs(){ document.querySelectorAll('[data-bc-block]').forEach(function(el){io.observe(el);}); }
    obs();
    if('MutationObserver' in window) new MutationObserver(obs).observe(document.body,{childList:true,subtree:true});
  }

  // ── CLICKS ────────────────────────────────────────────────────────────────────
  var _rc={};
  document.addEventListener('click',function(e){
    var bid=parentBlock(e.target);
    var tag=(e.target.tagName||'').toLowerCase();
    var cls=(e.target.className||'').toLowerCase();
    var txt=(e.target.innerText||'').toLowerCase().slice(0,40);
    if(bid){
      var b=getBlock(bid); b.clicks++;
      if(tag==='button'||(tag==='a'&&e.target.href)||cls.indexOf('btn')>-1||cls.indexOf('cta')>-1||txt.match(/acheter|commander|ajouter|essayer|profiter|découvrir|order|buy/)) b.cta++;
    }
    var zone=(e.clientX>>6)+'_'+(e.clientY>>6);
    if(!_rc[zone]) _rc[zone]={n:0,t:Date.now()};
    _rc[zone].n++;
    if(_rc[zone].n>=3&&Date.now()-_rc[zone].t<2000){S.rage_clicks++;_rc[zone]={n:0,t:Date.now()};}
    setTimeout(function(){if(_rc[zone])_rc[zone].n=0;},3000);
    save();
  });

  document.addEventListener('mouseup',function(){
    var sel=window.getSelection();
    if(sel&&sel.toString().length>8){var bid=parentBlock(sel.anchorNode);if(bid){getBlock(bid).selections++;save();}}
  });

  document.addEventListener('mouseleave',function(e){
    if(e.clientY<=0&&!S.exit_intent){S.exit_intent=1;save();}
  });

  window.addEventListener('beforeunload',function(){
    var now=Date.now();
    Object.keys(S.blocks).forEach(function(id){var b=S.blocks[id];if(b._t){b.ms+=now-b._t;b._t=0;}});
    S.time_ms=ms(); flush(); save();
  });

  // ── API ───────────────────────────────────────────────────────────────────────
  window.BC = {
    converted: function(d){S.converted=1;S.revenue=d&&d.revenue||0;S.order_id=d&&d.order_id||'';flush();save();},
    track:     function(n,d){if(!S.custom)S.custom=[];S.custom.push({n:n,t:ms(),d:d||{}});save();},
    data:      function(){ return JSON.parse(JSON.stringify(S)); },
    // Relancer l'auto-détection à la demande
    detect:    function(){ autoDetectBlocks(); startObserving(); if(AI) aiDetectBlocks(); },
    // Voir les blocs détectés sur la page
    blocks:    function(){
      var result = [];
      document.querySelectorAll('[data-bc-block]').forEach(function(el){
        result.push({ name: el.getAttribute('data-bc-block'), auto: !!el.getAttribute('data-bc-auto'), tag: el.tagName.toLowerCase(), height: el.offsetHeight });
      });
      console.table(result);
      return result;
    }
  };

  // ── INIT : AUTO-DETECT + OBSERVER ────────────────────────────────────────────
  function init() {
    if(AUTO) autoDetectBlocks();
    startObserving();
    if(AI) aiDetectBlocks();
    save();
    if(DBG) {
      console.log('%c⬡ BC Tracker v3 actif', 'color:#ff6b35;font-weight:bold;font-size:13px');
      console.log('%cBlocs détectés → BC.blocks()', 'color:#71717a');
      console.log('%cDonnées session → BC.data()', 'color:#71717a');
    }
  }

  // Attendre que le DOM soit prêt
  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── DEBUG OVERLAY ─────────────────────────────────────────────────────────────
  if(DBG) {
    var _d=null;
    function dbgInit(){
      if(_d) return;
      _d=document.createElement('div');
      _d.style.cssText='position:fixed;bottom:16px;right:16px;width:290px;max-height:460px;overflow:auto;background:#0d0d0f;color:#ccc;font:11px/1.5 monospace;padding:12px;border-radius:8px;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,.7);border:1px solid #2a2a2e';
      document.body.appendChild(_d);
    }
    function dbgRender(){
      if(!document.body) return; dbgInit();
      var h='<div style="color:#ff6b35;font-weight:700;margin-bottom:6px">⬡ BC v3'+(AUTO?' · AUTO':'')+' · '+Math.round(S.time_ms/1000)+'s</div>';
      h+='<div style="color:#555;font-size:9px;margin-bottom:8px">'+S.sid+' · '+S.device+'</div>';
      h+='<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px">';
      if(S.converted)  h+=tg('✓ CONVERTI','#4ade80');
      if(S.exit_intent) h+=tg('EXIT','#f97316');
      if(S.rage_clicks) h+=tg('RAGE×'+S.rage_clicks,'#f87171');
      h+=tg('↓'+S.max_scroll+'%','#60a5fa');
      h+='</div>';
      var bks=Object.keys(S.blocks).sort(function(a,b){return S.blocks[a].rank-S.blocks[b].rank;});
      bks.forEach(function(id){
        var b=S.blocks[id];
        var secs=((b.ms+(b._t?Date.now()-b._t:0))/1000).toFixed(1);
        var sc=['#4ade80','#86efac','#fbbf24','#f87171'][b.speed];
        var sl=['■','▸','▶','▶▶'][b.speed];
        h+='<div style="margin:3px 0;padding:5px 7px;background:#141416;border-radius:4px;border-left:2px solid '+(b.seen?'#ff6b35':'#333')+'">';
        h+='<div style="display:flex;justify-content:space-between"><b style="color:#e4e4e7">'+id+'</b><b style="color:#ff6b35">'+secs+'s</b></div>';
        h+='<div style="display:flex;gap:5px;margin-top:2px;flex-wrap:wrap">';
        h+='<span style="color:'+sc+';font-size:9px">'+sl+'</span>';
        if(b.rank)       h+=dm('#'+b.rank);
        if(b.returns)    h+=dm('↩'+b.returns);
        if(b.clicks)     h+=dm('clk×'+b.clicks);
        if(b.cta)        h+=dm('CTA','#4ade80');
        if(b.selections) h+=dm('sel×'+b.selections,'#c084fc');
        h+='</div></div>';
      });
      // Blocs non vus
      var ns=document.querySelectorAll('[data-bc-block]');
      var unseen=[].filter.call(ns,function(el){var id=el.getAttribute('data-bc-block');return!S.blocks[id]||!S.blocks[id].seen;}).map(function(el){return el.getAttribute('data-bc-block');});
      if(unseen.length) h+='<div style="color:#3f3f46;font-size:9px;margin-top:6px">Non vus: '+unseen.join(', ')+'</div>';
      _d.innerHTML=h;
    }
    function tg(t,c){return'<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:'+c+'18;color:'+c+';border:1px solid '+c+'35">'+t+'</span>';}
    function dm(t,c){return'<span style="font-size:9px;color:'+(c||'#555')+'">'+t+'</span>';}
    if(document.body) dbgInit(); else document.addEventListener('DOMContentLoaded',dbgInit);
  }

})();
