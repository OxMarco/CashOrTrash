import { RoundResultDto } from './dto/session.dto';
import { GameMode, GameSession } from './entities/game-session.entity';

/** Only the parts of a finished session the share line is built from. */
type ShareableSession = Pick<
  GameSession,
  'mode' | 'dailyDate' | 'itemIds' | 'totalScore'
>;

/**
 * Wordle-style, spoiler-free: shows the shape of the game, not the answers.
 *
 * The grid is the whole point — a result someone can post without ruining the
 * day's items for the people reading it. What it could not do on its own is
 * bring any of those readers back: a row of squares names no game and leads
 * nowhere, so every share landed on an audience with no way to act on it.
 *
 * The origin closes that loop. It has to be a public https origin rather than
 * the app's custom scheme, which resolves for nobody who has not installed the
 * game yet — precisely the reader worth converting. An unset origin drops the
 * line instead of shipping a URL that goes nowhere.
 */
export const buildShareText = (
  session: ShareableSession,
  results: Pick<RoundResultDto, 'hit'>[],
  hits: number,
  origin: string,
): string => {
  const squares = results.map((r) => (r.hit ? '🟩' : '⬜')).join('');
  const header =
    session.mode === GameMode.DAILY && session.dailyDate
      ? `CashOrTrash · daily ${session.dailyDate}`
      : 'CashOrTrash';

  const score = `${squares} ${hits}/${session.itemIds.length} · +${session.totalScore.toLocaleString('en-US')}`;

  return origin ? `${header}\n${score}\n${origin}` : `${header}\n${score}`;
};
