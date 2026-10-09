-- STRIKE V2-5 — bound the server-authored KDS modifier summary.
-- Forward-only follow-up. Existing historical preparation tasks keep NULL.
BEGIN;

ALTER TABLE "restaurant_preparation_tasks"
  ADD CONSTRAINT "restaurant_preparation_tasks_modifier_summary_bounded"
  CHECK (
    "modifierSummary" IS NULL
    OR (
      "modifierSummary" = btrim("modifierSummary")
      AND char_length("modifierSummary") BETWEEN 1 AND 500
    )
  );

COMMIT;
