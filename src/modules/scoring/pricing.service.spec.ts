import { PricingService } from './pricing.service';

const DOLLARS = (n: number) => Math.round(n * 100);

describe('PricingService', () => {
  let service: PricingService;

  beforeEach(() => {
    service = new PricingService();
  });

  describe('incrementFor', () => {
    it('gives the $50–$1,500 gameplay slider a $10 step', () => {
      // Which is what makes the prototype's $380–$520 range a legal bet.
      expect(service.incrementFor(DOLLARS(50), DOLLARS(1500))).toBe(
        DOLLARS(10),
      );
    });

    it.each([
      ['a tight slider', DOLLARS(5), DOLLARS(25), DOLLARS(0.2)],
      ['a mid slider', DOLLARS(50), DOLLARS(1500), DOLLARS(10)],
      ['a big-money slider', DOLLARS(1000), DOLLARS(50_000), DOLLARS(500)],
    ])('%s snaps to a 1/2/5×10ⁿ step', (_label, min, max, expected) => {
      expect(service.incrementFor(min, max)).toBe(expected);
    });

    it('never returns a sub-cent step', () => {
      expect(service.incrementFor(0, 10)).toBeGreaterThanOrEqual(1);
    });

    it('degrades safely on a zero or inverted span', () => {
      expect(service.incrementFor(100, 100)).toBe(1);
      expect(service.incrementFor(500, 100)).toBe(1);
    });

    it('keeps every slider within a usable number of stops', () => {
      const sliders: Array<[number, number]> = [
        [DOLLARS(1), DOLLARS(20)],
        [DOLLARS(50), DOLLARS(1500)],
        [DOLLARS(200), DOLLARS(900)],
        [DOLLARS(1000), DOLLARS(50_000)],
      ];

      for (const [min, max] of sliders) {
        const stops = (max - min) / service.incrementFor(min, max);
        expect(stops).toBeGreaterThanOrEqual(20);
        expect(stops).toBeLessThanOrEqual(500);
      }
    });
  });

  describe('snap', () => {
    it('moves a value to the nearest stop', () => {
      expect(service.snap(DOLLARS(383), DOLLARS(50), DOLLARS(1500))).toBe(
        DOLLARS(380),
      );
      expect(service.snap(DOLLARS(387), DOLLARS(50), DOLLARS(1500))).toBe(
        DOLLARS(390),
      );
    });

    it('leaves an already-snapped value alone', () => {
      expect(service.snap(DOLLARS(380), DOLLARS(50), DOLLARS(1500))).toBe(
        DOLLARS(380),
      );
    });

    it('clamps into the slider bounds', () => {
      expect(service.snap(DOLLARS(-100), DOLLARS(50), DOLLARS(1500))).toBe(
        DOLLARS(50),
      );
      expect(service.snap(DOLLARS(9999), DOLLARS(50), DOLLARS(1500))).toBe(
        DOLLARS(1500),
      );
    });

    it('always produces a value the server will accept', () => {
      const [min, max] = [DOLLARS(50), DOLLARS(1500)];
      for (let v = min - 500; v <= max + 500; v += 137) {
        expect(service.isSnapped(service.snap(v, min, max), min, max)).toBe(
          true,
        );
      }
    });
  });

  describe('isSnapped', () => {
    it('accepts values on a stop', () => {
      expect(service.isSnapped(DOLLARS(380), DOLLARS(50), DOLLARS(1500))).toBe(
        true,
      );
    });

    it('rejects values between stops', () => {
      expect(service.isSnapped(DOLLARS(383), DOLLARS(50), DOLLARS(1500))).toBe(
        false,
      );
    });

    it('accepts both slider bounds', () => {
      expect(service.isSnapped(DOLLARS(50), DOLLARS(50), DOLLARS(1500))).toBe(
        true,
      );
      expect(service.isSnapped(DOLLARS(1500), DOLLARS(50), DOLLARS(1500))).toBe(
        true,
      );
    });

    it('accepts the max bound even when it is off-step', () => {
      // $50–$1,437 has a $10 step; $1,437 is not a multiple of it, but the top
      // of the slider has to stay reachable.
      expect(service.isSnapped(DOLLARS(1437), DOLLARS(50), DOLLARS(1437))).toBe(
        true,
      );
    });
  });
});
