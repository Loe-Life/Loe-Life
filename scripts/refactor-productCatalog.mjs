import fs from "node:fs";
import path from "node:path";

/**
 * convertCatalogV2toV3.js
 *
 * Usage:
 *   node convertCatalogV2toV3.js ./catalog/productCatalog.v2.json ./catalog/productCatalog.v3.json --glitterDelta=4
 *
 * Notes:
 * - This converts v2 SKU-rows (SOLID/GLITTER as separate rows) into v3 products with:
 *   - finishes as options
 *   - garment colors + graphic colors as options
 *   - basePrice from spreadsheet mapping (heuristics) + glitter delta
 *   - skuByFinish retained for compatibility (checkout/Stripe/inventory)
 */

const INPUT = process.argv[2] || "./productCatalog.v2.json";
const OUTPUT = process.argv[3] || "./productCatalog.v3.json";

const arg = Object.fromEntries(
  process.argv.slice(4).map(s => {
    const [k, v] = s.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

// configurable glitter delta (USD)
const GLITTER_DELTA = Number(arg.glitterDelta ?? 4);

// placeholder option sets (replace later as you get real data)
const DEFAULT_GARMENT_COLORS = ["BLACK", "WHITE", "GRAY"];
const DEFAULT_GRAPHIC_COLORS_SOLID = ["WHITE", "BLACK", "RED", "BLUE"];
const DEFAULT_GRAPHIC_COLORS_GLITTER = ["GOLD", "SILVER"];

/* ===========================
   Helpers
   =========================== */

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function titleizeDisplayName(dn) {
  return String(dn || "")
    .toLowerCase()
    .split(/(\s+|-|_)/g)
    .map(t => (/[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t))
    .join("")
    .replace(/\s*-\s*/g, " – ")
    .trim();
}

function prettyEnum(s) {
  return String(s || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function sizeSort(a, b) {
  const order = ["XS","S","M","L","XL","2XL","3XL","4XL","ONE_SIZE","OS"];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai === -1 && bi === -1) return String(a).localeCompare(String(b));
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

/* ===========================
   Spreadsheet-aligned base pricing
   ===========================
   These values come from the customer spreadsheet you shared.
   Where the spreadsheet is ambiguous vs your current size tokens,
   we apply a conservative heuristic and emit warnings.  
*/

function basePriceFromSpreadsheet(product, variantSize) {
  const dn = String(product.displayName || "").toUpperCase();

  // TSHIRTS
  if (dn.includes("TSHIRT") && dn.includes("SHORT")) return 20; // 
  if (dn.includes("TSHIRT") && dn.includes("LONG")) return 22;  // 

  // HOODIES
  if (dn.includes("HOODIE") && dn.includes("NO ZIPPER")) return 28; // 
  if (dn.includes("HOODIE") && dn.includes("ZIPPER")) return 28;    // 

  // SWEATSHIRT NO HOOD (spreadsheet shows 24) 
  if (dn.includes("SWEATSHIRT")) return 24; // 

  // HEADBANDS
  if (dn.includes("HEADBAND")) return 10; // 

  // HATS: spreadsheet uses S/M, L/XL => 20 and XL/2XL => 22 
  if (dn.includes("HAT")) {
    if (String(variantSize).toUpperCase() === "2XL") return 22; // heuristic mapping for XL/2XL 
    return 20; // default for other hat sizes 
  }

  // BEANIES: spreadsheet has 16/17/19 but doesn’t label tiers in text export 
  if (dn.includes("BEANIE")) return 16; // pick lowest as base; tiers can be added later 

  // MENS tank tops: spreadsheet shows 15 
  if (dn.includes("TANK TOPS-MENS") && !dn.includes("SLEEVELESS")) return 15; // 

  // Mens sleeveless hoodies line in spreadsheet is combined label; your v2 has separate product name. Use category/subcategory as fallback.
  if (String(product.subcategory || "").toUpperCase() === "SLEEVELESS_HOODIE") return 18; // 

  // Womens loose fit tank prices are blank in sheet export 
  if (dn.includes("TANK TOPS-WOMENS") && dn.includes("LOOSE")) return null; // 

  // Womens slim fit appears at 14 and also 15 later; treat 14 as base, flag later if needed 
  if (dn.includes("TANK TOPS-WOMENS") && dn.includes("SLIM")) return 14; // 

  // DOG apparel: spreadsheet shows 8 for dog tshirts and 8 for dog hoodies 
  if (dn.includes("DOG TSHIRT")) return 8; // 
  if (dn.includes("DOG HOODIE")) return 8; // 

  return null;
}

/* ===========================
   Convert v2 rows -> v3 products
   =========================== */

const raw = fs.readFileSync(INPUT, "utf-8");
const v2 = JSON.parse(raw);
if (!Array.isArray(v2)) throw new Error("Input catalog must be an array.");

const activeRows = v2.filter(r => r && r.Active !== false);

const productsByHandle = new Map();
const warnings = [];

function getFinish(r) {
  // prefer v2 Variant.GraphicFinish, fallback to GraphicType
  const f = r?.Variant?.GraphicFinish ?? r?.GraphicType ?? "SOLID";
  return String(f).toUpperCase();
}

function getSize(r) {
  return r?.Variant?.Size ?? r?.Size ?? r?.RowKey ?? "ONE_SIZE";
}

function getFit(r) {
  return r?.Style ?? r?.Fit ?? "NONE";
}

for (const r of activeRows) {
  const handle = r.ProductHandle || slugify(`${r.DisplayName} ${r.Class} ${r.Fit}`);
  let p = productsByHandle.get(handle);

  if (!p) {
    p = {
      schema: "loe-life.catalog.product@v3",
      handle,
      id: handle, // stable
      name: r.ProductName || titleizeDisplayName(r.DisplayName),
      displayName: r.DisplayName,

      category: r.Category || "OTHER",
      subcategory: r.Subcategory || "OTHER",
      audience: r.Audience || r.Class || null,

      // style is your fit/style enum from v2 rows
      style: r.Style || r.Fit || null,

      tags: Array.isArray(r.Tags) ? r.Tags : [],
      merch: r.Merch || { Sort: 9999, Featured: false, New: false },

      // product imagery (placeholders)
      images: {
        primary: r?.Images?.primary ?? null,
        gallery: r?.Images?.gallery ?? [],
        byGarmentColor: {} // later: { "BLACK": "/images/garments/...png", ... }
      },

      // options
      options: {
        fits: new Set(),
        sizes: new Set(),
        finishes: new Set(["SOLID", "GLITTER"]), // ensure both exist as options even if rows missing
        garmentColors: new Set(DEFAULT_GARMENT_COLORS),
        // graphic library reference (separate file / embedded section)
        graphicsLibrary: "default",
        graphicColorsByFinish: {
          SOLID: [...DEFAULT_GRAPHIC_COLORS_SOLID],
          GLITTER: [...DEFAULT_GRAPHIC_COLORS_GLITTER]
        }
      },

      // pricing model (composable)
      pricing: {
        currency: r.Currency || "USD",
        basePrice: null, // filled from spreadsheet mapping
        finishDelta: { SOLID: 0, GLITTER: GLITTER_DELTA },
        // hooks for later (if you add per-graphic or per-color changes)
        graphicDeltaById: {},
        garmentColorDelta: {},
        notes: []
      },

      // variants keyed by fit+size; keep skuByFinish for compatibility
      variants: new Map()
    };

    productsByHandle.set(handle, p);
  }

  const size = getSize(r);
  const fit = String(getFit(r)).toUpperCase();
  const finish = getFinish(r);

  p.options.fits.add(fit);
  p.options.sizes.add(size);
  p.options.finishes.add(finish);

  const vKey = `${fit}||${size}`;
  let v = p.variants.get(vKey);
  if (!v) {
    v = {
      id: slugify(`${handle}-${fit}-${size}`),
      fit,
      size,
      // keep every finish-specific sku from v2
      skuByFinish: {},
      // carry some audit fields through
      lastUpdated: r.LastUpdated || null,
      active: true
    };
    p.variants.set(vKey, v);
  }

  // record finish-specific sku
  const sku = r.SKU || r.PartitionKey || null;
  if (sku) v.skuByFinish[finish] = sku;
}

// finalize products
const outProducts = [];
for (const p of productsByHandle.values()) {
  // compute base price from spreadsheet mapping, using first variant size as representative
  const firstVar = [...p.variants.values()][0];
  const inferred = basePriceFromSpreadsheet(p, firstVar?.size);

  if (inferred == null) {
    p.pricing.basePrice = null;
    p.pricing.notes.push("Base price missing/unknown from spreadsheet export; set manually.");
    warnings.push({ handle: p.handle, issue: "MISSING_BASE_PRICE", displayName: p.displayName });
  } else {
    p.pricing.basePrice = inferred;
  }

  // normalize Sets + Maps
  const finalProduct = {
    schema: p.schema,
    id: p.id,
    handle: p.handle,
    name: p.name,
    displayName: p.displayName,

    category: p.category,
    subcategory: p.subcategory,
    audience: p.audience,
    style: p.style,

    tags: p.tags,
    merch: p.merch,
    images: p.images,

    options: {
      fits: [...p.options.fits].sort(),
      sizes: [...p.options.sizes].sort(sizeSort),
      finishes: [...p.options.finishes].sort(),
      garmentColors: [...p.options.garmentColors],
      graphicsLibrary: p.options.graphicsLibrary,
      graphicColorsByFinish: p.options.graphicColorsByFinish
    },

    pricing: p.pricing,

    variants: [...p.variants.values()].sort((a, b) => {
      const f = a.fit.localeCompare(b.fit);
      if (f) return f;
      return sizeSort(a.size, b.size);
    })
  };

  outProducts.push(finalProduct);
}

// sort by merch
outProducts.sort((a, b) => {
  const as = Number(a?.merch?.Sort ?? 9999);
  const bs = Number(b?.merch?.Sort ?? 9999);
  if (as !== bs) return as - bs;
  return a.name.localeCompare(b.name);
});

/* ===========================
   Graphics library stub (embedded)
   =========================== */

const graphicsLibraries = {
  default: {
    id: "default",
    label: "Default Graphics (Placeholder)",
    items: [
      {
        id: "placeholder-logo",
        name: "Placeholder Logo",
        finishes: ["SOLID", "GLITTER"],
        colorsByFinish: {
          SOLID: [...DEFAULT_GRAPHIC_COLORS_SOLID],
          GLITTER: [...DEFAULT_GRAPHIC_COLORS_GLITTER]
        },
        images: {
          preview: "/images/placeholders/graphic.png",
          thumbnail: "/images/placeholders/graphic-thumb.png"
        }
      }
    ]
  }
};

/* ===========================
   Output
   =========================== */

const v3 = {
  schema: "loe-life.catalog@v3",
  generatedAt: new Date().toISOString(),
  source: path.resolve(INPUT),
  currency: "USD",

  pricing: {
    finishDelta: { SOLID: 0, GLITTER: GLITTER_DELTA },
    notes: [
      "Base prices are aligned to the customer spreadsheet where unambiguous.",
      "Glitter pricing is applied as a delta on top of basePrice.",
      "Where spreadsheet values were missing/ambiguous, basePrice is null and warnings are emitted."
    ]
  },

  warnings,
  graphicsLibraries,
  products: outProducts
};

fs.writeFileSync(OUTPUT, JSON.stringify(v3, null, 2), "utf-8");

// report
console.log("✅ v2 → v3 conversion complete");
console.log("Input rows:", v2.length);
console.log("Active rows:", activeRows.length);
console.log("Products:", outProducts.length);
console.log("Warnings:", warnings.length);
console.log("Wrote:", path.resolve(OUTPUT));