import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assembleProducts, buildItems, renderXml, htmlToText, formatPrice, escapeXml } from '../src/feed.mjs';

const lines = readFileSync(new URL('./fixtures/sample.jsonl', import.meta.url), 'utf8').split('\n');
const opts = { storeUrl: 'https://monococojugueterias.com', currency: 'ARS' };
const { items, stats } = buildItems(assembleProducts(lines), opts);
const byVariant = Object.fromEntries(items.map((i) => [i.variantId, i]));

test('exporta solo variantes con stock, imagen y precio', () => {
  assert.deepEqual(Object.keys(byVariant).sort(), ['101', '201', '202', '205']);
  assert.deepEqual(stats.excluded, { not_active: 0, not_published: 1, no_image: 1, price_zero: 1, out_of_stock: 2 });
  assert.equal(stats.exported, 4);
});

test('precio tachado: compareAt mayor que price', () => {
  assert.equal(byVariant['101'].price, '12999.50 ARS');
  assert.equal(byVariant['101'].salePrice, '9999.00 ARS');
  // compareAt menor que price: se ignora
  assert.equal(byVariant['202'].price, '1500.00 ARS');
  assert.equal(byVariant['202'].salePrice, null);
});

test('id: SKU único, si no ID de variante', () => {
  assert.equal(byVariant['101'].id, 'ADV-001');
  assert.equal(byVariant['201'].id, '201'); // SKU duplicado
  assert.equal(byVariant['205'].id, '205'); // SKU vacío
  assert.deepEqual(stats.duplicateSkus, [{ sku: 'DUP', count: 2 }]);
  assert.equal(stats.emptySkus, 1);
});

test('variantes: item_group_id y título con variante', () => {
  assert.equal(byVariant['101'].groupId, null);
  assert.equal(byVariant['101'].title, 'Calendario de Adviento Monococo');
  assert.equal(byVariant['201'].groupId, '2');
  assert.equal(byVariant['201'].title, 'Pelota "Rebote" <XL> - Roja');
});

test('link al dominio público e imágenes', () => {
  assert.equal(byVariant['101'].link, 'https://monococojugueterias.com/products/calendario-adviento?variant=101');
  assert.equal(byVariant['101'].image, 'https://cdn.shopify.com/a1.jpg');
  assert.deepEqual(byVariant['101'].additionalImages, ['https://cdn.shopify.com/a2.jpg']);
});

test('descripción en texto plano; vacía usa el título', () => {
  assert.equal(byVariant['101'].description, 'Calendario exclusivo & divertido.\nEdad: 3 años <3');
  assert.equal(byVariant['201'].description, 'Pelota "Rebote" <XL>');
  assert.equal(htmlToText('&#225;&#x00F1;'), 'áñ');
});

test('formato de precio', () => {
  assert.equal(formatPrice('1234567.891', 'ARS'), '1234567.89 ARS');
  assert.equal(formatPrice('0', 'ARS'), null);
  assert.equal(formatPrice('abc', 'ARS'), null);
});

test('XML escapado y sin caracteres inválidos', () => {
  assert.equal(escapeXml('a&b<c>"d\'\u0001'), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  const xml = renderXml(items, { storeUrl: opts.storeUrl, title: 'T', description: 'D', buildDate: new Date(0) });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<lastBuildDate>Thu, 01 Jan 1970 00:00:00 GMT<\/lastBuildDate>/);
  assert.match(xml, /<g:brand>Marca &amp; Cía<\/g:brand>/);
  assert.ok(!xml.includes('<script>'));
  assert.equal((xml.match(/<item>/g) || []).length, 4);
});
