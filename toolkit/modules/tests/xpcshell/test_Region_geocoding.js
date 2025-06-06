"use strict";

const { Region } = ChromeUtils.importESModule(
  "resource://gre/modules/Region.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  RegionTestUtils: "resource://testing-common/RegionTestUtils.sys.mjs",
});

function setLocation(location) {
  Services.prefs.setCharPref(
    "geo.provider.network.url",
    `data:application/json,${JSON.stringify({ location })}`
  );
}

async function stubMap(obj, path, fun) {
  let map = await IOUtils.readUTF8(do_get_file(path).path);
  sinon.stub(obj, fun).resolves(JSON.parse(map));
}

async function stubMaps(obj) {
  await stubMap(obj, "regions/world.geojson", "_getPlainMap");
  await stubMap(obj, "regions/world-buffered.geojson", "_getBufferedMap");
}

add_task(async function test_setup() {
  Services.prefs.setBoolPref("browser.region.log", true);
  Services.prefs.setBoolPref("browser.region.local-geocoding", true);
  await stubMaps(Region);
});

const LOCATIONS = [
  { lat: 55.867005, lng: -4.271078, expectedRegion: "GB" },
  // Small cove in Italy surrounded by another region.
  { lat: 45.6523148, lng: 13.7486427, expectedRegion: "IT" },
  // In Bosnia and Herzegovina but within a lot of borders.
  { lat: 42.557079, lng: 18.4370373, expectedRegion: "HR" },
  // In the sea bordering Croatia and a few other regions.
  { lat: 45.608696, lng: 13.4667903, expectedRegion: "HR" },
  // In the middle of the Atlantic.
  { lat: 35.4411368, lng: -41.5372973, expectedRegion: null },
  // Tanzania.
  { lat: -5.066019, lng: 39.1026251, expectedRegion: "TZ" },
];

add_task(async function test_local_basic() {
  for (const { lat, lng, expectedRegion } of LOCATIONS) {
    setLocation({ lat, lng });
    let region = await Region._getRegionLocally();
    Assert.equal(
      region,
      expectedRegion,
      `Got the expected region at ${lat},${lng}`
    );
  }
});

add_task(async function test_mls_results() {
  let data = await IOUtils.readUTF8(
    do_get_file("regions/mls-lookup-results.csv").path
  );
  for (const row of data.split("\n")) {
    let [lat, lng, expectedRegion] = row.split(",");
    setLocation({ lng: parseFloat(lng), lat: parseFloat(lat) });
    let region = await Region._getRegionLocally();
    Assert.equal(
      region,
      expectedRegion,
      `Expected ${expectedRegion} at ${lat},${lng} got ${region}`
    );
  }
});

add_task(async function test_geolocation_update() {
  RegionTestUtils.setNetworkRegion("AU");

  // Enable immediate region updates.
  Services.prefs.setBoolPref("browser.region.update.enabled", true);
  Services.prefs.setIntPref("browser.region.update.interval", 0);
  Services.prefs.setIntPref("browser.region.update.debounce", 0);

  let region = Region.newInstance();
  await stubMaps(region);
  await region.init();
  Assert.equal(region.home, "AU", "Correct initial region");

  Services.obs.notifyObservers(
    { coords: { latitude: -5.066019, longitude: 39.1026251 } },
    "geolocation-position-events"
  );
  Assert.equal(region.home, "AU", "First update will mark new region as seen");

  let regionUpdate = TestUtils.topicObserved("browser-region-updated");
  Services.obs.notifyObservers(
    { coords: { latitude: -5.066019, longitude: 39.1026251 } },
    "geolocation-position-events"
  );
  await regionUpdate;
  Assert.equal(region.home, "TZ", "Second update will change location");
});
