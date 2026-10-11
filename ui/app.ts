export {};
type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Build DOM with text nodes only, so API strings can never become markup. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

interface WalletRules {
  liquidation: { enabled: boolean; belowPct: number };
  opened: boolean;
  closed: boolean;
  liquidated: boolean;
  balance: { enabled: boolean; changeUsd: number };
  sessionKey: { enabled: boolean; withinDays: number };
  rewards: { enabled: boolean; aboveUsdc: number };
}
interface ProtocolRules {
  mintRate: { enabled: boolean; threshold: number };
  marketStatus: boolean;
}
interface Watch { id: string; address: string; role: 'own' | 'follow'; label: string | null; rules: WalletRules; lastPolledAt: number | null; lastError: string | null; openPositions: number | null }
interface Channel { id: string; kind: 'telegram' | 'discord' | 'webhook'; label: string | null; display: string; status: 'active' | 'paused'; lastOkAt: number | null; lastError: string | null }
interface Me { accountId: string; watches: Watch[]; channels: Channel[]; protocolRules: ProtocolRules }
interface Delivery { id: string; channelKind: string; channelLabel: string | null; status: 'pending' | 'sent' | 'dead'; attempts: number; nextAttemptAt: number | null; lastError: string | null; httpStatus: number | null }
interface AlertItem { id: string; type: string; severity: string; title: string; body: string; fields: { name: string; value: string }[]; url: string | null; suppressed: boolean; createdAt: number; address: string | null; deliveries: Delivery[] }
interface DeadItem { id: string; title: string; channelKind: string; channelLabel: string | null; attempts: number; lastError: string | null; httpStatus: number | null }
interface Status { channels: { kind: string; enabled: boolean; reason?: string }[]; telegramBot: string | null; insecureWebhooks: boolean; lastTick: { at: number } | null }
interface LbAccount { address: string; leaderboardName: string | null; currentOpenPositionCount: number; totalWindowedPnl: string }

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const KEY = 'ptal.token';
const store = {
  get: (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* storage blocked: token stays in memory only */ } },
  del: () => { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } },
};
let token: string | null = store.get();
let serverStatus: Status | null = null;
let freshToken: string | null = null;

async function api<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.auth !== false && token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  } catch {
    throw new HttpError(0, 'network', 'Could not reach the server. Check your connection and retry.');
  }
  const data = (await res.json().catch(() => ({}))) as { code?: string; message?: string } & Record<string, unknown>;
  if (!res.ok && !(path.endsWith('/test') && 'ok' in data)) throw new HttpError(res.status, data.code ?? 'error', data.message ?? `Request failed (${res.status}).`);
  return data as T;
}

const root = document.getElementById('app') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;

function toast(msg: string): void {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  window.setTimeout(() => t.remove(), 3500);
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const short = (a: string): string => `${a.slice(0, 6)}...${a.slice(-4)}`;
const usd = (raw: string): string => {
  const n = Number(BigInt(raw)) / 1e18;
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

function errorBox(err: unknown, retry: () => void): HTMLElement {
  return h('div', { class: 'error', role: 'alert' }, h('p', {}, err instanceof Error ? err.message : 'Something went wrong.'), h('button', { type: 'button', onclick: retry }, 'Retry'));
}

async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Copy failed. Select the text and copy it manually.'); }
}

function renderStatus(): void {
  statusEl.replaceChildren();
  if (!serverStatus) return;
  for (const c of serverStatus.channels) {
    statusEl.append(h('span', { class: `chip ${c.enabled ? 'on' : 'off'}`, title: c.reason ?? '' }, h('i'), `${c.kind}: ${c.enabled ? 'available' : 'disabled'}`));
  }
  statusEl.append(h('span', { class: 'chip' }, h('i'), serverStatus.lastTick ? `last poll ${ago(serverStatus.lastTick.at)}` : 'no poll yet'));
}

async function boot(): Promise<void> {
  root.replaceChildren(h('div', { class: 'skel tall' }));
  try {
    serverStatus = await api<Status>('/api/status', { auth: false });
    renderStatus();
  } catch (err) {
    root.replaceChildren(errorBox(err, () => void boot()));
    return;
  }
  if (!token) return renderWelcome();
  await renderAccount();
}

function renderWelcome(): void {
  const input = h('input', { type: 'text', id: 'have', autocomplete: 'off', placeholder: 'ptal_...', spellcheck: false });
  const create = h('button', { type: 'button', class: 'primary' }, 'Create my subscription');
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const r = await api<{ token: string }>('/api/accounts', { method: 'POST', auth: false });
      token = r.token; freshToken = r.token; store.set(r.token);
      await renderAccount();
    } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); create.disabled = false; }
  });
  const use = h('button', { type: 'button' }, 'Use token');
  use.addEventListener('click', async () => {
    const v = input.value.trim();
    if (!/^ptal_[A-Za-z0-9_-]{20,}$/.test(v)) return toast('That does not look like a management token.');
    token = v; store.set(v);
    await renderAccount();
  });
  root.replaceChildren(
    h('section', { class: 'card', 'aria-labelledby': 'h-start' },
      h('h2', { id: 'h-start' }, 'Start'),
      h('p', { class: 'sub' }, 'There are no passwords or wallet connections. Creating a subscription gives you a one-time management token. Keep it: it is the only way to manage your alerts, and we only store its hash.'),
      create,
    ),
    h('section', { class: 'card', 'aria-labelledby': 'h-have' },
      h('h2', { id: 'h-have' }, 'Already have a token?'),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', { for: 'have' }, 'Management token'), input), use),
    ),
  );
}

async function renderAccount(): Promise<void> {
  root.replaceChildren(h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel' }));
  let me: Me;
  try {
    me = await api<Me>('/api/me');
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      store.del(); token = null; toast('That token is not valid. Create a new subscription or paste another token.');
      return renderWelcome();
    }
    root.replaceChildren(errorBox(err, () => void renderAccount()));
    return;
  }
  const refresh = (): void => void renderAccount();
  root.replaceChildren(
    ...[freshToken ? tokenCard(freshToken, () => { freshToken = null; refresh(); }) : null,
    watchesCard(me, refresh),
    channelsCard(me, refresh),
    protocolCard(me, refresh),
    alertsCard(),
    deadCard(refresh),
    accountCard()].filter((n): n is HTMLElement => n !== null),
  );
}

function tokenCard(t: string, done: () => void): HTMLElement {
  return h('section', { class: 'card token', 'aria-labelledby': 'h-token' },
    h('h2', { id: 'h-token' }, 'Your management token'),
    h('div', { class: 'notice' }, 'Shown once. Save it in a password manager. Anyone with this token can manage your alerts, and if you lose it nobody can recover it.'),
    h('code', {}, t),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => void copy(t) }, 'Copy token'), h('button', { type: 'button', onclick: done }, 'I saved it')),
  );
}

function ruleNumber(id: string, value: number, step: string): HTMLInputElement {
  return h('input', { type: 'number', id, value, step, min: '0', inputmode: 'decimal' });
}

function rulesFields(prefix: string, r: WalletRules): { el: HTMLElement; read: () => WalletRules } {
  const cb = (id: string, label: string, on: boolean) => h('label', { class: 'check', for: `${prefix}-${id}` }, h('input', { type: 'checkbox', id: `${prefix}-${id}`, checked: on }), label);
  const liq = cb('liq', 'Liquidation distance below', r.liquidation.enabled);
  const liqN = ruleNumber(`${prefix}-liqn`, r.liquidation.belowPct, '0.01');
  const opened = cb('opened', 'Position opened', r.opened);
  const closed = cb('closed', 'Position closed (net PnL and PAPER minted)', r.closed);
  const liqd = cb('liqd', 'Position liquidated', r.liquidated);
  const bal = cb('bal', 'Balance changes by at least (USD)', r.balance.enabled);
  const balN = ruleNumber(`${prefix}-baln`, r.balance.changeUsd, '1');
  const key = cb('key', 'Session key expires within (days)', r.sessionKey.enabled);
  const keyN = ruleNumber(`${prefix}-keyn`, r.sessionKey.withinDays, '1');
  const rew = cb('rew', 'Pending staking rewards above (USDC)', r.rewards.enabled);
  const rewN = ruleNumber(`${prefix}-rewn`, r.rewards.aboveUsdc, '0.01');
  const on = (c: HTMLElement) => (c.querySelector('input') as HTMLInputElement).checked;
  const el = h('fieldset', {}, h('legend', {}, 'Alert types'),
    h('div', { class: 'rule' }, liq, liqN, h('span', { class: 'mute' }, '% from bust price')),
    opened, closed, liqd,
    h('div', { class: 'rule' }, bal, balN),
    h('div', { class: 'rule' }, key, keyN),
    h('div', { class: 'rule' }, rew, rewN),
  );
  return {
    el,
    read: () => ({
      liquidation: { enabled: on(liq), belowPct: Number(liqN.value) },
      opened: on(opened), closed: on(closed), liquidated: on(liqd),
      balance: { enabled: on(bal), changeUsd: Number(balN.value) },
      sessionKey: { enabled: on(key), withinDays: Number(keyN.value) },
      rewards: { enabled: on(rew), aboveUsdc: Number(rewN.value) },
    }),
  };
}

const OWN_DEFAULT: WalletRules = { liquidation: { enabled: true, belowPct: 0.05 }, opened: true, closed: true, liquidated: true, balance: { enabled: false, changeUsd: 100 }, sessionKey: { enabled: true, withinDays: 3 }, rewards: { enabled: false, aboveUsdc: 10 } };

function summarize(r: WalletRules): string {
  const parts: string[] = [];
  if (r.liquidation.enabled) parts.push(`liq < ${r.liquidation.belowPct}%`);
  if (r.opened) parts.push('opened');
  if (r.closed) parts.push('closed');
  if (r.liquidated) parts.push('liquidated');
  if (r.balance.enabled) parts.push(`balance +/- $${r.balance.changeUsd}`);
  if (r.sessionKey.enabled) parts.push(`key < ${r.sessionKey.withinDays}d`);
  if (r.rewards.enabled) parts.push(`rewards > $${r.rewards.aboveUsdc}`);
  return parts.join(', ') || 'no alert types enabled';
}

function watchesCard(me: Me, refresh: () => void): HTMLElement {
  const addr = h('input', { type: 'text', id: 'w-addr', placeholder: '0x...', autocomplete: 'off', spellcheck: false });
  const label = h('input', { type: 'text', id: 'w-label', maxlength: '40', placeholder: 'Optional' });
  const role = h('select', { id: 'w-role' }, h('option', { value: 'own' }, 'My wallet (all alert types)'), h('option', { value: 'follow' }, 'Follow a trader (trades only)'));
  const rules = rulesFields('wr', OWN_DEFAULT);
  const add = h('button', { type: 'button', class: 'primary' }, 'Watch wallet');
  add.addEventListener('click', async () => {
    add.disabled = true;
    try {
      const body: Record<string, unknown> = { address: addr.value.trim(), role: role.value, label: label.value.trim() || undefined };
      if (role.value === 'own') body.rules = rules.read();
      await api('/api/watches', { method: 'POST', body });
      toast('Wallet added. The first poll only records its current state.');
      refresh();
    } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); add.disabled = false; }
  });
  const pick = h('div', { class: 'picker', hidden: true });
  const pickBtn = h('button', { type: 'button' }, 'Pick from the leaderboard');
  pickBtn.addEventListener('click', async () => {
    if (!pick.hidden) { pick.hidden = true; return; }
    pick.hidden = false;
    pick.replaceChildren(h('div', { class: 'skel' }));
    try {
      const r = await api<{ accounts: LbAccount[] }>('/api/papertrade/state/leaderboard/accounts?page=0&pageSize=15&sortDir=desc&sortKey=totalWindowedPnl&window=24h', { auth: false });
      if (!r.accounts.length) { pick.replaceChildren(h('div', { class: 'empty' }, 'The leaderboard is empty right now.')); return; }
      pick.replaceChildren(...r.accounts.map((a) => h('button', { type: 'button', onclick: () => { addr.value = a.address; role.value = 'follow'; pick.hidden = true; addr.focus(); } },
        h('span', { class: 'mono' }, a.leaderboardName ? `${a.leaderboardName} (${short(a.address)})` : short(a.address)),
        h('span', { class: 'mute' }, `24h PnL ${usd(a.totalWindowedPnl)}, ${a.currentOpenPositionCount} open`))));
    } catch (err) { pick.replaceChildren(errorBox(err, () => pickBtn.click())); }
  });

  const list = me.watches.length
    ? h('div', { class: 'grid' }, ...me.watches.map((w) => watchItem(w, refresh)))
    : h('div', { class: 'empty' }, h('p', {}, 'No wallets yet. Add your own address to get liquidation warnings, or follow a top trader from the leaderboard.'));

  return h('section', { class: 'card', id: 'watches', 'aria-labelledby': 'h-watches' },
    h('h2', { id: 'h-watches' }, 'Wallets'),
    h('p', { class: 'sub' }, `Up to 25 wallets. Polled about once a minute. ${me.watches.length} watched.`),
    list,
    h('h3', { class: 'mt20' }, 'Add a wallet'),
    h('div', { class: 'row mt8' },
      h('div', { class: 'field' }, h('label', { for: 'w-addr' }, 'Wallet address'), addr),
      h('div', { class: 'field' }, h('label', { for: 'w-label' }, 'Label'), label),
      h('div', { class: 'field' }, h('label', { for: 'w-role' }, 'Type'), role)),
    h('div', { class: 'my8' }, pickBtn), pick,
    rules.el, add);
}

function watchItem(w: Watch, refresh: () => void): HTMLElement {
  const del = h('button', { type: 'button', class: 'danger small', 'aria-label': `Stop watching ${w.address}` }, 'Remove');
  del.addEventListener('click', async () => {
    try { await api(`/api/watches/${w.id}`, { method: 'DELETE' }); refresh(); } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
  });
  const edit = h('button', { type: 'button', class: 'small' }, 'Edit');
  const holder = h('div');
  edit.addEventListener('click', () => {
    if (holder.childElementCount) { holder.replaceChildren(); return; }
    const f = rulesFields(`e${w.id}`, w.rules);
    const save = h('button', { type: 'button', class: 'primary small' }, 'Save rules');
    save.addEventListener('click', async () => {
      try { await api(`/api/watches/${w.id}`, { method: 'PATCH', body: { rules: f.read() } }); toast('Rules saved'); refresh(); } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
    });
    holder.replaceChildren(f.el, save);
  });
  return h('div', { class: 'item' },
    h('div', { class: 'row between' }, h('h3', {}, w.label || short(w.address)), h('span', { class: 'badge' }, w.role === 'follow' ? 'following' : 'mine')),
    h('span', { class: 'mono' }, w.address),
    h('span', { class: 'mute' }, summarize(w.rules)),
    h('span', { class: 'mute' }, w.lastPolledAt ? `Polled ${ago(w.lastPolledAt)}, ${w.openPositions ?? 0} open positions` : 'Waiting for the first poll'),
    w.lastError ? h('span', { class: 'mute bad' }, `Last poll error: ${w.lastError}`) : null,
    h('div', { class: 'row' }, edit, del), holder);
}

function channelsCard(me: Me, refresh: () => void): HTMLElement {
  const st = serverStatus;
  const avail = (k: string) => st?.channels.find((c) => c.kind === k);
  const out = h('div');
  const addForm = (kind: 'discord' | 'webhook', title: string, hint: string, ph: string): HTMLElement => {
    const input = h('input', { type: 'url', id: `c-${kind}`, placeholder: ph, autocomplete: 'off' });
    const btn = h('button', { type: 'button' }, `Add ${kind}`);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api<{ secret: string | null }>('/api/channels', { method: 'POST', body: { kind, target: input.value.trim() } });
        if (r.secret) out.replaceChildren(h('div', { class: 'token' }, h('h3', {}, 'Webhook signing secret'), h('div', { class: 'notice' }, 'Shown once. Verify the x-papertrade-alerts-signature header with it.'), h('code', {}, r.secret), h('button', { type: 'button', onclick: () => void copy(r.secret as string) }, 'Copy secret'), h('button', { type: 'button', onclick: refresh }, 'Done')));
        else refresh();
      } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); btn.disabled = false; }
    });
    return h('div', { class: 'field' }, h('label', { for: `c-${kind}` }, title), input, h('p', { class: 'mute' }, hint), btn);
  };

  const tgBtn = h('button', { type: 'button' }, 'Link Telegram');
  const tgOut = h('div');
  const tg = avail('telegram');
  tgBtn.addEventListener('click', async () => {
    try {
      const r = await api<{ command: string; deepLink: string | null; expiresAt: number }>('/api/telegram/link', { method: 'POST' });
      tgOut.replaceChildren(h('div', { class: 'notice' }, 'Open the bot and send this within 15 minutes:'), h('code', { class: 'mono' }, r.command), ...(r.deepLink ? [h('p', {}, h('a', { href: r.deepLink, rel: 'noopener' }, 'Open in Telegram'))] : []));
    } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
  });
  if (tg && !tg.enabled) tgBtn.disabled = true;

  const list = me.channels.length
    ? h('div', { class: 'grid' }, ...me.channels.map((c) => channelItem(c, refresh)))
    : h('div', { class: 'empty' }, h('p', {}, 'No channels yet. Add one below, then press "Send test" to confirm it works.'));

  return h('section', { class: 'card', id: 'channels', 'aria-labelledby': 'h-channels' },
    h('h2', { id: 'h-channels' }, 'Channels'), h('p', { class: 'sub' }, 'Where alerts are delivered. Up to 6.'), list, out,
    h('div', { class: 'row top mt16' },
      h('div', { class: 'field' }, h('h3', {}, 'Telegram'), h('p', { class: 'mute' }, tg && !tg.enabled ? `Disabled on this deployment: ${tg.reason ?? 'not configured'}.` : 'Link a chat with a one-time code. You can also message the bot /start directly.'), tgBtn, tgOut),
      addForm('discord', 'Discord webhook URL', avail('discord')?.enabled === false ? 'Disabled on this deployment.' : 'Server settings, Integrations, Webhooks.', 'https://discord.com/api/webhooks/...'),
      addForm('webhook', 'Signed webhook URL', 'POST with an HMAC-SHA256 signature header.', 'https://example.com/hooks/papertrade')));
}

function channelItem(c: Channel, refresh: () => void): HTMLElement {
  const result = h('span', { class: 'mute', role: 'status' });
  const test = h('button', { type: 'button', class: 'small' }, 'Send test');
  test.addEventListener('click', async () => {
    test.disabled = true; result.textContent = 'Sending...';
    try {
      const r = await api<{ ok: boolean; status: number | null; error: string | null }>(`/api/channels/${c.id}/test`, { method: 'POST' });
      result.textContent = r.ok ? `Delivered${r.status ? ` (HTTP ${r.status})` : ''}.` : `Failed: ${r.error ?? 'unknown error'}`;
    } catch (err) { result.textContent = err instanceof Error ? err.message : 'Failed'; }
    test.disabled = false;
  });
  const pause = h('button', { type: 'button', class: 'small' }, c.status === 'active' ? 'Pause' : 'Resume');
  pause.addEventListener('click', async () => {
    try { await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { status: c.status === 'active' ? 'paused' : 'active' } }); refresh(); } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
  });
  const del = h('button', { type: 'button', class: 'danger small' }, 'Remove');
  del.addEventListener('click', async () => {
    try { await api(`/api/channels/${c.id}`, { method: 'DELETE' }); refresh(); } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
  });
  return h('div', { class: 'item' },
    h('div', { class: 'row between' }, h('h3', {}, c.label || c.kind), h('span', { class: `badge ${c.lastError ? 'dead' : c.status === 'active' ? 'sent' : 'pending'}` }, c.status)),
    h('span', { class: 'mono' }, c.display),
    h('span', { class: 'mute' }, c.lastOkAt ? `Last delivery ${ago(c.lastOkAt)}` : 'Nothing delivered yet'),
    c.lastError ? h('span', { class: 'mute bad' }, `Last error: ${c.lastError}`) : null,
    h('div', { class: 'row' }, test, pause, del), result);
}

function protocolCard(me: Me, refresh: () => void): HTMLElement {
  const r = me.protocolRules;
  const mr = h('input', { type: 'checkbox', id: 'p-mr', checked: r.mintRate.enabled });
  const mrN = h('input', { type: 'number', id: 'p-mrn', value: r.mintRate.threshold, step: '0.1', min: '0.01' });
  const ms = h('input', { type: 'checkbox', id: 'p-ms', checked: r.marketStatus });
  const save = h('button', { type: 'button', class: 'primary' }, 'Save protocol alerts');
  save.addEventListener('click', async () => {
    try { await api('/api/protocol-rules', { method: 'PUT', body: { mintRate: { enabled: mr.checked, threshold: Number(mrN.value) }, marketStatus: ms.checked } }); toast('Saved'); refresh(); } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
  });
  return h('section', { class: 'card', id: 'protocol', 'aria-labelledby': 'h-proto' },
    h('h2', { id: 'h-proto' }, 'Protocol alerts'), h('p', { class: 'sub' }, 'Not tied to a wallet.'),
    h('label', { class: 'check', for: 'p-mr' }, mr, 'PAPER mint rate crosses'), h('div', { class: 'rule' }, mrN, h('span', { class: 'mute' }, 'PAPER per $1 of net profit, in either direction')),
    h('label', { class: 'check', for: 'p-ms' }, ms, 'A market is paused or goes close-only'), save);
}

function deliveryBadge(d: Delivery): HTMLElement {
  const detail = d.status === 'pending' ? (d.nextAttemptAt ? `retry in ${Math.max(0, Math.round((d.nextAttemptAt - Date.now()) / 1000))}s` : 'queued') : d.status === 'dead' ? `dead after ${d.attempts}` : 'sent';
  return h('span', { class: `badge ${d.status}`, title: d.lastError ?? '' }, `${d.channelLabel || d.channelKind}: ${detail}`);
}

function alertsCard(): HTMLElement {
  const body = h('div', {}, h('div', { class: 'skel' }));
  const load = async (): Promise<void> => {
    try {
      const r = await api<{ alerts: AlertItem[] }>('/api/alerts?limit=30');
      body.replaceChildren(...(r.alerts.length ? r.alerts.map(alertRow) : [h('div', { class: 'empty' }, h('p', {}, 'No alerts yet. They appear here the moment a rule fires. Use "Send test" on a channel to see what one looks like.'))]));
    } catch (err) { body.replaceChildren(errorBox(err, () => void load())); }
  };
  void load();
  return h('section', { class: 'card', id: 'alerts', 'aria-labelledby': 'h-alerts' },
    h('div', { class: 'row between' }, h('h2', { id: 'h-alerts' }, 'Recent alerts'), h('button', { type: 'button', class: 'small', onclick: () => void load() }, 'Refresh')), body);
}

function alertRow(a: AlertItem): HTMLElement {
  return h('article', { class: 'alert' },
    h('div', { class: 'row between' }, h('h3', {}, a.title), h('span', { class: 'row' }, h('span', { class: `badge ${a.severity}` }, a.severity), h('span', { class: 'mute' }, ago(a.createdAt)))),
    h('p', { class: 'body' }, a.body),
    a.fields.length ? h('div', { class: 'fields' }, ...a.fields.map((f) => h('span', {}, h('b', {}, `${f.name}: `), f.value))) : null,
    a.suppressed ? h('span', { class: 'mute' }, 'Suppressed by the hourly alert cap. Not delivered.') : h('div', { class: 'row' }, ...a.deliveries.map(deliveryBadge)));
}

function deadCard(refresh: () => void): HTMLElement {
  const body = h('div', {}, h('div', { class: 'skel' }));
  const load = async (): Promise<void> => {
    try {
      const r = await api<{ deliveries: DeadItem[] }>('/api/deliveries/dead');
      body.replaceChildren(...(r.deliveries.length ? r.deliveries.map((d) => {
        const retry = h('button', { type: 'button', class: 'small' }, 'Retry');
        retry.addEventListener('click', async () => {
          try { await api(`/api/deliveries/${d.id}/retry`, { method: 'POST' }); toast('Re-queued. It is sent on the next poll.'); refresh(); } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
        });
        return h('article', { class: 'alert' }, h('div', { class: 'row between' }, h('h3', {}, d.title), retry), h('span', { class: 'mute' }, `${d.channelLabel || d.channelKind}: gave up after ${d.attempts} attempt${d.attempts === 1 ? '' : 's'}${d.httpStatus ? ` (HTTP ${d.httpStatus})` : ''}. ${d.lastError ?? ''}`));
      }) : [h('div', { class: 'empty' }, h('p', {}, 'Nothing here. Deliveries that fail every retry land here so you can fix the channel and send them again.'))]));
    } catch (err) { body.replaceChildren(errorBox(err, () => void load())); }
  };
  void load();
  return h('section', { class: 'card', id: 'dead', 'aria-labelledby': 'h-dead' }, h('h2', { id: 'h-dead' }, 'Failed deliveries'), body);
}

function accountCard(): HTMLElement {
  const forget = h('button', { type: 'button' }, 'Forget token on this device');
  forget.addEventListener('click', () => { store.del(); token = null; void boot(); });
  const del = h('button', { type: 'button', class: 'danger' }, 'Delete subscription');
  del.addEventListener('click', async () => {
    if (!window.confirm('Delete this subscription, its wallets, channels and alert history? This cannot be undone.')) return;
    try { await api('/api/me', { method: 'DELETE' }); store.del(); token = null; void boot(); } catch (err) { toast(err instanceof Error ? err.message : 'Failed'); }
  });
  return h('section', { class: 'card', 'aria-labelledby': 'h-acct' }, h('h2', { id: 'h-acct' }, 'Subscription'),
    h('p', { class: 'sub' }, 'The token is kept in this browser only. Forgetting it does not delete anything: paste the token later to come back.'), h('div', { class: 'row' }, forget, del));
}

const themeBtn = document.getElementById('theme') as HTMLButtonElement;
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
});

void boot();
