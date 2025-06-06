/*
 *  Copyright (c) 2017 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */

#include "api/audio_codecs/L16/audio_decoder_L16.h"

#include <memory>
#include <optional>
#include <vector>

#include "absl/strings/match.h"
#include "api/audio_codecs/audio_codec_pair_id.h"
#include "api/audio_codecs/audio_decoder.h"
#include "api/audio_codecs/audio_format.h"
#include "api/field_trials_view.h"
#include "modules/audio_coding/codecs/pcm16b/audio_decoder_pcm16b.h"
#include "modules/audio_coding/codecs/pcm16b/pcm16b_common.h"
#include "rtc_base/numerics/safe_conversions.h"

namespace webrtc {

std::optional<AudioDecoderL16::Config> AudioDecoderL16::SdpToConfig(
    const SdpAudioFormat& format) {
  Config config;
  config.sample_rate_hz = format.clockrate_hz;
  config.num_channels = checked_cast<int>(format.num_channels);
  if (absl::EqualsIgnoreCase(format.name, "L16") && config.IsOk()) {
    return config;
  }
  return std::nullopt;
}

void AudioDecoderL16::AppendSupportedDecoders(
    std::vector<AudioCodecSpec>* specs) {
  Pcm16BAppendSupportedCodecSpecs(specs);
}

std::unique_ptr<AudioDecoder> AudioDecoderL16::MakeAudioDecoder(
    const Config& config,
    std::optional<AudioCodecPairId> /*codec_pair_id*/,
    const FieldTrialsView* /* field_trials */) {
  if (!config.IsOk()) {
    return nullptr;
  }
  return std::make_unique<AudioDecoderPcm16B>(config.sample_rate_hz,
                                              config.num_channels);
}

}  // namespace webrtc
