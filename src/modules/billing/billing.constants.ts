export const BILLING_QUEUE = 'billing';

export const BILLING_JOBS = {
  /**
   * Erases a deleted player's RevenueCat customer. A job rather than a call in
   * the request, because account deletion must not wait on — or fail with — a
   * third party, and a purchase history left behind at RevenueCat is personal
   * data the player asked to have removed.
   */
  CUSTOMER_DELETE: 'customer-delete',
} as const;
