import { Module } from '@nestjs/common';

import { ImageProcessor } from './image-processor.service';
import { MediaController } from './media.controller';
import { LocalMediaStore, MediaStore } from './media-store';
import { PlaceholderSeeder } from './placeholder';

/**
 * Item photography: processing and serving to players.
 *
 * Photographs arrive off disk now — the catalogue is imported from `items/` at
 * deploy time — so this no longer fetches anything over HTTP. What is left is
 * the pair that matters: `ImageProcessor` washes and crops the bytes, and
 * `MediaStore` holds them under their own digest.
 *
 * Swapping `LocalMediaStore` for an object-store implementation is the single
 * binding below and nothing else, exactly as `PushSender` is bound in
 * `NotificationsModule`.
 */
@Module({
  controllers: [MediaController],
  providers: [
    { provide: MediaStore, useClass: LocalMediaStore },
    ImageProcessor,
    PlaceholderSeeder,
  ],
  exports: [MediaStore, ImageProcessor],
})
export class MediaModule {}
