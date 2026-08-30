import React from 'react';

const NS = 'docker';

const zh = {
  title: 'Docker 管理',
  description: '容器、镜像、网络、数据卷、Compose 管理',
  enabled: '启用插件',
};

const en = {
  title: 'Docker Management',
  description: 'Container, image, network, volume, Compose management',
  enabled: 'Enable plugin',
};

export const inject = ['settingsScope', 'slots', 'locale'];

export function apply(ctx: any) {
  ctx.effect?.(() => ctx.locale?.register?.(NS, { zh, en }), `dsh-${NS}: locale`);
  ctx.effect?.(() => {
    ctx.slots?.inject?.('settings.plugin.item', function* () {
      yield ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({}) }, Card);
    });
  }, `dsh-${NS}: settings`);
}

function Card(props: any) {
  const { scope, t } = props;
  const [open, setOpen] = React.useState(false);
  const s = { background: '#1a1a2e', color: '#e0e0e0', borderRadius: '8px', padding: '12px', marginBottom: '8px', border: '1px solid #333' } as React.CSSProperties;
  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', cursor: 'pointer', borderRadius: '4px', transition: 'background 0.15s' } as React.CSSProperties;
  const label = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px' } as React.CSSProperties;

  return React.createElement('li', { className: `dsh-${NS}-card`, style: s },
    React.createElement('div', { style: row, onClick: () => setOpen(!open), onMouseEnter: (e: any) => e.currentTarget.style.background = '#252540', onMouseLeave: (e: any) => e.currentTarget.style.background = 'transparent' },
      React.createElement('div', null,
        React.createElement('strong', { style: { fontSize: '14px' } }, '\uD83D\uDC33 ', t('title')),
        React.createElement('p', { style: { margin: '2px 0 0', fontSize: '12px', color: '#888' } }, t('description')),
      ),
      React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, open ? '\u25B2' : '\u25BC'),
    ),
    open ? React.createElement('div', { style: { padding: '8px 0', borderTop: '1px solid #333' } },
      React.createElement('label', { style: label },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('enabled') ?? true, onChange: (e: any) => scope?.set?.('enabled', e.target.checked) }),
        t('enabled'),
      ),
    ) : null,
  );
}
