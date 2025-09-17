import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Page, Card, Button, BlockStack, Text, InlineStack, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

/* ------------ GraphQL ------------ */

const GET_FUNCTION = `#graphql
  query GetCartTransformFunction {
    shopifyFunctions(first: 10, apiType: "cart_transform") {
      nodes { id apiType title }
    }
  }
`;

const LIST_TRANSFORMS = `#graphql
  query CurrentCartTransforms {
    cartTransforms(first: 10) {
      nodes { id functionId blockOnFailure }
      pageInfo { hasNextPage }
    }
  }
`;

const CREATE_TRANSFORM = `#graphql
  mutation EnableCartTransform($functionId: String!, $blockOnFailure: Boolean) {
    cartTransformCreate(functionId: $functionId, blockOnFailure: $blockOnFailure) {
      cartTransform { id functionId blockOnFailure }
      userErrors { field message }
    }
  }
`;

const DELETE_TRANSFORM = `#graphql
  mutation DisableCartTransform($id: ID!) {
    cartTransformDelete(id: $id) {
      deletedId
      userErrors { field message }
    }
  }
`;

/* ------------ Loader ------------ */

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const res = await admin.graphql(LIST_TRANSFORMS);
  const data = await res.json();
  const current = data?.data?.cartTransforms?.nodes?.[0] ?? null;
  return json({ current });
};

/* ------------ Action ------------ */

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "enable") {
    // Find your deployed cart_transform function
    const fRes = await admin.graphql(GET_FUNCTION);
    const fJson = await fRes.json();
    const fn = fJson?.data?.shopifyFunctions?.nodes?.[0];
    if (!fn?.id) {
      return json(
        { ok: false, message: "Function not found. Deploy the cart_transform extension first." },
        { status: 400 },
      );
    }

    // Create/enable the transform
    const cRes = await admin.graphql(CREATE_TRANSFORM, {
      variables: { functionId: fn.id, blockOnFailure: false },
    });
    const cJson = await cRes.json();
    const err = cJson?.data?.cartTransformCreate?.userErrors?.[0]?.message;
    if (err) return json({ ok: false, message: err }, { status: 400 });

    return json({ ok: true, current: cJson.data.cartTransformCreate.cartTransform });
  }

  if (intent === "disable") {
    const id = form.get("id");
    if (!id) return json({ ok: false, message: "Missing cart transform id." }, { status: 400 });

    const dRes = await admin.graphql(DELETE_TRANSFORM, { variables: { id } });
    const dJson = await dRes.json();
    const err = dJson?.data?.cartTransformDelete?.userErrors?.[0]?.message;
    if (err) return json({ ok: false, message: err }, { status: 400 });

    return json({ ok: true, current: null });
  }

  return json({ ok: false, message: "Unknown intent" }, { status: 400 });
};

/* ------------ UI ------------ */

export default function CartTransformIndex() {
  const { current: loaderCurrent } = useLoaderData(); // <-- read persisted state on first load
  const fetcher = useFetcher();

  // Prefer action result when present; otherwise fall back to loader value
  const actionCurrent = fetcher.data?.current;
  const current = actionCurrent === undefined ? loaderCurrent : actionCurrent;

  const errorMsg = fetcher.data?.ok === false ? fetcher.data?.message : null;

  return (
    <Page title="Cart Transform">
      <Card>
        <BlockStack gap="400">
          {errorMsg ? (
            <Banner tone="critical" title="Error">
              <p>{errorMsg}</p>
            </Banner>
          ) : null}

          {current ? (
            <>
              <Text as="p">Status: <b>Enabled</b></Text>
              <Text as="p" variant="bodySm">id: {current.id}</Text>
              <InlineStack gap="300">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="disable" />
                  <input type="hidden" name="id" value={current.id} />
                  <Button tone="critical" variant="primary" submit>
                    Disable
                  </Button>
                </fetcher.Form>
              </InlineStack>
            </>
          ) : (
            <>
              <Text as="p">Status: <b>Disabled</b></Text>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="enable" />
                <Button variant="primary" submit>
                  Enable Cart Transform
                </Button>
              </fetcher.Form>
            </>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
