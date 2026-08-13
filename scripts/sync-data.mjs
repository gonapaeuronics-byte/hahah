#!/usr/bin/env node
/**
 * Euronics Digital Command Centre — Daily Data Sync
 * ══════════════════════════════════════════════════
 * Runs on a schedule (GitHub Actions cron, 11:00 AM IST) and:
 *   1. Fetches missing days for every connector from TMR
 *   2. Merges into data/bank.json, prunes to a 95-day rolling window
 *   3. Pre-generates the 4 AI insight variants per tab
 *   4. Records per-connector stale/failure flags instead of crashing the whole run
 *
 * TMR data fetching uses the direct TMR API when TMR_AUTH_MODE=tmr_direct.
 */

import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(__dirname, '..', 'data', 'bank.json');

const AUTH_MODE = process.env.TMR_AUTH_MODE || 'anthropic_mcp';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TMR_API_KEY = process.env.TMR_API_KEY;
const TMR_TEAM_ID = '019f5adf-e428-7780-b26e-9a2ba16ad4f8';
const MAX_WINDOW_DAYS = 95;

// ── Connector definitions — mirrors the dashboard's catchUpSync() query exactly ──
const CONNECTORS = [
  {
    key: 'seller',
    connectorId: 'amazonseller',
    accountId: 'A150QQTOQF8MPC_A21TJRUUN4KGV',
    metrics: [
      'ordered_product_sales_amount',
      'order_count',
      'sessions',
      'unit_session_percentage',
      'page_views',
      'units_ordered_b_2_b',
      'ordered_product_sales_b_2_b_amount',
      'units_refunded',
      'refund_rate'
    ]
  },

  {
    key: 'amz',
    connectorId: 'amazonads',
    accountId: '1403183161385252-IN',
    currency: 'INR',
    metrics: [
      'cost',
      'total_sales',
      'total_purchases',
      'impressions',
      'clicks',
      'advertising_cost_of_sales',
      'return_on_ad_spend'
    ]
  },

  {
    key: 'gads',
    connectorId: 'gadw',
    accountId: '2186126678',
    currency: 'INR',
    metrics: [
      'metrics_cost_micros',
      'metrics_clicks',
      'metrics_impressions',
      'metrics_ctr',
      'metrics_conversions',
      'metrics_cost_per_conversion',
      'metrics_average_cpc',
      'metrics_all_conversions',
      'metrics_conversions_value',
      'roas_calc_conversions'
    ]
  },

  {
    key: 'meta',
    connectorId: 'fads',
    accountId: 'act_2793310755803',
    currency: 'INR',
    metrics: [
      'spend',
      'impressions',
      'clicks',
      'reach',
      'ctr',
      'cpc',
      'frequency',
      'unique_clicks',
      'cost_per_unique_click',
      'cpp',
      'custom_pixel_conversion_2793310755803_1143250729040220',
      'custom_cost_pixel_conversion_2793310755803_1143250729040220',
      'all_purchases',
      'purchase_conversions_all',
      'purchase_roas_all'
    ]
  },

  {
    key: 'gsc_daily',
    connectorId: 'gsc',
    accountId: 'https://euronics.co.in/',
    metrics: [
      'clicks',
      'impressions',
      'ctr',
      'position'
    ]
  },

  {
    key: 'ins',
    connectorId: 'ins',
    accountId: '17841407430637862',
    metrics: [
      'account_reach'
    ]
  },

  {
    key: 'shopify',
    connectorId: 'shopify',
    accountId: 'euronics-india',
    metrics: [
      'gross_sales_amount',
      'orders'
    ]
  },

  {
    key: 'lps',
    connectorId: 'lps',
    accountId: '527337',
    metrics: [
      'impressions',
      'engagements',
      'reach',
      'engagement_rate',
      'followers_gain_total',
      'clicks'
    ]
  },

  {
    key: 'lads',
    connectorId: 'lads',
    accountId: '515314368',
    metrics: [
      'costInLocalCurrency',
      'impressions',
      'clicks',
      'approximateUniqueImpressions',
      'landingPageClicks',
      'externalWebsiteConversions'
    ]
  }

  // GA4 intentionally excluded.
  // Re-add once a valid GA4 account ID is confirmed and reconnected.
];

// ── Date helpers ──

const fmtDate = d => d.toISOString().split('T')[0];

const addDays = (d, n) => {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
};

const today = new Date();
const yesterday = addDays(today, -1);

// ── Load existing bank ──

function loadBank() {
  return readFile(BANK_PATH, 'utf8').then(JSON.parse);
}

// ── TMR fetch: Anthropic MCP fallback mode ──

async function fetchViaAnthropicMcp(connector, startStr, endStr) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set');
  }

  const query = {
    dateRange: {
      startDate: startStr,
      endDate: endStr
    },
    dimensions: ['date'],
    metrics: connector.metrics,
    sort: [
      {
        sortField: 'date',
        direction: 'asc'
      }
    ]
  };

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,

    mcp_servers: [
      {
        type: 'url',
        url: 'https://mcp.twominutereports.com/mcp',
        name: 'tmr'
      }
    ],

    system:
      'You are a data assistant. Call the run_query MCP tool with the exact parameters given and return ONLY the raw JSON result. No explanation, no markdown, no code fences.',

    messages: [
      {
        role: 'user',
        content:
          `Call run_query with teamId="${TMR_TEAM_ID}", connectors=[{connectorId:"${connector.connectorId}",accountIds:["${connector.accountId}"]${connector.currency ? `,currencyCode:"${connector.currency}"` : ''},queries:[{query:${JSON.stringify(query)},title:"result"}]}]. Return only the JSON.`
      }
    ]
  };

  const res = await fetch(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },

      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    throw new Error(
      `Anthropic API ${res.status}: ${await res.text()}`
    );
  }

  const data = await res.json();

  let raw = '';

  for (const block of data.content || []) {
    const text =
      block.type === 'mcp_tool_result'
        ? (block.content?.[0]?.text || '')
        : (block.type === 'text' ? block.text : '');

    if (text && text.includes('connectorResults')) {
      raw = text;
      break;
    }
  }

  if (!raw) {
    throw new Error('No connectorResults found in response');
  }

  const fence = '```';

  let clean = raw;
  let fi = clean.indexOf(fence);

  while (fi !== -1) {
    const fe = clean.indexOf('\n', fi);

    clean =
      clean.slice(0, fi) +
      (fe !== -1 ? clean.slice(fe + 1) : '');

    fi = clean.indexOf(fence);
  }

  const j0 = clean.indexOf('{');
  const j1 = clean.lastIndexOf('}');

  const parsed = JSON.parse(
    clean.slice(j0, j1 + 1)
  );

  const rows =
    parsed.connectorResults?.[0]?.results?.[0]?.data?.rows || [];

  return rows;
}

// ── TMR fetch: DIRECT API ──

async function fetchViaTmrDirect(
  connector,
  startStr,
  endStr
) {
  if (!TMR_API_KEY) {
    throw new Error('TMR_API_KEY not set');
  }

  /*
   * TMR's API expects account IDs with the connector prefix.
   *
   * Example:
   *   gadw + 2186126678
   * becomes:
   *   gadw_2186126678
   */

  const accountId =
    connector.accountId.startsWith(
      `${connector.connectorId}_`
    )
      ? connector.accountId
      : `${connector.connectorId}_${connector.accountId}`;

  const res = await fetch(
    `https://api.twominutereports.com/v1/teams/${TMR_TEAM_ID}/data/run-query`,
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TMR_API_KEY}`
      },

      body: JSON.stringify({
        accounts: [accountId],

        dimensions: [
          'date'
        ],

        metrics: connector.metrics,

        dateRange: {
          startDate: startStr,
          endDate: endStr
        },

        sort: [
          {
            fieldId: 'date',
            direction: 'asc'
          }
        ]
      })
    }
  );

  if (!res.ok) {
    throw new Error(
      `TMR API ${res.status}: ${await res.text()}`
    );
  }

  const response = await res.json();

  if (!response.success) {
    throw new Error(
      `TMR query failed: ${JSON.stringify(
        response.error || response
      )}`
    );
  }

  /*
   * TMR returns:
   *
   * {
   *   success: true,
   *   data: [
   *     {
   *       date: "2026-08-12",
   *       cost: 123,
   *       clicks: 45
   *     }
   *   ]
   * }
   *
   * The dashboard expects:
   *
   * [
   *   ["2026-08-12", 123, 45]
   * ]
   */

  return (response.data || []).map(row => [
    row.date,
    ...connector.metrics.map(
      metric => row[metric] ?? 0
    )
  ]);
}

// ── Choose TMR authentication path ──

async function fetchConnector(
  connector,
  startStr,
  endStr
) {
  return AUTH_MODE === 'tmr_direct'
    ? fetchViaTmrDirect(
        connector,
        startStr,
        endStr
      )
    : fetchViaAnthropicMcp(
        connector,
        startStr,
        endStr
      );
}

// ── Merge + prune ──

function mergeRows(
  existing,
  incoming
) {
  const byDate = new Map(
    existing.map(r => [r[0], r])
  );

  for (const row of incoming) {
    byDate.set(row[0], row);
  }

  const merged =
    Array.from(byDate.values()).sort(
      (a, b) => (a[0] > b[0] ? 1 : -1)
    );

  return merged.slice(-MAX_WINDOW_DAYS);
}

// ── AI insight pre-generation ──

const AI_PROMPTS = {
  analyse: ctx =>
    `Euronics Industries (B2B washroom hygiene: hand dryers, sensor taps, soap dispensers, air curtains, India). 3-sentence performance analysis with numbers.\n\n${ctx}\n\nMax 80 words. No bullets.`,

  working: ctx =>
    `Euronics Industries. TOP 3 THINGS WORKING:\n1.\n2.\n3.\n\n${ctx}\nMax 20 words each. Specific numbers.`,

  notworking: ctx =>
    `Euronics Industries. TOP 3 NOT WORKING:\n1.\n2.\n3.\n\n${ctx}\nMax 20 words each.`,

  improve: ctx =>
    `Euronics Industries. TOP 3 ACTIONS TO IMPROVE:\n1.\n2.\n3.\n\n${ctx}\nMax 25 words each. Actionable.`
};

async function generateInsight(prompt) {
  if (!ANTHROPIC_API_KEY) {
    return null;
  }

  const res = await fetch(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },

      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,

        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    }
  );

  if (!res.ok) {
    return null;
  }

  const data = await res.json();

  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// ── Build AI contexts ──

function buildContexts(bank) {
  const sum = (rows, i) =>
    rows.reduce(
      (s, r) => s + (+r[i] || 0),
      0
    );

  const last30 = arr =>
    arr.slice(-30);

  const ctx = {};

  const amz =
    last30(bank.amz || []);

  ctx.amazon =
    `Amazon Ads (30d): Spend ₹${sum(amz, 1).toFixed(0)}, Sales ₹${sum(amz, 2).toFixed(0)}, Orders ${sum(amz, 3)}.`;

  const gads =
    last30(bank.gads || []);

  ctx.gads =
    `Google Ads / lead-gen (30d): Spend ₹${sum(gads, 1).toFixed(0)}, Leads ${sum(gads, 5).toFixed(1)}, Clicks ${sum(gads, 2)}.`;

  const meta =
    last30(bank.meta || []);

  ctx.meta =
    `Meta Ads / performance (30d): Spend ₹${sum(meta, 1).toFixed(0)}, Inquiries ${sum(meta, 11)}, Purchases ${sum(meta, 13)} worth ₹${sum(meta, 14).toFixed(0)}.`;

  const seller =
    last30(bank.seller || []);

  ctx.seller =
    `Amazon Marketplace (30d): Sales ₹${sum(seller, 1).toFixed(0)}, Orders ${sum(seller, 2)}, B2B sales ₹${sum(seller, 7).toFixed(0)}.`;

  const shop =
    last30(bank.shopify || []);

  ctx.shopify =
    `Shopify (30d): Revenue ₹${sum(shop, 1).toFixed(0)}, Orders ${sum(shop, 2)}.`;

  const gsc =
    last30(bank.gsc_daily || []);

  ctx.gsc =
    `Search Console (30d): Clicks ${sum(gsc, 1)}, Impressions ${sum(gsc, 2)}.`;

  const ins =
    last30(bank.ins || []);

  ctx.ins =
    `Instagram (30d): Reach ${sum(ins, 1)}.`;

  const lps =
    last30(bank.lps || []);

  ctx.lps =
    `LinkedIn Organic (30d): Impressions ${sum(lps, 1)}, Engagements ${sum(lps, 2)}.`;

  const lads =
    last30(bank.lads || []);

  ctx.lads =
    `LinkedIn Ads (30d): Spend ₹${sum(lads, 1).toFixed(0)}, Clicks ${sum(lads, 2)}.`;

  const fba =
    bank.fba_inventory || [];

  ctx.fba =
    `FBA inventory (live): ${fba.length} active SKUs, ${sum(fba, 3)} fulfillable units.`;

  return ctx;
}

// ── Generate all AI insights ──

async function generateAllInsights(bank) {
  const contexts =
    buildContexts(bank);

  const insights = {};

  for (const [tab, ctx] of Object.entries(contexts)) {
    insights[tab] = {};

    for (
      const [type, promptFn]
      of Object.entries(AI_PROMPTS)
    ) {
      try {
        insights[tab][type] =
          await generateInsight(
            promptFn(ctx)
          );
      } catch (e) {
        insights[tab][type] = null;

        console.warn(
          `AI insight failed for ${tab}/${type}:`,
          e.message
        );
      }
    }
  }

  return insights;
}

// ── Main ──

async function main() {
  console.log(
    `Sync starting. AUTH_MODE=${AUTH_MODE}. Window: through ${fmtDate(yesterday)}`
  );

  const bank =
    await loadBank();

  bank.syncLog =
    bank.syncLog || [];

  const runLog = {
    runAt: new Date().toISOString(),
    results: {}
  };

  for (const connector of CONNECTORS) {
    const existing =
      bank[connector.key] || [];

    const lastDate =
      existing.length
        ? existing[existing.length - 1][0]
        : fmtDate(
            addDays(
              yesterday,
              -MAX_WINDOW_DAYS
            )
          );

    const start =
      addDays(
        new Date(
          lastDate + 'T00:00:00'
        ),
        1
      );

    if (start > yesterday) {
      runLog.results[
        connector.key
      ] = 'up-to-date';

      continue;
    }

    try {
      const rows =
        await fetchConnector(
          connector,
          fmtDate(start),
          fmtDate(yesterday)
        );

      bank[connector.key] =
        mergeRows(
          existing,
          rows
        );

      runLog.results[
        connector.key
      ] = `+${rows.length} rows`;

      console.log(
        `✅ ${connector.key}: +${rows.length} rows`
      );

    } catch (e) {
      runLog.results[
        connector.key
      ] = `FAILED: ${e.message}`;

      console.error(
        `❌ ${connector.key} failed:`,
        e.message
      );

      // Leave existing data as-is.
    }
  }

  // GA4 stays flagged stale until reconnected.
  bank.ga4_stale = true;

  bank.ga4_stale_reason =
    bank.ga4_stale_reason ||
    "TMR account 350385395 (euronics.co.in GA4 property) is no longer in the team's connected accounts list.";

  bank.last_sync =
    new Date().toISOString();

  bank.BANK_MIN_DATE =
    bank.seller?.[0]?.[0] || null;

  bank.BANK_MAX_DATE =
    fmtDate(yesterday);

  // AI insights are generated server-side.
  // They are NOT required for the TMR data sync.
  if (
    process.env.SKIP_AI_INSIGHTS !== 'true'
  ) {
    console.log(
      'Generating AI insights...'
    );

    bank.aiInsights =
      await generateAllInsights(
        bank
      );

    bank.aiInsightsGeneratedAt =
      new Date().toISOString();
  }

  bank.syncLog =
    [
      runLog,
      ...bank.syncLog
    ].slice(0, 30);

  await writeFile(
    BANK_PATH,
    JSON.stringify(bank),
    'utf8'
  );

  console.log(
    '✅ bank.json updated:',
    BANK_PATH
  );

  console.log(
    JSON.stringify(
      runLog,
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(
    'Sync failed fatally:',
    e
  );

  process.exit(1);
});
