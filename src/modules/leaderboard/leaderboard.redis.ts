import { ChainableCommander } from 'ioredis';

const MEMBER_WIDTH = 10;

export const toMember = (userId: number): string =>
  String(userId).padStart(MEMBER_WIDTH, '0');

export const fromMember = (member: string): number =>
  Number.parseInt(member, 10);

/** ioredis resolves EXEC even when an individual command returned an error. */
export const execRedisTransaction = async (
  transaction: ChainableCommander,
  label: string,
): Promise<void> => {
  const results = await transaction.exec();
  if (!results) throw new Error(`${label}: Redis transaction was aborted`);

  const errors = results
    .map(([error]) => error)
    .filter((error): error is Error => error instanceof Error);
  if (errors.length > 0) {
    throw new Error(
      `${label}: ${errors.map((error) => error.message).join('; ')}`,
    );
  }
};
