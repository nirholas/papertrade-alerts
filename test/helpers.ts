import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeWalletSnapshot, type RawWalletSnapshot } from 'papertrade-sdk';
import type { DiffContext } from '../src/engine/diff.js';
import { compactSnapshot } from '../src/engine/snapshot.js';
import type { CompactSnapshot, InstrumentInfo, TradeRow } from '../src/types.js';

export interface RecordedRow {
  at: number;
  snap: RawWalletSnapshot;
  trades: Array<{ positionId: string; kind: 'PositionClosed' | 'Liquidated'; timestampMs: number; txHash: string; adjustedPnlRaw: string; userPaidFeeRaw: string; paperMintedRaw: string }> | null;
}

export interface RecordedProtocol {
  at: number;
  trading: { instruments: Array<{ id: number; symbol: string; priceScale: string }> } & Record<string, unknown>;
  summary: Record<string, unknown>;
}

export function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname), 'fixtures', name), 'utf8')) as T;
}

export const snapshotOf = (row: RecordedRow): CompactSnapshot => compactSnapshot(decodeWalletSnapshot(row.snap), row.at);
export const tradesOf = (row: RecordedRow): TradeRow[] => (row.trades ?? []).map(({ positionId, kind, timestampMs, txHash, adjustedPnlRaw, userPaidFeeRaw, paperMintedRaw }) => ({ positionId, kind, timestampMs, txHash, adjustedPnlRaw, userPaidFeeRaw, paperMintedRaw }));

const protocol = load<RecordedProtocol[]>('protocol.json');
export const instruments: Record<number, InstrumentInfo> = Object.fromEntries(protocol[0].trading.instruments.map((i) => [i.id, { id: i.id, symbol: i.symbol, priceScale: Number(i.priceScale) }]));

export function context(now: number, marks: Record<number, bigint> = {}): DiffContext {
  return { now, instruments, marks, accRewardPerShareRaw: BigInt(String(protocol[0].trading.accRewardPerShareRaw)), explorerUrl: 'https://papertrade-explorer.pages.dev' };
}
