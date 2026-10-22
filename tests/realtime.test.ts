import { describe, expect, it } from 'vitest';
import { restoreTopics, sanitizeTopics, shouldDeliver } from '../web/src/do/realtime';

describe('realtime topic state (hibernation/eviction survival)', () => {
  it('subscriptions survive a serialize/restore round trip, as after eviction', () => {
    const attached = { topics: sanitizeTopics(['order', 'inventory']) };
    // The runtime serializes the attachment; a fresh (post-eviction) object
    // deserializes it and must deliver to the same topics.
    const revived = JSON.parse(JSON.stringify(attached)) as unknown;
    const topics = restoreTopics(revived);
    expect(topics).toEqual(['order', 'inventory']);
    expect(shouldDeliver(topics, 'order.created')).toBe(true);
    expect(shouldDeliver(topics, 'inventory.low')).toBe(true);
    expect(shouldDeliver(topics, 'catalog.updated')).toBe(false);
  });

  it('unknown and oversized topics are dropped and the list is capped', () => {
    const topics = sanitizeTopics(['order', 'admin-secrets', 'x'.repeat(64), 'order', '*']);
    expect(topics).toEqual(['order', '*']);
    expect(shouldDeliver(topics, 'anything.at.all')).toBe(true);
    expect(restoreTopics(null)).toEqual([]);
    expect(restoreTopics({ topics: 'order' })).toEqual([]);
  });
});
