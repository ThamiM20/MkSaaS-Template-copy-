import { randomUUID } from 'crypto';
import { websiteConfig } from '@/config/website';
import { getDb } from '@/db';
import { creditTransaction, userCredit } from '@/db/schema';
import { addDays, isAfter } from 'date-fns';
import { and, asc, eq, or } from 'drizzle-orm';
import { CREDIT_TRANSACTION_TYPE } from './types';

/**
 * Get user's current credit balance
 * @param userId - User ID
 * @returns User's current credit balance
 */
export async function getUserCredits(userId: string): Promise<number> {
  const db = await getDb();
  const record = await db
    .select()
    .from(userCredit)
    .where(eq(userCredit.userId, userId))
    .limit(1);
  return record[0]?.currentCredits || 0;
}

export async function updateUserCredits(userId: string, credits: number) {
  const db = await getDb();
  await db
    .update(userCredit)
    .set({ currentCredits: credits, updatedAt: new Date() })
    .where(eq(userCredit.userId, userId));
}

export async function updateUserLastRefreshAt(userId: string, date: Date) {
  const db = await getDb();
  await db
    .update(userCredit)
    .set({ lastRefreshAt: date, updatedAt: new Date() })
    .where(eq(userCredit.userId, userId));
}

/**
 * Write a credit transaction record
 * @param params - Credit transaction parameters
 */
export async function saveCreditTransaction({
  userId,
  type,
  amount,
  description,
  paymentId,
  expirationDate,
}: {
  userId: string;
  type: string;
  amount: number;
  description: string;
  paymentId?: string;
  expirationDate?: Date;
}) {
  if (!userId || !type || !description) {
    console.error(
      'saveCreditTransaction, invalid params',
      userId,
      type,
      description
    );
    throw new Error('Invalid params');
  }
  if (!Number.isFinite(amount) || amount === 0) {
    console.error('saveCreditTransaction, invalid amount', userId, amount);
    throw new Error('Invalid amount');
  }
  const db = await getDb();
  await db.insert(creditTransaction).values({
    id: randomUUID(),
    userId,
    type,
    amount,
    // remaining amount is the same as amount for earn transactions
    // remaining amount is null for spend transactions
    remainingAmount: amount > 0 ? amount : null,
    description,
    paymentId,
    expirationDate,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Add credits (registration, monthly, purchase, etc.)
 * @param params - Credit creation parameters
 */
export async function addCredits({
  userId,
  amount,
  type,
  description,
  paymentId,
  expireDays = websiteConfig.credits.creditExpireDays,
}: {
  userId: string;
  amount: number;
  type: string;
  description: string;
  paymentId?: string;
  expireDays?: number;
}) {
  if (!userId || !type || !description) {
    console.error('addCredits, invalid params', userId, type, description);
    throw new Error('Invalid params');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('addCredits, invalid amount', userId, amount);
    throw new Error('Invalid amount');
  }
  if (!Number.isFinite(expireDays) || expireDays <= 0) {
    console.error('addCredits, invalid expire days', userId, expireDays);
    throw new Error('Invalid expire days');
  }
  // Process expired credits first
  await processExpiredCredits(userId);
  // Update user credit balance
  const db = await getDb();
  const current = await db
    .select()
    .from(userCredit)
    .where(eq(userCredit.userId, userId))
    .limit(1);
  // const newBalance = (current[0]?.currentCredits || 0) + amount;
  if (current.length > 0) {
    const newBalance = (current[0]?.currentCredits || 0) + amount;
    console.log('update user credit', userId, newBalance);
    await db
      .update(userCredit)
      .set({
        currentCredits: newBalance,
        // lastRefreshAt: new Date(), // NOTE: we can not update this field here
        updatedAt: new Date(),
      })
      .where(eq(userCredit.userId, userId));
  } else {
    const newBalance = amount;
    console.log('insert user credit', userId, newBalance);
    await db.insert(userCredit).values({
      id: randomUUID(),
      userId,
      currentCredits: newBalance,
      // lastRefreshAt: new Date(), // NOTE: we can not update this field here
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  // Write credit transaction record
  await saveCreditTransaction({
    userId,
    type,
    amount,
    description,
    paymentId,
    // NOTE: there is no expiration date for PURCHASE type
    expirationDate:
      type === CREDIT_TRANSACTION_TYPE.PURCHASE
        ? undefined
        : addDays(new Date(), expireDays),
  });
}

export async function hasEnoughCredits({
  userId,
  requiredCredits,
}: {
  userId: string;
  requiredCredits: number;
}) {
  const balance = await getUserCredits(userId);
  return balance >= requiredCredits;
}

/**
 * Consume credits (FIFO, by expiration)
 * @param params - Credit consumption parameters
 */
export async function consumeCredits({
  userId,
  amount,
  description,
}: {
  userId: string;
  amount: number;
  description: string;
}) {
  if (!userId || !description) {
    console.error('consumeCredits, invalid params', userId, description);
    throw new Error('Invalid params');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error('consumeCredits, invalid amount', userId, amount);
    throw new Error('Invalid amount');
  }
  // Process expired credits first
  await processExpiredCredits(userId);
  // Check balance
  if (!(await hasEnoughCredits({ userId, requiredCredits: amount }))) {
    console.error(
      `Insufficient credits for user ${userId}, required: ${amount}`
    );
    throw new Error('Insufficient credits');
  }
  // FIFO consumption: consume from the earliest unexpired credits first
  const db = await getDb();
  const transactions = await db
    .select()
    .from(creditTransaction)
    .where(
      and(
        eq(creditTransaction.userId, userId),
        or(
          eq(creditTransaction.type, CREDIT_TRANSACTION_TYPE.PURCHASE),
          eq(creditTransaction.type, CREDIT_TRANSACTION_TYPE.MONTHLY_REFRESH),
          eq(creditTransaction.type, CREDIT_TRANSACTION_TYPE.REGISTER_GIFT)
        )
      )
    )
    .orderBy(
      asc(creditTransaction.expirationDate),
      asc(creditTransaction.createdAt)
    );
  // Consume credits
  let remainingToDeduct = amount;
  for (const transaction of transactions) {
    if (remainingToDeduct <= 0) break;
    const remainingAmount = transaction.remainingAmount || 0;
    if (remainingAmount <= 0) continue;
    // credits to consume at most in this transaction
    const deductFromThis = Math.min(remainingAmount, remainingToDeduct);
    await db
      .update(creditTransaction)
      .set({
        remainingAmount: remainingAmount - deductFromThis,
        updatedAt: new Date(),
      })
      .where(eq(creditTransaction.id, transaction.id));
    remainingToDeduct -= deductFromThis;
  }
  // Update balance
  const current = await db
    .select()
    .from(userCredit)
    .where(eq(userCredit.userId, userId))
    .limit(1);
  const newBalance = (current[0]?.currentCredits || 0) - amount;
  await db
    .update(userCredit)
    .set({ currentCredits: newBalance, updatedAt: new Date() })
    .where(eq(userCredit.userId, userId));
  // Write usage record
  await saveCreditTransaction({
    userId,
    type: CREDIT_TRANSACTION_TYPE.USAGE,
    amount: -amount,
    description,
  });
}

/**
 * Process expired credits
 * @param userId - User ID
 */
export async function processExpiredCredits(userId: string) {
  const now = new Date();
  // Get all credit transactions without type EXPIRE
  const db = await getDb();
  const transactions = await db
    .select()
    .from(creditTransaction)
    .where(
      and(
        eq(creditTransaction.userId, userId),
        or(
          // NOTE: credits with PURCHASE type can not be expired
          // eq(creditTransaction.type, CREDIT_TRANSACTION_TYPE.PURCHASE),
          eq(creditTransaction.type, CREDIT_TRANSACTION_TYPE.MONTHLY_REFRESH),
          eq(creditTransaction.type, CREDIT_TRANSACTION_TYPE.REGISTER_GIFT)
        )
      )
    );
  let expiredTotal = 0;
  // Process expired credit transactions
  for (const transaction of transactions) {
    if (
      transaction.expirationDate &&
      isAfter(now, transaction.expirationDate) &&
      !transaction.expirationDateProcessedAt
    ) {
      const remain = transaction.remainingAmount || 0;
      if (remain > 0) {
        expiredTotal += remain;
        await db
          .update(creditTransaction)
          .set({
            remainingAmount: 0,
            expirationDateProcessedAt: now,
            updatedAt: now,
          })
          .where(eq(creditTransaction.id, transaction.id));
      }
    }
  }
  if (expiredTotal > 0) {
    // Deduct expired credits from balance
    const current = await db
      .select()
      .from(userCredit)
      .where(eq(userCredit.userId, userId))
      .limit(1);
    const newBalance = Math.max(
      0,
      (current[0]?.currentCredits || 0) - expiredTotal
    );
    await db
      .update(userCredit)
      .set({ currentCredits: newBalance, updatedAt: now })
      .where(eq(userCredit.userId, userId));
    // Write expire record
    await saveCreditTransaction({
      userId,
      type: CREDIT_TRANSACTION_TYPE.EXPIRE,
      amount: -expiredTotal,
      description: `Expire credits: ${expiredTotal}`,
    });
  }
}

/**
 * Add register gift credits
 * @param userId - User ID
 */
export async function addRegisterGiftCredits(userId: string) {
  if (!websiteConfig.credits.registerGiftCredits.enable) {
    console.log('addRegisterGiftCredits, disabled');
    return;
  }
  // Check if user has already received register gift credits
  const db = await getDb();
  const record = await db
    .select()
    .from(creditTransaction)
    .where(
      and(
        eq(creditTransaction.userId, userId),
        eq(creditTransaction.type, CREDIT_TRANSACTION_TYPE.REGISTER_GIFT)
      )
    )
    .limit(1);
  // add register gift credits if user has not received them yet
  if (record.length === 0) {
    const credits = websiteConfig.credits.registerGiftCredits.credits;
    await addCredits({
      userId,
      amount: credits,
      type: CREDIT_TRANSACTION_TYPE.REGISTER_GIFT,
      description: `Register gift credits: ${credits}`,
    });
  }
}

/**
 * Add free monthly credits
 * @param userId - User ID
 */
export async function addMonthlyFreeCredits(userId: string) {
  if (!websiteConfig.credits.freeMonthlyCredits.enable) {
    console.log('addMonthlyFreeCredits, disabled');
    return;
  }
  // Check last refresh time
  const db = await getDb();
  const record = await db
    .select()
    .from(userCredit)
    .where(eq(userCredit.userId, userId))
    .limit(1);
  const now = new Date();
  let canAdd = false;
  // never added credits before
  if (!record[0]?.lastRefreshAt) {
    canAdd = true;
  } else {
    const last = new Date(record[0].lastRefreshAt);
    canAdd =
      now.getMonth() !== last.getMonth() ||
      now.getFullYear() !== last.getFullYear();
  }
  // add credits if it's a new month
  if (canAdd) {
    const credits = websiteConfig.credits.freeMonthlyCredits.credits;
    await addCredits({
      userId,
      amount: credits,
      type: CREDIT_TRANSACTION_TYPE.MONTHLY_REFRESH,
      description: `Free monthly credits: ${credits} for ${now.getFullYear()}-${now.getMonth() + 1}`,
    });
  }
}
