import { Mail, Phone } from 'lucide-react';
import type { CloudCustomer } from '@shared/types';

/**
 * The pieces the two halves of the customer directory share.
 *
 * Customers and Visitors are one mirror (`cloud_customers`) split by holder
 * type onto two pages, so the row rendering has to stay identical between them — a
 * visitor who turns into a resident should not change how their contact details
 * or counts are drawn. Extracted here rather than duplicated so there is one
 * place to change when the shape of a row moves.
 */

/** The `visitor` holder type — a dated pass, one car and no bay. One of the
 *  cloud's four canonical values (resident | staff | season | visitor); it was
 *  'guest' before the cloud's 2026-08-16 rename, a word nothing sends anymore. */
export const VISITOR_HOLDER_TYPE = 'visitor';

/** What they ARE at this site — the holder type of the pass they hold here.
 *
 * Falls back to visitor, the least-privileged standing, when the cloud has not
 * told us yet: an unknown holder type must never read as a resident and inherit
 * the standing that goes with it. The old global resident/visitor customer flag
 * it used to fall back on no longer exists.
 */
export function holderTypeOf(customer: CloudCustomer): string {
  return customer.holderType ?? VISITOR_HOLDER_TYPE;
}

/** Which half of the directory someone belongs to.
 *
 * No 'guest' tolerance anymore: the mirror is replace-all on every pull and the
 * cloud has sent 'visitor' since 2026-08-16, so the old word cannot reappear. */
export function isVisitor(customer: CloudCustomer): boolean {
  return holderTypeOf(customer) === VISITOR_HOLDER_TYPE;
}

export function ContactCell({ email, phone }: { email: string | null; phone: string | null }) {
  if (!email && !phone) return <span className="text-gray-400">No contact details</span>;
  return (
    <span className="inline-flex flex-col gap-0.5">
      {email && <span className="inline-flex items-center gap-1"><Mail size={10} className="text-gray-400" /> {email}</span>}
      {phone && <span className="inline-flex items-center gap-1 font-mono"><Phone size={10} className="text-gray-400" /> {phone}</span>}
    </span>
  );
}

/** Same four holder types and the same colours as the Vehicles page and the
 *  bay badges, so a resident, their pass and their bay all read as one thing. */
export function HolderTypeBadge({ holderType }: { holderType: string | null }) {
  if (!holderType) return <span className="text-[11px] text-gray-400">—</span>;
  const tone: Record<string, string> = {
    resident: 'bg-sky-100 text-sky-800',
    staff: 'bg-violet-100 text-violet-800',
    season: 'bg-teal-100 text-teal-800',
    visitor: 'bg-amber-100 text-amber-800',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${tone[holderType] ?? 'bg-gray-100 text-gray-700'}`}>{holderType}</span>
  );
}

/**
 * Is this person's pass live right now?
 *
 * Reads the cloud's own `pass_status`, NOT a date compared here. The cloud flips
 * a pass to `expired` on an hourly job (passes:expire), and a pass is valid
 * through the END of its last day — so a box doing its own date maths would call
 * a pass dead some hours before the cloud does. One authority for the verdict.
 *
 * The DATE this depends on is deliberately not shown on the directory pages: the
 * Vehicles page already carries the full term (start → end, with lapsed / not
 * yet started), keyed on the plate a barrier actually reads. A second copy here
 * would be a second answer to the same question, derived a different way.
 *
 * Falls back to activePassesCount for a box that has not synced since the cloud
 * started sending pass_status, which is the signal these pages used before.
 */
export function hasLivePass(customer: CloudCustomer): boolean {
  if (customer.passStatus) return customer.passStatus === 'active';
  return customer.activePassesCount > 0;
}

export function CountChip({ icon: Icon, n, label }: { icon: any; n: number; label?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${n === 0 ? 'text-gray-400' : 'text-gray-700'}`}>
      <Icon size={11} /> {n}{label ? ` ${label}` : ''}
    </span>
  );
}
