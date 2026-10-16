import { buildAgentKit } from './package.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
console.log('[agent:build] ' + buildAgentKit({ root: resolve(dirname(fileURLToPath(import.meta.url)), '../../..') }));
