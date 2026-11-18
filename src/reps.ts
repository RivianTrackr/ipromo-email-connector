import { config } from "./config.js";
import { isAllowedSender } from "./auth.js";
import { getActiveRep, graphConfigured, listRepGroupMembers, type RepProfile } from "./graph.js";

// Who Leo can send as: enabled members of the reps group. The list is synced on
// start and every REPS_SYNC_HOURS, and every send also re-checks the rep live,
// so someone disabled or removed from the group can't be sent as even between
// syncs. Nothing here needs manual cleanup when a rep leaves.

let reps: RepProfile[] = [];
let lastSync: string | null = null;
let lastError: string | null = null;

export function maySendAsReps(userEmail: string): boolean {
  return graphConfigured() && config.reps.sendAsUsers.includes(userEmail.toLowerCase());
}

export async function syncReps(): Promise<void> {
  if (!graphConfigured()) return;
  try {
    const members = await listRepGroupMembers();
    reps = members
      .filter((m) => m.enabled && isAllowedSender(m.email))
      .sort((x, y) => x.name.localeCompare(y.name));
    lastSync = new Date().toISOString();
    lastError = null;
    console.log(`Reps synced: ${reps.length} active`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : "sync failed";
    console.error(`Reps sync failed: ${lastError}`);
  }
}

export function startRepSync(): void {
  if (!graphConfigured()) return;
  void syncReps();
  const every = Math.max(1, config.reps.syncHours) * 3600_000;
  setInterval(() => void syncReps(), every).unref();
}

export function repList() {
  return { reps, lastSync, lastError };
}

/** Live check right before sending. */
export async function resolveRep(email: string): Promise<RepProfile> {
  const rep = await getActiveRep(email.toLowerCase());
  if (!rep) {
    // Keep the cached list honest too.
    reps = reps.filter((r) => r.email !== email.toLowerCase());
    throw new Error(
      `${email} isn't an active rep (not in the reps group, disabled, or not found). Use list_reps to see who you can send as.`
    );
  }
  return rep;
}
