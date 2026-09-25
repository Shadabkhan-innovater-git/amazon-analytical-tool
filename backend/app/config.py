"""Business definitions shared by the import pipeline and the reporting API.

Mirrors frontend/lib/config.js so the browser and the server agree on
metric names, report grains and column-mapping synonyms.
"""

MARKETPLACES = {
    "US": {"currency": "USD", "name": "United States", "domain": "amazon.com"},
    "CA": {"currency": "CAD", "name": "Canada", "domain": "amazon.ca"},
    "MX": {"currency": "MXN", "name": "Mexico", "domain": "amazon.com.mx"},
    "UK": {"currency": "GBP", "name": "United Kingdom", "domain": "amazon.co.uk"},
    "DE": {"currency": "EUR", "name": "Germany", "domain": "amazon.de"},
    "FR": {"currency": "EUR", "name": "France", "domain": "amazon.fr"},
    "IT": {"currency": "EUR", "name": "Italy", "domain": "amazon.it"},
    "ES": {"currency": "EUR", "name": "Spain", "domain": "amazon.es"},
    "IN": {"currency": "INR", "name": "India", "domain": "amazon.in"},
    "JP": {"currency": "JPY", "name": "Japan", "domain": "amazon.co.jp"},
    "AU": {"currency": "AUD", "name": "Australia", "domain": "amazon.com.au"},
}

# Base (stored, additive) metrics. ad_types = where Amazon reports the metric.
BASE_METRICS = [
    {"key": "adSpend", "fmt": "currency"},
    {"key": "adSales", "fmt": "currency"},
    {"key": "impressions", "fmt": "int"},
    {"key": "clicks", "fmt": "int"},
    {"key": "orders", "fmt": "int"},
    {"key": "units", "fmt": "int"},
    {"key": "dpv", "fmt": "int", "ad_types": ["SB", "SD"]},
    {"key": "sameSkuSales", "fmt": "currency", "ad_types": ["SP"]},
    {"key": "otherSkuSales", "fmt": "currency", "ad_types": ["SP"]},
    {"key": "ntbOrders", "fmt": "int", "ad_types": ["SB", "SD"]},
    {"key": "ntbSales", "fmt": "currency", "ad_types": ["SB", "SD"]},
    {"key": "incrementalSales", "fmt": "currency"},
    {"key": "budget", "fmt": "currency"},
    {"key": "reach", "fmt": "int", "ad_types": ["SD"]},
    {"key": "videoViews", "fmt": "int", "ad_types": ["SB", "SD"]},
    {"key": "viewableImpressions", "fmt": "int", "ad_types": ["SB", "SD"]},
    {"key": "engagements", "fmt": "int", "ad_types": ["SD"]},
    {"key": "tosIs", "fmt": "pct", "ad_types": ["SP"]},
    {"key": "searchIs", "fmt": "pct", "ad_types": ["SP"]},
]
METRIC_KEYS = [m["key"] for m in BASE_METRICS]

CAMPAIGN_DIMS = ["marketplace", "account", "adType", "campaignType", "targeting", "portfolio", "campaign"]
SOURCES = {
    "campaign": CAMPAIGN_DIMS,
    "placement": CAMPAIGN_DIMS + ["placement"],
    "keyword": CAMPAIGN_DIMS + ["keyword", "matchType", "keywordType"],
    "asin": CAMPAIGN_DIMS + ["asin", "title", "brand", "category", "asinStatus"],
    "searchTerm": CAMPAIGN_DIMS + ["keyword", "matchType", "keywordType", "searchTerm"],
}
ALL_DIMS = sorted({d for dims in SOURCES.values() for d in dims})
# A multi-level report (e.g. Amazon's "Performance by Campaign" with product + targeting + placement
# columns) is imported once and split into every grain its columns support.
MULTI = "multi"
GRAIN_KEYS = {"keyword": "keyword", "asin": "asin", "placement": "placement", "searchTerm": "searchTerm"}

FIELD_SYNONYMS = {
    "date": ["date", "day", "startdate", "reportdate", "dates"],
    "marketplace": ["marketplace", "country", "countrycode", "market", "saleschannel", "region"],
    "currency": ["currency", "currencycode", "budgetcurrency"],
    "account": ["account", "accountname", "advertiseraccountname", "advertiser", "advertisername", "profile", "seller", "brandentity"],
    "adType": ["adtype", "adproduct", "campaigntype", "program", "sponsoredtype", "product"],
    "campaignType": ["campaignsubtype", "campaignformat", "adformat", "creativetype"],
    "targeting": ["targetingtype", "campaigntargetingtype", "targetingstrategy"],
    "portfolio": ["portfolio", "portfolioname"],
    "campaign": ["campaign", "campaignname"],
    "adGroup": ["adgroup", "adgroupname"],
    "placement": ["placement", "placementtype", "placementclassification", "biddingplacement"],
    "keyword": ["keyword", "targeting", "keywordtext", "target", "keywordortarget", "targetingexpression", "keywordtargeting"],
    "matchType": ["matchtype", "keywordmatchtype", "matchtypetarget", "targetingmatchtype"],
    "searchTerm": ["customersearchterm", "searchterm", "query", "searchquery"],
    "asin": ["asin", "advertisedasin", "purchasedasin", "productasin", "childasin"],
    "sku": ["sku", "advertisedsku", "merchantsku", "advertisedproductsku", "productsku"],
    "title": ["producttitle", "title", "productname", "itemname"],
    "brand": ["brand", "brandname"],
    "category": ["category", "productcategory", "productgroup", "browsenode"],
    "asinStatus": ["asinstatus", "listingstatus", "productstatus", "availability"],
    "entity": ["entity", "recordtype"],
    "adSpend": ["spend", "adspend", "cost", "totalcost", "spendamount"],
    "adSales": ["sales", "adsales", "attributedsales", "totalsales", "totaladsales", "attributedsales14d", "sales14d"],
    "impressions": ["impressions", "impr", "totalimpressions"],
    "clicks": ["clicks", "totalclicks"],
    "orders": ["orders", "totalorders", "attributedconversions", "purchases", "conversions"],
    "units": ["units", "unitssold", "totalunits", "unitsordered", "attributedunitsordered"],
    "dpv": ["detailpageviews", "dpv", "detailpageviewsdpv"],
    "sameSkuSales": ["advertisedskusales", "sameskusales", "attributedsalessamesku", "salesamesku", "advertisedasinsales"],
    "otherSkuSales": ["otherskusales", "othersales", "brandhalosales", "otherasinsales"],
    "ntbOrders": ["newtobrandorders", "ntborders", "newtobrandpurchases"],
    "ntbSales": ["newtobrandsales", "ntbsales"],
    "incrementalSales": ["incrementalsales", "estimatedincrementalsales"],
    "budget": ["budget", "dailybudget", "campaignbudget", "budgetamount"],
    "reach": ["reach", "uniquereach", "cumulativereach"],
    "videoViews": ["videoviews", "videocompleteviews", "videostarts"],
    "viewableImpressions": ["viewableimpressions", "vcpmimpressions"],
    "engagements": ["engagements", "totalengagements", "brandedsearches"],
    "tosIs": ["topofsearchimpressionshare", "topofsearchis", "tosis", "topofsearchimpressionsharepercent"],
    "searchIs": ["searchtermimpressionshare", "searchimpressionshare", "impressionshare"],
}
RECALCULATED = ["purchaserateoverclicks", "clickthrurate", "ctr", "costperclick", "cpc", "conversionrate", "cvr", "advertisingcostofsales",
                "acos", "returnonadvertisingspend", "roas", "totaladvertisingcostofsalesacos", "totalreturnonadvertisingspendroas"]
REQUIRED_FIELDS = ["date", "campaign", "adSpend"]
RECOMMENDED_FIELDS = ["adSales", "impressions", "clicks", "orders"]

import os as _os

# Upload size limit. Default 2 GB; change with the MAX_UPLOAD_MB environment variable
# (e.g. MAX_UPLOAD_MB=5000 python run.py). Files are streamed to disk and processed
# in chunks, so the limit is about disk space and patience, not memory.
MAX_UPLOAD_MB = int(_os.environ.get("MAX_UPLOAD_MB", "2048"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
ALLOWED_EXTENSIONS = (".csv", ".tsv", ".txt", ".xlsx", ".xls", ".zip", ".gz")
