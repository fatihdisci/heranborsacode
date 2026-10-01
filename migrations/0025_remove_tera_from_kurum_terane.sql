-- Update only the named templates. Existing jobs keep their original snapshots.
-- Preserve the order, delays and any additional fields of every remaining step.
UPDATE command_templates
SET steps_json = (
  SELECT json_group_array(json(value))
  FROM (
    SELECT value
    FROM json_each(command_templates.steps_json)
    WHERE lower(trim(json_extract(value, '$.command'))) NOT IN (
      '/kurum tera', '/derinlik tera'
    )
    ORDER BY CAST(key AS INTEGER)
  )
), updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  '7e8eced2-e884-4a46-9da4-4809a7b96179',
  'c7250fb2-82f5-446c-aa89-d2ba2cb1dcf6'
)
AND EXISTS (
  SELECT 1 FROM json_each(command_templates.steps_json)
  WHERE lower(trim(json_extract(value, '$.command'))) IN (
    '/kurum tera', '/derinlik tera'
  )
);
