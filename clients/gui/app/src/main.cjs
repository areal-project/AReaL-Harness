'use strict';

// 只装配当前桌面客户端；不提供旧 GUI 或其他后端回退入口。
require(process.argv.some(value => value.startsWith('--areal-core-service'))
  ? './core/service-main.cjs'
  : './core/main.cjs');
