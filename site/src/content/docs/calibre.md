---
title: Calibre libraries
description: How to add a Calibre library as a book source.
---

Keep your books in [Calibre](https://calibre-ebook.com)? Add the library folder (the one with `metadata.db`) as a source: the admin panel recognizes it and adds it as a **Calibre library**.

- **The catalog comes from `metadata.db`** — the titles and authors you fixed in Calibre, series and series numbers, tags, ratings, languages, publisher, description, ISBN and `cover.jpg`. Book files are not opened during indexing, so even a large library indexes in minutes.
- **One catalog entry per Calibre book.** The reader opens the first of EPUB → AZW3 → MOBI → FB2; every other format the book has in Calibre (AZW3, PDF…) is offered too — in the download menu, when sending to an e-reader and in OPDS — and served as is, without conversion.
- **PDF, DJVU, CBZ, CBR, TXT, RTF, DOCX** — in Calibre libraries and as loose files in plain book folders: download, OPDS and send to an e-reader. «Read» in the browser is shown for FB2, EPUB, MOBI / AZW3, CBZ (comics) and PDF; the rest are download only. The Android app opens PDF, CBZ and TXT in its reader and offers **Open in another app** for DJVU, CBR, RTF and DOCX. A Kindle address only receives EPUB, PDF, DOCX, TXT and RTF — other formats are refused with a clear message instead of bouncing at Amazon.
- **Already added the library as a plain folder?** **Admin → Book sources → Convert to Calibre**: it is reindexed as a Calibre library, and reading positions, bookmarks, ratings and shelves move to the Calibre books.
- **Tags** become genres by default. If your tags are mostly workflow labels («to read», «kobo»), switch the source to «search only» or «ignore».
- Renaming a book or an author in Calibre **does not break** reading positions, bookmarks or shelves: books are identified by Calibre's book UUID, not by the file path.
- The server **only reads** the library: it copies `metadata.db` to its `data/calibre` folder and reads that copy (roughly 1–3 KB per book), so Calibre can stay open and the folder can be mounted read-only. With folder watching on, a change in Calibre is picked up after the quiet period; otherwise run an incremental index or use the schedule.
