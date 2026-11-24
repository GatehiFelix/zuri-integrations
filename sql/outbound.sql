-- Outbound (pull API) views. Run as an ADMIN user, NOT zuri_integ, AFTER sql/schema.sql.
-- CRM tables are written as schema `zuridev` (dev). Point them at the real CRM schema when you run it:
--   dev:   mysql -u root -p zuri_integrations < sql/outbound.sql
--   prod:  sed 's/zuridev\./asteriskdb./g' sql/outbound.sql | mysql -u <admin> -p zuri_integrations
--
-- Views are SQL SECURITY DEFINER: the admin running this script becomes the definer and must keep SELECT on the
-- CRM tables. zuri_integ only gets SELECT on the views (see sql/grants.sql), never on the CRM tables.

USE zuri_integrations;

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