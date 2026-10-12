-- A server may take plugins from more than one repository, and install only the plugins it names from each. Each row is now one
-- repository of one server, holding the list of plugin names it installs, so the single prefix column gives way to that list. The prefix a
-- row held before becomes the only entry of its list, and a repository appears once per server.
ALTER TABLE plugin_sources ADD COLUMN plugins TEXT NOT NULL DEFAULT '[]';
UPDATE plugin_sources SET plugins = json_array(asset_prefix);
ALTER TABLE plugin_sources DROP COLUMN asset_prefix;
CREATE UNIQUE INDEX plugin_sources_by_repo ON plugin_sources (server_id, repo);
