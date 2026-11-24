#!/usr/bin/env node
// Genera public/catalogo.xml con el catálogo de Monococo en formato feed de Meta.
//
// Uso:
//   node src/build-feed.mjs                      -> consulta Shopify (requiere credencial)
//   node src/build-feed.mjs --from-file x.jsonl  -> usa un archivo local (pruebas, sin token)

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { assembleProducts, buildItems, renderXml } from './feed.mjs';
import { ShopifyError, createClient, fetchProductsJsonl, fetchProductsPaginated, getAccessToken, validateConfig } from './shopify.mjs';

const env = process.env;
const config = {
  shopDomain: (env.SHOPIFY_STORE_DOMAIN || 'jugueterias-monococo.myshopify.com').trim().toLowerCase(),
  apiVersion: (env.SHOPIFY_API_VERSION || '2026-10').trim(),
  storeUrl: (env.PUBLIC_STORE_URL || 'https://monococojugueterias.com').trim(),
  currency: (env.FEED_CURRENCY || 'ARS').trim().toUpperCase(),
  outputDir: env.OUTPUT_DIR || 'public',
  outputFile: 'catalogo.xml',
  // Freno de seguridad: si salen menos ítems que esto, NO se publica
  // (queda online la última versión buena).
  minItems: !env.MIN_ITEMS?.trim() ? 1000 : /^\d+$/.test(env.MIN_ITEMS.trim()) ? Number(env.MIN_ITEMS.trim()) : NaN,
};

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function validatePublicConfig() {
  let url;
  try { url = new URL(config.storeUrl); } catch { fail('PUBLIC_STORE_URL no es una URL válida.'); }
  if (url.protocol !== 'https:') fail('PUBLIC_STORE_URL tiene que empezar con https://');
  if (url.hostname.endsWith('.myshopify.com')) fail('PUBLIC_STORE_URL tiene que ser el dominio público, no el .myshopify.com');
  if (!/^[A-Z]{3}$/.test(config.currency)) fail('FEED_CURRENCY tiene que ser un código de 3 letras (ej. ARS).');
  if (!Number.isInteger(config.minItems) || config.minItems < 0) fail('MIN_ITEMS tiene que ser un número entero (solo dígitos).');
}

async function loadProducts() {
  const i = process.argv.indexOf('--from-file');
  if (i !== -1) {
    const file = process.argv[i + 1];
    if (!file) fail('Falta la ruta después de --from-file');
    return assembleProducts((await readFile(file, 'utf8')).split('\n'));
  }
  validateConfig(config);
  const token = await getAccessToken({
    shopDomain: config.shopDomain,
    adminToken: env.SHOPIFY_ADMIN_TOKEN?.trim(),
    clientId: env.SHOPIFY_CLIENT_ID?.trim(),
    clientSecret: env.SHOPIFY_CLIENT_SECRET?.trim(),
  });
  const client = createClient({ shopDomain: config.shopDomain, apiVersion: config.apiVersion, token });
  // Con token fijo usamos la exportación masiva (más rápida). Las llaves del
  // Dev Dashboard no la tienen permitida: en ese caso leemos por tandas.
  if (env.SHOPIFY_ADMIN_TOKEN?.trim() && env.FEED_MODE !== 'paginated') {
    return assembleProducts(await fetchProductsJsonl(client));
  }
  return fetchProductsPaginated(client);
}

function report(stats) {
  const e = stats.excluded;
  const lines = [
    `Productos leídos: ${stats.productsRead}`,
    `Variantes leídas: ${stats.variantsRead}`,
    `Ítems exportados: ${stats.exported}`,
    `Excluidos sin stock: ${e.out_of_stock}`,
    `Excluidos sin imagen: ${e.no_image}`,
    `Excluidos con precio 0: ${e.price_zero}`,
    `Excluidos no activos: ${e.not_active}`,
    `Excluidos no publicados en la tienda online: ${e.not_published}`,
    `SKUs vacíos (se usó el ID de variante): ${stats.emptySkus}`,
    `SKUs demasiado largos (se usó el ID de variante): ${stats.skuTooLong}`,
    `SKUs duplicados: ${stats.duplicateSkus.length}`,
  ];
  console.log(lines.join('\n'));
  if (stats.duplicateSkus.length) {
    console.log('Detalle de SKUs duplicados (se usó el ID de variante):');
    for (const d of stats.duplicateSkus) console.log(`  - ${d.sku} (x${d.count})`);
  }
  return lines;
}

async function main() {
  validatePublicConfig();
  const products = await loadProducts();
  const { items, stats } = buildItems(products, config);
  const summary = report(stats);

  if (items.length === 0 || items.length < config.minItems) {
    fail(`Se generaron ${items.length} ítems, menos que el mínimo (${config.minItems}). No se publica para no pisar el feed bueno.`);
  }

  const xml = renderXml(items, {
    storeUrl: config.storeUrl,
    title: 'Monococo Jugueterías',
    description: 'Catálogo de productos Monococo',
  });
  await mkdir(config.outputDir, { recursive: true });
  const out = path.join(config.outputDir, config.outputFile);
  await writeFile(out, xml, 'utf8');
  console.log(`Feed escrito en ${out} (${(Buffer.byteLength(xml) / 1024 / 1024).toFixed(2)} MB).`);

  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `## Feed Monococo\n\n${summary.map((l) => `- ${l}`).join('\n')}\n`);
  }
}

main().catch((err) => {
  // Solo mostramos mensajes propios; nunca el objeto de error completo
  // (podría incluir encabezados con la credencial).
  if (err instanceof ShopifyError) fail(err.message);
  if (err instanceof SyntaxError) fail('El resultado de Shopify no es JSON válido.');
  fail(`Error inesperado (${err.name}).`);
});
