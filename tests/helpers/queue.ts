type Delivery = { ack?: () => void; retry?: (options?: QueueRetryOptions) => void };

/** One delivered message, as the Queues runtime hands it to a consumer on its first attempt. */
export function queueMessage<Body>(body: Body, { ack, retry }: Delivery = {}): Message<Body> {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: ack ?? (() => {}),
    retry: retry ?? (() => {}),
  };
}

export function messageBatch<Body>(
  queue: string,
  messages: readonly Message<Body>[]
): MessageBatch<Body> {
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    retryAll: (options) => messages.forEach((message) => message.retry(options)),
    ackAll: () => messages.forEach((message) => message.ack()),
  };
}

const noBacklog = { backlogCount: 0, backlogBytes: 0 };

/** A producer binding that hands every sent body, batched or not, to `deliver`. */
export function fakeQueue(deliver: (body: unknown) => unknown = () => {}): Queue {
  return {
    metrics: async () => noBacklog,
    send: async (body) => {
      await deliver(body);
      return { metadata: { metrics: noBacklog } };
    },
    sendBatch: async (messages) => {
      for (const message of messages) await deliver(message.body);
      return { metadata: { metrics: noBacklog } };
    },
  };
}
