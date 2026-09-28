// Standalone process: no forced exit on success, so leaked sockets/timers fail the parent test.
import { initRedis, getRedis, closeRedis } from '../../infra/redis/client';
import { checkRateLimit } from '../../infra/redis/commands';

const mode = process.argv[2];
const send = (state: string) => { if (process.connected) process.send?.({ state, pid: process.pid }); };
let operation: Promise<unknown>;
process.on('message', async (message) => {
  if (message === 'recreate') {
    operation = checkRateLimit('child', 'graphql', 10, 1000);
    send('recreating');
  }
  if (message === 'close') {
    await closeRedis();
    await operation;
    const result = await checkRateLimit('after-close', 'graphql', 10, 1000);
    if (result.redisAvailable) throw new Error('Shutdown permitted Redis command');
    send('closed');
    process.disconnect?.();
  }
});
operation = initRedis().then((client) => {
  send('ready');
  client.on('reconnecting', () => send('reconnecting'));
  client.on('error', () => { if (!client.isOpen) send('terminal'); });
}, async () => {
  if (mode === 'startup') {
    await closeRedis();
    send('startup-rejected');
    process.exitCode = 1;
    process.disconnect?.();
  }
});
if (mode === 'handshake') getRedis().on('connect', () => send('tcp-connected'));

if (mode === 'connecting') {
  // Same turn as initRedis: net.connect has started, but its connect event cannot have run.
  void (async () => {
    await closeRedis();
    await operation;
    send('closed');
    process.disconnect?.();
  })();
}
