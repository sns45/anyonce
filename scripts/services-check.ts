#!/usr/bin/env bun
/** TCP connectivity check for the compose services in test/compose.yml. */
import { connect } from 'node:net';

export interface Service {
  name: string;
  host: string;
  port: number;
}

export const SERVICES: Service[] = [
  { name: 'dynamodb', host: '127.0.0.1', port: 18000 },
  { name: 'redis', host: '127.0.0.1', port: 6379 },
  { name: 'postgres', host: '127.0.0.1', port: 15432 },
  { name: 'redpanda', host: '127.0.0.1', port: 9092 },
  { name: 'elasticmq', host: '127.0.0.1', port: 9324 },
];

export function tcpOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function checkServices(
  services: Service[] = SERVICES,
): Promise<Array<{ name: string; up: boolean }>> {
  return Promise.all(
    services.map(async (s) => ({ name: s.name, up: await tcpOpen(s.host, s.port) })),
  );
}

if (import.meta.main) {
  const status = await checkServices();
  for (const s of status) console.log(`${s.name.padEnd(10)} ${s.up ? 'up' : 'DOWN'}`);
  process.exit(status.every((s) => s.up) ? 0 : 1);
}
