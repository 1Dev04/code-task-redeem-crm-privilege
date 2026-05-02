import { Pool, PoolClient } from "pg";
const pool = new Pool();

// Type
interface RedeemInput {
  companyId: string;
  memberId: string;
  privilegeId: string;
  idempotencyKey?: string;
}

interface RedeemResult {
  status: number;
  redemptionId: string;
  message: string;
  code?: string;
}

interface AppError {
  status: number;
  error: string;
  message: string;
}

interface MemberRow {
  id: string;
  tier_id: string;
  status: string;
}

interface PrivilegeRow {
  id: string;
  status: string;
  start_date: Date;
  end_date: Date;
  type: "coupon" | "voucher" | "gift" | "campaign";
}

interface QuotaRow {
  id: string;
  quota: number;
  used_quota: number;
}

interface RewardCodeRow {
  id: string;
  code: string;
}

interface RedemptionRow {
  id: string;
  status: string;
}

// Error handling
function handleError(status: number, error: string, message: string): AppError {
  return { status, error, message };
}

// Generate reward code
function generateCode(): string {
  return crypto.randomUUID().replace(/-/g, "").substring(0, 12).toUpperCase();
}

// isHandleError type guard
function isHandleError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    "error" in err &&
    "message" in err
  );
}

// Main function
async function redeemPrivilege(input: RedeemInput): Promise<RedeemResult> {
  const { companyId, memberId, privilegeId, idempotencyKey } = input;
  const client: PoolClient = await pool.connect();
  try {
    //  1 Validate Member
    const memberResult = await client.query<MemberRow>(
      `SELECT id, tier_id, status
       FROM person
       WHERE id = $1 AND company_id = $2`,
      [memberId, companyId],
    );

    if (memberResult.rowCount === 0) {
      throw handleError(404, "member_not_found", "Member not found");
    }

    const member = memberResult.rows[0];

    // Q1 - Member status check
    if (member?.status !== "active") {
      throw handleError(403, "member_inactive", "Member is not active");
    }

    // 2. Validate Privilege
    const privilegeResult = await client.query<PrivilegeRow>(
      `SELECT id, status, start_date, end_date, type
       FROM privilege
       WHERE id = $1 AND company_id = $2`,
      [privilegeId, companyId],
    );

    if (privilegeResult.rowCount === 0) {
      throw handleError(404, "privilege_not_found", "Privilege not found");
    }

    const privilege = privilegeResult.rows[0];

    // Q4 - Privilege status check
    if (privilege?.status !== "active") {
      throw handleError(400, "privilege_inactive", "Privilege is not active");
    }

    // Q3 - Check Datetime by server time UTC
    const now = new Date();
    if (
      now < new Date(privilege.start_date) ||
      now > new Date(privilege.end_date)
    ) {
      throw handleError(400, "privilege_expired", "This privilege has expired");
    }

    // Q5 - Check Tier member
    const tierResult = await client.query<{ exists: boolean }>(
      `SELECT 1 AS exists FROM privilege_tier_mapping
      WHERE privilege_id = $1 AND tier_id = $2`,
      [privilegeId, member.tier_id],
    );

    if (tierResult.rowCount === 0) {
      throw handleError(
        403,
        "tier_not_eligible",
        "Tier not eligible for this privilege",
      );
    }

    // 3 BEGIN TRANSACTION
    await client.query("BEGIN");

    // Q12 - Secure request ซ้ำ idempotency_key
    if (idempotencyKey) {
      const dupResult = await client.query<RedemptionRow>(
        `SELECT id, status FROM redemption
        WHERE idempotency_key = $1`,
        [idempotencyKey],
      );

      if ((dupResult.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        const existingRedemption = dupResult.rows[0];
        if (!existingRedemption) {
          throw handleError(500, "internal_error", "Unexpected error retrieving redemption");
        }
        return {
          status: 200,
          redemptionId: existingRedemption.id,
          message: "already redeemed",
        };
      }
    }

    //  Q6 - Check member not redeem privilege
    const alreadyRedeemed = await client.query<{ id: string }>(
      `SELECT id FROM redemption
       WHERE person_id = $1 AND privilege_id = $2
       AND status NOT IN ('cancelled')
       LIMIT 1`,
      [memberId, privilegeId],
    );

    if ((alreadyRedeemed.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      throw handleError(
        400,
        "already_redeemed",
        "Member already redeemed this privilege",
      );
    }

    // Q7 + Q11 - Check Quota and SELECT FOR UPDATE  (Secure race condition)
    const quotaResult = await client.query<QuotaRow>(
      `SELECT id, quota, used_quota FROM manage_quota
      WHERE privilege_id = $1 AND used_quota < quota
      FOR UPDATE`,
      [privilegeId],
    );

    if (quotaResult.rowCount === 0) {
      await client.query("ROLLBACK");
      throw handleError(
        400,
        "quota_exceeded",
        "This privilege is no longer available",
      );
    }

    // Q10 - Update used_quota
    await client.query(
      `UPDATE manage_quota
      SET used_quota = used_quota + 1, updated_at = NOW()
      WHERE privilege_id = $1`,
      [privilegeId],
    );

    // Q9 - Build redemption record
    const redemptionResult = await client.query<{ id: string }>(
      `INSERT INTO redemption
      (person_id, privilege_id, status, idempotency_key, redeemed_at, created_at)
       VALUES ($1, $2, 'pending', $3, NOW(), NOW())
       RETURNING id`,
      [memberId, privilegeId, idempotencyKey ?? null],
    );

    if (!redemptionResult.rows[0]) {
      await client.query("ROLLBACK");
      throw handleError(500, "internal_error", "Failed to create redemption record");
    }

    const redemptionId: string = redemptionResult.rows[0].id;

    // Q8 = reserve reward
    let rewardCode: string | undefined;
    if (privilege.type === "coupon" || privilege.type === "voucher") {
      const generateCodeResult = generateCode();

      const codeResult = await client.query<RewardCodeRow>(
        `INSERT INTO reward_code
        (redemption_id, type, code, status, expired_at, created_at)
        VALUES ($1, $2, $3, 'active', $4, NOW())
        RETURNING id, code`,
        [redemptionId, privilege.type, generateCodeResult, privilege.end_date],
      );

      rewardCode = codeResult.rows[0]?.code;
    }

    // Update redemption -> success

    await client.query(
      `UPDATE redemption SET status = 'success' WHERE id = $1`,
      [redemptionId],
    );

    await client.query(
      `INSERT INTO activity_log(person_id, action, description, created_at)
    VALUES ($1, 'redeem_success', $2, NOW())`,
      [memberId, `Redeemed privilege ${privilegeId}`],
    );

    await client.query(
      `INSERT INTO redemption_log
      (redemption_id, status_before, status_after, note, created_at)
      VALUES ($1, 'pending', 'success', 'Redemption completed', NOW())`,
      [redemptionId]
    )

    // Q13 - Commit
    await client.query("COMMIT");
    return {
      status: 200,
      message: "Redemption successful",
      redemptionId,
      ...(rewardCode !== undefined && { code: rewardCode }),
    };
  } catch (err: unknown) {
    // Q15 - rollback every thing if error happen
    await client.query("ROLLBACK"); 

    if (isHandleError(err)) throw err;

    throw handleError(
      500,
      "internal_error",
      (err as Error).message ?? "Unexpected error",
    );
  } finally {
    client.release();
  }
}

export default redeemPrivilege;
