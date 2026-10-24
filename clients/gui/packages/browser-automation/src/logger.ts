import { debuglog } from 'node:util';
const debug = debuglog('areal-browser');
export const logger = { debug: (message: string, facts?: unknown) => debug(message, facts) };
