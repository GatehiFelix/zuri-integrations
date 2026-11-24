-- zuri-integrations tables. Idempotent and safe on MariaDB 5.5 and newer.
-- Run as an ADMIN user (not zuri_integ), in this order:
--   mysql -u <admin> -p < sql/schema.sql      (this file: database + tables)
--   sed 's/zuridev\./<CRM_DB>./g' sql/outbound.sql | mysql -u <admin> -p zuri_integrations   (views)
--   sql/grants.sql                            (user + grants, edit the placeholders first)
--
-- 5.5 rules this file follows. Do not "modernize" them:
--   * only ONE TIMESTAMP column per table may use DEFAULT/ON UPDATE CURRENT_TIMESTAMP
--   * DATETIME cannot default to CURRENT_TIMESTAMP, so integration_outbox.next_attempt_at defaults to the
--     epoch and src/poller.js MUST insert it as NOW() (otherwise the sweeper sees every new row as overdue)
--   * no ADD COLUMN IF NOT EXISTS, no CREATE USER IF NOT EXISTS
--   * ENGINE=InnoDB is explicit on every table
--
-- Existing database created from the old schema? CREATE TABLE IF NOT EXISTS will not add new columns. Run once:
--   ALTER TABLE integration_endpoints ADD COLUMN expose_agent_name TINYINT(1) NOT NULL DEFAULT 0;

CREATE DATABASE IF NOT EXISTS zuri_integrations CHARACTER SET utf8mb4;
USE zuri_integrations;

CREATE TABLE IF NOT EXISTS integration_endpoints (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,            -- clients.product_id = queue_log.queue_id
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(128) NOT NULL,                   -- HMAC key (shown to the client once)
  default_country_code VARCHAR(4) NOT NULL DEFAULT '254',
  event_types VARCHAR(255) NOT NULL DEFAULT 'call.inbound',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expose_agent_name TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_product (product_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS integration_agent_state (
  product_id   VARCHAR(32)  NOT NULL,
  location     VARCHAR(128) NOT NULL,
  member_name  VARCHAR(128) NULL,
  in_queue     TINYINT(1)   NOT NULL,
  paused       TINYINT(1)   NOT NULL DEFAULT 0,
  pause_reason VARCHAR(255) NULL,
  seq          BIGINT UNSIGNED NOT NULL DEFAULT 0,
  changed_at   DATETIME(3)  NOT NULL,             -- fractional seconds: MariaDB 5.3+ / MySQL 5.6+
  PRIMARY KEY (product_id, location)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS integration_checkpoint (
  name VARCHAR(50) PRIMARY KEY,                   -- 'inbound_enterqueue'; the poller seeds it at MAX(id) on first run
  last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS integration_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  event_id VARCHAR(120) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  payload MEDIUMTEXT NOT NULL,                    -- TEXT, not JSON: old servers reject JSON columns
  status ENUM('pending','sent','dead') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT '1970-01-01 00:00:01',   -- the poller sets NOW() on insert
  last_error VARCHAR(500) NULL,
  sent_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event (product_id, event_id),
  KEY idx_due (status, next_attempt_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS integration_delivery_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  outbox_id BIGINT UNSIGNED NOT NULL,
  attempt INT NOT NULL,
  status_code SMALLINT NULL,
  error VARCHAR(255) NULL,
  duration_ms INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_outbox (outbox_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS integration_api_keys (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id   BIGINT UNSIGNED NOT NULL,          -- tenant
  key_prefix   CHAR(8) NOT NULL,                  -- public lookup part of the key
  key_hash     CHAR(64) NOT NULL,                 -- sha256(full key), hex
  label        VARCHAR(100) NULL,
  status       ENUM('active','revoked') NOT NULL DEFAULT 'active',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  revoked_at   TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uq_key_prefix (key_prefix),
  KEY idx_product (product_id, status)
) ENGINE=InnoDB;