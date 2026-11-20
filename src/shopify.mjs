// Comunicación con Shopify (solo lectura). Reglas de seguridad:
// - El token solo se envía al dominio de la tienda, validado abajo.
// - El token nunca se imprime: los errores muestran solo código y mensaje de Shopify.
// - La descarga del resultado (URL firmada de Shopify) se hace SIN token.

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const API_VERSION_RE = /^\d{4}-\d{2}$/;

export const PRODUCTS_BULK_QUERY = `
{
  products(query: "status:active AND published_status:published") {
    edges {
      node {
        id
        handle
        title
        descriptionHtml
        vendor
        productType
        status
        media {
          edges {
            node {
              id
              ... on MediaImage { image { url } }
            }
          }
        }
        variants {
          edges {
            node {
              id
              title
              sku
              price
              compareAtPrice
              availableForSale
              inventoryQuantity
              inventoryItem { tracked }
            }
          }
        }
      }
    }
  }
}`;

export class ShopifyError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateConfig({ shopDomain, apiVersion }) {
  if (!SHOP_DOMAIN_RE.test(shopDomain || '')) {
    throw new ShopifyError('SHOPIFY_STORE_DOMAIN inválido: tiene que ser del tipo "mitienda.myshopify.com".');
  }
  if (!API_VERSION_RE.test(apiVersion || '')) {
    throw new ShopifyError('SHOPIFY_API_VERSION inválida: tiene que ser del tipo "2026-10".');
  }
}

// Devuelve un token de acceso. Acepta dos formas:
//  1) SHOPIFY_ADMIN_TOKEN (token fijo de una app personalizada), o
//  2) SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (apps del Dev Dashboard:
//     se pide un token temporal en cada corrida).
export async function getAccessToken({ shopDomain, adminToken, clientId, clientSecret }) {
  if (adminToken) return adminToken;
  if (!clientId || !clientSecret) {
    throw new ShopifyError(
      'Falta la credencial de Shopify: definí SHOPIFY_ADMIN_TOKEN, o SHOPIFY_CLIENT_ID y SHOPIFY_CLIENT_SECRET.',
    );
  }
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    redirect: 'error',
  });
  if (!res.ok) throw new ShopifyError(`Shopify rechazó el pedido de token (HTTP ${res.status}). Revisá el client ID/secret.`);
  const body = await res.json();
  if (!body.access_token) throw new ShopifyError('Shopify no devolvió un token de acceso.');
  return body.access_token;
}

export function createClient({ shopDomain, apiVersion, token }) {
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  async function graphql(query, variables = {}) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query, variables }),
          redirect: 'error', // nunca seguir redirecciones con el token puesto
        });
      } catch (err) {
        if (attempt === 5) throw new ShopifyError(`No se pudo conectar con Shopify (${err.cause?.code || err.name}).`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 5) throw new ShopifyError(`Shopify respondió HTTP ${res.status} varias veces.`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyError(`Shopify rechazó la credencial (HTTP ${res.status}). Revisá el token y los permisos read_products/read_inventory.`);
      }
      if (!res.ok) throw new ShopifyError(`Shopify respondió HTTP ${res.status}.`);
      const body = await res.json();
      if (body.errors) {
        const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
        if (throttled && attempt < 5) { await sleep(2000 * attempt); continue; }
        throw new ShopifyError(`Error de GraphQL: ${body.errors.map((e) => e.message).join(' | ')}`);
      }
      return body.data;
    }
    throw new ShopifyError('Shopify no respondió.');
  }

  return { graphql };
}

const RUN_BULK = `
mutation run($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const POLL_BULK = `
query poll($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
  }
}`;

// Lanza la Bulk Operation, espera a que termine y devuelve las líneas JSONL.
export async function fetchProductsJsonl(client, { log = console.log, timeoutMs = 25 * 60 * 1000 } = {}) {
  const started = await client.graphql(RUN_BULK, { query: PRODUCTS_BULK_QUERY });
  const { bulkOperation, userErrors } = started.bulkOperationRunQuery;
  if (userErrors?.length) throw new ShopifyError(`No se pudo iniciar la exportación: ${userErrors.map((e) => e.message).join(' | ')}`);
  log(`Exportación iniciada en Shopify (${bulkOperation.id}).`);

  const deadline = Date.now() + timeoutMs;
  let wait = 3000;
  let op;
  while (true) {
    await sleep(wait);
    wait = Math.min(wait * 1.5, 20000);
    op = (await client.graphql(POLL_BULK, { id: bulkOperation.id })).node;
    if (!op) throw new ShopifyError('Shopify no encontró la exportación.');
    if (op.status === 'COMPLETED') break;
    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(op.status)) {
      throw new ShopifyError(`La exportación terminó con estado ${op.status} (${op.errorCode || 'sin código'}).`);
    }
    if (Date.now() > deadline) throw new ShopifyError('La exportación de Shopify tardó demasiado.');
  }
  log(`Exportación completa: ${op.objectCount} objetos.`);
  if (!op.url) return []; // la tienda no devolvió resultados

  const url = new URL(op.url);
  if (url.protocol !== 'https:') throw new ShopifyError('La URL de descarga de Shopify no es https.');
  // Descarga sin token: es una URL firmada y temporal.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new ShopifyError(`No se pudo descargar el resultado (HTTP ${res.status}).`);
  const text = await res.text();
  return text.split('\n');
}
