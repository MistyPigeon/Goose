// |reftest| shell-option(--enable-temporal) skip-if(!this.hasOwnProperty('Temporal')||!xulRuntime.shell) -- Temporal is not enabled unconditionally, requires shell-options
// Copyright (C) 2022 Igalia, S.L. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-temporal.plainyearmonth.prototype.subtract
description: temporalDurationLike object must contain at least one correctly spelled property
features: [Temporal]
---*/

const instance = new Temporal.PlainYearMonth(2000, 5);

assert.throws(
  TypeError,
  () => instance.subtract({}),
  "Throws TypeError if no property is present"
);

assert.throws(
  TypeError,
  () => instance.subtract({ nonsense: true }),
  "Throws TypeError if no recognized property is present"
);

assert.throws(
  TypeError,
  () => instance.subtract({ sign: 1 }),
  "Sign property is not recognized"
);

reportCompare(0, 0);
