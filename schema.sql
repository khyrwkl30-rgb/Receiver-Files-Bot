CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  service TEXT,
  model TEXT,
  photo_id TEXT,
  price REAL,
  status TEXT DEFAULT 'new',
  receipt_id TEXT,
  file_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_state (
  user_id TEXT PRIMARY KEY,
  order_id INTEGER,
  action TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
