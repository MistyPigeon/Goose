/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {
  Arg,
  generateActorSpec,
  BULK_RESPONSE,
} = require("resource://devtools/shared/protocol.js");

const heapSnapshotFileSpec = generateActorSpec({
  typeName: "heapSnapshotFile",

  methods: {
    transferHeapSnapshot: {
      request: {
        snapshotId: Arg(0, "string"),
      },
      response: BULK_RESPONSE,
    },
  },
});

exports.heapSnapshotFileSpec = heapSnapshotFileSpec;
