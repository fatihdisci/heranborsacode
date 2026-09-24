CREATE TABLE IF NOT EXISTS safari_extension_rate (
  window_minute INTEGER PRIMARY KEY,
  used INTEGER NOT NULL CHECK(used BETWEEN 1 AND 15)
);
