import React, { useEffect, useState } from 'react';

export const inject = ['slots', 'connection'];
const h = React.createElement;
const labels = { 'signed-out': '尚未绑定', authorizing: '等待网页授权', binding: '正在保存绑定', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', disconnected: '已断开', revoked: '绑定已撤销', error: '连接失败' };

const styles = `
.dsh-agentlink { display:flex; flex-direction:column; align-self:flex-start; gap:20px; width:100%; height:fit-content; box-sizing:border-box; padding:12px 0; color:var(--dsw-alias-label-primary, #18181b); font-family:inherit; font-size:14px; line-height:1.6; }
.dsh-agentlink h2,.dsh-agentlink p,.dsh-agentlink dl,.dsh-agentlink dd { margin:0; }
.dsh-agentlink h2 { font-size:16px; font-weight:500; line-height:24px; }
.dsh-agentlink p { font-size:13px; line-height:1.6; color:var(--dsw-alias-label-secondary, #71717a); }
.dsh-agentlink header { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.dsh-agentlink .al-status { display:inline-flex; align-items:center; gap:6px; margin-left:auto; font-size:12px; color:inherit; }
.dsh-agentlink .al-status::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; opacity:.45; }
.dsh-agentlink .al-status[data-connected=true]::before { background:#269768; opacity:1; }
.dsh-agentlink dl { display:grid; grid-template-columns:72px minmax(0,1fr); align-items:baseline; gap:10px 16px; padding:16px 0; border-block:1px solid var(--dsw-alias-border-default, #e5e7eb); font-size:13px; }
.dsh-agentlink dt { color:var(--dsw-alias-label-secondary, #71717a); }
.dsh-agentlink dd { overflow-wrap:anywhere; }
.dsh-agentlink .al-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.dsh-agentlink button,.dsh-agentlink a { display:inline-flex; align-items:center; justify-content:center; min-height:36px; box-sizing:border-box; padding:6px 14px; border:1px solid var(--dsw-alias-border-default, #e5e7eb); border-radius:10px; background:transparent; color:inherit; font:inherit; font-size:13px; line-height:22px; text-decoration:none; cursor:pointer; }
.dsh-agentlink .al-primary { background:var(--dsw-alias-label-primary, #18181b); color:var(--dsw-alias-bg-layer-2, #fff); border-color:transparent; }
.dsh-agentlink button:disabled { opacity:.5; cursor:wait; }
.dsh-agentlink :is(button,a):hover { opacity:.8; }
.dsh-agentlink :is(button,a):focus-visible { outline:2px solid currentColor; outline-offset:3px; }
.dsh-agentlink [role=alert] { color:#c2413b; }
`;

export function apply(ctx) {
  // The local authenticated connection owns management; the remote adapter
  // denies these endpoints even if a remote client forges the UI flag.
  if (globalThis.__DSH_AGENTLINK_VIEWER__ || !ctx.connection.isLoopback) return;
  function AgentLink() {
    const [status, setStatus] = useState();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    async function call(method) {
      const result = await ctx.connection.rpc.call('/api', `agentlink/${method}`, {});
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    useEffect(() => {
      let stopped = false, timer;
      async function poll() {
        try { const value = await call('status'); if (!stopped) setStatus(value); }
        catch { if (!stopped) setError('无法读取连接状态，请重试。'); }
        if (!stopped) timer = setTimeout(poll, 2000);
      }
      void poll();
      return () => { stopped = true; clearTimeout(timer); };
    }, []);
    async function action(method) {
      setBusy(true); setError('');
      try { setStatus(await call(method)); }
      catch (error) { setError(error.message); }
      finally { setBusy(false); }
    }
    const button = (label, method, primary = false) => h('button', { key: method, type: 'button', disabled: busy, onClick: () => void action(method), className: primary ? 'al-primary' : undefined }, label);
    return h('section', { className: 'dsh-agentlink' },
      h('style', null, styles),
      h('header', null, h('h2', null, 'AgentLink'), h('span', { className: 'al-status', role: 'status', 'aria-live': 'polite', 'data-connected': status?.state === 'connected' }, labels[status?.state] ?? '正在读取…')),
      h('p', null, '绑定后，可从其他电脑或手机的浏览器访问此 DSH。'),
      status && h('dl', null, h('dt', null, '当前实例'), h('dd', null, status.name), h('dt', null, '服务地址'), h('dd', null, status.hub)),
      (error || status?.error) && h('p', { role: 'alert' }, error || status.error),
      h('div', { className: 'al-actions' },
        status?.machineId ? [h('a', { key: 'web', className: 'al-primary', href: `${status.hub}/machines`, target: '_blank', rel: 'noopener noreferrer' }, '打开 AgentLink Web'), button('重新连接', 'reconnect'), button('解绑此实例', 'logout')]
          : !status?.loginUrl && button(busy ? '正在准备…' : '登录 AgentLink', 'login', true),
        status?.loginUrl && h('a', { className: 'al-primary', href: status.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, '前往 AgentLink 授权'),
        status?.state === 'authorizing' && button('取消登录', 'cancel')),
      h('p', null, status?.machineId ? '请保持 DSH 运行。解绑后，此实例将停止远程访问。' : '在 AgentLink 网页登录账号并确认绑定。'));

  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agentlink', label: 'AgentLink', order: 80 }, AgentLink));
}
