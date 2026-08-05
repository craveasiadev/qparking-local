import { useEffect, useState } from 'react';
import { Ban, Check, ArrowDown, ArrowUp, Bolt, CreditCard, AlertTriangle, Loader2 } from 'lucide-react';

interface GateEvent {
  state: 'open' | 'closed';
  plate?: string;
  laneName?: string;
  direction?: 'in' | 'out' | 'test';
  reason?: string;
  /** Extra line under the headline — currently the blacklist reason. */
  detail?: string | null;
  feeCents?: number;
  holdMs?: number;
}

/**
 * Always-on-top stand-in for a real gate-relay. Defaults to a big red CLOSED
 * panel and switches layout based on the event's `reason` so the driver
 * always knows what's happening:
 *   - WELCOME / COME AGAIN  → success states (green / teal)
 *   - PLEASE PAY            → exit-pending while terminal runs (blue + spinner)
 *   - ALREADY INSIDE        → duplicate scan, use exit lane (amber)
 *   - TERMINAL NOT CONFIGURED / CAMERA HAS NO LANE → operator misconfig (red)
 *   - GATE CLOSED           → idle default (red)
 */
export function GateView() {
  const [event, setEvent] = useState<GateEvent>({ state: 'closed' });

  useEffect(() => {
    const off = window.bridge.onEvent('gate-state', (payload) => {
      setEvent(payload as GateEvent);
    });
    return off;
  }, []);

  const isOpen = event.state === 'open';
  const reason = event.reason ?? '';
  const isPleasePay = !isOpen && reason === 'please-pay';
  const isRescanBlock = !isOpen && reason === 'duplicate-scan';
  const isNoLane = !isOpen && reason === 'no-lane';
  const isNoTerminal = !isOpen && reason === 'no-terminal';
  const isTerminalOffline = !isOpen && reason === 'terminal-offline';
  const isExitWithoutEntry = !isOpen && reason === 'exit-without-entry';
  const isBlacklisted = !isOpen && reason === 'blacklisted';
  // Pass-only lane, no valid pass. Distinct from 'blacklisted': this driver
  // isn't banned, they're simply not registered here — so the wording sends
  // them to the attendant without accusing them of anything.
  const isNotAuthorised = !isOpen && reason === 'not-authorised';
  const isMisconfig = isNoLane || isNoTerminal || isTerminalOffline;

  // Pick a background — each driver-facing state gets its own colour so
  // there's no ambiguity from across the lane.
  const bg = isOpen
    ? (event.direction === 'in' ? 'bg-emerald-500'
      : event.direction === 'out' ? 'bg-teal-500'
      : 'bg-emerald-500')
    : isPleasePay ? 'bg-blue-600'
    : isRescanBlock ? 'bg-amber-500'
    : isExitWithoutEntry ? 'bg-orange-600'
    // Near-black: deliberately unlike every other state, so staff can tell a
    // blocked vehicle from an ordinary closed gate at a glance across the lane.
    : isBlacklisted ? 'bg-zinc-900'
    // Deep red — clearly a refusal, but not the near-black reserved for a ban.
    : isNotAuthorised ? 'bg-rose-800'
    : isMisconfig ? 'bg-red-700'
    : 'bg-red-600';

  // Top greeting.
  const greeting = isOpen
    ? (event.direction === 'in' ? 'WELCOME'
      : event.direction === 'out' ? 'COME AGAIN'
      : 'GATE OPEN')
    : isPleasePay ? 'PLEASE PAY'
    : isRescanBlock ? 'ALREADY INSIDE'
    : isBlacklisted ? 'VEHICLE BLOCKED'
    : isNotAuthorised ? 'ACCESS DENIED'
    : isExitWithoutEntry ? 'NO ENTRY ON RECORD'
    : isNoLane ? 'CAMERA HAS NO LANE'
    : isNoTerminal ? 'TERMINAL NOT CONFIGURED'
    : isTerminalOffline ? 'TERMINAL OFFLINE'
    : 'GATE CLOSED';

  // Sub-message under the headline (driver-facing).
  const subline = isOpen
    ? (event.direction === 'in' ? 'Drive in slowly'
      : event.direction === 'out' ? 'Thank you · Drive safely'
      : 'Test trigger')
    : isPleasePay ? 'Tap card on payment terminal'
    : isRescanBlock ? 'Please use exit lane to pay'
    // Show the operator-entered blacklist reason when there is one, so staff
    // walking over already know what this is about.
    : isBlacklisted ? (event.detail ? `See attendant · ${event.detail}` : 'Please see attendant')
    : isNotAuthorised ? 'No valid parking pass · Please see attendant'
    : isExitWithoutEntry ? 'See attendant for assistance'
    : isTerminalOffline ? 'Operator: connect terminal in Terminals page'
    : isMisconfig ? 'Operator: check qparking-local settings'
    : null;

  // Icon choice — payment screen gets a card icon, errors get a warning
  // triangle, normal closed gets a ban symbol.
  const HeadIcon = isOpen ? Check
    : isPleasePay ? CreditCard
    : (isMisconfig || isExitWithoutEntry || isBlacklisted || isNotAuthorised) ? AlertTriangle
    : Ban;
  const DirIcon = event.direction === 'in' ? ArrowDown : event.direction === 'out' ? ArrowUp : Bolt;

  return (
    <div className={`min-h-screen w-screen flex items-center justify-center text-white transition-colors duration-200 ${bg}`}>
      <div className="text-center p-10 select-none">
        <div className="inline-flex items-center justify-center w-32 h-32 rounded-full bg-white/15 mb-6">
          <HeadIcon size={80} strokeWidth={2.5} />
        </div>
        <div className="text-6xl font-black tracking-tight">{greeting}</div>

        {/* Open-state layout: plate + drive-in/out message */}
        {isOpen && (
          <div className="mt-6 space-y-3">
            {event.plate && (
              <div className="text-8xl font-mono font-black tracking-widest leading-none">{event.plate}</div>
            )}
            {subline && (
              <div className="text-3xl font-light tracking-wide opacity-90">{subline}</div>
            )}
            <div className="flex items-center justify-center gap-3 text-xl font-semibold opacity-75 pt-2">
              <DirIcon size={22} strokeWidth={2.5} />
              <span className="uppercase tracking-widest">
                {event.direction === 'in' ? 'Entry' : event.direction === 'out' ? 'Exit' : 'Test'}
              </span>
              {event.laneName && <span>· {event.laneName}</span>}
            </div>
          </div>
        )}

        {/* PLEASE PAY screen — big amount + spinner showing terminal is live */}
        {isPleasePay && (
          <div className="mt-6 space-y-4">
            {typeof event.feeCents === 'number' && (
              <div className="text-9xl font-mono font-black tracking-tight leading-none">
                RM {(event.feeCents / 100).toFixed(2)}
              </div>
            )}
            {event.plate && (
              <div className="text-5xl font-mono font-black tracking-widest leading-none opacity-95">{event.plate}</div>
            )}
            <p className="text-2xl font-light tracking-wide opacity-95">{subline}</p>
            <div className="inline-flex items-center gap-2 text-base font-semibold uppercase tracking-widest opacity-80 pt-2">
              <Loader2 size={20} className="animate-spin" />
              <span>Waiting for terminal…</span>
            </div>
          </div>
        )}

        {/* Re-scan, no-entry, misconfig screens */}
        {!isOpen && !isPleasePay && (isRescanBlock || isExitWithoutEntry || isMisconfig) && (
          <div className="mt-6 space-y-3">
            {event.plate && (
              <div className="text-7xl font-mono font-black tracking-widest leading-none">{event.plate}</div>
            )}
            {subline && <p className="text-2xl font-light tracking-wide opacity-95">{subline}</p>}
          </div>
        )}

        {/* Idle default */}
        {!isOpen && !isPleasePay && !isRescanBlock && !isExitWithoutEntry && !isMisconfig && (
          <p className="mt-6 text-sm uppercase tracking-widest opacity-75">
            Waiting for next vehicle…
          </p>
        )}
      </div>
    </div>
  );
}
