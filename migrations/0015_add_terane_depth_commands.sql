UPDATE command_templates
SET steps_json = json_insert(
  json_insert(
    steps_json,
    '$[#]',
    json_object('botUsername', 'b0pt_bot', 'command', '/derinlik paseu', 'delaySeconds', 3)
  ),
  '$[#]',
  json_object('botUsername', 'b0pt_bot', 'command', '/derinlik hedef', 'delaySeconds', 3)
)
WHERE id = 'c7250fb2-82f5-446c-aa89-d2ba2cb1dcf6';
