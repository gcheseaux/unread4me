"use strict";

/**
 * unread4me content script.
 *
 * Marks a tweet as read once it has dwelled in the viewport, then dims or hides
 * read tweets in the Following feed.
 *
 * Dimming changes no layout, so it is free. Hiding only ever collapses a row
 * you have not scrolled to yet, which is just as free: it takes height from
 * below the fold, where you cannot see it go.
 *
 * Nothing here collapses a row you have already passed, tempting as the space
 * behind you looks. X lays the timeline out itself, absolutely positioning
 * every row by transform, so a row above you keeps its slot until X re-measures
 * and rewrites every offset below it, a few frames later, dragging the feed up
 * under you. The browser will not absorb that, since it only compensates for
 * layout it performed itself, and scrolling to compensate is no better: the
 * compensation is a jump of its own, just one we caused.
 */
(() => {
  const CELL_SELECTOR = 'div[data-testid="cellInnerDiv"]';
  const TWEET_SELECTOR = 'article[data-testid="tweet"]';
  const DIM_CLASS = "trf-read";
  const HIDE_CLASS = "trf-hidden";
  const NO_AVATARS_CLASS = "trf-no-avatars";
  const POST_FIRST_CLASS = "trf-post-first";
  const HIDE_MEDIA_CLASS = "trf-hide-media";
  const NO_COMPOSER_CLASS = "trf-no-composer";
  const NO_SIDEBAR_CLASS = "trf-no-sidebar";
  const EXPAND_POSTS_CLASS = "trf-expand-posts";
  const NO_WHO_TO_FOLLOW_CLASS = "trf-no-who-to-follow";
  const NO_ACTIONS_CLASS = "trf-no-actions";
  const CARDS_CLASS = "trf-cards";
  const FIRST_OF_THREAD_CLASS = "trf-first-of-thread";
  const CAMERA_CLASS = "trf-camera";
  const MEDIA_SELECTOR = [
    '[data-testid="tweetPhoto"]',
    '[data-testid="videoPlayer"]',
    '[data-testid="videoComponent"]',
    '[data-testid="card.wrapper"]',
    // X has shipped its video player under more than one test id, so catch the
    // element itself too.
    "video"
  ].join(", ");

  const SCAN_THROTTLE_MS = 120;
  const BACKSTOP_MS = 1000;
  const FLUSH_MS = 1500;

  // Used when the tab label does not match the configured one, before falling
  // back to tab position.
  const KNOWN_FOLLOWING_LABELS = [
    "following",
    "suivis",
    "folge ich",
    "siguiendo",
    "seguendo",
    "seguindo",
    "volgend",
    "följer",
    "seuratut",
    "подписки",
    "フォロー中",
    "팔로우 중",
    "正在关注",
    "追蹤中"
  ];

  const MODES = new Set(["dim", "hide", "show"]);

  const DEFAULT_SETTINGS = {
    mode: "dim",
    dwellMs: 1000,
    dimOpacity: 0.35,
    followingLabel: "Following",
    hideAvatars: true,
    postFirst: true,
    hideMedia: true,
    hideComposer: true,
    hideSidebar: true,
    expandPosts: true,
    hideWhoToFollow: true,
    hideActions: true,
    cards: true,
    firstOfThread: true,
    cameraButton: false,
    debug: false
  };

  /**
   * Reads the stored shape, migrating the old enabled/revealAll pair to mode.
   * The pair itself is dropped, so the next save leaves it behind.
   */
  function normalize(raw) {
    const { enabled, revealAll, ...stored } = raw || {};
    const mode = MODES.has(stored.mode)
      ? stored.mode
      : enabled === false || revealAll === true
        ? "show"
        : "dim";
    return { ...DEFAULT_SETTINGS, ...stored, mode };
  }

  let settings = { ...DEFAULT_SETTINGS };

  function log(...args) {
    if (settings.debug) console.log("[unread4me]", ...args);
  }

  /** Tweet ids known to have been read (this session plus persisted history). */
  const readIds = new Set();
  /** Subset of readIds that you dwelled on during *this* session. */
  const sessionReadIds = new Set();
  /** Seen long enough to count, but still on screen, so not read yet. */
  const dwelledIds = new Set();
  /** Tweet ids currently filtered. Sticky, so a tweet cannot flicker back. */
  const maskedIds = new Set();
  /** Masked ids that have actually been collapsed, in hide mode. Also sticky. */
  const collapsedIds = new Set();
  /** Tweet ids currently intersecting the viewport at all. */
  const visibleIds = new Set();
  /** Tweet id -> pending dwell timer. */
  const dwellTimers = new Map();
  /** Tweet ids read but not yet written to storage. */
  const unsavedIds = new Set();

  /** Articles handed to the IntersectionObserver, which holds them strongly. */
  const observedArticles = new Set();

  let inScope = false;
  /** The post j/k last moved to, so the next press carries on from it. */
  let currentId = null;
  let scanQueued = false;
  let flushTimer = null;
  let lastBadgeCount = -1;
  let torn = false;

  const intersectionObserver = new IntersectionObserver(onIntersect, {
    threshold: [0, 0.25, 0.5, 0.6, 0.9, 1]
  });

  const mutationObserver = new MutationObserver(onMutate);

  /** True once the extension has been reloaded or disabled underneath us. */
  function contextGone() {
    return torn || !chrome.runtime?.id;
  }

  function teardown() {
    if (torn) return;
    torn = true;
    intersectionObserver.disconnect();
    mutationObserver.disconnect();
    for (const timer of dwellTimers.values()) clearTimeout(timer);
    dwellTimers.clear();
    clearEverything();
    // Their buttons would call into an extension that is no longer there.
    for (const el of document.querySelectorAll("[data-trf-mode-toggle], [data-trf-capture]")) {
      el.remove();
    }
    document.documentElement.classList.remove(
      NO_AVATARS_CLASS,
      POST_FIRST_CLASS,
      HIDE_MEDIA_CLASS,
      NO_COMPOSER_CLASS,
      NO_SIDEBAR_CLASS,
      EXPAND_POSTS_CLASS,
      NO_WHO_TO_FOLLOW_CLASS,
      NO_ACTIONS_CLASS,
      CARDS_CLASS,
      FIRST_OF_THREAD_CLASS,
      CAMERA_CLASS
    );
  }

  /* ------------------------------------------------------------------ scope */

  /**
   * The Following feed lives at /home and is only distinguishable from For you
   * by which tab is selected, since both share the same URL.
   */
  function followingFeedActive() {
    if (location.pathname !== "/home") return false;

    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).filter(
      (tab) => tab.closest("nav")
    );
    if (tabs.length === 0) return false;

    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    if (!selected) return false;

    const label = (selected.textContent || "").trim().toLowerCase();
    const wanted = (settings.followingLabel || "").trim().toLowerCase();
    if (wanted && label === wanted) return true;
    if (KNOWN_FOLLOWING_LABELS.includes(label)) return true;

    // Unrecognised label, so fall back to position: For you is first, Following
    // is second, any pinned lists come after.
    return tabs.indexOf(selected) === 1;
  }

  /* ------------------------------------------------------------------ tweets */

  /**
   * The first status link carrying a <time> is the tweet's own permalink. Any
   * later one belongs to a quoted tweet.
   */
  function tweetIdOf(article) {
    const stamp = article.querySelector('a[href*="/status/"] time');
    const anchor = stamp ? stamp.closest("a") : article.querySelector('a[href*="/status/"]');
    const href = anchor && anchor.getAttribute("href");
    const match = href && href.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      const id = entry.target.dataset.trfId;
      if (!id) continue;

      if (entry.isIntersecting) {
        visibleIds.add(id);
      } else {
        visibleIds.delete(id);
        commitDwell(id);
      }

      // Either most of the tweet is on screen, or the tweet is taller than the
      // viewport and is filling half of it.
      const shown = entry.intersectionRect.height;
      const enough =
        entry.isIntersecting &&
        shown >= Math.min(entry.boundingClientRect.height * 0.6, window.innerHeight * 0.5);

      if (enough && !readIds.has(id)) startDwell(id);
      else stopDwell(id);
    }
    requestScan();
  }

  /**
   * Dwelling on a tweet does not make it read, it only makes it a candidate.
   * Reading something means having had it on screen and then moved on, so the
   * commit waits until it leaves the viewport. Otherwise merely reloading the
   * page marks off whatever happened to be on screen, which you never read.
   */
  function startDwell(id) {
    if (dwellTimers.has(id)) return;
    const timer = setTimeout(() => {
      dwellTimers.delete(id);
      dwelledIds.add(id);
      log("dwelled on", id, "- read once it leaves the screen");
    }, settings.dwellMs);
    dwellTimers.set(id, timer);
  }

  /** Called once a dwelled tweet is out of sight, which is what settles it. */
  function commitDwell(id) {
    if (!dwelledIds.delete(id)) return;
    markRead(id);
  }

  function stopDwell(id) {
    const timer = dwellTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    dwellTimers.delete(id);
  }

  function markRead(id) {
    if (readIds.has(id)) return;
    readIds.add(id);
    sessionReadIds.add(id);
    unsavedIds.add(id);
    log("read", id);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  async function flush() {
    flushTimer = null;
    if (unsavedIds.size === 0 || contextGone()) return;
    const ids = Array.from(unsavedIds);
    unsavedIds.clear();
    try {
      await chrome.runtime.sendMessage({ type: "mark", ids });
    } catch {
      teardown();
    }
  }

  /* ------------------------------------------------------------------- paint */

  function requestScan() {
    if (scanQueued || torn) return;
    scanQueued = true;
    setTimeout(() => requestAnimationFrame(scan), SCAN_THROTTLE_MS);
  }

  /**
   * React owns the class attribute of every cell, so re-rendering one drops the
   * class we put on it and the row springs back to full height. Waiting for the
   * next scan to notice is too late: at a 120ms throttle the expanded row gets
   * painted for several frames, which reads as the feed flinching.
   *
   * This callback runs as a microtask, before the browser paints, so restoring
   * the class here means the expanded state never reaches the screen.
   */
  function onMutate(records) {
    // Tagged here for the same reason as settle(): a row streamed in would
    // otherwise be painted with its name on top and its media showing, then jump.
    if (needsTweetTags()) {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const article = node.closest(TWEET_SELECTOR);
          tagTweets(article || node);
        }
      }
    }
    if (settings.hideWhoToFollow) tagWhoToFollow();
    tagReplies();
    if (settings.firstOfThread) tagThreads();

    if (inScope) {
      const touched = new Set();
      for (const record of records) {
        if (record.type === "attributes") {
          // X churns attributes all over the page, so reject anything that is
          // not one of our rows before touching the DOM any further.
          if (record.attributeName === "class" && record.target.matches(CELL_SELECTOR)) {
            touched.add(record.target);
          }
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches(CELL_SELECTOR)) touched.add(node);
          else for (const cell of node.querySelectorAll(CELL_SELECTOR)) touched.add(cell);
        }
      }
      if (touched.size > 0) settle(touched);
    }
    requestScan();
  }

  /**
   * Decides a batch of rows and paints them, reads first and writes after, the
   * same way scan() does.
   *
   * Running from the mutation callback is the point: it is a microtask, so a
   * row X has just streamed in gets its class before the frame is painted. Left
   * to the next scan the row shows at full height for a moment first, and since
   * X fills the timeline a batch at a time, that reads as the feed collapsing
   * over and over as it loads.
   */
  function settle(cells) {
    const decided = [];
    for (const cell of cells) {
      if (!cell.isConnected) continue;
      const article = cell.querySelector(TWEET_SELECTOR);
      const id = article ? tweetIdOf(article) : null;
      if (!id) continue;

      const masked = shouldMask(id);
      if (masked) maskedIds.add(id);

      let collapse = false;
      if (settings.mode === "hide" && masked) {
        collapse = collapsedIds.has(id) || cell.getBoundingClientRect().top >= 0;
        if (collapse) collapsedIds.add(id);
      }
      decided.push({ cell, masked, collapse });
    }

    for (const { cell, masked, collapse } of decided) {
      setClass(cell, DIM_CLASS, masked && !collapse);
      setClass(cell, HIDE_CLASS, collapse);
    }
  }

  function scan() {
    scanQueued = false;
    if (contextGone()) return teardown();

    // Everywhere on x.com, not just the Following feed, so before the scope
    // check. Also catches anything the mutation callback missed.
    if (needsTweetTags()) {
      tagTweets(document);
    }
    if (settings.hideComposer) tagComposer();
    if (settings.cards) tagHeader();
    if (settings.hideWhoToFollow) tagWhoToFollow();
    tagReplies();
    if (settings.firstOfThread) tagThreads();

    const active = settings.mode !== "show" && followingFeedActive();
    if (active !== inScope) {
      inScope = active;
      log(inScope ? "entered the Following feed" : "left the Following feed");
      if (!inScope) clearEverything();
    }
    if (!inScope) {
      // X reuses these row nodes on its other pages. One that still carried our
      // class when we stopped watching would stay invisible somewhere we have
      // no business touching, which reads as a post that never loads. Clearing
      // on the way out is not enough, since the reuse happens after that.
      for (const cell of document.querySelectorAll(`.${DIM_CLASS}, .${HIDE_CLASS}`)) {
        cell.classList.remove(DIM_CLASS, HIDE_CLASS);
      }
      return updateBadge(0);
    }

    const hiding = settings.mode === "hide";

    // Read phase: no DOM writes here, so the rect reads stay batched. Dim mode
    // needs no geometry at all.
    const rows = [];

    for (const cell of document.querySelectorAll(CELL_SELECTOR)) {
      const article = cell.querySelector(TWEET_SELECTOR);
      const id = article ? tweetIdOf(article) : null;

      if (!id) {
        // Dividers, "Show more", and whatever else shares the cell wrapper.
        rows.push({ cell, article: null, masked: false, collapse: false });
        continue;
      }

      const masked = shouldMask(id);
      if (masked) maskedIds.add(id);

      // Collapse only what starts at or below the top of the viewport. Height
      // taken from there costs nothing: everything above it holds still, so
      // your scroll position never moves. Take height from above you instead
      // and the whole feed slides, which no amount of scrolling to compensate
      // can hide, because the compensation is itself a jump.
      //
      // A row you are reading right now is safe without checking for it here:
      // shouldMask() leaves this session's reads alone until they are off
      // screen, so the only visible rows that reach this point are ones you
      // finished with in an earlier session.
      let collapse = false;
      if (hiding && masked) {
        if (collapsedIds.has(id)) {
          collapse = true;
        } else if (cell.getBoundingClientRect().top >= 0) {
          collapse = true;
        }
        if (collapse) collapsedIds.add(id);
      }

      rows.push({ cell, article, id, masked, collapse });
    }

    // Dividers, "Show more replies" and the like carry no tweet id, so nothing
    // above collapses them. Left alone they outlive the posts they belonged to
    // and strand themselves between two hidden rows, looking like a stray row
    // between two posts that are not even related.
    //
    // Only collapse one with a real collapsed post on either side of it. A
    // divider still touching a post you can see may well belong to it, and one
    // with nothing after it at all is the row at the end of the feed that X
    // watches to know when to load more. Hide that and it never intersects, so
    // nothing loads again.
    if (hiding) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id) continue;

        let before = null;
        for (let j = i - 1; j >= 0 && !before; j--) if (rows[j].id) before = rows[j];
        let after = null;
        for (let j = i + 1; j < rows.length && !after; j++) if (rows[j].id) after = rows[j];

        rows[i].collapse = Boolean(before && after) && before.collapse && after.collapse;
      }
    }

    // Write phase.
    for (const { cell, article, id, masked, collapse } of rows) {
      if (article && article.dataset.trfId !== id) article.dataset.trfId = id;
      if (article && !observedArticles.has(article)) {
        observedArticles.add(article);
        intersectionObserver.observe(article);
      }
      // In hide mode a read tweet still on screen is dimmed in the meantime,
      // then collapses once it is out of the way.
      setClass(cell, DIM_CLASS, masked && !collapse);
      setClass(cell, HIDE_CLASS, collapse);
    }

    log(
      `scan: ${rows.filter((r) => r.article).length} tweets in the DOM, ` +
        `${rows.filter((r) => r.masked).length} read ` +
        `(${rows.filter((r) => r.collapse).length} collapsed), ` +
        `${readIds.size} known read (${sessionReadIds.size} this session)`
    );

    updateBadge(maskedIds.size);
  }

  /**
   * A tweet read in an earlier session is filtered on sight, since you are done
   * with it. A tweet read during *this* session is left alone until it leaves
   * the screen, so nothing changes while you are still looking at it. Once
   * filtered it stays filtered, including when you scroll back up.
   */
  function shouldMask(id) {
    if (maskedIds.has(id)) return true;
    if (!readIds.has(id)) return false;
    return !(sessionReadIds.has(id) && visibleIds.has(id));
  }

  /** X drops timeline nodes as you scroll, so stop observing the dead ones. */
  function pruneObserved() {
    for (const article of observedArticles) {
      if (article.isConnected) continue;
      intersectionObserver.unobserve(article);
      observedArticles.delete(article);
      const id = article.dataset.trfId;
      if (!id) continue;
      visibleIds.delete(id);
      // X only drops a row once it is well out of the way, so it counts as
      // having left the screen: the observer will never say so itself now.
      commitDwell(id);
    }
  }

  function setClass(cell, className, on) {
    if (on === cell.classList.contains(className)) return;
    cell.classList.toggle(className, on);
  }

  function clearEverything() {
    for (const cell of document.querySelectorAll(`.${DIM_CLASS}, .${HIDE_CLASS}`)) {
      cell.classList.remove(DIM_CLASS, HIDE_CLASS);
    }
    maskedIds.clear();
    collapsedIds.clear();
    updateBadge(0);
  }

  function applyDimStrength() {
    document.documentElement.style.setProperty("--trf-dim", String(settings.dimOpacity));
  }

  /**
   * Layout tweaks, driven by classes on the root so they cover every tweet on
   * x.com, not just the Following feed.
   */
  function applyLayout() {
    const root = document.documentElement.classList;
    root.toggle(NO_AVATARS_CLASS, settings.hideAvatars);
    root.toggle(POST_FIRST_CLASS, settings.postFirst);
    root.toggle(HIDE_MEDIA_CLASS, settings.hideMedia);
    root.toggle(NO_COMPOSER_CLASS, settings.hideComposer);
    root.toggle(NO_SIDEBAR_CLASS, settings.hideSidebar);
    root.toggle(EXPAND_POSTS_CLASS, settings.expandPosts);
    root.toggle(NO_WHO_TO_FOLLOW_CLASS, settings.hideWhoToFollow);
    root.toggle(NO_ACTIONS_CLASS, settings.hideActions);
    root.toggle(CARDS_CLASS, settings.cards);
    root.toggle(FIRST_OF_THREAD_CLASS, settings.firstOfThread);
    root.toggle(CAMERA_CLASS, settings.cameraButton);
  }

  function needsTweetTags() {
    return (
      settings.postFirst ||
      settings.hideMedia ||
      settings.expandPosts ||
      settings.hideActions ||
      settings.cards
    );
  }

  /**
   * Tags the rows of a tweet's body column (name, media, action bar) so the
   * stylesheet can rearrange them. X gives none of those rows a hook of its
   * own, so walk up from the parts it does name until reaching the column they
   * share. Tagging is unconditional and cheap; the root classes decide whether
   * any of it shows.
   *
   * Data attributes rather than classes, since React owns the class attribute
   * and would drop ours on the next render, but leaves unknown attributes be.
   */
  function tagTweet(article) {
    // The post a status page is about keeps its media, since opening the post
    // is how you get to see it. Checked every time, as X reuses the article.
    const page = location.pathname.match(/\/status\/(\d+)/);
    const focal = Boolean(page) && tweetIdOf(article) === page[1];
    if (focal !== article.hasAttribute("data-trf-focal")) {
      if (focal) article.dataset.trfFocal = "";
      else delete article.dataset.trfFocal;
    }

    if (settings.cards) {
      tagEmptyCard(article);
      tagSeparators(article);
      if (settings.cameraButton) placeCaptureButton(article);
    }

    // Finds and tags the thread lines, which hang loose without the avatars.
    if (settings.hideAvatars) threadLinks(article);

    if (focal) return tagFocal(article);

    let column = article.querySelector("[data-trf-byline]")?.parentElement;

    if (!column) {
      // The first name is the tweet's own. Any later one belongs to a quote.
      const name = article.querySelector('[data-testid="User-Name"]');
      const groups = article.querySelectorAll('[role="group"]');
      const bar = groups[groups.length - 1];
      if (!name || !bar) return;

      let byline = name;
      while (byline.parentElement && !byline.parentElement.contains(bar)) {
        byline = byline.parentElement;
      }
      column = byline.parentElement;
      if (!column || column === article) return;

      let actions = bar;
      while (actions.parentElement !== column) actions = actions.parentElement;

      byline.dataset.trfByline = "";
      actions.dataset.trfActions = "";
    }

    // A long post arrives with its full text and a "Show more" button that
    // expands it in place, so press it for you. An older build makes it a link
    // to the post's own page instead, which would navigate away, so a link is
    // left for you to click.
    if (settings.expandPosts) {
      const more = article.querySelector('[data-testid="tweet-text-show-more-link"]');
      if (more && !more.closest("a[href]") && !more.hasAttribute("data-trf-pressed")) {
        more.dataset.trfPressed = "";
        more.click();
      }
    }

    tagRepost(article, column);

    // Media loads after the rest of the tweet, so this part runs every time.
    // A row holding a name is a quoted tweet, left whole so its text stays,
    // and its own media is dealt with below.
    for (const row of column.children) {
      if (row.hasAttribute("data-trf-media")) continue;
      if (row.hasAttribute("data-trf-byline") || row.hasAttribute("data-trf-actions")) continue;
      if (!row.querySelector(MEDIA_SELECTOR)) continue;
      if (row.querySelector('[data-testid="User-Name"]')) tagQuotedMedia(row);
      else row.dataset.trfMedia = "";
    }
  }

  /**
   * The post a page is about is laid out differently: its text, media, date and
   * counts share one box with the buttons, so the rows the feed rearranges do
   * not exist there, and hiding the buttons' row would take the whole post with
   * it. So only the button bar itself is tagged, and the post keeps X's order,
   * with its media. Whatever an earlier visit tagged goes first, since X can
   * reuse a feed post's article for it.
   */
  function tagFocal(article) {
    const groups = article.querySelectorAll('[role="group"]');
    const bar = groups[groups.length - 1];

    const names = ["trfByline", "trfActions", "trfMedia", "trfContext"];
    const tagged = "[data-trf-byline], [data-trf-actions], [data-trf-media], [data-trf-context]";
    for (const el of article.querySelectorAll(tagged)) {
      if (el === bar) continue;
      for (const name of names) delete el.dataset[name];
    }
    for (const copy of article.querySelectorAll("[data-trf-repost]")) copy.remove();

    if (bar && !bar.hasAttribute("data-trf-actions")) bar.dataset.trfActions = "";

    // The header row beside the name also carries buttons: "Subscribe" or
    // "Follow", Grok, and the "..." menu. None has a stable hook of its own, so
    // the row is found as the largest box around the name that holds nothing
    // of the post's body: no text, date, media, quoted post or bar, which also
    // covers a post with no text. Every control in it outside the name and
    // the avatar is tagged.
    const name = article.querySelector('[data-testid="User-Name"]');
    if (!name) return;
    const body = `[data-testid="tweetText"], [role="group"], time, ${MEDIA_SELECTOR}`;
    const holdsBody = (box) =>
      box.querySelector(body) || box.querySelectorAll('[data-testid="User-Name"]').length > 1;
    let header = name;
    while (header.parentElement && header.parentElement !== article && !holdsBody(header.parentElement)) {
      header = header.parentElement;
    }
    for (const control of header.querySelectorAll('button, [role="button"], a')) {
      if (name.contains(control) || control.closest('[data-testid="Tweet-User-Avatar"]')) continue;
      if (!control.hasAttribute("data-trf-header-control")) control.dataset.trfHeaderControl = "";
    }
  }

  /**
   * A post hidden by something else on the page, such as an ad blocker taking
   * out a promoted post, leaves its card behind with nothing in it, which shows
   * as a stray line across the feed. So the row is tagged for the stylesheet to
   * hide whenever a box from the post up to its row is hidden. The row itself
   * is left out of the check, since it may be hidden by us, and would then
   * never come back. Not the last row, which X watches to load more.
   */
  function tagEmptyCard(article) {
    const cell = article.closest(CELL_SELECTOR);
    if (!cell) return;
    let empty = false;
    for (let box = article; box !== cell && !empty; box = box.parentElement) {
      empty = getComputedStyle(box).display === "none";
    }
    empty &&= Boolean(cell.nextElementSibling);
    if (empty === cell.hasAttribute("data-trf-empty")) return;
    if (empty) {
      cell.dataset.trfEmpty = "";
      log("empty card, its post hidden by something else", cell);
    } else {
      delete cell.dataset.trfEmpty;
    }
  }

  /**
   * X draws the line between two posts as a bottom border on one of the boxes
   * wrapped around the post, and which one varies with the kind of row. With
   * cards it shows up as a rule under the post, so check each box from the post
   * up to its row. Only a line on one side counts: a border all round is a
   * frame, such as the card itself.
   */
  function tagSeparators(article) {
    const cell = article.closest(CELL_SELECTOR);
    if (!cell) return;
    for (let box = article; box && box !== cell; box = box.parentElement) {
      const style = getComputedStyle(box);
      const framed = parseFloat(style.borderLeftWidth) > 0;
      const line =
        !framed &&
        (parseFloat(style.borderBottomWidth) > 0 || parseFloat(style.borderTopWidth) > 0);
      if (line && !box.hasAttribute("data-trf-separator")) {
        box.dataset.trfSeparator = "";
        log("separator line on a post", box);
      }
    }
  }

  /**
   * A quoted tweet lays its media out in a box of its own, sometimes below its
   * text, sometimes as a thumbnail beside it. Either way, climb from the media
   * to the largest box that holds neither the name nor the text, so the hole it
   * leaves closes up without taking any of the quote's words with it.
   */
  function tagQuotedMedia(row) {
    for (const media of row.querySelectorAll(MEDIA_SELECTOR)) {
      if (media.closest("[data-trf-media]")) continue;
      let box = media;
      while (
        box.parentElement &&
        box.parentElement !== row &&
        !box.parentElement.querySelector('[data-testid="User-Name"], [data-testid="tweetText"]')
      ) {
        box = box.parentElement;
      }
      box.dataset.trfMedia = "";
    }
  }

  /**
   * "X reposted" sits in a row of its own above the whole tweet, outside the
   * body column, so no reordering can bring it next to the name. Instead the
   * original row is tagged for the stylesheet to hide, and a plain copy goes
   * into the body column, where the stylesheet slots it just above the name.
   *
   * The copy is ours, not React's, so appending it is safe: React only moves
   * the nodes it rendered. Checked every time, since the line can render after
   * the rest of the tweet, and X can reuse the article for another tweet.
   */
  function tagRepost(article, column) {
    const social = article.querySelector('[data-testid="socialContext"]');
    const existing = column.querySelector(":scope > [data-trf-repost]");
    const key = social ? `${tweetIdOf(article)}:${social.textContent}` : null;

    if (existing && existing.dataset.trfRepost === key) return;
    existing?.remove();
    for (const stale of article.querySelectorAll("[data-trf-context]")) {
      if (!stale.contains(social)) delete stale.dataset.trfContext;
    }
    if (!social || column.contains(social)) return;

    let context = social;
    while (context.parentElement && !context.parentElement.contains(column)) {
      context = context.parentElement;
    }
    if (!context.parentElement) return;
    context.dataset.trfContext = "";

    const line = document.createElement("div");
    line.dataset.trfRepost = key;
    const icon = context.querySelector("svg");
    if (icon) line.append(icon.cloneNode(true));
    line.append((social.closest("a") || social).cloneNode(true));
    column.append(line);
    log("repost line copied above the name", line);
  }

  /**
   * The "What's happening?" box above the Home timeline. It has no hook of its
   * own either, so walk up from its text area to the container it shares with
   * the tab bar and tag the row holding it. Only on /home: a status page puts
   * its reply box in the same kind of text area, and that one stays.
   */
  function tagComposer() {
    if (/\/status\/\d+/.test(location.pathname)) return tagReplyBox();
    if (location.pathname !== "/home") return;
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const textarea = column?.querySelector('[data-testid="tweetTextarea_0"]');
    const tabs = column?.querySelector('nav [role="tab"]');
    if (!textarea || !tabs || textarea.closest("[data-trf-composer]")) return;

    let composer = textarea;
    while (composer.parentElement && !composer.parentElement.contains(tabs)) {
      composer = composer.parentElement;
    }
    if (composer.parentElement && column.contains(composer.parentElement)) {
      composer.dataset.trfComposer = "";
    }
  }

  /**
   * The "Post your reply" box under the post a page is about. It sits in the
   * post's row or in a row of its own, so climb from its text area to the
   * largest box that holds no post. A reply opened from a post's reply button
   * comes up in a dialog, outside the column, and is left alone.
   */
  function tagReplyBox() {
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const textarea = column?.querySelector(`${CELL_SELECTOR} [data-testid="tweetTextarea_0"]`);
    if (!textarea || textarea.closest("[data-trf-composer]")) return;

    let box = textarea;
    while (
      box.parentElement &&
      box.parentElement !== column &&
      !box.parentElement.querySelector(TWEET_SELECTOR)
    ) {
      box = box.parentElement;
    }
    box.dataset.trfComposer = "";
  }

  /**
   * "Who to follow" shows up twice: as a box in the right sidebar, and as a
   * module X drops into the timeline, a heading, a few accounts, a "Show more"
   * link to /i/connect_people and a divider, each in a row of its own. Neither
   * has a hook, and the heading text depends on the language, so both are
   * found by the accounts and the link they hold.
   *
   * X reuses its row nodes for whatever scrolls in next, so the tags are
   * worked out afresh every time and dropped from rows that no longer match.
   */
  function tagWhoToFollow() {
    const stale = new Set(document.querySelectorAll("[data-trf-who-to-follow]"));
    const tag = (el) => {
      stale.delete(el);
      if (!el.hasAttribute("data-trf-who-to-follow")) el.dataset.trfWhoToFollow = "";
    };

    // The sidebar box wraps the aside in a bordered frame or two, which would
    // be left standing empty, so climb to the outermost wrapper it fills alone.
    const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
    for (const aside of sidebar?.querySelectorAll("aside") ?? []) {
      if (!aside.querySelector('[data-testid="UserCell"]')) continue;
      let box = aside;
      while (
        box.parentElement &&
        box.parentElement !== sidebar &&
        box.parentElement.childElementCount === 1
      ) {
        box = box.parentElement;
      }
      tag(box);
    }

    // The connect_people page is that same list, and there it is the content.
    //
    // X does not always send the "Show more" link, so on Home any row holding
    // an account counts too: the timeline there is posts, and a list of
    // accounts in it is always a suggestion. Elsewhere, such as a followers
    // page, the accounts are the content, so only the link is trusted.
    const column = document.querySelector('[data-testid="primaryColumn"]');
    if (column && !location.pathname.startsWith("/i/connect_people")) {
      const cells = new Set();
      for (const link of column.querySelectorAll(`${CELL_SELECTOR} a[href^="/i/connect_people"]`)) {
        cells.add(link.closest(CELL_SELECTOR));
      }
      if (location.pathname === "/home") {
        for (const user of column.querySelectorAll(`${CELL_SELECTOR} [data-testid="UserCell"]`)) {
          cells.add(user.closest(CELL_SELECTOR));
        }
      }

      const inModule = (row) =>
        row?.querySelector('[data-testid="UserCell"], a[href^="/i/connect_people"]');

      for (const cell of cells) {
        // Not the last row, which is the one X watches to load more.
        if (!cell.nextElementSibling) continue;
        tag(cell);

        // Back over the other accounts to the heading.
        let prev = cell.previousElementSibling;
        while (inModule(prev)) {
          tag(prev);
          prev = prev.previousElementSibling;
        }
        if (prev && !prev.querySelector(TWEET_SELECTOR)) tag(prev);

        // On over the rest of the accounts and the link to the divider.
        let next = cell.nextElementSibling;
        while (inModule(next) && next.nextElementSibling) {
          tag(next);
          next = next.nextElementSibling;
        }
        if (next?.nextElementSibling && !next.querySelector(TWEET_SELECTOR)) tag(next);
      }
    }

    // "Discover more" closes a post's page with posts picked from across X,
    // under a heading of its own. Replies have no heading, so the first row
    // that is a heading and not a post starts it, and it runs to the end. The
    // last row goes too, unlike in the feed: X watches it to load more, and
    // more of "Discover more" is exactly what is not wanted here.
    if (column && /\/status\/\d+/.test(location.pathname)) {
      let found = false;
      for (const row of column.querySelectorAll(CELL_SELECTOR)) {
        found ||= !row.querySelector(TWEET_SELECTOR) && row.querySelector('h2, [role="heading"]');
        if (found) tag(row);
      }
    }

    for (const el of stale) delete el.dataset.trfWhoToFollow;
  }

  /** The page the reply ids below belong to. */
  let replyPage = null;
  /**
   * Posts known to be replies on that page, so they stay marked once the post
   * they answer has scrolled away.
   */
  const replyIds = new Set();

  /**
   * On a post's page, the rows after the post are its replies, up to the
   * "Discover more" heading. They are marked so the stylesheet can indent them
   * under the post and run a line down from it, which tells them apart from
   * posts in the feed. The value says how to draw each row's part of the line:
   * "post" for a reply, "gap" for a row between replies (a divider or "Show
   * more replies") and "last" for the last reply, where the line ends. The
   * post's own row is marked "root" so the line starts at its card.
   *
   * X unloads rows far off screen, the post's own row included, so a row also
   * counts when it holds a post already known to be a reply, and so does every
   * row after it.
   */
  function tagReplies() {
    const page = /\/status\/\d+/.test(location.pathname) ? location.pathname : null;
    if (page !== replyPage) {
      replyPage = page;
      replyIds.clear();
    }

    const marks = new Map();
    if (page) {
      let root = null;
      let inReplies = false;
      const rows = [];
      for (const row of document.querySelectorAll(CELL_SELECTOR)) {
        const article = row.querySelector(TWEET_SELECTOR);
        if (!article && row.querySelector('h2, [role="heading"]')) {
          if (inReplies) break;
          continue;
        }
        if (article?.hasAttribute("data-trf-focal")) {
          root = row;
          inReplies = true;
          continue;
        }
        const id = article ? tweetIdOf(article) : null;
        if (id && replyIds.has(id)) inReplies = true;
        if (!inReplies) continue;
        if (id) replyIds.add(id);
        rows.push({ row, post: Boolean(id) });
      }

      // The line ends at the last reply, not at a divider after it.
      while (rows.length > 0 && !rows[rows.length - 1].post) rows.pop();
      rows.forEach(({ row, post }, i) => {
        marks.set(row, i === rows.length - 1 ? "last" : post ? "post" : "gap");
      });
      if (root && rows.length > 0) marks.set(root, "root");
    }

    for (const el of document.querySelectorAll("[data-trf-reply]")) {
      if (!marks.has(el)) delete el.dataset.trfReply;
    }
    for (const [row, mark] of marks) {
      if (row.dataset.trfReply !== mark) row.dataset.trfReply = mark;
    }
  }

  /**
   * A thread in the Home timeline shows as several rows, one per post, linked
   * by a line X draws down the avatar column. Only the first post is kept: the
   * rest of the thread is a click away, as replies on that post's page. The
   * rows after it are tagged for the stylesheet to hide, along with the rows
   * between them, such as "Show more replies". Never the last row, though,
   * which is the one X watches to load more.
   */
  function tagThreads() {
    const stale = new Set(document.querySelectorAll("[data-trf-thread-rest]"));
    const tag = (row) => {
      stale.delete(row);
      if (!row.hasAttribute("data-trf-thread-rest")) row.dataset.trfThreadRest = "";
    };

    // A row with no post after a linked one is only held, and hidden once a
    // post that continues the thread turns up after it. One that is followed
    // by anything else, or by nothing loaded yet, is none of the thread's
    // business and stays.
    if (location.pathname === "/home") {
      let open = false;
      let held = [];
      for (const row of document.querySelectorAll(CELL_SELECTOR)) {
        if (!row.nextElementSibling) break;
        const article = row.querySelector(TWEET_SELECTOR);
        if (!article) {
          if (open) held.push(row);
          continue;
        }
        const { top, bottom } = threadLinks(article);
        if (top) {
          for (const gap of held) tag(gap);
          tag(row);
        }
        held = [];
        open = bottom;
      }
    }

    for (const row of stale) delete row.dataset.trfThreadRest;
  }

  /**
   * Whether a post is linked to the one above it (top) and to the one below
   * (bottom). X draws each link as an empty box 2px wide in the avatar column,
   * above the avatar for a link up and below it for a link down. Nothing names
   * it, so it is found by its shape, once per post shown in the article, as X
   * reuses articles for other posts. The boxes are tagged on the way, so the
   * stylesheet can hide one left dangling once the avatars are gone.
   */
  function threadLinks(article) {
    const id = tweetIdOf(article) || "";
    if (article.dataset.trfThreadFor !== id) {
      let top = false;
      let bottom = false;
      const avatar = article.querySelector('[data-testid="Tweet-User-Avatar"]');
      // Not settled before the avatar column is there, so try again later.
      if (!avatar) return { top: false, bottom: false };
      for (const box of article.querySelectorAll("div:empty")) {
        const style = getComputedStyle(box);
        if (style.width !== "2px" || style.backgroundColor === "rgba(0, 0, 0, 0)") continue;
        if (!box.hasAttribute("data-trf-connector")) box.dataset.trfConnector = "";
        if (box.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING) top = true;
        else bottom = true;
      }
      article.dataset.trfThreadFor = id;
      article.dataset.trfThread = `${top ? "top" : ""} ${bottom ? "bottom" : ""}`.trim();
    }
    const links = article.dataset.trfThread.split(" ");
    return { top: links.includes("top"), bottom: links.includes("bottom") };
  }

  /**
   * The tab bar at the top of Home: the line under it and the "+" button that
   * pins a list. Neither has a hook, and the line is not even drawn by the tab
   * bar: it can be a border on any of the boxes stacked around the tabs, or one
   * a pixel high of its own. So the "+" is found as the one control in the
   * header that is not a tab, and the line by where it is: anything in the
   * column, outside the rows of the timeline, that draws a line across right
   * at the bottom edge of the tabs. The blue underline of the selected tab is
   * no wider than the tab, so it is left alone.
   *
   * Only on /home, since elsewhere the same header holds the back button.
   */
  function tagHeader() {
    if (location.pathname !== "/home") return;
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const nav = column?.querySelector('nav [role="tab"]')?.closest("nav");
    if (!nav) return;
    if (!nav.hasAttribute("data-trf-tabs")) nav.dataset.trfTabs = "";
    placeModeToggle(nav);

    let header = nav;
    while (
      header.parentElement &&
      header.parentElement !== column &&
      !header.parentElement.querySelector(`${CELL_SELECTOR}, [data-testid="tweetTextarea_0"]`)
    ) {
      header = header.parentElement;
    }
    // A control beside the tabs sits in a box of its own that keeps its width
    // with the control hidden, so the whole box goes, and the tabs take the
    // width back to line up with the cards.
    for (let el of header.querySelectorAll('a, button, [role="button"]')) {
      if (el.closest('[role="tab"]') || el.querySelector('[role="tab"]')) continue;
      if (el.closest("[data-trf-mode-toggle]")) continue;
      if (!nav.contains(el)) {
        while (el.parentElement !== header && !el.parentElement.contains(nav)) el = el.parentElement;
      }
      if (!el.hasAttribute("data-trf-header-button")) el.dataset.trfHeaderButton = "";
    }

    // Measured at the top of the page only: once scrolled, other boxes pass
    // under the pinned tab bar and would line up with it by accident.
    if (window.scrollY > 50) return;

    const edge = nav.getBoundingClientRect();
    const near = (y) => Math.abs(y - edge.bottom) <= 3;
    const walker = document.createTreeWalker(column, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (el) =>
        el.matches(CELL_SELECTOR)
          ? NodeFilter.FILTER_REJECT
          : el.hasAttribute("data-trf-header-line") || el.hasAttribute("data-trf-tabs")
            ? NodeFilter.FILTER_SKIP
            : NodeFilter.FILTER_ACCEPT
    });

    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      const rect = el.getBoundingClientRect();
      if (rect.width < edge.width * 0.5) continue;
      const style = getComputedStyle(el);
      let side = null;
      if (parseFloat(style.borderBottomWidth) > 0 && near(rect.bottom)) side = "bottom";
      else if (parseFloat(style.borderTopWidth) > 0 && near(rect.top)) side = "top";
      else if (rect.height > 0 && rect.height <= 2 && near(rect.top)) side = "box";
      else if (style.boxShadow !== "none" && near(rect.bottom)) side = "bottom";
      if (!side) continue;
      el.dataset.trfHeaderLine = side;
      log("line under the tab bar", side, el);
    }
  }

  const MODE_BUTTONS = [
    {
      mode: "dim",
      label: "Dim read posts",
      icon: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'
    },
    {
      mode: "hide",
      label: "Hide read posts",
      icon:
        '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/>' +
        '<circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>'
    },
    {
      mode: "show",
      label: "Show read posts",
      icon:
        '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/>' +
        '<circle cx="12" cy="12" r="3"/>'
    }
  ];

  /**
   * The dim / hide / show switch at the right end of the tab bar, the same
   * choice as in the popup. It goes last in the nav, after everything X put
   * there, and is put back whenever X re-renders the bar without it.
   */
  function placeModeToggle(nav) {
    let toggle = nav.querySelector(":scope > [data-trf-mode-toggle]");
    if (!toggle) {
      toggle = document.createElement("div");
      toggle.dataset.trfModeToggle = "";
      toggle.setAttribute("role", "radiogroup");
      toggle.setAttribute("aria-label", "Read posts");
      for (const { mode, label, icon } of MODE_BUTTONS) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.mode = mode;
        button.title = label;
        button.setAttribute("role", "radio");
        button.setAttribute("aria-label", label);
        button.innerHTML = svgIcon(icon);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (contextGone() || settings.mode === mode) return;
          chrome.storage.local.set({ settings: { ...settings, mode } });
        });
        toggle.append(button);
      }
      nav.append(toggle);
    } else if (toggle !== nav.lastElementChild) {
      nav.append(toggle);
    }
    for (const button of toggle.children) {
      const on = String(button.dataset.mode === settings.mode);
      if (button.getAttribute("aria-checked") !== on) button.setAttribute("aria-checked", on);
    }
  }

  function svgIcon(icon) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`
    );
  }

  const CAMERA_ICON =
    '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 5h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>' +
    '<circle cx="12" cy="13" r="3.5"/>';
  const DONE_ICON = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
  const FAILED_ICON = '<path d="M6 6l12 12M18 6L6 18"/>';
  const CARD_RADIUS = 16;
  /** Wide enough to read in a social feed, small enough to share easily. */
  const CAPTURE_WIDTH = 720;

  /**
   * The button in the top right corner of a card that copies a picture of the
   * card to the clipboard. It goes in the card, the row's only child, beside
   * the post rather than inside it, and is put back whenever X re-renders the
   * row without it. X reuses rows for other posts, so the button works out
   * which card it is in when clicked.
   */
  function placeCaptureButton(article) {
    const card = article.closest(CELL_SELECTOR)?.querySelector(":scope > div");
    if (!card || card.querySelector(":scope > [data-trf-capture]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.trfCapture = "";
    button.title = "Copy a picture of this post";
    button.setAttribute("aria-label", "Copy a picture of this post");
    button.innerHTML = svgIcon(CAMERA_ICON);
    button.addEventListener("click", onCaptureClick);
    card.append(button);
  }

  /**
   * Hands the clipboard a promise of the picture straight away, while the click
   * still counts as one: by the time the screenshot is back and cropped, the
   * browser would no longer let a fresh write through.
   */
  function onCaptureClick(event) {
    // Kept from X, which would otherwise open the post.
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    if (contextGone() || button.hasAttribute("data-state")) return;
    button.dataset.state = "busy";

    const picture = captureCard(button.parentElement);
    navigator.clipboard
      .write([new ClipboardItem({ "image/png": picture })])
      .then(
        () => showCaptureState(button, "done", DONE_ICON),
        (error) => {
          console.warn("[unread4me] could not copy the post", error);
          showCaptureState(button, "failed", FAILED_ICON);
        }
      );
  }

  function showCaptureState(button, state, icon) {
    button.dataset.state = state;
    button.innerHTML = svgIcon(icon);
    setTimeout(() => {
      delete button.dataset.state;
      button.innerHTML = svgIcon(CAMERA_ICON);
    }, 1500);
  }

  /**
   * The screenshot covers only what is on screen, so the card is scrolled clear
   * of the pinned tab bar first, and of the bottom edge when it fits. While it
   * is taken, the root carries an attribute that hides the button and lifts the
   * dimming of a read post.
   */
  async function captureCard(card) {
    const root = document.documentElement;
    root.dataset.trfCapturing = "";
    let rect;
    let response;
    try {
      bringIntoView(card);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      rect = card.getBoundingClientRect();
      response = await chrome.runtime.sendMessage({ type: "capture" });
    } finally {
      delete root.dataset.trfCapturing;
    }
    if (!response?.dataUrl) throw new Error(response?.error || "no screenshot");
    return cropToCard(response.dataUrl, rect);
  }

  function bringIntoView(card) {
    const top = headerOffset() + 8;
    const bottom = window.innerHeight - 8;
    const rect = card.getBoundingClientRect();
    let delta = 0;
    if (rect.top < top || rect.height > bottom - top) delta = rect.top - top;
    else if (rect.bottom > bottom) delta = rect.bottom - bottom;
    if (delta !== 0) window.scrollBy({ top: delta, behavior: "instant" });
  }

  /**
   * The screenshot is at device pixels, so everything is scaled by how much
   * wider it is than the window. The corners are cut round like the card's, so
   * the page behind them does not show.
   */
  async function cropToCard(dataUrl, rect) {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));

    const scale = image.width / window.innerWidth;
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const width = Math.round((Math.min(rect.right, window.innerWidth) - left) * scale);
    const height = Math.round((Math.min(rect.bottom, window.innerHeight) - top) * scale);

    // Brought down to the width social networks show a picture at, never up,
    // since enlarging a small screenshot only blurs it.
    const fit = Math.min(1, CAPTURE_WIDTH / width);
    const outWidth = Math.round(width * fit);
    const outHeight = Math.round(height * fit);

    const canvas = new OffscreenCanvas(outWidth, outHeight);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.beginPath();
    context.roundRect(0, 0, outWidth, outHeight, CARD_RADIUS * scale * fit);
    context.clip();
    context.drawImage(
      image,
      Math.round(left * scale),
      Math.round(top * scale),
      width,
      height,
      0,
      0,
      outWidth,
      outHeight
    );
    image.close();
    return canvas.convertToBlob({ type: "image/png" });
  }

  function tagTweets(root) {
    if (root.matches?.(TWEET_SELECTOR)) return tagTweet(root);
    for (const article of root.querySelectorAll(TWEET_SELECTOR)) tagTweet(article);
  }

  function updateBadge(count) {
    if (count === lastBadgeCount || contextGone()) return;
    lastBadgeCount = count;
    chrome.runtime.sendMessage({ type: "badge", count }).catch(() => {});
  }

  /* ---------------------------------------------------------------- keyboard */

  /**
   * X's own j/k walks its internal list of timeline entries, which still holds
   * every row we collapsed: it has no idea they are hidden. Pressing j then
   * stops on each one invisibly before reaching a post you can actually see.
   * Nothing we can set tells X to skip them, so in hide mode we take the keys
   * and walk the rows that are really on the page.
   */
  function onKeyDown(event) {
    if (!inScope || settings.mode !== "hide") return;
    if (event.key !== "j" && event.key !== "k") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    }

    const rows = navigableRows();
    if (rows.length === 0) return;

    // X binds these too, and both of us acting would move you twice.
    event.preventDefault();
    event.stopImmediatePropagation();
    stepTo(rows, event.key === "j" ? 1 : -1);
  }

  /** The rows actually on the page, in order. Collapsed ones are not stops. */
  function navigableRows() {
    const rows = [];
    for (const cell of document.querySelectorAll(CELL_SELECTOR)) {
      if (cell.classList.contains(HIDE_CLASS) || cell.hasAttribute("data-trf-thread-rest")) continue;
      const article = cell.querySelector(TWEET_SELECTOR);
      const id = article ? tweetIdOf(article) : null;
      if (id) rows.push({ cell, id });
    }
    return rows;
  }

  function stepTo(rows, delta) {
    const offset = headerOffset();

    let index = -1;
    if (currentId !== null) {
      const found = rows.findIndex((row) => row.id === currentId);
      if (found !== -1) {
        // Only keep the old position if you have not scrolled away from it by
        // hand since, otherwise start again from what is on screen now.
        const rect = rows[found].cell.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < window.innerHeight) index = found;
      }
    }

    if (index === -1) {
      index = rows.findIndex((row) => row.cell.getBoundingClientRect().top >= offset - 1);
      if (index === -1) index = rows.length - 1;
      // Nothing was picked yet, so j should land on the post at the top rather
      // than skipping straight past it.
      if (delta > 0) index -= 1;
    }

    const next = rows[index + delta];
    if (!next) return;

    currentId = next.id;
    const top = next.cell.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: "instant" });
    log(`moved to ${next.id}`);
  }

  /** Height of the pinned tab bar, so a post does not land underneath it. */
  function headerOffset() {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    const nav = tab && tab.closest("nav");
    if (!nav) return 0;
    const rect = nav.getBoundingClientRect();
    return rect.top <= 1 ? Math.max(0, rect.bottom) : 0;
  }

  /* ------------------------------------------------------------------- state */

  async function load() {
    const stored = await chrome.storage.local.get(["settings", "readTweets"]);
    settings = normalize(stored.settings);
    for (const id of Object.keys(stored.readTweets || {})) readIds.add(id);
    applyDimStrength();
    applyLayout();
    log(`loaded ${readIds.size} read ids from storage, mode ${settings.mode}`);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.settings) {
      const previousMode = settings.mode;
      settings = normalize(changes.settings.newValue);
      applyDimStrength();
      applyLayout();
      // Switching mode has to drop the classes of the mode you left, and lets a
      // tweet collapsed earlier come back if you asked to see it again.
      if (settings.mode !== previousMode) clearEverything();
    }

    if (changes.readTweets) {
      const next = changes.readTweets.newValue || {};
      const ids = Object.keys(next);
      if (ids.length === 0) {
        // History was cleared from the popup.
        readIds.clear();
        sessionReadIds.clear();
        dwelledIds.clear();
        clearEverything();
      } else {
        for (const id of ids) readIds.add(id);
      }
    }

    requestScan();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "stats") return false;
    sendResponse({ inScope, marked: maskedIds.size, collapsed: collapsedIds.size });
    return false;
  });

  // Capture, so we get the keys before X's own handler does.
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", requestScan, { passive: true });
  window.addEventListener("resize", requestScan, { passive: true });
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  load().then(() => {
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      // Catches a re-render dropping our class before the row gets painted
      // back at full height.
      attributes: true,
      attributeFilter: ["class"]
    });
    setInterval(() => {
      pruneObserved();
      requestScan();
    }, BACKSTOP_MS);
    // Straight in, not through the throttle: anything already on the page when
    // we start would otherwise sit there at full height until the first scan.
    scan();
  });
})();
