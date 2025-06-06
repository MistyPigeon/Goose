/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/layers/APZPublicUtils.h"

#include "AsyncPanZoomController.h"
#include "nsLayoutUtils.h"
#include "mozilla/HelperMacros.h"
#include "mozilla/StaticPrefs_general.h"

namespace mozilla {
namespace layers {

namespace apz {

/*static*/ void InitializeGlobalState() {
  MOZ_ASSERT(NS_IsMainThread());
  AsyncPanZoomController::InitializeGlobalState();
}

/*static*/ const ScreenMargin CalculatePendingDisplayPort(
    const FrameMetrics& aFrameMetrics, const ParentLayerPoint& aVelocity) {
  return AsyncPanZoomController::CalculatePendingDisplayPort(
      aFrameMetrics, aVelocity, AsyncPanZoomController::ZoomInProgress::No);
}

/*static*/ gfx::Size GetDisplayportAlignmentMultiplier(
    const ScreenSize& aBaseSize) {
  return AsyncPanZoomController::GetDisplayportAlignmentMultiplier(aBaseSize);
}

ScrollAnimationBezierPhysicsSettings ComputeBezierAnimationSettingsForOrigin(
    ScrollOrigin aOrigin) {
  int32_t minMS = 0;
  int32_t maxMS = 0;
  bool isOriginSmoothnessEnabled = false;
  bool isGeneralSmoothnessEnabled = nsLayoutUtils::IsSmoothScrollingEnabled();

#define READ_DURATIONS(prefbase)                                              \
  isOriginSmoothnessEnabled = isGeneralSmoothnessEnabled &&                   \
                              StaticPrefs::general_smoothScroll_##prefbase(); \
  if (isOriginSmoothnessEnabled) {                                            \
    minMS = StaticPrefs::general_smoothScroll_##prefbase##_durationMinMS();   \
    maxMS = StaticPrefs::general_smoothScroll_##prefbase##_durationMaxMS();   \
  }

  switch (aOrigin) {
    case ScrollOrigin::Pixels:
      READ_DURATIONS(pixels)
      break;
    case ScrollOrigin::Lines:
      READ_DURATIONS(lines)
      break;
    case ScrollOrigin::Pages:
      READ_DURATIONS(pages)
      break;
    case ScrollOrigin::MouseWheel:
      READ_DURATIONS(mouseWheel)
      break;
    case ScrollOrigin::Scrollbars:
      READ_DURATIONS(scrollbars)
      break;
    default:
      READ_DURATIONS(other)
      break;
  }

#undef READ_DURATIONS

  if (isOriginSmoothnessEnabled) {
    static const int32_t kSmoothScrollMaxAllowedAnimationDurationMS = 10000;
    maxMS = std::clamp(maxMS, 0, kSmoothScrollMaxAllowedAnimationDurationMS);
    minMS = std::clamp(minMS, 0, maxMS);
  }

  // Keep the animation duration longer than the average event intervals
  // (to "connect" consecutive scroll animations before the scroll comes to a
  // stop).
  double intervalRatio =
      ((double)StaticPrefs::general_smoothScroll_durationToIntervalRatio()) /
      100.0;

  // Duration should be at least as long as the intervals -> ratio is at least 1
  intervalRatio = std::max(1.0, intervalRatio);

  return ScrollAnimationBezierPhysicsSettings{minMS, maxMS, intervalRatio};
}

ScrollMode GetScrollModeForOrigin(ScrollOrigin origin) {
  bool isSmoothScrollingEnabled = nsLayoutUtils::IsSmoothScrollingEnabled();
  if (!isSmoothScrollingEnabled) return ScrollMode::Instant;
  switch (origin) {
    case ScrollOrigin::Lines:
      return StaticPrefs::general_smoothScroll_lines() ? ScrollMode::Smooth
                                                       : ScrollMode::Instant;
    case ScrollOrigin::Pages:
      return StaticPrefs::general_smoothScroll_pages() ? ScrollMode::Smooth
                                                       : ScrollMode::Instant;
    case ScrollOrigin::Other:
      return StaticPrefs::general_smoothScroll_other() ? ScrollMode::Smooth
                                                       : ScrollMode::Instant;
    default:
      MOZ_ASSERT(false, "Unknown keyboard scroll origin");
      return isSmoothScrollingEnabled ? ScrollMode::Smooth
                                      : ScrollMode::Instant;
  }
}

}  // namespace apz
}  // namespace layers
}  // namespace mozilla
