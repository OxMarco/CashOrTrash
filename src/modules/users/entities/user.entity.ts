import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('user')
@Check(
  'ck_user_stats_nonnegative',
  '"totalPoints" >= 0 AND "streakDays" >= 0 AND "bestRoundScore" >= 0',
)
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Claimed after onboarding, so nullable until then. `citext` gives us
   * case-insensitive uniqueness in the database rather than in a service —
   * "Sam" and "sam" collide at the index, which is what makes the username
   * race in the e2e test resolve deterministically.
   */
  @Index('uq_user_username', { unique: true, where: '"username" IS NOT NULL' })
  @Column({ type: 'citext', nullable: true })
  username: string | null;

  /**
   * SHA-256 of the client's device id, as lowercase hex — never the id itself.
   *
   * The device id is the account's permanent bearer credential, so it is kept
   * the way a password would be: only in a form that cannot be presented back
   * to the API. See `hashDeviceId`, the one place the digest is computed.
   *
   * Renamed from `deviceId` when the stored values were hashed, so that code
   * (or an old replica mid-deploy) that still expects the plaintext column
   * fails loudly rather than quietly registering a duplicate account under an
   * unhashed id that nothing would ever match again.
   */
  @Index('uq_user_device_id', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  deviceIdHash: string;

  /** Drives the client-side generated avatar; no image upload in v1. */
  @Column({ type: 'varchar', length: 32 })
  avatarSeed: string;

  @Column({ type: 'int', default: 0 })
  totalPoints: number;

  @Column({ type: 'int', default: 0 })
  streakDays: number;

  /** UTC calendar date of the last completed daily session. */
  @Column({ type: 'date', nullable: true })
  streakLastPlayedOn: string | null;

  @Column({ type: 'int', default: 0 })
  bestRoundScore: number;

  /**
   * The address this account was registered from, written once and never
   * updated.
   *
   * There is no password and no attestation — a device id is whatever the
   * client says it is — so nothing stops someone minting accounts but the
   * per-address budget in `AuthService`, and a budget with no record behind it
   * cannot be checked after the fact. This is what makes "these three hundred
   * accounts all came from one address" a query rather than a suspicion.
   *
   * Nullable because a request can arrive without a resolvable address, because
   * rows written before this column existed have none — and because the
   * `registration-ip-prune` job nulls it once the account is past
   * `REGISTRATION_IP_RETENTION_DAYS`. It is the only piece of personal data the
   * application stores, in a codebase that redacts device ids from its logs, so
   * it is kept for as long as the question it answers is still being asked and
   * no longer.
   */
  @Index('ix_user_registration_ip', { where: '"registrationIp" IS NOT NULL' })
  @Column({ type: 'varchar', length: 45, nullable: true })
  registrationIp: string | null;

  /**
   * The id RevenueCat knows this player by — random, because RevenueCat's
   * public SDK key can read any customer whose id it can guess, and `id` is a
   * sequence. Sent to the app in `/me` and to no one else.
   */
  @Index('uq_user_billing_id', { unique: true })
  @Column({ type: 'uuid', default: () => 'uuid_generate_v4()' })
  billingId: string;

  /**
   * When the `premium` entitlement runs out, as last read from RevenueCat.
   * Null is free, and a past value is lapsed — see `isPremium`. Written only
   * by `BillingService`, never from anything the client sends.
   */
  @Column({ type: 'timestamptz', nullable: true })
  premiumExpiresAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
