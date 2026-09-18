import type { IMessage, MessageHeaders, ProviderMetadata } from '@anyq/core';

export interface FakeMessageInit<T> {
  id?: string;
  body: T;
  headers?: MessageHeaders;
  metadata?: ProviderMetadata;
  deliveryAttempt?: number;
}

/** A real IMessage shape with recording ack and nack, so the wrapper under test is exercised as anyq calls it. */
export function fakeMessage<T>(init: FakeMessageInit<T>): IMessage<T> & {
  acks: number;
  nacks: Array<boolean | undefined>;
} {
  const message = {
    id: init.id ?? 'msg-1',
    body: init.body,
    headers: init.headers ?? {},
    timestamp: new Date(0),
    deliveryAttempt: init.deliveryAttempt ?? 1,
    metadata: init.metadata ?? { provider: 'memory', memory: { queueName: 'orders' } },
    raw: undefined,
    acks: 0,
    nacks: [] as Array<boolean | undefined>,
    async ack(): Promise<void> {
      message.acks += 1;
    },
    async nack(requeue?: boolean): Promise<void> {
      message.nacks.push(requeue);
    },
  };
  return message as unknown as IMessage<T> & { acks: number; nacks: Array<boolean | undefined> };
}
