import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchProductsPaginated } from '../src/shopify.mjs';
import { buildItems } from '../src/feed.mjs';

const v = (id, extra = {}) => ({ id: `gid://shopify/ProductVariant/${id}`, title: `V${id}`, sku: `S${id}`, price: '100', compareAtPrice: null, availableForSale: true, inventoryQuantity: 1, inventoryItem: { tracked: true }, ...extra });
const product = (id, variants, hasMore = false) => ({
  id: `gid://shopify/Product/${id}`, handle: `p${id}`, title: `P${id}`, descriptionHtml: '', vendor: 'Monococo', productType: 'T', status: 'ACTIVE', onlineStoreUrl: 'https://x',
  media: { nodes: [{ id: 'm', image: { url: `https://cdn.shopify.com/${id}.jpg` } }, { id: 'video' }] },
  variants: { pageInfo: { hasNextPage: hasMore, endCursor: hasMore ? 'vc1' : null }, nodes: variants },
});

test('lee todas las tandas y las variantes extra', async () => {
  const calls = [];
  const client = {
    async graphql(query, vars) {
      calls.push(vars);
      if (query.includes('query page')) {
        if (!vars.cursor) return { products: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [product(1, [v(1)]), product(2, [v(2), v(3)], true)] } };
        return { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [product(3, [v(9)])] } };
      }
      assert.equal(vars.id, 'gid://shopify/Product/2');
      return { product: { variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [v(4)] } } };
    },
  };
  const products = await fetchProductsPaginated(client, { log: () => {} });
  assert.equal(products.length, 3);
  assert.deepEqual(products[1].variants.map((x) => x.id.split('/').pop()), ['2', '3', '4']);
  assert.deepEqual(products[0].images, ['https://cdn.shopify.com/1.jpg']);
  assert.equal(products[0].media, undefined);
  assert.equal(calls.length, 3);
  const { items } = buildItems(products, { storeUrl: 'https://monococojugueterias.com', currency: 'ARS' });
  assert.equal(items.length, 5);
});
