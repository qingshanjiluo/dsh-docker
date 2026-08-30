/**
 * dsh-docker 客户端 — 设置卡片
 */
import React from 'react';
const NS = 'docker';
const zh = { title: 'Docker 管理', description: '容器、镜像、网络、数据卷、Compose 管理', enabled: '启用插件' };
const en = { title: 'Docker Management', description: 'Container, image, network, volume, Compose management', enabled: 'Enable plugin' };

export const inject = ['settingsScope', 'slots', 'locale'];

export function apply(ctx: any) {
  const t = ctx.locale?.bind(NS) || ((k: string) => (zh as any)[k] || k);
  ctx.effect?.(() => ctx.locale?.register?.(NS, { zh, en }), 'dsh-docker: locale');
  ctx.effect?.(() => {
    ctx.slots?.inject?.('settings.plugin.item', function* () {
      yield ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({}) }, DockerCard);
    });
  }, 'dsh-docker: settings card');
}

function DockerCard(props: any) {
  const { scope, t } = props;
  const [open, setOpen] = React.useState(false);
  return React.createElement('li', { className: 'dsh-docker-card' },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', cursor: 'pointer' }, onClick: () => setOpen(!open) },
      React.createElement('div', null, React.createElement('strong', null, '🐳 ', t('title')), React.createElement('p', { style: { margin: '2px 0 0', fontSize: '12px', color: '#888' } }, t('description'))),
      React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, open ? '▲' : '▼')),
    open ? React.createElement('div', { style: { padding: '8px 0', borderTop: '1px solid #333' } },
      React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('enabled') ?? true, onChange: (e: any) => scope?.set?.('enabled', e.target.checked) }),
        t('enabled'))) : null);
}
