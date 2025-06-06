/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/* Test that an installed engine can't use a resource URL for an icon */

"use strict";

add_setup(async function () {
  let server = useHttpServer();
  server.registerContentType("sjs", "sjs");
});

add_task(async function test_installedresourceicon() {
  consoleAllowList.push("Error while setting icon for search engine");
  // Attempts to load a resource:// url as an icon.
  let engine1 = await SearchTestUtils.installOpenSearchEngine({
    url: `${gHttpURL}/opensearch/resourceicon.xml`,
  });
  // Attempts to load a chrome:// url as an icon.
  let engine2 = await SearchTestUtils.installOpenSearchEngine({
    url: `${gHttpURL}/opensearch/chromeicon.xml`,
  });

  Assert.equal(undefined, await engine1.getIconURL());
  Assert.equal(undefined, await engine2.getIconURL());
});

add_task(async function test_installedhttpplace() {
  let observed = TestUtils.consoleMessageObserved(msg => {
    return msg.wrappedJSObject.arguments[0].includes(
      "Content type does not match expected"
    );
  });

  // The easiest way to test adding the icon is via a generated xml, otherwise
  // we have to somehow insert the address of the server into it.
  // Attempts to load a non-image page into an image icon.
  let engine = await SearchTestUtils.installOpenSearchEngine({
    url:
      `${gHttpURL}/sjs/engineMaker.sjs?` +
      JSON.stringify({
        baseURL: `${gHttpURL}/`,
        imageURL: `${gHttpURL}/head_search.js`,
        name: "invalidicon",
        method: "GET",
      }),
  });

  await observed;

  Assert.equal(
    undefined,
    await engine.getIconURL(),
    "Should not have set an iconURI"
  );
});
