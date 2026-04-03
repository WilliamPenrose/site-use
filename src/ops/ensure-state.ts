import type { Primitives, Snapshot } from '../primitives/types.js';
import type { StateDescriptor } from './matchers.js';
import { findByDescriptor, meetsCondition } from './matchers.js';
import { ElementNotFound, StateTransitionFailed } from '../errors.js';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;
const MAX_CLICK_RETRIES = 2;

export interface EnsureStateResult {
  action: 'already_there' | 'transitioned';
  snapshot: Snapshot;
}

export type EnsureStateFn = (
  target: StateDescriptor | StateDescriptor[],
) => Promise<EnsureStateResult>;

export function makeEnsureState(
  primitives: Primitives,
): EnsureStateFn {
  return async (target) => {
    const targets = Array.isArray(target) ? target : [target];
    let lastSnapshot: Snapshot | null = null;
    let lastAction: 'already_there' | 'transitioned' = 'already_there';

    for (const t of targets) {
      let action: 'already_there' | 'transitioned' = 'already_there';

      // Step 1: URL check
      if (t.url) {
        const currentUrl = await primitives.evaluate<string>(
          'window.location.href',
        );
        const urlMatch =
          typeof t.url === 'string'
            ? currentUrl.includes(t.url)
            : t.url.test(currentUrl);

        if (!urlMatch) {
          if (typeof t.url !== 'string') {
            throw new Error(
              'Cannot navigate to a RegExp URL that does not match. Provide a string URL.',
            );
          }
          await primitives.navigate(t.url);
          action = 'transitioned';
        }
      }

      // Step 2: Element state check
      if (t.role) {
        const result = await ensureElementState(primitives, t);
        lastSnapshot = result.snapshot;
        if (result.action === 'transitioned') action = 'transitioned';
        lastAction = action;
        continue;
      }

      // Step 3: URL-only — take snapshot for the caller
      lastSnapshot = await primitives.takeSnapshot();
      lastAction = action;
    }

    if (!lastSnapshot) {
      lastSnapshot = await primitives.takeSnapshot();
    }

    return { action: lastAction, snapshot: lastSnapshot };
  };
}

async function ensureElementState(
  primitives: Primitives,
  target: StateDescriptor,
): Promise<EnsureStateResult> {
  // Poll until the element appears or timeout
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let snapshot = await primitives.takeSnapshot();
  let match = findByDescriptor(snapshot, target);

  while (!match && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    snapshot = await primitives.takeSnapshot();
    match = findByDescriptor(snapshot, target);
  }

  if (!match) {
    throw new ElementNotFound(
      `No element found matching role="${target.role}" name="${target.name}"`,
      { step: `ensureState: looking for ${target.role} "${target.name}"` },
    );
  }

  if (meetsCondition(match, target)) {
    return { action: 'already_there', snapshot };
  }

  // Click to transition — retry with fresh snapshot if click fails
  // (backendNodeId may be stale after window restore or SPA re-render)
  for (let attempt = 0; attempt <= MAX_CLICK_RETRIES; attempt++) {
    if (attempt > 0) {
      console.error(
        `[site-use] click failed, re-snapshotting (attempt ${attempt + 1}/${MAX_CLICK_RETRIES + 1}, ${deadline - Date.now()}ms remaining)...`,
      );
      await sleep(POLL_INTERVAL_MS);
      snapshot = await primitives.takeSnapshot();
      match = findByDescriptor(snapshot, target);
      if (!match) {
        throw new ElementNotFound(
          `No element found matching role="${target.role}" name="${target.name}" on retry`,
          { step: `ensureState: re-find ${target.role} "${target.name}"` },
        );
      }
      if (meetsCondition(match, target)) {
        return { action: 'transitioned', snapshot };
      }
    }

    try {
      console.error(`[site-use] clicking ${target.role} "${target.name}"...`);
      await primitives.click(match.uid);
      break;
    } catch (err) {
      if (attempt === MAX_CLICK_RETRIES) throw err;
    }
  }

  // Poll until condition met or timeout
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const pollSnapshot = await primitives.takeSnapshot();
    const pollMatch = findByDescriptor(pollSnapshot, target);
    if (pollMatch && meetsCondition(pollMatch, target)) {
      return { action: 'transitioned', snapshot: pollSnapshot };
    }
  }

  throw new StateTransitionFailed(
    `State not reached after ${POLL_TIMEOUT_MS}ms: role="${target.role}" name="${target.name}"`,
    { step: `ensureState: waiting for ${target.role} "${target.name}"` },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
