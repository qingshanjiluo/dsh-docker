import React from 'react';
import { createSettingsCard } from '@deepseek-ai/dsh-settings';

export default createSettingsCard({
  title: 'docker',
  description: 'Docker 容器管理',
  config: [
    { key: 'enabled', type: 'boolean', label: '启用插件', default: true },
    { key: 'dockerPath', type: 'string', label: 'Docker 路径', default: 'docker' },
    { key: 'composePath', type: 'string', label: 'Compose 路径', default: 'docker-compose' },
    { key: 'defaultTimeout', type: 'number', label: '默认超时(ms)', default: 30000 },
  ],
});
