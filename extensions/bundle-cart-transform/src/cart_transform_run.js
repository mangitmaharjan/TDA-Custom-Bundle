// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const operations = [];

  for (const line of input.cart.lines ?? []) {
    const merch = line.merchandise;
    if (!merch || merch.__typename !== "ProductVariant") continue;

    const mf = merch.bundleRefs;
    // Only react to the exact metafield type we expect
    if (!mf || mf.type !== "list.variant_reference") continue;

    const componentVariantIds = normalizeVariantIds(mf);
    if (componentVariantIds.length === 0) continue;

    // Expand this "bundle" line into its components.
    // Each component inherits the original line's quantity.
    const expandedCartItems = componentVariantIds.map((variantId) => ({
      merchandiseId: variantId,
      quantity: line.quantity ?? 1,
    }));

    operations.push({
      lineExpand: {
        cartLineId: line.id,
        expandedCartItems,
        // Optional: you can also set a group title/image/price adjustment here.
        // title: "Bundle components",
      },
    });
  }

  return { operations };
}

function normalizeVariantIds(mf) {
  if (!mf) return [];

  // Prefer jsonValue — in Functions schema it's already JSON.
  // For list.variant_reference this is usually an array of GIDs.
  // But be tolerant to shapes like [{id: "..."}] or a string.
  let raw = mf.jsonValue;

  try {
    if (!raw && typeof mf.value === "string") {
      // Fallback: some stores/tools may persist a JSON string into `value`
      raw = JSON.parse(mf.value);
    }
  } catch (_) {
    // ignore
  }

  if (Array.isArray(raw)) {
    return raw
      .map((item) =>
        typeof item === "string"
          ? item
          : item?.id || item?.gid || null
      )
      .filter(Boolean);
  }

  if (typeof raw === "string") {
    // Single gid or comma-separated — best-effort
    if (raw.startsWith("gid://")) return [raw];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.startsWith("gid://"));
  }

  return [];
}