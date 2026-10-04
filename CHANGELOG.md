# Changelog

## 1.0.0, October 4, 2026

First public release.

### Read posts

- Marks a post as read once it has dwelled in view and then scrolled away.
- Dims, hides or shows read posts in the Following feed, chosen in the popup or with a switch in the Home tab bar.
- Takes over `j` and `k` in hide mode, so they skip the hidden posts.
- Keeps the read history locally for 30 days, shared across tabs.

### Feed layout

- Shows each post as a rounded card, with the author, handle and date right-aligned below the text.
- Turns the Home tabs into a card of their own, aligned with the posts.
- Hides profile pictures, post buttons and menus, the post box on Home and the left navigation bar.
- Keeps images and videos out of the feed, showing them only on the post's own page.
- Expands long posts in full.
- Removes "Who to follow", promoted posts and the "X reposted" line.
- Shows only the first post of a thread on Home.

### Post pages

- Shows the opened post in full, with its images and videos, without its Subscribe, Grok and menu buttons.
- Indents the replies under the post, with a line linking them to it.
- Removes the reply box and the "Discover more" section.

### Sharing

- Adds an optional camera button to each card that copies a picture of it to the clipboard as a PNG, at most 720 pixels wide. It is off by default, and turning it on asks for the access to all sites the screenshot needs.

### Compatibility

- Works in Chromium-based browsers, tested on Vivaldi.
