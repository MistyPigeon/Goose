/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",

  Log: "chrome://remote/content/shared/Log.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logger", () =>
  lazy.Log.get(lazy.Log.TYPES.MARIONETTE)
);

/**
 * Child JSWindowActor to handle navigation for reftests relying on marionette.
 */
export class MarionetteReftestChild extends JSWindowActorChild {
  constructor() {
    super();

    // This promise will resolve with the URL recorded in the "load" event
    // handler. This URL will not be impacted by any hash modification that
    // might be performed by the test script.
    // The harness should be loaded before loading any test page, so the actors
    // should be registered before the "load" event is received for a test page.
    this._loadedURLPromise = new Promise(
      r => (this._resolveLoadedURLPromise = r)
    );
  }

  handleEvent(event) {
    if (event.type == "load") {
      const url = event.target.location.href;
      lazy.logger.debug(`Handle load event with URL ${url}`);
      this._resolveLoadedURLPromise(url);
    }
  }

  actorCreated() {
    lazy.logger.trace(
      `[${this.browsingContext.id}] Reftest actor created ` +
        `for window id ${this.manager.innerWindowId}`
    );
  }

  async receiveMessage(msg) {
    const { name, data } = msg;

    let result;
    switch (name) {
      case "MarionetteReftestParent:flushRendering":
        result = await this.flushRendering(data);
        break;
      case "MarionetteReftestParent:reftestWait":
        result = await this.reftestWait(data);
        break;
    }
    return result;
  }

  /**
   * Wait for a reftest page to be ready for screenshots:
   * - wait for the loadedURL to be available (see handleEvent)
   * - check if the URL matches the expected URL
   * - if present, wait for the "reftest-wait" classname to be removed from the
   *   document element
   *
   * @param {object} options
   * @param {string} options.url
   *        The expected test page URL
   * @param {boolean} options.useRemote
   *        True when using e10s
   * @param {boolean} options.warnOnOverflow
   *        True if we should check the content fits in the viewport.
   *        This isn't necessary for print reftests where we will render the full
   *        size of the paginated content.
   * @returns {boolean}
   *         Returns true when the correct page is loaded and ready for
   *         screenshots. Returns false if the page loaded bug does not have the
   *         expected URL.
   */
  async reftestWait(options = {}) {
    const { url, useRemote } = options;
    const loadedURL = await this._loadedURLPromise;
    if (loadedURL !== url) {
      lazy.logger.debug(
        `Window URL does not match the expected URL "${loadedURL}" !== "${url}"`
      );
      return false;
    }

    const documentElement = this.document.documentElement;
    const hasReftestWait = documentElement.classList.contains("reftest-wait");

    lazy.logger.debug("Waiting for event loop to spin");
    await new Promise(resolve => lazy.setTimeout(resolve, 0));

    await this.paintComplete({
      useRemote,
      ignoreThrottledAnimations: true,
      hasReftestWait,
    });

    if (hasReftestWait) {
      const event = new this.document.defaultView.Event("TestRendered", {
        bubbles: true,
      });
      documentElement.dispatchEvent(event);
      lazy.logger.info("Emitted TestRendered event");
      await this.reftestWaitRemoved();
      await this.paintComplete({
        useRemote,
        ignoreThrottledAnimations: false,
        hasReftestWait,
      });
    }
    if (
      options.warnOnOverflow &&
      (this.document.defaultView.innerWidth < documentElement.scrollWidth ||
        this.document.defaultView.innerHeight < documentElement.scrollHeight)
    ) {
      lazy.logger.warn(
        `${url} overflows viewport (width: ${documentElement.scrollWidth}, height: ${documentElement.scrollHeight})`
      );
    }
    return true;
  }

  paintComplete({ useRemote, ignoreThrottledAnimations, hasReftestWait }) {
    lazy.logger.debug("Waiting for rendering");
    let win = this.document.defaultView;
    let windowUtils = win.windowUtils;
    let painted = false;
    const documentElement = this.document.documentElement;
    return new Promise(resolve => {
      let maybeResolve = () => {
        this.flushRendering({ ignoreThrottledAnimations });
        if (useRemote) {
          // Flush display (paint)
          lazy.logger.debug("Force update of layer tree");
          windowUtils.updateLayerTree();
        }

        const once =
          hasReftestWait && !documentElement.classList.contains("reftest-wait");
        if (windowUtils.isMozAfterPaintPending && (!once || !painted)) {
          lazy.logger.debug("isMozAfterPaintPending: true");
          win.windowRoot.addEventListener(
            "MozAfterPaint",
            () => {
              lazy.logger.debug("MozAfterPaint fired");
              painted = true;
              maybeResolve();
            },
            { once: true }
          );
        } else {
          // resolve at the start of the next frame in case of leftover paints
          lazy.logger.debug("isMozAfterPaintPending: false");
          win.requestAnimationFrame(() => {
            win.requestAnimationFrame(resolve);
          });
        }
      };
      maybeResolve();
    });
  }

  reftestWaitRemoved() {
    lazy.logger.debug("Waiting for reftest-wait removal");
    return new Promise(resolve => {
      const documentElement = this.document.documentElement;
      let observer = new this.document.defaultView.MutationObserver(() => {
        if (!documentElement.classList.contains("reftest-wait")) {
          observer.disconnect();
          lazy.logger.debug("reftest-wait removed");
          lazy.setTimeout(resolve, 0);
        }
      });
      if (documentElement.classList.contains("reftest-wait")) {
        observer.observe(documentElement, { attributes: true });
      } else {
        lazy.setTimeout(resolve, 0);
      }
    });
  }

  /**
   * Ensure layout is flushed in each frame
   *
   * @param {object} options
   * @param {boolean} options.ignoreThrottledAnimations Don't flush
   *        the layout of throttled animations. We can end up in a
   *        situation where flushing a throttled animation causes
   *        mozAfterPaint events even when all rendering we care about
   *        should have ceased. See
   *        https://searchfox.org/mozilla-central/rev/d58860eb739af613774c942c3bb61754123e449b/layout/tools/reftest/reftest-content.js#723-729
   *        for more detail.
   */
  flushRendering(options = {}) {
    let { ignoreThrottledAnimations } = options;
    lazy.logger.debug(
      `flushRendering ignoreThrottledAnimations:${ignoreThrottledAnimations}`
    );
    let anyPendingPaintsGeneratedInDescendants = false;

    function flushWindow(win) {
      let utils = win.windowUtils;
      let afterPaintWasPending = utils.isMozAfterPaintPending;

      let root = win.document.documentElement;
      if (root) {
        try {
          if (ignoreThrottledAnimations) {
            utils.flushLayoutWithoutThrottledAnimations();
          } else {
            root.getBoundingClientRect();
          }
        } catch (e) {
          lazy.logger.error("flushWindow failed", e);
        }
      }

      if (!afterPaintWasPending && utils.isMozAfterPaintPending) {
        anyPendingPaintsGeneratedInDescendants = true;
      }

      for (let i = 0; i < win.frames.length; ++i) {
        // Skip remote frames, flushRendering will be called on their individual
        // MarionetteReftest actor via _recursiveFlushRendering performed from
        // the topmost MarionetteReftest actor.
        if (!Cu.isRemoteProxy(win.frames[i])) {
          flushWindow(win.frames[i]);
        }
      }
    }

    let thisWin = this.document.defaultView;
    flushWindow(thisWin);

    if (
      anyPendingPaintsGeneratedInDescendants &&
      !thisWin.windowUtils.isMozAfterPaintPending
    ) {
      lazy.logger.error(
        "Descendant frame generated a MozAfterPaint event, " +
          "but the root document doesn't have one!"
      );
    }
  }
}
