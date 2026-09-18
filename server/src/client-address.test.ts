import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAddress } from './client-address';

test('proxy headers are trusted only from configured peers and contain one canonical address', () => {
  assert.equal(clientAddress('203.0.113.1', '198.51.100.5', []), '203.0.113.1');
  assert.equal(clientAddress('203.0.113.1', '198.51.100.5', ['127.0.0.1']), '203.0.113.1');
  assert.equal(clientAddress('::ffff:127.0.0.1', '198.51.100.5', ['127.0.0.1']), '198.51.100.5');
  assert.equal(clientAddress('127.0.0.1', 'fake, 198.51.100.5', ['127.0.0.1']), '127.0.0.1');
  assert.equal(clientAddress('127.0.0.1', '2001:0db8:0:0:0:0:0:1', ['127.0.0.1']), '2001:db8::1');
});
