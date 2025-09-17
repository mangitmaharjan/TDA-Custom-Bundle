// app/routes/bundles.create.jsx
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  Box,
  TextField,
  ChoiceList,
  List,
  Link,
  Select,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/* ---------------- Loader ---------------- */
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

/* ---------------- GraphQL ---------------- */

// Metafield definition on PRODUCT VARIANT: list.variant_reference
const METAFIELD_DEF_CREATE = `#graphql
  mutation EnsureVariantListRefDef {
    metafieldDefinitionCreate(definition: {
      name: "Bundle Components"
      key: "component_reference"
      namespace: "custom"
      ownerType: PRODUCTVARIANT
      type: "list.variant_reference"
      access: { admin: READ_WRITE, storefront: NONE }
    }) {
      createdDefinition { id }
      userErrors { field message }
    }
  }
`;

// Create product; Shopify creates a default variant
const PRODUCT_CREATE = `#graphql
  mutation CreateBundleProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        title
        handle
        status
        variants(first: 1) { nodes { id title } }
      }
      userErrors { field message }
    }
  }
`;

// Update default variant price + weight (weight is nested in inventoryItem.measurement.weight)
const VARIANT_BULK_UPDATE = `#graphql
  mutation UpdateDefaultVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        price
        inventoryItem { measurement { weight { value unit } } }
      }
      userErrors { field message }
    }
  }
`;

// Save the list.variant_reference on the default variant
const METAFIELDS_SET = `#graphql
  mutation SaveBundleMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

// Read variant price + weight correctly (weight is on inventoryItem.measurement.weight)
const VARIANT_DETAILS = `#graphql
  query VariantDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on ProductVariant {
        id
        title
        price
        inventoryItem {
          measurement {
            weight { value unit }
          }
        }
        product { title }
      }
    }
  }
`;

// Publications (to find "Online Store")
const PUBLICATIONS_QUERY = `#graphql
  query Pubs {
    publications(first: 50) {
      nodes { id name }
    }
  }
`;

// ✅ Current publish mutation (array input); include $pubId so we can confirm in selection set
const PUBLISH_PRODUCT = `#graphql
  mutation PublishProduct($id: ID!, $input: [PublicationInput!]!, $pubId: ID!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          publishedOnPublication(publicationId: $pubId)
        }
      }
      userErrors { field message }
    }
  }
`;

/* ---------------- Action ---------------- */
export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "create");

  // A) Resolve totals from selected component variants (auto-fill)
  if (intent === "resolve") {
    const ids = JSON.parse(String(form.get("variantIds") || "[]"));
    if (!Array.isArray(ids) || ids.length === 0) {
      return json({ ok: false, message: "No variants supplied." }, { status: 400 });
    }

    const resp = await admin.graphql(VARIANT_DETAILS, { variables: { ids } });
    const data = await resp.json();
    const nodes = (data?.data?.nodes ?? []).filter(Boolean);

    let totalPrice = 0;
    let totalGrams = 0;

    const toNumber = (v) => (v == null ? 0 : Number(v));
    const toGrams = (value, unit) => {
      const v = toNumber(value);
      if (!v) return 0;
      switch (unit) {
        case "KILOGRAMS": return v * 1000;
        case "POUNDS":    return v * 453.59237;
        case "OUNCES":    return v * 28.349523125;
        default:          return v; // GRAMS
      }
    };

    for (const v of nodes) {
      const priceNum = parseFloat(v?.price ?? "0");
      totalPrice += isFinite(priceNum) ? priceNum : 0;
      const w = v?.inventoryItem?.measurement?.weight;
      totalGrams += w ? toGrams(w.value, w.unit) : 0;
    }

    return json({
      ok: true,
      totals: { price: Number(totalPrice.toFixed(2)), grams: Math.round(totalGrams) },
      variants: nodes,
    });
  }

  // B) Create the bundle product and attach references, then publish to Online Store
  const title = (form.get("title") || "").toString().trim();
  const description = (form.get("description") || "").toString();
  const status = (form.get("status") || "DRAFT").toString(); // DRAFT | ACTIVE
  const imageUrl = (form.get("imageUrl") || "").toString().trim();
  const componentVariantIds = JSON.parse(form.get("componentVariantIds") || "[]");
  const priceStr = (form.get("price") || "").toString().trim();
  const weightStr = (form.get("weight") || "").toString().trim();
  const weightUnit = (form.get("weightUnit") || "GRAMS").toString();

  if (!title) return json({ ok: false, message: "Enter a product title." }, { status: 400 });
  if (!Array.isArray(componentVariantIds) || componentVariantIds.length === 0) {
    return json({ ok: false, message: "Pick at least one component variant." }, { status: 400 });
  }

  // 1) Ensure metafield definition exists
  try {
    const defResp = await admin.graphql(METAFIELD_DEF_CREATE);
    await defResp.json();
  } catch (_) {}

  // 2) Create product (with description + simple image URL)
  const productInput = {
    title,
    status,
    tags: ["bundle-app"],
    descriptionHtml: description || undefined,
    images: imageUrl ? [{ src: imageUrl }] : undefined,
  };

  const createResp = await admin.graphql(PRODUCT_CREATE, { variables: { product: productInput } });
  const createJson = await createResp.json();
  const createErr = createJson?.data?.productCreate?.userErrors?.[0]?.message;
  if (createErr) return json({ ok: false, message: createErr }, { status: 400 });

  const product = createJson?.data?.productCreate?.product;
  const productId = product?.id;
  const bundleVariantId = product?.variants?.nodes?.[0]?.id;
  if (!bundleVariantId) {
    return json({ ok: false, message: "New product has no default variant to attach the metafield." }, { status: 400 });
  }

  // 3) Update default variant price/weight (weight via inventoryItem.measurement.weight)
  const numericPrice = priceStr ? parseFloat(priceStr) : undefined;
  const numericWeight = weightStr ? parseFloat(weightStr) : undefined;

  if ((numericPrice != null && isFinite(numericPrice)) || (numericWeight != null && isFinite(numericWeight))) {
    const variants = [{
      id: bundleVariantId,
      price: (numericPrice != null && isFinite(numericPrice)) ? numericPrice.toFixed(2) : undefined,
      inventoryItem: (numericWeight != null && isFinite(numericWeight)) ? {
        measurement: { weight: { value: numericWeight, unit: weightUnit } },
      } : undefined,
    }];

    const updResp = await admin.graphql(VARIANT_BULK_UPDATE, {
      variables: { productId, variants },
    });
    const updJson = await updResp.json();
    const updErr = updJson?.data?.productVariantsBulkUpdate?.userErrors?.[0]?.message;
    if (updErr) return json({ ok: false, message: updErr }, { status: 400 });
  }

  // 4) Attach list.variant_reference on the new product's default variant
  const mfResp = await admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: [{
        ownerId: bundleVariantId,
        namespace: "custom",
        key: "component_reference",
        type: "list.variant_reference",
        value: JSON.stringify(componentVariantIds),
      }],
    },
  });
  const mfJson = await mfResp.json();
  const mfErr = mfJson?.data?.metafieldsSet?.userErrors?.[0]?.message;
  if (mfErr) return json({ ok: false, message: mfErr }, { status: 400 });

  // 5) Publish to Online Store
  let onlineStorePublicationId = null;
  try {
    const pubsResp = await admin.graphql(PUBLICATIONS_QUERY);
    const pubsJson = await pubsResp.json();
    const pubs = pubsJson?.data?.publications?.nodes ?? [];
    const online = pubs.find((p) => p.name === "Online Store") || pubs.find((p) => /online/i.test(p.name || ""));
    onlineStorePublicationId = online?.id || null;
  } catch (_) {}

  if (onlineStorePublicationId) {
    const pubResp = await admin.graphql(PUBLISH_PRODUCT, {
      variables: {
        id: productId,
        input: [{ publicationId: onlineStorePublicationId }],
        pubId: onlineStorePublicationId,
      },
    });
    const pubJson = await pubResp.json();
    const pubErr = pubJson?.data?.publishablePublish?.userErrors?.[0]?.message;
    if (pubErr) {
      // Not fatal for creation—surface info in the banner
      return json({
        ok: true,
        message: `Bundle created, but publishing to Online Store returned: ${pubErr}`,
        product,
        bundleVariantId,
        componentVariantIds,
      });
    }
  }

  return json({
    ok: true,
    message:
      status === "ACTIVE"
        ? "Bundle product created and published to Online Store."
        : "Bundle product created and published (currently Draft; switch to Active to show on Online Store).",
    product,
    bundleVariantId,
    componentVariantIds,
  });
};

/* ---------------- Client/UI ---------------- */

const WEIGHT_OPTIONS = [
  { label: "Grams", value: "GRAMS" },
  { label: "Kilograms", value: "KILOGRAMS" },
  { label: "Pounds", value: "POUNDS" },
  { label: "Ounces", value: "OUNCES" },
];

const gramsTo = (grams, unit) => {
  if (!grams) return 0;
  switch (unit) {
    case "KILOGRAMS": return grams / 1000;
    case "POUNDS":    return grams / 453.59237;
    case "OUNCES":    return grams / 28.349523125;
    default:          return grams;
  }
};

export default function CreateBundleProduct() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  // Form state
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState(["DRAFT"]);
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  const [components, setComponents] = useState([]); // [{id, title, productTitle}]
  const [price, setPrice] = useState("");
  const [weight, setWeight] = useState("");
  const [weightUnit, setWeightUnit] = useState("GRAMS");

  const priceTouched = useRef(false);
  const weightTouched = useRef(false);

  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data?.product?.id) {
      shopify.toast.show("Bundle product created");
    }
  }, [fetcher.data?.ok, fetcher.data?.product?.id, shopify]);

  // Pick variants via App Bridge Library (promise API)
  const pickVariants = async () => {
    const selected = await shopify.resourcePicker({
      type: "variant",
      multiple: true,
      filter: { variants: true },
    });
    if (selected?.length) {
      const normalized = selected.map((v) => ({
        id: v.id,
        title: v.title || "Variant",
        productTitle: v.productTitle || v.product?.title,
      }));
      setComponents(normalized);

      const form = new FormData();
      form.set("intent", "resolve");
      form.set("variantIds", JSON.stringify(normalized.map((n) => n.id)));
      fetcher.submit(form, { method: "POST" });
    }
  };

  // Auto-fill price/weight from server-resolved totals unless user edited
  useEffect(() => {
    const totals = fetcher.data?.totals;
    if (!totals) return;
    if (!priceTouched.current) setPrice(String(totals.price ?? ""));
    if (!weightTouched.current) {
      const val = gramsTo(totals.grams ?? 0, weightUnit);
      setWeight(val ? String(Number(val.toFixed(2))) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data?.totals]);

  // Recompute visible weight if unit changes and user hasn't edited
  useEffect(() => {
    const totals = fetcher.data?.totals;
    if (!totals) return;
    if (!weightTouched.current) {
      const val = gramsTo(totals.grams ?? 0, weightUnit);
      setWeight(val ? String(Number(val.toFixed(2))) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weightUnit]);

  const createBundle = () => {
    const form = new FormData();
    form.set("intent", "create");
    form.set("title", title);
    form.set("status", status[0] || "DRAFT");
    form.set("description", description);
    form.set("imageUrl", imageUrl);
    form.set("componentVariantIds", JSON.stringify(components.map((c) => c.id)));
    form.set("price", price);
    form.set("weight", weight);
    form.set("weightUnit", weightUnit);
    fetcher.submit(form, { method: "POST" });
  };

  const productIdShort = fetcher.data?.product?.id?.replace("gid://shopify/Product/", "");

  return (
    <Page>
      <TitleBar title="Create Bundle Product">
        <button variant="primary" onClick={createBundle} disabled={!title || components.length === 0}>
          Create bundle product
        </button>
      </TitleBar>

      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">New bundle</Text>
                  <Text as="p" variant="bodyMd">
                    Creates a new product and saves component <b>variant references</b> on its default variant.
                    Price & weight are auto-filled from selected variants (you can edit before saving).
                  </Text>
                </BlockStack>

                {/* Product core fields */}
                <BlockStack gap="300">
                  <TextField
                    label="Bundle product title"
                    value={title}
                    onChange={setTitle}
                    autoComplete="off"
                    placeholder="e.g., Weekend Essentials Bundle"
                  />
                  <ChoiceList
                    title="Status"
                    titleHidden
                    choices={[
                      { label: "Draft", value: "DRAFT" },
                      { label: "Active", value: "ACTIVE" },
                    ]}
                    selected={status}
                    onChange={setStatus}
                  />
                  <TextField
                    label="Description (HTML allowed)"
                    value={description}
                    onChange={setDescription}
                    autoComplete="off"
                    multiline={6}
                    placeholder="<p>Bundle details…</p>"
                  />
                  <TextField
                    label="Image URL (optional)"
                    value={imageUrl}
                    onChange={setImageUrl}
                    autoComplete="off"
                    placeholder="https://example.com/image.jpg"
                    helpText="MVP accepts a URL. (Direct upload via stagedUploadsCreate can be added later.)"
                  />
                </BlockStack>

                {/* Component variants */}
                <InlineStack gap="400" align="space-between" blockAlign="start">
                  <Box>
                    <Text as="h3" variant="headingMd">Component variants</Text>
                    <div style={{ marginTop: 8 }}>
                      <Button onClick={pickVariants}>
                        {components.length ? "Edit component variants" : "Choose component variants"}
                      </Button>
                    </div>
                  </Box>

                  {components.length > 0 && (
                    <Box paddingBlockStart="200">
                      <List type="bullet">
                        {components.map((v) => (
                          <List.Item key={v.id}>
                            {v.productTitle ? `${v.productTitle} — ` : ""}{v.title}
                          </List.Item>
                        ))}
                      </List>
                    </Box>
                  )}
                </InlineStack>

                {/* Price & weight (auto-filled but editable) */}
                <InlineStack gap="300">
                  <TextField
                    label="Bundle price"
                    type="number"
                    value={price}
                    onChange={(val) => { priceTouched.current = true; setPrice(val); }}
                    autoComplete="off"
                    prefix="$"
                    min="0"
                  />
                  <TextField
                    label="Bundle weight"
                    type="number"
                    value={weight}
                    onChange={(val) => { weightTouched.current = true; setWeight(val); }}
                    autoComplete="off"
                    min="0"
                  />
                  <Select
                    label="Unit"
                    labelHidden
                    options={[
                      { label: "Grams", value: "GRAMS" },
                      { label: "Kilograms", value: "KILOGRAMS" },
                      { label: "Pounds", value: "POUNDS" },
                      { label: "Ounces", value: "OUNCES" },
                    ]}
                    value={weightUnit}
                    onChange={setWeightUnit}
                  />
                </InlineStack>

                <InlineStack gap="300">
                  <Button
                    variant="primary"
                    onClick={createBundle}
                    loading={isSubmitting}
                    disabled={!title || components.length === 0}
                  >
                    Create bundle product
                  </Button>
                  <Link
                    url="https://shopify.dev/docs/api/app-bridge-library/apis/resource-picker"
                    target="_blank"
                    removeUnderline
                  >
                    Resource Picker docs
                  </Link>
                </InlineStack>

                {fetcher.data?.message && (
                  <Banner
                    title={fetcher.data.ok ? "Success" : "Error"}
                    tone={fetcher.data.ok ? "success" : "critical"}
                  >
                    <p>{fetcher.data.message}</p>
                    {fetcher.data?.product?.id && (
                      <p style={{ marginTop: 8 }}>
                        <Link
                          url={`shopify:admin/products/${productIdShort}`}
                          target="_blank"
                          removeUnderline
                        >
                          Open created product
                        </Link>
                      </p>
                    )}
                  </Banner>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
