import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogModule } from '../catalog/catalog.module';
import { Item } from '../catalog/entities/item.entity';
import { Theme } from '../catalog/entities/theme.entity';
import { MAINTENANCE_QUEUE } from '../jobs/jobs.constants';
import { MediaModule } from '../media/media.module';
import { AdminAuthService } from './admin-auth.service';
import { AdminCatalogService } from './admin-catalog.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';

/**
 * Registered unconditionally, even when no password is configured.
 *
 * The routes exist either way and answer 503 on login, which is a clearer
 * signal than a 404 that looks identical to a typo in the URL. Nothing behind
 * the guard is reachable without a token, and no token can be minted without
 * the hash — so an unconfigured portal is closed, not merely hidden.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Theme, Item]),
    PassportModule,
    JwtModule.register({}),
    CatalogModule,
    MediaModule,
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
  ],
  controllers: [AdminController],
  providers: [
    AdminAuthService,
    AdminCatalogService,
    AdminGuard,
    AdminJwtStrategy,
  ],
})
export class AdminModule {}
