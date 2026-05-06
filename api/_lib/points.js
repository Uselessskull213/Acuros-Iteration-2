// Server-side points / wallet service.
// Mirrors AcurosMobile/lib/pointsService.ts. $10 spent = 1 point.

export const CENTS_PER_POINT = 1000;

export function pointsFromCents(amountCents) {
  return Math.floor(Number(amountCents || 0) / CENTS_PER_POINT);
}

// Increment user_points (creating the row if missing). Returns points earned.
export async function addSpend(admin, { userId, orgId, amountCents }) {
  const earned = pointsFromCents(amountCents);
  if (!userId || !orgId) return earned;

  const { data: existing } = await admin
    .from('user_points')
    .select('points, total_spent_cents')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (existing) {
    await admin
      .from('user_points')
      .update({
        points: (existing.points || 0) + earned,
        total_spent_cents: (existing.total_spent_cents || 0) + amountCents,
      })
      .eq('user_id', userId)
      .eq('org_id', orgId);
  } else {
    await admin.from('user_points').insert({
      user_id: userId,
      org_id: orgId,
      points: earned,
      total_spent_cents: amountCents,
    });
  }
  return earned;
}

export async function addTransaction(admin, { userId, orgId, amountCents, description, pointsEarned }) {
  if (!userId || !orgId) return;
  await admin.from('wallet_transactions').insert({
    user_id: userId,
    org_id: orgId,
    amount_cents: amountCents,
    description,
    points_earned: pointsEarned,
  });
}
