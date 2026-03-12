import fs from "node:fs";
import path from "node:path";

const INPUT = process.argv[2] || "./productCatalog.json";
const OUTPUT = process.argv[3] || "./productCatalog.v2.json";

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
  // Keep it simple + deterministic
  // "TSHIRT - SHORT SLEEVE" => "Tshirt – Short Sleeve"
  return String(dn || "")
    .toLowerCase()
    .split(/(\s+|-|\_)/g)
    .map(t => (/[a-z]/.test(t) ? t[0].toUpperCase() + t.slice(1) : t))
    .join("")
    .replace(/\s*-\s*/g, " – ")
    .trim();
}

function classify(displayName, cls) {
  const dn = String(displayName || "").toUpperCase().trim();
  const c = String(cls || "").toUpperCase().trim();

  if (c === "DOG" || dn.startsWith("DOG ")) return ["PETS", "DOG_APPAREL"];

  if (dn.includes("TSHIRT") || dn.includes("TANK TOP") || dn.includes("SLEEVELESS")) {
    if (dn.includes("TSHIRT")) return ["TOPS", "TSHIRT"];
    if (dn.includes("TANK")) return ["TOPS", "TANK_TOP"];
    return ["TOPS", "SLEEVELESS_HOODIE"];
  }

  if (dn.includes("HOODIE") || dn.includes("SWEATSHIRT")) {
    return ["OUTERWEAR", dn.includes("HOODIE") ? "HOODIE" : "SWEATSHIRT"];
  }

  if (dn.includes("HAT") || dn.includes("BEANIE") || dn.includes("HEADBAND")) {
    if (dn.includes("HAT")) return ["ACCESSORIES", "HAT"];
    if (dn.includes("BEANIE")) return ["ACCESSORIES", "BEANIE"];
    return ["ACCESSORIES", "HEADBAND"];
  }

  return ["OTHER", "OTHER"];
}

function tagsFor(row) {
  const dn = String(row.DisplayName || "");
  const tokens = dn.split(/[^A-Za-z0-9]+/g).filter(Boolean).map(s => s.toLowerCase());
  const extra = [row.Class, row.Fit].map(s => String(s || "").toLowerCase()).filter(Boolean);
  const all = [...tokens, ...extra];

  const seen = new Set();
  const out = [];
  for (const t of all) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function merchSort(category, subcategory) {
  const base = { TOPS: 100, OUTERWEAR: 200, ACCESSORIES: 300, PETS: 400, OTHER: 900 }[category] ?? 900;
  const bump = {
    TSHIRT: 0,
    TANK_TOP: 10,
    SLEEVELESS_HOODIE: 20,
    HOODIE: 0,
    SWEATSHIRT: 10,
    HAT: 0,
    BEANIE: 10,
    HEADBAND: 20,
    DOG_APPAREL: 0
  }[subcategory] ?? 50;
  return base + bump;
}

function validateRow(r, idx) {
  const missing = [];
  for (const k of ["PartitionKey","RowKey","DisplayName","Class","Fit","Size","Price","GraphicType","Active","LastUpdated"]) {
    if (r[k] === undefined) missing.push(k);
  }
  return missing.length ? { idx, sku: r.PartitionKey, missing } : null;
}

const raw = fs.readFileSync(INPUT, "utf-8");
const data = JSON.parse(raw);

if (!Array.isArray(data)) throw new Error("Catalog root must be an array.");

const issues = {
  missingRequired: [],
  duplicateSku: [],
  duplicateVariantSignature: []
};

const skuSeen = new Set();
const sigSeen = new Map();

const out = data.map((row, i) => {
  const miss = validateRow(row, i);
  if (miss) issues.missingRequired.push(miss);

  const sku = row.PartitionKey;
  if (skuSeen.has(sku)) issues.duplicateSku.push(sku);
  skuSeen.add(sku);

  const [Category, Subcategory] = classify(row.DisplayName, row.Class);

  // product identity: stable + deterministic grouping key
  const ProductHandle = slugify(`${row.DisplayName} ${row.Class} ${row.Fit}`);
  const ProductName = titleizeDisplayName(row.DisplayName);

  const sig = [
    row.DisplayName, row.Class, row.Fit, row.Size, row.GraphicType, row.Price
  ].join("|");
  if (sigSeen.has(sig)) {
    sigSeen.get(sig).push(sku);
  } else {
    sigSeen.set(sig, [sku]);
  }

  return {
    ...row,

    // new fields
    SKU: sku,

    ProductHandle,
    ProductName,
    Category,
    Subcategory,

    Audience: String(row.Class || "").toUpperCase() || null,
    Style: String(row.Fit || "").toUpperCase() || null,

    Variant: {
      Size: row.Size,
      GraphicFinish: row.GraphicType ? String(row.GraphicType).toUpperCase() : null
    },

    BasePrice: row.Price,
    PriceDelta: 0,
    Currency: "USD",

    Images: {
      primary: null,
      gallery: []
    },

    Tags: tagsFor(row),

    Merch: {
      Sort: merchSort(Category, Subcategory),
      Featured: false,
      New: false
    }
  };
});

// build duplicate signature list
for (const [sig, skus] of sigSeen.entries()) {
  if (skus.length > 1) issues.duplicateVariantSignature.push({ sig, skus });
}

// Write output
fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2), "utf-8");

// Print review
console.log("✅ Refactor complete");
console.log("Input rows:", data.length);
console.log("Output rows:", out.length);
console.log("Unique SKUs:", skuSeen.size);
console.log("Missing required fields:", issues.missingRequired.length);
console.log("Duplicate SKU:", issues.duplicateSku.length);
console.log("Duplicate variant signatures:", issues.duplicateVariantSignature.length);

if (issues.missingRequired.length) {
  console.log("\n--- Missing fields (first 10) ---");
  console.log(issues.missingRequired.slice(0,10));
}

if (issues.duplicateVariantSignature.length) {
  console.log("\n--- Duplicate variant signatures (first 10) ---");
  console.log(issues.duplicateVariantSignature.slice(0,10));
}

console.log("\nWrote:", path.resolve(OUTPUT));