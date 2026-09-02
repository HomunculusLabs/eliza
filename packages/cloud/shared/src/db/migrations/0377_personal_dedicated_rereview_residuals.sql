-- Durable re-review audit attribution plus the sole-remaining-candidate
-- reconciliation boundary for personal Dedicated adoption selections.
--
-- Re-review of a stale receipt is an explicit operator decision that must
-- remain attributable even when the reviewed inventory has since shrunk to
-- exactly one eligible candidate; the initial selection keeps requiring a
-- genuinely ambiguous (>= 2 candidate) inventory, enforced in application
-- code rather than by this relaxed receipt constraint.

ALTER TABLE "personal_dedicated_adoption_selections"
  ADD COLUMN "rereviewed_by_user_id" uuid;

ALTER TABLE "personal_dedicated_adoption_selections"
  ADD CONSTRAINT "personal_dedicated_adoption_selections_rereviewed_by_user_id_users_id_fk"
    FOREIGN KEY ("rereviewed_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;

ALTER TABLE "personal_dedicated_adoption_selections"
  DROP CONSTRAINT "personal_dedicated_adoption_selections_candidate_count_check";

ALTER TABLE "personal_dedicated_adoption_selections"
  ADD CONSTRAINT "personal_dedicated_adoption_selections_candidate_count_check"
    CHECK ("candidate_count" >= 1);
