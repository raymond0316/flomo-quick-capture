# Flomo Quick Capture

Capture text, tags, recordings and images into yearly Markdown notes, with Tencent Cloud transcription, automatic `noteCount` updates, attachment cleanup, and a daily “reunion” with your old notes.

## Install

Copy the `dist/flomo-quick-capture` folder into `<vault>/.obsidian/plugins/`, reload Obsidian, and enable **Flomo Quick Capture** in Settings → Community plugins. Assign a hotkey to `Flomo Quick Capture: Quick capture` if you want one-key capture.

The plugin id is `flomo-quick-capture`. Since v1.4.0 it changed from `obsidian-flomo`. To migrate, copy `data.json` from `.obsidian/plugins/obsidian-flomo/` into `.obsidian/plugins/flomo-quick-capture/`; folder settings, the Daily Reunion session and the recent-review list are kept. Tencent Cloud credentials live in the device SecretStorage and are not affected.

## Capturing

One window handles text, `#tags`, recordings and images; you can save an image-only or recording-only note. “Add image” opens the system picker, and the available options (album, camera) come from the system.

Typing `#` lists existing tags from the vault, including Chinese and nested tags. Keep typing to filter. Use ↑↓, Enter or Tab to insert, Esc to dismiss, or click an item.

Saving while recording stops the recording first. After saving you can jump straight to the new record in the yearly note.

## Drafts

Text is saved locally about 600ms after you stop typing; images and finished recordings are stored too. Closing or choosing “Later” saves first. Reopening or reloading restores the draft, and a red “Discard draft” button clears it after a second confirmation. The draft is cleared only after the note is written successfully.

Drafts live in IndexedDB on the current device, scoped per vault. They are not synced through iCloud and never contain Tencent Cloud keys. If the app is force-quit, unsaved input and audio still being recorded may be lost.

## Settings

Settings → Flomo Quick Capture:

- Note folder, recording folder and image folder. Defaults are `01.快速记录/flomo-import`, its `record` and `images` subfolders. Paths are vault-relative and missing folders are created. Changing them affects new records only; existing files are not moved.
- Toggle automatic transcription after saving, choose the recognition engine, and fill in Tencent Cloud AppID, SecretId and SecretKey.
- “Retry transcription for existing recordings” processes unfinished recordings.
- “Recount noteCount” recomputes annual notes in the configured folder.
- Daily Reunion: number of records per batch, range, and the daily refresh time.

## Tencent Cloud speech recognition

Enable the flash recording-file recognition service in the Tencent Cloud console and confirm quota or post-paid permission before entering AppID, SecretId and SecretKey from the same account. Sub-accounts need the matching call permission. The default engine is Chinese general `16k_zh`.

The three credentials are stored in the device SecretStorage, never in notes or `data.json`, and must be configured separately on phone and desktop. With transcription enabled, recordings are uploaded to Tencent Cloud and billed by your account. Keep the app in the foreground while transcribing. A single file must stay under 100MB and 2 hours; MP4/M4A and WebM are converted on device to 16 kHz mono WAV when possible, and the converted file must also stay under 100MB.

Failures never delete the recording. Retry from settings; results are written under the audio link in the yearly note, and results that fail to write back are cached locally until they succeed. Existing text is treated as done, so delete the wrong text under the audio link before retrying.

Common errors: 4002 authentication failure (check the three values, permission and system time), 4003 service not enabled, 4004 quota exhausted, 4005 unpaid balance, 4007 audio decode failure.

## Yearly notes and noteCount

Records are appended to `YYYY年.md`, each under a `## YYYY-MM-DD HH:mm:ss` heading. `noteCount` counts those headings per annual note, ignoring fenced code blocks and preserving other YAML properties.

It recalculates about 700ms after saving, manual edits, files moved into the folder, or startup, and only for annual notes directly inside the configured folder. If an existing `00-时间索引.md` is present, the year count is updated after saving a new record.

## Recording actions

After stopping, the toolbar offers “Re-record” and “Delete”; there is no separate remove button under the player. Delete restores “Start recording”. Re-record replaces the current recording only on success; denied permission or interruption keeps the original. Restored recording drafts can also be re-recorded or deleted.

## Attachment cleanup

Settings → Flomo Quick Capture → Attachment cleanup → Scan and preview, then press “Scan attachments”. Only `recording-` and `image-` media files created by this plugin inside the configured folders are scanned; normal attachments, imported flomo attachments and hidden folders are skipped.

The scan checks Markdown, Canvas and Base references across the vault and detects duplicate copies by file content. Candidates show path, size and duplicate information and can be previewed. Only unreferenced files are listed and nothing is selected by default; referenced, transcribing or pending-writeback files are protected.

Select items, press “Move to trash”, then confirm. Every file is re-checked right before removal and skipped if references appeared or the file changed. Files move to the vault’s hidden `.trash` folder, so they can be restored and are never deleted permanently. References inside PDFs or external apps are out of scope, so preview first.

Cleanup is blocked while capturing, saving or transcribing. Scanning never modifies files; a cleanup run reports moved, skipped and failed counts.

## Daily Reunion

Run `Flomo Quick Capture: Daily Reunion`. The plugin samples a small batch of old records from your yearly notes: 3 by default, configurable to 4 or 5, from all years or the last year only.

The dialog shows one record at a time with its full text, date, tags, first image thumbnail and a recording marker. Use “Previous” and “Next” to move; the last record shows “Finish”. Click the card to open the original note at that heading — the dialog and your position stay put.

Finishing a batch opens a completion view where you can close it or start another batch. The batch, your position and the finished state are saved for the day, so reopening continues where you left off instead of reshuffling. A missing record or a new review day starts a new batch silently.

The batch refresh time defaults to **09:00**. After that moment, the next open creates a new batch; before it, yesterday’s batch continues. You can change it to 00:00, 06:00 or 12:00, and 00:00 means refresh by calendar day.

New batches avoid the 50 most recently reviewed records, with repeats allowed when candidates run short. Reading is read-only: browse state and the recent list are stored in plugin settings, yearly notes are never rewritten.

## Commands

- Quick capture
- Recover unsaved record
- Retry transcription for existing recordings
- Recount all annual notes
- Daily Reunion

## Development and release

`node build.js` produces `dist/flomo-quick-capture/` with `main.js`, `manifest.json` and `styles.css` — the three assets required by a GitHub Release. The release tag must match `manifest.json` version exactly, without a `v` prefix. The repository root needs `README.md`, `LICENSE` and `manifest.json`; submit the plugin at community.obsidian.md.

Run `node --test tests/*.test.js` for the unit suite. Real microphone behaviour, mobile keyboards and Tencent Cloud recognition must be verified inside Obsidian; tests never call paid APIs.
