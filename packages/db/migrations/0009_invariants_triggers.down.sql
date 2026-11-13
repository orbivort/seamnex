DROP TRIGGER IF EXISTS settings_guard ON settings;
DROP FUNCTION IF EXISTS seamnex_settings_guard();

DROP TRIGGER IF EXISTS group_mapping_guard ON group_mapping;
DROP FUNCTION IF EXISTS seamnex_group_mapping_guard();

DROP TRIGGER IF EXISTS entitlement_sync_state ON entitlement;
DROP FUNCTION IF EXISTS seamnex_entitlement_sync_state();

DROP TRIGGER IF EXISTS backup_requires_artefact ON backup;
DROP TRIGGER IF EXISTS backup_render_set ON backup;
DROP FUNCTION IF EXISTS seamnex_backup_requires_artefact();
DROP FUNCTION IF EXISTS seamnex_backup_render_set();

DROP TRIGGER IF EXISTS instance_route_lifespan_recheck ON instance_route;
DROP FUNCTION IF EXISTS seamnex_instance_route_lifespan_recheck();

DROP TRIGGER IF EXISTS idp_client_lifespan ON idp_client;
DROP FUNCTION IF EXISTS seamnex_idp_client_lifespan();

DROP TRIGGER IF EXISTS credential_scope_mode ON credential_scope;
DROP FUNCTION IF EXISTS seamnex_credential_scope_mode();

DROP TRIGGER IF EXISTS instance_slug_reserved ON instance;
DROP FUNCTION IF EXISTS seamnex_instance_slug_reserved();

DROP TRIGGER IF EXISTS break_glass_immutable ON break_glass_session;
DROP FUNCTION IF EXISTS seamnex_break_glass_immutable();

DROP TRIGGER IF EXISTS render_set_immutable ON render_set;
DROP FUNCTION IF EXISTS seamnex_render_set_immutable();

DROP TRIGGER IF EXISTS audit_event_no_truncate ON audit_event;
DROP TRIGGER IF EXISTS audit_event_no_update_delete ON audit_event;
DROP TRIGGER IF EXISTS audit_event_append ON audit_event;
DROP FUNCTION IF EXISTS seamnex_audit_event_immutable();
DROP FUNCTION IF EXISTS seamnex_audit_event_append();
DROP FUNCTION IF EXISTS seamnex_audit_hash(text, bigint, timestamptz, uuid, text, text, text, text, text, text, jsonb, text);
DROP TABLE IF EXISTS audit_chain;

ALTER TABLE workflow DROP CONSTRAINT IF EXISTS workflow_current_version_fk;
ALTER TABLE render_set DROP CONSTRAINT IF EXISTS render_set_plan_fk;
ALTER TABLE instance_env_value DROP CONSTRAINT IF EXISTS instance_env_value_render_set_fk;
ALTER TABLE instance_param DROP CONSTRAINT IF EXISTS instance_param_instance_fk;
ALTER TABLE catalog_entry DROP CONSTRAINT IF EXISTS catalog_entry_primary_instance_fk;
