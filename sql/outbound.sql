-- Outbound (pull API) objects. Run as an admin user, NOT as zuri_integ.
-- CRM tables are assumed to live in schema `zuridev`. For a local DB:
--   sed 's/zuridev\./YOUR_LOCAL_DB./g' sql/outbound.sql | mysql -u root zuri_integrations
--
-- Views are SQL SECURITY DEFINER, so zuri_integ only needs SELECT on the views
-- (no grant on the CRM tables themselves).

USE zuri_integrations;

-- ---------------------------------------------------------------- API keys
CREATE TABLE IF NOT EXISTS integration_api_keys (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id   BIGINT UNSIGNED NOT NULL,                 -- tenant
  key_prefix   CHAR(8) NOT NULL,                         -- public lookup part of the key
  key_hash     CHAR(64) NOT NULL,                        -- sha256(full key), hex
  label        VARCHAR(100) NULL,
  status       ENUM('active','revoked') NOT NULL DEFAULT 'active',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  revoked_at   TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uq_key_prefix (key_prefix),
  KEY idx_product (product_id, status)
) ENGINE=InnoDB;

-- ------------------------------------------------------------------ views
-- Campaigns of a tenant (tenant = campaigns.product_id)
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_export_campaigns AS
SELECT
  ca.id                                   AS campaign_id,
  ca.product_id                           AS tenant,
  ca.campaign_name                        AS name,
  ca.status                               AS status,          -- 'active' | 'deleted'
  ca.created_at                           AS created_at
FROM zuridev.campaigns ca;

-- Contacts: bare number (col_1) only. Tenant isolation is enforced twice:
-- the contact's client must belong to the same product_id as its campaign.
-- A contact is "deleted" if it was soft-deleted OR its campaign was deleted.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_export_contacts AS
SELECT
  cc.id                                   AS contact_id,
  ca.product_id                           AS tenant,
  cc.campaign_id                          AS campaign_id,
  cc.col_1                                AS msisdn,
  cc.created_at                           AS created_at,
  cc.actioned_at                          AS actioned_at,
  (cc.deleted = 'yes' OR ca.status = 'deleted') AS is_deleted,
  GREATEST(
    COALESCE(cc.updated_at, cc.created_at, '1970-01-01 00:00:01'),
    COALESCE(ca.updated_at, ca.created_at, '1970-01-01 00:00:01')
  )                                       AS changed_at
FROM zuridev.client_contacts cc
JOIN zuridev.campaigns ca ON ca.id = cc.campaign_id
JOIN zuridev.clients   cl ON cl.id = cc.client_id AND cl.product_id = ca.product_id;

-- Prefixes (clients.prefix, may be comma separated) per tenant
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_export_account AS
SELECT cl.product_id AS tenant, cl.prefix AS prefix
FROM zuridev.clients cl;

-- ----------------------------------------------------------------- grants
-- GRANT SELECT ON zuri_integrations.v_export_campaigns TO 'zuri_integ'@'127.0.0.1';
-- GRANT SELECT ON zuri_integrations.v_export_contacts  TO 'zuri_integ'@'127.0.0.1';
-- GRANT SELECT ON zuri_integrations.v_export_account   TO 'zuri_integ'@'127.0.0.1';
-- (integration_api_keys is covered by the existing SELECT/INSERT/UPDATE/DELETE on zuri_integrations.*)