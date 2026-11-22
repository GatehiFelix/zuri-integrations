-- LOCAL DEV ONLY. Minimal copies of the CRM tables so the views and API can be tested.
-- Apply: sed 's/zuridev\./YOUR_LOCAL_DB./g' sql/dev_outbound_seed.sql | mysql -u root
-- (create YOUR_LOCAL_DB first if it does not exist)

CREATE TABLE IF NOT EXISTS zuridev.clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL UNIQUE,
  prefix VARCHAR(255) NULL,
  created_at DATETIME NULL, updated_at DATETIME NULL
);
CREATE TABLE IF NOT EXISTS zuridev.campaigns (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  campaign_name VARCHAR(255) NOT NULL,
  status ENUM('active','deleted') NOT NULL DEFAULT 'active',
  created_at DATETIME NULL, updated_at DATETIME NULL
);
CREATE TABLE IF NOT EXISTS zuridev.client_contacts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT NOT NULL,
  campaign_id BIGINT NULL,
  col_1 VARCHAR(255) NULL,
  status VARCHAR(255) NOT NULL DEFAULT 'Not Called',
  deleted VARCHAR(255) NOT NULL DEFAULT 'no',
  created_at DATETIME NULL, updated_at DATETIME NULL, actioned_at DATETIME NULL,
  KEY idx_campaign (campaign_id)
);

INSERT INTO zuridev.clients (id, name, product_id, prefix, created_at) VALUES
  (1, 'Dev Client', 6000, '80, 10, 6', NOW()),
  (2, 'Other Client', 7000, '9', NOW());
INSERT INTO zuridev.campaigns (id, product_id, campaign_name, status, created_at, updated_at) VALUES
  (1, 6000, 'Nov Renewals', 'active',  '2026-11-01 08:00:00', '2026-11-01 08:00:00'),
  (2, 6000, 'Old Campaign', 'deleted', '2026-09-01 08:00:00', '2026-11-10 08:00:00'),
  (3, 7000, 'Other tenant', 'active',  '2026-11-01 08:00:00', '2026-11-01 08:00:00');
INSERT INTO zuridev.client_contacts (client_id, campaign_id, col_1, deleted, created_at, updated_at, actioned_at) VALUES
  (1, 1, '0712000001', 'no',  '2026-11-01 09:00:00', '2026-11-01 09:00:00', NULL),
  (1, 1, '0712000002', 'no',  '2026-11-01 09:00:00', '2026-11-05 10:00:00', '2026-11-05 10:00:00'),
  (1, 1, '0712000003', 'yes', '2026-11-01 09:00:00', '2026-11-06 11:00:00', NULL),
  (1, 1, '0712000004', 'no',  '2026-11-02 09:00:00', NULL, NULL),
  (1, 2, '0712000005', 'no',  '2026-09-02 09:00:00', '2026-09-02 09:00:00', NULL),
  (2, 3, '0722000001', 'no',  '2026-11-01 09:00:00', '2026-11-01 09:00:00', NULL);