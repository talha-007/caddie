import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';

/**
 * A short, stable label for a caller that is not their address.
 *
 * The dashboard needs to answer "is one client burning the budget" and "are
 * these fifty sessions really one script". Both need the same caller to look
 * the same twice; neither needs to know who they are. So addresses are hashed
 * and cut to eight characters.
 *
 * Salted, because an unsalted hash of an IP is not anonymous - the whole IPv4
 * space can be hashed in seconds, so the digest is the address with extra
 * steps.
 *
 * The salt comes from ADMIN_TOKEN so that every instance derives the same
 * label: a per-process salt would give one caller a different label on each
 * instance, and the fleet-wide grouping this exists for would be nonsense.
 * Without ADMIN_TOKEN there is no dashboard to read the labels anyway, so a
 * random per-process salt is the safer default.
 */
const SALT = env.adminToken || randomBytes(16).toString('hex');

export function clientHash(key: string): string {
  return createHash('sha256').update(`${SALT}:${key}`).digest('hex').slice(0, 8);
}
