import { DurableObject } from 'cloudflare:workers';

/** Placeholder until the Durable Objects store task lands; keeps the workers test host bootable. */
export class IdempotencyObject extends DurableObject {}
