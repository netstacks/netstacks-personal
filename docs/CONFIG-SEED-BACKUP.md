# Backup & Seed (whole-database)

Back up, restore, or migrate your **entire** NetStacks setup by copying the local
database. Because it copies the whole database, it captures everything —
sessions, credential profiles, jump hosts, NetBox/LibreNMS/Crawler integrations
and their mappings/filters, AI setup, snippets, MOPs — configured or not.

Find it under **Settings → Integrations → Backup & Seed** (Personal/standalone mode only).

## Export

Pick one of two modes, then choose where to save the `.db` file (a native save
dialog — it does not auto-download):

- **Full backup** — includes secrets (the vault). For your own restore or moving to
  a new machine. The secrets remain encrypted under your existing master password;
  you unlock with that password after restoring.
- **Shareable seed** — **no secrets**. The database structure and all records are
  kept, but every secret is stripped: SSH passwords/passphrases, integration
  tokens, AI keys, secure-note bodies, and the master-password verifier are
  removed. Safe to hand to teammates.

In a shareable seed, a profile (or integration) is fully present — only the
secret attached to it is blank. After import, the recipient sets a master
password and re-enters those secrets in Settings; they attach to the same
profiles/resources automatically.

## Import (restore or seed)

1. **Import database…** → choose a `.db` file (native open dialog).
2. Confirm. Your current database is **backed up first** (timestamped, next to the
   live DB — it never overwrites a previous backup), then the import is staged.
3. The app **restarts** to apply it (a database can't be swapped while it's open).
4. On launch:
   - **Full backup** → unlock with the master password from that backup.
   - **Shareable seed** → you're prompted to set a new master password, then
     re-enter secrets in Settings.

## Where backups live

When you import, the previous database is copied to a timestamped file beside the
live DB:

- macOS: `~/Library/Application Support/netstacks/netstacks.db.bak-<timestamp>`
- Linux: `~/.local/share/netstacks/netstacks.db.bak-<timestamp>`
- Windows: `%APPDATA%\netstacks\netstacks.db.bak-<timestamp>`

To roll back manually: quit NetStacks, copy a `.bak-<timestamp>` over
`netstacks.db`, and relaunch.

## For admins: distribute an org seed

1. Configure one install exactly how everyone should start.
2. Export as a **Shareable seed** (no secrets) and distribute the `.db`.
3. Each engineer imports it, sets their master password, and fills in their own
   (or shared) secrets. Because the file has no secrets, it is safe to host on an
   internal share.

## Notes & limits

- The exported file is a normal SQLite database, copied with `VACUUM INTO` (a
  clean, consistent snapshot).
- Importing a database from a different app version is migrated forward on launch.
  Importing a **newer** database into an **older** app is not supported.
- Private SSH key *files* are referenced by path and are not contained in the
  database; place the key files (or repoint the path) on the target machine.
