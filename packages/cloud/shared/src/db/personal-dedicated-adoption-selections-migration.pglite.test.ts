/** Executes the Dedicated adoption migration on its real predecessor authority using PGlite. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const ORGANIZATION = "10000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000001";
const ACTOR = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000001";
const BACKUP = "40000000-0000-4000-8000-000000000001";
const SOURCE_AGENT = "personal:dedicated-migration-proof";
const HASH = "f".repeat(64);

const authorityMigration = readFileSync(
  new URL("./migrations/0319_personal_dedicated_upgrade_authorities.sql", import.meta.url),
  "utf8",
);
const adoptionMigration = readFileSync(
  new URL("./migrations/0329_personal_dedicated_adoption_selections.sql", import.meta.url),
  "utf8",
);
const rereviewMigration = readFileSync(
  new URL("./migrations/0377_personal_dedicated_rereview_residuals.sql", import.meta.url),
  "utf8",
);

let database: PGlite;

beforeAll(async () => {
  database = new PGlite();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE agent_sandboxes (id uuid PRIMARY KEY);
    CREATE TABLE agent_sandbox_backups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sandbox_record_id uuid REFERENCES agent_sandboxes(id) ON DELETE CASCADE,
      snapshot_type text NOT NULL DEFAULT 'manual'
    );
    INSERT INTO organizations (id) VALUES ('${ORGANIZATION}');
    INSERT INTO users (id) VALUES ('${USER}'), ('${ACTOR}');
    INSERT INTO agent_sandboxes (id) VALUES ('${AGENT}');
  `);
  await database.exec(authorityMigration);
  await database.exec(adoptionMigration);
  await database.exec(rereviewMigration);
}, 60_000);

afterAll(async () => {
  await database.close();
});

describe("personal Dedicated adoption selection migration", () => {
  test("installs the exact receipt shape and all backup mutation trigger events", async () => {
    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'personal_dedicated_adoption_selections'
      ORDER BY ordinal_position
    `);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "id",
      "organization_id",
      "user_id",
      "source_agent_id",
      "dedicated_agent_id",
      "selected_by_user_id",
      "selection_reason",
      "state_disposition",
      "activation_kind",
      "activation_backup_id",
      "activation_backup_hash",
      "activation_backup_chain",
      "restore_fence_hash",
      "restore_fence_started_at",
      "inventory_fingerprint",
      "candidate_count",
      "schema_version",
      "selected_at",
      "created_at",
      "updated_at",
      "rereviewed_by_user_id",
    ]);

    const triggerEvents = await database.query<{ event_manipulation: string }>(`
      SELECT event_manipulation
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = 'agent_sandbox_backups'
        AND trigger_name = 'agent_sandbox_backups_reviewed_restore_fence'
      ORDER BY event_manipulation
    `);
    expect(triggerEvents.rows.map(({ event_manipulation }) => event_manipulation)).toEqual([
      "DELETE",
      "INSERT",
      "UPDATE",
    ]);

    const oldTargetForeignKey = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM pg_constraint
      WHERE conname =
        'personal_dedicated_upgrade_authorities_dedicated_agent_id_agent_sandboxes_id_fk'
    `);
    expect(oldTargetForeignKey.rows).toEqual([{ count: "0" }]);
  });

  test("rejects backup writes while fenced and permits them after release", async () => {
    await database.exec(`
      INSERT INTO personal_dedicated_adoption_selections (
        organization_id, user_id, source_agent_id, dedicated_agent_id,
        selected_by_user_id, selection_reason, state_disposition, activation_kind,
        restore_fence_hash, restore_fence_started_at, inventory_fingerprint,
        candidate_count
      ) VALUES (
        '${ORGANIZATION}', '${USER}', '${SOURCE_AGENT}', '${AGENT}',
        '${ACTOR}', 'duplicate_owned_dedicated_inventory',
        'fresh_boot_no_verified_backup', 'fresh_boot', '${HASH}', now(), '${HASH}', 2
      )
    `);

    await expect(
      database.exec(`
        INSERT INTO agent_sandbox_backups (id, sandbox_record_id)
        VALUES ('${BACKUP}', '${AGENT}')
      `),
    ).rejects.toThrow(/reviewed restore authority is fenced/);

    await database.exec(`
      UPDATE personal_dedicated_adoption_selections
      SET restore_fence_hash = NULL, restore_fence_started_at = NULL
      WHERE dedicated_agent_id = '${AGENT}';
      INSERT INTO agent_sandbox_backups (id, sandbox_record_id)
      VALUES ('${BACKUP}', '${AGENT}');
    `);
    const backups = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM agent_sandbox_backups WHERE id = '${BACKUP}'
    `);
    expect(backups.rows).toEqual([{ count: "1" }]);
  });

  test("re-review residual migration records the actor and allows a sole remaining candidate", async () => {
    await database.exec(
      `DELETE FROM personal_dedicated_adoption_selections WHERE dedicated_agent_id = '${AGENT}'`,
    );
    await database.exec(`
      INSERT INTO personal_dedicated_adoption_selections (
        organization_id, user_id, source_agent_id, dedicated_agent_id,
        selected_by_user_id, rereviewed_by_user_id, selection_reason,
        state_disposition, activation_kind, inventory_fingerprint, candidate_count
      ) VALUES (
        '${ORGANIZATION}', '${USER}', '${SOURCE_AGENT}', '${AGENT}',
        '${USER}', '${ACTOR}', 'duplicate_owned_dedicated_inventory',
        'fresh_boot_no_verified_backup', 'fresh_boot', '${HASH}', 1
      )
    `);

    const soleCandidate = await database.query<{ count: string }>(`
      SELECT count(*)::text AS count
      FROM personal_dedicated_adoption_selections
      WHERE candidate_count = 1 AND rereviewed_by_user_id = '${ACTOR}'
    `);
    expect(soleCandidate.rows).toEqual([{ count: "1" }]);

    await expect(
      database.exec(`
        UPDATE personal_dedicated_adoption_selections
        SET candidate_count = 0
        WHERE dedicated_agent_id = '${AGENT}'
      `),
    ).rejects.toThrow(/candidate_count_check/);

    await database.exec(`DELETE FROM users WHERE id = '${ACTOR}'`);
    const nulled = await database.query<{ rereviewed_by: string | null }>(`
      SELECT rereviewed_by_user_id AS rereviewed_by
      FROM personal_dedicated_adoption_selections
      WHERE dedicated_agent_id = '${AGENT}'
    `);
    expect(nulled.rows).toEqual([{ rereviewed_by: null }]);
  });

  test("preserves selection and upgrade tombstones after target deletion", async () => {
    await database.exec(`
      INSERT INTO personal_dedicated_upgrade_authorities (
        organization_id, user_id, source_agent_id, dedicated_agent_id
      ) VALUES ('${ORGANIZATION}', '${USER}', '${SOURCE_AGENT}', '${AGENT}');
      DELETE FROM agent_sandboxes WHERE id = '${AGENT}';
    `);

    const tombstones = await database.query<{ table_name: string; count: string }>(`
      SELECT 'adoption' AS table_name, count(*)::text AS count
      FROM personal_dedicated_adoption_selections
      WHERE dedicated_agent_id = '${AGENT}'
      UNION ALL
      SELECT 'upgrade' AS table_name, count(*)::text AS count
      FROM personal_dedicated_upgrade_authorities
      WHERE dedicated_agent_id = '${AGENT}'
      ORDER BY table_name
    `);
    expect(tombstones.rows).toEqual([
      { table_name: "adoption", count: "1" },
      { table_name: "upgrade", count: "1" },
    ]);
  });
});
