CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE login_tokens(id TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT NOT NULL,revoked_at TEXT);
CREATE TABLE sessions(hash TEXT PRIMARY KEY,expires TEXT NOT NULL,token_id TEXT REFERENCES login_tokens(id));
CREATE TABLE oauth_codes(hash TEXT PRIMARY KEY,data TEXT NOT NULL,expires TEXT NOT NULL);
CREATE TABLE worker_registrations(id TEXT PRIMARY KEY,worker_id TEXT,principal TEXT,artifact_id TEXT,body TEXT,state TEXT);
