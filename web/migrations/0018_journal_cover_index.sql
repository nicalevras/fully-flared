INSERT INTO catalog_builds(id,kind,state,phase,state_json,scope_listing_id,created_at,updated_at)
VALUES('index:@posts','index','building','index','{}','@posts',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(id) DO UPDATE SET state='building',phase='index',state_json='{}',updated_at=excluded.updated_at WHERE state='done';
