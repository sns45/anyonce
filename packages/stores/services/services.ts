import { describe, test } from 'bun:test';
import { connect } from 'node:net';

export function tcpOpen(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
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

/** Registers the suite when the service answers; otherwise one skipped test that names the fix. */
export async function describeService(name: string, port: number, fn: () => void): Promise<void> {
  const up = await tcpOpen(port);
  if (up) {
    describe(name, fn);
    return;
  }
  test.skip(`${name}: service down on 127.0.0.1:${port}; run docker compose -f test/compose.yml up -d --wait`, () => {});
}
