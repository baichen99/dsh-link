import { readFile } from 'node:fs/promises';
import { Account } from './account.js';

export const name = 'agentlink';
export const inject = ['connection', 'typertGateway', 'clientModules', 'webServer', 'credentials'];

export async function apply(ctx, config = {}) {
  const shared = ctx.connection.createSharedFetchHandler('/api');
  const [viewer, css] = await Promise.all([
    readFile(new URL('../dist/viewer.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/viewer.css', import.meta.url), 'utf8'),
  ]);
  const script = viewer.replaceAll('</script', '<\\/script');
  const account = new Account(ctx, config, {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/agentlink/bootstrap') {
        const injections = ctx.webServer.renderIndex('<!doctype html><html><head></head><body></body></html>');
        const data = JSON.stringify(injections).replaceAll('<', '\\u003c');
        const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src blob: data:; font-src data: blob:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'";
        return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css.replaceAll('</style', '<\\/style')}</style></head><body><div id="root"></div><script id="dsh-injections" type="application/json">${data}</script><script>${script}</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-dsh-viewer-ready': '1' } });
      }
      if (path.startsWith('/plugins/')) return ctx.clientModules.fetchBundle(request);
      return shared.fetch(request);
    },
    openStream: (endpoint, payload, signal) => ctx.typertGateway.wireStream.open(endpoint, payload, signal),
  });
  ctx.effect(() => () => account.dispose());
  async function manage(endpoint) {
    try {
      let value;
      if (endpoint === 'status') value = account.status();
      else if (endpoint === 'login') value = await account.login();
      else if (endpoint === 'logout') value = await account.logout();
      else if (endpoint === 'reconnect') { await account.connect(); value = account.status(); }
      else if (endpoint === 'cancel') { account.cancelLogin(); value = account.status(); }
      else throw new Error('未知操作。');
      return { ok: true, value };
    } catch (error) { return { ok: false, error: { code: 'agentlink/error', message: error.message, details: {} } }; }
  }
  for (const endpoint of ['status', 'login', 'logout', 'reconnect', 'cancel']) {
    ctx.connection.fetch.register({
      path: `/api/agentlink/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let message;
        try { message = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.rpcId.length > 128) return new Response('Invalid request', { status: 400 });
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: await manage(endpoint) });
      },
    });
  }
  await account.init();
}
