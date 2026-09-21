import React, { useEffect, useState } from 'react';

export const inject = ['slots', 'connection'];
const h = React.createElement;
const labels = { 'signed-out': '尚未绑定', authorizing: '等待网页授权', binding: '正在保存绑定', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', disconnected: '已断开', revoked: '绑定已撤销', error: '连接失败' };

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
    const button = (label, method) => h('button', { key: method, type: 'button', disabled: busy, onClick: () => void action(method), style: { padding: '8px 14px', border: '1px solid currentColor', borderRadius: 6, cursor: busy ? 'wait' : 'pointer', background: 'transparent', color: 'inherit' } }, label);
    return h('section', { style: { maxWidth: 640, padding: 20, display: 'grid', gap: 16 } },
      h('h2', { style: { fontSize: 22, fontWeight: 600 } }, 'AgentLink'),
      h('p', null, '登录并绑定此 DSH，即可从 AgentLink 网页继续会话和处理审批。'),
      h('p', { role: 'status', 'aria-live': 'polite' }, labels[status?.state] ?? '正在读取状态…'),
      status && h('dl', null, h('dt', null, '当前实例'), h('dd', null, status.name), h('dt', null, '服务地址'), h('dd', { style: { overflowWrap: 'anywhere' } }, status.hub)),
      (error || status?.error) && h('p', { role: 'alert' }, error || status.error),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
        status?.machineId ? [button('重新连接', 'reconnect'), button('解绑此实例', 'logout'), h('a', { key: 'web', href: `${status.hub}/machines`, target: '_blank', rel: 'noopener noreferrer' }, '打开 AgentLink Web')]
          : button(busy ? '正在准备…' : '登录 AgentLink', 'login'),
        status?.loginUrl && h('a', { href: status.loginUrl, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'underline' } }, '前往 AgentLink 授权'),
        status?.state === 'authorizing' && button('取消登录', 'cancel')),
      h('p', { style: { fontSize: 12, opacity: 0.7 } }, '授权在 AgentLink 页面完成。解绑会停止此实例的远程访问。'));
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agentlink', label: 'AgentLink', order: 80 }, AgentLink));
}
