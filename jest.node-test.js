// The core suites import `test` from `node:test`; under Jest it is Jest's own.
module.exports = { test: global.test, describe: global.describe };
