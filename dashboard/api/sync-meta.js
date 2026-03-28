/**
 * BC Tracker — Meta Ads Sync
 * Vercel API Route : /api/sync-meta
 * 
 * Appelle l'API Meta Graph et insère les données dans ClickHouse
 * Configurer en cron Vercel : toutes les nuits à 2h
 * 
 * Variables d'env nécessaires :
 * META_ACCESS_TOKEN=...
 * META_ACCOUNT_ID=act_248534332859504
 * CH_HOST=https://iofse68zg7.europe-west4.gcp.clickhouse.cloud:8443
 * CH_USER=default
 * CH_PASSWORD=...
 * CH_DB=bc_tracker
 */

const META_API = 'https://graph.facebook.com/v19.0';

// ── MAPPING URL → page ID ─────────────────────────────────────────────────
// Traduit les URLs des landing pages Meta en noms courts pour ClickHouse
function urlToPageId(url) {
  if (!url) return 'unknown';
  try {
    const path = new URL(url).pathname
      .replace(/^\/|\/$/g, '')
      .replace(/\//g, '-')
      || 'home';
    return path.toLowerCase().slice(0, 64);
  } catch(e) {
    return 'unknown';
  }
}

// ── APPEL API META ────────────────────────────────────────────────────────
async function fetchMetaInsights(accountId, token, dateStart, dateStop) {
  const fields = [
    'campaign_name',
    'adset_name', 
    'ad_name',
    'spend',
    'clicks',
    'impressions',
    'cpc',
    'ctr',
    'actions',
    'cost_per_action_type',
    'website_purchase_roas',
  ].join(',');

  // Level : ad pour avoir l'URL de destination
  const params = new URLSearchParams({
    level:       'ad',
    fields:      fields + ',creative{object_story_spec}',
    time_range:  JSON.stringify({ since: dateStart, until: dateStop }),
    limit:       '500',
    access_token: token,
  });

  const url = `${META_API}/${accountId}/insights?${params}`;
  const res = await fetch(url);
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Meta API error: ${err}`);
  }
  
  const data = await res.json();
  
  if (data.error) {
    throw new Error(`Meta API error: ${data.error.message}`);
  }
  
  // Paginer si nécessaire
  let rows = data.data || [];
  let cursor = data.paging?.cursors?.after;
  
  while (cursor && rows.length < 5000) {
    const nextParams = new URLSearchParams({
      ...Object.fromEntries(params),
      after: cursor,
    });
    const nextRes = await fetch(`${META_API}/${accountId}/insights?${nextParams}`);
    const nextData = await nextRes.json();
    rows = rows.concat(nextData.data || []);
    cursor = nextData.paging?.cursors?.after;
    if (!nextData.paging?.next) break;
  }
  
  return rows;
}

// ── PARSER LES ACTIONS ────────────────────────────────────────────────────
function getAction(actions, actionType) {
  if (!actions) return 0;
  const action = actions.find(a => a.action_type === actionType);
  return action ? parseInt(action.value) || 0 : 0;
}

function getActionValue(costPerAction, actionType) {
  if (!costPerAction) return 0;
  const action = costPerAction.find(a => a.action_type === actionType);
  return action ? parseFloat(action.value) || 0 : 0;
}

// ── RÉCUPÉRER L'URL DE DESTINATION ────────────────────────────────────────
async function getAdDestinationUrl(adId, token) {
  try {
    const res = await fetch(
      `${META_API}/${adId}?fields=creative{object_story_spec,effective_object_story_id}&access_token=${token}`
    );
    const data = await res.json();
    
    // Chercher l'URL dans le creative
    const spec = data.creative?.object_story_spec;
    if (spec?.link_data?.link) return spec.link_data.link;
    if (spec?.video_data?.call_to_action?.value?.link) return spec.video_data.call_to_action.value.link;
    
    return null;
  } catch(e) {
    return null;
  }
}

// ── INSÉRER DANS CLICKHOUSE ───────────────────────────────────────────────
async function insertToClickHouse(rows, env) {
  if (rows.length === 0) return;
  
  const { CH_HOST, CH_USER, CH_PASSWORD, CH_DB } = env;
  
  // Construire le batch d'inserts
  const jsonRows = rows.map(r => JSON.stringify(r)).join('\n');
  const query = `INSERT INTO ${CH_DB}.meta_ads FORMAT JSONEachRow`;
  
  const res = await fetch(`${CH_HOST}/?query=${encodeURIComponent(query)}`, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': CH_USER,
      'X-ClickHouse-Key':  CH_PASSWORD,
      'Content-Type':      'application/json',
    },
    body: jsonRows,
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ClickHouse insert error: ${err}`);
  }
  
  return rows.length;
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  
  // Sécurité : vérifier le token cron
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const env = {
    META_TOKEN:  process.env.META_ACCESS_TOKEN,
    META_ACCOUNT: process.env.META_ACCOUNT_ID || 'act_248534332859504',
    CH_HOST:     process.env.CH_HOST,
    CH_USER:     process.env.CH_USER || 'default',
    CH_PASSWORD: process.env.CH_PASSWORD,
    CH_DB:       process.env.CH_DB || 'bc_tracker',
  };
  
  // Par défaut : synchroniser les 7 derniers jours
  const days = parseInt(req.query.days) || 7;
  const today = new Date();
  const dateStop  = today.toISOString().slice(0, 10);
  const dateStart = new Date(today - days * 86400000).toISOString().slice(0, 10);
  
  console.log(`[Meta Sync] ${dateStart} → ${dateStop}`);
  
  try {
    // 1. Récupérer les insights Meta
    const insights = await fetchMetaInsights(
      env.META_ACCOUNT,
      env.META_TOKEN,
      dateStart,
      dateStop
    );
    
    console.log(`[Meta Sync] ${insights.length} lignes récupérées`);
    
    // 2. Transformer les données
    const rows = [];
    
    for (const insight of insights) {
      // Récupérer l'URL de destination pour mapper sur la landing page
      let destinationUrl = null;
      if (insight.ad_id) {
        destinationUrl = await getAdDestinationUrl(insight.ad_id, env.META_TOKEN);
      }
      
      const purchases     = getAction(insight.actions, 'purchase');
      const addToCart     = getAction(insight.actions, 'add_to_cart');
      const initiateCheckout = getAction(insight.actions, 'initiate_checkout');
      const costPerPurchase  = getActionValue(insight.cost_per_action_type, 'purchase');
      
      rows.push({
        site:              'wespring',
        date:              insight.date_start,
        page:              urlToPageId(destinationUrl),
        destination_url:   destinationUrl || '',
        campaign:          insight.campaign_name || '',
        adset:             insight.adset_name || '',
        ad_name:           insight.ad_name || '',
        ad_id:             insight.ad_id || '',
        spend:             parseFloat(insight.spend) || 0,
        clicks:            parseInt(insight.clicks) || 0,
        impressions:       parseInt(insight.impressions) || 0,
        cpc:               parseFloat(insight.cpc) || 0,
        ctr:               parseFloat(insight.ctr) || 0,
        purchases:         purchases,
        add_to_cart:       addToCart,
        initiate_checkout: initiateCheckout,
        cac:               costPerPurchase,
        cvr_meta:          insight.clicks > 0 ? purchases / parseInt(insight.clicks) * 100 : 0,
      });
    }
    
    // 3. Insérer dans ClickHouse par batch de 100
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      inserted += await insertToClickHouse(batch, env);
    }
    
    console.log(`[Meta Sync] ${inserted} lignes insérées dans ClickHouse`);
    
    return res.status(200).json({
      ok:       true,
      period:   `${dateStart} → ${dateStop}`,
      insights: insights.length,
      inserted: inserted,
    });
    
  } catch(err) {
    console.error('[Meta Sync] Erreur:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
