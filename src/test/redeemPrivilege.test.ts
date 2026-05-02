import redeemPrivilege from "../redeemPrivilege";

// Mock pg ทั้งหมด (Testing)
jest.mock("pg", () => {
  const mQuery = jest.fn();
  const mRelease = jest.fn();
  const mClient = { query: mQuery, release: mRelease };
  const mPool = { connect: jest.fn(() => Promise.resolve(mClient)) };
  return { Pool: jest.fn(() => mPool) };
});

import { Pool } from "pg";

// Helper ดึง mock client
const getMockClient = () => {
  const pool = new Pool() as any;
  return pool.connect() as any;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("redeemPrivilege", () => {

  test("should throw 404 if member not found", async () => {
    const client = await getMockClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // member not found

    await expect(
      redeemPrivilege({ companyId: "c1", memberId: "m1", privilegeId: "p1" })
    ).rejects.toMatchObject({ status: 404, error: "member_not_found" });
  });

  test("should throw 403 if member inactive", async () => {
    const client = await getMockClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", tier_id: "1", status: "inactive" }] });

    await expect(
      redeemPrivilege({ companyId: "c1", memberId: "m1", privilegeId: "p1" })
    ).rejects.toMatchObject({ status: 403, error: "member_inactive" });
  });

  test("should throw 404 if privilege not found", async () => {
    const client = await getMockClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", tier_id: "1", status: "active" }] }) // member
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // privilege not found

    await expect(
      redeemPrivilege({ companyId: "c1", memberId: "m1", privilegeId: "p1" })
    ).rejects.toMatchObject({ status: 404, error: "privilege_not_found" });
  });

  test("should throw 400 if privilege expired", async () => {
    const client = await getMockClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", tier_id: "1", status: "active" }] }) // member
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ 
        id: "p1", status: "active",
        start_date: new Date("2020-01-01"),
        end_date: new Date("2020-12-31"), // หมดอายุแล้ว
        type: "coupon"
      }] });

    await expect(
      redeemPrivilege({ companyId: "c1", memberId: "m1", privilegeId: "p1" })
    ).rejects.toMatchObject({ status: 400, error: "privilege_expired" });
  });

  test("should throw 403 if tier not eligible", async () => {
    const client = await getMockClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", tier_id: "0", status: "active" }] }) // member silver
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ 
        id: "p1", status: "active",
        start_date: new Date("2020-01-01"),
        end_date: new Date("2099-12-31"),
        type: "coupon"
      }] }) // privilege
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // tier not eligible

    await expect(
      redeemPrivilege({ companyId: "c1", memberId: "m1", privilegeId: "p1" })
    ).rejects.toMatchObject({ status: 403, error: "tier_not_eligible" });
  });

  test("should throw 400 if quota exceeded", async () => {
    const client = await getMockClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", tier_id: "1", status: "active" }] }) // member
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ 
        id: "p1", status: "active",
        start_date: new Date("2020-01-01"),
        end_date: new Date("2099-12-31"),
        type: "coupon"
      }] }) // privilege
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] }) // tier ok
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // idempotency ok
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // not redeemed yet
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // quota exceeded

    await expect(
      redeemPrivilege({ companyId: "c1", memberId: "m1", privilegeId: "p1" })
    ).rejects.toMatchObject({ status: 400, error: "quota_exceeded" });
  });

  test("should return 200 on success", async () => {
    const client = await getMockClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "m1", tier_id: "1", status: "active" }] }) // member
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ 
        id: "p1", status: "active",
        start_date: new Date("2020-01-01"),
        end_date: new Date("2099-12-31"),
        type: "gift" // ไม่ต้อง generate code
      }] }) // privilege
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ exists: true }] }) // tier ok
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // idempotency ok
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // not redeemed yet
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "q1", quota: 100, used_quota: 50 }] }) // quota ok
      .mockResolvedValueOnce({}) // update used_quota
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "r1" }] }) // insert redemption
      .mockResolvedValueOnce({}) // update redemption success
      .mockResolvedValueOnce({}) // activity_log
      .mockResolvedValueOnce({}) // redemption_log
      .mockResolvedValueOnce({}); // COMMIT

    const result = await redeemPrivilege({
      companyId: "c1", memberId: "m1", privilegeId: "p1",
      idempotencyKey: "key-123"
    });

    expect(result.status).toBe(200);
    expect(result.redemptionId).toBe("r1");
  });

});