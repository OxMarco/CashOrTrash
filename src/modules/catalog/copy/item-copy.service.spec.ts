import OpenAI from 'openai';
import { Repository } from 'typeorm';

import { CatalogService } from '../catalog.service';
import { ItemCopy as ItemCopyRow } from '../entities/item-copy.entity';
import { Item } from '../entities/item.entity';
import { Theme } from '../entities/theme.entity';
import { MediaStore } from '../../media/media-store';
import { ItemCopyService } from './item-copy.service';
import {
  CopywriterUnavailableError,
  type ItemCopy,
  ItemCopywriter,
} from './item-copywriter.service';

const item = (id: number, title = `upload ${id}`): Item =>
  ({
    id,
    themeId: 1,
    title,
    sourceName: title,
    conditionLine: '',
    photoUrl: '',
    copyPending: true,
  }) as unknown as Item;

/**
 * The pass decides one thing the copywriter cannot: whether an item's flag is
 * cleared. Get it wrong one way and an outage empties the queue with nothing
 * written; get it wrong the other and every refusal is paid for again on every
 * run. These pin both directions.
 */
describe('ItemCopyService', () => {
  let items: {
    find: jest.Mock;
    countBy: jest.Mock;
    update: jest.Mock;
    findOne: jest.Mock;
  };
  let copies: { upsert: jest.Mock };
  let copywriter: {
    available: boolean;
    write: jest.Mock;
    translate: jest.Mock;
  };
  let catalog: { invalidateThemes: jest.Mock };
  let service: ItemCopyService;
  let queued: Item[];

  beforeEach(() => {
    queued = [item(1), item(2)];
    items = {
      // The first call is the queue; every later one is `titlesIn`.
      find: jest
        .fn()
        .mockImplementation((options: { where: { copyPending?: boolean } }) =>
          Promise.resolve(
            options.where.copyPending
              ? queued
              : queued.map(({ title }) => ({ title })),
          ),
        ),
      countBy: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
    };
    copies = { upsert: jest.fn().mockResolvedValue(undefined) };
    copywriter = {
      available: true,
      write: jest.fn(),
      translate: jest.fn().mockResolvedValue(new Map()),
    };
    catalog = { invalidateThemes: jest.fn().mockResolvedValue(undefined) };

    service = new ItemCopyService(
      items as unknown as Repository<Item>,
      copies as unknown as Repository<ItemCopyRow>,
      {
        find: jest.fn().mockResolvedValue([{ id: 1, name: 'Watches' }]),
      } as unknown as Repository<Theme>,
      copywriter as unknown as ItemCopywriter,
      catalog as unknown as CatalogService,
      { open: jest.fn() } as unknown as MediaStore,
    );
  });

  const flagsCleared = () =>
    items.update.mock.calls
      .filter(([, patch]) => (patch as Item).copyPending === false)
      .map(([where]) => (where as { id: number }).id);

  it('clears the flag on an item the model declined, and counts it', async () => {
    copywriter.write.mockResolvedValue(new Map());

    await expect(service.run()).resolves.toMatchObject({
      written: 0,
      failed: 2,
    });
    expect(flagsCleared()).toEqual([1, 2]);
  });

  it('writes accepted copy and clears the flag', async () => {
    copywriter.write.mockResolvedValue(
      new Map<string, ItemCopy>([
        ['1', { title: 'Seiko 6139', conditionLine: 'Steel · 1978' }],
        ['2', { title: 'Omega Speedmaster', conditionLine: 'Manual wind' }],
      ]),
    );

    await expect(service.run()).resolves.toMatchObject({ written: 2 });
    expect(items.update).toHaveBeenCalledWith(
      { id: 1 },
      {
        title: 'Seiko 6139',
        conditionLine: 'Steel · 1978',
        copyPending: false,
      },
    );
    expect(catalog.invalidateThemes).toHaveBeenCalled();
  });

  /**
   * The bug this replaces: every failure was swallowed as an empty map, and an
   * empty map reads as "the model declined" — so an OpenAI outage cleared the
   * flag on everything queued and nothing ever came back for it.
   */
  describe('when OpenAI is unavailable', () => {
    const outage = (
      partial: Map<string, ItemCopy> = new Map(),
      settled: string[] = [],
    ) =>
      new CopywriterUnavailableError(
        partial,
        new Set(settled),
        new OpenAI.APIConnectionTimeoutError(),
      );

    it('leaves every unanswered item flagged and fails the job', async () => {
      const error = outage();
      copywriter.write.mockRejectedValue(error);
      items.countBy.mockResolvedValue(2);

      // Rethrown, so BullMQ's `attempts` retry it and a job that runs out of
      // them leaves the items for the boot catch-up.
      await expect(service.run()).rejects.toBe(error);
      expect(flagsCleared()).toEqual([]);
      expect(copywriter.translate).not.toHaveBeenCalled();
    });

    it('keeps copy that was already written before the outage', async () => {
      queued = [item(1), item(2), item(3)];
      copywriter.write.mockRejectedValue(
        outage(
          new Map([['1', { title: 'Seiko 6139', conditionLine: 'Steel' }]]),
          // 2 was answered — and declined — in the same batch as 1.
          ['1', '2'],
        ),
      );

      await expect(service.run()).rejects.toBeInstanceOf(
        CopywriterUnavailableError,
      );
      // 1 written, 2 declined: both answered, both cleared. 3 was never asked.
      expect(flagsCleared()).toEqual([1, 2]);
      expect(items.update).toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({ title: 'Seiko 6139' }),
      );
      // What was written is still translated and published before the throw.
      expect(copywriter.translate).toHaveBeenCalled();
      expect(catalog.invalidateThemes).toHaveBeenCalled();
    });

    it('does not mistake an unrelated error for an outage', async () => {
      copywriter.write.mockRejectedValue(new Error('database gone'));
      await expect(service.run()).rejects.toThrow('database gone');
      expect(flagsCleared()).toEqual([]);
    });
  });

  /**
   * Two items the model named identically. The second is qualified with its
   * own new description, not the row's stored line — which for a portal upload
   * is empty, and on a rewrite is the description being replaced.
   */
  describe('keeping a title unique', () => {
    beforeEach(() => {
      queued = [item(2)];
      // Another item in the category already holds the model's title.
      items.findOne.mockImplementation(
        (options: { where: { title: string } }) =>
          Promise.resolve(
            options.where.title === 'Seiko 6139' ? { id: 9 } : null,
          ),
      );
    });

    const titleWritten = () =>
      (items.update.mock.calls[0][1] as { title: string }).title;

    it('qualifies a clash with the new condition line', async () => {
      copywriter.write.mockResolvedValue(
        new Map([['2', { title: 'Seiko 6139', conditionLine: '1978' }]]),
      );
      await service.run();
      expect(titleWritten()).toBe('Seiko 6139 · 1978');
    });

    it('numbers it instead when the line is empty', async () => {
      copywriter.write.mockResolvedValue(
        new Map([['2', { title: 'Seiko 6139', conditionLine: '  ' }]]),
      );
      await service.run();
      expect(titleWritten()).toBe('Seiko 6139 (2)');
    });

    it('numbers it instead when the combination would leak', async () => {
      // Stubbed past `vet`, which would have caught this title on its own —
      // the point is only that the qualified string is checked as a whole
      // before it is written, since nothing else checks it.
      copywriter.write.mockResolvedValue(
        new Map([['2', { title: 'Seiko 6139 CHF', conditionLine: '9,000' }]]),
      );
      items.findOne.mockImplementation(
        (options: { where: { title: string } }) =>
          Promise.resolve(
            options.where.title === 'Seiko 6139 CHF' ? { id: 9 } : null,
          ),
      );
      await service.run();
      expect(titleWritten()).toBe('Seiko 6139 CHF (2)');
    });
  });
});
