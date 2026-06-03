"use server";

/**
 * Server actions for the first-run /setup page.
 *
 * createAdminUser():
 *   1. Guards against running when any user already exists (idempotent).
 *   2. Creates an org ("My Organization" — can be renamed in settings).
 *   3. Creates the admin user with a bcrypt-hashed password.
 *
 * Only called when AUTH_PROVIDER=authjs (self-hosted).
 * Supabase deployments never reach this page.
 */

import { Pool } from "pg";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

const BCRYPT_COST = 12;

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  // Short-lived: setup runs once, then the user is redirected away
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
}

export type SetupResult =
  | { ok: true }
  | { ok: false; error: string };

export async function isAlreadyConfigured(): Promise<boolean> {
  const pool = getPool();
  try {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM users LIMIT 1"
    );
    return parseInt(rows[0]?.count ?? "0", 10) > 0;
  } finally {
    await pool.end();
  }
}

export async function createAdminUser(formData: FormData): Promise<SetupResult> {
  const orgName = (formData.get("org_name") as string | null)?.trim();
  const email = (formData.get("email") as string | null)?.toLowerCase().trim();
  const password = formData.get("password") as string | null;
  const confirm = formData.get("confirm") as string | null;

  // ── Validation ───────────────────────────────────────────────────────────
  if (!orgName || orgName.length < 1) {
    return { ok: false, error: "Organization name is required." };
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "A valid email address is required." };
  }
  if (!password || password.length < 12) {
    return { ok: false, error: "Password must be at least 12 characters." };
  }
  if (password !== confirm) {
    return { ok: false, error: "Passwords do not match." };
  }

  const pool = getPool();
  try {
    // ── Guard: fail if any user exists ──────────────────────────────────────
    const { rows: check } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM users"
    );
    if (parseInt(check[0]?.count ?? "0", 10) > 0) {
      return { ok: false, error: "This instance is already configured. Sign in instead." };
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const orgId = `org_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

    // ── Transactional insert ─────────────────────────────────────────────────
    await pool.query("BEGIN");
    try {
      await pool.query(
        "INSERT INTO orgs (id, name) VALUES ($1, $2)",
        [orgId, orgName]
      );
      await pool.query(
        "INSERT INTO users (email, password_hash, org_id, role) VALUES ($1, $2, $3, 'owner')",
        [email, passwordHash, orgId]
      );
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }

    return { ok: true };
  } catch (err) {
    console.error("[setup] createAdminUser failed:", err);
    return { ok: false, error: "Setup failed. Check server logs for details." };
  } finally {
    await pool.end();
  }
}
