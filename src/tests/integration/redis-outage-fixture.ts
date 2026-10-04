import { execFileSync } from 'child_process';

/**
 * The Redis container that the outage tests may stop, pause and start.
 *
 * It is named by explicit opt-in (WAVE3_REDIS_DESTRUCTIVE=1, WAVE3_REDIS_CONTAINER and
 * WAVE3_REDIS_CONTAINER_ID) and must prove that it is a fixture made for this: the same id, the
 * label `peakpass.redis-outage=owned`, and an explicit loopback host port equal to REDIS_PORT.
 * A port Docker chose is assigned again on every start, so only an explicit one lets the client
 * under test reconnect to the same address after a stop.
 */
export function ownedRedis(): { name: string; id: string; port: number; paused: boolean } {
  const name = process.env.WAVE3_REDIS_CONTAINER;
  const id = process.env.WAVE3_REDIS_CONTAINER_ID;
  if (
    process.env.WAVE3_REDIS_DESTRUCTIVE !== '1' ||
    !name ||
    !id ||
    process.env.REDIS_HOST !== '127.0.0.1'
  ) {
    throw new Error('Requires the explicit opt-in of a dedicated Redis outage fixture');
  }
  const info = JSON.parse(
    execFileSync('docker', ['inspect', name], { encoding: 'utf8', windowsHide: true }),
  )[0];
  const binding = info.HostConfig?.PortBindings?.['6379/tcp']?.[0];
  if (
    info.Id !== id ||
    info.Config?.Labels?.['peakpass.redis-outage'] !== 'owned' ||
    binding?.HostIp !== '127.0.0.1' ||
    !binding.HostPort ||
    binding.HostPort !== process.env.REDIS_PORT
  ) {
    throw new Error('Redis outage fixture ownership mismatch');
  }
  return { name, id, port: Number(binding.HostPort), paused: info.State?.Paused === true };
}
