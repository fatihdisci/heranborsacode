UPDATE command_templates
SET steps_json = (
  SELECT json_group_array(json(json_set(value, '$.delaySeconds', 3)))
  FROM (
    SELECT value
    FROM json_each(command_templates.steps_json)
    ORDER BY CAST(key AS INTEGER)
  )
), updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  '7e8eced2-e884-4a46-9da4-4809a7b96179',
  'c7250fb2-82f5-446c-aa89-d2ba2cb1dcf6'
);
