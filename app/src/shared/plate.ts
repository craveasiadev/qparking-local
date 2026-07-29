/**
 * The ONE canonical plate key used everywhere in this app.
 *
 * Why this exists: the LPR pipeline has always stripped separators (a camera
 * reports the same physical plate as "vmm 1234", "VMM-1234" or "VMM_1234"),
 * while qparking SaaS stores whatever the operator typed with only whitespace
 * removed. So a plate registered in the cloud as "FIX-1234" was cached locally
 * as "FIX-1234" and then looked up by the gate as "FIX1234" — no match, and a
 * paid-up pass holder got charged at the barrier.
 *
 * Canonicalising on BOTH sides of every local comparison (cloud ingest AND gate
 * lookup) closes that without needing the cloud to change its storage format:
 * whatever separators the SaaS keeps, the local key is always the same.
 *
 * Rule: uppercase, drop everything that isn't a letter or a digit.
 */
export function canonicalPlate(plate: string): string {
  return (plate ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
