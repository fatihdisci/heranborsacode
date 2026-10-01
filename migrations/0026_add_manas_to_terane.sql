-- Append MANAS once, preserving existing Terane steps and job snapshots.
UPDATE command_templates
SET steps_json = json_insert(
  steps_json,
  '$[#]', json_object('botUsername', 'b0pt_bot', 'command', '/derinlik manas', 'delaySeconds', 3)
), updated_at = CURRENT_TIMESTAMP
WHERE id = 'c7250fb2-82f5-446c-aa89-d2ba2cb1dcf6'
AND NOT EXISTS (
  SELECT 1 FROM json_each(command_templates.steps_json)
  WHERE lower(trim(json_extract(value, '$.command'))) = '/derinlik manas'
);
