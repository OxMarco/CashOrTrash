/**
 * Polls until `condition` holds, or gives up.
 *
 * The leaderboard and match reconciliation are driven by domain events emitted
 * *after* the bet transaction commits, so they are deliberately not finished
 * when the HTTP response returns. In production that gap is invisible: it
 * closes in under a millisecond while the client's next request is still in
 * flight over a mobile network. Back-to-back on loopback, it is not, and a
 * test that asserted immediately would be asserting on a race rather than on
 * behaviour.
 *
 * Note what this does *not* paper over: it never retries a request whose
 * result should already be correct, only ones documented as eventual.
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  { timeoutMs = 5_000, intervalMs = 25, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
