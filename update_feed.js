import fs from "node:fs";

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

if (!TOKEN || !LOCATION_ID) {
  throw new Error("Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID secrets.");
}

const SQUARE_VERSION = "2024-01-18";
const OUT = "winesearcher-feed.txt";
const TAX = "Inc.tax";
const OFFER = "R";
const DELIVERY = "Next day";
const SHOP_SEARCH_BASE = "https://www.magazzinonyc.com/s/shop?query=";

function encodeQuery(q) {
  return encodeURIComponent(q).replace(/%20/g, "%20");
}

function guessVintage(name) {
  const m = name.match(/\b(18|19|20)\d{2}\b/);
  return m ? m[0] : "NV";
}

function guessUnitSize(name) {
  // Minimal: default to 750ml unless name includes obvious size terms
  const n = name.toLowerCase();
  if (n.includes("magnum") || n.includes("1.5l") || n.includes("1500")) return "1.5L Magnum";
  if (n.includes("375")) return "375ml";
  if (n.includes("500")) return "500ml";
  if (n.includes("1l") || n.includes("1000")) return "1L";
  if (n.includes("3l")) return "3L";
  return "750ml";
}

async function squareFetch(path, body = null) {
  const res = await fetch(`https://connect.squareup.com${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Square API ${res.status}: ${txt}`);
  return JSON.parse(txt);
}

function centsToDollars(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

async function main() {
  // 1) Pull all item variations (SKU + price + variation id) and related item names
  const cat = await squareFetch("/v2/catalog/search", {
    object_types: ["ITEM_VARIATION"],
    include_related_objects: true,
    limit: 1000,
  });

  const variations = cat.objects || [];
  const related = cat.related_objects || [];

  const itemNameById = new Map();
  for (const obj of related) {
    if (obj.type === "ITEM") {
      itemNameById.set(obj.id, obj.item_data?.name || "");
    }
  }

  // Keep only variations that have SKUs (Wine-Searcher needs a unique id)
  const usable = [];
  for (const v of variations) {
    const d = v.item_variation_data;
    const sku = d?.sku;
    if (!sku) continue;

    const itemId = d?.item_id;
    const itemName = itemNameById.get(itemId) || "";
    const varName = d?.name || "";

    // If variation name adds important size info, append it
    const fullName =
      varName && varName.toLowerCase() !== "regular"
        ? `${itemName} ${varName}`.trim()
        : itemName.trim();

    usable.push({
      sku,
      name: fullName || sku,
      variationId: v.id,
      price: centsToDollars(d?.price_money?.amount),
      imageUrl: null,
    });
  }

  // 2) Pull inventory counts for these variations at your location
  const inv = await squareFetch("/v2/inventory/batch-retrieve-counts", {
    catalog_object_ids: usable.map((u) => u.variationId),
    location_ids: [LOCATION_ID],
    states: ["IN_STOCK"],
  });

  const stockByVarId = new Map();
  for (const c of inv.counts || []) {
    stockByVarId.set(c.catalog_object_id, String(Number(c.quantity || 0)));
  }

  // 3) Write Wine-Searcher feed
  const header =
    "SKU|name|description|vintage|unit-size|price|stock|url|min-order|tax|offer-type|delivery-time|LWIN|imageurl";

  const lines = [header];

  for (const u of usable) {
    const vintage = guessVintage(u.name);
    const unitSize = guessUnitSize(u.name);
    const stock = stockByVarId.get(u.variationId) ?? "0";
    const url = `${SHOP_SEARCH_BASE}${encodeQuery(u.name)}`;

    // description, min-order, LWIN, imageurl left blank for minimal setup
    const row = [
      u.sku,
      u.name,
      "", // description
      vintage,
      unitSize,
      u.price,
      stock,
      url,
      "", // min-order
      TAX,
      OFFER,
      DELIVERY,
      "", // LWIN
      "", // imageurl
    ].join("|");

    lines.push(row);
  }

  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${OUT} with ${usable.length} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
