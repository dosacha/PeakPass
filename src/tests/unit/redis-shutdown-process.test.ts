import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { createServer, Socket } from 'net';

// Real TCP blackhole deliberately withholds Redis handshake replies.
// This catches shutdown while node-redis owns a pending socket/init promise.
it.each(['connecting', 'shutdown', 'timeout'])('closes pending handshake TCP sockets and exits naturally after %s', async (mode) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '../helpers/redis-lifecycle-child.ts'), mode === 'timeout' ? 'startup' : mode === 'shutdown' ? 'handshake' : 'connecting'], {
      windowsHide: true,
      env: { ...process.env, REDIS_HOST: '127.0.0.1', REDIS_PORT: String(address.port), LOG_LEVEL: 'fatal' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const states: string[] = [];
    let errors = '';
    child.stderr!.on('data', (data) => { errors += data; });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child!.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.on('message', (message: { state: string }) => {
      states.push(message.state);
      if (message.state === 'tcp-connected') child!.send('close');
    });
    const result = await Promise.race([exit, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child did not exit: ${states}; ${errors}`)), 10000);
      exit.then(() => clearTimeout(timer));
    })]);
    expect(result).toEqual({ code: mode === 'timeout' ? 1 : 0, signal: null });
    expect(states).toEqual(mode === 'timeout' ? ['startup-rejected'] : mode === 'shutdown' ? ['tcp-connected', 'closed'] : ['closed']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sockets.size).toBe(0);
    process.stdout.write(JSON.stringify({ childPid: child.pid, result, states, sockets: sockets.size }) + '\n');
  } finally {
    if (child?.exitCode === null) child.kill(); // failure cleanup only; never accepted as success
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
