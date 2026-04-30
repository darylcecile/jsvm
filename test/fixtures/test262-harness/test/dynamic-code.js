/*---
description: fixture proving harness includes can use dynamic code
includes: [dynamicInclude.js]
---*/

assert.sameValue(dynamicIncludeResult, 42);
