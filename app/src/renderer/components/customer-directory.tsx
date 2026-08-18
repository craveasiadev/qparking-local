import { Mail, Phone } from 'lucide-react';
import type { CloudCustomer } from '@shared/types';

/**
 * The pieces the two halves of the customer directory share.
 *
 * Customers and Visitors are one mirror (`cloud_customers`) split by role onto
 * two pages, so the row rendering has to stay identical between them — a
 * visitor who turns into a resident should not change how their contact details
 * or counts are drawn. Extracted here rather than duplicated so there is one
 * place to change when the shape of a row moves.
 */

/** `season_passes.role` for someone with a dated pass, one car and no bay.
 *  Was 'guest' until the cloud renamed it (migration 2026_08_16_090000); the
 *  box speaks the cloud's word so a filter compares equal to what it receives. */
export const VISITOR_ROLE = 'visitor';

/** What they ARE at this site — the role of the pass they hold here.
 *
 * Falls back to visitor, the least-privileged standing, when the cloud has not
 * told us yet: an unknown role must never read as a resident and inherit the
 * standing that goes with it. The old global resident/visitor customer flag it
 * used to fall back on no longer exists.
 */
export function roleOf(customer: CloudCustomer): string {
  return customer.siteRole ?? VISITOR_ROLE;
}

/** Which half of the directory someone belongs to.
 *
 * Accepts the pre-rename 'guest' too. The mirror is replace-all on every pull,
 * so the old word only survives on a box that has not synced since 2026-08-16 —
 * but such a box would otherwise put its visitors on the Customers page under no
 * role tab at all, which is precisely the confusion the split exists to end.
 * Read tolerantly, compare against the canonical word everywhere else. */
export function isVisitor(customer: CloudCustomer): boolean {
  const role = roleOf(customer);
  return role === VISITOR_ROLE || role === 'guest';
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

/** Same four roles and the same colours as the Vehicles page and the bay
 *  badges, so a resident, their pass and their bay all read as one thing. */
export function RoleBadge({ role }: { role: string | null }) {
  if (!role) return <span className="text-[11px] text-gray-400">—</span>;
  const tone: Record<string, string> = {
    resident: 'bg-sky-100 text-sky-800',
    staff: 'bg-violet-100 text-violet-800',
    season: 'bg-teal-100 text-teal-800',
    visitor: 'bg-amber-100 text-amber-800',
    guest: 'bg-amber-100 text-amber-800', // pre-rename rows on an unsynced box
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${tone[role] ?? 'bg-gray-100 text-gray-700'}`}>{role}</span>
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
