/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This file is loaded into the browser window scope.
/* eslint-env mozilla/browser-window */

var PointerlockFsWarning = {
  _element: null,
  _origin: null,

  /**
   * Timeout object for managing timeout request. If it is started when
   * the previous call hasn't finished, it would automatically cancelled
   * the previous one.
   */
  Timeout: class {
    constructor(func, delay) {
      this._id = 0;
      this._func = func;
      this._delay = delay;
    }
    start() {
      this.cancel();
      this._id = setTimeout(() => this._handle(), this._delay);
    }
    cancel() {
      if (this._id) {
        clearTimeout(this._id);
        this._id = 0;
      }
    }
    _handle() {
      this._id = 0;
      this._func();
    }
    get delay() {
      return this._delay;
    }
  },

  showPointerLock(aOrigin) {
    if (!document.fullscreen) {
      let timeout = Services.prefs.getIntPref(
        "pointer-lock-api.warning.timeout"
      );
      this.show(aOrigin, "pointerlock-warning", timeout, 0);
    }
  },

  showFullScreen(aOrigin) {
    let timeout = Services.prefs.getIntPref("full-screen-api.warning.timeout");
    let delay = Services.prefs.getIntPref("full-screen-api.warning.delay");
    this.show(aOrigin, "fullscreen-warning", timeout, delay);
  },

  // Shows a warning that the site has entered fullscreen or
  // pointer lock for a short duration.
  show(aOrigin, elementId, timeout, delay) {
    if (!this._element) {
      this._element = document.getElementById(elementId);
      // Setup event listeners
      this._element.addEventListener("transitionend", this);
      this._element.addEventListener("transitioncancel", this);
      window.addEventListener("mousemove", this, true);
      // If the user explicitly disables the prompt, there's no need to detect
      // activation.
      if (timeout > 0) {
        window.addEventListener("activate", this);
        window.addEventListener("deactivate", this);
      }
      // The timeout to hide the warning box after a while.
      this._timeoutHide = new this.Timeout(() => {
        window.removeEventListener("activate", this);
        window.removeEventListener("deactivate", this);
        this._state = "hidden";
      }, timeout);
      // The timeout to show the warning box when the pointer is at the top
      this._timeoutShow = new this.Timeout(() => {
        this._state = "ontop";
        this._timeoutHide.start();
      }, delay);
    }

    // Set the strings on the warning UI.
    if (aOrigin) {
      this._origin = aOrigin;
    }
    let uri = Services.io.newURI(this._origin);
    let host = null;
    // Make an exception for PDF.js - we'll show "This document" instead.
    if (this._origin != "resource://pdf.js") {
      try {
        host = uri.host;
      } catch (e) {}
    }
    let textElem = this._element.querySelector(
      ".pointerlockfswarning-domain-text"
    );
    if (!host) {
      textElem.hidden = true;
    } else {
      textElem.removeAttribute("hidden");
      // Document's principal's URI has a host. Display a warning including it.
      let { DownloadUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/DownloadUtils.sys.mjs"
      );
      let displayHost = DownloadUtils.getURIHost(uri.spec)[0];
      let l10nString = {
        "fullscreen-warning": "fullscreen-warning-domain",
        "pointerlock-warning": "pointerlock-warning-domain",
      }[elementId];
      document.l10n.setAttributes(textElem, l10nString, {
        domain: displayHost,
      });
    }

    this._element.dataset.identity =
      gIdentityHandler.pointerlockFsWarningClassName;

    // User should be allowed to explicitly disable
    // the prompt if they really want.
    if (this._timeoutHide.delay <= 0) {
      return;
    }

    if (Services.focus.activeWindow == window) {
      this._state = "onscreen";
      this._timeoutHide.start();
    }
  },

  /**
   * Close the full screen or pointerlock warning.
   * @param {('fullscreen-warning'|'pointerlock-warning')} elementId - Id of the
   * warning element to close. If the id does not match the currently shown
   * warning this is a no-op.
   */
  close(elementId) {
    if (!elementId) {
      throw new Error("Must pass id of warning element to close");
    }
    if (!this._element || this._element.id != elementId) {
      return;
    }
    // Cancel any pending timeout
    this._timeoutHide.cancel();
    this._timeoutShow.cancel();
    // Reset state of the warning box
    this._state = "hidden";
    this._doHide();
    // Reset state of the text so we don't persist or retranslate it.
    this._element
      .querySelector(".pointerlockfswarning-domain-text")
      .removeAttribute("data-l10n-id");
    // Remove all event listeners
    this._element.removeEventListener("transitionend", this);
    this._element.removeEventListener("transitioncancel", this);
    window.removeEventListener("mousemove", this, true);
    window.removeEventListener("activate", this);
    window.removeEventListener("deactivate", this);
    // Clear fields
    this._element = null;
    this._timeoutHide = null;
    this._timeoutShow = null;

    // Ensure focus switches away from the (now hidden) warning box.
    // If the user clicked buttons in the warning box, it would have
    // been focused, and any key events would be directed at the (now
    // hidden) chrome document instead of the target document.
    gBrowser.selectedBrowser.focus();
  },

  // State could be one of "onscreen", "ontop", "hiding", and
  // "hidden". Setting the state to "onscreen" and "ontop" takes
  // effect immediately, while setting it to "hidden" actually
  // turns the state to "hiding" before the transition finishes.
  _lastState: null,
  _STATES: ["hidden", "ontop", "onscreen"],
  get _state() {
    for (let state of this._STATES) {
      if (this._element.hasAttribute(state)) {
        return state;
      }
    }
    return "hiding";
  },

  _doHide() {
    try {
      this._element.hidePopover();
    } catch (e) {}
    this._element.hidden = true;
  },

  set _state(newState) {
    let currentState = this._state;
    if (currentState == newState) {
      return;
    }
    if (currentState != "hiding") {
      this._lastState = currentState;
      this._element.removeAttribute(currentState);
    }
    if (currentState == "hidden") {
      this._element.showPopover();
    }
    // hidden is dealt with on transitionend or close(), see _doHide().
    if (newState != "hidden") {
      this._element.setAttribute(newState, "");
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case "mousemove": {
        let state = this._state;
        if (state == "hidden") {
          // If the warning box is currently hidden, show it after
          // a short delay if the pointer is at the top.
          if (event.clientY != 0) {
            this._timeoutShow.cancel();
          } else if (this._timeoutShow.delay >= 0) {
            this._timeoutShow.start();
          }
        } else if (state != "onscreen") {
          let elemRect = this._element.getBoundingClientRect();
          if (state == "hiding" && this._lastState != "hidden") {
            // If we are on the hiding transition, and the pointer
            // moved near the box, restore to the previous state.
            if (event.clientY <= elemRect.bottom + 50) {
              this._state = this._lastState;
              this._timeoutHide.start();
            }
          } else if (state == "ontop" || this._lastState != "hidden") {
            // State being "ontop" or the previous state not being
            // "hidden" indicates this current warning box is shown
            // in response to user's action. Hide it immediately when
            // the pointer leaves that area.
            if (event.clientY > elemRect.bottom + 50) {
              this._state = "hidden";
              this._timeoutHide.cancel();
            }
          }
        }
        break;
      }
      case "transitionend":
      case "transitioncancel": {
        if (this._state == "hiding") {
          this._doHide();
        }
        if (this._state == "onscreen") {
          window.dispatchEvent(new CustomEvent("FullscreenWarningOnScreen"));
        }
        break;
      }
      case "activate": {
        this._state = "onscreen";
        this._timeoutHide.start();
        break;
      }
      case "deactivate": {
        this._state = "hidden";
        this._timeoutHide.cancel();
        break;
      }
    }
  },
};

var PointerLock = {
  _isActive: false,

  /**
   * @returns {boolean} - true if pointer lock is currently active for the
   * associated window.
   */
  get isActive() {
    return this._isActive;
  },

  entered(originNoSuffix) {
    this._isActive = true;
    Services.obs.notifyObservers(null, "pointer-lock-entered");
    PointerlockFsWarning.showPointerLock(originNoSuffix);
  },

  exited() {
    this._isActive = false;
    PointerlockFsWarning.close("pointerlock-warning");
  },
};

var FullScreen = {
  init() {
    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "permissionsFullScreenAllowed",
      "permissions.fullscreen.allowed"
    );

    let notificationExitButton = document.getElementById(
      "fullscreen-exit-button"
    );
    notificationExitButton.addEventListener("click", this.exitDomFullScreen);

    // Called when the Firefox window go into fullscreen.
    addEventListener("fullscreen", this, true);

    // Called only when fullscreen is requested
    // by the parent (eg: via the browser-menu).
    // Should not be called when the request comes from
    // the content.
    addEventListener("willenterfullscreen", this, true);
    addEventListener("willexitfullscreen", this, true);
    addEventListener("MacFullscreenMenubarRevealUpdate", this, true);

    if (window.fullScreen) {
      this.toggle();
    }
  },

  uninit() {
    this.cleanup();
  },

  willToggle(aWillEnterFullscreen) {
    if (aWillEnterFullscreen) {
      document.documentElement.setAttribute("inFullscreen", true);
    } else {
      document.documentElement.removeAttribute("inFullscreen");
    }
  },

  get fullScreenToggler() {
    delete this.fullScreenToggler;
    return (this.fullScreenToggler =
      document.getElementById("fullscr-toggler"));
  },

  toggle() {
    var enterFS = window.fullScreen;

    // Toggle the View:FullScreen command, which controls elements like the
    // fullscreen menuitem, and menubars.
    let fullscreenCommand = document.getElementById("View:FullScreen");
    if (enterFS) {
      fullscreenCommand.setAttribute("checked", enterFS);
    } else {
      fullscreenCommand.removeAttribute("checked");
    }

    if (AppConstants.platform == "macosx") {
      // Make sure the menu items are adjusted.
      document.getElementById("enterFullScreenItem").hidden = enterFS;
      document.getElementById("exitFullScreenItem").hidden = !enterFS;
      this.shiftMacToolbarDown(0);
    }

    let fstoggler = this.fullScreenToggler;
    fstoggler.addEventListener("mouseover", this._expandCallback);
    fstoggler.addEventListener("dragenter", this._expandCallback);
    fstoggler.addEventListener("touchmove", this._expandCallback, {
      passive: true,
    });

    document.documentElement.toggleAttribute("inFullscreen", enterFS);
    document.documentElement.toggleAttribute(
      "macOSNativeFullscreen",
      enterFS &&
        AppConstants.platform == "macosx" &&
        (Services.prefs.getBoolPref(
          "full-screen-api.macos-native-full-screen"
        ) ||
          !document.fullscreenElement)
    );

    if (!document.fullscreenElement) {
      ToolbarIconColor.inferFromText("fullscreen", enterFS);
    }

    if (enterFS) {
      document.addEventListener("keypress", this._keyToggleCallback);
      document.addEventListener("popupshown", this._setPopupOpen);
      document.addEventListener("popuphidden", this._setPopupOpen);
      gURLBar.controller.addListener(this);

      // In DOM fullscreen mode, we hide toolbars with CSS
      if (!document.fullscreenElement) {
        this.hideNavToolbox(true);
      }
    } else {
      this.showNavToolbox(false);
      // This is needed if they use the context menu to quit fullscreen
      this._isPopupOpen = false;
      this.cleanup();
    }
    this._toggleShortcutKeys();
  },

  exitDomFullScreen() {
    // Don't use `this` here. It does not reliably refer to this object.
    if (document.fullscreen) {
      document.exitFullscreen();
    }
  },

  _currentToolbarShift: 0,

  /**
   * Shifts the browser toolbar down when it is moused over on macOS in
   * fullscreen.
   * @param {number} shiftSize
   *   A distance, in pixels, by which to shift the browser toolbar down.
   */
  shiftMacToolbarDown(shiftSize) {
    if (typeof shiftSize !== "number") {
      console.error("Tried to shift the toolbar by a non-numeric distance.");
      return;
    }

    // shiftSize is sent from Cocoa widget code as a very precise double. We
    // don't need that kind of precision in our CSS.
    shiftSize = shiftSize.toFixed(2);
    gNavToolbox.classList.toggle("fullscreen-with-menubar", shiftSize > 0);

    let transform = shiftSize > 0 ? `translateY(${shiftSize}px)` : "";
    gNavToolbox.style.transform = transform;
    gURLBar.textbox.style.transform = gURLBar.textbox.hasAttribute("breakout")
      ? transform
      : "";
    if (shiftSize > 0) {
      // If the mouse tracking missed our fullScreenToggler, then the toolbox
      // might not have been shown before the menubar is animated down. Make
      // sure it is shown now.
      if (!this.fullScreenToggler.hidden) {
        this.showNavToolbox();
      }
    }

    this._currentToolbarShift = shiftSize;
  },

  handleEvent(event) {
    switch (event.type) {
      case "willenterfullscreen":
        this.willToggle(true);
        break;
      case "willexitfullscreen":
        this.willToggle(false);
        break;
      case "fullscreen":
        this.toggle();
        break;
      case "MacFullscreenMenubarRevealUpdate":
        this.shiftMacToolbarDown(event.detail);
        break;
    }
  },

  _logWarningPermissionPromptFS(actionStringKey) {
    let consoleMsg = Cc["@mozilla.org/scripterror;1"].createInstance(
      Ci.nsIScriptError
    );
    let message = gBrowserBundle.GetStringFromName(
      `permissions.fullscreen.${actionStringKey}`
    );
    consoleMsg.initWithWindowID(
      message,
      gBrowser.currentURI.spec,
      0,
      0,
      Ci.nsIScriptError.warningFlag,
      "FullScreen",
      gBrowser.selectedBrowser.innerWindowID
    );
    Services.console.logMessage(consoleMsg);
  },

  _handlePermPromptShow() {
    if (
      !FullScreen.permissionsFullScreenAllowed &&
      window.fullScreen &&
      PopupNotifications.getNotification(
        this._permissionNotificationIDs
      ).filter(n => !n.dismissed).length
    ) {
      this.exitDomFullScreen();
      this._logWarningPermissionPromptFS("fullScreenCanceled");
    }
  },

  enterDomFullscreen(aBrowser, aActor) {
    if (!document.fullscreenElement) {
      aActor.requestOrigin = null;
      return;
    }

    // If we have a current pointerlock warning shown then hide it
    // before transition.
    PointerlockFsWarning.close("pointerlock-warning");

    // If it is a remote browser, send a message to ask the content
    // to enter fullscreen state. We don't need to do so if it is an
    // in-process browser, since all related document should have
    // entered fullscreen state at this point.
    // Additionally, in Fission world, we may need to notify the
    // frames in the middle (content frames that embbed the oop iframe where
    // the element requesting fullscreen lives) to enter fullscreen
    // first.
    // This should be done before the active tab check below to ensure
    // that the content document handles the pending request. Doing so
    // before the check is fine since we also check the activeness of
    // the requesting document in content-side handling code.
    if (this._isRemoteBrowser(aBrowser)) {
      // The cached message recipient in actor is used for fullscreen state
      // cleanup, we should not use it while entering fullscreen.
      let [targetActor, inProcessBC] = this._getNextMsgRecipientActor(
        aActor,
        false /* aUseCache */
      );
      if (!targetActor) {
        // If there is no appropriate actor to send the message we have
        // no way to complete the transition and should abort by exiting
        // fullscreen.
        this._abortEnterFullscreen(aActor);
        return;
      }
      // Record that the actor is waiting for its child to enter
      // fullscreen so that if it dies we can abort.
      targetActor.waitingForChildEnterFullscreen = true;
      targetActor.sendAsyncMessage("DOMFullscreen:Entered", {
        remoteFrameBC: inProcessBC,
      });

      if (inProcessBC) {
        // We aren't messaging the request origin yet, skip this time.
        return;
      }
    }

    // If we've received a fullscreen notification, we have to ensure that the
    // element that's requesting fullscreen belongs to the browser that's currently
    // active. If not, we exit fullscreen since the "full-screen document" isn't
    // actually visible now.
    if (
      !aBrowser ||
      gBrowser.selectedBrowser != aBrowser ||
      // The top-level window has lost focus since the request to enter
      // full-screen was made. Cancel full-screen.
      Services.focus.activeWindow != window
    ) {
      this._abortEnterFullscreen(aActor);
      return;
    }

    // Remove permission prompts when entering full-screen.
    if (!FullScreen.permissionsFullScreenAllowed) {
      let notifications = PopupNotifications.getNotification(
        this._permissionNotificationIDs
      ).filter(n => !n.dismissed);
      PopupNotifications.remove(notifications, true);
      if (notifications.length) {
        this._logWarningPermissionPromptFS("promptCanceled");
      }
    }
    document.documentElement.setAttribute("inDOMFullscreen", true);

    XULBrowserWindow.onEnterDOMFullscreen();

    if (gFindBarInitialized) {
      gFindBar.close(true);
    }

    // Exit DOM full-screen mode when switching to a different tab.
    gBrowser.tabContainer.addEventListener("TabSelect", this.exitDomFullScreen);

    // Addon installation should be cancelled when entering DOM fullscreen for security and usability reasons.
    // Installation prompts in fullscreen can trick the user into installing unwanted addons.
    // In fullscreen the notification box does not have a clear visual association with its parent anymore.
    if (gXPInstallObserver.removeAllNotifications(aBrowser)) {
      // If notifications have been removed, log a warning to the website console
      gXPInstallObserver.logWarningFullScreenInstallBlocked();
    }

    PopupNotifications.panel.addEventListener(
      "popupshowing",
      () => this._handlePermPromptShow(),
      true
    );
  },

  cleanup() {
    if (!window.fullScreen) {
      MousePosTracker.removeListener(this);
      document.removeEventListener("keypress", this._keyToggleCallback);
      document.removeEventListener("popupshown", this._setPopupOpen);
      document.removeEventListener("popuphidden", this._setPopupOpen);
      gURLBar.controller.removeListener(this);
    }
  },

  _toggleShortcutKeys() {
    const kEnterKeyIds = [
      "key_enterFullScreen",
      "key_enterFullScreen_old",
      "key_enterFullScreen_compat",
    ];
    const kExitKeyIds = [
      "key_exitFullScreen",
      "key_exitFullScreen_old",
      "key_exitFullScreen_compat",
    ];
    for (let id of window.fullScreen ? kEnterKeyIds : kExitKeyIds) {
      document.getElementById(id)?.setAttribute("disabled", "true");
    }
    for (let id of window.fullScreen ? kExitKeyIds : kEnterKeyIds) {
      document.getElementById(id)?.removeAttribute("disabled");
    }
  },

  /**
   * Clean up full screen, starting from the request origin's first ancestor
   * frame that is OOP.
   *
   * If there are OOP ancestor frames, we notify the first of those and then bail to
   * be called again in that process when it has dealt with the change. This is
   * repeated until all ancestor processes have been updated. Once that has happened
   * we remove our handlers and attributes and notify the request origin to complete
   * the cleanup.
   */
  cleanupDomFullscreen(aActor) {
    let needToWaitForChildExit = false;
    // Use the message recipient cached in the actor if possible, especially for
    // the case that actor is destroyed, which we are unable to find it by
    // walking up the browsing context tree.
    let [target, inProcessBC] = this._getNextMsgRecipientActor(
      aActor,
      true /* aUseCache */
    );
    if (target) {
      needToWaitForChildExit = true;
      // Record that the actor is waiting for its child to exit fullscreen so
      // that if it dies we can continue cleanup.
      target.waitingForChildExitFullscreen = true;
      target.sendAsyncMessage("DOMFullscreen:CleanUp", {
        remoteFrameBC: inProcessBC,
      });
      if (inProcessBC) {
        return needToWaitForChildExit;
      }
    }

    PopupNotifications.panel.removeEventListener(
      "popupshowing",
      () => this._handlePermPromptShow(),
      true
    );

    PointerlockFsWarning.close("fullscreen-warning");
    gBrowser.tabContainer.removeEventListener(
      "TabSelect",
      this.exitDomFullScreen
    );

    document.documentElement.removeAttribute("inDOMFullscreen");

    return needToWaitForChildExit;
  },

  _abortEnterFullscreen(aActor) {
    // This function is called synchronously in fullscreen change, so
    // we have to avoid calling exitFullscreen synchronously here.
    //
    // This could reject if we're not currently in fullscreen
    // so just ignore rejection.
    setTimeout(() => document.exitFullscreen().catch(() => {}), 0);
    if (aActor.timerId) {
      // Cancel the stopwatch for any fullscreen change to avoid
      // errors if it is started again.
      Glean.fullscreen.change.cancel(aActor.timerId);
      aActor.timerId = null;
    }
  },

  /**
   * Search for the first ancestor of aActor that lives in a different process.
   * If found, that ancestor actor and the browsing context for its child which
   * was in process are returned. Otherwise [request origin, null].
   *
   *
   * @param {JSWindowActorParent} aActor
   *        The actor that called this function.
   * @param {bool} aUseCache
   *        Use the recipient cached in the aActor if available.
   *
   * @return {[JSWindowActorParent, BrowsingContext]}
   *         The parent actor which should be sent the next msg and the
   *         in process browsing context which is its child. Will be
   *         [null, null] if there is no OOP parent actor and request origin
   *         is unset. [null, null] is also returned if the intended actor or
   *         the calling actor has been destroyed or its associated
   *         WindowContext is in BFCache.
   */
  _getNextMsgRecipientActor(aActor, aUseCache) {
    // Walk up the cached nextMsgRecipient to find the next available actor if
    // any.
    if (aUseCache && aActor.nextMsgRecipient) {
      let nextMsgRecipient = aActor.nextMsgRecipient;
      while (nextMsgRecipient) {
        let [actor] = nextMsgRecipient;
        if (
          !actor.hasBeenDestroyed() &&
          actor.windowContext &&
          !actor.windowContext.isInBFCache
        ) {
          return nextMsgRecipient;
        }
        nextMsgRecipient = actor.nextMsgRecipient;
      }
    }

    if (aActor.hasBeenDestroyed()) {
      return [null, null];
    }

    let childBC = aActor.browsingContext;
    let parentBC = childBC.parent;

    // Walk up the browsing context tree from aActor's browsing context
    // to find the first ancestor browsing context that's in a different process.
    while (parentBC) {
      if (!childBC.currentWindowGlobal || !parentBC.currentWindowGlobal) {
        break;
      }
      let childPid = childBC.currentWindowGlobal.osPid;
      let parentPid = parentBC.currentWindowGlobal.osPid;

      if (childPid == parentPid) {
        childBC = parentBC;
        parentBC = childBC.parent;
      } else {
        break;
      }
    }

    let target = null;
    let inProcessBC = null;

    if (parentBC && parentBC.currentWindowGlobal) {
      target = parentBC.currentWindowGlobal.getActor("DOMFullscreen");
      inProcessBC = childBC;
      aActor.nextMsgRecipient = [target, inProcessBC];
    } else {
      target = aActor.requestOrigin;
    }

    if (
      !target ||
      target.hasBeenDestroyed() ||
      target.windowContext?.isInBFCache
    ) {
      return [null, null];
    }
    return [target, inProcessBC];
  },

  _isRemoteBrowser(aBrowser) {
    return gMultiProcessBrowser && aBrowser.getAttribute("remote") == "true";
  },

  getMouseTargetRect() {
    return this._mouseTargetRect;
  },

  // Event callbacks
  _expandCallback() {
    FullScreen.showNavToolbox();
  },

  onMouseEnter() {
    this.hideNavToolbox();
  },

  _keyToggleCallback(aEvent) {
    // if we can use the keyboard (eg Ctrl+L or Ctrl+E) to open the toolbars, we
    // should provide a way to collapse them too.
    if (aEvent.keyCode == aEvent.DOM_VK_ESCAPE) {
      FullScreen.hideNavToolbox();
    } else if (aEvent.keyCode == aEvent.DOM_VK_F6) {
      // F6 is another shortcut to the address bar, but its not covered in OpenLocation()
      FullScreen.showNavToolbox();
    }
  },

  // Checks whether we are allowed to collapse the chrome
  _isPopupOpen: false,
  _isChromeCollapsed: false,

  _setPopupOpen(aEvent) {
    // Popups should only veto chrome collapsing if they were opened when the chrome was not collapsed.
    // Otherwise, they would not affect chrome and the user would expect the chrome to go away.
    // e.g. we wouldn't want the autoscroll icon firing this event, so when the user
    // toggles chrome when moving mouse to the top, it doesn't go away again.
    let target = aEvent.originalTarget;
    if (target.localName == "tooltip" || target.id == "tab-preview-panel") {
      return;
    }
    if (
      aEvent.type == "popupshown" &&
      !FullScreen._isChromeCollapsed &&
      target.getAttribute("nopreventnavboxhide") != "true"
    ) {
      FullScreen._isPopupOpen = true;
    } else if (aEvent.type == "popuphidden") {
      FullScreen._isPopupOpen = false;
      // Try again to hide toolbar when we close the popup.
      FullScreen.hideNavToolbox(true);
    }
  },

  // UrlbarController listener method
  onViewOpen() {
    if (!this._isChromeCollapsed) {
      this._isPopupOpen = true;
    }
  },

  // UrlbarController listener method
  onViewClose() {
    this._isPopupOpen = false;
    this.hideNavToolbox(true);
  },

  get navToolboxHidden() {
    return this._isChromeCollapsed;
  },

  // Autohide helpers for the context menu item
  updateAutohideMenuitem(aItem) {
    aItem.setAttribute(
      "checked",
      Services.prefs.getBoolPref("browser.fullscreen.autohide")
    );
  },
  setAutohide() {
    Services.prefs.setBoolPref(
      "browser.fullscreen.autohide",
      !Services.prefs.getBoolPref("browser.fullscreen.autohide")
    );
    // Try again to hide toolbar when we change the pref.
    FullScreen.hideNavToolbox(true);
  },

  showNavToolbox(trackMouse = true) {
    if (BrowserHandler.kiosk) {
      return;
    }
    this.fullScreenToggler.hidden = true;
    gNavToolbox.removeAttribute("fullscreenShouldAnimate");
    gNavToolbox.style.marginTop = "";

    if (!this._isChromeCollapsed) {
      return;
    }

    // Track whether mouse is near the toolbox
    if (trackMouse) {
      let rect = gBrowser.tabpanels.getBoundingClientRect();
      this._mouseTargetRect = {
        top: rect.top + 50,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
      MousePosTracker.addListener(this);
    }

    this._isChromeCollapsed = false;
    Services.obs.notifyObservers(null, "fullscreen-nav-toolbox", "shown");
  },

  hideNavToolbox(aAnimate = false) {
    if (this._isChromeCollapsed) {
      return;
    }
    if (!Services.prefs.getBoolPref("browser.fullscreen.autohide")) {
      return;
    }
    // a popup menu is open in chrome: don't collapse chrome
    if (this._isPopupOpen) {
      return;
    }

    // a textbox in chrome is focused (location bar anyone?): don't collapse chrome
    // unless we are kiosk mode
    let focused = document.commandDispatcher.focusedElement;
    if (
      focused &&
      focused.ownerDocument == document &&
      focused.localName == "input" &&
      !BrowserHandler.kiosk
    ) {
      // But try collapse the chrome again when anything happens which can make
      // it lose the focus. We cannot listen on "blur" event on focused here
      // because that event can be triggered by "mousedown", and hiding chrome
      // would cause the content to move. This combination may split a single
      // click into two actionless halves.
      let retryHideNavToolbox = () => {
        // Wait for at least a frame to give it a chance to be passed down to
        // the content.
        requestAnimationFrame(() => {
          setTimeout(() => {
            // In the meantime, it's possible that we exited fullscreen somehow,
            // so only hide the toolbox if we're still in fullscreen mode.
            if (window.fullScreen) {
              this.hideNavToolbox(aAnimate);
            }
          }, 0);
        });
        window.removeEventListener("keydown", retryHideNavToolbox);
        window.removeEventListener("click", retryHideNavToolbox);
      };
      window.addEventListener("keydown", retryHideNavToolbox);
      window.addEventListener("click", retryHideNavToolbox);
      return;
    }

    if (!BrowserHandler.kiosk) {
      this.fullScreenToggler.hidden = false;
    }

    if (
      aAnimate &&
      window.matchMedia("(prefers-reduced-motion: no-preference)").matches &&
      !BrowserHandler.kiosk
    ) {
      gNavToolbox.setAttribute("fullscreenShouldAnimate", true);
    }

    gNavToolbox.style.marginTop =
      -gNavToolbox.getBoundingClientRect().height + "px";
    this._isChromeCollapsed = true;
    Services.obs.notifyObservers(null, "fullscreen-nav-toolbox", "hidden");

    MousePosTracker.removeListener(this);
  },
};

ChromeUtils.defineLazyGetter(FullScreen, "_permissionNotificationIDs", () => {
  let { PermissionUI } = ChromeUtils.importESModule(
    "resource:///modules/PermissionUI.sys.mjs"
  );
  return (
    Object.values(PermissionUI)
      .filter(value => {
        let returnValue;
        try {
          returnValue = value.prototype.notificationID;
        } catch (err) {
          if (err.message === "Not implemented.") {
            returnValue = false;
          } else {
            throw err;
          }
        }
        return returnValue;
      })
      .map(value => value.prototype.notificationID)
      // Additionally include webRTC permission prompt which does not use PermissionUI
      .concat(["webRTC-shareDevices"])
  );
});
