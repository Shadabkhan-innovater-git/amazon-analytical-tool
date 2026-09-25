/* ==========================================================================
   CONFIG — single source of truth for business definitions.
   Metrics, directions, dimensions, report sources, marketplaces, mapping
   synonyms and insight thresholds live here and nowhere else.
   ========================================================================== */
const Config = (() => {
  const MARKETPLACES = {
    US: { currency: 'USD', region: 'US', name: 'United States', domain: 'amazon.com' },
    CA: { currency: 'CAD', region: 'CA', name: 'Canada', domain: 'amazon.ca' },
    MX: { currency: 'MXN', region: 'MX', name: 'Mexico', domain: 'amazon.com.mx' },
    UK: { currency: 'GBP', region: 'GB', name: 'United Kingdom', domain: 'amazon.co.uk' },
    DE: { currency: 'EUR', region: 'DE', name: 'Germany', domain: 'amazon.de' },
    FR: { currency: 'EUR', region: 'FR', name: 'France', domain: 'amazon.fr' },
    IT: { currency: 'EUR', region: 'IT', name: 'Italy', domain: 'amazon.it' },
    ES: { currency: 'EUR', region: 'ES', name: 'Spain', domain: 'amazon.es' },
    IN: { currency: 'INR', region: 'IN', name: 'India', domain: 'amazon.in' },
    JP: { currency: 'JPY', region: 'JP', name: 'Japan', domain: 'amazon.co.jp' },
    AU: { currency: 'AUD', region: 'AU', name: 'Australia', domain: 'amazon.com.au' },
  };

  const AD_TYPES = { SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' };

  /* Base (stored, additive) metrics. `adTypes` = where Amazon reports it;
     rows of other ad types store null, so aggregates show N/A, never 0.
     `sources` = report grains where the metric is meaningful. */
  const BASE_METRICS = [
    { key: 'adSpend', fmt: 'currency', dir: 'neutral' },
    { key: 'adSales', fmt: 'currency', dir: 'positive' },
    { key: 'impressions', fmt: 'int', dir: 'positive' },
    { key: 'clicks', fmt: 'int', dir: 'positive' },
    { key: 'orders', fmt: 'int', dir: 'positive' },
    { key: 'units', fmt: 'int', dir: 'positive' },
    { key: 'dpv', fmt: 'int', dir: 'positive', adTypes: ['SB', 'SD'] },
    { key: 'sameSkuSales', fmt: 'currency', dir: 'positive', adTypes: ['SP'] },
    { key: 'otherSkuSales', fmt: 'currency', dir: 'neutral', adTypes: ['SP'] },
    { key: 'ntbOrders', fmt: 'int', dir: 'positive', adTypes: ['SB', 'SD'] },
    { key: 'ntbSales', fmt: 'currency', dir: 'positive', adTypes: ['SB', 'SD'] },
    { key: 'incrementalSales', fmt: 'currency', dir: 'positive' },
    { key: 'budget', fmt: 'currency', dir: 'neutral', sources: ['campaign'] },
    { key: 'reach', fmt: 'int', dir: 'positive', adTypes: ['SD'], sources: ['campaign'] },
    { key: 'videoViews', fmt: 'int', dir: 'positive', adTypes: ['SB', 'SD'] },
    { key: 'viewableImpressions', fmt: 'int', dir: 'positive', adTypes: ['SB', 'SD'] },
    { key: 'engagements', fmt: 'int', dir: 'positive', adTypes: ['SD'] },
    // impression-weighted averages (not additive)
    { key: 'tosIs', fmt: 'pct', dir: 'positive', adTypes: ['SP'], weight: 'impressions', sources: ['campaign'] },
    { key: 'searchIs', fmt: 'pct', dir: 'positive', adTypes: ['SP'], weight: 'impressions', sources: ['searchTerm'] },
  ];

  /* Derived metrics — the ONLY place formulas exist.
     a = aggregate accessor: a.s(key) sum, a.c(key, of) conditional sum of `of` where `key` present */
  const DERIVED_METRICS = [
    { key: 'ctr', fmt: 'pct', dir: 'positive', deps: ['clicks', 'impressions'], f: a => ratio(a.s('clicks'), a.s('impressions'), 100) },
    { key: 'cpc', fmt: 'currency2', dir: 'negative', deps: ['adSpend', 'clicks'], f: a => ratio(a.s('adSpend'), a.s('clicks')) },
    { key: 'cvr', fmt: 'pct', dir: 'positive', deps: ['orders', 'clicks'], f: a => ratio(a.s('orders'), a.s('clicks'), 100) },
    { key: 'acos', fmt: 'pct', dir: 'negative', deps: ['adSpend', 'adSales'], f: a => ratio(a.s('adSpend'), a.s('adSales'), 100) },
    // ROAS = Ad Sales / Ad Spend — used everywhere, never redefined.
    { key: 'roas', fmt: 'ratio', dir: 'positive', deps: ['adSales', 'adSpend'], f: a => ratio(a.s('adSales'), a.s('adSpend')) },
    { key: 'aov', fmt: 'currency2', dir: 'positive', deps: ['adSales', 'orders'], f: a => ratio(a.s('adSales'), a.s('orders')) },
    { key: 'ntbOrderRate', fmt: 'pct', dir: 'positive', deps: ['ntbOrders'], f: a => ratio(a.s('ntbOrders'), a.c('ntbOrders', 'orders'), 100) },
    { key: 'ntbSalesRate', fmt: 'pct', dir: 'positive', deps: ['ntbSales'], f: a => ratio(a.s('ntbSales'), a.c('ntbSales', 'adSales'), 100) },
    { key: 'incrementalFraction', fmt: 'pct', dir: 'positive', deps: ['incrementalSales'], f: a => ratio(a.s('incrementalSales'), a.c('incrementalSales', 'adSales'), 100) },
    { key: 'budgetUtil', fmt: 'pct', dir: 'neutral', deps: ['budget'], f: a => ratio(a.c('budget', 'adSpend'), a.s('budget'), 100) },
    { key: 'frequency', fmt: 'ratio', dir: 'neutral', deps: ['reach'], f: a => ratio(a.c('reach', 'impressions'), a.s('reach')) },
  ];
  function ratio(n, d, k = 1) { return n == null || d == null || d === 0 ? null : (n / d) * k; }

  const METRICS = {};
  BASE_METRICS.forEach((m, i) => { METRICS[m.key] = { ...m, base: true, idx: i }; });
  DERIVED_METRICS.forEach(m => { METRICS[m.key] = { ...m, base: false }; });

  /* metricDirection — consumed by the comparison renderer, never hard-coded in components */
  const metricDirection = Object.fromEntries(Object.values(METRICS).map(m => [m.key, m.dir]));

  /* Report grains. Amazon reports each grain separately; totals must come from
     one grain at a time, otherwise spend is double counted. */
  const CAMPAIGN_DIMS = ['marketplace', 'account', 'adType', 'campaignType', 'targeting', 'portfolio', 'campaign'];
  const SOURCES = {
    campaign: { dims: [...CAMPAIGN_DIMS] },
    placement: { dims: [...CAMPAIGN_DIMS, 'placement'] },
    keyword: { dims: [...CAMPAIGN_DIMS, 'keyword', 'matchType', 'keywordType'] },
    asin: { dims: [...CAMPAIGN_DIMS, 'asin', 'title', 'brand', 'category', 'asinStatus'] },
    searchTerm: { dims: [...CAMPAIGN_DIMS, 'keyword', 'matchType', 'keywordType', 'searchTerm'] },
  };
  const SOURCE_PREFERENCE = ['campaign', 'placement', 'keyword', 'asin', 'searchTerm'];
  /* A multi-level report (one file with campaign + targeting + product [+ placement] columns) is
     staged once and split into every grain its columns support; each grain reconciles to the file. */
  const MULTI = 'multi';
  const GRAIN_ID = { campaign: [], keyword: ['keyword', 'matchType'], asin: ['asin'], placement: ['placement'], searchTerm: ['searchTerm', 'keyword', 'matchType'] };
  const GRAIN_FILTER = { keyword: 'keyword', asin: 'asin', placement: 'placement', searchTerm: 'searchTerm' };
  SOURCES[MULTI] = { dims: [...new Set(Object.values(SOURCES).flatMap(s => s.dims))] };
  Object.values(SOURCES).forEach(s => s.dims.push('fileId'));

  /* Filterable dimensions (global filter state). Order = filter panel order. */
  const FILTER_DIMS = ['account', 'adType', 'portfolio', 'campaign', 'campaignType', 'targeting', 'placement',
    'keyword', 'matchType', 'keywordType', 'searchTerm', 'asin', 'brand', 'category'];

  /* Donut dimension choices (chart engine) */
  const BREAKDOWN_DIMS = ['keywordType', 'adType', 'campaignType', 'portfolio', 'brand', 'placement', 'matchType', 'targeting', 'category'];
  const BREAKDOWN_METRICS = ['adSpend', 'adSales', 'orders', 'units', 'impressions', 'clicks'];

  /* Chart palette — validated (CVD / normal-vision / lightness) for both themes */
  const PALETTE = {
    light: ['#2f7bf5', '#5b2bc0', '#0f9e86', '#e0892b', '#c8427a', '#7d8a2a'],
    dark: ['#5a9df7', '#7c4ce6', '#1fae93', '#e08d36', '#e0609a', '#98a83a'],
    other: { light: '#9aa6b6', dark: '#5f6d82' },
  };

  /* Column mapping synonyms — user-extendable in Settings. Header text is
     normalised (lower-case, alphanumerics only, attribution windows removed). */
  const FIELD_SYNONYMS = {
    date: ['date', 'day', 'startdate', 'reportdate', 'dates'],
    marketplace: ['marketplace', 'country', 'countrycode', 'market', 'saleschannel', 'region'],
    currency: ['currency', 'currencycode', 'budgetcurrency'],
    account: ['account', 'accountname', 'advertiseraccountname', 'advertiser', 'advertisername', 'profile', 'seller', 'brandentity'],
    adType: ['adtype', 'adproduct', 'campaigntype', 'program', 'sponsoredtype', 'product'],
    campaignType: ['campaignsubtype', 'campaignformat', 'adformat', 'creativetype'],
    targeting: ['targetingtype', 'campaigntargetingtype', 'targetingstrategy'],
    portfolio: ['portfolio', 'portfolioname'],
    campaign: ['campaign', 'campaignname'],
    adGroup: ['adgroup', 'adgroupname'],
    placement: ['placement', 'placementtype', 'placementclassification', 'biddingplacement'],
    keyword: ['keyword', 'targeting', 'keywordtext', 'target', 'keywordortarget', 'targetingexpression', 'keywordtargeting'],
    matchType: ['matchtype', 'keywordmatchtype', 'matchtypetarget', 'targetingmatchtype'],
    searchTerm: ['customersearchterm', 'searchterm', 'query', 'searchquery'],
    asin: ['asin', 'advertisedasin', 'purchasedasin', 'productasin', 'childasin'],
    sku: ['sku', 'advertisedsku', 'merchantsku', 'advertisedproductsku', 'productsku'],
    title: ['producttitle', 'title', 'productname', 'itemname'],
    brand: ['brand', 'brandname'],
    category: ['category', 'productcategory', 'productgroup', 'browsenode'],
    asinStatus: ['asinstatus', 'listingstatus', 'productstatus', 'availability'],
    entity: ['entity', 'recordtype'],
    adSpend: ['spend', 'adspend', 'cost', 'totalcost', 'spendamount'],
    adSales: ['sales', 'adsales', 'attributedsales', 'totalsales', 'totaladsales', 'attributedsales14d', 'sales14d'],
    impressions: ['impressions', 'impr', 'totalimpressions'],
    clicks: ['clicks', 'totalclicks'],
    orders: ['orders', 'totalorders', 'attributedconversions', 'purchases', 'conversions'],
    units: ['units', 'unitssold', 'totalunits', 'unitsordered', 'attributedunitsordered'],
    dpv: ['detailpageviews', 'dpv', 'detailpageviewsdpv'],
    sameSkuSales: ['advertisedskusales', 'sameskusales', 'attributedsalessamesku', 'salesamesku', 'advertisedasinsales'],
    otherSkuSales: ['otherskusales', 'othersales', 'brandhalosales', 'otherasinsales'],
    ntbOrders: ['newtobrandorders', 'ntborders', 'newtobrandpurchases'],
    ntbSales: ['newtobrandsales', 'ntbsales'],
    incrementalSales: ['incrementalsales', 'estimatedincrementalsales'],
    budget: ['budget', 'dailybudget', 'campaignbudget', 'budgetamount'],
    reach: ['reach', 'uniquereach', 'cumulativereach'],
    videoViews: ['videoviews', 'videocompleteviews', 'videostarts'],
    viewableImpressions: ['viewableimpressions', 'vcpmimpressions'],
    engagements: ['engagements', 'totalengagements', 'brandedsearches'],
    tosIs: ['topofsearchimpressionshare', 'topofsearchis', 'tosis', 'topofsearchimpressionsharepercent'],
    searchIs: ['searchtermimpressionshare', 'searchimpressionshare', 'impressionshare'],
  };
  /* Columns Amazon exports that we recompute rather than import */
  const RECALCULATED = ['purchaserateoverclicks', 'clickthrurate', 'ctr', 'costperclick', 'cpc', 'conversionrate', 'cvr', 'advertisingcostofsales',
    'acos', 'returnonadvertisingspend', 'roas', 'totaladvertisingcostofsalesacos', 'totalreturnonadvertisingspendroas'];
  const DIM_FIELDS = ['date', 'marketplace', 'currency', 'account', 'adType', 'campaignType', 'targeting', 'portfolio', 'campaign',
    'adGroup', 'placement', 'keyword', 'matchType', 'searchTerm', 'asin', 'sku', 'title', 'brand', 'category', 'asinStatus', 'entity'];
  const REQUIRED_FIELDS = ['date', 'campaign', 'adSpend'];
  const RECOMMENDED_FIELDS = ['adSales', 'impressions', 'clicks', 'orders'];

  /* Insight thresholds — tunable without touching the engine */
  const INSIGHTS = {
    minChangePct: 2,          // ignore movements smaller than this
    concentrationPct: 40,     // single entity share considered concentrated
    lowRoasFactor: 0.6,       // ROAS below 60% of account average = low
    highRoasFactor: 1.3,      // ROAS above 130% of account average = high
    minSpendSharePct: 3,      // entity must hold ≥3% spend to be called out as a problem
    lowSpendSharePct: 5,      // opportunity = high ROAS with <5% spend share
    placementShiftPp: 2,      // share change (percentage points) that counts as a shift
    wastedSpendMinClicks: 15, // search term with ≥15 clicks and zero orders
  };

  const ROLES = {
    admin: { import: true, export: true, settings: true, allAccounts: true },
    manager: { import: true, export: true, settings: false, allAccounts: false },
    analyst: { import: false, export: true, settings: false, allAccounts: true },
    viewer: { import: false, export: false, settings: false, allAccounts: true },
  };

  const LANGS = { en: 'English', hi: 'हिन्दी', fr: 'Français', de: 'Deutsch', es: 'Español', pt: 'Português', ja: '日本語' };
  const LANG_DEFAULT_REGION = { en: null, hi: 'IN', fr: 'FR', de: 'DE', es: 'ES', pt: 'BR', ja: 'JP' };

  return { MULTI, GRAIN_ID, GRAIN_FILTER, MARKETPLACES, AD_TYPES, BASE_METRICS, METRICS, metricDirection, SOURCES, SOURCE_PREFERENCE, FILTER_DIMS,
    BREAKDOWN_DIMS, BREAKDOWN_METRICS, PALETTE, FIELD_SYNONYMS, RECALCULATED, DIM_FIELDS, REQUIRED_FIELDS,
    RECOMMENDED_FIELDS, INSIGHTS, ROLES, LANGS, LANG_DEFAULT_REGION, ratio };
})();
