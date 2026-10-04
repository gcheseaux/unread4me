# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

unread4me is an extension for Chromium-based browsers (Manifest V3, plain JavaScript, no build step) that dims or hides the posts you have already read in the Following feed on x.com, and clears the clutter around them. The name is always written in lowercase: `unread4me`.

See `README.md` for the feature list, the permissions and the file layout.

## Running and testing

There is no build and no test suite. To try a change:

1. Run `node --check content.js` and `node --check background.js` for syntax.
2. On the browser's extensions page (`vivaldi://extensions` in Vivaldi, where it is tested), reload the unpacked extension, then reload the x.com tab. Reloading only the extension leaves the old content script running in the tab, which then fails with "Extension context invalidated".
3. Check the result on x.com/home, in the Following tab.

The Errors page on the extensions page keeps errors from earlier versions of the script but shows them next to the current source, so line numbers can look wrong. Click **Clear all** and reproduce before trusting one.

## How the content script works

- **Tagging, not restyling X's classes.** X's markup has almost no stable hooks besides `data-testid` (`cellInnerDiv`, `tweet`, `User-Name`, `UserCell`, `primaryColumn`, `socialContext`, `caret`). `content.js` walks from those to the boxes it needs and marks them with `data-trf-*` attributes (`data-trf-byline`, `data-trf-actions`, `data-trf-media`, `data-trf-tabs`, `data-trf-header-line`, `data-trf-who-to-follow`, and so on). `content.css` styles those attributes. React owns the `class` attribute and drops added classes on re-render, but leaves unknown attributes alone.
- **Root classes switch features on.** Each popup setting maps to a class on `<html>` (`trf-cards`, `trf-post-first`, `trf-no-actions`, ...), set in `applyLayout()`. Tagging runs regardless, and the CSS decides what shows.
- **Read state.** `trf-read` (dim) and `trf-hidden` (collapse) are classes on the timeline row, restored from the MutationObserver callback (a microtask, before paint) whenever React drops them.
- **Scan loop.** `scan()` runs throttled on scroll, resize, mutations and a 1 s backstop. It reads all geometry first, then writes.
- **Elements we add.** The repost line copy, the Dim / Hide / Show switch (`placeModeToggle()`) and the camera button (`placeCaptureButton()`) are appended as the last child of a React-managed node, and put back on the next scan if React removes them. `teardown()` removes them when the extension context is gone.
- **Screenshot.** The camera button is off by default (`cameraButton`). Turning it on in the popup requests the optional `<all_urls>` host permission, which `chrome.tabs.captureVisibleTab` requires (host access to x.com alone is not enough, and `activeTab` is never granted by an in-page click). `background.js` keeps the setting in step with the permission through `chrome.permissions.onAdded` and `onRemoved`. When clicked, the button asks `background.js` for the screenshot, crops to the card in the page, scales to at most `CAPTURE_WIDTH` (720 px) and writes a PNG with `navigator.clipboard.write`, handing it a promise so the click still counts as user activation.

## X layout gotchas learned the hard way

- Timeline rows are absolutely positioned and stacked by X from the size its ResizeObserver reports, which is the content box. Padding on a row is not counted, so card spacing is a margin on the row's child, with the row forced to a flex column.
- Never collapse a row above the viewport: X re-measures a few frames later and the feed jumps. Hide mode only collapses rows whose top is at or below the top of the screen.
- Never hide the last timeline row: X watches it to load more.
- The line under the tab bar can be a border on any of several boxes, or a 1 to 2 px box of its own, so `tagHeader()` finds it by position. It must skip the tab bar itself (`data-trf-tabs`), whose own border would otherwise be taken for X's line.
- The post a status page is about (`data-trf-focal`) has its text, media, date, counts and buttons in one box, so the feed's row tagging (byline, actions, media) must not run on it: hiding the "actions" row there hides the whole post. `tagFocal()` tags only the button bar itself.
- Posts of a thread (or a reply shown with the post it answers) are separate rows, linked only by an empty 2px-wide box X draws in the avatar column, above the avatar for a link up and below it for a link down. `threadLinks()` finds these by shape and caches the result per post id on the article.
- "Who to follow" in the timeline does not always include its "Show more" link to `/i/connect_people`, so on `/home` any row holding a `UserCell` counts as part of the module.

## Settings

`DEFAULT_SETTINGS` and `normalize()` are duplicated in `content.js` and `popup.js` and must stay in sync. Nothing writes defaults to storage: both fill in whatever is missing. `normalize()` migrates the old `enabled` and `revealAll` pair to `mode` and drops it.

## Writing style

Comments are full sentences in plain prose, explaining why, in the voice of the surrounding code. Commit messages are one short imperative line.
