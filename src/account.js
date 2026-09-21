import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { connectHost } from './host-tunnel.js';

const RECORD = 'agentlink/binding';
export function normalizeHub(value = 'https://link.harmopath.com') {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Hub 必须是 HTTPS 地址（本地测试可用 HTTP）。');
  return url.origin;
}

export class Account {
  constructor(ctx, config, adapter) {
    this.ctx = ctx;
    this.hub = normalizeHub(config.hubUrl);
    this.name = (config.name || `DSH · ${hostname()}`).slice(0, 64);
    this.adapter = adapter;
    this.state = 'signed-out';
    this.error = '';
    this.disposed = false;
    this.connectEpoch = 0;
  }
  async init() {
    const saved = await this.ctx.credentials.readRecord(RECORD);
    if (saved?.kind === 'grant') {
      const value = saved.payload;
      if (value?.hub !== this.hub || typeof value.authToken !== 'string' || typeof value.machineId !== 'string' || !/^[\w-]{43}$/.test(value.enckey)) throw new Error('已保存的绑定与中继配置不匹配，请先使用原配置解绑。');
      this.binding = value;
      await this.connect();
    }
  }
  status() { return { state: this.state, error: this.error, name: this.name, hub: this.hub, machineId: this.binding?.machineId, loginUrl: this.loginUrl }; }
  async api(path, { token, method = 'POST', body } = {}) {
    const response = await fetch(new URL(path, this.hub), {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'agentlink', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`AgentLink 请求失败（${response.status}），请重试。`), { status: response.status });
    return result;
  }
  async login() {
    if (this.binding || this.state === 'binding') throw new Error('请先完成或解除当前绑定。');
    this.cancelLogin();
    this.state = 'authorizing'; this.error = '';
    const code = randomBytes(24).toString('base64url');
    const enckey = randomBytes(32).toString('base64url');
    const url = new URL('/daemon', this.hub);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('pair', code); url.searchParams.set('host', this.name); url.searchParams.set('runtime', 'dsh');
    const ws = this.pairSocket = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 16_384 });
    let claimed = false;
    await new Promise((resolve, reject) => {
      this.pairReject = reject;
      const fail = () => {
        if (this.pairSocket !== ws || claimed) return;
        this.cancelLogin(); this.state = 'error'; this.error = '绑定连接已关闭或超时，请重新登录。';
        reject(new Error(this.error));
      };
      this.loginTimer = setTimeout(fail, 10 * 60_000);
      ws.on('error', fail);
      ws.on('close', fail);
      ws.on('message', async raw => {
        if (this.pairSocket !== ws || claimed) return;
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'pair_pending') {
            this.loginUrl = `${this.hub}/dsh/authorize#code=${code}`;
            resolve();
            this.pairReject = undefined;
          } else if (message.type === 'claimed') {
            claimed = true; this.state = 'binding'; clearTimeout(this.loginTimer); this.loginUrl = undefined;
            const parts = typeof message.token === 'string' ? message.token.split('.') : [];
            if (parts.length !== 3 || parts[0] !== 'al1') throw new Error('无效的机器凭证。');
            const { mid: machineId } = JSON.parse(Buffer.from(parts[1], 'base64url'));
            if (typeof machineId !== 'string' || !machineId) throw new Error('无效的实例标识。');
            const binding = { hub: this.hub, authToken: message.token, machineId, enckey };
            try {
              await this.ctx.credentials.modifyRecord(RECORD, () => ({ kind: 'grant', payload: binding }));
            } catch (error) {
              await this.api('/api/machines/self', { token: binding.authToken, method: 'DELETE' });
              throw error;
            }
            this.binding = binding;
            this.pairSocket = undefined; ws.close();
            await this.connect();
          }
        } catch {
          this.state = 'error'; this.error = '绑定未完成，请重试连接或解绑后重试。';
          this.pairSocket = undefined; clearTimeout(this.loginTimer); this.loginUrl = undefined; ws.close();
          reject(new Error(this.error));
        }
      });
    });
    return this.status();
  }
  cancelLogin() {
    if (this.state === 'binding') throw new Error('正在保存绑定，请稍候。');
    clearTimeout(this.loginTimer);
    this.pairReject?.(new Error('授权已取消。')); this.pairReject = undefined;
    const ws = this.pairSocket; this.pairSocket = undefined; ws?.close();
    this.loginUrl = undefined;
    if (this.state === 'authorizing') this.state = 'signed-out';
  }
  async uploadKey() {
    const binding = this.binding;
    if (binding) await this.api(`/api/machines/${encodeURIComponent(binding.machineId)}/enckey`, { token: binding.authToken, body: { enckey: binding.enckey } });
  }
  async connect() {
    const epoch = ++this.connectEpoch;
    this.stop?.();
    if (!this.binding || this.disposed) return;
    this.state = 'connecting'; this.error = '';
    try { await this.uploadKey(); }
    catch (error) {
      if (this.disposed || epoch !== this.connectEpoch) return;
      if ([401, 403, 404].includes(error.status)) {
        await this.ctx.credentials.deleteRecord(RECORD);
        this.binding = undefined; this.state = 'revoked'; this.error = '绑定已失效，请重新登录。';
      } else { this.state = 'error'; this.error = error.message; }
      return;
    }
    if (this.disposed || !this.binding || epoch !== this.connectEpoch) return;
    this.stop = connectHost({ ...this.binding, ...this.adapter,
      onStatus: state => { this.state = state; },
      onRevoked: async () => {
        try { await this.ctx.credentials.deleteRecord(RECORD); this.binding = undefined; }
        catch { this.error = '访问已撤销，但本地凭证清理失败，请重试解绑。'; }
      },
      onRecover: () => this.uploadKey(),
    });
  }
  async logout() {
    this.connectEpoch++;
    this.cancelLogin(); this.stop?.(); this.state = 'disconnected';
    if (this.binding) {
      try { await this.api('/api/machines/self', { token: this.binding.authToken, method: 'DELETE' }); }
      catch (error) { if (![401, 403, 404].includes(error.status)) throw error; }
    }
    await this.ctx.credentials.deleteRecord(RECORD);
    this.binding = undefined; this.state = 'signed-out'; this.error = '';
    return this.status();
  }
  dispose() {
    this.connectEpoch++;
    this.pairReject?.(new Error('插件已停止。')); this.pairReject = undefined;
    this.disposed = true; clearTimeout(this.loginTimer);
    const ws = this.pairSocket; this.pairSocket = undefined; ws?.close(); this.stop?.();
  }
}
