import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogModule } from '../catalog/catalog.module';
import { GameSession } from '../sessions/entities/game-session.entity';
import { SessionRound } from '../sessions/entities/session-round.entity';
import { User } from '../users/entities/user.entity';
import { Match } from './entities/match.entity';
import { MatchesController } from './matches.controller';
import { MatchesGateway } from './matches.gateway';
import { MatchesReadService } from './matches-read.service';
import { MatchesReconciliationService } from './matches-reconciliation.service';
import { MatchesService } from './matches.service';

/**
 * Registers the session repositories directly rather than importing
 * SessionsModule: sessions needs the match read side, so importing back would
 * make the pair circular. Bets arrive over the event bus instead.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Match, GameSession, SessionRound, User]),
    CatalogModule,
    JwtModule.register({}),
  ],
  controllers: [MatchesController],
  providers: [
    MatchesService,
    MatchesReadService,
    MatchesReconciliationService,
    MatchesGateway,
  ],
  exports: [
    MatchesReadService,
    MatchesReconciliationService,
    MatchesService,
    MatchesGateway,
  ],
})
export class MatchesModule {}
