import { createFixtureApp } from './app';

const port = Number(process.env.PORT ?? '0');
const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: createFixtureApp().fetch });
console.log(`listening on http://127.0.0.1:${server.port}`);
