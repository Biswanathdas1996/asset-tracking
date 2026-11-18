import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coinImageUrl } from '../src/services/coingecko.js';

test('keeps CoinGecko coin images and drops anything else', () => {
  const pol = 'https://coin-images.coingecko.com/coins/images/32440/small/pol.png?1759114181';
  assert.equal(coinImageUrl(pol), pol);
  assert.equal(coinImageUrl('https://assets.coingecko.com/coins/images/1/small/bitcoin.png'), 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png');
  assert.equal(coinImageUrl('http://coin-images.coingecko.com/coins/images/1/small/bitcoin.png'), null);
  assert.equal(coinImageUrl('https://evil.example/pol.png'), null);
  assert.equal(coinImageUrl(''), null);
  assert.equal(coinImageUrl(null), null);
});
