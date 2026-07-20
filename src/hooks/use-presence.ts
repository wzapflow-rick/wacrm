"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  derivePresence,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

// How often the viewer re-derives presence locally. The online→offline
// transition fires NO database event (it's just the clock passing the
// staleness threshold), so without this tick a member who closes their
// tab would appear online forever. ~15s keeps "offline" responsive
// without busy-spinning.
const RE_DERIVE_MS = 15_000;

type PresenceMap = Map<string, PresenceRow>;

interface UsePresenceResult {
  /** Derived status for one member (defaults to offline if unseen). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /**
   * The clock value the hook is currently deriving against. Pass this
   * to `presenceLabel` / `formatLastSeen` so labels stay in lockstep
   * with the dots (both advance on the same ~15s re-derive tick).
   */
  now: number;
}

/**
 * Live presence for every member of the caller's account. Reads the
 * `member_presence` table (RLS-scoped to the account), subscribes to
 * Realtime changes, and re-derives "offline" on a local timer.
 *
 * Account comes from useAuth; pass `enabled: false` to opt a consumer
 * out (e.g. while a parent sheet is closed).
 */
export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();

  // Presence rows keyed by user_id, held in immutable state — each
  // update replaces the Map so React renders and the derived getters
  // recompute. No ref/version dance needed.
  const [rows, setRows] = useState<PresenceMap>(() => new Map());

  // `now` ticks so derivePresence re-evaluates staleness over time.
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active || !accountId) return;

    let cancelled = false;

    // Fetch the full presence snapshot and REPLACE the map. Unlike the old
    // Realtime path there are no out-of-order events to reconcile — each poll
    // is an authoritative snapshot — so a straight replace is correct and
    // also drops rows that vanished.
    const fetchPresence = async () => {
      try {
        const res = await fetch("/api/presence", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          presence: {
            user_id: string;
            status: StoredPresence;
            last_seen_at: string;
          }[];
        };
        if (cancelled) return;
        const next: PresenceMap = new Map();
        for (const r of data.presence ?? []) {
          next.set(r.user_id, {
            status: r.status,
            last_seen_at: r.last_seen_at,
          });
        }
        setRows(next);
      } catch (err) {
        if (!cancelled) {
          console.error("[usePresence] fetch error:", err);
        }
      }
    };

    // The re-derive tick doubles as the poll cadence: every ~15s we both
    // refetch presence (to see others' heartbeats) and advance `now` (so a
    // member who stopped beating decays to offline via staleness).
    void fetchPresence();
    const tick = setInterval(() => {
      setNow(Date.now());
      void fetchPresence();
    }, RE_DERIVE_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [active, accountId]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  return { getPresence, getRow, now };
}
