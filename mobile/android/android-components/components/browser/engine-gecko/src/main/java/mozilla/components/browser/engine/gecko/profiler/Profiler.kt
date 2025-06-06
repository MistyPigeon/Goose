/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.browser.engine.gecko.profiler

import mozilla.components.concept.base.profiler.Profiler
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.ProfilerController

/**
 * Gecko-based implementation of [Profiler], wrapping the
 * ProfilerController object provided by GeckoView.
 */
class Profiler : Profiler {

    /**
     * See [Profiler.isProfilerActive].
     */
    override fun isProfilerActive(): Boolean {
        return ProfilerController.isProfilerActive()
    }

    /**
     * See [Profiler.getProfilerTime].
     */
    override fun getProfilerTime(): Double? {
        return ProfilerController.getProfilerTime()
    }

    /**
     * See [Profiler.addMarker].
     */
    override fun addMarker(markerName: String, startTime: Double?, endTime: Double?, text: String?) {
        ProfilerController.addMarker(markerName, startTime, endTime, text)
    }

    /**
     * See [Profiler.addMarker].
     */
    override fun addMarker(markerName: String, startTime: Double?, text: String?) {
        ProfilerController.addMarker(markerName, startTime, text)
    }

    /**
     * See [Profiler.addMarker].
     */
    override fun addMarker(markerName: String, startTime: Double?) {
        ProfilerController.addMarker(markerName, startTime)
    }

    /**
     * See [Profiler.addMarker].
     */
    override fun addMarker(markerName: String, text: String?) {
        ProfilerController.addMarker(markerName, text)
    }

    /**
     * See [Profiler.addMarker].
     */
    override fun addMarker(markerName: String) {
        ProfilerController.addMarker(markerName)
    }

    override fun startProfiler(filters: Array<String>, features: Array<String>) {
        ProfilerController.startProfiler(filters, features)
    }

    override fun stopProfiler(onSuccess: (ByteArray?) -> Unit, onError: (Throwable) -> Unit) {
        ProfilerController.stopProfiler().then(
            { profileResult ->
                onSuccess(profileResult)
                GeckoResult<Void>()
            },
            { throwable ->
                onError(throwable)
                GeckoResult<Void>()
            },
        )
    }
}
