-- Article cards whose note has no article (e.g. pos changed) would be quizzed forever: suspend them.
UPDATE "cards" SET "suspended" = true
WHERE "template" = 'article' AND NOT "suspended"
  AND "note_id" IN (SELECT "id" FROM "notes" WHERE "fields"->>'article' IS NULL);
