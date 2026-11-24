-- zuri_integ user + grants. Run ONCE as an ADMIN user, AFTER sql/schema.sql and sql/outbound.sql.
-- Edit a COPY (keep the password out of git), replace every <PLACEHOLDER>; a leftover one is a syntax error on purpose.
--   <APP_HOST>          host the service connects from, as the DB sees it (prod 192.168.200.213, or localhost)
--   <PASSWORD>          strong password for zuri_integ (no ' or \ characters)
--   <QUEUE_LOG_DB>      schema of the real queue_log (prod asteriskdb, dev zuridev)
--   <QUEUE_LOG_TABLE>   queue_log
-- The service's .env must then use QUEUE_LOG_TABLE=<QUEUE_LOG_DB>.<QUEUE_LOG_TABLE>.

CREATE USER 'zuri_integ'@'<APP_HOST>' IDENTIFIED BY '<PASSWORD>';

-- Own tables: read/write
GRANT SELECT, INSERT, UPDATE, DELETE ON zuri_integrations.integration_endpoints      TO 'zuri_integ'@'<APP_HOST>';
GRANT SELECT, INSERT, UPDATE, DELETE ON zuri_integrations.integration_agent_state    TO 'zuri_integ'@'<APP_HOST>';
GRANT SELECT, INSERT, UPDATE, DELETE ON zuri_integrations.integration_checkpoint     TO 'zuri_integ'@'<APP_HOST>';
GRANT SELECT, INSERT, UPDATE, DELETE ON zuri_integrations.integration_outbox         TO 'zuri_integ'@'<APP_HOST>';
GRANT SELECT, INSERT, UPDATE, DELETE ON zuri_integrations.integration_delivery_log   TO 'zuri_integ'@'<APP_HOST>';
GRANT SELECT, INSERT, UPDATE, DELETE ON zuri_integrations.integration_api_keys       TO 'zuri_integ'@'<APP_HOST>';

-- CRM-facing views: SELECT ONLY
GRANT SELECT ON zuri_integrations.v_export_campaigns TO 'zuri_integ'@'<APP_HOST>';
GRANT SELECT ON zuri_integrations.v_export_contacts  TO 'zuri_integ'@'<APP_HOST>';
GRANT SELECT ON zuri_integrations.v_export_account   TO 'zuri_integ'@'<APP_HOST>';

-- The poller reads the real call log
GRANT SELECT ON <QUEUE_LOG_DB>.<QUEUE_LOG_TABLE> TO 'zuri_integ'@'<APP_HOST>';

-- NOTE: never grant on zuri_integrations.* as a whole. v_export_campaigns and v_export_account are single-table
-- views, which MySQL/MariaDB treat as updatable. With schema-level UPDATE/DELETE, zuri_integ could modify or delete
-- CRM rows through them (the DEFINER executes the write). Per-table grants close that.