// The server id alphabet is shared by the database, the unit names and the command line. It is restricted so that an id can
// never start with a dash (it would read as an option), contain a path separator, or be expanded by systemd.
export const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
