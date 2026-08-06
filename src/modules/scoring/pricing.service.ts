import { Injectable } from '@nestjs/common';

/** Aim for roughly this many slider stops between min and max. */
const TARGET_STEPS = 100;

/**
 * The slider "snaps to sensible price increments" (README §6). Deriving the
 * increment server-side and shipping it in the round payload keeps the client's
 * snapping and the server's bet validation from drifting apart — the client
 * cannot produce a value the server will then reject as unsnapped.
 */
@Injectable()
export class PricingService {
  /** Nearest 1/2/5×10ⁿ step that divides the span into ~TARGET_STEPS stops. */
  incrementFor(sliderMinCents: number, sliderMaxCents: number): number {
    const span = sliderMaxCents - sliderMinCents;
    if (span <= 0) return 1;

    const raw = span / TARGET_STEPS;
    const exponent = Math.floor(Math.log10(raw));
    const magnitude = 10 ** exponent;
    const fraction = raw / magnitude;

    // Nearest nice number, not the next one up: a $1,450 raw step should read
    // as $1,000, not $2,000.
    const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
    return Math.max(1, nice * magnitude);
  }

  /** Snaps to the nearest stop, clamped into the slider's bounds. */
  snap(
    valueCents: number,
    sliderMinCents: number,
    sliderMaxCents: number,
  ): number {
    const increment = this.incrementFor(sliderMinCents, sliderMaxCents);
    const steps = Math.round((valueCents - sliderMinCents) / increment);
    const snapped = sliderMinCents + steps * increment;
    return Math.min(Math.max(snapped, sliderMinCents), sliderMaxCents);
  }

  /**
   * A value is acceptable if it sits on a stop, or on the max bound — the last
   * stop rarely lands exactly on the max and the top of the slider must stay
   * reachable.
   */
  isSnapped(
    valueCents: number,
    sliderMinCents: number,
    sliderMaxCents: number,
  ): boolean {
    if (valueCents === sliderMaxCents) return true;
    const increment = this.incrementFor(sliderMinCents, sliderMaxCents);
    return (valueCents - sliderMinCents) % increment === 0;
  }
}
