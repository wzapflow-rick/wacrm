'use client';

import { useState } from 'react';
import { MessageTemplate } from '@/types';
import type { AudienceConfig, VariableMapping } from '@/lib/broadcasts/types';

// Re-exported so existing importers of these types keep working after the
// audience/variable resolution logic moved server-side.
export type {
  AudienceConfig,
  VariableMapping,
  CustomFieldFilter,
  CustomFieldOperator,
} from '@/lib/broadcasts/types';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without it.
   */
  headerMediaUrl?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

interface BroadcastProgress {
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
}

const POLL_INTERVAL_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin client over the server broadcast pipeline. All heavy lifting —
 * audience resolution, recipient creation, and the rate-limited Meta
 * fan-out — happens server-side in POST /api/broadcasts (which returns a
 * broadcast id immediately and delivers in the background). This hook just
 * kicks that off and polls GET /api/broadcasts/[id] to drive the progress
 * bar until the broadcast leaves the 'sending' state.
 */
export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(
    payload: BroadcastPayload,
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(5);

    try {
      const res = await fetch('/api/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start broadcast');
      }

      const broadcastId: string = data.broadcastId;
      setProgress(10);

      // Poll for progress until the background send finishes. The send
      // continues server-side regardless, so a poll error just retries.
      // A generous cap prevents an infinite loop if the server stalls.
      const maxPolls = 4000; // ~100 min at 1.5s — well past any real send
      for (let i = 0; i < maxPolls; i++) {
        await sleep(POLL_INTERVAL_MS);

        let progressData: BroadcastProgress | null = null;
        try {
          const pRes = await fetch(`/api/broadcasts/${broadcastId}`, {
            cache: 'no-store',
          });
          if (pRes.ok) {
            const body = (await pRes.json()) as { broadcast: BroadcastProgress };
            progressData = body.broadcast;
          }
        } catch {
          // Transient — keep polling.
        }

        if (progressData) {
          const { status, total_recipients, sent_count, failed_count } =
            progressData;
          const done = sent_count + failed_count;
          const pct =
            total_recipients > 0
              ? Math.min(99, 10 + Math.round((done / total_recipients) * 89))
              : 99;
          setProgress(pct);

          if (status !== 'sending') {
            setProgress(100);
            return broadcastId;
          }
        }
      }

      // Timed out waiting — the broadcast still exists and keeps sending.
      setProgress(100);
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
