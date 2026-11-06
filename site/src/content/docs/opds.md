---
title: OPDS and KOReader
description: Connect e-reader apps through OPDS and sync KOReader progress.
---

## OPDS

The catalog address is `http://<server>:3000/opds` (OPDS 2: `/opds/v2`). Sign in with a library user's login and password. Works with KOReader, FBReader, Moon+ Reader, Librera.

Books you have started show their progress in the title: ◔ ◑ ◕ ⬤.

Under «My library» (`/opds/user`) there are personal feeds: favorite books, shelves and smart shelves, favorite authors and series, Want to read, «New from favorites» and Recommended.

## KOReader progress sync

1. In your profile, in the **KOReader progress sync** block, create a separate password for KOReader (your account password is not used).
2. In KOReader: **Progress sync → Custom sync server**, address `http://<server>:3000/kosync`, your login and the password you created.
3. Download the book through OPDS — that is how the server recognizes it in KOReader.

Sync works both ways: KOReader progress shows up in «Reading» on the site and in the app, and a position from the web reader is picked up in KOReader.
