USE zuri_integrations;

CREATE TABLE IF NOT EXISTS queue_log_dev (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trx_id BIGINT UNSIGNED NOT NULL,
  event_time VARCHAR(100) NOT NULL,
  queue_id VARCHAR(255) NOT NULL,
  agent VARCHAR(255) NOT NULL,
  event_name VARCHAR(255) NOT NULL,
  delay_time INT NULL,
  msisdn VARCHAR(255) NULL,
  queue_pos INT NULL,
  call_len INT NOT NULL DEFAULT 0,
  created DATETIME NOT NULL,
  dispositioned VARCHAR(10) NOT NULL DEFAULT 'no',
  fully_resolved VARCHAR(10) NOT NULL DEFAULT 'no',
  comment VARCHAR(255) NULL
);