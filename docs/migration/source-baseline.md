# Imported source baseline

Pointer was initialized on 2026-07-30 from exact tracked snapshots of two
previously separate repositories. Their Git histories were intentionally not
imported; those repositories remain the historical record.

| Imported component | Donor repository | Imported commit |
| --- | --- | --- |
| server and CLI | `https://github.com/YouEye-Platform/Pointer-Lite.git` | `9435350c95d6a2bd5be2653b543c0490b410bffc` |
| web | `https://github.com/YouEye-Platform/Pointer-WebUI.git` | `8acead41203f51ea5728601be8f634658cd4b87c` |

Only tracked source, tests, contracts and relevant documentation were imported.
No repository metadata, dependency directories, build output, environment
files, credentials, databases, backups or deployment secrets were copied.

At import preflight, both donors were clean and exactly matched their remote
`main` heads. The existing deployment was healthy, its PostgreSQL schema was
version 16, and stored provider credential envelopes were decryptable with the
retained production encryption configuration. Counts and secret material are
deliberately excluded from this source record.
