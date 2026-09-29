-- Copy the current Terane stock order and delays without changing its template.
INSERT OR IGNORE INTO command_templates(id,name,steps_json)
SELECT 'e36042c7-799a-4843-8525-fcba34a66d68','akdterane',
  REPLACE(steps_json,'/derinlik ','/akd ')
FROM command_templates
WHERE id='c7250fb2-82f5-446c-aa89-d2ba2cb1dcf6';
