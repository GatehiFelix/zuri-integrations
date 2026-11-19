-- Run once as an admin user. Separate schema so CRM model syncs never touch these tables.
CREATE DATABASE IF NOT EXISTS zuri_integrations CHARACTER SET utf8mb4;
USE zuri_integrations;

-- CREATE USER 'zuri_integ'@'%' IDENTIFIED BY 'change-me';
-- GRANT ALL PRIVILEGES ON zuri_integrations.* TO 'zuri_integ'@'%';
-- GRANT SELECT ON zuridev.queue_log TO 'zuri_integ'@'%';

CREATE TABLE IF NOT EXISTS integration_endpoints (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,            -- clients.product_id = queue_log.queue_id
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(128) NOT NULL,                   -- HMAC key (shown to the client once)
  default_country_code VARCHAR(4) NOT NULL DEFAULT '254',
  event_types VARCHAR(255) NOT NULL DEFAULT 'call.inbound',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product (product_id)
);

CREATE TABLE IF NOT EXISTS integration_checkpoint (
  name VARCHAR(50) PRIMARY KEY,                   -- 'inbound_enterqueue'
  last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  event_id VARCHAR(120) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  payload MEDIUMTEXT NOT NULL,                    -- TEXT, not JSON: old servers reject JSON columns
  status ENUM('pending','sent','dead') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error VARCHAR(500) NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event (product_id, event_id),
  KEY idx_due (status, next_attempt_at)
);

CREATE TABLE IF NOT EXISTS integration_delivery_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  outbox_id BIGINT UNSIGNED NOT NULL,
  attempt INT NOT NULL,
  status_code SMALLINT NULL,
  error VARCHAR(255) NULL,
  duration_ms INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_outbox (outbox_id)
);