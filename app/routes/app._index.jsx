// app/routes/bundles._index.jsx
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Box,
  Link,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

/** ---------------- GraphQL ---------------- **/

// List products tagged "bundle-app"; read the bundle metafield on the default (first) variant
const LIST_BUNDLES = `#graphql
  query ListBundles($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "tag:bundle-app") {
      edges {
        cursor
        node {
          id
          title
          status
          handle
          createdAt
          updatedAt
          featuredImage { url altText }
          variants(first: 1) {
            nodes {
              id
              metafield(namespace: "custom", key: "component_reference") {
                references(first: 250) {
                  nodes {
                    __typename
                    ... on ProductVariant {
                      id
                      title
                      product { title }
                    }
                  }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** ---------------- Loader ---------------- **/
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const after = url.searchParams.get("after") || null;
  const first = Number(url.searchParams.get("first") || 25);

  const resp = await admin.graphql(LIST_BUNDLES, { variables: { first, after } });
  const data = await resp.json();

  const edges = data?.data?.products?.edges ?? [];
  const pageInfo = data?.data?.products?.pageInfo ?? { hasNextPage: false, endCursor: null };

  // Normalize for the UI
  const items = edges.map((e) => {
    const p = e.node;
    const v = p?.variants?.nodes?.[0];
    const refs = v?.metafield?.references?.nodes ?? [];
    return {
      cursor: e.cursor,
      id: p.id,
      idShort: p.id?.replace("gid://shopify/Product/", ""),
      title: p.title,
      status: p.status,
      handle: p.handle,
      image: p.featuredImage?.url || null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      defaultVariantId: v?.id || null,
      components: refs.map((n) => ({
        id: n.id,
        title: n.title || "Variant",
        productTitle: n.product?.title,
      })),
    };
  });

  return json({ items, pageInfo, first });
};

/** ---------------- UI ---------------- **/
export default function BundlesIndex() {
  const { items, pageInfo, first } = useLoaderData();

  const total = items.length;
  const hasBundles = total > 0;

  const nextHref = useMemo(() => {
    if (!pageInfo?.hasNextPage) return null;
    const params = new URLSearchParams();
    params.set("first", String(first));
    params.set("after", pageInfo.endCursor);
    return `/bundles?${params.toString()}`;
  }, [pageInfo, first]);

  return (
    <Page>
      <TitleBar title="Bundles">
        <a href="app/bundles/create" role="button">Create bundle</a>
      </TitleBar>

      <Layout>
        <Layout.Section>
          {!hasBundles && (
            <Banner title="No bundles yet" tone="info">
              <p>
                You haven’t created any bundle products.{" "}
                <Link url="/bundles/create" removeUnderline>Make one now</Link>.
              </p>
            </Banner>
          )}

          {hasBundles && (
            <BlockStack gap="400">
              {items.map((item) => {
                const count = item.components.length;
                return (
                  <Card key={item.id}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="200" blockAlign="center">
                          {item.image ? (
                            <img
                              src={item.image}
                              alt=""
                              style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8 }}
                            />
                          ) : (
                            <Box
                              width="48"
                              height="48"
                              background="bg-fill-tertiary"
                              borderRadius="200"
                            />
                          )}
                          <div>
                            <Text as="h3" variant="headingMd">{item.title}</Text>
                            <InlineStack gap="200">
                              <Badge tone={item.status === "ACTIVE" ? "success" : "attention"}>
                                {item.status.toLowerCase()}
                              </Badge>
                              <Badge tone={count > 0 ? "success" : "critical"}>
                                {count} component{count === 1 ? "" : "s"}
                              </Badge>
                            </InlineStack>
                          </div>
                        </InlineStack>

                        <InlineStack gap="200">
                          <Button
                            url={`shopify:admin/products/${item.idShort}`}
                            target="_blank"
                            variant="primary"
                          >
                            Open in Admin
                          </Button>
                          <Button url={`/bundles/${item.idShort}`} disabled>
                            Edit (coming soon)
                          </Button>
                        </InlineStack>
                      </InlineStack>

                      {count > 0 && (
                        <Box paddingInlineStart="300">
                          <Text as="p" tone="subdued">Components</Text>
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {item.components.slice(0, 6).map((c) => (
                              <li key={c.id}>
                                <Text as="span" variant="bodyMd">
                                  {c.productTitle ? `${c.productTitle} — ` : ""}{c.title}
                                </Text>
                              </li>
                            ))}
                            {count > 6 && (
                              <li>
                                <Text as="span" tone="subdued">
                                  +{count - 6} more…
                                </Text>
                              </li>
                            )}
                          </ul>
                        </Box>
                      )}
                    </BlockStack>
                  </Card>
                );
              })}

              {nextHref && (
                <InlineStack align="center">
                  <Button url={nextHref}>Load more</Button>
                </InlineStack>
              )}
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
