-- This template uses the ordinary result delivery path: text responses arrive
-- as Telegram messages rather than the bundled Kurum template's TXT/PDF files.
INSERT OR IGNORE INTO command_templates(id,name,steps_json) VALUES
('bfd240af-f2ad-46da-a39a-8f420fe1dc34','genel kurum','[{"botUsername":"ucretsizderinlikbot","command":"/kurum","delaySeconds":3}]');
