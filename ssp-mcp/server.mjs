import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const definitions = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url)));
const validator = new Ajv();
addFormats(validator);
const validate = Object.fromEntries(
  Object.entries(definitions).map(([name, definition]) => [name, validator.compile(definition.inputSchema)])
);
const paths = {
  renderProspectVideoV2: '/render-prospect-video-v2',
  renderProspectThumbnail: '/render-prospect-thumbnail'
};
const toolError = (text) => ({ isError: true, content: [{ type: 'text', text }] });

export function createBridge(config, authorize) {
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', config.resource);
  return createServer(async (req, res) => {
    const path = new URL(req.url, config.resource).pathname;
    if (req.method === 'GET' && path === '/health') {
      return res.writeHead(200).end('ok');
    }
    if (req.method === 'GET' && path === metadata.pathname) {
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        resource: config.resource,
        authorization_servers: [config.issuer],
        bearer_methods_supported: ['header']
      }));
    }
    if (path !== '/mcp') return res.writeHead(404).end();
    if (!(await authorize(req.headers.authorization))) {
      return res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${metadata.href}"` }).end();
    }

    const server = new Server({ name: 'ssp-prospect-mcp', version: '1.0.0' }, {
      capabilities: { tools: {} }
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Object.entries(definitions).map(([name, definition]) => ({
        name,
        ...definition,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      }))
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: payload } }) => {
      if (!Object.hasOwn(validate, name)) return toolError('Unknown operation.');
      if (!validate[name](payload)) return toolError('The input does not match the prospect schema.');
      if (name === 'renderProspectVideoV2') {
        const review = payload.campaign_tag === 'VIRTUAL_STAGING_REVIEW';
        if (!(review ? payload.card_2_caption_text : payload.narration_card_2)) {
          return toolError('Card 2 requires the campaign-specific captions or narration.');
        }
      }
      const isHandoff = name === 'sendProspectToPabblyV2';
      const url = isHandoff ? config.pabbly : new URL(paths[name], config.renderer);
      if (!url) return toolError('Pabbly V2 handoff is disabled.');
      const headers = { 'Content-Type': 'application/json' };
      if (!isHandoff) headers['x-api-key'] = config.rendererKey;
      try {
        const response = await fetch(url, {
          method: 'POST', headers, body: JSON.stringify(payload),
          redirect: 'error', signal: AbortSignal.timeout(180_000)
        });
        if (!response.ok) return toolError(`Upstream returned HTTP ${response.status}.`);
        const data = isHandoff ? { accepted: true } : await response.json();
        if (!isHandoff && data.success !== true) return toolError('Renderer did not report success.');
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch {
        return toolError('Upstream result is unknown. Check for an existing result before retrying.');
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    }
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Expected an HTTPS URL');
  return url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resource = httpsUrl(required('SSP_MCP_RESOURCE_URL')).href;
  if (new URL(resource).pathname !== '/mcp' || new URL(resource).search) throw new Error('Expected a canonical /mcp URL');
  const issuer = required('SSP_MCP_OAUTH_ISSUER');
  httpsUrl(issuer);
  const subject = required('SSP_MCP_ALLOWED_SUBJECT');
  const jwks = createRemoteJWKSet(httpsUrl(required('SSP_MCP_JWKS_URL')));
  const config = {
    resource, issuer,
    renderer: httpsUrl(required('SSP_MCP_RENDERER_URL')),
    rendererKey: required('SSP_MCP_RENDERER_API_KEY'),
    pabbly: process.env.SSP_MCP_PABBLY_V2_WEBHOOK && httpsUrl(process.env.SSP_MCP_PABBLY_V2_WEBHOOK)
  };
  const authorize = async (header) => {
    const token = /^Bearer (\S+)$/i.exec(header || '')?.[1];
    if (!token) return false;
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer, audience: resource, subject, requiredClaims: ['exp']
      });
      return typeof payload.exp === 'number';
    } catch {
      return false;
    }
  };
  createBridge(config, authorize).listen(process.env.PORT || 3000, '0.0.0.0');
}
