import type { ObservedResponse, StepRequest } from './types';

export type FetchHandler = (request: Request) => Response | Promise<Response>;
export type Target = FetchHandler | { baseUrl: string };
export type Sender = (req: StepRequest) => Promise<ObservedResponse>;

const IN_PROCESS_ORIGIN = 'http://conformance.invalid';

function buildInit(req: StepRequest): RequestInit {
  const init: RequestInit = { method: req.method, headers: req.headers ?? {} };
  if (req.body !== undefined) init.body = req.body;
  return init;
}

async function observe(response: Response): Promise<ObservedResponse> {
  const body = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body };
}

/** Wraps a target as a function that sends one step request and reads the whole response. */
export function toSender(target: Target): Sender {
  if (typeof target === 'function') {
    return async (req) =>
      observe(await target(new Request(IN_PROCESS_ORIGIN + req.path, buildInit(req))));
  }
  const base = target.baseUrl.replace(/\/$/, '');
  return async (req) => observe(await fetch(base + req.path, buildInit(req)));
}
