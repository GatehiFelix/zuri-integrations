CREATE TABLE IF NOT EXISTS integration_recordings (
  id CHAR(24) NOT NULL, product_id BIGINT UNSIGNED NOT NULL, call_id VARCHAR(64) NOT NULL,
  file_key CHAR(40) NOT NULL, rel_path VARCHAR(300) NOT NULL, direction VARCHAR(10) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0, duration_sec INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('ready','gone') NOT NULL DEFAULT 'ready',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uq_rec (product_id, file_key), KEY ix_call (product_id, call_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
CREATE TABLE IF NOT EXISTS integration_recording_access (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, recording_id CHAR(24) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL, ip VARCHAR(45) NULL, format VARCHAR(4) NULL,
  http_status SMALLINT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY ix_acc (recording_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8;
GRANT SELECT,INSERT,UPDATE ON zuri_integrations.integration_recordings TO 'zuri_integ'@'192.168.200.55';
GRANT INSERT ON zuri_integrations.integration_recording_access TO 'zuri_integ'@'192.168.200.55';