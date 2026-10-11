import { describe, expect, it } from 'vitest';
import { diffProtocol, protocolSnapshot } from '../src/engine/protocol.js';
import { DEFAULT_PROTOCOL_RULES } from '../src/engine/rules.js';
import { instruments, load, type RecordedProtocol } from './helpers.js';

const [first, last] = load<RecordedProtocol[]>('protocol.json');
const snap = (p: RecordedProtocol) => protocolSnapshot(p.trading as never, p.summary as never, p.at);

describe('protocol diff on recorded protocol state', () => {
  it('produces no events on the first observation (nothing to compare against)', () => {
    const events = diffProtocol(null, snap(first), instruments);
    expect(events.market).toEqual([]);
    expect(events.mintRate({ ...DEFAULT_PROTOCOL_RULES, mintRate: { enabled: true, threshold: 1 } })).toBeNull();
  });

  it('is silent between two real observations with no market change', () => {
    expect(diffProtocol(snap(first), snap(last), instruments).market).toEqual([]);
  });

  it('reports a market that is paused or goes close-only', () => {
    const prev = snap(first);
    const curr = structuredClone(snap(last));
    const id = Object.keys(curr.markets)[0];
    curr.markets[id] = 'paused';
    const events = diffProtocol({ ...prev, markets: { ...prev.markets, [id]: 'open' } }, curr, instruments).market;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('market_status');
    const again = diffProtocol(curr, curr, instruments).market;
    expect(again).toEqual([]);
  });
});
