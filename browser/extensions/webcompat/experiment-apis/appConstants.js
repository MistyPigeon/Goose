/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global AppConstants, ExtensionAPI, XPCOMUtils */

this.appConstants = class extends ExtensionAPI {
  getAPI() {
    return {
      appConstants: {
        getAndroidPackageName: () => {
          return Services.env.get("MOZ_ANDROID_PACKAGE_NAME");
        },
        getEffectiveUpdateChannel: () => {
          const ver = AppConstants.MOZ_APP_VERSION_DISPLAY;
          if (ver.includes("a")) {
            return "nightly";
          } else if (ver.includes("b")) {
            return "beta";
          } else if (ver.includes("esr")) {
            return "esr";
          }
          return "stable";
        },
        getReleaseBranch: () => {
          if (AppConstants.NIGHTLY_BUILD) {
            return "nightly";
          } else if (AppConstants.MOZ_DEV_EDITION) {
            return "dev_edition";
          } else if (AppConstants.EARLY_BETA_OR_EARLIER) {
            return "early_beta_or_earlier";
          } else if (AppConstants.RELEASE_OR_BETA) {
            return "release_or_beta";
          }
          return "unknown";
        },
      },
    };
  }
};
