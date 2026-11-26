import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBridge } from './server.mjs';

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return new URL(`http://127.0.0.1:${server.address().port}`);
}

test('anonymous MCP is blocked and authenticated discovery and calls follow the saved contracts', async t => {
  const calls = [];
  const upstream = await listen(createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, key: req.headers['x-api-key'], payload: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
  }), t);
  const config = {
    renderer: upstream, rendererKey: 'test-key', pabbly: new URL('/test-webhook', upstream),
    resource: 'http://localhost/mcp', issuer: 'https://issuer.example'
  };
  const bridge = await listen(createBridge(config, async header => header === 'Bearer test-token'), t);
  const endpoint = new URL('/mcp', bridge);
  const anonymous = await fetch(endpoint);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata/);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: 'Bearer test-token' } }
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
      'renderProspectThumbnail', 'renderProspectVideoV2', 'sendProspectToPabblyV2'
    ]);
    const image = 'https://assets.example/image.png';
    const property = { property_address: '1 Test Way', interior_before_image_url: image, interior_after_image_url: image };
    assert.equal((await client.callTool({ name: 'renderProspectThumbnail', arguments: {} })).isError, true);
    assert.equal(calls.length, 0);
    assert.equal((await client.callTool({ name: 'renderProspectThumbnail', arguments: property })).isError, undefined);
    const identifiers = { prospect_id: 'test-1', agent_email: 'test@example.com', campaign_tag: 'VACANT_LISTING' };
    const video = {
      ...identifiers, ...property, qr_code_url: image, exterior_before_image_url: image, exterior_after_image_url: image,
      card_1: {}, card_2: { interior_original_label: 'Before', interior_final_label: 'After',
        exterior_original_label: 'Before', exterior_final_labels: ['GOLDEN HOUR EXTERIOR'] },
      narration_card_1: 'Test', narration_card_2: 'Test'
    };
    assert.equal((await client.callTool({ name: 'renderProspectVideoV2', arguments: video })).isError, undefined);
    const handoff = {
      ...identifiers, property_address: property.property_address, first_name: 'Test', mls_number: 'test-1',
      email_subject: 'Test', email_html: '<p>Test</p>', second_touch_email_subject: 'Test',
      second_touch_email_html: '<p>Test</p>', qr_code_image_url: image, qr_code_target_url: image,
      watch_url: image, thumbnail_url: image
    };
    assert.equal((await client.callTool({ name: 'sendProspectToPabblyV2', arguments: handoff })).isError, undefined);
    assert.deepEqual(calls.map(call => [call.path, call.key]), [
      ['/render-prospect-thumbnail', 'test-key'], ['/render-prospect-video-v2', 'test-key'], ['/test-webhook', undefined]
    ]);
    assert.deepEqual(calls[2].payload, handoff);
  } finally {
    await client.close();
  }
});
