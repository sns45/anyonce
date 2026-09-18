import { type Store, validateKey } from '@anyonce/core';
import type { IMessage, MessageHeaders, ProviderMetadata } from '@anyq/core';
import { QueueConfigurationError } from './errors';
import { messageFingerprint } from './fingerprint';

/** REQ-Q-1 key sources. Q40: only 'body' survives an anyq park on every adapter. */
export type KeySource = 'id' | 'header' | 'body';

/** The header a producer sets when the broker id is not stable (REQ-DOC-1, Q4). */
export const DEFAULT_KEY_HEADER = 'idempotency-key';

export interface IdempotentOptions<T = unknown> {
  store: Store;
  key?: KeySource | ((message: IMessage<T>) => string | Promise<string>);
  keyHeader?: string;
  scope?: string | ((message: IMessage<T>) => string);
  consumerGroup?: string;
  fingerprint?: (message: IMessage<T>) => string | Promise<string>;
  leaseMs?: number;
  ttlMs?: number;
  /** D15: 'retry' throws InFlightError for the strategy to park; 'ack' treats the duplicate as handled. */
  onInFlight?: 'retry' | 'ack';
  clock?: () => number;
  logger?: { warn(message: string): void };
}

export interface ResolvedOptions<T = unknown> {
  store: Store;
  key: KeySource | ((message: IMessage<T>) => string | Promise<string>);
  keyHeader: string;
  scope: string | ((message: IMessage<T>) => string) | undefined;
  consumerGroup: string | undefined;
  fingerprint: (message: IMessage<T>) => string | Promise<string>;
  leaseMs: number | undefined;
  ttlMs: number | undefined;
  onInFlight: 'retry' | 'ack';
  clock: () => number;
  logger: { warn(message: string): void };
}

const defaultLogger = {
  warn(message: string): void {
    console.warn(message);
  },
};

export function resolveOptions<T = unknown>(options: IdempotentOptions<T>): ResolvedOptions<T> {
  return {
    store: options.store,
    key: options.key ?? 'id',
    keyHeader: options.keyHeader ?? DEFAULT_KEY_HEADER,
    scope: options.scope,
    consumerGroup: options.consumerGroup,
    fingerprint: options.fingerprint ?? ((message) => messageFingerprint(message.body)),
    leaseMs: options.leaseMs,
    ttlMs: options.ttlMs,
    onInFlight: options.onInFlight ?? 'retry',
    clock: options.clock ?? Date.now,
    logger: options.logger ?? defaultLogger,
  };
}

/** Header values may be bytes on brokers with binary headers, so decode before comparing (anyq MessageHeaders). */
export function headerValue(headers: MessageHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [field, value] of Object.entries(headers)) {
    if (field.toLowerCase() !== wanted || value === undefined) continue;
    return typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array);
  }
  return undefined;
}

export async function resolveKey<T>(
  message: IMessage<T>,
  options: ResolvedOptions<T>,
): Promise<string> {
  const source = options.key;
  let key: string;
  if (typeof source === 'function') key = await source(message);
  else if (source === 'id') key = message.id;
  else if (source === 'body') key = await messageFingerprint(message.body);
  else {
    const found = headerValue(message.headers, options.keyHeader);
    if (found === undefined) {
      throw new QueueConfigurationError(
        `anyonce: key source "header" found no ${options.keyHeader} header on this message`,
      );
    }
    key = found;
  }
  const validation = validateKey(key);
  if (!validation.ok) {
    throw new QueueConfigurationError(
      `anyonce: the resolved identity is not usable: ${validation.reason}`,
    );
  }
  return key;
}

/** Q42: the queue half of D8's scope, per provider, from what the message actually carries. */
function queueName(metadata: ProviderMetadata): {
  queue: string | undefined;
  group: string | undefined;
} {
  switch (metadata.provider) {
    case 'memory':
      return { queue: metadata.memory?.queueName, group: undefined };
    case 'redis-streams':
      return {
        queue: metadata.redisStreams?.stream,
        group: metadata.redisStreams?.consumerGroup,
      };
    case 'sqs':
      return { queue: metadata.sqs?.queueUrl, group: undefined };
    case 'kafka':
      return { queue: metadata.kafka?.topic, group: undefined };
    case 'pgmq':
      return { queue: metadata.pgmq?.queueName, group: undefined };
    case 'nats':
      return { queue: metadata.nats?.stream, group: undefined };
    case 'google-pubsub':
      return { queue: metadata.googlePubsub?.subscription, group: undefined };
    case 'cloudflare-queues':
      return { queue: metadata.cloudflareQueues?.queueName, group: undefined };
    default:
      return { queue: undefined, group: undefined };
  }
}

export function resolveScope<T>(message: IMessage<T>, options: ResolvedOptions<T>): string {
  const override = options.scope;
  if (typeof override === 'string') return override;
  if (typeof override === 'function') return override(message);
  const { queue, group } = queueName(message.metadata);
  if (queue === undefined || queue === '') {
    throw new QueueConfigurationError(
      `anyonce: the ${message.metadata.provider} adapter does not name its queue on the message; pass scope`,
    );
  }
  const resolvedGroup = options.consumerGroup ?? group;
  return resolvedGroup === undefined || resolvedGroup === '' ? queue : `${queue}/${resolvedGroup}`;
}
