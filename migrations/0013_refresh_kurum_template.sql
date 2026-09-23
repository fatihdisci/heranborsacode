UPDATE command_templates
SET steps_json = json_insert(
  (
    SELECT json_group_array(json(value))
    FROM (
      SELECT value
      FROM json_each(command_templates.steps_json)
      WHERE json_extract(value, '$.command') NOT IN (
        '/kurum a1 capital', '/kurum tacirler', '/kurum deniz',
        '/kurum ziraat', '/kurum yapı kredi'
      )
      ORDER BY CAST(key AS INTEGER)
    )
  ),
  '$[#]', json_object('botUsername', 'b0pt_bot', 'command', '/kurum ziraat', 'delaySeconds', 4),
  '$[#]', json_object('botUsername', 'b0pt_bot', 'command', '/kurum yapı kredi', 'delaySeconds', 4)
)
WHERE id = '7e8eced2-e884-4a46-9da4-4809a7b96179';
