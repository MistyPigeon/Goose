#include <string>
#include <vector>
#include <algorithm>
#include <mutex>
#include <regex>

class TrackerScriptBlocker {
public:
    TrackerScriptBlocker() {
        // Add known tracker patterns (use domain or regex as needed)
        trackerPatterns = {
            R"(doubleclick\.net)",
            R"(google-analytics\.com)",
            R"(googletagmanager\.com)",
            R"(facebook\.net)",
            R"(adsystem\.com)",
            R"(adservice\.google\.com)",
            R"(quantserve\.com)",
            R"(scorecardresearch\.com)",
            R"(taboola\.com)",
            R"(outbrain\.com)"
        };
    }

    // Returns true if the script URL matches a known tracker pattern
    bool ShouldBlockScript(const std::string& scriptUrl) const {
        for (const auto& pattern : trackerPatterns) {
            std::regex re(pattern, std::regex_constants::icase);
            if (std::regex_search(scriptUrl, re)) {
                return true;
            }
        }
        return false;
    }

    // Thread-safe singleton access
    static TrackerScriptBlocker& Instance() {
        static TrackerScriptBlocker instance;
        return instance;
    }

    // Add a new tracker pattern at runtime
    void AddTrackerPattern(const std::string& pattern) {
        std::lock_guard<std::mutex> lock(mutex_);
        trackerPatterns.push_back(pattern);
    }

private:
    std::vector<std::string> trackerPatterns;
    mutable std::mutex mutex_;
};

// Example usage: Call before loading any script
bool ShouldLoadScript(const std::string& scriptUrl) {
    return !TrackerScriptBlocker::Instance().ShouldBlockScript(scriptUrl);
}

/*
Usage in your script loading pipeline:
if (ShouldLoadScript(candidateScriptUrl)) {
    // Proceed to load script
} else {
    // Block script and optionally log or notify
}
*/
