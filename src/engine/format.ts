import { formatUnits } from 'papertrade-sdk';

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** Wad (18-decimal) string or bigint to a plain number. Display only. */
export const wadNum = (raw: string | bigint): number => Number(formatUnits(BigInt(raw), 18));

export const fmtUsd = (n: number): string => usdFmt.format(n);
export const fmtSignedUsd = (n: number): string => `${n < 0 ? '-' : '+'}${usdFmt.format(Math.abs(n))}`;
export const fmtNum = (n: number): string => numFmt.format(n);
export const fmtWadUsd = (raw: string | bigint): string => fmtUsd(wadNum(raw));
export const fmtSignedWadUsd = (raw: string | bigint): string => fmtSignedUsd(wadNum(raw));
export const shortAddr = (a: string): string => `${a.slice(0, 6)}...${a.slice(-4)}`;
export const fmtPct = (fraction: number): string => `${(fraction * 100).toFixed(fraction * 100 < 1 ? 3 : 2)}%`;
export const fmtPrice = (raw: bigint | string, scale: number): string => fmtUsd(Number(raw) / scale);
