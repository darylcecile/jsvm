/*---
description: fixture proving Test262Error can be thrown and caught in guest code
---*/

var caught = false;

try {
  throw new Test262Error("caught");
} catch (error) {
  caught = error.name === "Test262Error" && error.message === "caught";
}

assert.sameValue(caught, true);
